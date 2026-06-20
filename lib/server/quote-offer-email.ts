import { emailHtml, emailButton, emailDataTable, fmtDate, emailHighlightBox } from "@/lib/server/email-layout";
import { sendEmail } from "@/lib/server/send-email";
import { escapeHtml } from "@/lib/server/escape-html";

export type QuoteEmailResult = { ok: boolean; error?: string };

// ─── Tipi ────────────────────────────────────────────────────────────────────

export interface ServiceQuoteEmailData {
  quoteNumber: string;
  customerFirstName: string;
  customerLastName: string;
  customerEmail: string;
  customerLanguage: "it" | "en";
  serviceType: string;
  direction: "arrival" | "departure" | "round_trip" | null;
  arrivalDate: string | null;
  arrivalTime: string | null;
  arrivalFlightTrain: string | null;
  departureDate: string | null;
  departureTime: string | null;
  departureFlightTrain: string | null;
  hotelName: string | null;
  hotelAddress: string | null;
  pax: number;
  luggageNotes: string | null;
  specialRequests: string | null;
  priceCents: number;        // per persona
  currency: string;
  priceNotes: string | null;
  emailIntro: string | null; // messaggio apertura personalizzato
  iban: string | null;
  swiftCode: string | null;
  bankAccountHolder: string | null;
  paymentInstructions: string | null;
  expiresAt: string | null;  // ISO date
  acceptUrl: string;         // URL con token
  companyPhone: string | null;
  companyWhatsapp: string | null;
  footerPhone: string | null;
  items?: ServiceQuoteEmailItem[];
  totalPriceCents?: number | null;
}

export interface QuoteConfirmEmailData extends Omit<ServiceQuoteEmailData, "acceptUrl" | "expiresAt"> {
  totalPaidCents: number;
}

