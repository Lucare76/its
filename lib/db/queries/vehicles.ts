import type { SupabaseClient } from "@supabase/supabase-js";

export async function queryTenantVehicles(
  admin: SupabaseClient,
  tenantId: string,
  opts?: { activeOnly?: boolean }
) {
  let q = admin
    .from("vehicles")
    .select("*")
    .eq("tenant_id", tenantId);

  if (opts?.activeOnly) q = q.eq("active", true);

  return q.order("label");
}

export async function queryVehicleById(
  admin: SupabaseClient,
  tenantId: string,
  vehicleId: string
) {
  return admin
    .from("vehicles")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("id", vehicleId)
    .maybeSingle();
}
