import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { normalizeE164 } from "@/lib/server/whatsapp";
import { isValidIsoDate } from "@/lib/medmar-date";
import { resolveOperationalTiming } from "@/lib/operational-timing-resolver";
import { fmtTime, type PrintService } from "@/lib/piano-giorno-print";
import {
  MEDMAR_DEPARTURE_KINDS,
  buildGeneratedConvocationRows,
  type ServiceForConvocation,
} from "@/lib/medmar-generate-from-services";

export const runtime = "nodejs";

// READ-ONLY. Finds the MEDMAR Formula departures for the given operational
// day and returns rows in the exact shape the MEDMAR Excel-import preview
// consumes. Never sends WhatsApp, never mutates services / bookings /
// convocation batches / whatsapp_events.

const SERVICE_COLUMNS =
  "id, customer_name, phone, phone_e164, pax, hotel_id, booking_service_kind, direction, date, departure_date, departure_time, time, pickup_hotel, pickup_time, orario_barca, vessel, barca_compagnia, porto_bruno, meeting_point, status";

type ServiceRow = {
  id: string;
  customer_name: string | null;
  phone: string | null;
  phone_e164: string | null;
  pax: number | null;
  hotel_id: string | null;
  booking_service_kind: string | null;
  direction: string | null;
  date: string | null;
  departure_date: string | null;
  departure_time: string | null;
  time: string | null;
  pickup_hotel: string | null;
  pickup_time: string | null;
  orario_barca: string | null;
  vessel: string | null;
  barca_compagnia: string | null;
  porto_bruno: string | null;
  meeting_point: string | null;
  status: string;
};

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const date = request.nextUrl.searchParams.get("date") ?? "";
  if (!isValidIsoDate(date)) {
    return NextResponse.json({ error: "Parametro date non valido: atteso formato YYYY-MM-DD" }, { status: 400 });
  }

  const tenantId = auth.membership.tenant_id;
  const kinds = [...MEDMAR_DEPARTURE_KINDS];

  const hotelsRes = await auth.admin
    .from("hotels")
    .select("id, name")
    .eq("tenant_id", tenantId);
  if (hotelsRes.error) {
    return NextResponse.json({ error: hotelsRes.error.message }, { status: 500 });
  }
  const hotelName = new Map((hotelsRes.data ?? []).map((h) => [h.id as string, h.name as string]));

  // Same departure-day pattern as /api/ops/departure-services: explicit
  // departure_date, plus direction=departure rows that only carry `date`.
  const [q1, q2] = await Promise.all([
    auth.admin
      .from("services")
      .select(SERVICE_COLUMNS)
      .eq("tenant_id", tenantId)
      .eq("departure_date", date)
      .eq("is_draft", false)
      .neq("status", "cancelled")
      .in("booking_service_kind", kinds)
      .limit(2000),
    auth.admin
      .from("services")
      .select(SERVICE_COLUMNS)
      .eq("tenant_id", tenantId)
      .is("departure_date", null)
      .eq("date", date)
      .eq("direction", "departure")
      .eq("is_draft", false)
      .neq("status", "cancelled")
      .in("booking_service_kind", kinds)
      .limit(2000),
  ]);
  if (q1.error) return NextResponse.json({ error: q1.error.message }, { status: 500 });
  if (q2.error) return NextResponse.json({ error: q2.error.message }, { status: 500 });

  const seen = new Set<string>();
  const services: ServiceRow[] = [];
  for (const row of [...(q1.data ?? []), ...(q2.data ?? [])] as ServiceRow[]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    services.push(row);
  }
  services.sort((a, b) =>
    (a.orario_barca ?? a.departure_time ?? "").localeCompare(b.orario_barca ?? b.departure_time ?? "") ||
    (a.customer_name ?? "").localeCompare(b.customer_name ?? ""),
  );

  const mapped: ServiceForConvocation[] = services.map((svc) => {
    // Level 2 of the canonical resolver (no context) — reads only the
    // fields already persisted on the service, the same source used by the
    // Piano del Giorno print. Never invents an orario, never emits 00:00.
    const timing = resolveOperationalTiming(svc as unknown as PrintService);
    const pickup = timing.pickupTime ?? fmtTime(svc.pickup_hotel) ?? fmtTime(svc.pickup_time) ?? "";
    const vesselTime =
      timing.ferryTime ?? fmtTime(svc.orario_barca) ?? fmtTime(svc.departure_time) ?? "";
    return {
      service_id: svc.id,
      customer_name: svc.customer_name,
      phone: svc.phone,
      phone_e164: svc.phone_e164,
      hotel_name: svc.hotel_id ? hotelName.get(svc.hotel_id) ?? null : null,
      pax: svc.pax,
      pickup_time: pickup || null,
      vessel_time: vesselTime || null,
      booking_service_kind: svc.booking_service_kind,
    };
  });

  const { rows, summary } = buildGeneratedConvocationRows(mapped, date, normalizeE164);

  return NextResponse.json({ ok: true, date, source: "gestionale", summary, rows });
}
