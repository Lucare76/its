import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

async function fetchAllServices(admin: SupabaseClient, tenantId: string) {
  const PAGE = 1000;
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

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const includeInboundEmails = request.nextUrl.searchParams.get("include_inbound_emails") === "true";

    const [servicesResult, assignmentsResult, busLotConfigsResult, statusEventsResult, hotelsResult, membershipsResult, inboundResult] =
      await Promise.all([
        fetchAllServices(auth.admin, auth.membership.tenant_id),
        auth.admin.from("assignments").select("*").eq("tenant_id", auth.membership.tenant_id),
        (async () => {
          const result = await auth.admin.from("bus_lot_configs").select("*").eq("tenant_id", auth.membership.tenant_id);
          return result.error ? { data: [], error: null } : result;
        })(),
        auth.admin.from("status_events").select("*").eq("tenant_id", auth.membership.tenant_id),
        auth.admin.from("hotels").select("*").eq("tenant_id", auth.membership.tenant_id),
        auth.admin
          .from("memberships")
          .select("user_id, tenant_id, role, full_name")
          .eq("tenant_id", auth.membership.tenant_id),
        includeInboundEmails
          ? auth.admin.from("inbound_emails").select("*").eq("tenant_id", auth.membership.tenant_id)
          : Promise.resolve({ data: [], error: null })
      ]);

    const error =
      servicesResult.error ??
      assignmentsResult.error ??
      statusEventsResult.error ??
      hotelsResult.error ??
      membershipsResult.error ??
      inboundResult.error;

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      tenant_id: auth.membership.tenant_id,
      user_id: auth.user.id,
      role: auth.membership.role,
      services: servicesResult.data ?? [],
      assignments: assignmentsResult.data ?? [],
      bus_lot_configs: busLotConfigsResult.data ?? [],
      status_events: statusEventsResult.data ?? [],
      hotels: hotelsResult.data ?? [],
      memberships: membershipsResult.data ?? [],
      inbound_emails: inboundResult.data ?? []
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
