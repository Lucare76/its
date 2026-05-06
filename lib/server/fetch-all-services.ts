import type { SupabaseClient } from "@supabase/supabase-js";
import type { Service } from "@/lib/types";

const PAGE = 1000;

export async function fetchAllServices(admin: SupabaseClient, tenantId: string) {
  const all: Service[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await admin
      .from("services")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { data: null, error };
    if (data) all.push(...(data as Service[]));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return { data: all, error: null };
}
