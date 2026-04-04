import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/server/whatsapp";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.user_id !== "string" || typeof body.otp_code !== "string") {
    return NextResponse.json({ error: "user_id e otp_code richiesti" }, { status: 400 });
  }

  const userId = body.user_id.trim();
  const otpCode = body.otp_code.trim();

  if (!userId || !otpCode || otpCode.length !== 6 || !/^\d+$/.test(otpCode)) {
    return NextResponse.json({ error: "OTP non valido" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Find active OTP session
  const otpLookup = await admin
    .from("otp_sessions")
    .select("id, otp_code, attempts_remaining, expires_at")
    .eq("user_id", userId)
    .is("verified_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (otpLookup.error || !otpLookup.data) {
    return NextResponse.json({ error: "Sessione OTP non trovata o scaduta" }, { status: 404 });
  }

  const otpSession = otpLookup.data;

  // Check if expired
  if (new Date(otpSession.expires_at) < new Date()) {
    await admin
      .from("otp_sessions")
      .delete()
      .eq("id", otpSession.id)
      .catch(() => undefined);

    return NextResponse.json({ error: "OTP scaduto. Richiedi un nuovo codice" }, { status: 410 });
  }

  // Check attempts
  if (otpSession.attempts_remaining <= 0) {
    await admin
      .from("otp_sessions")
      .delete()
      .eq("id", otpSession.id)
      .catch(() => undefined);

    return NextResponse.json({ error: "Troppi tentativi falliti. Richiedi un nuovo OTP" }, { status: 429 });
  }

  // Verify OTP
  if (otpSession.otp_code !== otpCode) {
    const newAttempts = otpSession.attempts_remaining - 1;
    await admin
      .from("otp_sessions")
      .update({ attempts_remaining: newAttempts })
      .eq("id", otpSession.id)
      .catch(() => undefined);

    const remaining = Math.max(0, newAttempts);
    return NextResponse.json(
      { error: `OTP non corretto. Tentativi rimasti: ${remaining}` },
      { status: 401 }
    );
  }

  // Mark as verified
  const verifyResult = await admin
    .from("otp_sessions")
    .update({ verified_at: new Date().toISOString() })
    .eq("id", otpSession.id)
    .select("id")
    .maybeSingle();

  if (verifyResult.error) {
    return NextResponse.json({ error: "Errore durante la verifica OTP" }, { status: 500 });
  }

  // Log successful 2FA
  await admin
    .from("auth_audit_log")
    .insert({
      user_id: userId,
      event_type: "login",
      status: "success",
      ip_address: request.headers.get("x-forwarded-for") || "unknown",
      details: { otp_verified: true }
    })
    .catch(() => undefined);

  return NextResponse.json({
    ok: true,
    message: "OTP verificato correttamente"
  });
}
