import { emailHtml } from "@/lib/server/email-layout";

export type AgencyBookingEmailStatus = "sent" | "failed" | "skipped";

export interface AgencyBookingEmailInput {
  to: string | null;
  customerName: string;
  serviceKindLabel: string;
  arrivalDate: string;
  arrivalTime: string;
  departureDate: string;
  departureTime: string;
  hotelName: string;
  pax: number;
  notes: string;
}

export interface AgencyBookingEmailResult {
  status: AgencyBookingEmailStatus;
  error: string | null;
}

function buildPlainText(input: AgencyBookingEmailInput) {
  const lines = [
    `Ciao ${input.customerName},`,
    "",
    "abbiamo ricevuto la tua prenotazione Ischia Transfer.",
    "",
    `Servizio: ${input.serviceKindLabel}`,
    `Hotel/Struttura: ${input.hotelName}`,
    `Pax: ${input.pax}`,
    `Arrivo: ${input.arrivalDate} ${input.arrivalTime}`,
    `Partenza: ${input.departureDate} ${input.departureTime}`,
    "",
    `Note: ${input.notes || "-"}`,
    "",
    "Ti contatteremo per eventuali dettagli operativi.",
    "Grazie."
  ];
  return lines.join("\n");
}

function buildHtml(input: AgencyBookingEmailInput) {
  const notes = input.notes ? input.notes : "-";
  return emailHtml([
    `<p>Ciao <strong>${input.customerName}</strong>,</p>`,
    "<p>abbiamo ricevuto la tua prenotazione Ischia Transfer.</p>",
    `<table style="width:100%;border-collapse:collapse;margin:16px 0;">`,
    `<tr><td style="padding:8px 12px;border:1px solid #e2e8f0;background:#f8fafc;font-weight:600;width:140px;">Servizio</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${input.serviceKindLabel}</td></tr>`,
    `<tr><td style="padding:8px 12px;border:1px solid #e2e8f0;background:#f8fafc;font-weight:600;">Hotel/Struttura</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${input.hotelName}</td></tr>`,
    `<tr><td style="padding:8px 12px;border:1px solid #e2e8f0;background:#f8fafc;font-weight:600;">Pax</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${input.pax}</td></tr>`,
    `<tr><td style="padding:8px 12px;border:1px solid #e2e8f0;background:#f8fafc;font-weight:600;">Arrivo</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${input.arrivalDate} ${input.arrivalTime}</td></tr>`,
    `<tr><td style="padding:8px 12px;border:1px solid #e2e8f0;background:#f8fafc;font-weight:600;">Partenza</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${input.departureDate} ${input.departureTime}</td></tr>`,
    `<tr><td style="padding:8px 12px;border:1px solid #e2e8f0;background:#f8fafc;font-weight:600;">Note</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${notes}</td></tr>`,
    `</table>`,
    "<p>Ti contatteremo per eventuali dettagli operativi.</p>",
  ].join(""));
}

export async function sendAgencyBookingConfirmationEmail(input: AgencyBookingEmailInput): Promise<AgencyBookingEmailResult> {
  if (!input.to) {
    return { status: "skipped", error: "Destinatario email non disponibile." };
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.AGENCY_BOOKING_FROM_EMAIL;
  if (!apiKey || !from) {
    return { status: "skipped", error: "Provider email non configurato (RESEND_API_KEY / AGENCY_BOOKING_FROM_EMAIL)." };
  }

  const subject = `Conferma prenotazione Ischia Transfer - ${input.arrivalDate}`;
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
      error: `Invio email fallito (${response.status}). ${bodyText.slice(0, 240)}`
    };
  }

  return { status: "sent", error: null };
}
