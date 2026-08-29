// Shared source for both GET /api/ops/snav-convocations/generate-from-services
// (read-only preview) and POST .../create-batch-from-services (writes a real
// batch) — mirrors lib/server/medmar-generate-with-coverage.ts exactly, only
// the target kind/table names differ. Read-only: no DB writes happen here.

import { normalizeE164, type createAdminClient } from "@/lib/server/whatsapp";
import { resolveOperationalTiming } from "@/lib/operational-timing-resolver";
import { fmtTime, type PrintService } from "@/lib/piano-giorno-print";
import { applyPickupCalc } from "@/lib/server/apply-pickup-calc";
import {
  SNAV_DEPARTURE_KINDS,
  buildGeneratedSnavConvocationRows,
  type ServiceForSnavConvocation,
  type GeneratedSnavConvocationRow,
} from "@/lib/snav-generate-from-services";
import {
  resolveCoverageForRow,
  buildCoverageSummary,
  type CoverageResult,
  type CoverageSummary,
} from "@/lib/medmar-convocation-coverage";
import { loadSnavSentSnapshots } from "@/lib/server/snav-convocation-coverage-source";

type AdminClient = ReturnType<typeof createAdminClient>;

export type GeneratedSnavRowWithCoverage = GeneratedSnavConvocationRow & CoverageResult;

const SERVICE_COLUMNS =
  "id, customer_name, phone, pax, hotel_id, booking_service_kind, direction, date, departure_date, departure_time, time, pickup_hotel, pickup_time, orario_barca, vessel, barca_compagnia, porto_bruno, meeting_point, billing_party_name, status";

type ServiceRow = {
  id: string;
  customer_name: string | null;
  phone: string | null;
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
  billing_party_name: string | null;
  status: string;
};

export async function fetchSnavServicesForDate(
  admin: AdminClient,
  tenantId: string,
  date: string,
): Promise<{ error: string } | { services: ServiceForSnavConvocation[] }> {
  const kinds = [...SNAV_DEPARTURE_KINDS];

  const hotelsRes = await admin.from("hotels").select("id, name, zone").eq("tenant_id", tenantId);
  if (hotelsRes.error) return { error: hotelsRes.error.message };
  const hotelName = new Map((hotelsRes.data ?? []).map((h) => [h.id as string, h.name as string]));
  const hotelZone = new Map((hotelsRes.data ?? []).map((h) => [h.id as string, (h as { zone: string | null }).zone]));

  // Round-trip bookings create TWO services rows (arrival leg + departure
  // leg). The arrival leg also carries the booking's overall departure_date,
  // so direction='departure' is required on BOTH queries (see the MEDMAR
  // duplicate-convocation fix — same root cause applies here).
  const [q1, q2] = await Promise.all([
    admin
      .from("services")
      .select(SERVICE_COLUMNS)
      .eq("tenant_id", tenantId)
      .eq("departure_date", date)
      .eq("direction", "departure")
      .eq("is_draft", false)
      .neq("status", "cancelled")
      .in("booking_service_kind", kinds)
      .limit(2000),
    admin
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
  if (q1.error) return { error: q1.error.message };
  if (q2.error) return { error: q2.error.message };

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

  const mapped: ServiceForSnavConvocation[] = services.map((svc) => {
    // Level 2 of the canonical resolver (no context) — reads only the
    // fields already persisted on the service, the same source used by the
    // Piano del Giorno print. Never invents an orario, never emits 00:00.
    const timing = resolveOperationalTiming(svc as unknown as PrintService);
    const vesselTime = timing.ferryTime ?? fmtTime(svc.orario_barca) ?? fmtTime(svc.departure_time) ?? "";
    let pickup = timing.pickupTime ?? fmtTime(svc.pickup_hotel) ?? fmtTime(svc.pickup_time) ?? "";

    // Nothing persisted (the common case for Formula SNAV direct bookings,
    // whose pickup is a hotel/zone lookup): fall back to the SAME canonical
    // Domain-B rule the write-path (applyPickupCalc, lib/departure-pickup-rules.ts,
    // transport_type "snav") already uses — read-only simulation, never
    // persisted here, never a MEDMAR rule applied to SNAV.
    if (!pickup && vesselTime) {
      const zone = svc.hotel_id ? hotelZone.get(svc.hotel_id) ?? null : null;
      const canonical = applyPickupCalc({
        direction: "departure",
        booking_service_kind: svc.booking_service_kind,
        time: vesselTime,
        billing_party_name: svc.billing_party_name,
        vessel: svc.vessel,
        hotel_zone: zone,
        hotel_name: svc.hotel_id ? hotelName.get(svc.hotel_id) ?? null : null,
      });
      pickup = canonical.pickup_hotel ?? "";
    }

    return {
      service_id: svc.id,
      customer_name: svc.customer_name,
      phone: svc.phone,
      hotel_name: svc.hotel_id ? hotelName.get(svc.hotel_id) ?? null : null,
      pax: svc.pax,
      pickup_time: pickup || null,
      vessel_time: vesselTime || null,
      booking_service_kind: svc.booking_service_kind,
    };
  });

  return { services: mapped };
}

export async function generateSnavRowsWithCoverage(
  admin: AdminClient,
  tenantId: string,
  date: string,
): Promise<{ error: string } | { rows: GeneratedSnavRowWithCoverage[]; summary: CoverageSummary }> {
  const fetched = await fetchSnavServicesForDate(admin, tenantId, date);
  if ("error" in fetched) return fetched;

  const { rows: generated } = buildGeneratedSnavConvocationRows(fetched.services, date, normalizeE164);

  const serviceIds = generated.map((r) => r.service_id);
  const phones = generated.map((r) => r.phone_e164).filter((p): p is string => !!p);
  const { byServiceId, byFallbackKey } = await loadSnavSentSnapshots(admin, tenantId, serviceIds, phones);

  const rows: GeneratedSnavRowWithCoverage[] = generated.map((row) => {
    const coverage = resolveCoverageForRow(
      {
        status: row.status,
        service_id: row.service_id,
        phone_e164: row.phone_e164,
        customer_name: row.customer_name,
        travel_date_iso: row.departure_date_iso,
        hotel: row.hotel,
        passengers: row.passengers,
        pickup_time: row.pickup_time,
        vessel_time: row.vessel_time,
      },
      byServiceId,
      byFallbackKey,
    );
    return { ...row, ...coverage };
  });

  const summary = buildCoverageSummary(rows.map((r) => r.coverage_status));
  return { rows, summary };
}
