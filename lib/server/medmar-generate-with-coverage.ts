// Shared source for both GET /api/ops/medmar-convocations/generate-from-services
// (read-only preview) and POST .../create-batch-from-services (writes a real
// batch) — kept in one place so the two never compute a different set of
// rows/statuses for the same date. Read-only: no DB writes happen here.

import { normalizeE164, type createAdminClient } from "@/lib/server/whatsapp";
import { resolveOperationalTiming } from "@/lib/operational-timing-resolver";
import { fmtTime, type PrintService } from "@/lib/piano-giorno-print";
import {
  MEDMAR_DEPARTURE_KINDS,
  buildGeneratedConvocationRows,
  type ServiceForConvocation,
  type GeneratedConvocationRow,
} from "@/lib/medmar-generate-from-services";
import {
  resolveCoverageForRow,
  buildCoverageSummary,
  type CoverageResult,
  type CoverageSummary,
} from "@/lib/medmar-convocation-coverage";
import { loadMedmarSentSnapshots } from "@/lib/server/medmar-convocation-coverage-source";

type AdminClient = ReturnType<typeof createAdminClient>;

export type GeneratedRowWithCoverage = GeneratedConvocationRow & CoverageResult;

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

export async function fetchMedmarServicesForDate(
  admin: AdminClient,
  tenantId: string,
  date: string,
): Promise<{ error: string } | { services: ServiceForConvocation[] }> {
  const kinds = [...MEDMAR_DEPARTURE_KINDS];

  const hotelsRes = await admin.from("hotels").select("id, name").eq("tenant_id", tenantId);
  if (hotelsRes.error) return { error: hotelsRes.error.message };
  const hotelName = new Map((hotelsRes.data ?? []).map((h) => [h.id as string, h.name as string]));

  // Same departure-day pattern as /api/ops/departure-services: explicit
  // departure_date, plus direction=departure rows that only carry `date`.
  const [q1, q2] = await Promise.all([
    admin
      .from("services")
      .select(SERVICE_COLUMNS)
      .eq("tenant_id", tenantId)
      .eq("departure_date", date)
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

  const mapped: ServiceForConvocation[] = services.map((svc) => {
    // Level 2 of the canonical resolver (no context) — reads only the
    // fields already persisted on the service, the same source used by the
    // Piano del Giorno print. Never invents an orario, never emits 00:00.
    const timing = resolveOperationalTiming(svc as unknown as PrintService);
    const pickup = timing.pickupTime ?? fmtTime(svc.pickup_hotel) ?? fmtTime(svc.pickup_time) ?? "";
    const vesselTime = timing.ferryTime ?? fmtTime(svc.orario_barca) ?? fmtTime(svc.departure_time) ?? "";
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

  return { services: mapped };
}

export async function generateMedmarRowsWithCoverage(
  admin: AdminClient,
  tenantId: string,
  date: string,
): Promise<{ error: string } | { rows: GeneratedRowWithCoverage[]; summary: CoverageSummary }> {
  const fetched = await fetchMedmarServicesForDate(admin, tenantId, date);
  if ("error" in fetched) return fetched;

  const { rows: generated } = buildGeneratedConvocationRows(fetched.services, date, normalizeE164);

  const serviceIds = generated.map((r) => r.service_id);
  const phones = generated.map((r) => r.phone_e164).filter((p): p is string => !!p);
  const { byServiceId, byFallbackKey } = await loadMedmarSentSnapshots(admin, tenantId, serviceIds, phones);

  const rows: GeneratedRowWithCoverage[] = generated.map((row) => {
    const coverage = resolveCoverageForRow(
      {
        status: row.status,
        service_id: row.service_id,
        phone_e164: row.phone_e164,
        customer_name: row.customer_name,
        travel_date_iso: row.travel_date_iso,
        hotel: row.hotel,
        passengers: row.passengers,
        pickup_time: row.pickup_time,
        vessel_time: row.departure_time,
      },
      byServiceId,
      byFallbackKey,
    );
    return { ...row, ...coverage };
  });

  const summary = buildCoverageSummary(rows.map((r) => r.coverage_status));
  return { rows, summary };
}
