import { emailHtml, emailDataTable, emailButton, fmtDate } from "@/lib/server/email-layout";
import { buildServiceLabel, buildServiceLabelShort, type ServiceLabelContext } from "@/lib/service-label";
import { sendEmail as sendEmailUtil } from "@/lib/server/send-email";

interface EmailResult {
  status: "sent" | "failed" | "skipped";
  error: string | null;
}

async function sendEmail(params: { to: string; subject: string; html: string; text: string }): Promise<EmailResult> {
  const result = await sendEmailUtil({ to: params.to, subject: params.subject, html: params.html, text: params.text });
  if (result.skipped) return { status: "skipped", error: "Provider email non configurato." };
  if (!result.ok) return { status: "failed", error: result.error ?? "Invio fallito." };
  return { status: "sent", error: null };
}

function formatPrice(cents: number): string {
  return `€${(cents / 100).toFixed(2).replace(".", ",")}`;
}

// ---------------------------------------------------------------------------
// Email OPERATORE — nuova prenotazione da approvare
// ---------------------------------------------------------------------------

export interface OperatorNotifyInput {
  serviceId: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  agencyName: string | null;
  serviceCtx: ServiceLabelContext;
  arrivalDate: string;
  arrivalTime: string;
  departureDate: string;
  departureTime: string;
  hotelName: string;
  pax: number;
  notes: string;
  approvalUrl: string;
  quotedPriceCents?: number | null;
  catalogPriceCents?: number | null;
}

export async function sendOperatorNotifyEmail(input: OperatorNotifyInput): Promise<EmailResult> {
  const to = process.env.OPS_NOTIFY_EMAIL?.trim();
  if (!to) return { status: "skipped", error: "OPS_NOTIFY_EMAIL non configurata." };

  const serviceLabel = buildServiceLabel(input.serviceCtx);
  const serviceLabelShort = buildServiceLabelShort(input.serviceCtx);
  const agency = input.agencyName ?? "Agenzia non specificata";

  const html = emailHtml(`
    <p style="font-size:17px;margin-bottom:4px;">Nuova prenotazione da confermare</p>
    <p style="color:#475569;margin-bottom:24px;">Una richiesta è arrivata dall'area agenzia e attende la tua conferma.</p>

    <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%" style="background:linear-gradient(135deg,#0f2744,#1e3a5f);border-radius:14px;margin-bottom:24px;">
      <tr><td class="service-box" style="padding:20px 24px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.5);margin-bottom:6px;">Servizio richiesto</div>
        <div class="service-title" style="font-size:20px;font-weight:800;color:#ffffff;line-height:1.3;">${serviceLabel}</div>
        <div style="font-size:14px;color:rgba(255,255,255,0.7);margin-top:6px;">👤 ${input.customerName} · ${agency}</div>
      </td></tr>
    </table>

    ${(() => {
      const rows: [string, string][] = [
        ["📅 Arrivo", `${fmtDate(input.arrivalDate)} alle ${input.arrivalTime}`],
        ["📅 Rientro", `${fmtDate(input.departureDate)} alle ${input.departureTime}`],
        ["👥 Passeggeri", `${input.pax} persone`],
        ["📞 Telefono", input.customerPhone],
        ["✉️ Email cliente", input.customerEmail ?? "—"],
        ["📝 Note", input.notes || "—"],
      ];
      if (input.quotedPriceCents != null) {
        const quoted = formatPrice(input.quotedPriceCents);
        if (input.catalogPriceCents != null) {
          const catalog = formatPrice(input.catalogPriceCents);
          const diff = input.quotedPriceCents - input.catalogPriceCents;
          const match = Math.abs(diff) <= 50; // tolleranza 0,50€
          const priceLabel = match
            ? `${quoted} ✅ (listino ${catalog})`
            : `${quoted} ⚠️ MISMATCH — listino: ${catalog} (diff: ${diff > 0 ? "+" : ""}${formatPrice(Math.abs(diff))})`;
          rows.push(["💰 Prezzo dichiarato", priceLabel]);
        } else {
          rows.push(["💰 Prezzo dichiarato", `${quoted} (listino non configurato)`]);
        }
      }
      return emailDataTable(rows);
    })()}

    <p style="color:#475569;margin-top:20px;font-size:14px;">Clicca per confermare o rifiutare la prenotazione e impostare il prezzo.</p>

    ${emailButton("Gestisci prenotazione", input.approvalUrl, "#1e3a5f")}

    <p style="font-size:12px;color:#94a3b8;margin-top:8px;">Link valido 48 ore · ID: ${input.serviceId}</p>
  `, { title: "Nuova prenotazione da confermare", preheader: `${input.customerName} — ${serviceLabelShort}, ${fmtDate(input.arrivalDate)}` });

  const text = [
    `NUOVA PRENOTAZIONE DA CONFERMARE`,
    `Servizio: ${serviceLabel}`,
    `Cliente: ${input.customerName} (${agency})`,
    `Telefono: ${input.customerPhone}`,
    `Arrivo: ${fmtDate(input.arrivalDate)} ${input.arrivalTime}`,
    `Rientro: ${fmtDate(input.departureDate)} ${input.departureTime}`,
    `Passeggeri: ${input.pax}`,
    `Note: ${input.notes || "—"}`,
    ``,
    `Gestisci: ${input.approvalUrl}`,
    `(link valido 48 ore)`
  ].join("\n");

  return sendEmail({ to, subject: `[Da confermare] ${serviceLabelShort} — ${input.customerName}, ${fmtDate(input.arrivalDate)}`, html, text });
}

