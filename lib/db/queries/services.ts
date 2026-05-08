import type { SupabaseClient } from "@supabase/supabase-js";

export type ServiceRow = {
  id: string;
  tenant_id: string;
  date: string;
  time: string;
  status: string;
  service_type_code: string | null;
  booking_service_kind: string | null;
  customer_name: string | null;
  pax: number;
  hotel_id: string | null;
  vehicle_id: string | null;
  driver_user_id: string | null;
  notes: string | null;
  [key: string]: unknown;
};

export async function queryTenantServices(
  admin: SupabaseClient,
  tenantId: string,
  opts?: { date?: string; status?: string | string[] }
) {
  let q = admin
    .from("services")
    .select("*")
    .eq("tenant_id", tenantId);

  if (opts?.date) q = q.eq("date", opts.date);
  if (Array.isArray(opts?.status)) {
    q = q.in("status", opts.status);
  } else if (opts?.status) {
    q = q.eq("status", opts.status);
  }

  return q.order("date").order("time");
}

export async function queryTenantServicesForDate(
  admin: SupabaseClient,
  tenantId: string,
  date: string
) {
  return queryTenantServices(admin, tenantId, { date });
}
