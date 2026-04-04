import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const [servicesResult, assignmentsResult, hotelsResult, membershipsResult, inboundResult] = await Promise.all([
      auth.admin.from("services").select("*").eq("tenant_id", auth.membership.tenant_id),
      auth.admin.from("assignments").select("*").eq("tenant_id", auth.membership.tenant_id),
      auth.admin.from("hotels").select("*").eq("tenant_id", auth.membership.tenant_id),
      auth.admin
        .from("memberships")
        .select("user_id, tenant_id, role, full_name")
        .eq("tenant_id", auth.membership.tenant_id),
      auth.admin.from("inbound_emails").select("*").eq("tenant_id", auth.membership.tenant_id)
    ]);

    const error =
      servicesResult.error ??
      assignmentsResult.error ??
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
      services: servicesResult.data ?? [],
      assignments: assignmentsResult.data ?? [],
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
