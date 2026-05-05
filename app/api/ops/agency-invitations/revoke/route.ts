import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => null) as {
    agency_id?: string;
    action?: "revoke" | "reinstate";
  } | null;

  if (!body?.agency_id) {
    return NextResponse.json({ error: "agency_id mancante." }, { status: 400 });
  }

  const { admin, user, membership } = auth;
  const agencyId = body.agency_id;
  const action = body.action ?? "revoke";

  if (action === "revoke") {
    await admin
      .from("direct_invites")
      .update({ rejected_at: new Date().toISOString() })
      .eq("tenant_id", membership.tenant_id)
      .eq("agency_id", agencyId)
      .eq("role", "agency")
      .is("accepted_at", null)
      .is("rejected_at", null);

    const { data: suspended } = await admin
      .from("memberships")
      .update({ suspended: true })
      .eq("tenant_id", membership.tenant_id)
      .eq("agency_id", agencyId)
      .eq("role", "agency")
      .select("user_id");

    auditLog({
      event: "agency_portal_access_revoked",
      level: "info",
      tenantId: membership.tenant_id,
      userId: user.id,
      details: {
        agency_id: agencyId,
        suspended_users: (suspended ?? []).map((m: { user_id: string }) => m.user_id),
      },
    });
  } else if (action === "reinstate") {
    await admin
      .from("memberships")
      .update({ suspended: false })
      .eq("tenant_id", membership.tenant_id)
      .eq("agency_id", agencyId)
      .eq("role", "agency");

    auditLog({
      event: "agency_portal_access_reinstated",
      level: "info",
      tenantId: membership.tenant_id,
      userId: user.id,
      details: { agency_id: agencyId },
    });
  } else {
    return NextResponse.json({ error: "Azione non valida." }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