export interface ServiceQuoteEmailItem {
  item_type: "service" | "free_text";
  title?: string | null;
  description?: string | null;
  service_type?: string | null;
  direction?: "arrival" | "departure" | "round_trip" | null;
  arrival_date?: string | null;
  arrival_time?: string | null;
  arrival_flight_train?: string | null;
  departure_date?: string | null;
  departure_time?: string | null;
  departure_flight_train?: string | null;
  hotel_name?: string | null;
  hotel_address?: string | null;
  pax?: number | null;
  quantity?: number | null;
  luggage_notes?: string | null;
  special_requests?: string | null;
  unit_price_cents?: number | null;
  total_price_cents?: number | null;
  price_notes?: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtEur(cents: number): string {
  return (cents / 100).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function serviceTypeLabel(type: string, lang: "it" | "en"): string {
  const map: Record<string, [string, string]> = {
    transfer_airport:  ["Transfer Aeroporto", "Airport Transfer"],
    transfer_station:  ["Transfer Stazione", "Train Station Transfer"],
    transfer_port:     ["Transfer Porto", "Port Transfer"],
    excursion:         ["Escursione", "Excursion"],
    shuttle:           ["Navetta", "Shuttle"],
    formula_snav:      ["Formula SNAV", "SNAV Package"],
    formula_medmar:    ["Formula Medmar", "Medmar Package"],
    custom:            ["Servizio su misura", "Custom Service"],
  };
  const entry = map[type];
  return entry ? entry[lang === "it" ? 0 : 1] : type;
}

function fmtTime(t: string | null): string {
  return t ? t.slice(0, 5) : "";
}

function fmtExpiresDate(iso: string | null, lang: "it" | "en"): string {
  if (!iso) return lang === "it" ? "non specificata" : "not specified";
  const d = new Date(iso);
  return lang === "it"
    ? d.toLocaleDateString("it-IT", { day: "2-digit", month: "long", year: "numeric" })
    : d.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
}

function itemTitle(item: ServiceQuoteEmailItem, lang: "it" | "en") {
  if (item.title) return escapeHtml(item.title);
  if (item.item_type === "free_text") return lang === "it" ? "Servizio libero" : "Custom item";
  return escapeHtml(serviceTypeLabel(item.service_type ?? "custom", lang));
}

function buildItemsHtml(items: ServiceQuoteEmailItem[] | undefined, lang: "it" | "en") {
  if (!items || items.length === 0) return "";
  const it = lang === "it";
  const e = escapeHtml;
  const blocks = items.map((item, index) => {
    const meta: string[] = [];
    if (item.item_type === "service") {
      if (item.hotel_name) meta.push(`${it ? "Hotel" : "Hotel"}: ${e(item.hotel_name)}`);
      if (item.pax != null && item.pax > 0) meta.push(`${item.pax} pax`);
      if (item.arrival_date) meta.push(`${it ? "Arrivo" : "Arrival"}: ${fmtDate(item.arrival_date)}${item.arrival_time ? ` ${fmtTime(item.arrival_time)}` : ""}`);
      if (item.departure_date) meta.push(`${it ? "Partenza" : "Departure"}: ${fmtDate(item.departure_date)}${item.departure_time ? ` ${fmtTime(item.departure_time)}` : ""}`);
    } else if (item.quantity && item.quantity > 1) {
      meta.push(`${it ? "Quantita" : "Quantity"}: ${item.quantity}`);
    }
    if (item.description) meta.push(e(item.description));
    if (item.special_requests) meta.push(e(item.special_requests));
    if (item.price_notes) meta.push(e(item.price_notes));

    return `
      <div style="border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;margin-bottom:10px;background:#ffffff;">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;">
          <div>
            <p style="margin:0 0 4px;font-weight:700;color:#1e3a5f;">${index + 1}. ${itemTitle(item, lang)}</p>
            ${meta.length > 0 ? `<p style="margin:0;color:#64748b;font-size:13px;line-height:1.5;">${meta.join("<br/>")}</p>` : ""}
          </div>
          <p style="margin:0;font-weight:800;color:#1e3a5f;white-space:nowrap;">€ ${fmtEur(item.total_price_cents ?? 0)}</p>
        </div>
      </div>`;
  }).join("");

  return `
    <p style="margin:20px 0 8px;font-weight:700;color:#1e3a5f;">${it ? "SERVIZI INCLUSI" : "INCLUDED SERVICES"}</p>
    ${blocks}
  `;
}

// ─── TEMPLATE 1 & 2 — OFFERTA ────────────────────────────────────────────────

function buildOfferBody(d: ServiceQuoteEmailData): string {
  const it = d.customerLanguage === "it";
  const e = escapeHtml;
  const totalCents = d.totalPriceCents ?? d.items?.reduce((sum, item) => sum + (item.total_price_cents ?? 0), 0) ?? d.priceCents * d.pax;
  const typeLabel = serviceTypeLabel(d.serviceType, d.customerLanguage);
  const showArrival = d.direction === "arrival" || d.direction === "round_trip";
  const showDeparture = d.direction === "departure" || d.direction === "round_trip";

  // Sezioni viaggio
  const arrivalRows: Array<[string, string]> = [];
  if (showArrival && d.arrivalDate) {
    arrivalRows.push([it ? "📅 Data arrivo" : "📅 Arrival date", fmtDate(d.arrivalDate)]);
    if (d.arrivalTime) arrivalRows.push([it ? "⏰ Orario" : "⏰ Time", fmtTime(d.arrivalTime)]);
    if (d.arrivalFlightTrain) arrivalRows.push([it ? "✈️ Volo / Treno" : "✈️ Flight / Train", e(d.arrivalFlightTrain)]);
  }
  const departureRows: Array<[string, string]> = [];
  if (showDeparture && d.departureDate) {
    departureRows.push([it ? "📅 Data partenza" : "📅 Departure date", fmtDate(d.departureDate)]);
    if (d.departureTime) departureRows.push([it ? "⏰ Orario" : "⏰ Time", fmtTime(d.departureTime)]);
    if (d.departureFlightTrain) departureRows.push([it ? "✈️ Volo / Treno" : "✈️ Flight / Train", e(d.departureFlightTrain)]);
  }

  const detailRows: Array<[string, string]> = [
    [it ? "🚐 Tipo servizio" : "🚐 Service type", e(typeLabel)],
    ...(d.hotelName ? [[it ? "🏨 Hotel" : "🏨 Hotel", e(d.hotelName)] as [string, string]] : []),
    ...(d.hotelAddress ? [[it ? "📍 Indirizzo" : "📍 Address", e(d.hotelAddress)] as [string, string]] : []),
    [it ? "👥 Passeggeri" : "👥 Passengers", String(d.pax)],
    ...(d.luggageNotes ? [[it ? "🧳 Note bagagli" : "🧳 Luggage notes", e(d.luggageNotes)] as [string, string]] : []),
    ...(d.specialRequests ? [[it ? "📝 Richieste speciali" : "📝 Special requests", e(d.specialRequests)] as [string, string]] : []),
  ];

  const priceRows: Array<[string, string]> = [
    [it ? "💶 Prezzo a persona" : "💶 Price per person", `€ ${fmtEur(d.priceCents)}`],
    [it ? "💶 Totale" : "💶 Total", `<strong>€ ${fmtEur(totalCents)}</strong>`],
    ...(d.priceNotes ? [[it ? "ℹ️ Note prezzo" : "ℹ️ Price notes", e(d.priceNotes)] as [string, string]] : []),
  ];

  const paymentRows: Array<[string, string]> = [
    ...(d.iban ? [["IBAN", `<span style="font-family:monospace;font-weight:600;">${e(d.iban)}</span>`] as [string, string]] : []),
    ...(d.swiftCode ? [["SWIFT/BIC", `<span style="font-family:monospace;font-weight:600;">${e(d.swiftCode)}</span>`] as [string, string]] : []),
    ...(d.bankAccountHolder ? [[it ? "Intestatario" : "Account holder", e(d.bankAccountHolder)] as [string, string]] : []),
    [it ? "Causale" : "Reference", `${it ? "Preventivo" : "Quote"} ${e(d.quoteNumber)} — ${e(d.customerLastName)}`],
  ];

  const intro = d.emailIntro
    ? `<p style="color:#475569;margin-bottom:20px;">${e(d.emailIntro)}</p>`
    : `<p style="color:#475569;margin-bottom:20px;">${it
        ? "Grazie per averci contattato. Di seguito la nostra offerta per il servizio richiesto."
        : "Thank you for contacting us. Please find below our quote for the requested service."}</p>`;

  const arrivalSection = arrivalRows.length > 0 ? `
    <p style="margin:20px 0 8px;font-weight:700;color:#1e3a5f;">${it ? "▼ ARRIVO A ISCHIA" : "▼ ARRIVAL TO ISCHIA"}</p>
    ${emailDataTable(arrivalRows)}` : "";

  const departureSection = departureRows.length > 0 ? `
    <p style="margin:20px 0 8px;font-weight:700;color:#1e3a5f;">${it ? "▲ PARTENZA DA ISCHIA" : "▲ DEPARTURE FROM ISCHIA"}</p>
    ${emailDataTable(departureRows)}` : "";

  const paymentTitle = it
    ? `<p style="margin:20px 0 8px;font-weight:700;color:#1e3a5f;">MODALITÀ DI PAGAMENTO (Bonifico bancario)</p>`
    : `<p style="margin:20px 0 8px;font-weight:700;color:#1e3a5f;">PAYMENT DETAILS (Bank transfer)</p>`;

  const extraPayment = d.paymentInstructions
    ? `<p style="color:#475569;font-size:13px;margin-top:12px;">${e(d.paymentInstructions)}</p>` : "";

  const acceptSection = emailHighlightBox(`
    <p style="font-size:15px;font-weight:600;color:#1e3a5f;margin-bottom:16px;">
      ${it ? "Per accettare questa offerta, clicca il pulsante:" : "To accept this quote, click the button:"}
    </p>
    ${emailButton(it ? "✅ ACCETTA OFFERTA" : "✅ ACCEPT QUOTE", d.acceptUrl, "#059669")}
    <p style="font-size:12px;color:#94a3b8;margin-top:12px;">
      ${it
        ? `Offerta valida fino al <strong>${fmtExpiresDate(d.expiresAt, "it")}</strong>`
        : `Quote valid until <strong>${fmtExpiresDate(d.expiresAt, "en")}</strong>`}
    </p>
  `, "#f0fdf4", "#bbf7d0");

  const disclaimer = `<div style="background:#fef9e7;border:1px solid #fde68a;border-radius:10px;padding:14px 16px;margin-top:20px;font-size:13px;color:#92400e;">
    ⚠️ ${it
      ? "L&apos;accettazione dell&apos;offerta <strong>non costituisce conferma definitiva</strong> del servizio. La prenotazione sarà confermata solo al ricevimento del pagamento."
      : "Accepting this quote does <strong>not constitute a confirmed booking</strong>. Your reservation will be confirmed only upon receipt of payment."}
  </div>`;

  const contacts = d.companyPhone || d.companyWhatsapp ? `
    <p style="margin-top:24px;font-size:14px;color:#475569;">
      ${it ? "Per qualsiasi domanda:" : "For any questions:"}
      ${d.companyPhone ? `<br/>📞 ${e(d.companyPhone)}` : ""}
      ${d.companyWhatsapp ? `<br/>💬 WhatsApp: ${e(d.companyWhatsapp)}` : ""}
      <br/>📧 <a href="mailto:info@ischiatransferservice.it" style="color:#3b82f6;">info@ischiatransferservice.it</a>
    </p>` : "";

  return `
    <p style="font-size:17px;margin-bottom:6px;">${it ? "Gentile" : "Dear"} <strong>${e(d.customerFirstName)} ${e(d.customerLastName)}</strong>,</p>
    ${intro}

    ${d.items && d.items.length > 0 ? buildItemsHtml(d.items, d.customerLanguage) : `
      <p style="margin:20px 0 8px;font-weight:700;color:#1e3a5f;">${it ? "DETTAGLI SERVIZIO" : "SERVICE DETAILS"}</p>
      ${emailDataTable(detailRows)}
      ${arrivalSection}
      ${departureSection}
    `}

    <p style="margin:20px 0 8px;font-weight:700;color:#1e3a5f;">${it ? "PREZZO" : "PRICE"}</p>
    ${emailDataTable(priceRows)}

    ${paymentTitle}
    ${emailDataTable(paymentRows)}
    ${extraPayment}

    ${acceptSection}
    ${disclaimer}
    ${contacts}
  `;
}

// ─── TEMPLATE 3 & 4 — CONFERMA ───────────────────────────────────────────────

function buildConfirmBody(d: QuoteConfirmEmailData): string {
  const it = d.customerLanguage === "it";
  const e = escapeHtml;
  const typeLabel = serviceTypeLabel(d.serviceType, d.customerLanguage);
  const showArrival = d.direction === "arrival" || d.direction === "round_trip";
  const showDeparture = d.direction === "departure" || d.direction === "round_trip";

  const rows: Array<[string, string]> = [
    [it ? "🚐 Tipo servizio" : "🚐 Service type", e(typeLabel)],
    ...(d.hotelName ? [[it ? "🏨 Hotel" : "🏨 Hotel", e(d.hotelName)] as [string, string]] : []),
    [it ? "👥 Passeggeri" : "👥 Passengers", String(d.pax)],
    ...(showArrival && d.arrivalDate
      ? [[it ? "▼ Arrivo" : "▼ Arrival",
          `${fmtDate(d.arrivalDate)} ${d.arrivalTime ? `alle ${fmtTime(d.arrivalTime)}` : ""}${d.arrivalFlightTrain ? ` — ${e(d.arrivalFlightTrain)}` : ""}`] as [string, string]]
      : []),
    ...(showDeparture && d.departureDate
      ? [[it ? "▲ Partenza" : "▲ Departure",
          `${fmtDate(d.departureDate)} ${d.departureTime ? `alle ${fmtTime(d.departureTime)}` : ""}${d.departureFlightTrain ? ` — ${e(d.departureFlightTrain)}` : ""}`] as [string, string]]
      : []),
    [it ? "💶 Totale pagato" : "💶 Total paid", `<strong>€ ${fmtEur(d.totalPaidCents)}</strong>`],
  ];

  const usefulInfo = showArrival ? `
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:18px 20px;margin:20px 0;">
      <p style="font-weight:700;color:#1e3a5f;margin:0 0 10px;">${it ? "INFORMAZIONI UTILI" : "USEFUL INFORMATION"}</p>
      <p style="color:#1e293b;margin:0 0 8px;">
        🚐 ${it
          ? "Il giorno dell&apos;arrivo il nostro autista vi attenderà al porto con un cartello con il vostro cognome."
          : "On arrival day, our driver will be waiting for you at the port with a sign displaying your name."}
      </p>
      <p style="color:#1e293b;margin:0;">
        📱 ${it
          ? "Il giorno prima del servizio riceverete un messaggio WhatsApp con i dettagli dell&apos;autista e del mezzo."
          : "The day before your service, you will receive a WhatsApp message with your driver&apos;s details and vehicle."}
      </p>
    </div>` : showDeparture ? `
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:18px 20px;margin:20px 0;">
      <p style="font-weight:700;color:#1e3a5f;margin:0 0 10px;">${it ? "INFORMAZIONI UTILI" : "USEFUL INFORMATION"}</p>
      <p style="color:#1e293b;margin:0 0 8px;">
        🚐 ${it
          ? "Il giorno della partenza il nostro autista vi preleverà direttamente dal vostro hotel all&apos;orario concordato."
          : "On departure day, our driver will pick you up directly from your hotel at the agreed time."}
      </p>
      <p style="color:#1e293b;margin:0;">
        📱 ${it
          ? "Il giorno prima riceverete un messaggio WhatsApp con l&apos;orario esatto di prelievo e i dettagli dell&apos;autista."
          : "The day before, you will receive a WhatsApp message with the exact pickup time and driver details."}
      </p>
    </div>` : "";

  const contacts = d.companyPhone || d.companyWhatsapp ? `
    <p style="margin-top:20px;font-size:14px;color:#475569;">
      ${it ? "Per qualsiasi variazione o necessità:" : "For any changes or assistance:"}
      ${d.companyPhone ? `<br/>📞 ${e(d.companyPhone)}` : ""}
      ${d.companyWhatsapp ? `<br/>💬 WhatsApp: ${e(d.companyWhatsapp)}` : ""}
      <br/>📧 <a href="mailto:info@ischiatransferservice.it" style="color:#3b82f6;">info@ischiatransferservice.it</a>
    </p>` : "";

  return `
    <p style="font-size:17px;margin-bottom:6px;">${it ? "Gentile" : "Dear"} <strong>${e(d.customerFirstName)} ${e(d.customerLastName)}</strong>,</p>

    ${emailHighlightBox(`
      <p style="font-size:18px;font-weight:800;color:#166534;margin:0 0 6px;">
        ✅ ${it ? "PRENOTAZIONE CONFERMATA" : "BOOKING CONFIRMED"}
      </p>
      <p style="color:#475569;font-size:14px;margin:0;">
        ${it ? "Il pagamento è stato ricevuto. Il Suo servizio è confermato." : "Your payment has been received. Your service is confirmed."}
      </p>
    `, "#f0fdf4", "#bbf7d0")}

    ${d.items && d.items.length > 0 ? buildItemsHtml(d.items, d.customerLanguage) : `
      <p style="margin:20px 0 8px;font-weight:700;color:#1e3a5f;">${it ? "RIEPILOGO SERVIZIO" : "SERVICE SUMMARY"}</p>
      ${emailDataTable(rows)}
    `}

    ${usefulInfo}
    ${contacts}

    <p style="margin-top:24px;font-weight:700;color:#1e3a5f;">
      ${it ? "A presto a Ischia! 🌊" : "See you in Ischia! 🌊"}
    </p>
  `;
}

// ─── Funzioni di invio ────────────────────────────────────────────────────────

// ─── Preview (HTML senza invio) ──────────────────────────────────────────────

export function buildQuoteOfferHtml(data: ServiceQuoteEmailData): { html: string; subject: string } {
  const it = data.customerLanguage === "it";
  const subject = it
    ? `Preventivo N° ${data.quoteNumber} — Ischia Transfer Service`
    : `Transfer Quote #${data.quoteNumber} — Ischia Transfer Service`;
  const html = emailHtml(buildOfferBody(data), {
    title: subject,
    preheader: it
      ? `Preventivo transfer — ${data.hotelName ?? ""} ${data.arrivalDate ? fmtDate(data.arrivalDate) : ""}`
      : `Transfer quote — ${data.hotelName ?? ""} ${data.arrivalDate ? fmtDate(data.arrivalDate) : ""}`,
    footerPhone: data.footerPhone,
  });
  return { html, subject };
}

// ─── Invio email offerta ──────────────────────────────────────────────────────

export async function sendQuoteOfferEmail(data: ServiceQuoteEmailData): Promise<QuoteEmailResult> {
  const it = data.customerLanguage === "it";
  const subject = it
    ? `Preventivo N° ${data.quoteNumber} — Ischia Transfer Service`
    : `Transfer Quote #${data.quoteNumber} — Ischia Transfer Service`;

  const html = emailHtml(buildOfferBody(data), {
    title: subject,
    preheader: it
      ? `Preventivo transfer — ${data.hotelName ?? ""} ${data.arrivalDate ? fmtDate(data.arrivalDate) : ""}`
      : `Transfer quote — ${data.hotelName ?? ""} ${data.arrivalDate ? fmtDate(data.arrivalDate) : ""}`,
    footerPhone: data.footerPhone,
  });

  const result = await sendEmail({ to: data.customerEmail, subject, html });
  if (!result.ok && !result.skipped) return { ok: false, error: result.error };
  return { ok: true };
}

export async function sendQuoteConfirmEmail(data: QuoteConfirmEmailData): Promise<QuoteEmailResult> {
  const it = data.customerLanguage === "it";
  const subject = it
    ? `✅ Prenotazione Confermata N° ${data.quoteNumber} — Ischia Transfer Service`
    : `✅ Booking Confirmed #${data.quoteNumber} — Ischia Transfer Service`;

  const html = emailHtml(buildConfirmBody(data), {
    title: subject,
    preheader: it ? "La sua prenotazione è stata confermata." : "Your booking has been confirmed.",
    footerPhone: data.footerPhone,
  });

  const result = await sendEmail({ to: data.customerEmail, subject, html });
  if (!result.ok && !result.skipped) return { ok: false, error: result.error };
  return { ok: true };
}
