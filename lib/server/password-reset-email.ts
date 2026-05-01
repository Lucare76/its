import { emailButton, emailHtml } from "@/lib/server/email-layout";
import { getVerifiedFromEmail, resendFetch } from "@/lib/server/send-email";

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
  return emailHtml(
    `
    <p style="font-size:17px;margin-bottom:8px;">Ciao <strong>${input.fullName}</strong>,</p>
    <p style="color:#475569;margin-bottom:8px;">Abbiamo ricevuto una richiesta di reset password per il tuo account <strong>Ischia Transfer Service</strong>.</p>
    <p style="color:#475569;margin-bottom:24px;">Clicca il bottone qui sotto per impostare una nuova password. Il link e valido per <strong>60 minuti</strong>.</p>

    ${emailButton("Imposta nuova password", input.resetUrl)}

    <div style="background:#fefce8;border:1px solid #fde68a;border-radius:10px;padding:14px 18px;margin:20px 0;font-size:13px;color:#92400e;">
      Se non hai richiesto tu il reset, ignora questa email. La tua password rimane invariata.
    </div>

    <p style="font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:16px;">
      Il bottone non funziona? Copia e incolla questo link:<br/>
      <a href="${input.resetUrl}" style="color:#3b82f6;word-break:break-all;">${input.resetUrl}</a>
    </p>
  `,
    { title: "Reset password - Ischia Transfer", preheader: "Reimposta la tua password di accesso" }
  );
}

export async function sendPasswordResetEmail(input: PasswordResetEmailInput): Promise<PasswordResetEmailResult> {
  if (!input.to) {
    return { status: "skipped", error: "Destinatario email non disponibile." };
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = getVerifiedFromEmail();
  if (!apiKey || !from) {
    return { status: "skipped", error: "Provider email non configurato (RESEND_API_KEY / AGENCY_BOOKING_FROM_EMAIL)." };
  }

  const subject = "Reset password - accesso Ischia Transfer";
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
      error: `Invio email reset fallito (${response.status}). ${bodyText.slice(0, 240)}`
    };
  }

  return { status: "sent", error: null };
}
