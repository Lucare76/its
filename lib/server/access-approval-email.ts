import { emailHtml, emailDataTable } from "@/lib/server/email-layout";

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
  const rows: Array<[string, string]> = [["🎭 Ruolo", roleLabel(input.role)]];
  if (input.agencyName?.trim()) rows.push(["🏢 Agenzia", input.agencyName.trim()]);

  return emailHtml(`
    <div style="text-align:center;margin-bottom:32px;">
      <div style="display:inline-block;background:#dcfce7;border-radius:50%;width:64px;height:64px;line-height:64px;font-size:32px;margin-bottom:16px;">✅</div>
      <h2 style="font-size:22px;font-weight:800;color:#0f2744;margin:0 0 8px;">Accesso approvato!</h2>
      <p style="color:#475569;font-size:15px;margin:0;">Benvenuto/a in <strong>Ischia Transfer Service</strong></p>
    </div>

    <p style="color:#475569;margin-bottom:20px;">Ciao <strong>${input.fullName}</strong>, la tua richiesta di accesso è stata approvata. Di seguito i dettagli del tuo account.</p>

    ${emailDataTable(rows)}

    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:16px 20px;margin:24px 0;font-size:14px;color:#166534;">
      ${input.role === "agency"
        ? "🏢 Puoi ora accedere alla tua <strong>area agenzia</strong> per inserire e gestire le prenotazioni."
        : "🖥️ Puoi ora accedere al <strong>gestionale operativo</strong> con le autorizzazioni del tuo ruolo."}
    </div>

    <p style="font-size:13px;color:#94a3b8;">Per assistenza scrivi a <a href="mailto:info@ischiatransferservice.it" style="color:#3b82f6;">info@ischiatransferservice.it</a></p>
  `, { title: "Accesso approvato — Ischia Transfer", preheader: "Il tuo accesso è stato approvato" });
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
