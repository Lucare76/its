"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getToken } from "@/lib/supabase/client";


// ── Types ─────────────────────────────────────────────────────────────────────

type Status = "draft" | "offer_sent" | "accepted" | "paid" | "confirmed" | "expired" | "cancelled";

type QuoteFull = {
  id: string;
  quote_number: string;
  status: Status;
  customer_first_name: string;
  customer_last_name: string;
  customer_email: string;
  customer_phone: string | null;
  customer_language: "it" | "en";
  service_type: string;
  direction: "arrival" | "departure" | "round_trip" | null;
  arrival_date: string | null;
  arrival_time: string | null;
  arrival_flight_train: string | null;
  departure_date: string | null;
  departure_time: string | null;
  departure_flight_train: string | null;
  hotel_name: string | null;
  hotel_address: string | null;
  pax: number;
  luggage_notes: string | null;
  special_requests: string | null;
  price_cents: number;
  price_mode: "per_person" | "total";
  currency: string;
  price_notes: string | null;
  email_intro: string | null;
  payment_method: string | null;
  iban: string | null;
  swift_code: string | null;
  bank_account_holder: string | null;
  payment_instructions: string | null;
  payment_reference: string | null;
  notes_internal: string | null;
  is_agency: boolean;
  end_customer_name: string | null;
  offer_sent_at: string | null;
  accepted_at: string | null;
  paid_at: string | null;
  confirmed_at: string | null;
  cancelled_at: string | null;
  expires_at: string | null;
  created_at: string;
  items?: QuoteItem[];
};

type QuoteItem = {
  item_type: "service" | "free_text";
  title: string | null;
  description: string | null;
  service_type: string | null;
  direction: "arrival" | "departure" | "round_trip" | null;
  arrival_date: string | null;
  arrival_time: string | null;
  departure_date: string | null;
  departure_time: string | null;
  hotel_name: string | null;
  pax: number | null;
  quantity: number | null;
  price_mode: "per_person" | "total";
  unit_price_cents: number | null;
  total_price_cents: number | null;
  price_notes: string | null;
};

type QuoteItemForm = {
  item_type: "service" | "free_text";
  title: string;
  description: string;
  service_type: string;
  direction: string;
  service_date: string;
  service_time: string;
  hotel_name: string;
  pax: number;
  quantity: number;
  price_euros: string;
  price_mode: "per_person" | "total";
  price_notes: string;
};

