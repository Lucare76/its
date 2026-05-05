import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";
import {
  sendDirectInviteEmail,
  generateInviteToken,
  getInviteExpiration,
} from "@/lib/server/direct-invite-email";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const { admin, membership } = auth;

  const [invitesRes, membershipsRes] = await Promise.all([
    admin
      .from("direct_invites")
      .select("id, email, full_name, agency_id, expires_at, accepted_at, rejected_at, created_at")
      .eq("tenant_id", membership.tenant_id)
      .eq("role", "agency")
      .order("created_at", { ascending: false }),
    admin
      .from("memberships")
      .select("user_id, agency_id, full_name, suspended")
      .eq("tenant_id", membership.tenant_id)
      .eq("role", "agency"),
  ]);

  return NextResponse.json({
    invites: invitesRes.data ?? [],
    memberships: membershipsRes.data ?? [],
  });
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => null) as {
    agency_id?: string;
    email?: string;
    full_name?: string;
  } | null;

  if (!body?.agency_id || !body?.email || !body?.full_name) {
    return NextResponse.json({ error: "Dati mancanti." }, { status: 400 });
  }

  const { admin, user, membership } = auth;
  const email = body.email.trim().toLowerCase();
  const fullName = body.full_name.trim();
  const agencyId = body.agency_id;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Email non valida." }, { status: 400 });
  }
  if (!fullName) {
    return NextResponse.json({ error: "Nome contatto obbligatorio." }, { status: 400 });
  }

  const { data: agency } = await admin
    .from("agencies")
    .select("id, name")
    .eq("id", agencyId)
    .eq("tenant_id", membership.tenant_id)
    .maybeSingle();

  if (!agency) {
    return NextResponse.json({ error: "Agenzia non trovata." }, { status: 404 });
  }

  // Cancel any pending invites for this agency before creating a new one
  await admin
    .from("direct_invites")
    .update({ rejected_at: new Date().toISOString() })
    .eq("tenant_id", membership.tenant_id)
    .eq("agency_id", agencyId)
    .eq("role", "agency")
    .is("accepted_at", null)
    .is("rejected_at", null);

  const inviteToken = generateInviteToken();
  const expiresAt = getInviteExpiration(7);

  const { data: invite, error: insertError } = await admin
    .from("direct_invites")
    .insert({
      tenant_id: membership.tenant_id,
      invited_by_user_id: user.id,
      email,
      full_name: fullName,
      role: "agency",
      agency_id: agencyId,
      invite_token: inviteToken,
      expires_at: expiresAt.toISOString(),
    })
    .select("id")
    .single();

  if (insertError || !invite) {
    return NextResponse.json(
      { error: insertError?.message ?? "Errore creazione invito." },
      { status: 500 }
    );
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const acceptUrl = `${appUrl}/auth/accept-invite?token=${inviteToken}`;

  const emailResult = await sendDirectInviteEmail({ to: email, fullName, inviteToken, acceptUrl });

  auditLog({
    event: "agency_portal_invite_sent",
    level: "info",
    tenantId: membership.tenant_id,
    userId: user.id,
    details: {
      agency_id: agencyId,
      agency_name: agency.name,
      invite_id: invite.id,
      email,
      email_status: emailResult.status,
    },
  });

  return NextResponse.json({ ok: true, invite_id: invite.id, email_status: emailResult.status });
}
