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
  return [
    `<p>Ciao ${input.customerName},</p>`,
    "<p>abbiamo ricevuto la tua prenotazione Ischia Transfer.</p>",
    "<ul>",
    `<li><strong>Servizio:</strong> ${input.serviceKindLabel}</li>`,
    `<li><strong>Hotel/Struttura:</strong> ${input.hotelName}</li>`,
    `<li><strong>Pax:</strong> ${input.pax}</li>`,
    `<li><strong>Arrivo:</strong> ${input.arrivalDate} ${input.arrivalTime}</li>`,
    `<li><strong>Partenza:</strong> ${input.departureDate} ${input.departureTime}</li>`,
    `<li><strong>Note:</strong> ${notes}</li>`,
    "</ul>",
    "<p>Ti contatteremo per eventuali dettagli operativi.</p>",
    "<p>Grazie.</p>"
  ].join("");
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
