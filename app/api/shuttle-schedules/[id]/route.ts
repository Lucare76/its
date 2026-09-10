import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";
import { decodeShuttleScheduleId, enumerateShuttleDates, type ShuttleSchedule } from "@/lib/shuttle-schedules";

export const runtime = "nodejs";

const patchSchema = z.object({
  hotel_id: z.string().uuid().nullable().optional(),
  booking_service_kind: z.enum(["navetta", "shuttle_hotel"]).optional(),
  customer_name: z.string().min(1).max(120).optional(),
  direction: z.enum(["arrival", "departure"]).optional(),
  departure_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  meeting_point: z.string().max(200).nullable().optional(),
  vessel: z.string().min(1).max(60).optional(),
  valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  valid_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  days_of_week: z.array(z.number().int().min(0).max(6)).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

// Explicit Europe/Rome timezone (not UTC, not offset-fixed) so "today" matches
// the operative day in Italy across DST transitions. See F-05.
const ROME_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Rome",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function todayIsoDate(now: Date = new Date()): string {
  return ROME_DATE_FORMATTER.format(now);
}

function normalizeNullableText(value: string | null | undefined) {
  return value?.trim() || null;
}

function buildRows(tenantId: string, schedule: ShuttleSchedule) {
  return enumerateShuttleDates(schedule, todayIsoDate()).map((date) => ({
    tenant_id: tenantId,
    date,
    time: schedule.departure_time,
    service_type: "transfer",
    direction: schedule.direction,
    customer_name: schedule.customer_name,
    pax: 1,
    hotel_id: schedule.hotel_id,
    vessel: schedule.vessel,
    booking_service_kind: schedule.booking_service_kind,
    meeting_point: schedule.meeting_point,
    notes: schedule.notes ?? "",
    phone: "",
    status: "new",
    is_draft: false,
  }));
}

// ─── RPC atomiche (P1: PATCH/DELETE transazionali, migration 0276) ───────
//
// Guardia operativa + individuazione righe future + DELETE (+ INSERT per la
// PATCH) girano ORA dentro un'unica transazione Postgres lato RPC
// (public.patch_shuttle_schedule / public.delete_shuttle_schedule): non più
// una sequenza di chiamate Supabase separate che potevano lasciare il DB in
// uno stato parziale (DELETE riuscita, INSERT fallita) o soggetto a una race
// check-then-act tra la guardia e la scrittura. Il calcolo del range di
// date/orario/timezone resta qui in TypeScript (invariato, vedi
// enumerateShuttleDates/todayIsoDate) — la RPC riceve le righe già calcolate
// e si occupa solo della parte che deve essere atomica sul database.

type ShuttleRpcOldIdentity = {
  direction: string;
  departure_time: string;
  customer_name: string;
  vessel: string;
  hotel_id: string | null;
  meeting_point: string | null;
  booking_service_kind: string | null;
};

type ShuttleRpcResult = {
  deleted_count: number;
  deleted_date_from: string | null;
  deleted_date_to: string | null;
  deleted_weekdays: number[] | null;
  inserted_count?: number;
};

const OPERATIONAL_GUARD_RPC_MESSAGE = "SHUTTLE_HAS_OPERATIONAL_SERVICES";

function isOperationalGuardRpcError(error: { message?: string | null } | null | undefined): boolean {
  return error?.message === OPERATIONAL_GUARD_RPC_MESSAGE;
}

async function callPatchShuttleScheduleRpc(
  admin: SupabaseClient,
  tenantId: string,
  old: ShuttleRpcOldIdentity,
  newRows: Array<Record<string, unknown>>
) {
  return admin.rpc("patch_shuttle_schedule", {
    p_tenant_id: tenantId,
    p_today: todayIsoDate(),
    p_old_direction: old.direction,
    p_old_departure_time: old.departure_time,
    p_old_customer_name: old.customer_name,
    p_old_vessel: old.vessel,
    p_old_hotel_id: old.hotel_id,
    p_old_meeting_point: old.meeting_point,
    p_old_booking_service_kind: old.booking_service_kind,
    p_new_rows: newRows,
  });
}

async function callDeleteShuttleScheduleRpc(admin: SupabaseClient, tenantId: string, old: ShuttleRpcOldIdentity) {
  return admin.rpc("delete_shuttle_schedule", {
    p_tenant_id: tenantId,
    p_today: todayIsoDate(),
    p_old_direction: old.direction,
    p_old_departure_time: old.departure_time,
    p_old_customer_name: old.customer_name,
    p_old_vessel: old.vessel,
    p_old_hotel_id: old.hotel_id,
    p_old_meeting_point: old.meeting_point,
    p_old_booking_service_kind: old.booking_service_kind,
  });
}

function operationalGuardResponse() {
  return NextResponse.json(
    {
      error: "SHUTTLE_HAS_OPERATIONAL_SERVICES",
      message:
        "La navetta contiene corse odierne o future già assegnate o lavorate. Rimuovi prima le assegnazioni e ripristina lo stato delle corse.",
    },
    { status: 409 }
  );
}

async function isHotelInTenant(admin: SupabaseClient, tenantId: string, hotelId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("hotels")
    .select("id")
    .eq("id", hotelId)
    .eq("tenant_id", tenantId)
    .limit(1);
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

function invalidHotelResponse() {
  return NextResponse.json(
    {
      error: "INVALID_HOTEL_FOR_TENANT",
      message: "L'hotel selezionato non appartiene al tenant autenticato.",
    },
    { status: 400 }
  );
}

// The shuttle schedule id is not a database key: it is a base64url-encoded
// JSON key. decodeShuttleScheduleId() only decodes/parses — it does not
// validate structure, so a syntactically valid JSON payload missing the
// fields the queries rely on (e.g. "{}" or "[]") decodes without throwing.
// This checks only the fields used unconditionally in .eq(...) filters
// downstream (hotel_id/meeting_point/booking_service_kind already have
// null-safe fallbacks and are not required here).
function isValidDecodedScheduleKey(value: ReturnType<typeof decodeShuttleScheduleId>): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value.direction === "arrival" || value.direction === "departure") &&
    typeof value.departure_time === "string" &&
    value.departure_time.length > 0 &&
    typeof value.customer_name === "string" &&
    value.customer_name.length > 0 &&
    typeof value.vessel === "string" &&
    value.vessel.length > 0
  );
}

