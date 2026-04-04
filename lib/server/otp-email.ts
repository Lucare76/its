import { emailHtml } from "@/lib/server/email-layout";

export interface OtpEmailInput {
  to: string;
  fullName: string;
  otpCode: string;
}

interface OtpEmailResult {
  status: 'sent' | 'failed' | 'skipped';
  error: string | null;
}

function buildOtpPlainText(input: OtpEmailInput): string {
  return [
    `Ciao ${input.fullName},`,
    "",
    "Hai ricevuto una richiesta di accesso al tuo account Ischia Transfer Service.",
    "",
    `Codice di verifica (valido 10 minuti): ${input.otpCode}`,
    "",
    "Se non hai richiesto questo codice, ignora questo messaggio.",
    "Grazie."
  ].join("\n");
}

function buildOtpHtml(input: OtpEmailInput): string {
  return emailHtml([
    `<p>Ciao <strong>${input.fullName}</strong>,</p>`,
    "<p>Hai ricevuto una richiesta di accesso al tuo account Ischia Transfer Service.</p>",
    "<p><strong>Codice di verifica (valido 10 minuti):</strong></p>",
    `<p style="word-break:break-word;font-family:monospace;background:#f0f4ff;border:2px solid #c7d7f0;padding:16px 20px;border-radius:10px;font-size:22px;letter-spacing:4px;text-align:center;color:#1e3a5f;">${input.otpCode}</p>`,
    "<p>Se non hai richiesto questo codice, ignora questo messaggio.</p>",
  ].join(""));
}

export async function sendOtpEmail(input: OtpEmailInput): Promise<OtpEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.AGENCY_BOOKING_FROM_EMAIL;
  if (!apiKey || !from) {
    return { status: 'skipped', error: 'Provider email non configurato (RESEND_API_KEY / AGENCY_BOOKING_FROM_EMAIL).' };
  }

  const subject = "Codice di verifica - accesso Ischia Transfer";
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
      html: buildOtpHtml(input),
      text: buildOtpPlainText(input)
    })
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    return {
      status: 'failed',
      error: `Invio OTP fallito (${response.status}). ${bodyText.slice(0, 240)}`
    };
  }

  return { status: 'sent', error: null };
}
