import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveCollectiveReservations, type CollectiveConvocation } from "@/lib/piano-collective-convocations";
import type { ConvocationArrival } from "@/lib/piano-arrival-convocations";

export async function loadCollectiveConvocations(admin: SupabaseClient, tenantId: string, date: string) {
  const { data, error } = await admin.from("collective_ferry_convocations").select("event_key, active, last_departure, margin_min, margin_max, updated_at")
    .eq("tenant_id", tenantId).eq("date", date);
  // Before migration deployment no feature can have been enabled. Other errors must fail closed.
  if (error) {
    if (error.code === "42P01" || error.code === "PGRST205") return [];
    throw new Error(`Convocazioni TUTTI: ${error.message}`);
  }
  return (data ?? []).map((row) => ({ ...row, date, last_departure: row.last_departure.slice(0, 5) })) as CollectiveConvocation[];
}

export async function loadCollectiveReservations(admin: SupabaseClient, tenantId: string, date: string) {
  const configs = await loadCollectiveConvocations(admin, tenantId, date);
  if (!configs.some((entry) => entry.active)) return [];
  const { data, error } = await admin.from("services")
    .select("id, direction, status, time, pax, vessel, meeting_point, origin_place_type, origin_place_id, hotel_id, destination_place_id, orario_barca, ferry_details")
    .eq("tenant_id", tenantId).eq("date", date).eq("direction", "arrival").neq("status", "cancelled").neq("is_draft", true).limit(3000);
  if (error) throw new Error(error.message);
  return resolveCollectiveReservations(configs, (data ?? []) as ConvocationArrival[]);
}
