import { emailHtml } from "@/lib/server/email-layout";

export type AccessApprovalEmailStatus = "sent" | "failed" | "skipped";

export interface AccessApprovalEmailInput {
  to: string | null;
  fullName: string;
  role: "admin" | "operator" | "driver" | "agency" | "supervisor";
  agencyName?: string | null;
}

export interface AccessApprovalEmailResult {
  status: AccessApprovalEmailStatus;
  error: string | null;
}

function roleLabel(role: AccessApprovalEmailInput["role"]) {
  if (role === "admin") return "Admin";
  if (role === "operator") return "Operatore";
  if (role === "driver") return "Autista";
  return "Agenzia";
}

function buildPlainText(input: AccessApprovalEmailInput) {
  const lines = [
    `Ciao ${input.fullName},`,
    "",
    "la tua richiesta di accesso e stata approvata.",
    "",
    `Ruolo assegnato: ${roleLabel(input.role)}`,
    input.agencyName?.trim() ? `Agenzia: ${input.agencyName.trim()}` : null,
    "",
    input.role === "agency"
      ? "Ora puoi accedere alla tua area dedicata e inserire le prenotazioni agenzia."
      : "Ora puoi accedere al gestionale con il ruolo assegnato.",
    "",
    "Se hai bisogno di supporto, contatta Ischia Transfer Service.",
    "Grazie."
  ].filter(Boolean);

  return lines.join("\n");
}

function buildHtml(input: AccessApprovalEmailInput) {
  return emailHtml([
    `<p>Ciao <strong>${input.fullName}</strong>,</p>`,
    "<p>la tua richiesta di accesso è stata approvata.</p>",
    `<table style="width:100%;border-collapse:collapse;margin:16px 0;">`,
    `<tr><td style="padding:8px 12px;border:1px solid #e2e8f0;background:#f8fafc;font-weight:600;width:140px;">Ruolo assegnato</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${roleLabel(input.role)}</td></tr>`,
    input.agencyName?.trim() ? `<tr><td style="padding:8px 12px;border:1px solid #e2e8f0;background:#f8fafc;font-weight:600;">Agenzia</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${input.agencyName.trim()}</td></tr>` : "",
    `</table>`,
    `<p>${input.role === "agency" ? "Ora puoi accedere alla tua area dedicata e inserire le prenotazioni agenzia." : "Ora puoi accedere al gestionale con il ruolo assegnato."}</p>`,
    "<p>Se hai bisogno di supporto, contatta Ischia Transfer Service.</p>",
  ].join(""));
}

export async function sendAccessApprovalEmail(input: AccessApprovalEmailInput): Promise<AccessApprovalEmailResult> {
  if (!input.to) {
    return { status: "skipped", error: "Destinatario email non disponibile." };
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.AGENCY_BOOKING_FROM_EMAIL;
  if (!apiKey || !from) {
    return { status: "skipped", error: "Provider email non configurato (RESEND_API_KEY / AGENCY_BOOKING_FROM_EMAIL)." };
  }

  const subject = "Richiesta approvata - accesso Ischia Transfer";
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
      error: `Invio email approvazione fallito (${response.status}). ${bodyText.slice(0, 240)}`
    };
  }

  return { status: "sent", error: null };
}
