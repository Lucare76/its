import type { SupabaseClient } from "@supabase/supabase-js";

const PAGE = 1000;

export async function fetchAllServices(admin: SupabaseClient, tenantId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await admin
      .from("services")
      .select("*")
      .eq("tenant_id", tenantId)
      .range(from, from + PAGE - 1);
    if (error) return { data: null, error };
    if (data) all.push(...data);
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return { data: all, error: null };
}
