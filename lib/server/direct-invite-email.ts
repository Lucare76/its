import { createAdminClient } from "@/lib/server/whatsapp";

export interface DirectInviteEmailInput {
  to: string;
  fullName: string;
  inviteToken: string;
  acceptUrl: string;
}

interface DirectInviteEmailResult {
  status: 'sent' | 'failed' | 'skipped';
  error: string | null;
}

function buildInviteEmailPlainText(input: DirectInviteEmailInput): string {
  return [
    `Ciao ${input.fullName},`,
    "",
    "Sei stato invitato a unirti a Ischia Transfer Service.",
    "",
    `Accetta l'invito cliccando il link seguente:`,
    input.acceptUrl,
    "",
    "Questo link scade tra 7 giorni.",
    "Se non hai richiesto questo invito, puoi ignorare questo messaggio.",
    "Grazie."
  ].join("\n");
}

function buildInviteEmailHtml(input: DirectInviteEmailInput): string {
  return [
    `<p>Ciao ${input.fullName},</p>`,
    "<p>Sei stato invitato a unirti a Ischia Transfer Service.</p>",
    "<p><strong>Accetta l'invito:</strong></p>",
    `<p><a href="${input.acceptUrl}" style="background: #3b82f6; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; display: inline-block;">Accetta invito</a></p>`,
    "<p style=\"font-size: 12px; color: #666;\">Questo link scade tra 7 giorni.</p>",
    "<p>Se non hai richiesto questo invito, puoi ignorare questo messaggio.</p>",
    "<p>Grazie.</p>"
  ].join("");
}

export async function sendDirectInviteEmail(input: DirectInviteEmailInput): Promise<DirectInviteEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.AGENCY_BOOKING_FROM_EMAIL;
  if (!apiKey || !from) {
    return { status: 'skipped', error: 'Provider email non configurato.' };
  }

  const subject = "Invito - Ischia Transfer Service";
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
      html: buildInviteEmailHtml(input),
      text: buildInviteEmailPlainText(input)
    })
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    return {
      status: 'failed',
      error: `Invio invito fallito (${response.status}). ${bodyText.slice(0, 240)}`
    };
  }

  return { status: 'sent', error: null };
}

export function generateInviteToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  for (let i = 0; i < 32; i += 1) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

export function getInviteExpiration(daysFromNow = 7): Date {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return date;
}