// ---------------------------------------------------------------------------
// Email OPERATORE — prenotazione duplicata ⚠️
// ---------------------------------------------------------------------------

export interface OperatorDuplicateNotifyInput {
  existingServiceId: string;
  customerName: string;
  agencyName: string | null;
  serviceCtx: ServiceLabelContext;
  arrivalDate: string;
  pax: number;
}

function buildDuplicateEmailHtml(input: OperatorDuplicateNotifyInput, forOperator: boolean): string {
  const serviceLabel = buildServiceLabelShort(input.serviceCtx);
  const agency = input.agencyName ?? "Agenzia non specificata";
  const intro = forOperator
    ? `L'agenzia ha inviato una richiesta identica a una già esistente. La nuova richiesta è stata bloccata automaticamente.`
    : `La tua richiesta è stata bloccata: esiste già una prenotazione identica per questo cliente (stesso hotel, data e orario).`;
  const footer = forOperator
    ? `Nessuna azione necessaria — la prenotazione originale è già in attesa di conferma.`
    : `La prenotazione originale è già in attesa di approvazione. Contatta l'operatore per chiarimenti.`;

  return emailHtml(`
    <p style="font-size:17px;margin-bottom:4px;">⚠️ Prenotazione duplicata rilevata</p>
    <p style="color:#475569;margin-bottom:24px;">${intro}</p>

    <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%" style="background:#fef3c7;border:1px solid #fcd34d;border-radius:14px;margin-bottom:24px;">
      <tr><td style="padding:18px 24px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#92400e;margin-bottom:6px;">⚠️ Duplicato bloccato</div>
        <div style="font-size:18px;font-weight:800;color:#78350f;line-height:1.3;">${serviceLabel}</div>
        <div style="font-size:14px;color:#92400e;margin-top:6px;">👤 ${input.customerName} · ${agency}</div>
      </td></tr>
    </table>

    ${emailDataTable([
      ["📅 Data arrivo", fmtDate(input.arrivalDate)],
      ["👥 Passeggeri", `${input.pax} persone`],
      ["🔖 ID prenotazione esistente", input.existingServiceId],
    ])}

    <p style="color:#475569;margin-top:20px;font-size:14px;">${footer}</p>
  `, { title: "Prenotazione duplicata", preheader: `Duplicato: ${serviceLabel} — ${input.customerName}` });
}