type FormData = {
  customer_first_name: string;
  customer_last_name: string;
  customer_email: string;
  customer_phone: string;
  customer_language: "it" | "en";
  service_type: string;
  direction: string;
  arrival_date: string;
  arrival_time: string;
  arrival_flight_train: string;
  departure_date: string;
  departure_time: string;
  departure_flight_train: string;
  hotel_name: string;
  hotel_address: string;
  pax: number;
  luggage_notes: string;
  special_requests: string;
  price_euros: string;
  price_mode: "per_person" | "total";
  price_notes: string;
  email_intro: string;
  iban: string;
  swift_code: string;
  bank_account_holder: string;
  payment_instructions: string;
  notes_internal: string;
  is_agency: boolean;
  end_customer_name: string;
  items: QuoteItemForm[];
};

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  draft: "Bozza", offer_sent: "Offerta inviata", accepted: "Accettata",
  paid: "Pagata", confirmed: "Confermata", expired: "Scaduta", cancelled: "Cancellata",
};
const STATUS_COLORS: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600", offer_sent: "bg-blue-100 text-blue-700",
  accepted: "bg-yellow-100 text-yellow-700", paid: "bg-purple-100 text-purple-700",
  confirmed: "bg-green-100 text-green-700", expired: "bg-orange-100 text-orange-700",
  cancelled: "bg-red-100 text-red-700",
};
const SERVICE_OPTIONS = [
  { value: "transfer_airport", label: "Transfer Aeroporto" },
  { value: "transfer_station", label: "Transfer Stazione" },
  { value: "transfer_port",    label: "Transfer Porto" },
  { value: "excursion",        label: "Escursione" },
  { value: "shuttle",          label: "Navetta" },
  { value: "formula_snav",     label: "Formula SNAV" },
  { value: "formula_medmar",   label: "Formula Medmar" },
  { value: "custom",           label: "Su misura" },
];
const SERVICE_LABELS: Record<string, string> = Object.fromEntries(SERVICE_OPTIONS.map(o => [o.value, o.label]));
const DIR_LABELS: Record<string, string> = { arrival: "Arrivo", departure: "Partenza", round_trip: "Andata e Ritorno" };

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}
function fmtDatetime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("it-IT", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtEur(cents: number) { return `€ ${(cents / 100).toFixed(2)}`; }

function quoteItemsTotal(items: QuoteItem[] | undefined, fallback: number) {
  return items && items.length > 0 ? items.reduce((sum, item) => sum + (item.total_price_cents ?? 0), 0) : fallback;
}

function quoteToForm(q: QuoteFull): FormData {
  return {
    customer_first_name: q.customer_first_name,
    customer_last_name:  q.customer_last_name,
    customer_email:      q.customer_email,
    customer_phone:      q.customer_phone ?? "",
    customer_language:   q.customer_language,
    service_type:        q.service_type,
    direction:           q.direction ?? "",
    arrival_date:        q.arrival_date ?? "",
    arrival_time:        q.arrival_time?.slice(0,5) ?? "",
    arrival_flight_train: q.arrival_flight_train ?? "",
    departure_date:      q.departure_date ?? "",
    departure_time:      q.departure_time?.slice(0,5) ?? "",
    departure_flight_train: q.departure_flight_train ?? "",
    hotel_name:          q.hotel_name ?? "",
    hotel_address:       q.hotel_address ?? "",
    pax:                 q.pax,
    luggage_notes:       q.luggage_notes ?? "",
    special_requests:    q.special_requests ?? "",
    price_euros:         String(q.price_cents / 100),
    price_mode:          q.price_mode ?? "per_person",
    price_notes:         q.price_notes ?? "",
    email_intro:         q.email_intro ?? "",
    iban:                q.iban ?? "",
    swift_code:          q.swift_code ?? "",
    bank_account_holder: q.bank_account_holder ?? "",
    payment_instructions: q.payment_instructions ?? "",
    notes_internal:      q.notes_internal ?? "",
    is_agency:           q.is_agency ?? false,
    end_customer_name:   q.end_customer_name ?? "",
    items: Array.isArray(q.items) ? q.items.slice(1).map((item) => ({
      item_type: item.item_type === "free_text" ? "free_text" as const : "service" as const,
      title: String(item.title ?? ""),
      description: String(item.description ?? ""),
      service_type: String(item.service_type ?? "custom"),
      direction: String(item.direction ?? ""),
      service_date: String(item.arrival_date ?? item.departure_date ?? ""),
      service_time: String((item.arrival_time ?? item.departure_time ?? "") as string).slice(0, 5),
      hotel_name: String(item.hotel_name ?? ""),
      pax: Number(item.pax ?? 1),
      quantity: Number(item.quantity ?? 1),
      price_euros: item.unit_price_cents ? String(Number(item.unit_price_cents) / 100) : "",
      price_mode: item.price_mode === "total" ? "total" as const : "per_person" as const,
      price_notes: String(item.price_notes ?? ""),
    })) : [],
  };
}

// Locking rules per status
function isLocked(field: string, status: Status): boolean {
  if (status === "expired" || status === "cancelled") return true;
  if (status === "confirmed" || status === "paid") return field !== "notes_internal";
  if (status === "accepted") return field === "price_euros" || field === "price_mode";
  return false; // draft, offer_sent: tutto modificabile
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PreventivDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  const [quote, setQuote]       = useState<QuoteFull | null>(null);
  const [loading, setLoading]   = useState(true);
  const [mode, setMode]         = useState<"view" | "edit">("view");
  const [form, setForm]         = useState<FormData | null>(null);
  const [saving, setSaving]     = useState(false);
  const [saveError, setSaveError] = useState("");
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [paymentRef, setPaymentRef] = useState("");

  const [previewOpen, setPreviewOpen]       = useState(false);
  const [previewLang, setPreviewLang]       = useState<"it"|"en">("it");
  const [previewHtml, setPreviewHtml]       = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);

  async function loadQuote() {
    const token = await getToken();
    if (!token) { setLoading(false); return; }
    setLoading(true);
    const res = await fetch(`/api/ops/service-quotes/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json() as { ok?: boolean; quote?: QuoteFull };
    if (body.ok && body.quote) {
      setQuote(body.quote);
      setForm(quoteToForm(body.quote));
      setPreviewLang(body.quote.customer_language);
    }
    setLoading(false);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadQuote(); }, 0);
    return () => window.clearTimeout(timer);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  function sf(field: keyof FormData, value: string | number) {
    setForm(f => f ? { ...f, [field]: value } : f);
  }

  function updateItem(index: number, patch: Partial<QuoteItemForm>) {
    setForm(f => f ? { ...f, items: f.items.map((item, i) => i === index ? { ...item, ...patch } : item) } : f);
  }

  function addItem(item_type: "service" | "free_text") {
    setForm(f => f ? {
      ...f,
      items: [...f.items, {
        item_type, title: item_type === "service" ? "Servizio aggiuntivo" : "Voce libera",
        description: "", service_type: "custom", direction: "", service_date: "", service_time: "",
        hotel_name: "", pax: item_type === "service" ? f.pax : 0, quantity: 1,
        price_euros: "", price_mode: "per_person" as const, price_notes: "",
      }],
    } : f);
  }

  function removeItem(index: number) {
    setForm(f => f ? { ...f, items: f.items.filter((_, i) => i !== index) } : f);
  }

  function itemPriceCents(value: string) {
    return Math.round(parseFloat(value) * 100) || 0;
  }

  function buildQuoteItems(priceCents: number) {
    if (!form) return [];
    const formShowArr = form.direction === "arrival" || form.direction === "round_trip";
    const formShowDep = form.direction === "departure" || form.direction === "round_trip";
    return [
      {
        item_type: "service" as const, price_mode: form.price_mode, service_type: form.service_type,
        direction: form.direction || null,
        arrival_date: formShowArr ? (form.arrival_date || null) : null,
        arrival_time: formShowArr ? (form.arrival_time || null) : null,
        arrival_flight_train: formShowArr ? (form.arrival_flight_train || null) : null,
        departure_date: formShowDep ? (form.departure_date || null) : null,
        departure_time: formShowDep ? (form.departure_time || null) : null,
        departure_flight_train: formShowDep ? (form.departure_flight_train || null) : null,
        hotel_name: form.hotel_name || null, hotel_address: form.hotel_address || null,
        pax: form.pax, quantity: 1, luggage_notes: form.luggage_notes || null,
        special_requests: form.special_requests || null,
        unit_price_cents: priceCents,
        total_price_cents: form.price_mode === "total" ? priceCents : priceCents * form.pax,
        price_notes: form.price_notes || null,
      },
      ...form.items.map((item) => {
        const cents = itemPriceCents(item.price_euros);
        return {
          item_type: item.item_type, price_mode: item.price_mode,
          title: item.title || null, description: item.description || null,
          service_type: item.item_type === "service" ? item.service_type : null,
          direction: item.item_type === "service" ? item.direction || null : null,
          arrival_date: item.item_type === "service" && item.direction !== "departure" ? item.service_date || null : null,
          arrival_time: item.item_type === "service" && item.direction !== "departure" ? item.service_time || null : null,
          departure_date: item.item_type === "service" && item.direction === "departure" ? item.service_date || null : null,
          departure_time: item.item_type === "service" && item.direction === "departure" ? item.service_time || null : null,
          hotel_name: item.item_type === "service" ? item.hotel_name || null : null,
          pax: item.item_type === "service" ? item.pax : 0,
          quantity: item.item_type === "free_text" ? item.quantity : 1,
          unit_price_cents: cents,
          total_price_cents: item.price_mode === "total" ? cents
            : item.item_type === "service" ? cents * Math.max(item.pax, 1) : cents * Math.max(item.quantity, 1),
          price_notes: item.price_notes || null,
        };
      }),
    ];
  }

  async function handleSave(sendAfter = false) {
    if (!form || !quote) return;
    setSaving(true);
    setSaveError("");
    const token = await getToken();
    if (!token) { setSaving(false); return; }

    const priceCents = Math.round(parseFloat(form.price_euros) * 100) || quote.price_cents;
    const payload: Record<string, unknown> = {
      customer_first_name: form.customer_first_name.trim(),
      customer_last_name:  form.customer_last_name.trim(),
      customer_email:      form.customer_email.trim(),
      customer_phone:      form.customer_phone || null,
      customer_language:   form.customer_language,
      service_type:        form.service_type,
      direction:           form.direction || null,
      arrival_date:        form.arrival_date || null,
      arrival_time:        form.arrival_time || null,
      arrival_flight_train: form.arrival_flight_train || null,
      departure_date:      form.departure_date || null,
      departure_time:      form.departure_time || null,
      departure_flight_train: form.departure_flight_train || null,
      hotel_name:          form.hotel_name || null,
      hotel_address:       form.hotel_address || null,
      pax:                 form.pax,
      luggage_notes:       form.luggage_notes || null,
      special_requests:    form.special_requests || null,
      price_notes:         form.price_notes || null,
      price_mode:          form.price_mode,
      email_intro:         form.email_intro || null,
      iban:                form.iban || null,
      swift_code:          form.swift_code || null,
      bank_account_holder: form.bank_account_holder || null,
      payment_instructions: form.payment_instructions || null,
      notes_internal:      form.notes_internal || null,
      is_agency:           form.is_agency,
      end_customer_name:   form.is_agency ? (form.end_customer_name || null) : null,
    };
    if (!isLocked("price_euros", quote.status)) payload.price_cents = priceCents;
    payload.items = buildQuoteItems(priceCents);

    const res = await fetch(`/api/ops/service-quotes/${id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json() as { ok?: boolean; error?: string };
    if (!body.ok) { setSaveError(body.error ?? "Errore salvataggio."); setSaving(false); return; }

    await loadQuote();
    setMode("view");
    setSaving(false);

    if (sendAfter) {
      await doAction("send");
    }
  }

  async function doAction(action: string, extra?: Record<string, unknown>) {
    setActionBusy(action);
    setActionError("");
    const token = await getToken();
    if (!token) { setActionBusy(null); return; }
    const res = await fetch(`/api/ops/service-quotes/${id}/${action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(extra ?? {}),
    });
    const body = await res.json() as { ok?: boolean; error?: string };
    if (!body.ok) setActionError(body.error ?? "Errore.");
    else await loadQuote();
    setActionBusy(null);
  }

  async function loadPreview(lang: "it"|"en") {
    setPreviewLang(lang);
    setPreviewLoading(true);
    setPreviewHtml("");
    const token = await getToken();
    if (!token) { setPreviewLoading(false); return; }
    const res = await fetch(`/api/ops/service-quotes/${id}/preview-email?lang=${lang}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json() as { ok?: boolean; html?: string };
    if (body.ok && body.html) setPreviewHtml(body.html);
    setPreviewLoading(false);
  }

  function openPreview() {
    setPreviewOpen(true);
    void loadPreview(previewLang);
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  if (loading) return (
    <div className="flex items-center justify-center h-screen text-slate-400">Caricamento preventivo…</div>
  );
  if (!quote || !form) return (
    <div className="flex flex-col items-center justify-center h-screen gap-4">
      <p className="text-slate-500">Preventivo non trovato.</p>
      <Link href="/preventivi" className="text-blue-600 hover:underline text-sm">← Torna alla lista</Link>
    </div>
  );

  const isReadOnly = quote.status === "expired" || quote.status === "cancelled";
  const isPartialLock = quote.status === "confirmed" || quote.status === "paid";
  const showArr = (form.direction || quote.direction) === "arrival" || (form.direction || quote.direction) === "round_trip";
  const showDep = (form.direction || quote.direction) === "departure" || (form.direction || quote.direction) === "round_trip";
  const quoteItems = quote.items ?? [];
  const totalCents = quoteItemsTotal(
    quoteItems,
    quote.price_mode === "total" ? quote.price_cents : quote.price_cents * quote.pax,
  );

  // ── VIEW mode ──────────────────────────────────────────────────────────────

  if (mode === "view") return (
    <>
      <div className="quote-natural-text min-h-screen bg-slate-50">
        <div className="max-w-2xl mx-auto py-8 px-4 space-y-4">
          {/* Header */}
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-3 flex-wrap mb-1">
                <h1 className="text-xl font-bold text-slate-800">{quote.quote_number}</h1>
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_COLORS[quote.status]}`}>
                  {STATUS_LABELS[quote.status]}
                </span>
              </div>
              <p className="text-slate-500 text-sm">{quote.customer_first_name} {quote.customer_last_name} — {quote.customer_email}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Link href="/preventivi" className="text-xs text-slate-400 hover:text-slate-600">← Lista</Link>
              {!isReadOnly && (
                <button onClick={() => setMode("edit")}
                  className="flex items-center gap-1.5 text-sm px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl">
                  ✏️ Modifica
                </button>
              )}
            </div>
          </div>

          {actionError && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2 rounded-xl">{actionError}</div>
          )}

          {/* Status warnings */}
          {quote.status === "offer_sent" && (
            <div className="bg-blue-50 border border-blue-200 text-blue-800 text-xs px-4 py-2 rounded-xl">
              ℹ️ Offerta inviata il {fmtDatetime(quote.offer_sent_at)}. Scade il {fmtDate(quote.expires_at)}.
            </div>
          )}
          {quote.status === "accepted" && (
            <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 text-xs px-4 py-2 rounded-xl">
              ✅ Offerta accettata il {fmtDatetime(quote.accepted_at)}. In attesa di pagamento.
            </div>
          )}

          {/* Sections */}
          <Section title="Cliente">
            <Row label="Nome" value={`${quote.customer_first_name} ${quote.customer_last_name}`} />
            <Row label="Email" value={quote.customer_email} />
            {quote.customer_phone && <Row label="Telefono" value={quote.customer_phone} />}
            <Row label="Lingua" value={quote.customer_language === "it" ? "🇮🇹 Italiano" : "🇬🇧 English"} />
            {quote.is_agency && <Row label="Tipo" value="Agenzia" />}
            {quote.is_agency && quote.end_customer_name && <Row label="Cliente finale" value={quote.end_customer_name} />}
          </Section>

          <Section title="Servizio">
            <Row label="Tipo" value={SERVICE_LABELS[quote.service_type] ?? quote.service_type} />
            {quote.direction && <Row label="Direzione" value={DIR_LABELS[quote.direction] ?? quote.direction} />}
            {quote.hotel_name && <Row label="Hotel" value={quote.hotel_name} />}
            {quote.hotel_address && <Row label="Indirizzo" value={quote.hotel_address} />}
            <Row label="Passeggeri" value={String(quote.pax)} />
            {quote.luggage_notes && <Row label="Bagagli" value={quote.luggage_notes} />}
            {quote.special_requests && <Row label="Richieste speciali" value={quote.special_requests} />}
          </Section>

          {showArr && (
            <Section title="▼ Arrivo a Ischia">
              {quote.arrival_date && <Row label="Data" value={fmtDate(quote.arrival_date)} />}
              {quote.arrival_time && <Row label="Orario" value={quote.arrival_time.slice(0,5)} />}
              {quote.arrival_flight_train && <Row label="Volo / Treno" value={quote.arrival_flight_train} />}
            </Section>
          )}

          {showDep && (
            <Section title="▲ Partenza da Ischia">
              {quote.departure_date && <Row label="Data" value={fmtDate(quote.departure_date)} />}
              {quote.departure_time && <Row label="Orario" value={quote.departure_time.slice(0,5)} />}
              {quote.departure_flight_train && <Row label="Volo / Treno" value={quote.departure_flight_train} />}
            </Section>
          )}

          <Section title="Prezzo">
            {quoteItems.length === 0 && quote.price_mode !== "total" && <Row label="Per persona" value={fmtEur(quote.price_cents)} />}
            <Row label={quoteItems.length > 0 ? "Totale preventivo" : `Totale (${quote.pax} pax)`} value={fmtEur(totalCents)} bold />
            {quote.price_notes && <Row label="Note" value={quote.price_notes} />}
          </Section>

          {quoteItems.length > 0 && (
            <Section title="Servizi inclusi">
              <div className="space-y-2">
                {quoteItems.map((item, index) => (
                  <div key={index} className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                    <div className="flex justify-between gap-3 text-sm">
                      <span className="font-semibold text-slate-800">
                        {index + 1}. {item.title || (item.item_type === "free_text" ? "Voce libera" : SERVICE_LABELS[item.service_type ?? ""] ?? item.service_type ?? "Servizio")}
                      </span>
                      <span className="font-bold text-blue-900">{fmtEur(item.total_price_cents ?? 0)}</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {[
                        item.description ?? null,
                        item.hotel_name ? `Hotel: ${item.hotel_name}` : null,
                        item.pax != null && item.pax > 0 ? `${item.pax} pax` : null,
                        item.price_mode === "per_person" && item.unit_price_cents != null ? `Per persona: ${fmtEur(item.unit_price_cents)}` : null,
                        item.quantity && item.quantity > 1 ? `Quantita: ${item.quantity}` : null,
                        item.arrival_date ? `Arrivo: ${fmtDate(item.arrival_date)}${item.arrival_time ? ` ${item.arrival_time.slice(0, 5)}` : ""}` : null,
                        item.departure_date ? `Partenza: ${fmtDate(item.departure_date)}${item.departure_time ? ` ${item.departure_time.slice(0, 5)}` : ""}` : null,
                        item.price_notes ?? null,
                      ].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                ))}
              </div>
            </Section>
          )}

          <Section title="Pagamento">
            {quote.iban && <Row label="IBAN" value={quote.iban} mono />}
            {quote.swift_code && <Row label="SWIFT/BIC" value={quote.swift_code} mono />}
            {quote.bank_account_holder && <Row label="Intestatario" value={quote.bank_account_holder} />}
            {quote.payment_instructions && <Row label="Istruzioni" value={quote.payment_instructions} />}
            {quote.payment_reference && <Row label="Riferimento CRO" value={quote.payment_reference} />}
          </Section>

          {quote.email_intro && (
            <Section title="Intro email">
              <p className="py-2 text-sm text-slate-600 italic">{quote.email_intro}</p>
            </Section>
          )}

          <Section title="Note interne">
            <p className="py-2 text-sm text-slate-600">{quote.notes_internal || <span className="text-slate-300 italic">Nessuna</span>}</p>
          </Section>

          <Section title="Cronologia">
            <TRow ts={quote.created_at} label="Preventivo creato" />
            {quote.offer_sent_at && <TRow ts={quote.offer_sent_at} label="Offerta inviata" />}
            {quote.expires_at && <TRow ts={quote.expires_at} label="Scadenza offerta" future />}
            {quote.accepted_at && <TRow ts={quote.accepted_at} label="Accettata dal cliente" />}
            {quote.paid_at && <TRow ts={quote.paid_at} label="Pagamento registrato" />}
            {quote.confirmed_at && <TRow ts={quote.confirmed_at} label="Prenotazione confermata" />}
            {quote.cancelled_at && <TRow ts={quote.cancelled_at} label="Cancellata" />}
          </Section>

          {/* Actions */}
          <div className="space-y-2 pb-8">
            {(quote.status === "draft" || quote.status === "offer_sent") && (
              <button onClick={openPreview}
                className="w-full border border-blue-200 text-blue-700 hover:bg-blue-50 font-medium py-2.5 rounded-xl text-sm">
                👁 Anteprima email
              </button>
            )}
            {(quote.status === "draft" || quote.status === "offer_sent") && (
              <button disabled={!!actionBusy} onClick={() => doAction("send")}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-semibold py-3 rounded-xl">
                {actionBusy === "send" ? "Invio…" : quote.status === "offer_sent" ? "📧 Re-invia offerta" : "📧 Invia offerta email"}
              </button>
            )}
            {(quote.status === "accepted" || quote.status === "offer_sent") && (
              <div className="border border-purple-200 bg-purple-50 rounded-xl p-4 space-y-2">
                <p className="text-sm font-semibold text-purple-800">Registra pagamento</p>
                <input type="text" placeholder="Riferimento / CRO bonifico (opzionale)"
                  value={paymentRef} onChange={e => setPaymentRef(e.target.value)}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white" />
                <button disabled={!!actionBusy}
                  onClick={() => doAction("register-payment", { payment_reference: paymentRef || null })}
                  className="w-full bg-purple-600 hover:bg-purple-700 disabled:opacity-60 text-white font-semibold py-2.5 rounded-xl">
                  {actionBusy === "register-payment" ? "Registrazione…" : "✅ Conferma pagamento ricevuto"}
                </button>
              </div>
            )}
            {isReadOnly && (
              <a href={`/preventivi/new?from=${quote.id}`} target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium py-2.5 rounded-xl text-sm">
                📋 Duplica come nuova offerta ↗
              </a>
            )}
            {!["confirmed", "cancelled"].includes(quote.status) && (
              <button disabled={!!actionBusy}
                onClick={() => { if (confirm("Cancellare questo preventivo?")) doAction("cancel"); }}
                className="w-full border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-60 font-medium py-2.5 rounded-xl text-sm">
                {actionBusy === "cancel" ? "Cancellazione…" : "✕ Cancella preventivo"}
              </button>
            )}
          </div>
        </div>
      </div>

      {previewOpen && (
        <PreviewModal
          quoteNumber={quote.quote_number}
          customerEmail={quote.customer_email}
          html={previewHtml}
          loading={previewLoading}
          lang={previewLang}
          onSwitch={l => loadPreview(l)}
          onClose={() => setPreviewOpen(false)}
          onSend={() => { setPreviewOpen(false); void doAction("send"); }}
          sendBusy={actionBusy === "send"}
          canSend={quote.status === "draft" || quote.status === "offer_sent"}
        />
      )}
    </>
  );

  // ── EDIT mode ──────────────────────────────────────────────────────────────

  const Lk = (field: string) => isLocked(field, quote.status);

  return (
    <>
      <div className="quote-natural-text min-h-screen bg-slate-50">
        <div className="max-w-2xl mx-auto py-8 px-4">
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-xl font-bold text-slate-800">Modifica — {quote.quote_number}</h1>
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_COLORS[quote.status]}`}>
                {STATUS_LABELS[quote.status]}
              </span>
            </div>
            <button onClick={() => { setMode("view"); setForm(quoteToForm(quote)); setSaveError(""); }}
              className="text-sm text-slate-400 hover:text-slate-600">✕ Annulla</button>
          </div>

          {/* Status warnings for edit mode */}
          {quote.status === "offer_sent" && (
            <div className="mb-4 bg-amber-50 border border-amber-200 text-amber-800 text-xs px-4 py-2 rounded-xl">
              ⚠️ Offerta già inviata al cliente. Le modifiche saranno visibili solo se reinvii l&apos;email.
            </div>
          )}
          {quote.status === "accepted" && (
            <div className="mb-4 bg-amber-50 border border-amber-200 text-amber-800 text-xs px-4 py-2 rounded-xl">
              ⚠️ Il cliente ha accettato questa offerta. Il prezzo è bloccato 🔒. Puoi modificare gli altri dettagli.
            </div>
          )}
          {isPartialLock && (
            <div className="mb-4 bg-slate-100 border border-slate-200 text-slate-600 text-xs px-4 py-2 rounded-xl">
              🔒 Prenotazione confermata. Solo le note interne sono modificabili.
            </div>
          )}

          <div className="space-y-4">
            {/* Cliente */}
            <Card title="Cliente">
              <Grid>
                <EF label="Nome *" locked={Lk("customer_first_name")}>
                  <EInput value={form.customer_first_name} onChange={v => sf("customer_first_name", v)} locked={Lk("customer_first_name")} required exactText />
                </EF>
                <EF label="Cognome *" locked={Lk("customer_last_name")}>
                  <EInput value={form.customer_last_name} onChange={v => sf("customer_last_name", v)} locked={Lk("customer_last_name")} required exactText />
                </EF>
                <EF label="Email *" full locked={Lk("customer_email")}>
                  <EInput type="email" value={form.customer_email} onChange={v => sf("customer_email", v)} locked={Lk("customer_email")} required />
                </EF>
                <EF label="Telefono" locked={Lk("customer_phone")}>
                  <EInput value={form.customer_phone} onChange={v => sf("customer_phone", v)} locked={Lk("customer_phone")} />
                </EF>
                <EF label="Lingua email" locked={Lk("customer_language")}>
                  <ESelect value={form.customer_language} onChange={v => sf("customer_language", v)} locked={Lk("customer_language")}
                    options={[{ value:"it", label:"🇮🇹 Italiano" },{ value:"en", label:"🇬🇧 English" }]} />
                </EF>
              </Grid>
              {!isPartialLock && (
                <div className="mt-3 space-y-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={form.is_agency} onChange={e => setForm(f => f ? { ...f, is_agency: e.target.checked, end_customer_name: e.target.checked ? f.end_customer_name : "" } : f)}
                      className="rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                    <span className="text-sm text-slate-700">Preventivo per agenzia</span>
                  </label>
                  {form.is_agency && (
                    <EF label="Nome cliente finale" full locked={false}>
                      <EInput value={form.end_customer_name} onChange={v => sf("end_customer_name", v)} locked={false} placeholder="es. Mario Rossi / Gruppo Smith" />
                    </EF>
                  )}
                </div>
              )}
            </Card>

            {/* Servizio */}
            <Card title="Servizio">
              <Grid>
                <EF label="Tipo *" locked={Lk("service_type")}>
                  <ESelect value={form.service_type} onChange={v => sf("service_type", v)} locked={Lk("service_type")} options={SERVICE_OPTIONS} />
                </EF>
                <EF label="Direzione" locked={Lk("direction")}>
                  <ESelect value={form.direction} onChange={v => sf("direction", v)} locked={Lk("direction")} options={[
                    { value:"arrival", label:"Arrivo" },{ value:"departure", label:"Partenza" },
                    { value:"round_trip", label:"A/R" },{ value:"", label:"Non specificata" },
                  ]} />
                </EF>
                {showArr && <>
                  <EF label="Data arrivo" locked={Lk("arrival_date")}><EInput type="date" value={form.arrival_date} onChange={v => sf("arrival_date", v)} locked={Lk("arrival_date")} /></EF>
                  <EF label="Orario arrivo" locked={Lk("arrival_time")}><EInput type="time" value={form.arrival_time} onChange={v => sf("arrival_time", v)} locked={Lk("arrival_time")} /></EF>
                  <EF label="Volo arrivo" full locked={Lk("arrival_flight_train")}><EInput value={form.arrival_flight_train} onChange={v => sf("arrival_flight_train", v)} locked={Lk("arrival_flight_train")} placeholder="es. LX1712" /></EF>
                </>}
                {showDep && <>
                  <EF label="Data partenza" locked={Lk("departure_date")}><EInput type="date" value={form.departure_date} onChange={v => sf("departure_date", v)} locked={Lk("departure_date")} /></EF>
                  <EF label="Orario partenza" locked={Lk("departure_time")}><EInput type="time" value={form.departure_time} onChange={v => sf("departure_time", v)} locked={Lk("departure_time")} /></EF>
                  <EF label="Volo partenza" full locked={Lk("departure_flight_train")}><EInput value={form.departure_flight_train} onChange={v => sf("departure_flight_train", v)} locked={Lk("departure_flight_train")} placeholder="es. AZ1287" /></EF>
                </>}
                <EF label="Hotel" locked={Lk("hotel_name")}><EInput value={form.hotel_name} onChange={v => sf("hotel_name", v)} locked={Lk("hotel_name")} /></EF>
                <EF label="Indirizzo hotel" locked={Lk("hotel_address")}><EInput value={form.hotel_address} onChange={v => sf("hotel_address", v)} locked={Lk("hotel_address")} /></EF>
                <EF label="Pax *" locked={Lk("pax")}><EInput type="number" value={String(form.pax)} onChange={v => sf("pax", Number(v))} locked={Lk("pax")} required /></EF>
                <EF label="Note bagagli" locked={Lk("luggage_notes")}><EInput value={form.luggage_notes} onChange={v => sf("luggage_notes", v)} locked={Lk("luggage_notes")} /></EF>
                <EF label="Richieste speciali" full locked={Lk("special_requests")}><EInput value={form.special_requests} onChange={v => sf("special_requests", v)} locked={Lk("special_requests")} /></EF>
              </Grid>
            </Card>

            {/* Prezzo */}
            <Card title="Prezzo">
              <Grid>
                <EF label="Modalita prezzo" locked={Lk("price_mode")}>
                  <ESelect value={form.price_mode} onChange={v => sf("price_mode", v)} locked={Lk("price_mode")} options={[
                    { value: "per_person", label: "Per persona" },
                    { value: "total", label: "Totale servizio" },
                  ]} />
                </EF>
                <EF label={`${form.price_mode === "total" ? "Prezzo totale" : "Prezzo/persona"} (€)${Lk("price_euros") ? " 🔒" : " *"}`} locked={Lk("price_euros")}>
                  <EInput type="number" step="0.01" value={form.price_euros} onChange={v => sf("price_euros", v)} locked={Lk("price_euros")} required />
                </EF>
                <EF label={form.price_mode === "total" ? "Totale preventivo" : `Totale (${form.pax} pax)`} locked={true}>
                  <div className="px-3 py-2 border border-slate-100 bg-slate-50 rounded-lg text-sm font-bold text-blue-900">
                    {`€ ${(parseFloat(form.price_euros || "0") * (form.price_mode === "total" ? 1 : form.pax)).toFixed(2)}`}
                  </div>
                </EF>
                <EF label="Note prezzo" full locked={Lk("price_notes")}><EInput value={form.price_notes} onChange={v => sf("price_notes", v)} locked={Lk("price_notes")} /></EF>
              </Grid>
            </Card>

            {/* Servizi extra */}
            {!isPartialLock && (
              <Card title="Servizi extra e voci libere">
                <div className="space-y-3">
                  {form.items.length === 0 && (
                    <p className="text-sm text-slate-400">Aggiungi altri servizi nello stesso preventivo oppure una voce descrittiva libera.</p>
                  )}
                  {form.items.map((item, index) => (
                    <div key={index} className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <ESelect value={item.item_type} onChange={v => updateItem(index, { item_type: v as "service" | "free_text" })} locked={false}
                          options={[{ value: "service", label: "Servizio" }, { value: "free_text", label: "Voce libera" }]} />
                        <button type="button" onClick={() => removeItem(index)} className="shrink-0 text-xs text-red-600 hover:underline">Rimuovi</button>
                      </div>
                      <Grid>
                        <EF label="Titolo" full locked={false}><EInput value={item.title} onChange={v => updateItem(index, { title: v })} locked={false} /></EF>
                        <EF label="Descrizione" full locked={false}>
                          <ETextarea value={item.description} onChange={v => updateItem(index, { description: v })} locked={false} rows={2} />
                        </EF>
                        {item.item_type === "service" && (
                          <>
                            <EF label="Tipo" locked={false}><ESelect value={item.service_type} onChange={v => updateItem(index, { service_type: v })} locked={false} options={SERVICE_OPTIONS} /></EF>
                            <EF label="Direzione" locked={false}>
                              <ESelect value={item.direction} onChange={v => updateItem(index, { direction: v })} locked={false} options={[
                                { value: "", label: "Non specificata" }, { value: "arrival", label: "Arrivo" },
                                { value: "departure", label: "Partenza" }, { value: "round_trip", label: "A/R" },
                              ]} />
                            </EF>
                            <EF label="Data" locked={false}><EInput type="date" value={item.service_date} onChange={v => updateItem(index, { service_date: v })} locked={false} /></EF>
                            <EF label="Orario" locked={false}><EInput type="time" value={item.service_time} onChange={v => updateItem(index, { service_time: v })} locked={false} /></EF>
                            <EF label="Hotel" locked={false}><EInput value={item.hotel_name} onChange={v => updateItem(index, { hotel_name: v })} locked={false} /></EF>
                            <EF label="Pax" locked={false}><EInput type="number" value={String(item.pax)} onChange={v => updateItem(index, { pax: Number(v) })} locked={false} /></EF>
                          </>
                        )}
                        {item.item_type === "free_text" && (
                          <EF label="Quantita" locked={false}><EInput type="number" value={String(item.quantity)} onChange={v => updateItem(index, { quantity: Number(v) })} locked={false} /></EF>
                        )}
                        <EF label="Modalita prezzo" locked={false}>
                          <ESelect value={item.price_mode} onChange={v => updateItem(index, { price_mode: v as "per_person" | "total" })} locked={false} options={[
                            { value: "per_person", label: item.item_type === "service" ? "Per persona" : "Per quantita" },
                            { value: "total", label: "Totale voce" },
                          ]} />
                        </EF>
                        <EF label={item.price_mode === "total" ? "Prezzo totale" : item.item_type === "service" ? "Prezzo per pax" : "Prezzo unitario"} locked={false}>
                          <EInput type="number" step="0.01" value={item.price_euros} onChange={v => updateItem(index, { price_euros: v })} locked={false} />
                        </EF>
                        <EF label="Note prezzo" full locked={false}><EInput value={item.price_notes} onChange={v => updateItem(index, { price_notes: v })} locked={false} /></EF>
                      </Grid>
                    </div>
                  ))}
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => addItem("service")} className="text-sm px-3 py-2 rounded-lg border border-blue-200 text-blue-700 hover:bg-blue-50">+ Servizio</button>
                    <button type="button" onClick={() => addItem("free_text")} className="text-sm px-3 py-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50">+ Voce libera</button>
                  </div>
                </div>
              </Card>
            )}

            {/* Email */}
            <Card title="Email offerta">
              <Grid>
                <EF label="Intro personalizzata" full locked={Lk("email_intro")}>
                  <ETextarea value={form.email_intro} onChange={v => sf("email_intro", v)} locked={Lk("email_intro")} rows={3} />
                </EF>
                <EF label="IBAN" locked={Lk("iban")}><EInput value={form.iban} onChange={v => sf("iban", v)} locked={Lk("iban")} /></EF>
                <EF label="SWIFT/BIC" locked={Lk("swift_code")}><EInput value={form.swift_code} onChange={v => sf("swift_code", v)} locked={Lk("swift_code")} placeholder="es. BCITITMM" /></EF>
                <EF label="Intestatario conto" locked={Lk("bank_account_holder")}><EInput value={form.bank_account_holder} onChange={v => sf("bank_account_holder", v)} locked={Lk("bank_account_holder")} /></EF>
                <EF label="Istruzioni pagamento" full locked={Lk("payment_instructions")}>
                  <ETextarea value={form.payment_instructions} onChange={v => sf("payment_instructions", v)} locked={Lk("payment_instructions")} rows={2} />
                </EF>
              </Grid>
              {!isPartialLock && (
                <div className="flex gap-2 mt-3">
                  <button type="button" onClick={() => { void handleSave(false); setTimeout(() => void loadPreview("it"), 800); }}
                    className="text-xs px-3 py-1.5 border border-blue-200 rounded-lg text-blue-700 hover:bg-blue-50">
                    👁 Anteprima 🇮🇹
                  </button>
                  <button type="button" onClick={() => { void handleSave(false); setTimeout(() => void loadPreview("en"), 800); }}
                    className="text-xs px-3 py-1.5 border border-blue-200 rounded-lg text-blue-700 hover:bg-blue-50">
                    👁 Preview 🇬🇧
                  </button>
                </div>
              )}
            </Card>

            {/* Note interne — sempre modificabili */}
            <Card title="Note interne">
              <EF label="Note (non visibili al cliente)" locked={false}>
                <ETextarea value={form.notes_internal} onChange={v => sf("notes_internal", v)} locked={false} rows={2} />
              </EF>
            </Card>

            {saveError && <p className="text-red-600 text-sm bg-red-50 border border-red-200 px-4 py-2 rounded-xl">{saveError}</p>}

            {/* Save buttons */}
            <div className="flex flex-col gap-2 pb-8">
              <button disabled={saving} onClick={() => handleSave(false)}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-semibold py-3 rounded-xl">
                {saving ? "Salvataggio…" : "Salva modifiche"}
              </button>
              {(quote.status === "draft" || quote.status === "offer_sent") && (
                <button disabled={saving} onClick={() => handleSave(true)}
                  className="w-full bg-green-600 hover:bg-green-700 disabled:opacity-60 text-white font-semibold py-3 rounded-xl">
                  {saving ? "Salvataggio…" : "Salva e re-invia email"}
                </button>
              )}
              <button onClick={() => { setMode("view"); setForm(quoteToForm(quote)); setSaveError(""); }}
                className="w-full border border-slate-200 text-slate-600 hover:bg-slate-50 py-2.5 rounded-xl text-sm">
                Annulla
              </button>
            </div>
          </div>
        </div>
      </div>

      {previewOpen && (
        <PreviewModal
          quoteNumber={quote.quote_number}
          customerEmail={form.customer_email}
          html={previewHtml}
          loading={previewLoading}
          lang={previewLang}
          onSwitch={l => loadPreview(l)}
          onClose={() => setPreviewOpen(false)}
          onSend={() => { setPreviewOpen(false); void doAction("send"); }}
          sendBusy={actionBusy === "send"}
          canSend={quote.status === "draft" || quote.status === "offer_sent"}
        />
      )}
    </>
  );
}

// ── Preview modal ─────────────────────────────────────────────────────────────

function PreviewModal({ quoteNumber, customerEmail, html, loading, lang, onSwitch, onClose, onSend, sendBusy, canSend }: {
  quoteNumber: string; customerEmail: string; html: string; loading: boolean; lang: "it"|"en";
  onSwitch: (l: "it"|"en") => void; onClose: () => void;
  onSend: () => void; sendBusy: boolean; canSend: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 shrink-0">
          <div>
            <h3 className="font-bold text-slate-800">Anteprima email — {quoteNumber}</h3>
            <p className="text-xs text-slate-400">A: {customerEmail}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-semibold">
              <button onClick={() => onSwitch("it")} className={`px-3 py-1.5 ${lang==="it" ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>🇮🇹 IT</button>
              <button onClick={() => onSwitch("en")} className={`px-3 py-1.5 ${lang==="en" ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>🇬🇧 EN</button>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl ml-1">✕</button>
          </div>
        </div>
        <div className="flex-1 overflow-hidden p-4">
          {loading
            ? <div className="flex items-center justify-center h-full text-slate-400">Caricamento anteprima…</div>
            : html
              ? <iframe srcDoc={html} className="w-full h-full rounded-xl border border-slate-100" sandbox="allow-same-origin" title="Anteprima email" />
              : <div className="flex items-center justify-center h-full text-slate-400">Anteprima non disponibile.</div>}
        </div>
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-slate-100 shrink-0">
          <button onClick={onClose} className="px-4 py-2 border border-slate-200 rounded-xl text-slate-600 hover:bg-slate-50 text-sm">Chiudi</button>
          {canSend && (
            <button disabled={sendBusy} onClick={onSend}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-semibold px-5 py-2.5 rounded-xl text-sm">
              {sendBusy ? "Invio…" : "✉️ Invia email ora"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Shared components ─────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5">
      <h2 className="text-[10px] font-bold text-blue-900 uppercase tracking-wider mb-3">{title}</h2>
      {children}
    </div>
  );
}
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5">
      <h2 className="text-xs font-bold text-blue-900 uppercase tracking-wider mb-4">{title}</h2>
      {children}
    </div>
  );
}
function Grid({ children }: { children: React.ReactNode }) { return <div className="grid grid-cols-2 gap-3">{children}</div>; }
function Row({ label, value, mono = false, bold = false }: { label: string; value: string; mono?: boolean; bold?: boolean }) {
  return (
    <div className="flex justify-between gap-4 py-2 border-b border-slate-100 last:border-0 text-sm">
      <span className="text-slate-500 shrink-0">{label}</span>
      <span className={`text-right ${mono ? "font-mono text-slate-700" : bold ? "font-bold text-blue-900" : "font-medium text-slate-800"}`}>{value}</span>
    </div>
  );
}
function TRow({ ts, label, future = false }: { ts: string; label: string; future?: boolean }) {
  return (
    <div className="flex gap-3 py-2 border-b border-slate-100 last:border-0 text-sm items-start">
      <span className={`shrink-0 text-xs mt-0.5 tabular-nums ${future ? "text-orange-500" : "text-slate-400"}`}>{fmtDatetime(ts)}</span>
      <span className={future ? "text-orange-700" : "text-slate-700"}>{label}</span>
    </div>
  );
}

// Edit form components
function EF({ label, children, full = false, locked }: { label: string; children: React.ReactNode; full?: boolean; locked: boolean }) {
  return (
    <div className={full ? "col-span-2" : ""}>
      <label className="block text-xs font-medium text-slate-500 mb-1">
        {label} {locked && <span className="text-slate-300">🔒</span>}
      </label>
      {children}
    </div>
  );
}
function EInput({ value, onChange, type = "text", required = false, locked, placeholder = "", step, exactText = false }: {
  value: string; onChange?: (v: string) => void; type?: string; required?: boolean; locked: boolean; placeholder?: string; step?: string; exactText?: boolean;
}) {
  return (
    <input type={type} value={value} onChange={e => !locked && onChange?.(e.target.value)}
      required={required} placeholder={placeholder} step={step} readOnly={locked}
      autoCapitalize={type === "text" || exactText ? "none" : undefined}
      autoCorrect={type === "text" || exactText ? "off" : undefined}
      spellCheck={type === "text" || exactText ? false : undefined}
      className={`w-full normal-case border rounded-lg px-3 py-2 text-sm focus:outline-none ${locked ? "border-slate-100 bg-slate-50 text-slate-400 cursor-not-allowed" : "border-slate-200 focus:ring-1 focus:ring-blue-400"}`} />
  );
}
function ESelect({ value, onChange, options, locked }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; locked: boolean;
}) {
  if (locked) return <div className="px-3 py-2 border border-slate-100 bg-slate-50 rounded-lg text-sm text-slate-400">{options.find(o => o.value === value)?.label ?? value}</div>;
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-blue-400">
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
function ETextarea({ value, onChange, locked, rows = 3 }: {
  value: string; onChange?: (v: string) => void; locked: boolean; rows?: number;
}) {
  return (
    <textarea value={value} onChange={e => !locked && onChange?.(e.target.value)}
      rows={rows} readOnly={locked}
      autoCapitalize="none" autoCorrect="off" spellCheck={false}
      className={`w-full normal-case border rounded-lg px-3 py-2 text-sm resize-none focus:outline-none ${locked ? "border-slate-100 bg-slate-50 text-slate-400 cursor-not-allowed" : "border-slate-200 focus:ring-1 focus:ring-blue-400"}`} />
  );
}
