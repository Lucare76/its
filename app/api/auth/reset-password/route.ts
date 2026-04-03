import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/server/whatsapp";
import { isDisposableEmail, hasDeliverableEmailDomain } from "@/lib/email-validation";
import { sendTemporaryPasswordEmail } from "@/lib/server/password-reset-email";

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
    // Per sicurezza, non riveliamo se l'email esiste o meno
    return NextResponse.json({ ok: true, message: "Controlla la tua casella di posta per le istruzioni." }, { status: 200 });
  }

  const temporaryPassword = generateTemporaryPassword(14);

  const updateResult = await admin.auth.admin.updateUserById(existingUser.id, {
    password: temporaryPassword,
    user_metadata: {
      ...((existingUser.user_metadata ?? {}) as Record<string, unknown>),
      password_change_required: true
    }
  });

  if (updateResult.error) {
    return NextResponse.json({ error: "Impossibile generare password temporanea." }, { status: 500 });
  }

  const sendResult = await sendTemporaryPasswordEmail({
    to: email,
    fullName: (existingUser.user_metadata as any)?.full_name ?? email,
    tempPassword: temporaryPassword
  });

  if (sendResult.status === "failed") {
    return NextResponse.json({ error: sendResult.error ?? "Invio email temporanea fallito." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, message: "Email con password temporanea inviata." }, { status: 200 });
}
