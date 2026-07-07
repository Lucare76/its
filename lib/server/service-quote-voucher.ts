import type { SupabaseClient } from "@supabase/supabase-js";
import { escapeHtml } from "@/lib/server/escape-html";

type QuoteItemRow = {
  item_type: "service" | "free_text";
  title: string | null;
  description: string | null;
  service_type: string | null;
  direction: "arrival" | "departure" | "round_trip" | null;
  arrival_date: string | null;
  arrival_time: string | null;
  arrival_flight_train?: string | null;
  departure_date: string | null;
  departure_time: string | null;
  departure_flight_train?: string | null;
  hotel_name: string | null;
  hotel_address?: string | null;
  pax: number | null;
  quantity: number | null;
  luggage_notes?: string | null;
  special_requests: string | null;
};

type VoucherLanguage = "it" | "en";

const SERVICE_LABELS: Record<string, Record<VoucherLanguage, string>> = {
  transfer_airport: { it: "Transfer Aeroporto", en: "Airport Transfer" },
  transfer_station: { it: "Transfer Stazione", en: "Train Station Transfer" },
  transfer_port: { it: "Transfer Porto", en: "Port Transfer" },
  excursion: { it: "Escursione", en: "Excursion" },
  shuttle: { it: "Navetta", en: "Shuttle" },
  formula_snav: { it: "Formula SNAV", en: "SNAV Package" },
  formula_medmar: { it: "Formula Medmar", en: "Medmar Package" },
  custom: { it: "Servizio su misura", en: "Custom Service" },
};

const DIRECTION_LABELS: Record<string, Record<VoucherLanguage, string>> = {
  arrival: { it: "Arrivo", en: "Arrival" },
  departure: { it: "Partenza", en: "Departure" },
  round_trip: { it: "Andata e ritorno", en: "Round trip" },
};

const COPY: Record<VoucherLanguage, Record<string, string>> = {
  it: {
    htmlLang: "it",
    title: "Voucher prenotazione",
    subtitle: "Prenotazione confermata al ricevimento del saldo.",
    quoteRef: "Rif. preventivo",
    customer: "Cliente",
    guest: "Ospite",
    contacts: "Contatti",
    status: "Stato",
    confirmed: "Confermata",
    paid: "Pagata",
    preview: "Preview voucher",
    generatedOn: "Generato il",
    reference: "Riferimento",
    confirmedServicesVoucher: "Voucher servizi confermati",
    includedServices: "Servizi inclusi",
    type: "Tipo",
    direction: "Direzione",
    hotel: "Hotel",
    address: "Indirizzo",
    passengers: "Passeggeri",
    quantity: "Quantita",
    arrival: "Arrivo",
    departure: "Partenza",
    at: "ore",
    arrivalRef: "Rif. arrivo",
    departureRef: "Rif. partenza",
    luggage: "Bagagli",
    requests: "Richieste",
    customItem: "Voce prenotazione",
    service: "Servizio",
    note: "Il giorno prima del servizio riceverete, quando previsto, i dettagli operativi di autista, mezzo e orario definitivo. Presentare questo voucher in caso di richiesta del personale operativo.",
    phone: "Tel.",
    print: "Stampa / salva PDF",
  },
  en: {
    htmlLang: "en",
    title: "Booking voucher",
    subtitle: "Booking confirmed after receipt of payment.",
    quoteRef: "Quote ref.",
    customer: "Customer",
    guest: "Guest",
    contacts: "Contacts",
    status: "Status",
    confirmed: "Confirmed",
    paid: "Paid",
    preview: "Voucher preview",
    generatedOn: "Generated on",
    reference: "Reference",
    confirmedServicesVoucher: "Confirmed services voucher",
    includedServices: "Included services",
    type: "Type",
    direction: "Direction",
    hotel: "Hotel",
    address: "Address",
    passengers: "Passengers",
    quantity: "Quantity",
    arrival: "Arrival",
    departure: "Departure",
    at: "at",
    arrivalRef: "Arrival ref.",
    departureRef: "Departure ref.",
    luggage: "Luggage",
    requests: "Requests",
    customItem: "Booking item",
    service: "Service",
    note: "The day before the service, when applicable, you will receive the final operational details with driver, vehicle and confirmed time. Please present this voucher if requested by our operations team.",
    phone: "Phone",
    print: "Print / save PDF",
  },
};

