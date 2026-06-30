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
  total_price_cents?: number | null;
  luggage_notes?: string | null;
  special_requests: string | null;
  price_notes: string | null;
};

const SERVICE_LABELS: Record<string, string> = {
  transfer_airport: "Transfer Aeroporto",
  transfer_station: "Transfer Stazione",
  transfer_port: "Transfer Porto",
  excursion: "Escursione",
  shuttle: "Navetta",
  formula_snav: "Formula SNAV",
  formula_medmar: "Formula Medmar",
  custom: "Servizio su misura",
};

const DIRECTION_LABELS: Record<string, string> = {
  arrival: "Arrivo",
  departure: "Partenza",
  round_trip: "Andata e ritorno",
};

function fmtDate(value?: string | null) {
  if (!value) return "";
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleDateString("it-IT", { day: "2-digit", month: "long", year: "numeric", timeZone: "UTC" });
}

function fmtTime(value?: string | null) {
  return value ? String(value).slice(0, 5) : "";
}

function fmtMoney(cents: number) {
  return `EUR ${(cents / 100).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function serviceLabel(type?: string | null) {
  return type ? SERVICE_LABELS[type] ?? type : "Servizio";
}

function itemTitle(item: QuoteItemRow, index: number) {
  if (item.title?.trim()) return item.title.trim();
  if (item.item_type === "free_text") return "Voce prenotazione";
  return serviceLabel(item.service_type);
}

function metaLine(label: string, value?: string | number | null) {
  if (value == null || String(value).trim() === "") return "";
  return `<span><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</span>`;
}

function renderItem(item: QuoteItemRow, index: number) {
  const showArrival = item.direction !== "departure";
  const showDeparture = item.direction !== "arrival";
  const meta = [
    item.item_type === "service" ? metaLine("Tipo", serviceLabel(item.service_type)) : "",
    item.direction ? metaLine("Direzione", DIRECTION_LABELS[item.direction] ?? item.direction) : "",
    item.hotel_name ? metaLine("Hotel", item.hotel_name) : "",
    item.hotel_address ? metaLine("Indirizzo", item.hotel_address) : "",
    item.pax && item.pax > 0 ? metaLine("Passeggeri", `${item.pax} pax`) : "",
    item.quantity && item.quantity > 1 ? metaLine("Quantita", item.quantity) : "",
    showArrival && item.arrival_date ? metaLine("Arrivo", `${fmtDate(item.arrival_date)}${item.arrival_time ? ` ore ${fmtTime(item.arrival_time)}` : ""}`) : "",
    item.arrival_flight_train ? metaLine("Rif. arrivo", item.arrival_flight_train) : "",
    showDeparture && item.departure_date ? metaLine("Partenza", `${fmtDate(item.departure_date)}${item.departure_time ? ` ore ${fmtTime(item.departure_time)}` : ""}`) : "",
    item.departure_flight_train ? metaLine("Rif. partenza", item.departure_flight_train) : "",
    item.luggage_notes ? metaLine("Bagagli", item.luggage_notes) : "",
    item.special_requests ? metaLine("Richieste", item.special_requests) : "",
    item.price_notes ? metaLine("Note", item.price_notes) : "",
  ].filter(Boolean);

  const description = item.description?.trim()
    ? `<p class="item-description">${escapeHtml(item.description.trim())}</p>`
    : "";

  return `
    <section class="item">
      <div class="item-index">${index + 1}</div>
      <div class="item-body">
        <h2>${escapeHtml(itemTitle(item, index))}</h2>
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
    price_notes: quote.price_notes,
  }];
  const voucherItems = quoteItems.length > 0 ? quoteItems : fallbackItems;

  const totalCents = quoteItems.length > 0
    ? quoteItems.reduce((sum, item) => sum + Number(item.total_price_cents ?? 0), 0)
    : Number(quote.price_mode === "total" ? quote.price_cents : quote.price_cents * quote.pax);

  const customerName = `${quote.customer_first_name ?? ""} ${quote.customer_last_name ?? ""}`.trim();
  const guestName = quote.is_agency && quote.end_customer_name ? quote.end_customer_name : null;
  const companyName = tenant?.name ?? "Ischia Transfer Service";
  const contactPhone = tenant?.quote_company_phone ?? tenant?.contact_phone ?? null;
  const contactWhatsapp = tenant?.quote_company_whatsapp ?? null;
  const printedAt = new Date().toLocaleString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Voucher prenotazione ${escapeHtml(quote.quote_number)}</title>
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
      .hero-grid, .summary, .meta { grid-template-columns: 1fr; }
      .ref { text-align: left; }
    }
  </style>
</head>
<body>
  <main class="page">
    <header class="hero">
      <p class="kicker">${escapeHtml(companyName)}</p>
      <h1>Voucher prenotazione</h1>
      <div class="hero-grid">
        <div>
          <p style="margin:0;color:#dbeafe;font-size:14px;">Prenotazione confermata al ricevimento del saldo.</p>
        </div>
        <div class="ref">
          <strong>${escapeHtml(quote.quote_number)}</strong>
          <span>Rif. preventivo</span>
        </div>
      </div>
    </header>
    <section class="content">
      <div class="summary">
        <div class="box"><label>Cliente</label><p>${escapeHtml(customerName || "-")}${guestName ? `<small>Ospite: ${escapeHtml(guestName)}</small>` : ""}</p></div>
        <div class="box"><label>Contatti</label><p>${escapeHtml(quote.customer_email ?? "-")}${quote.customer_phone ? `<small>${escapeHtml(quote.customer_phone)}</small>` : ""}</p></div>
        <div class="box"><label>Totale prenotazione</label><p>${escapeHtml(fmtMoney(totalCents))}</p></div>
        <div class="box"><label>Stato</label><p>${quote.status === "confirmed" ? "Confermata" : "Preview voucher"}<small>Generato il ${escapeHtml(printedAt)}</small></p></div>
      </div>

      <p class="items-title">Servizi inclusi</p>
      ${voucherItems.map(renderItem).join("")}

      <div class="note">
        Il giorno prima del servizio riceverete, quando previsto, i dettagli operativi di autista, mezzo e orario definitivo. Presentare questo voucher in caso di richiesta del personale operativo.
      </div>
    </section>
    <footer class="footer">
      <span>${escapeHtml(companyName)}</span>
      <span>${contactPhone ? `Tel. ${escapeHtml(contactPhone)}` : ""}${contactWhatsapp ? ` - WhatsApp ${escapeHtml(contactWhatsapp)}` : ""}</span>
    </footer>
  </main>
  <div class="toolbar no-print"><button onclick="window.print()">Stampa / salva PDF</button></div>
</body>
</html>`;
}
