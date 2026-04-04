import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/server/whatsapp";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.token !== "string" || typeof body.password !== "string") {
    return NextResponse.json({ error: "Token e password richiesti" }, { status: 400 });
  }

  const token = body.token.trim();
  const password = body.password.trim();

  if (!token || password.length < 8) {
    return NextResponse.json({ error: "Token o password non validi" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Find invite
  const inviteLookup = await admin
    .from("direct_invites")
    .select("*")
    .eq("invite_token", token)
    .is("accepted_at", null)
    .is("rejected_at", null)
    .maybeSingle();

  if (inviteLookup.error || !inviteLookup.data) {
    return NextResponse.json({ error: "Invito non trovato o scaduto" }, { status: 404 });
  }

  const invite = inviteLookup.data as any;

  // Check if expired
  if (new Date(invite.expires_at) < new Date()) {
    return NextResponse.json({ error: "Invito scaduto" }, { status: 410 });
  }

  // Create user
  const userResult = await admin.auth.admin.createUser({
    email: invite.email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name: invite.full_name
    }
  });

  if (userResult.error || !userResult.data.user) {
    return NextResponse.json({ error: userResult.error?.message ?? "Errore creazione utente" }, { status: 500 });
  }

  const newUserId = userResult.data.user.id;

  // Create membership
  const membershipInsert = await admin.from("memberships").insert({
    user_id: newUserId,
    tenant_id: invite.tenant_id,
    agency_id: invite.agency_id || null,
    role: invite.role,
    full_name: invite.full_name
  });

  if (membershipInsert.error) {
    await admin.auth.admin.deleteUser(newUserId).catch(() => undefined);
    return NextResponse.json({ error: membershipInsert.error.message }, { status: 500 });
  }

  // Mark invite as accepted
  await admin
    .from("direct_invites")
    .update({ accepted_at: new Date().toISOString() })
    .eq("id", invite.id)
    .then(() => undefined, () => undefined);

  // Log audit
  await admin
    .from("auth_audit_log")
    .insert({
      user_id: newUserId,
      event_type: "account_created_by_admin",
      status: "success",
      details: { email: invite.email, method: "accept_direct_invite", role: invite.role }
    })
    .catch(() => undefined);

  return NextResponse.json({
    ok: true,
    message: "Accesso creato correttamente. Puoi ora accedere con la tua email e password.",
    user_id: newUserId
  });
}
