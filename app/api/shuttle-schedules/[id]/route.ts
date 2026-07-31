import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";
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

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
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

async function insertRows(admin: SupabaseClient, rows: Array<Record<string, unknown>>) {
  const chunkSize = 500;
  for (let index = 0; index < rows.length; index += chunkSize) {
    const { error } = await admin.from("services").insert(rows.slice(index, index + chunkSize));
    if (error) throw new Error(error.message);
  }
}

async function deleteMatchingFutureServices(
  admin: SupabaseClient,
  tenantId: string,
  scheduleId: string
) {
  const decoded = decodeShuttleScheduleId(scheduleId);
  let query = admin
    .from("services")
    .delete()
    .eq("tenant_id", tenantId)
    .gte("date", todayIsoDate())
    .eq("direction", decoded.direction)
    .eq("time", decoded.departure_time)
    .eq("customer_name", decoded.customer_name)
    .eq("vessel", decoded.vessel);

  if (decoded.hotel_id) query = query.eq("hotel_id", decoded.hotel_id);
  else query = query.is("hotel_id", null);

  if (decoded.meeting_point) query = query.eq("meeting_point", decoded.meeting_point);
  else query = query.is("meeting_point", null);

  if (decoded.booking_service_kind) query = query.eq("booking_service_kind", decoded.booking_service_kind);

  const { error } = await query;
  if (error) throw new Error(error.message);
}

async function hasOperationalFutureServices(
  admin: SupabaseClient,
  tenantId: string,
  scheduleId: string
): Promise<boolean> {
  const decoded = decodeShuttleScheduleId(scheduleId);
  let query = admin
    .from("services")
    .select("id, status")
    .eq("tenant_id", tenantId)
    .gte("date", todayIsoDate())
    .eq("direction", decoded.direction)
    .eq("time", decoded.departure_time)
    .eq("customer_name", decoded.customer_name)
    .eq("vessel", decoded.vessel);

  if (decoded.hotel_id) query = query.eq("hotel_id", decoded.hotel_id);
  else query = query.is("hotel_id", null);

  if (decoded.meeting_point) query = query.eq("meeting_point", decoded.meeting_point);
  else query = query.is("meeting_point", null);

  if (decoded.booking_service_kind) query = query.eq("booking_service_kind", decoded.booking_service_kind);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const services = (data ?? []) as Array<{ id: string; status: string | null }>;
  if (services.some((service) => service.status !== "new")) return true;

  const serviceIds = services.map((service) => service.id);
  if (serviceIds.length === 0) return false;

  const { data: assignmentRows, error: assignmentsError } = await admin
    .from("assignments")
    .select("id")
    .eq("tenant_id", tenantId)
    .in("service_id", serviceIds)
    .limit(1);
  if (assignmentsError) throw new Error(assignmentsError.message);

  return ((assignmentRows ?? []) as Array<{ id: string }>).length > 0;
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

  const existing = decodeShuttleScheduleId(id);
  const nextValidFrom = parsed.data.valid_from;
  const nextValidTo = parsed.data.valid_to;
  if (nextValidTo < nextValidFrom) {
    return NextResponse.json(
      { error: "La data finale deve essere uguale o successiva alla data iniziale." },
      { status: 400 }
    );
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

  try {
    if (await hasOperationalFutureServices(auth.admin, auth.membership.tenant_id, id)) {
      return operationalGuardResponse();
    }
    await deleteMatchingFutureServices(auth.admin, auth.membership.tenant_id, id);
    const rows = buildRows(auth.membership.tenant_id, schedule);
    if (rows.length) {
      await insertRows(auth.admin, rows);
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Errore aggiornamento navetta." },
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
    if (await hasOperationalFutureServices(auth.admin, auth.membership.tenant_id, id)) {
      return operationalGuardResponse();
    }
    await deleteMatchingFutureServices(auth.admin, auth.membership.tenant_id, id);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Errore eliminazione navetta." },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