export async function sendOperatorDuplicateNotifyEmail(input: OperatorDuplicateNotifyInput): Promise<EmailResult> {
  const to = process.env.OPS_NOTIFY_EMAIL?.trim();
  if (!to) return { status: "skipped", error: "OPS_NOTIFY_EMAIL non configurata." };

  const serviceLabel = buildServiceLabelShort(input.serviceCtx);
  const agency = input.agencyName ?? "Agenzia non specificata";

  const text = [
    `⚠️ PRENOTAZIONE DUPLICATA BLOCCATA`,
    `Servizio: ${serviceLabel}`,
    `Cliente: ${input.customerName} (${agency})`,
    `Data: ${fmtDate(input.arrivalDate)} · ${input.pax} pax`,
    `ID prenotazione originale: ${input.existingServiceId}`,
    ``,
    `Nessuna azione necessaria.`
  ].join("\n");

  return sendEmail({ to, subject: `[Duplicato] ${serviceLabel} — ${input.customerName}`, html: buildDuplicateEmailHtml(input, true), text });
}

export async function sendAgencyDuplicateNotifyEmail(input: OperatorDuplicateNotifyInput & { agencyEmail: string }): Promise<EmailResult> {
  const serviceLabel = buildServiceLabelShort(input.serviceCtx);
  const agency = input.agencyName ?? "Agenzia";

  const text = [
    `⚠️ PRENOTAZIONE DUPLICATA`,
    `La richiesta per ${input.customerName} (${agency}) è stata bloccata.`,
    `Esiste già: ${serviceLabel} — ${fmtDate(input.arrivalDate)} · ${input.pax} pax`,
    `ID prenotazione esistente: ${input.existingServiceId}`,
    ``,
    `Contatta l'operatore per chiarimenti.`
  ].join("\n");

  return sendEmail({ to: input.agencyEmail, subject: `[Duplicato] ${serviceLabel} — ${input.customerName}`, html: buildDuplicateEmailHtml(input, false), text });
}

// ---------------------------------------------------------------------------
// Email AGENZIA — conferma ✅
// ---------------------------------------------------------------------------

export interface AgencyConfirmedInput {
  to: string | null;
  customerName: string;
  agencyName: string | null;
  serviceCtx: ServiceLabelContext;
  arrivalDate: string;
  arrivalTime: string;
  departureDate: string;
  departureTime: string;
  hotelName: string;
  pax: number;
  notes: string;
  priceCents: number;
  operatorNotes: string | null;
}

