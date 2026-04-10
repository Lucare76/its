import { emailHtml, emailDataTable } from "@/lib/server/email-layout";

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
  const notes = input.notes ? input.notes : "—";
  return emailHtml(`
    <p style="font-size:17px;margin-bottom:6px;">Ciao <strong>${input.customerName}</strong>,</p>
    <p style="color:#475569;margin-bottom:24px;">La tua prenotazione è stata ricevuta con successo. Di seguito il riepilogo del servizio.</p>

    <div style="background:linear-gradient(135deg,#0f2744,#1e3a5f);border-radius:14px;padding:20px 24px;margin-bottom:24px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.5);margin-bottom:6px;">Servizio prenotato</div>
      <div style="font-size:22px;font-weight:800;color:#ffffff;">${input.serviceKindLabel}</div>
      <div style="font-size:14px;color:rgba(255,255,255,0.7);margin-top:4px;">📍 ${input.hotelName}</div>
    </div>

    ${emailDataTable([
      ["👥 Passeggeri", `${input.pax} persone`],
      ["✈️ Arrivo", `${input.arrivalDate} alle ${input.arrivalTime}`],
      ["🏠 Partenza", `${input.departureDate} alle ${input.departureTime}`],
      ["📝 Note", notes],
    ])}

    <p style="color:#475569;margin-top:20px;">Il nostro team ti contatterà per eventuali dettagli operativi. Grazie per aver scelto Ischia Transfer Service!</p>
  `, { title: "Conferma prenotazione — Ischia Transfer", preheader: `Prenotazione confermata — ${input.hotelName}, ${input.arrivalDate}` });
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
