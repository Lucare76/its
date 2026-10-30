import { agencyArrivalLabel, agencyReturnLabel, ferryDepartureLabel } from "@/lib/agency-booking-time-labels";
import { emailHtml, emailDataTable, fmtDate } from "@/lib/server/email-layout";
import { sendEmail as sendEmailUtil } from "@/lib/server/send-email";

export type AgencyBookingEmailStatus = "sent" | "failed" | "skipped";

export interface AgencyBookingEmailInput {
  to: string | null;
  customerName: string;
  recipientName?: string | null;
  serviceKindLabel: string;
  bookingKind?: string | null;
  ferryDepartureTime?: string | null;
  arrivalDate: string;
  arrivalTime: string;
  departureDate: string;
  departureTime: string;
  hotelName: string;
  pax: number;
  notes: string;
  pendingConfirmation?: boolean;
}

export interface AgencyBookingEmailResult {
  status: AgencyBookingEmailStatus;
  error: string | null;
}

function buildPlainText(input: AgencyBookingEmailInput) {
  const greeting = input.recipientName?.trim() || input.customerName;
  const lines = [
    `Ciao ${greeting},`,
    "",
    input.pendingConfirmation ? "Richiesta ricevuta, in attesa di conferma dell’operatore." : "La tua prenotazione è stata ricevuta con successo.",
    `Cliente: ${input.customerName}`,
    "",
    `Servizio: ${input.serviceKindLabel}`,
    `Hotel/Struttura: ${input.hotelName}`,
    `Pax: ${input.pax}`,
    ...(input.ferryDepartureTime ? [`${ferryDepartureLabel(input.bookingKind)}: ${fmtDate(input.arrivalDate)} ${input.ferryDepartureTime}`] : []),
    `${agencyArrivalLabel(input.bookingKind)}: ${fmtDate(input.arrivalDate)} ${input.arrivalTime}`,
    `${agencyReturnLabel(input.bookingKind)}: ${fmtDate(input.departureDate)} ${input.departureTime}`,
    "",
    `Note: ${input.notes || "-"}`,
    "",
    "Ti contatteremo per eventuali dettagli operativi.",
    "Grazie."
  ];
  return lines.join("\n");
}

function buildHtml(input: AgencyBookingEmailInput) {
  const greeting = input.recipientName?.trim() || input.customerName;
  const notes = input.notes ? input.notes : "—";
  const statusLine = input.pendingConfirmation
    ? `<p style="background:#fef3c7;border:1px solid #fcd34d;border-radius:10px;padding:12px 16px;color:#92400e;font-size:14px;margin-bottom:24px;">⏳ La tua prenotazione è <strong>in attesa di conferma</strong> da parte dell'operatore. Riceverai una comunicazione appena elaborata.</p>`
    : `<p style="color:#475569;margin-bottom:24px;">La tua prenotazione è stata ricevuta con successo. Di seguito il riepilogo del servizio.</p>`;
  return emailHtml(`
    <p style="font-size:17px;margin-bottom:6px;">Ciao <strong>${greeting}</strong>,</p>
    ${statusLine}

    ${emailDataTable([
      ["Cliente", input.customerName],
      ["Servizio", input.serviceKindLabel],
      ["Hotel / Struttura", input.hotelName],
    ])}

    ${emailDataTable([
      ["👥 Passeggeri", `${input.pax} persone`],
      ...(input.ferryDepartureTime ? [[ferryDepartureLabel(input.bookingKind), `${fmtDate(input.arrivalDate)} alle ${input.ferryDepartureTime}`] as [string, string]] : []),
      [agencyArrivalLabel(input.bookingKind), `${fmtDate(input.arrivalDate)} alle ${input.arrivalTime}`],
      [agencyReturnLabel(input.bookingKind), `${fmtDate(input.departureDate)} alle ${input.departureTime}`],
      ["📝 Note", notes],
    ])}

    <p style="color:#475569;margin-top:20px;">Il nostro team ti contatterà per eventuali dettagli operativi. Grazie per aver scelto Ischia Transfer Service!</p>
  `, { title: input.pendingConfirmation ? "Richiesta ricevuta — Ischia Transfer" : "Riepilogo prenotazione — Ischia Transfer", preheader: `${input.pendingConfirmation ? "In attesa di conferma" : "Prenotazione ricevuta"} — ${input.hotelName}, ${fmtDate(input.arrivalDate)}` });
}

export async function sendAgencyBookingConfirmationEmail(input: AgencyBookingEmailInput): Promise<AgencyBookingEmailResult> {
  if (!input.to) {
    return { status: "skipped", error: "Destinatario email non disponibile." };
  }

  const subject = `${input.pendingConfirmation ? "Richiesta ricevuta" : "Riepilogo prenotazione"} Ischia Transfer - ${fmtDate(input.arrivalDate)}`;
  const result = await sendEmailUtil({
    to: input.to,
    subject,
    html: buildHtml(input),
    text: buildPlainText(input),
  });

  if (!result.ok && !result.skipped) {
    return { status: "failed", error: result.error ?? "Invio email fallito." };
  }

  return { status: "sent", error: null };
}
