import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/server/whatsapp";
import { generateOtpCode, getOtpExpiration } from "@/lib/server/otp-utils";
import { sendOtpEmail } from "@/lib/server/otp-email";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.user_id !== "string" || typeof body.email !== "string") {
    return NextResponse.json({ error: "user_id e email richiesti" }, { status: 400 });
  }

  const userId = body.user_id.trim();
  const email = body.email.trim().toLowerCase();
  const fullName = body.full_name || email;

  if (!userId || !email.match(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)) {
    return NextResponse.json({ error: "Dati non validi" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Generate OTP
  const otpCode = generateOtpCode(6);
  const expiresAt = getOtpExpiration(10);

  // Clean up old OTP sessions for this user
  await admin
    .from("otp_sessions")
    .delete()
    .eq("user_id", userId)
    .lt("expires_at", new Date().toISOString())
    .then(() => undefined, () => undefined);

  // Delete any existing pending OTP for this user
  await admin
    .from("otp_sessions")
    .delete()
    .eq("user_id", userId)
    .is("verified_at", null)
    .then(() => undefined, () => undefined);

  // Insert new OTP session
  const otpInsert = await admin
    .from("otp_sessions")
    .insert({
      user_id: userId,
      email,
      otp_code: otpCode,
      attempts_remaining: 3,
      expires_at: expiresAt.toISOString()
    })
    .select("id")
    .maybeSingle();

  if (otpInsert.error || !otpInsert.data?.id) {
    return NextResponse.json({ error: "Impossibile generare OTP" }, { status: 500 });
  }

  // Send email
  const sendResult = await sendOtpEmail({
    to: email,
    fullName,
    otpCode
  });

  if (sendResult.status === "failed") {
    return NextResponse.json({ error: sendResult.error ?? "Invio OTP fallito" }, { status: 500 });
  }

  // Log in audit
  await admin
    .from("auth_audit_log")
    .insert({
      user_id: userId,
      event_type: "login",
      status: "success",
      ip_address: request.headers.get("x-forwarded-for") || "unknown",
      details: { otp_sent: true, email }
    })
    .then(() => undefined, () => undefined);

  return NextResponse.json({
    ok: true,
    message: "Codice OTP inviato alla tua email. Valido 10 minuti.",
    session_id: otpInsert.data.id
  });
}