function quoteLanguage(value: unknown): VoucherLanguage {
  return value === "en" ? "en" : "it";
}

function fmtDate(value: string | null | undefined, lang: VoucherLanguage) {
  if (!value) return "";
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleDateString(lang === "en" ? "en-GB" : "it-IT", { day: "2-digit", month: "long", year: "numeric", timeZone: "UTC" });
}

function fmtTime(value?: string | null) {
  return value ? String(value).slice(0, 5) : "";
}

function serviceLabel(type: string | null | undefined, lang: VoucherLanguage) {
  return type ? SERVICE_LABELS[type]?.[lang] ?? type : COPY[lang].service;
}

function directionLabel(direction: string | null | undefined, lang: VoucherLanguage) {
  return direction ? DIRECTION_LABELS[direction]?.[lang] ?? direction : "";
}

function itemTitle(item: QuoteItemRow, lang: VoucherLanguage) {
  if (item.title?.trim()) return item.title.trim();
  if (item.item_type === "free_text") return COPY[lang].customItem;
  return serviceLabel(item.service_type, lang);
}

function metaLine(label: string, value?: string | number | null) {
  if (value == null || String(value).trim() === "") return "";
  return `<span><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</span>`;
}

function renderItem(item: QuoteItemRow, index: number, lang: VoucherLanguage) {
  const t = COPY[lang];
  const showArrival = item.direction !== "departure";
  const showDeparture = item.direction !== "arrival";
  const meta = [
    item.item_type === "service" ? metaLine(t.type, serviceLabel(item.service_type, lang)) : "",
    item.direction ? metaLine(t.direction, directionLabel(item.direction, lang)) : "",
    item.hotel_name ? metaLine(t.hotel, item.hotel_name) : "",
    item.hotel_address ? metaLine(t.address, item.hotel_address) : "",
    item.pax && item.pax > 0 ? metaLine(t.passengers, `${item.pax} pax`) : "",
    item.quantity && item.quantity > 1 ? metaLine(t.quantity, item.quantity) : "",
    showArrival && item.arrival_date ? metaLine(t.arrival, `${fmtDate(item.arrival_date, lang)}${item.arrival_time ? ` ${t.at} ${fmtTime(item.arrival_time)}` : ""}`) : "",
    item.arrival_flight_train ? metaLine(t.arrivalRef, item.arrival_flight_train) : "",
    showDeparture && item.departure_date ? metaLine(t.departure, `${fmtDate(item.departure_date, lang)}${item.departure_time ? ` ${t.at} ${fmtTime(item.departure_time)}` : ""}`) : "",
    item.departure_flight_train ? metaLine(t.departureRef, item.departure_flight_train) : "",
    item.luggage_notes ? metaLine(t.luggage, item.luggage_notes) : "",
    item.special_requests ? metaLine(t.requests, item.special_requests) : "",
  ].filter(Boolean);

  const description = item.description?.trim()
    ? `<p class="item-description">${escapeHtml(item.description.trim())}</p>`
    : "";

  return `
    <section class="item">
      <div class="item-index">${index + 1}</div>
      <div class="item-body">
        <h2>${escapeHtml(itemTitle(item, lang))}</h2>
        ${description}
        <div class="meta">${meta.join("")}</div>
      </div>
    </section>`;
}

