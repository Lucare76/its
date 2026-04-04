import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/server/whatsapp";
import { generateInviteToken, getInviteExpiration, sendDirectInviteEmail } from "@/lib/server/direct-invite-email";
import { isDisposableEmail, hasDeliverableEmailDomain } from "@/lib/email-validation";
import { z } from "zod";

const directInviteSchema = z.object({
  email: z.string().email("Email non valida"),
  full_name: z.string().min(1, "Nome richiesto"),
  role: z.enum(["admin", "operator", "driver", "agency"]),
  agency_id: z.string().uuid().optional().nullable()
});

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const admin = createAdminClient();
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = authHeader.slice("Bearer ".length);
  const { data: { user }, error: authError } = await admin.auth.getUser(token);
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Get admin's membership and tenant
  const { data: memberships, error: membershipError } = await admin
    .from("memberships")
    .select("tenant_id, role")
    .eq("user_id", user.id);

  const membershipRows = (memberships ?? []) as Array<{ tenant_id: string; role: string }>;
  const adminMembership = membershipRows.find((m) => m.role === "admin");

  if (membershipError || !adminMembership?.tenant_id) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const parsed = directInviteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid payload" },
      { status: 400 }
    );
  }

  const email = parsed.data.email.trim().toLowerCase();
  const fullName = parsed.data.full_name.trim();
  const role = parsed.data.role;
  const agencyId = parsed.data.agency_id;

  // Validate email
  if (isDisposableEmail(email)) {
    return NextResponse.json({ error: "Email temporanea non consentita" }, { status: 400 });
  }

  if (!(await hasDeliverableEmailDomain(email))) {
    return NextResponse.json({ error: "Dominio email non valido" }, { status: 400 });
  }

  // Check if user already exists
  const listResult = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listResult.error) {
    return NextResponse.json({ error: "Error checking existing users" }, { status: 500 });
  }

  const existingUser = (listResult.data?.users ?? []).find((u) => u.email?.toLowerCase() === email);
  if (existingUser) {
    return NextResponse.json({ error: "Utente già registrato" }, { status: 409 });
  }

  // Check if invite already exists
  const existingInvite = await admin
    .from("direct_invites")
    .select("id, accepted_at")
    .eq("email", email)
    .eq("tenant_id", adminMembership.tenant_id)
    .is("accepted_at", null)
    .is("rejected_at", null)
    .maybeSingle();

  if (existingInvite.error) {
    return NextResponse.json({ error: existingInvite.error.message }, { status: 500 });
  }

  if (existingInvite.data?.id) {
    return NextResponse.json({ error: "Invito già esistente per questa email" }, { status: 409 });
  }

  // Generate invite token
  const inviteToken = generateInviteToken();
  const expiresAt = getInviteExpiration(7);

  // Insert invite
  const inviteInsert = await admin
    .from("direct_invites")
    .insert({
      tenant_id: adminMembership.tenant_id,
      invited_by_user_id: user.id,
      email,
      full_name: fullName,
      role,
      agency_id: agencyId || null,
      invite_token: inviteToken,
      expires_at: expiresAt.toISOString()
    })
    .select("id")
    .maybeSingle();

  if (inviteInsert.error || !inviteInsert.data?.id) {
    return NextResponse.json({ error: "Errore creazione invito" }, { status: 500 });
  }

  // Send invite email
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() || request.nextUrl.origin;
  const acceptUrl = `${appUrl.replace(/\/$/, "")}/auth/accept-invite?token=${inviteToken}`;

  const sendResult = await sendDirectInviteEmail({
    to: email,
    fullName,
    inviteToken,
    acceptUrl
  });

  if (sendResult.status === "failed") {
    return NextResponse.json({ error: sendResult.error ?? "Errore invio email" }, { status: 500 });
  }

  // Log audit
  await admin
    .from("auth_audit_log")
    .insert({
      user_id: user.id,
      event_type: "account_created_by_admin",
      status: "success",
      ip_address: request.headers.get("x-forwarded-for") || "unknown",
      details: { email, full_name: fullName, role, method: "direct_invite" }
    })
    .then(() => undefined, () => undefined);

  return NextResponse.json(
    {
      ok: true,
      invite_id: inviteInsert.data.id,
      message: `Invito inviato a ${email}. Valido 7 giorni.`
    },
    { status: 201 }
  );
}
