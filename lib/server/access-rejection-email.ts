import { emailHtml } from "@/lib/server/email-layout";
import { getVerifiedFromEmail, resendFetch } from "@/lib/server/send-email";

export type AccessRejectionEmailStatus = "sent" | "failed" | "skipped";

export interface AccessRejectionEmailInput {
  to: string | null;
  fullName: string;
  /**
   * Motivazione facoltativa da mostrare all'agenzia. Deve provenire da un
   * campo esplicitamente pensato per essere visibile all'utente (vedi
   * `reject_notes` compilato dall'admin nella UI di /settings/users) — non
   * il generico `review_notes` di tenant_access_requests, che puo' essere
   * usato anche per annotazioni interne.
   */
  reasonForAgency?: string | null;
}

export interface AccessRejectionEmailResult {
  status: AccessRejectionEmailStatus;
  error: string | null;
}

function buildPlainText(input: AccessRejectionEmailInput) {
  const lines = [
    `Ciao ${input.fullName},`,
    "",
    "la tua richiesta di accesso all'area riservata di Ischia Transfer Service non e' stata approvata.",
    input.reasonForAgency?.trim() ? "" : null,
    input.reasonForAgency?.trim() ? `Motivazione: ${input.reasonForAgency.trim()}` : null,
    "",
    "Per qualsiasi chiarimento puoi contattare Ischia Transfer Service.",
    "Grazie."
  ].filter((line): line is string => line !== null);

  return lines.join("\n");
}

function buildHtml(input: AccessRejectionEmailInput) {
  const reasonBlock = input.reasonForAgency?.trim()
    ? `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px 20px;margin:24px 0;font-size:14px;color:#334155;">
        <strong>Motivazione:</strong> ${input.reasonForAgency.trim()}
      </div>`
    : "";

  return emailHtml(`
    <div style="text-align:center;margin-bottom:32px;">
      <div style="display:inline-block;background:#fee2e2;border-radius:50%;width:64px;height:64px;line-height:64px;font-size:32px;margin-bottom:16px;">✉️</div>
      <h2 style="font-size:22px;font-weight:800;color:#0f2744;margin:0 0 8px;">Richiesta non approvata</h2>
      <p style="color:#475569;font-size:15px;margin:0;">Ischia Transfer Service</p>
    </div>

    <p style="color:#475569;margin-bottom:20px;">Ciao <strong>${input.fullName}</strong>, la tua richiesta di accesso all'area riservata non e' stata approvata.</p>

    ${reasonBlock}

    <p style="color:#475569;font-size:14px;">Per qualsiasi chiarimento puoi contattare Ischia Transfer Service.</p>

    <p style="font-size:13px;color:#94a3b8;">Per assistenza scrivi a <a href="mailto:info@ischiatransferservice.it" style="color:#3b82f6;">info@ischiatransferservice.it</a></p>
  `, { title: "Richiesta di accesso — Ischia Transfer Service", preheader: "Aggiornamento sulla tua richiesta di accesso" });
}

export async function sendAccessRejectionEmail(input: AccessRejectionEmailInput): Promise<AccessRejectionEmailResult> {
  if (!input.to) {
    return { status: "skipped", error: "Destinatario email non disponibile." };
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = getVerifiedFromEmail();
  if (!apiKey || !from) {
    return { status: "skipped", error: "Provider email non configurato (RESEND_API_KEY / AGENCY_BOOKING_FROM_EMAIL)." };
  }

  const subject = "Richiesta di accesso - Ischia Transfer Service";
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
      error: `Invio email rifiuto fallito (${response.status}). ${bodyText.slice(0, 240)}`
    };
  }

  return { status: "sent", error: null };
}
