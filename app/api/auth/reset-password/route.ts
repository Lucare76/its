import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/server/whatsapp";
import { isDisposableEmail, hasDeliverableEmailDomain } from "@/lib/email-validation";
import { sendPasswordResetEmail } from "@/lib/server/password-reset-email";
import { checkRateLimit, RATE_LIMIT_DEFAULTS, type RateLimitConfig } from "@/lib/server/rate-limit";
import { sendSecurityAlert } from "@/lib/server/security-alert-email";
import { adminGetUserByEmail } from "@/lib/server/admin-user-lookup";

const bodySchema = z.object({
  email: z.string().email("Email non valida"),
});

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Email non valida." }, { status: 400 });
  }
  const email = parsed.data.email.trim().toLowerCase();

  // Rate limiting by email
  const ipAddress = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown";
  const rateLimitCheck = await checkRateLimit("reset_password", email, RATE_LIMIT_DEFAULTS.resetPassword as RateLimitConfig);
  
  if (!rateLimitCheck.allowed) {
    await sendSecurityAlert({
      type: 'rate_limit_exceeded',
      email,
      ip_address: ipAddress,
      details: { endpoint: '/api/auth/reset-password', attemptCount: RATE_LIMIT_DEFAULTS.resetPassword.maxAttempts }
    }).then(() => undefined, () => undefined);
    
    return NextResponse.json(
      { error: "Troppi tentativi di reset. Riprova tra 1 ora." },
      { status: 429, headers: { "Retry-After": "3600" } }
    );
  }

  if (isDisposableEmail(email)) {
    return NextResponse.json({ error: "Email temporanea o usa e getta non consentita." }, { status: 400 });
  }

  if (!(await hasDeliverableEmailDomain(email))) {
    return NextResponse.json({ error: "Dominio email non valido o non raggiungibile. Usa un indirizzo valido." }, { status: 400 });
  }

  const admin = createAdminClient();
  const { user: existingUser, error: getUserError } = await adminGetUserByEmail(email);
  if (getUserError) {
    return NextResponse.json({ error: "Errore interno durante la ricerca utente." }, { status: 500 });
  }

  if (!existingUser?.id) {
    // Per sicurezza, non riveliamo se l'email esiste o meno, ma logghiamo il tentativo
    await admin
      .from("auth_audit_log")
      .insert({
        event_type: "reset_password_requested",
        status: "success",
        ip_address: ipAddress,
        details: { email, user_found: false }
      })
      .then(() => undefined, () => undefined);

    return NextResponse.json({ ok: true, message: "Controlla la tua casella di posta per le istruzioni." }, { status: 200 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() || request.nextUrl.origin;
  const redirectTo = `${appUrl.replace(/\/$/, "")}/auth/update-password`;
  const linkResult = await admin.auth.admin.generateLink({
    type: "recovery",
    email,
    options: {
      redirectTo
    }
  });

  const resetUrl = linkResult.data?.properties?.action_link ?? null;
  if (linkResult.error || !resetUrl) {
    await admin
      .from("auth_audit_log")
      .insert({
        user_id: existingUser.id,
        event_type: "reset_password_requested",
        status: "failed",
        ip_address: ipAddress,
        details: { email, error: linkResult.error?.message ?? "Reset link generation failed" }
      })
      .then(() => undefined, () => undefined);

    return NextResponse.json({ error: "Impossibile generare il link di reset." }, { status: 500 });
  }

  const sendResult = await sendPasswordResetEmail({
    to: email,
    fullName: (existingUser.user_metadata as { full_name?: string } | null)?.full_name ?? email,
    resetUrl
  });

  if (sendResult.status !== "sent") {
    await admin
      .from("auth_audit_log")
      .insert({
        user_id: existingUser.id,
        event_type: "reset_password_requested",
        status: "failed",
        ip_address: ipAddress,
        details: { email, error: `Reset email send failed: ${sendResult.error}` }
      })
      .then(() => undefined, () => undefined);

    return NextResponse.json({ error: sendResult.error ?? "Invio email reset fallito." }, { status: 500 });
  }

  await admin
    .from("auth_audit_log")
    .insert({
      user_id: existingUser.id,
      event_type: "reset_password_requested",
      status: "success",
      ip_address: ipAddress,
      details: { email }
    })
    .then(() => undefined, () => undefined);

  return NextResponse.json({ ok: true, message: "Se l'account esiste, abbiamo inviato un link per reimpostare la password." }, { status: 200 });
}
