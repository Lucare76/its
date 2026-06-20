"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import { getToken } from "@/lib/supabase/client";

// ── Types ─────────────────────────────────────────────────────────────────────

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
  price_notes: string;
  email_intro: string;
  iban: string;
  swift_code: string;
  bank_account_holder: string;
  payment_instructions: string;
  notes_internal: string;
  items: QuoteItemForm[];
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
  price_notes: string;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const EMPTY_FORM: FormData = {
  customer_first_name: "", customer_last_name: "", customer_email: "",
  customer_phone: "", customer_language: "it",
  service_type: "transfer_airport", direction: "arrival",
  arrival_date: "", arrival_time: "", arrival_flight_train: "",
  departure_date: "", departure_time: "", departure_flight_train: "",
  hotel_name: "", hotel_address: "",
  pax: 1, luggage_notes: "", special_requests: "",
  price_euros: "", price_notes: "",
  email_intro: "", iban: "", swift_code: "", bank_account_holder: "", payment_instructions: "", notes_internal: "",
  items: [],
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

// ── Import helpers ─────────────────────────────────────────────────────────────

type ImportResult = {
  customer_first_name?: string;
  customer_last_name?: string;
  customer_phone?: string;
  hotel_name?: string;
  arrival_date?: string;
  arrival_time?: string;
  arrival_flight_train?: string;
  departure_date?: string;
  departure_time?: string;
  departure_flight_train?: string;
  pax?: number;
  customer_language?: "it" | "en";
  direction?: string;
};

const IT_MONTHS: Record<string, number> = {
  gennaio:1, febbraio:2, marzo:3, aprile:4, maggio:5, giugno:6,
  luglio:7, agosto:8, settembre:9, ottobre:10, novembre:11, dicembre:12,
};
const EN_MONTHS: Record<string, number> = {
  january:1, february:2, march:3, april:4, may:5, june:6,
  july:7, august:8, september:9, october:10, november:11, december:12,
  jan:1, feb:2, mar:3, apr:4, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
};

function toTitleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function parseDate(text: string): { date: string; label: string } | null {
  const year = new Date().getFullYear();

  // Italian: "15 maggio 2026" or "15 maggio"
  const itMatch = text.match(/(\d{1,2})\.?\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)(?:\s+(\d{4}))?/i);
  if (itMatch) {
    const d = itMatch[1].padStart(2, "0");
    const m = String(IT_MONTHS[itMatch[2].toLowerCase()]).padStart(2, "0");
    const y = itMatch[3] ?? String(year);
    return { date: `${y}-${m}-${d}`, label: `${d}/${m}` };
  }
  // English: "12. JUNE" or "May 15" or "15 May 2026"
  const enMatch = text.match(/(?:(\d{1,2})\.?\s+)?(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\.?\s*(\d{1,2})?(?:\s+(\d{4}))?/i);
  if (enMatch) {
    const day = (enMatch[1] ?? enMatch[3] ?? "1").padStart(2, "0");
    const mon = String(EN_MONTHS[enMatch[2].toLowerCase()]).padStart(2, "0");
    const y   = enMatch[4] ?? String(year);
    return { date: `${y}-${mon}-${day}`, label: `${day}/${mon}` };
  }
  // Numeric with / or - : "15/05", "15/05/2026", "15-05-2026"
  const slashMatch = text.match(/(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?/);
  if (slashMatch) {
    const dayN = parseInt(slashMatch[1]);
    const monN = parseInt(slashMatch[2]);
    if (monN < 1 || monN > 12 || dayN < 1 || dayN > 31) return null;
    const d = String(dayN).padStart(2, "0");
    const m = String(monN).padStart(2, "0");
    const y = slashMatch[3] ? (slashMatch[3].length === 2 ? `20${slashMatch[3]}` : slashMatch[3]) : String(year);
    return { date: `${y}-${m}-${d}`, label: `${d}/${m}` };
  }
  // Numeric with . ONLY when year is present: "15.05.2026" — avoids confusing HH.MM times like "17.10"
  const dotMatch = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (dotMatch) {
    const dayN = parseInt(dotMatch[1]);
    const monN = parseInt(dotMatch[2]);
    if (monN < 1 || monN > 12 || dayN < 1 || dayN > 31) return null;
    const d = String(dayN).padStart(2, "0");
    const m = String(monN).padStart(2, "0");
    const y = dotMatch[3].length === 2 ? `20${dotMatch[3]}` : dotMatch[3];
    return { date: `${y}-${m}-${d}`, label: `${d}/${m}` };
  }
  return null;
}

function extractFromText(text: string): ImportResult {
  const result: ImportResult = {};
  const lower = text.toLowerCase();

  // Language detection
  const itWords = ["sono", "siamo", "arrivo", "partenza", "grazie", "vorrei", "prenotare", "porto", "aeroporto"];
  const enWords = ["arrive", "depart", "flight", "hotel", "thank", "book", "we are", "i am", "please"];
  const itScore = itWords.filter(w => lower.includes(w)).length;
  const enScore = enWords.filter(w => lower.includes(w)).length;
  result.customer_language = enScore > itScore ? "en" : "it";

  // Name: greeting pattern or ALL-CAPS or title-case lines
  const nameMatch = text.match(/(?:grazie|thanks?|regards?|saluti|cordiali\s+saluti|sinceramente),?\s*\n?\s*([A-ZÀÈÌÒÙ][A-ZÀÈÌÒÙa-zàèìòù]+(?:[-\s][A-ZÀÈÌÒÙ][A-ZÀÈÌÒÙa-zàèìòù]+)*)\s+([A-ZÀÈÌÒÙ][A-ZÀÈÌÒÙa-zàèìòù]+)/);
  if (nameMatch) {
    result.customer_first_name = toTitleCase(nameMatch[1]);
    result.customer_last_name = toTitleCase(nameMatch[2]);
  } else {
    // Scan last 3 non-empty lines for a name (title-case or ALL CAPS)
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
      const line = lines[i];
      const titleMatch = line.match(/^([A-ZÀÈÌÒÙ][a-zàèìòù]+)\s+([A-ZÀÈÌÒÙ][a-zàèìòù]+)$/);
      if (titleMatch) { result.customer_first_name = titleMatch[1]; result.customer_last_name = titleMatch[2]; break; }
      const capsMatch = line.match(/^([A-ZÀÈÌÒÙ]{2,})\s+([A-ZÀÈÌÒÙ]{2,})$/);
      if (capsMatch) { result.customer_first_name = toTitleCase(capsMatch[1]); result.customer_last_name = toTitleCase(capsMatch[2]); break; }
    }
  }

  // Phone: "+49 172 5404319", "+391234567890"
  const phoneMatch = text.match(/\+?[\d][\d\s\-]{8,14}\d/);
  if (phoneMatch) result.customer_phone = phoneMatch[0].replace(/[\s\-]/g, "");

  // Flight: "LX1712", "AZ 1287", "W4 3555" (2-char code including letter+digit like W4, FR, AZ)
  const flights = [...text.matchAll(/\b([A-Z][A-Z0-9])\s?(\d{3,4})\b/g)].map(m => `${m[1]}${m[2]}`);

  // Times: "10:30", "12:55", "16.40", "17.10" (colon or period separator)
  const times = [...text.matchAll(/\b(\d{1,2})[:.h](\d{2})\b/g)]
    .map(m => ({ str: `${m[1].padStart(2,"0")}:${m[2]}`, h: parseInt(m[1]), min: parseInt(m[2]) }))
    .filter(t => t.h <= 23 && t.min <= 59)
    .map(t => t.str);

  // Dates: collect all parsed dates from text
  const dateMatches: Array<{ date: string; index: number }> = [];
  const datePatterns = [
    /\d{1,2}\.?\s+(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)(?:\s+\d{4})?/gi,
    /(?:\d{1,2}\.?\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\.?\s*\d{1,2}?(?:\s+\d{4})?/gi,
    /\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?/g,
  ];
  for (const pat of datePatterns) {
    let m: RegExpExecArray | null;
    while ((m = pat.exec(text)) !== null) {
      const parsed = parseDate(m[0]);
      if (parsed) dateMatches.push({ date: parsed.date, index: m.index });
    }
  }
  dateMatches.sort((a, b) => a.index - b.index);

  // Pax
  const paxPatterns = [
    /(?:siam[oi] in|in|per)\s+(\d+)\s*(?:person[ae]|pax|persone|passeggeri)?/i,
    /(\d+)\s+(?:person[ae]|passeggeri|adulti|persone|pax)/i,
    /(?:we are|there are|party of|group of)\s+(\d+)/i,
  ];
  for (const pat of paxPatterns) {
    const m = text.match(pat);
    if (m) { result.pax = parseInt(m[1], 10); break; }
  }

  // Hotel
  const hotelMatch = text.match(/(?:hotel|resort|villa|b&b|albergo)\s+([A-Z][^\n,\.]{2,40})/i);
  if (hotelMatch) result.hotel_name = hotelMatch[1].trim();

  // Direction + date/time/flight assignment
  const hasArrival   = /arriv[ao]|arriv[ei]|in arrivo|arriving|arrival/i.test(text);
  const hasDeparture = /part[ei]nz[ao]|rientro|rit[oi]rn[ao]|depart|leaving|departure|return/i.test(text);

  if (hasArrival && hasDeparture) {
    result.direction = "round_trip";
    // First date/time = arrival, second = departure
    if (dateMatches[0]) result.arrival_date = dateMatches[0].date;
    if (dateMatches[1]) result.departure_date = dateMatches[1].date;
    if (times[0]) result.arrival_time = times[0];
    if (times[1]) result.departure_time = times[1];
    if (flights[0]) result.arrival_flight_train = flights[0];
    if (flights[1]) result.departure_flight_train = flights[1];
  } else if (hasDeparture) {
    result.direction = "departure";
    if (dateMatches[0]) result.departure_date = dateMatches[0].date;
    if (times[0]) result.departure_time = times[0];
    if (flights[0]) result.departure_flight_train = flights[0];
  } else {
    result.direction = "arrival";
    if (dateMatches[0]) result.arrival_date = dateMatches[0].date;
    if (times[0]) result.arrival_time = times[0];
    if (flights[0]) result.arrival_flight_train = flights[0];
  }

  return result;
}

// ── Main component (wrapped in Suspense for useSearchParams) ──────────────────

export default function NewPreventivePage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-screen text-slate-400">Caricamento…</div>}>
      <NewPreventiveInner />
    </Suspense>
  );
}