export async function sendAgencyConfirmedEmail(input: AgencyConfirmedInput): Promise<EmailResult> {
  if (!input.to) return { status: "skipped", error: "Destinatario non disponibile." };

  const serviceLabel = buildServiceLabel(input.serviceCtx);
  const serviceLabelShort = buildServiceLabelShort(input.serviceCtx);
  const priceFormatted = formatPrice(input.priceCents);
  const operatorNotes = input.operatorNotes?.trim() || null;
  const greeting = input.agencyName?.trim() || input.customerName;

  const html = emailHtml(`
    <p style="font-size:17px;margin-bottom:6px;">Ciao <strong>${greeting}</strong>,</p>
    <p style="color:#475569;margin-bottom:24px;">La prenotazione è stata <strong style="color:#16a34a;">confermata</strong>.</p>

    <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%" style="background:linear-gradient(135deg,#0f2744,#1e3a5f);border-radius:14px;margin-bottom:24px;">
      <tr><td class="service-box" style="padding:20px 24px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.5);margin-bottom:6px;">Servizio confermato</div>
        <div class="service-title" style="font-size:20px;font-weight:800;color:#ffffff;line-height:1.3;">${serviceLabel}</div>
      </td></tr>
    </table>

    ${emailDataTable([
      ["📅 Arrivo", `${fmtDate(input.arrivalDate)} alle ${input.arrivalTime}`],
      ["📅 Rientro", `${fmtDate(input.departureDate)} alle ${input.departureTime}`],
      ["👥 Passeggeri", `${input.pax} persone`],
      ["📝 Note", input.notes || "—"],
      ["💰 Prezzo", `<strong style="font-size:16px;">${priceFormatted}</strong>`],
    ])}

    ${operatorNotes ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px 18px;margin-top:16px;"><div style="font-size:12px;font-weight:700;color:#166534;text-transform:uppercase;margin-bottom:4px;">Note operative</div><div style="font-size:14px;color:#15803d;">${operatorNotes}</div></div>` : ""}

    <p style="color:#475569;margin-top:24px;">Grazie per aver scelto Ischia Transfer Service!</p>
  `, { title: "Prenotazione confermata", preheader: `Confermato: ${serviceLabelShort} — ${priceFormatted}` });

  const text = [
    `Ciao ${greeting},`,
    `La prenotazione è stata CONFERMATA.`,
    `Servizio: ${serviceLabel}`,
    `Arrivo: ${fmtDate(input.arrivalDate)} ${input.arrivalTime}`,
    `Rientro: ${fmtDate(input.departureDate)} ${input.departureTime}`,
    `Passeggeri: ${input.pax}`,
    operatorNotes ? `Note operative: ${operatorNotes}` : null,
    `Prezzo: ${priceFormatted}`,
    `Grazie per aver scelto Ischia Transfer Service!`
  ].filter(Boolean).join("\n");

  return sendEmail({ to: input.to, subject: `✅ Confermato — ${serviceLabelShort}, ${fmtDate(input.arrivalDate)}`, html, text });
}

// ---------------------------------------------------------------------------
// Email AGENZIA — rifiuto ❌
// ---------------------------------------------------------------------------

export interface AgencyRejectedInput {
  to: string | null;
  customerName: string;
  agencyName: string | null;
  serviceCtx: ServiceLabelContext;
  arrivalDate: string;
  arrivalTime: string;
  departureDate: string;
  departureTime: string;
  hotelName: string;
  pax: number;
  notes: string;
  operatorNotes: string | null;
}

export async function sendAgencyRejectedEmail(input: AgencyRejectedInput): Promise<EmailResult> {
  if (!input.to) return { status: "skipped", error: "Destinatario non disponibile." };

  const serviceLabel = buildServiceLabel(input.serviceCtx);
  const serviceLabelShort = buildServiceLabelShort(input.serviceCtx);
  const reason = input.operatorNotes?.trim() || "Servizio non disponibile per la data o il percorso richiesti.";
  const greeting = input.agencyName?.trim() || input.customerName;

  const html = emailHtml(`
    <p style="font-size:17px;margin-bottom:6px;">Ciao <strong>${greeting}</strong>,</p>
    <p style="color:#475569;margin-bottom:24px;">Purtroppo non è possibile confermare la prenotazione richiesta.</p>

    <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%" style="background:#fef2f2;border:1px solid #fecaca;border-radius:14px;margin-bottom:24px;">
      <tr><td class="service-box" style="padding:20px 24px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#991b1b;margin-bottom:6px;">Prenotazione non disponibile</div>
        <div class="service-title" style="font-size:18px;font-weight:700;color:#7f1d1d;line-height:1.3;">${serviceLabel}</div>
        <div style="font-size:14px;color:#991b1b;margin-top:6px;">${fmtDate(input.arrivalDate)} · ${input.pax} pax</div>
      </td></tr>
    </table>

    <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;padding:14px 18px;margin-bottom:24px;">
      <div style="font-size:12px;font-weight:700;color:#92400e;text-transform:uppercase;margin-bottom:4px;">Motivazione</div>
      <div style="font-size:14px;color:#78350f;">${reason}</div>
    </div>

    <p style="color:#475569;">Per trovare una soluzione alternativa contattateci a <a href="mailto:info@ischiatransferservice.it" style="color:#1e3a5f;font-weight:600;">info@ischiatransferservice.it</a></p>
  `, { title: "Prenotazione non disponibile", preheader: `Non confermato: ${serviceLabelShort}, ${fmtDate(input.arrivalDate)}` });

  const text = [
    `Ciao ${greeting},`,
    `Purtroppo non è possibile confermare: ${serviceLabel} — ${fmtDate(input.arrivalDate)}`,
    `Motivazione: ${reason}`,
    `Contattateci: info@ischiatransferservice.it`
  ].join("\n");

  return sendEmail({ to: input.to, subject: `❌ Non disponibile — ${serviceLabelShort}, ${fmtDate(input.arrivalDate)}`, html, text });
}