export async function buildServiceQuoteVoucherHtml(
  admin: SupabaseClient,
  tenantId: string,
  quoteId: string,
) {
  const [{ data: quote, error }, { data: items }, { data: tenant }] = await Promise.all([
    admin.from("service_quotes").select("*").eq("tenant_id", tenantId).eq("id", quoteId).single(),
    admin.from("service_quote_items").select("*").eq("tenant_id", tenantId).eq("quote_id", quoteId).order("sort_order", { ascending: true }),
    admin.from("tenants").select("name, contact_phone, quote_company_phone, quote_company_whatsapp").eq("id", tenantId).maybeSingle(),
  ]);

  if (error || !quote) throw new Error("Preventivo non trovato.");

  const lang = quoteLanguage(quote.customer_language);
  const t = COPY[lang];
  const quoteItems = (items ?? []) as QuoteItemRow[];
  const fallbackItems: QuoteItemRow[] = [{
    item_type: "service",
    title: null,
    description: null,
    service_type: quote.service_type,
    direction: quote.direction,
    arrival_date: quote.arrival_date,
    arrival_time: quote.arrival_time,
    arrival_flight_train: quote.arrival_flight_train,
    departure_date: quote.departure_date,
    departure_time: quote.departure_time,
    departure_flight_train: quote.departure_flight_train,
    hotel_name: quote.hotel_name,
    hotel_address: quote.hotel_address,
    pax: quote.pax,
    quantity: 1,
    luggage_notes: quote.luggage_notes,
    special_requests: quote.special_requests,
  }];
  const voucherItems = quoteItems.length > 0 ? quoteItems : fallbackItems;

  const customerName = `${quote.customer_first_name ?? ""} ${quote.customer_last_name ?? ""}`.trim();
  const guestName = quote.is_agency && quote.end_customer_name ? quote.end_customer_name : null;
  const companyName = tenant?.name ?? "Ischia Transfer Service";
  const contactPhone = tenant?.quote_company_phone ?? tenant?.contact_phone ?? null;
  const contactWhatsapp = tenant?.quote_company_whatsapp ?? null;
  const printedAt = new Date().toLocaleString(lang === "en" ? "en-GB" : "it-IT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const statusLabel = quote.status === "confirmed"
    ? t.confirmed
    : quote.status === "paid"
      ? t.paid
      : t.preview;

  return `<!doctype html>
<html lang="${t.htmlLang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(t.title)} ${escapeHtml(quote.quote_number)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #f3f4f6; color: #111827; font-family: Arial, Helvetica, sans-serif; }
    @page { size: A4; margin: 14mm; }
    @media print {
      body { background: #fff; }
      .page { margin: 0; box-shadow: none; border: 0; }
      .no-print { display: none !important; }
    }
    .page { max-width: 820px; margin: 28px auto; background: #fff; border: 1px solid #e5e7eb; box-shadow: 0 16px 45px rgba(15,23,42,.10); }
    .hero { padding: 30px 34px; background: #0f172a; color: #fff; }
    .brand-row { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
    .brand-logo { width: 132px; height: auto; display: block; }
    .kicker { margin: 0 0 6px; font-size: 11px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: #93c5fd; }
    h1 { margin: 0; font-size: 30px; line-height: 1.08; }
    .hero-grid { display: grid; grid-template-columns: 1fr auto; gap: 20px; align-items: end; margin-top: 22px; }
    .ref { text-align: right; }
    .ref strong { display: block; font-size: 20px; letter-spacing: .04em; }
    .ref span { color: #cbd5e1; font-size: 12px; }
    .content { padding: 28px 34px 34px; }
    .summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-bottom: 24px; }
    .box { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 14px; min-height: 72px; }
    .box label { display: block; margin-bottom: 5px; font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #64748b; }
    .box p { margin: 0; font-size: 14px; line-height: 1.35; font-weight: 700; color: #111827; }
    .box small { display: block; margin-top: 4px; color: #64748b; font-weight: 400; }
    .items-title { margin: 0 0 12px; font-size: 12px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; color: #0f172a; }
    .item { display: grid; grid-template-columns: 34px 1fr; gap: 12px; border-top: 1px solid #e5e7eb; padding: 18px 0; break-inside: avoid; }
    .item-index { width: 30px; height: 30px; border-radius: 999px; background: #dbeafe; color: #1d4ed8; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 13px; }
    .item h2 { margin: 3px 0 8px; font-size: 17px; color: #0f172a; }
    .item-description { margin: 0 0 10px; color: #475569; font-size: 13px; line-height: 1.45; white-space: pre-line; }
    .meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px 18px; font-size: 12px; color: #334155; line-height: 1.35; }
    .meta span { min-width: 0; }
    .note { margin-top: 22px; border: 1px solid #bfdbfe; background: #eff6ff; border-radius: 8px; padding: 14px 16px; color: #1e3a8a; font-size: 13px; line-height: 1.45; }
    .footer { display: flex; justify-content: space-between; gap: 16px; border-top: 1px solid #e5e7eb; padding: 16px 34px; color: #64748b; font-size: 11px; }
    .toolbar { max-width: 820px; margin: 0 auto 28px; text-align: right; }
    .toolbar button { border: 0; border-radius: 8px; background: #0f172a; color: #fff; padding: 10px 16px; font-weight: 700; cursor: pointer; }
    @media (max-width: 680px) {
      .page { margin: 0; border: 0; }
      .hero, .content, .footer { padding-left: 20px; padding-right: 20px; }
      .brand-row { align-items: flex-start; flex-direction: column; }
      .hero-grid, .summary, .meta { grid-template-columns: 1fr; }
      .ref { text-align: left; }
    }
  </style>
</head>
<body>
  <main class="page">
    <header class="hero">
      <div class="brand-row">
        <img class="brand-logo" src="/brand/logo-email-header.png" alt="${escapeHtml(companyName)} logo">
        <p class="kicker">${escapeHtml(companyName)}</p>
      </div>
      <h1>${escapeHtml(t.title)}</h1>
      <div class="hero-grid">
        <div>
          <p style="margin:0;color:#dbeafe;font-size:14px;">${escapeHtml(t.subtitle)}</p>
        </div>
        <div class="ref">
          <strong>${escapeHtml(quote.quote_number)}</strong>
          <span>${escapeHtml(t.quoteRef)}</span>
        </div>
      </div>
    </header>
    <section class="content">
      <div class="summary">
        <div class="box"><label>${escapeHtml(t.customer)}</label><p>${escapeHtml(customerName || "-")}${guestName ? `<small>${escapeHtml(t.guest)}: ${escapeHtml(guestName)}</small>` : ""}</p></div>
        <div class="box"><label>${escapeHtml(t.contacts)}</label><p>${escapeHtml(quote.customer_email ?? "-")}${quote.customer_phone ? `<small>${escapeHtml(quote.customer_phone)}</small>` : ""}</p></div>
        <div class="box"><label>${escapeHtml(t.status)}</label><p>${escapeHtml(statusLabel)}<small>${escapeHtml(t.generatedOn)} ${escapeHtml(printedAt)}</small></p></div>
        <div class="box"><label>${escapeHtml(t.reference)}</label><p>${escapeHtml(quote.quote_number ?? "-")}<small>${escapeHtml(t.confirmedServicesVoucher)}</small></p></div>
      </div>

      <p class="items-title">${escapeHtml(t.includedServices)}</p>
      ${voucherItems.map((item, index) => renderItem(item, index, lang)).join("")}

      <div class="note">
        ${escapeHtml(t.note)}
      </div>
    </section>
    <footer class="footer">
      <span>${escapeHtml(companyName)}</span>
      <span>${contactPhone ? `${escapeHtml(t.phone)} ${escapeHtml(contactPhone)}` : ""}${contactWhatsapp ? ` - WhatsApp ${escapeHtml(contactWhatsapp)}` : ""}</span>
    </footer>
  </main>
  <div class="toolbar no-print"><button onclick="window.print()">${escapeHtml(t.print)}</button></div>
</body>
</html>`;
}
