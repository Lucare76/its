import type { SupabaseClient } from "@supabase/supabase-js";

/** Resolve canonical stop names, never pickup notes or meeting points. */
export async function invoiceBusStops(admin: SupabaseClient, tenantId: string, services: Array<{ id: string; booking_service_kind?: string | null; service_type?: string | null; meeting_point?: string | null; vessel?: string | null; bus_city_origin?: string | null }>): Promise<Map<string, string>> {
  const ids = services.filter(s => s.booking_service_kind === "bus_city_hotel" || s.service_type === "bus_tour").map(s => s.id);
  const names = new Map<string, string>();
  if (!ids.length) return names;
  const { data: allocations, error } = await admin.from("tenant_bus_allocations").select("service_id,stop_id,direction").eq("tenant_id", tenantId).in("service_id", ids);
  if (error) throw new Error(error.message);
  const { data: stops, error: stopError } = await admin.from("tenant_bus_line_stops").select("id,stop_name,city,pickup_note").eq("tenant_id", tenantId);
  if (stopError) throw new Error(stopError.message);
  const byId = new Map((stops ?? []).map(s => [s.id, s.stop_name]));
  // Use arrival allocation for a booking with both legs; deduplicate splits.
  for (const id of ids) {
    const rows = (allocations ?? []).filter(a => a.service_id === id);
    const arrivals = rows.filter(a => a.direction === "arrival");
    const labels = [...new Set((arrivals.length ? arrivals : rows).map(a => byId.get(a.stop_id)?.trim()).filter(Boolean))];
    if (labels.length) names.set(id, labels.join(" / "));
  }
  const norm = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  for (const service of services.filter(s => ids.includes(s.id) && !names.has(s.id))) {
    const refs = [service.bus_city_origin, service.meeting_point, service.vessel].filter((v): v is string => Boolean(v?.trim())).map(norm);
    const candidates = (stops ?? []).filter(stop => {
      const label = norm(stop.stop_name || "");
      const city = norm(stop.city || "");
      const pickup = norm(stop.pickup_note || "");
      return refs.some(ref => [label, city, pickup, `${pickup} ${label}`, `${pickup} ${city}`].filter(Boolean).includes(ref)
        || (city && (` ${ref} `).includes(` ${city} `)));
    });
    const labels = [...new Set(candidates.map(s => s.stop_name?.trim()).filter(Boolean))];
    if (labels.length === 1) names.set(service.id, labels[0]);
  }
  return names;
}