function invalidScheduleIdResponse() {
  return NextResponse.json({ error: "Identificativo navetta non valido." }, { status: 400 });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "operator"],
    auditPrefix: "shuttle_schedules_update",
  });
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Dati non validi." },
      { status: 400 }
    );
  }

  let existing: ReturnType<typeof decodeShuttleScheduleId>;
  try {
    existing = decodeShuttleScheduleId(id);
    if (!isValidDecodedScheduleKey(existing)) {
      throw new Error("shuttle schedule id decoded to an incomplete/invalid structure");
    }
  } catch (error) {
    auditLog({
      event: "shuttle_schedules_update_invalid_id",
      level: "warn",
      tenantId: auth.membership.tenant_id,
      userId: auth.user.id,
      details: { idLength: id.length },
    });
    return invalidScheduleIdResponse();
  }

  const nextValidFrom = parsed.data.valid_from;
  const nextValidTo = parsed.data.valid_to;
  if (nextValidTo < nextValidFrom) {
    return NextResponse.json(
      { error: "La data finale deve essere uguale o successiva alla data iniziale." },
      { status: 400 }
    );
  }

  if (parsed.data.hotel_id) {
    let hotelValid: boolean;
    try {
      hotelValid = await isHotelInTenant(auth.admin, auth.membership.tenant_id, parsed.data.hotel_id);
    } catch (error) {
      auditLog({
        event: "shuttle_schedules_update_hotel_check_failed",
        level: "error",
        tenantId: auth.membership.tenant_id,
        userId: auth.user.id,
        details: { scheduleId: id, message: error instanceof Error ? error.message : String(error) },
      });
      return NextResponse.json(
        { error: "Impossibile verificare l'hotel selezionato." },
        { status: 500 }
      );
    }
    if (!hotelValid) {
      return invalidHotelResponse();
    }
  }

  const schedule: ShuttleSchedule = {
    id,
    tenant_id: auth.membership.tenant_id,
    hotel_id: parsed.data.hotel_id === undefined ? existing.hotel_id : parsed.data.hotel_id,
    booking_service_kind: parsed.data.booking_service_kind ?? existing.booking_service_kind,
    customer_name: parsed.data.customer_name?.trim() ?? existing.customer_name,
    direction: parsed.data.direction ?? existing.direction,
    departure_time: parsed.data.departure_time ?? existing.departure_time,
    meeting_point: parsed.data.meeting_point === undefined ? existing.meeting_point : normalizeNullableText(parsed.data.meeting_point),
    vessel: parsed.data.vessel?.trim() ?? existing.vessel,
    valid_from: nextValidFrom,
    valid_to: nextValidTo,
    days_of_week: parsed.data.days_of_week === undefined ? null : parsed.data.days_of_week?.length ? parsed.data.days_of_week : null,
    notes: parsed.data.notes === undefined ? null : normalizeNullableText(parsed.data.notes),
  };

  let expectedInsertCount = 0;
  let deletedCount = 0;
  let deletedDateFrom: string | null = null;
  let deletedDateTo: string | null = null;
  let previousWeekdays: number[] = [];

  try {
    const rows = buildRows(auth.membership.tenant_id, schedule);
    const { data, error } = await callPatchShuttleScheduleRpc(
      auth.admin,
      auth.membership.tenant_id,
      existing,
      rows
    );
    if (error) {
      if (isOperationalGuardRpcError(error)) {
        return operationalGuardResponse();
      }
      throw new Error(error.message);
    }
    const result = (Array.isArray(data) ? data[0] : data) as ShuttleRpcResult | undefined;
    deletedCount = result?.deleted_count ?? 0;
    deletedDateFrom = result?.deleted_date_from ?? null;
    deletedDateTo = result?.deleted_date_to ?? null;
    previousWeekdays = result?.deleted_weekdays ?? [];
    expectedInsertCount = result?.inserted_count ?? 0;

    auditLog({
      event: "shuttle_schedule_updated",
      level: "info",
      tenantId: auth.membership.tenant_id,
      userId: auth.user.id,
      role: auth.membership.role,
      outcome: "updated",
      details: {
        previous: {
          hotelId: existing.hotel_id,
          bookingServiceKind: existing.booking_service_kind,
          customerName: existing.customer_name,
          direction: existing.direction,
          departureTime: existing.departure_time,
          meetingPoint: existing.meeting_point,
          vessel: existing.vessel,
          validFrom: deletedDateFrom,
          validTo: deletedDateTo,
          weekdays: previousWeekdays,
        },
        next: {
          hotelId: schedule.hotel_id,
          bookingServiceKind: schedule.booking_service_kind,
          customerName: schedule.customer_name,
          direction: schedule.direction,
          departureTime: schedule.departure_time,
          meetingPoint: schedule.meeting_point,
          vessel: schedule.vessel,
          validFrom: schedule.valid_from,
          validTo: schedule.valid_to,
          weekdays: schedule.days_of_week,
        },
        deletedCount,
        insertedCount: expectedInsertCount,
        deletedDateFrom,
        deletedDateTo,
      },
    });
  } catch (error) {
    // RPC transazionale: se qui arriva un errore, la transazione Postgres ha
    // fatto rollback completo (guardia/delete/insert sono un unico blocco
    // atomico) — non esiste più uno stato "delete riuscita, insert fallita"
    // da registrare separatamente.
    auditLog({
      event: "shuttle_schedules_update_failed",
      level: "error",
      tenantId: auth.membership.tenant_id,
      userId: auth.user.id,
      details: {
        scheduleId: id,
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return NextResponse.json(
      { error: "Impossibile aggiornare la navetta." },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "operator"],
    auditPrefix: "shuttle_schedules_delete",
  });
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  try {
    const existing = decodeShuttleScheduleId(id);
    const { data, error } = await callDeleteShuttleScheduleRpc(auth.admin, auth.membership.tenant_id, existing);
    if (error) {
      if (isOperationalGuardRpcError(error)) {
        return operationalGuardResponse();
      }
      throw new Error(error.message);
    }
    const result = (Array.isArray(data) ? data[0] : data) as ShuttleRpcResult | undefined;

    auditLog({
      event: "shuttle_schedule_deleted",
      level: "info",
      tenantId: auth.membership.tenant_id,
      userId: auth.user.id,
      role: auth.membership.role,
      outcome: "deleted",
      details: {
        previous: {
          hotelId: existing.hotel_id,
          bookingServiceKind: existing.booking_service_kind,
          customerName: existing.customer_name,
          direction: existing.direction,
          departureTime: existing.departure_time,
          meetingPoint: existing.meeting_point,
          vessel: existing.vessel,
          validFrom: result?.deleted_date_from ?? null,
          validTo: result?.deleted_date_to ?? null,
          weekdays: result?.deleted_weekdays ?? [],
        },
        next: null,
        deletedCount: result?.deleted_count ?? 0,
        insertedCount: 0,
        deletedDateFrom: result?.deleted_date_from ?? null,
        deletedDateTo: result?.deleted_date_to ?? null,
      },
    });
  } catch (error) {
    auditLog({
      event: "shuttle_schedules_delete_failed",
      level: "error",
      tenantId: auth.membership.tenant_id,
      userId: auth.user.id,
      details: { scheduleId: id, message: error instanceof Error ? error.message : String(error) },
    });
    return NextResponse.json(
      { error: "Impossibile eliminare la navetta." },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
