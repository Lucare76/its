/**
 * GET /api/ops/diagnostics?date=YYYY-MM-DD
 *
 * Diagnostica Giornata — livello di controllo READ-ONLY sopra i dati gia'
 * esistenti (vedi lib/server/operational-day-diagnostics.ts). Nessun
 * ricalcolo di pickup/ferry/agenzia: carica tutto in batch (query fisse,
 * indipendenti dal numero di servizi) e delega l'interpretazione a
 * diagnoseOperationalDay().
 *
 * Query totali (fisse, mai per-riga — vedi report task):
 *  1. services (data + tenant)
 *  2. hotels (tenant)
 *  3. ferry_pickup_rules
 *  4. ferry_schedules
 *  5. assignments (IN sui service_id del giorno)
 *  6. tenant_bus_units (tenant)
 *  7. tenant_bus_allocations (IN sui service_id del giorno)
 *  8. bus_lot_configs (tenant + service_date)
 *  9. services (id, linked_service_id, date, direction, status — IN sui
 *     linked_service_id non presenti nel set del giorno) — unica query
 *     supplementare, riusata sia per BROKEN_LINKED_SERVICE (id assente dal
 *     risultato) sia per la reciprocita' INCONSISTENT_ROUND_TRIP cross-day
 *     (es. andata 28/08 -> ritorno 04/09), senza query per riga.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { diagnoseOperationalDay, type DiagnosticsHotelRow, type DiagnosticsLinkedServiceRef } from "@/lib/server/operational-day-diagnostics";
import type { PrintService } from "@/lib/piano-giorno-print";
import { romeDateKey } from "@/lib/server/operational-health/operations-health";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const date = url.searchParams.get("date")?.trim() || romeDateKey(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "Parametro 'date' non valido (atteso YYYY-MM-DD)." }, { status: 400 });
  }

  const tenantId = auth.membership.tenant_id;

  const [servicesResult, hotelsResult, rulesResult, schedulesResult, busUnitsResult, busLotConfigsResult] = await Promise.all([
    auth.admin.from("services").select("*").eq("tenant_id", tenantId).eq("date", date),
    auth.admin.from("hotels").select("id, name, zone").eq("tenant_id", tenantId),
    auth.admin.from("ferry_pickup_rules").select("*"),
    auth.admin
      .from("ferry_schedules")
      .select("company, departure_port, arrival_port, departure_time, arrival_time, direction, days_of_week, valid_from, valid_to"),
    auth.admin.from("tenant_bus_units").select("id,bus_line_id,label,capacity,low_seat_threshold,minimum_passengers,status,manual_close,close_reason,sort_order,active").eq("tenant_id", tenantId),
    auth.admin.from("bus_lot_configs").select("*").eq("tenant_id", tenantId).eq("service_date", date),
  ]);

  const firstError = servicesResult.error || hotelsResult.error || rulesResult.error || schedulesResult.error || busUnitsResult.error || busLotConfigsResult.error;
  if (firstError) {
    return NextResponse.json({ error: `Errore caricamento dati diagnostica: ${firstError.message}` }, { status: 500 });
  }

  const services = (servicesResult.data ?? []) as unknown as PrintService[];
  const serviceIds = services.map((s) => s.id);

  const [assignmentsResult, busAllocationsResult] = await Promise.all([
    serviceIds.length
      ? auth.admin.from("assignments").select("service_id, driver_user_id").eq("tenant_id", tenantId).in("service_id", serviceIds)
      : Promise.resolve({ data: [], error: null }),
    serviceIds.length
      ? auth.admin
          .from("tenant_bus_allocations")
          .select("id,service_id,bus_line_id,bus_unit_id,stop_id,stop_name,direction,pax_assigned,notes")
          .eq("tenant_id", tenantId)
          .in("service_id", serviceIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (assignmentsResult.error || busAllocationsResult.error) {
    return NextResponse.json({ error: "Errore caricamento assegnazioni/allocazioni bus." }, { status: 500 });
  }

  // BROKEN_LINKED_SERVICE: unica query batch supplementare, mai per riga.
  const dayServiceIds = new Set(serviceIds);
  const linkedIdsOutsideDay = Array.from(
    new Set(
      services
        .map((s) => s.linked_service_id)
        .filter((id): id is string => Boolean(id) && !dayServiceIds.has(id as string))
    )
  );
  // Righe thin dei linked_service_id fuori dalla giornata caricata (es.
  // andata 28/08 -> ritorno 04/09): un'unica query batch IN(...), mai una per
  // riga. Colonne minime per esistenza + reciprocita' (linked_service_id) +
  // coerenza cancellazione (status) — la data e' inclusa solo per debug/UI,
  // mai usata per giudicare anomalo un round trip multi-giorno.
  let externalLinkedServices: DiagnosticsLinkedServiceRef[] = [];
  if (linkedIdsOutsideDay.length > 0) {
    const { data: foundLinked, error: linkedError } = await auth.admin
      .from("services")
      .select("id, linked_service_id, date, direction, status")
      .eq("tenant_id", tenantId)
      .in("id", linkedIdsOutsideDay);
    if (linkedError) {
      return NextResponse.json({ error: "Errore verifica collegamenti andata/ritorno." }, { status: 500 });
    }
    externalLinkedServices = (foundLinked ?? []) as DiagnosticsLinkedServiceRef[];
  }

  const hotelsById = new Map(
    ((hotelsResult.data ?? []) as DiagnosticsHotelRow[]).map((h) => [h.id, h] as const)
  );

  const result = diagnoseOperationalDay({
    date,
    services,
    hotelsById,
    operationalRules: (rulesResult.data ?? []) as never,
    ferrySchedules: (schedulesResult.data ?? []) as never,
    assignments: (assignmentsResult.data ?? []) as { service_id: string; driver_user_id: string | null }[],
    busUnits: (busUnitsResult.data ?? []) as never,
    busAllocations: (busAllocationsResult.data ?? []) as never,
    busLotConfigs: (busLotConfigsResult.data ?? []) as never,
    externalLinkedServices,
  });

  return NextResponse.json({ ok: true, date, ...result });
}
