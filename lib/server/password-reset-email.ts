export type PasswordResetEmailStatus = "sent" | "failed" | "skipped";

export interface PasswordResetEmailInput {
  to: string | null;
  fullName: string;
  resetUrl: string;
}

export interface PasswordResetEmailResult {
  status: PasswordResetEmailStatus;
  error: string | null;
}

function buildPlainText(input: PasswordResetEmailInput) {
  return [
    `Ciao ${input.fullName},`,
    "",
    "abbiamo ricevuto una richiesta di reset password per il tuo accesso Ischia Transfer.",
    "",
    "Apri questo link per impostare una nuova password:",
    input.resetUrl,
    "",
    "Se non hai richiesto tu il reset, puoi ignorare questa email.",
    "",
    "Grazie."
  ].join("\n");
}

function buildHtml(input: PasswordResetEmailInput) {
  return [
    `<p>Ciao ${input.fullName},</p>`,
    "<p>abbiamo ricevuto una richiesta di reset password per il tuo accesso Ischia Transfer.</p>",
    `<p><a href="${input.resetUrl}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#0f172a;color:#ffffff;text-decoration:none;font-weight:600">Imposta nuova password</a></p>`,
    `<p>Se il bottone non funziona, copia e incolla questo link nel browser:<br /><a href="${input.resetUrl}">${input.resetUrl}</a></p>`,
    "<p>Se non hai richiesto tu il reset, puoi ignorare questa email.</p>",
    "<p>Grazie.</p>"
  ].join("");
}

export async function sendPasswordResetEmail(input: PasswordResetEmailInput): Promise<PasswordResetEmailResult> {
  if (!input.to) {
    return { status: "skipped", error: "Destinatario email non disponibile." };
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.AGENCY_BOOKING_FROM_EMAIL;
  if (!apiKey || !from) {
    return { status: "skipped", error: "Provider email non configurato (RESEND_API_KEY / AGENCY_BOOKING_FROM_EMAIL)." };
  }

  const subject = "Reset password - accesso Ischia Transfer";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject,
      html: buildHtml(input),
      text: buildPlainText(input)
    })
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    return {
      status: "failed",
      error: `Invio email reset fallito (${response.status}). ${bodyText.slice(0, 240)}`
    };
  }

  return { status: "sent", error: null };
}

function buildTemporaryPasswordPlainText(input: { fullName: string; tempPassword: string }) {
  const lines = [
    `Ciao ${input.fullName},`,
    "",
    "Hai richiesto la reimpostazione della password.",
    "",
    `Questa e la tua password temporanea: ${input.tempPassword}`,
    "",
    "Al primo accesso ti verra richiesto di cambiarla con una password definitiva.",
    "",
    "Se non hai richiesto questa operazione, contatta subito il supporto.",
    "Grazie."
  ];

  return lines.join("\n");
}

function buildTemporaryPasswordHtml(input: { fullName: string; tempPassword: string }) {
  return [
    `<p>Ciao ${input.fullName},</p>`,
    "<p>Hai richiesto la reimpostazione della password.</p>",
    "<p><strong>Questa è la tua password temporanea:</strong></p>",
    `<p style=\"word-break: break-word; font-family: monospace; background: #f4f4f4; padding: 8px; border-radius: 6px;\">${input.tempPassword}</p>`,
    "<p>Al primo accesso ti verra richiesto di cambiarla con una password definitiva.</p>",
    "<p>Se non hai richiesto questa operazione, contatta subito il supporto.</p>",
    "<p>Grazie.</p>"
  ].join("");
}

export async function sendTemporaryPasswordEmail(input: { to: string; fullName: string; tempPassword: string }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.AGENCY_BOOKING_FROM_EMAIL;
  if (!apiKey || !from) {
    return { status: "skipped" as const, error: "Provider email non configurato (RESEND_API_KEY / AGENCY_BOOKING_FROM_EMAIL)." };
  }

  const subject = "Password temporanea - accesso Ischia Transfer";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject,
      html: buildTemporaryPasswordHtml(input),
      text: buildTemporaryPasswordPlainText(input)
    })
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    return {
      status: "failed" as const,
      error: `Invio email temporanea fallito (${response.status}). ${bodyText.slice(0, 240)}`
    };
  }

  return { status: "sent" as const, error: null };
}
