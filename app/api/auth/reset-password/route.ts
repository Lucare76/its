import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/server/whatsapp";
import { isDisposableEmail, hasDeliverableEmailDomain } from "@/lib/email-validation";
import { sendTemporaryPasswordEmail } from "@/lib/server/password-reset-email";
import { checkRateLimit, RATE_LIMIT_DEFAULTS, type RateLimitConfig } from "@/lib/server/rate-limit";
import { sendSecurityAlert } from "@/lib/server/security-alert-email";

function generateTemporaryPassword(length = 12) {
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,.<>?";
  let result = "";
  for (let i = 0; i < length; i += 1) {
    result += charset[Math.floor(Math.random() * charset.length)];
  }
  return result;
}

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.email !== "string") {
    return NextResponse.json({ error: "Email richiesta" }, { status: 400 });
  }

  const email = body.email.trim().toLowerCase();
  if (!email.match(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)) {
    return NextResponse.json({ error: "Email non valida" }, { status: 400 });
  }

  // Rate limiting by email
  const ipAddress = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown";
  const rateLimitCheck = checkRateLimit("reset_password", email, RATE_LIMIT_DEFAULTS.resetPassword as RateLimitConfig);
  
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
  const listResult = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listResult.error) {
    return NextResponse.json({ error: "Errore interno durante la ricerca utente." }, { status: 500 });
  }

  const existingUser = (listResult.data?.users ?? []).find((u) => u.email?.toLowerCase() === email) ?? null;

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

  const temporaryPassword = generateTemporaryPassword(14);

  const updateResult = await admin.auth.admin.updateUserById(existingUser.id, {
    password: temporaryPassword,
    data: {
      ...((existingUser.user_metadata ?? {}) as Record<string, unknown>),
      password_change_required: true
    }
  });

  if (updateResult.error) {
    await admin
      .from("auth_audit_log")
      .insert({
        user_id: existingUser.id,
        event_type: "reset_password_requested",
        status: "failed",
        ip_address: ipAddress,
        details: { email, error: updateResult.error.message }
      })
      .then(() => undefined, () => undefined);

    return NextResponse.json({ error: "Impossibile generare password temporanea." }, { status: 500 });
  }

  const sendResult = await sendTemporaryPasswordEmail({
    to: email,
    fullName: (existingUser.user_metadata as any)?.full_name ?? email,
    tempPassword: temporaryPassword
  });

  if (sendResult.status === "failed") {
    await admin
      .from("auth_audit_log")
      .insert({
        user_id: existingUser.id,
        event_type: "reset_password_requested",
        status: "failed",
        ip_address: ipAddress,
        details: { email, error: `Email send failed: ${sendResult.error}` }
      })
      .then(() => undefined, () => undefined);

    return NextResponse.json({ error: sendResult.error ?? "Invio email temporanea fallito." }, { status: 500 });
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

  return NextResponse.json({ ok: true, message: "Email con password temporanea inviata." }, { status: 200 });
}
