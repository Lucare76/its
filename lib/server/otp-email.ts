import { emailHtml, emailHighlightBox } from "@/lib/server/email-layout";

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
  return emailHtml(`
    <p style="font-size:17px;margin-bottom:8px;">Ciao <strong>${input.fullName}</strong>,</p>
    <p style="color:#475569;margin-bottom:24px;">Hai richiesto un codice di accesso per <strong>Ischia Transfer Service</strong>. Usa il codice qui sotto per completare il login.</p>

    ${emailHighlightBox(`
      <div style="font-size:11px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;color:#64748b;margin-bottom:12px;">Il tuo codice di verifica</div>
      <div style="font-family:'Courier New',monospace;font-size:38px;font-weight:800;letter-spacing:10px;color:#0f2744;">${input.otpCode}</div>
      <div style="font-size:12px;color:#94a3b8;margin-top:12px;">⏱ Valido per 10 minuti</div>
    `)}

    <p style="font-size:13px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:20px;margin-top:8px;">
      Se non hai richiesto questo codice, ignora questa email. Il tuo account è al sicuro.
    </p>
  `, { title: "Codice di verifica — Ischia Transfer", preheader: `Il tuo codice è ${input.otpCode}` });
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