function NewPreventiveInner() {
  const router   = useRouter();
  const searchParams = useSearchParams();
  const fromId   = searchParams.get("from"); // duplicate from existing

  const [form, setForm]       = useState<FormData>(EMPTY_FORM);
  const [saving, setSaving]   = useState(false);
  const [formError, setFormError] = useState("");

  const [previewOpen, setPreviewOpen]     = useState(false);
  const [previewLang, setPreviewLang]     = useState<"it"|"en">("it");
  const [previewHtml, setPreviewHtml]     = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);

  const [importOpen, setImportOpen]       = useState(false);
  const [importText, setImportText]       = useState("");
  const [importResult, setImportResult]   = useState<ImportResult | null>(null);

  // Load tenant payment defaults (only when NOT duplicating)
  useEffect(() => {
    if (fromId) return;
    (async () => {
      const token = await getToken();
      if (!token) return;
      const res = await fetch("/api/ops/tenant-quote-settings", { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json() as { ok?: boolean; iban?: string | null; swift_code?: string | null; bank_account_holder?: string | null; payment_instructions?: string | null };
      if (!body.ok) return;
      setForm(f => ({
        ...f,
        ...(body.iban                 ? { iban:                 body.iban! }                 : {}),
        ...(body.swift_code           ? { swift_code:           body.swift_code! }           : {}),
        ...(body.bank_account_holder  ? { bank_account_holder:  body.bank_account_holder! }  : {}),
        ...(body.payment_instructions ? { payment_instructions: body.payment_instructions! } : {}),
      }));
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load source quote if duplicating
  useEffect(() => {
    if (!fromId) return;
    (async () => {
      const token = await getToken();
      if (!token) return;
      const res = await fetch(`/api/ops/service-quotes/${fromId}`, { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json() as { ok?: boolean; quote?: Record<string, unknown> };
      if (!body.ok || !body.quote) return;
      const q = body.quote;
      setForm({
        customer_first_name: String(q.customer_first_name ?? ""),
        customer_last_name:  String(q.customer_last_name ?? ""),
        customer_email:      String(q.customer_email ?? ""),
        customer_phone:      String(q.customer_phone ?? ""),
        customer_language:   (q.customer_language as "it"|"en") ?? "it",
        service_type:        String(q.service_type ?? "transfer_airport"),
        direction:           String(q.direction ?? "arrival"),
        arrival_date:        String(q.arrival_date ?? ""),
        arrival_time:        String((q.arrival_time as string | null)?.slice(0,5) ?? ""),
        arrival_flight_train: String(q.arrival_flight_train ?? ""),
        departure_date:      String(q.departure_date ?? ""),
        departure_time:      String((q.departure_time as string | null)?.slice(0,5) ?? ""),
        departure_flight_train: String(q.departure_flight_train ?? ""),
        hotel_name:          String(q.hotel_name ?? ""),
        hotel_address:       String(q.hotel_address ?? ""),
        pax:                 Number(q.pax ?? 1),
        luggage_notes:       String(q.luggage_notes ?? ""),
        special_requests:    String(q.special_requests ?? ""),
        price_euros:         q.price_cents ? String(Number(q.price_cents) / 100) : "",
        price_notes:         String(q.price_notes ?? ""),
        email_intro:         String(q.email_intro ?? ""),
        iban:                String(q.iban ?? ""),
        swift_code:          String(q.swift_code ?? ""),
        bank_account_holder: String(q.bank_account_holder ?? ""),
        payment_instructions: String(q.payment_instructions ?? ""),
        notes_internal:      "",
        items:               Array.isArray(q.items) ? (q.items as Array<Record<string, unknown>>).slice(1).map((item) => ({
          item_type: item.item_type === "free_text" ? "free_text" : "service",
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
          price_notes: String(item.price_notes ?? ""),
        })) : [],
      });
    })();
  }, [fromId]);

  function sf(field: keyof FormData, value: string | number) {
    setForm(f => ({ ...f, [field]: value }));
  }

  function updateItem(index: number, patch: Partial<QuoteItemForm>) {
    setForm(f => ({ ...f, items: f.items.map((item, i) => i === index ? { ...item, ...patch } : item) }));
  }

  function addItem(item_type: "service" | "free_text") {
    setForm(f => ({
      ...f,
      items: [
        ...f.items,
        {
          item_type,
          title: item_type === "service" ? "Servizio aggiuntivo" : "Voce libera",
          description: "",
          service_type: "custom",
          direction: "",
          service_date: "",
          service_time: "",
          hotel_name: "",
          pax: item_type === "service" ? f.pax : 0,
          quantity: 1,
          price_euros: "",
          price_notes: "",
        },
      ],
    }));
  }

  function removeItem(index: number) {
    setForm(f => ({ ...f, items: f.items.filter((_, i) => i !== index) }));
  }

  function itemPriceCents(value: string) {
    return Math.round(parseFloat(value) * 100) || 0;
  }

  function buildQuoteItems(priceCents: number) {
    return [
      {
        item_type: "service" as const,
        service_type: form.service_type,
        direction: form.direction || null,
        arrival_date: form.arrival_date || null,
        arrival_time: form.arrival_time || null,
        arrival_flight_train: form.arrival_flight_train || null,
        departure_date: form.departure_date || null,
        departure_time: form.departure_time || null,
        departure_flight_train: form.departure_flight_train || null,
        hotel_name: form.hotel_name || null,
        hotel_address: form.hotel_address || null,
        pax: form.pax,
        quantity: 1,
        luggage_notes: form.luggage_notes || null,
        special_requests: form.special_requests || null,
        unit_price_cents: priceCents,
        total_price_cents: priceCents * form.pax,
        price_notes: form.price_notes || null,
      },
      ...form.items.map((item) => {
        const cents = itemPriceCents(item.price_euros);
        return {
          item_type: item.item_type,
          title: item.title || null,
          description: item.description || null,
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
          total_price_cents: item.item_type === "service" ? cents * Math.max(item.pax, 1) : cents * Math.max(item.quantity, 1),
          price_notes: item.price_notes || null,
        };
      }),
    ];
  }

  const showArr = form.direction === "arrival"   || form.direction === "round_trip";
  const showDep = form.direction === "departure" || form.direction === "round_trip";

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError("");
    const token = await getToken();
    if (!token) { setFormError("Non autenticato."); setSaving(false); return; }

    const priceCents = Math.round(parseFloat(form.price_euros) * 100) || 0;
    if (!priceCents) { setFormError("Inserisci un prezzo valido."); setSaving(false); return; }

    const payload = {
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
      price_cents:         priceCents,
      price_notes:         form.price_notes || null,
      email_intro:         form.email_intro || null,
      iban:                form.iban || null,
      swift_code:          form.swift_code || null,
      bank_account_holder: form.bank_account_holder || null,
      payment_instructions: form.payment_instructions || null,
      notes_internal:      form.notes_internal || null,
      items:               buildQuoteItems(priceCents),
    };

    const res = await fetch("/api/ops/service-quotes", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json() as { ok?: boolean; error?: string; quote?: { id: string } };
    if (!body.ok) { setFormError(body.error ?? "Errore creazione."); setSaving(false); return; }
    router.push(`/preventivi/${body.quote!.id}`);
  }

  async function openPreview(lang: "it"|"en") {
    setPreviewOpen(true);
    setPreviewLang(lang);
    setPreviewLoading(true);
    setPreviewHtml("");
    // Build fake data from form for preview — we save first as draft to get an ID
    // Alternative: just show a "save first" message
    // For simplicity, we show a form-based preview using the dedicated endpoint
    const token = await getToken();
    if (!token) { setPreviewLoading(false); return; }

    // POST to save a temp draft silently, preview, delete is complex.
    // Better: POST to preview-email endpoint with form data
    const priceCents = Math.round(parseFloat(form.price_euros) * 100) || 0;
    const previewItems = buildQuoteItems(priceCents);
    const res = await fetch("/api/ops/service-quotes/preview-email", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteNumber: "ANTEPRIMA",
        customerFirstName: form.customer_first_name || "[Nome]",
        customerLastName:  form.customer_last_name  || "[Cognome]",
        customerEmail:     form.customer_email       || "cliente@email.com",
        customerLanguage:  lang,
        serviceType:       form.service_type,
        direction:         form.direction || null,
        arrivalDate:       form.arrival_date || null,
        arrivalTime:       form.arrival_time || null,
        arrivalFlightTrain: form.arrival_flight_train || null,
        departureDate:     form.departure_date || null,
        departureTime:     form.departure_time || null,
        departureFlightTrain: form.departure_flight_train || null,
        hotelName:         form.hotel_name || null,
        hotelAddress:      form.hotel_address || null,
        pax:               form.pax,
        luggageNotes:      form.luggage_notes || null,
        specialRequests:   form.special_requests || null,
        priceCents,
        currency:          "EUR",
        priceNotes:        form.price_notes || null,
        emailIntro:        form.email_intro || null,
        iban:              form.iban || null,
        swiftCode:         form.swift_code || null,
        bankAccountHolder: form.bank_account_holder || null,
        paymentInstructions: form.payment_instructions || null,
        expiresAt:         null,
        acceptUrl:         "#[link-accettazione]",
        companyPhone:      null,
        companyWhatsapp:   null,
        items:             previewItems,
        totalPriceCents:   previewItems.reduce((sum, item) => sum + item.total_price_cents, 0),
      }),
    });
    const data = await res.json() as { ok?: boolean; html?: string };
    if (data.ok && data.html) setPreviewHtml(data.html);
    setPreviewLoading(false);
  }

  function doExtract() {
    const result = extractFromText(importText);
    setImportResult(result);
  }

  function applyImport() {
    if (!importResult) return;
    setForm(f => ({
      ...f,
      ...(importResult.customer_first_name ? { customer_first_name: importResult.customer_first_name } : {}),
      ...(importResult.customer_last_name  ? { customer_last_name:  importResult.customer_last_name }  : {}),
      ...(importResult.customer_phone      ? { customer_phone:      importResult.customer_phone }      : {}),
      ...(importResult.customer_language   ? { customer_language:   importResult.customer_language }   : {}),
      ...(importResult.hotel_name          ? { hotel_name:          importResult.hotel_name }          : {}),
      ...(importResult.direction           ? { direction:           importResult.direction }           : {}),
      ...(importResult.arrival_date        ? { arrival_date:        importResult.arrival_date }        : {}),
      ...(importResult.arrival_time        ? { arrival_time:        importResult.arrival_time }        : {}),
      ...(importResult.arrival_flight_train ? { arrival_flight_train: importResult.arrival_flight_train } : {}),
      ...(importResult.departure_date       ? { departure_date:      importResult.departure_date }      : {}),
      ...(importResult.departure_time       ? { departure_time:      importResult.departure_time }      : {}),
      ...(importResult.departure_flight_train ? { departure_flight_train: importResult.departure_flight_train } : {}),
      ...(importResult.pax                 ? { pax:                 importResult.pax }                 : {}),
    }));
    setImportOpen(false);
    setImportText("");
    setImportResult(null);
  }

  return (
    <>
      <div className="min-h-screen bg-slate-50">
        <div className="max-w-2xl mx-auto py-8 px-4">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-xl font-bold text-slate-800">
                {fromId ? "Duplica preventivo" : "Nuovo preventivo"}
              </h1>
              <p className="text-sm text-slate-400 mt-0.5">Compila i dati del cliente e del servizio</p>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setImportOpen(true)}
                className="flex items-center gap-1.5 text-sm px-3 py-2 border border-slate-200 rounded-xl text-slate-600 hover:bg-white">
                📋 Importa da testo
              </button>
              <Link href="/preventivi" className="text-sm text-slate-400 hover:text-slate-600">← Lista</Link>
            </div>
          </div>

          <form onSubmit={handleSave} className="space-y-4">
            {/* Cliente */}
            <Card title="Cliente">
              <Grid>
                <Field label="Nome *"><Input value={form.customer_first_name} onChange={v => sf("customer_first_name", v)} required /></Field>
                <Field label="Cognome *"><Input value={form.customer_last_name} onChange={v => sf("customer_last_name", v)} required /></Field>
                <Field label="Email *" full><Input type="email" value={form.customer_email} onChange={v => sf("customer_email", v)} required /></Field>
                <Field label="Telefono"><Input value={form.customer_phone} onChange={v => sf("customer_phone", v)} /></Field>
                <Field label="Lingua email">
                  <Select value={form.customer_language} onChange={v => sf("customer_language", v)}
                    options={[{ value:"it", label:"🇮🇹 Italiano" },{ value:"en", label:"🇬🇧 English" }]} />
                </Field>
              </Grid>
            </Card>

            {/* Servizio */}
            <Card title="Servizio">
              <Grid>
                <Field label="Tipo *">
                  <Select value={form.service_type} onChange={v => sf("service_type", v)} options={SERVICE_OPTIONS} />
                </Field>
                <Field label="Direzione">
                  <Select value={form.direction} onChange={v => sf("direction", v)} options={[
                    { value:"arrival",    label:"Arrivo" },
                    { value:"departure",  label:"Partenza" },
                    { value:"round_trip", label:"Andata e Ritorno" },
                    { value:"",          label:"Non specificata" },
                  ]} />
                </Field>
                {showArr && <>
                  <Field label="Data arrivo"><Input type="date" value={form.arrival_date} onChange={v => sf("arrival_date", v)} /></Field>
                  <Field label="Orario arrivo"><Input type="time" value={form.arrival_time} onChange={v => sf("arrival_time", v)} /></Field>
                  <Field label="Volo / Treno arrivo" full><Input value={form.arrival_flight_train} onChange={v => sf("arrival_flight_train", v)} placeholder="es. LX1712" /></Field>
                </>}
                {showDep && <>
                  <Field label="Data partenza"><Input type="date" value={form.departure_date} onChange={v => sf("departure_date", v)} /></Field>
                  <Field label="Orario partenza"><Input type="time" value={form.departure_time} onChange={v => sf("departure_time", v)} /></Field>
                  <Field label="Volo / Treno partenza" full><Input value={form.departure_flight_train} onChange={v => sf("departure_flight_train", v)} placeholder="es. AZ1287" /></Field>
                </>}
                <Field label="Hotel"><Input value={form.hotel_name} onChange={v => sf("hotel_name", v)} /></Field>
                <Field label="Indirizzo hotel"><Input value={form.hotel_address} onChange={v => sf("hotel_address", v)} /></Field>
                <Field label="N° passeggeri *"><Input type="number" value={String(form.pax)} onChange={v => sf("pax", Number(v))} required /></Field>
                <Field label="Note bagagli"><Input value={form.luggage_notes} onChange={v => sf("luggage_notes", v)} /></Field>
                <Field label="Richieste speciali" full><Input value={form.special_requests} onChange={v => sf("special_requests", v)} /></Field>
              </Grid>
            </Card>

            {/* Prezzo */}
            <Card title="Prezzo">
              <Grid>
                <Field label="Prezzo per persona (€) *">
                  <Input type="number" step="0.01" value={form.price_euros} onChange={v => sf("price_euros", v)} required placeholder="es. 45.00" />
                </Field>
                <Field label={`Totale (${form.pax} pax)`}>
                  <div className="px-3 py-2 border border-slate-100 bg-slate-50 rounded-lg text-sm font-bold text-blue-900">
                    {form.price_euros
                      ? `€ ${(parseFloat(form.price_euros || "0") * form.pax).toFixed(2)}`
                      : "—"}
                  </div>
                </Field>
                <Field label="Note prezzo" full><Input value={form.price_notes} onChange={v => sf("price_notes", v)} /></Field>
              </Grid>
            </Card>

            <Card title="Servizi extra e voci libere">
              <div className="space-y-3">
                {form.items.length === 0 && (
                  <p className="text-sm text-slate-400">Aggiungi altri servizi nello stesso preventivo oppure una voce descrittiva libera.</p>
                )}
                {form.items.map((item, index) => (
                  <div key={index} className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <Select value={item.item_type} onChange={v => updateItem(index, { item_type: v as "service" | "free_text" })}
                        options={[{ value: "service", label: "Servizio" }, { value: "free_text", label: "Voce libera" }]} />
                      <button type="button" onClick={() => removeItem(index)} className="shrink-0 text-xs text-red-600 hover:underline">Rimuovi</button>
                    </div>
                    <Grid>
                      <Field label="Titolo" full><Input value={item.title} onChange={v => updateItem(index, { title: v })} /></Field>
                      <Field label="Descrizione" full>
                        <textarea value={item.description} onChange={e => updateItem(index, { description: e.target.value })} rows={2}
                          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 resize-none" />
                      </Field>
                      {item.item_type === "service" && (
                        <>
                          <Field label="Tipo"><Select value={item.service_type} onChange={v => updateItem(index, { service_type: v })} options={SERVICE_OPTIONS} /></Field>
                          <Field label="Direzione">
                            <Select value={item.direction} onChange={v => updateItem(index, { direction: v })} options={[
                              { value: "", label: "Non specificata" },
                              { value: "arrival", label: "Arrivo" },
                              { value: "departure", label: "Partenza" },
                              { value: "round_trip", label: "A/R" },
                            ]} />
                          </Field>
                          <Field label="Data"><Input type="date" value={item.service_date} onChange={v => updateItem(index, { service_date: v })} /></Field>
                          <Field label="Orario"><Input type="time" value={item.service_time} onChange={v => updateItem(index, { service_time: v })} /></Field>
                          <Field label="Hotel"><Input value={item.hotel_name} onChange={v => updateItem(index, { hotel_name: v })} /></Field>
                          <Field label="Pax"><Input type="number" value={String(item.pax)} onChange={v => updateItem(index, { pax: Number(v) })} /></Field>
                        </>
                      )}
                      {item.item_type === "free_text" && (
                        <Field label="Quantita"><Input type="number" value={String(item.quantity)} onChange={v => updateItem(index, { quantity: Number(v) })} /></Field>
                      )}
                      <Field label={item.item_type === "service" ? "Prezzo per pax" : "Prezzo unitario"}>
                        <Input type="number" step="0.01" value={item.price_euros} onChange={v => updateItem(index, { price_euros: v })} />
                      </Field>
                      <Field label="Note prezzo" full><Input value={item.price_notes} onChange={v => updateItem(index, { price_notes: v })} /></Field>
                    </Grid>
                  </div>
                ))}
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => addItem("service")} className="text-sm px-3 py-2 rounded-lg border border-blue-200 text-blue-700 hover:bg-blue-50">+ Servizio</button>
                  <button type="button" onClick={() => addItem("free_text")} className="text-sm px-3 py-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50">+ Voce libera</button>
                </div>
              </div>
            </Card>

            {/* Email */}
            <Card title="Email offerta">
              <div className="space-y-3">
                <Field label="Intro personalizzata (lascia vuoto per testo standard)">
                  <textarea value={form.email_intro} onChange={e => sf("email_intro", e.target.value)} rows={3}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 resize-none" />
                </Field>
              </div>
            </Card>

            {/* Pagamento */}
            <Card title="Pagamento">
              <Grid>
                <Field label="IBAN" full><Input value={form.iban} onChange={v => sf("iban", v)} placeholder="IT60X..." /></Field>
                <Field label="SWIFT/BIC"><Input value={form.swift_code} onChange={v => sf("swift_code", v)} placeholder="es. BCITITMM" /></Field>
                <Field label="Intestatario conto"><Input value={form.bank_account_holder} onChange={v => sf("bank_account_holder", v)} /></Field>
              </Grid>
              <div className="mt-3">
                <Field label="Istruzioni pagamento aggiuntive">
                  <textarea value={form.payment_instructions} onChange={e => sf("payment_instructions", e.target.value)} rows={2}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 resize-none" />
                </Field>
              </div>
              {/* Preview buttons */}
              <div className="flex gap-2 mt-3">
                <button type="button" onClick={() => openPreview("it")}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 border border-blue-200 rounded-lg text-blue-700 hover:bg-blue-50">
                  👁 Anteprima 🇮🇹
                </button>
                <button type="button" onClick={() => openPreview("en")}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 border border-blue-200 rounded-lg text-blue-700 hover:bg-blue-50">
                  👁 Preview 🇬🇧
                </button>
              </div>
            </Card>

            {/* Note interne */}
            <Card title="Note interne">
              <Field label="Note (non visibili al cliente)">
                <textarea value={form.notes_internal} onChange={e => sf("notes_internal", e.target.value)} rows={2}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 resize-none" />
              </Field>
            </Card>

            {formError && <p className="text-red-600 text-sm bg-red-50 border border-red-200 px-4 py-2 rounded-lg">{formError}</p>}

            <div className="flex gap-3 pb-8">
              <button type="submit" disabled={saving}
                className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-semibold py-3 rounded-xl">
                {saving ? "Salvataggio…" : "Crea preventivo"}
              </button>
              <Link href="/preventivi"
                className="px-5 py-3 border border-slate-200 rounded-xl text-slate-600 hover:bg-slate-50 text-center">
                Annulla
              </Link>
            </div>
          </form>
        </div>
      </div>

      {/* ── Email preview modal ─────────────────────────────────────────────── */}
      {previewOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 shrink-0">
              <div>
                <h3 className="font-bold text-slate-800">Anteprima email</h3>
                <p className="text-xs text-slate-400">Come la riceverà il cliente (dati del form)</p>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-semibold">
                  <button onClick={() => openPreview("it")}
                    className={`px-3 py-1.5 ${previewLang==="it" ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                    🇮🇹 IT
                  </button>
                  <button onClick={() => openPreview("en")}
                    className={`px-3 py-1.5 ${previewLang==="en" ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                    🇬🇧 EN
                  </button>
                </div>
                <button onClick={() => setPreviewOpen(false)} className="text-slate-400 hover:text-slate-600 text-xl ml-1">✕</button>
              </div>
            </div>
            <div className="flex-1 overflow-hidden p-4">
              {previewLoading
                ? <div className="flex items-center justify-center h-full text-slate-400">Caricamento…</div>
                : previewHtml
                  ? <iframe srcDoc={previewHtml} className="w-full h-full rounded-xl border border-slate-100" sandbox="allow-same-origin" title="Anteprima" />
                  : <div className="flex items-center justify-center h-full text-slate-400">Anteprima non disponibile.</div>
              }
            </div>
            <div className="px-5 py-4 border-t border-slate-100 text-right shrink-0">
              <button onClick={() => setPreviewOpen(false)}
                className="px-4 py-2 border border-slate-200 rounded-xl text-slate-600 hover:bg-slate-50 text-sm">
                Chiudi
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Import da testo modal ──────────────────────────────────────────────── */}
      {importOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 shrink-0">
              <h3 className="font-bold text-slate-800">Importa dati da messaggio</h3>
              <button onClick={() => { setImportOpen(false); setImportText(""); setImportResult(null); }}
                className="text-slate-400 hover:text-slate-600 text-xl">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Incolla qui il messaggio del cliente</label>
                <textarea
                  value={importText}
                  onChange={e => { setImportText(e.target.value); setImportResult(null); }}
                  rows={8}
                  placeholder={"Buongiorno, vorrei prenotare un transfer dall'aeroporto di Napoli.\nSiamo in 4, arriviamo con il volo LX1712 alle 10:30 il 15 maggio.\nNecessitiamo anche del ritorno il 22 maggio, volo AZ1287 alle 12:55.\nGrazie, Fabien Arnaud"}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 resize-none"
                />
              </div>
              <button onClick={doExtract}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2.5 rounded-xl text-sm">
                🔍 Estrai dati
              </button>

              {importResult && (
                <div className="border border-green-200 bg-green-50 rounded-xl p-4 space-y-1">
                  <p className="text-xs font-bold text-green-800 mb-2">Dati estratti:</p>
                  {importResult.customer_first_name && <ExtractRow label="Nome" value={importResult.customer_first_name} />}
                  {importResult.customer_last_name  && <ExtractRow label="Cognome" value={importResult.customer_last_name} />}
                  {importResult.customer_phone      && <ExtractRow label="Telefono" value={importResult.customer_phone} />}
                  {importResult.customer_language   && <ExtractRow label="Lingua" value={importResult.customer_language === "en" ? "🇬🇧 English" : "🇮🇹 Italiano"} />}
                  {importResult.direction           && <ExtractRow label="Direzione" value={{ arrival:"Arrivo", departure:"Partenza", round_trip:"A/R" }[importResult.direction] ?? importResult.direction} />}
                  {importResult.hotel_name          && <ExtractRow label="Hotel" value={importResult.hotel_name} />}
                  {importResult.arrival_date        && <ExtractRow label="Data arrivo" value={importResult.arrival_date} />}
                  {importResult.arrival_time        && <ExtractRow label="Orario arrivo" value={importResult.arrival_time} />}
                  {importResult.arrival_flight_train && <ExtractRow label="Volo arrivo" value={importResult.arrival_flight_train} />}
                  {importResult.departure_date       && <ExtractRow label="Data partenza" value={importResult.departure_date} />}
                  {importResult.departure_time       && <ExtractRow label="Orario partenza" value={importResult.departure_time} />}
                  {importResult.departure_flight_train && <ExtractRow label="Volo partenza" value={importResult.departure_flight_train} />}
                  {importResult.pax                 && <ExtractRow label="Passeggeri" value={String(importResult.pax)} />}
                  {!importResult.customer_first_name && !importResult.arrival_date && !importResult.departure_date && (
                    <p className="text-xs text-amber-700">⚠️ Pochi dati rilevati. Prova a incollare il testo completo del messaggio.</p>
                  )}
                </div>
              )}
            </div>
            <div className="flex gap-3 px-5 py-4 border-t border-slate-100 shrink-0">
              <button onClick={() => { setImportOpen(false); setImportText(""); setImportResult(null); }}
                className="flex-1 border border-slate-200 rounded-xl py-2.5 text-slate-600 hover:bg-slate-50 text-sm">
                Annulla
              </button>
              {importResult && (
                <button onClick={applyImport}
                  className="flex-1 bg-green-600 hover:bg-green-700 text-white font-semibold py-2.5 rounded-xl text-sm">
                  ✅ Applica al form
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Small components ───────────────────────────────────────────────────────────

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5">
      <h2 className="text-xs font-bold text-blue-900 uppercase tracking-wider mb-4">{title}</h2>
      {children}
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>;
}

function Field({ label, children, full = false }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div className={full ? "col-span-2" : ""}>
      <label className="block text-xs font-medium text-slate-500 mb-1">{label}</label>
      {children}
    </div>
  );
}

function Input({ value, onChange, type = "text", required = false, placeholder = "", step }: {
  value: string; onChange?: (v: string) => void;
  type?: string; required?: boolean; placeholder?: string; step?: string;
}) {
  return (
    <input type={type} value={value} onChange={e => onChange?.(e.target.value)}
      required={required} placeholder={placeholder} step={step}
      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400" />
  );
}

function Select({ value, onChange, options }: {
  value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-blue-400">
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function ExtractRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="text-green-600 font-medium shrink-0">✅ {label}:</span>
      <span className="text-green-800">{value}</span>
    </div>
  );
}
