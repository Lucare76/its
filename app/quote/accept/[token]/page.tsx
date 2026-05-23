"use client";

import { useEffect, useState } from "react";
import { use } from "react";

type QuoteDetails = {
  id: string;
  quote_number: string;
  status: string;
  customer_first_name: string;
  customer_last_name: string;
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
  currency: string;
  price_notes: string | null;
  email_intro: string | null;
  iban: string | null;
  bank_account_holder: string | null;
  payment_instructions: string | null;
  expires_at: string | null;
};

// ── i18n ─────────────────────────────────────────────────────────────────────

const T = {
  it: {
    loading: "Caricamento in corso…",
    notFound: "Preventivo non trovato o link non valido.",
    expired: "Questa offerta è scaduta.",
    alreadyAccepted: "Hai già accettato questa offerta. Attendi la nostra conferma dopo la verifica del pagamento.",
    cancelled: "Questa offerta è stata annullata.",
    title: (n: string) => `Offerta N° ${n}`,
    greeting: (name: string) => `Gentile ${name},`,
    intro: "Di seguito i dettagli della nostra offerta.",
    serviceDetails: "DETTAGLI SERVIZIO",
    serviceType: "Tipo servizio",
    hotel: "Hotel",
    address: "Indirizzo",
    passengers: "Passeggeri",
    luggage: "Note bagagli",
    special: "Richieste speciali",
    arrival: "▼ ARRIVO A ISCHIA",
    departure: "▲ PARTENZA DA ISCHIA",
    arrDate: "Data arrivo",
    depDate: "Data partenza",
    time: "Orario",
    flightTrain: "Volo / Treno",
    price: "PREZZO",
    pricePerPerson: "Prezzo a persona",
    total: "Totale",
    payment: "MODALITÀ DI PAGAMENTO (Bonifico bancario)",
    iban: "IBAN",
    holder: "Intestatario",
    reference: "Causale",
    validity: (d: string) => `Offerta valida fino al ${d}`,
    acceptBtn: "✅ ACCETTO L'OFFERTA",
    accepting: "Accettazione in corso…",
    disclaimer: "L'accettazione dell'offerta non costituisce conferma definitiva del servizio. La prenotazione sarà confermata solo al ricevimento del pagamento.",
    successTitle: "Offerta Accettata!",
    successText: "Grazie per aver accettato la nostra offerta. Ti contatteremo a breve per confermare i dettagli del pagamento.",
    error: "Si è verificato un errore. Riprova o contatta info@ischiatransferservice.it",
    validUntil: "Valida fino al",
  },
  en: {
    loading: "Loading…",
    notFound: "Quote not found or invalid link.",
    expired: "This offer has expired.",
    alreadyAccepted: "You have already accepted this offer. Please wait for our confirmation after payment verification.",
    cancelled: "This offer has been cancelled.",
    title: (n: string) => `Quote #${n}`,
    greeting: (name: string) => `Dear ${name},`,
    intro: "Please find below the details of our offer.",
    serviceDetails: "SERVICE DETAILS",
    serviceType: "Service type",
    hotel: "Hotel",
    address: "Address",
    passengers: "Passengers",
    luggage: "Luggage notes",
    special: "Special requests",
    arrival: "▼ ARRIVAL TO ISCHIA",
    departure: "▲ DEPARTURE FROM ISCHIA",
    arrDate: "Arrival date",
    depDate: "Departure date",
    time: "Time",
    flightTrain: "Flight / Train",
    price: "PRICE",
    pricePerPerson: "Price per person",
    total: "Total",
    payment: "PAYMENT DETAILS (Bank transfer)",
    iban: "IBAN",
    holder: "Account holder",
    reference: "Reference",
    validity: (d: string) => `Offer valid until ${d}`,
    acceptBtn: "✅ ACCEPT OFFER",
    accepting: "Processing…",
    disclaimer: "Accepting this offer does not constitute a confirmed booking. Your reservation will be confirmed only upon receipt of payment.",
    successTitle: "Offer Accepted!",
    successText: "Thank you for accepting our offer. We will contact you shortly to confirm the payment details.",
    error: "An error occurred. Please try again or contact info@ischiatransferservice.it",
    validUntil: "Valid until",
  },
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtEur(cents: number) {
  return `€ ${(cents / 100).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(iso: string | null, lang: "it" | "en"): string {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString(lang === "it" ? "it-IT" : "en-GB", {
    day: "2-digit", month: "long", year: "numeric", timeZone: "UTC",
  });
}

function fmtExpires(iso: string | null, lang: "it" | "en"): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(lang === "it" ? "it-IT" : "en-GB", {
    day: "2-digit", month: "long", year: "numeric",
  });
}

const SERVICE_LABELS: Record<string, [string, string]> = {
  transfer_airport: ["Transfer Aeroporto", "Airport Transfer"],
  transfer_station: ["Transfer Stazione", "Train Station Transfer"],
  transfer_port:    ["Transfer Porto", "Port Transfer"],
  excursion:        ["Escursione", "Excursion"],
  shuttle:          ["Navetta", "Shuttle"],
  formula_snav:     ["Formula SNAV", "SNAV Package"],
  formula_medmar:   ["Formula Medmar", "Medmar Package"],
  custom:           ["Servizio su misura", "Custom Service"],
};

function serviceLabel(type: string, lang: "it" | "en"): string {
  const e = SERVICE_LABELS[type];
  return e ? e[lang === "it" ? 0 : 1] : type;
}

// ── Row component ─────────────────────────────────────────────────────────────

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-2 border-b border-slate-100 last:border-0 text-sm">
      <span className="text-slate-500 shrink-0">{label}</span>
      <span className="text-slate-800 font-medium text-right">{value}</span>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AcceptQuotePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);

  const [quote, setQuote] = useState<QuoteDetails | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "accepted" | "error" | "expired" | "not_found" | "cancelled">("loading");
  const [accepting, setAccepting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const lang: "it" | "en" = quote?.customer_language ?? "it";
  const t = T[lang];

  useEffect(() => {
    if (!token) { setState("not_found"); return; }
    fetch(`/api/public/service-quotes/accept?token=${encodeURIComponent(token)}`)
      .then(r => r.json())
      .then((body: { ok?: boolean; quote?: QuoteDetails; error?: string }) => {
        if (!body.ok || !body.quote) { setState("not_found"); return; }
        const q = body.quote;
        setQuote(q);
        if (q.status === "cancelled") { setState("cancelled"); return; }
        if (q.status === "accepted" || q.status === "paid" || q.status === "confirmed") { setState("accepted"); return; }
        if (q.status !== "offer_sent") { setState("not_found"); return; }
        if (q.expires_at && new Date(q.expires_at) < new Date()) { setState("expired"); return; }
        setState("ready");
      })
      .catch(() => setState("error"));
  }, [token]);

  async function handleAccept() {
    if (!token || accepting) return;
    setAccepting(true);
    setErrorMsg("");
    try {
      const res = await fetch(`/api/public/service-quotes/accept?token=${encodeURIComponent(token)}`, { method: "POST" });
      const body = await res.json() as { ok?: boolean; already_accepted?: boolean; error?: string };
      if (res.status === 410) { setState("expired"); return; }
      if (!body.ok) { setErrorMsg(body.error ?? t.error); return; }
      setState("accepted");
    } catch {
      setErrorMsg(t.error);
    } finally {
      setAccepting(false);
    }
  }

  // ── Render states ────────────────────────────────────────────────────────

  const wrapper = (children: React.ReactNode) => (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-slate-100 flex items-start justify-center py-10 px-4">
      <div className="w-full max-w-xl">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center gap-2 mb-2">
            <span className="text-2xl font-black text-blue-900 tracking-tight">ISCHIA</span>
            <span className="text-2xl font-black text-sky-500">TRANSFER</span>
            <span className="text-2xl font-black text-blue-900 tracking-tight">SERVICE</span>
          </div>
          <p className="text-xs text-slate-400">info@ischiatransferservice.it</p>
        </div>
        {children}
      </div>
    </div>
  );

  if (state === "loading") return wrapper(<div className="bg-white rounded-2xl p-8 text-center text-slate-500 shadow">{t.loading}</div>);
  if (state === "not_found") return wrapper(<div className="bg-white rounded-2xl p-8 text-center text-slate-500 shadow">{t.notFound}</div>);
  if (state === "expired") return wrapper(<div className="bg-amber-50 rounded-2xl p-8 text-center shadow border border-amber-200"><p className="text-amber-800 font-semibold text-lg">⏰ {t.expired}</p></div>);
  if (state === "cancelled") return wrapper(<div className="bg-red-50 rounded-2xl p-8 text-center shadow border border-red-200"><p className="text-red-800 font-semibold text-lg">❌ {t.cancelled}</p></div>);

  if (state === "accepted") return wrapper(
    <div className="bg-green-50 rounded-2xl p-8 text-center shadow border border-green-200">
      <p className="text-4xl mb-4">✅</p>
      <p className="text-green-800 font-bold text-xl mb-2">{t.successTitle}</p>
      <p className="text-green-700 text-sm">{t.successText}</p>
    </div>
  );

  if (state === "error") return wrapper(<div className="bg-red-50 rounded-2xl p-8 text-center shadow border border-red-200"><p className="text-red-800">{t.error}</p></div>);

  if (!quote) return null;

  const showArrival = quote.direction === "arrival" || quote.direction === "round_trip";
  const showDeparture = quote.direction === "departure" || quote.direction === "round_trip";
  const totalCents = quote.price_cents * quote.pax;

  return wrapper(
    <div className="bg-white rounded-2xl shadow overflow-hidden">
      {/* Title band */}
      <div className="bg-blue-900 text-white px-6 py-4">
        <p className="text-xs opacity-70 uppercase tracking-widest mb-1">{t.title(quote.quote_number)}</p>
        <p className="text-lg font-bold">{t.greeting(`${quote.customer_first_name} ${quote.customer_last_name}`)}</p>
        <p className="text-sm opacity-80 mt-1">{t.intro}</p>
      </div>

      <div className="p-6 space-y-5">
        {/* Custom intro */}
        {quote.email_intro && (
          <p className="text-slate-600 text-sm italic border-l-4 border-blue-200 pl-3">{quote.email_intro}</p>
        )}

        {/* Service details */}
        <section>
          <h2 className="text-xs font-bold text-blue-900 uppercase tracking-wider mb-2">{t.serviceDetails}</h2>
          <div className="bg-slate-50 rounded-xl px-4 py-1">
            <Row label={t.serviceType} value={serviceLabel(quote.service_type, lang)} />
            {quote.hotel_name && <Row label={t.hotel} value={quote.hotel_name} />}
            {quote.hotel_address && <Row label={t.address} value={quote.hotel_address} />}
            <Row label={t.passengers} value={String(quote.pax)} />
            {quote.luggage_notes && <Row label={t.luggage} value={quote.luggage_notes} />}
            {quote.special_requests && <Row label={t.special} value={quote.special_requests} />}
          </div>
        </section>

        {/* Arrival */}
        {showArrival && quote.arrival_date && (
          <section>
            <h2 className="text-xs font-bold text-blue-900 uppercase tracking-wider mb-2">{t.arrival}</h2>
            <div className="bg-blue-50 rounded-xl px-4 py-1">
              <Row label={t.arrDate} value={fmtDate(quote.arrival_date, lang)} />
              {quote.arrival_time && <Row label={t.time} value={quote.arrival_time.slice(0, 5)} />}
              {quote.arrival_flight_train && <Row label={t.flightTrain} value={quote.arrival_flight_train} />}
            </div>
          </section>
        )}

        {/* Departure */}
        {showDeparture && quote.departure_date && (
          <section>
            <h2 className="text-xs font-bold text-blue-900 uppercase tracking-wider mb-2">{t.departure}</h2>
            <div className="bg-orange-50 rounded-xl px-4 py-1">
              <Row label={t.depDate} value={fmtDate(quote.departure_date, lang)} />
              {quote.departure_time && <Row label={t.time} value={quote.departure_time.slice(0, 5)} />}
              {quote.departure_flight_train && <Row label={t.flightTrain} value={quote.departure_flight_train} />}
            </div>
          </section>
        )}

        {/* Price */}
        <section>
          <h2 className="text-xs font-bold text-blue-900 uppercase tracking-wider mb-2">{t.price}</h2>
          <div className="bg-slate-50 rounded-xl px-4 py-1">
            <Row label={t.pricePerPerson} value={fmtEur(quote.price_cents)} />
            <div className="flex justify-between gap-4 py-2 text-sm">
              <span className="text-slate-500">{t.total}</span>
              <span className="text-blue-900 font-black text-base">{fmtEur(totalCents)}</span>
            </div>
            {quote.price_notes && <Row label="ℹ️" value={quote.price_notes} />}
          </div>
        </section>

        {/* Payment */}
        {(quote.iban || quote.bank_account_holder) && (
          <section>
            <h2 className="text-xs font-bold text-blue-900 uppercase tracking-wider mb-2">{t.payment}</h2>
            <div className="bg-slate-50 rounded-xl px-4 py-1">
              {quote.iban && (
                <div className="flex justify-between gap-4 py-2 border-b border-slate-100 text-sm">
                  <span className="text-slate-500">{t.iban}</span>
                  <span className="font-mono font-semibold text-slate-800 text-right break-all">{quote.iban}</span>
                </div>
              )}
              {quote.bank_account_holder && <Row label={t.holder} value={quote.bank_account_holder} />}
              <Row label={t.reference} value={`${quote.quote_number}`} />
            </div>
            {quote.payment_instructions && (
              <p className="mt-2 text-xs text-slate-500 italic">{quote.payment_instructions}</p>
            )}
          </section>
        )}

        {/* Validity */}
        {quote.expires_at && (
          <p className="text-center text-xs text-slate-500">{t.validity(fmtExpires(quote.expires_at, lang))}</p>
        )}

        {/* Accept button */}
        <div className="bg-green-50 border border-green-200 rounded-2xl p-5 text-center">
          {errorMsg && <p className="text-red-600 text-sm mb-3">{errorMsg}</p>}
          <button
            onClick={handleAccept}
            disabled={accepting}
            className="w-full bg-green-600 hover:bg-green-700 disabled:opacity-60 text-white font-bold py-4 rounded-xl text-lg transition-colors"
          >
            {accepting ? t.accepting : t.acceptBtn}
          </button>
        </div>

        {/* Disclaimer */}
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-xs text-amber-800">
          ⚠️ {t.disclaimer}
        </div>
      </div>
    </div>
  );
}
