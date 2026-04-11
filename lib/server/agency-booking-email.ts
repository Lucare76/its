import { emailHtml, emailDataTable, fmtDate } from "@/lib/server/email-layout";
import { sendEmail as sendEmailUtil } from "@/lib/server/send-email";

export type AgencyBookingEmailStatus = "sent" | "failed" | "skipped";

export interface AgencyBookingEmailInput {
  to: string | null;
  customerName: string;
  recipientName?: string | null;
  serviceKindLabel: string;
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
    "abbiamo ricevuto la tua prenotazione Ischia Transfer.",
    "",
    `Servizio: ${input.serviceKindLabel}`,
    `Hotel/Struttura: ${input.hotelName}`,
    `Pax: ${input.pax}`,
    `Arrivo: ${fmtDate(input.arrivalDate)} ${input.arrivalTime}`,
    `Partenza: ${fmtDate(input.departureDate)} ${input.departureTime}`,
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

    <table class="service-box" cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%" style="background:linear-gradient(135deg,#0f2744,#1e3a5f);border-radius:14px;margin-bottom:24px;">
      <tr><td class="service-box" style="padding:20px 24px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.5);margin-bottom:6px;">Servizio prenotato</div>
        <div class="service-title" style="font-size:20px;font-weight:800;color:#ffffff;line-height:1.3;">${input.serviceKindLabel}</div>
        <div style="font-size:14px;color:rgba(255,255,255,0.7);margin-top:6px;">📍 ${input.hotelName}</div>
      </td></tr>
    </table>

    ${emailDataTable([
      ["👥 Passeggeri", `${input.pax} persone`],
      ["✈️ Arrivo", `${fmtDate(input.arrivalDate)} alle ${input.arrivalTime}`],
      ["🏠 Partenza", `${fmtDate(input.departureDate)} alle ${input.departureTime}`],
      ["📝 Note", notes],
    ])}

    <p style="color:#475569;margin-top:20px;">Il nostro team ti contatterà per eventuali dettagli operativi. Grazie per aver scelto Ischia Transfer Service!</p>
  `, { title: "Conferma prenotazione — Ischia Transfer", preheader: `Prenotazione confermata — ${input.hotelName}, ${fmtDate(input.arrivalDate)}` });
}

export async function sendAgencyBookingConfirmationEmail(input: AgencyBookingEmailInput): Promise<AgencyBookingEmailResult> {
  if (!input.to) {
    return { status: "skipped", error: "Destinatario email non disponibile." };
  }

  const subject = `Conferma prenotazione Ischia Transfer - ${fmtDate(input.arrivalDate)}`;
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
