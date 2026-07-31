import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { authorizeServiceRoleRequest, type AuthorizedRequestContext } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";
import { fetchAllServices } from "@/lib/server/fetch-all-services";
import { deriveShuttleSchedules, enumerateShuttleDates, type ShuttleSchedule } from "@/lib/shuttle-schedules";

export const runtime = "nodejs";

const shuttleScheduleSchema = z.object({
  hotel_id: z.string().uuid().nullable().optional(),
  booking_service_kind: z.enum(["navetta", "shuttle_hotel"]).default("navetta"),
  customer_name: z.string().min(1).max(120),
  direction: z.enum(["arrival", "departure"]),
  departure_time: z.string().regex(/^\d{2}:\d{2}$/),
  meeting_point: z.string().max(200).nullable().optional(),
  vessel: z.string().min(1).max(60).default("Navetta"),
  valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  valid_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  days_of_week: z.array(z.number().int().min(0).max(6)).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
}).refine((data) => data.valid_to >= data.valid_from, {
  message: "La data finale deve essere uguale o successiva alla data iniziale.",
  path: ["valid_to"],
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

function buildServiceRows(tenantId: string, schedule: ShuttleSchedule) {
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

async function insertInChunks(
  auth: AuthorizedRequestContext<"admin" | "operator">,
  rows: Array<Record<string, unknown>>,
) {
  if (rows.length === 0) return;
  const chunkSize = 500;
  for (let index = 0; index < rows.length; index += chunkSize) {
    const { error } = await auth.admin.from("services").insert(rows.slice(index, index + chunkSize));
    if (error) {
      throw new Error(error.message);
    }
  }
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

export async function GET(request: NextRequest) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "operator"],
    auditPrefix: "shuttle_schedules_list",
  });
  if (auth instanceof NextResponse) return auth;

  const servicesResult = await fetchAllServices(auth.admin, auth.membership.tenant_id);
  if (servicesResult.error) {
    auditLog({
      event: "shuttle_schedules_list_failed",
      level: "error",
      tenantId: auth.membership.tenant_id,
      userId: auth.user.id,
      details: { message: servicesResult.error.message },
    });
    return NextResponse.json({ error: "Impossibile recuperare le navette." }, { status: 500 });
  }

  const schedules = deriveShuttleSchedules(servicesResult.data ?? []);
  return NextResponse.json({ ok: true, schedules });
}

export async function POST(request: NextRequest) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "operator"],
    auditPrefix: "shuttle_schedules_create",
  });
  if (auth instanceof NextResponse) return auth;

  const parsed = shuttleScheduleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Dati non validi." },
      { status: 400 }
    );
  }

  if (parsed.data.hotel_id) {
    let hotelValid: boolean;
    try {
      hotelValid = await isHotelInTenant(auth.admin, auth.membership.tenant_id, parsed.data.hotel_id);
    } catch (error) {
      auditLog({
        event: "shuttle_schedules_create_hotel_check_failed",
        level: "error",
        tenantId: auth.membership.tenant_id,
        userId: auth.user.id,
        details: { message: error instanceof Error ? error.message : String(error) },
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
    id: "",
    tenant_id: auth.membership.tenant_id,
    hotel_id: parsed.data.hotel_id ?? null,
    booking_service_kind: parsed.data.booking_service_kind,
    customer_name: parsed.data.customer_name.trim(),
    direction: parsed.data.direction,
    departure_time: parsed.data.departure_time,
    meeting_point: parsed.data.meeting_point?.trim() || null,
    vessel: parsed.data.vessel.trim() || "Navetta",
    valid_from: parsed.data.valid_from,
    valid_to: parsed.data.valid_to,
    days_of_week: parsed.data.days_of_week?.length ? parsed.data.days_of_week : null,
    notes: parsed.data.notes?.trim() || null,
  };

  try {
    await insertInChunks(auth, buildServiceRows(auth.membership.tenant_id, schedule));
  } catch (error) {
    auditLog({
      event: "shuttle_schedules_create_failed",
      level: "error",
      tenantId: auth.membership.tenant_id,
      userId: auth.user.id,
      details: { message: error instanceof Error ? error.message : String(error) },
    });
    return NextResponse.json(
      { error: "Impossibile creare la navetta." },
      { status: 500 }
    );
  }

  return GET(request);
}
