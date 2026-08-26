import { emailHtml, emailDataTable } from "@/lib/server/email-layout";
import { getVerifiedFromEmail, resendFetch } from "@/lib/server/send-email";

export type AccessRequestReceivedEmailStatus = "sent" | "failed" | "skipped";

export interface AccessRequestReceivedEmailInput {
  to: string | null;
  fullName: string;
  agencyName: string;
}

export interface AccessRequestReceivedEmailResult {
  status: AccessRequestReceivedEmailStatus;
  error: string | null;
}

function buildPlainText(input: AccessRequestReceivedEmailInput) {
  const lines = [
    `Ciao ${input.fullName},`,
    "",
    "abbiamo ricevuto la tua richiesta di accesso all'area riservata di Ischia Transfer Service.",
    "",
    `Agenzia indicata: ${input.agencyName}`,
    "",
    "La richiesta deve ora essere esaminata e approvata da Ischia Transfer Service.",
    "Riceverai una nuova comunicazione via email non appena la richiesta sara' stata esaminata.",
    "",
    "Grazie."
  ];

  return lines.join("\n");
}

function buildHtml(input: AccessRequestReceivedEmailInput) {
  const rows: Array<[string, string]> = [["🏢 Agenzia", input.agencyName]];

  return emailHtml(`
    <div style="text-align:center;margin-bottom:32px;">
      <div style="display:inline-block;background:#e0f2fe;border-radius:50%;width:64px;height:64px;line-height:64px;font-size:32px;margin-bottom:16px;">📨</div>
      <h2 style="font-size:22px;font-weight:800;color:#0f2744;margin:0 0 8px;">Richiesta ricevuta</h2>
      <p style="color:#475569;font-size:15px;margin:0;">Ischia Transfer Service</p>
    </div>

    <p style="color:#475569;margin-bottom:20px;">Ciao <strong>${input.fullName}</strong>, abbiamo ricevuto la tua richiesta di accesso all'area riservata.</p>

    ${emailDataTable(rows)}

    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:16px 20px;margin:24px 0;font-size:14px;color:#1e40af;">
      La richiesta deve ora essere esaminata e approvata da Ischia Transfer Service. Riceverai una nuova comunicazione via email non appena sara' stata esaminata.
    </div>

    <p style="font-size:13px;color:#94a3b8;">Per assistenza scrivi a <a href="mailto:info@ischiatransferservice.it" style="color:#3b82f6;">info@ischiatransferservice.it</a></p>
  `, { title: "Richiesta ricevuta — Ischia Transfer", preheader: "Abbiamo ricevuto la tua richiesta di accesso" });
}

export async function sendAccessRequestReceivedEmail(
  input: AccessRequestReceivedEmailInput
): Promise<AccessRequestReceivedEmailResult> {
  if (!input.to) {
    return { status: "skipped", error: "Destinatario email non disponibile." };
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = getVerifiedFromEmail();
  if (!apiKey || !from) {
    return { status: "skipped", error: "Provider email non configurato (RESEND_API_KEY / AGENCY_BOOKING_FROM_EMAIL)." };
  }

  const subject = "Richiesta di accesso ricevuta - Ischia Transfer Service";
  const response = await resendFetch(apiKey, {
    from,
    to: [input.to],
    subject,
    html: buildHtml(input),
    text: buildPlainText(input)
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    return {
      status: "failed",
      error: `Invio email richiesta ricevuta fallito (${response.status}). ${bodyText.slice(0, 240)}`
    };
  }

  return { status: "sent", error: null };
}
