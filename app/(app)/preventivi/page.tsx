"use client";

import { useState, useEffect, useCallback } from "react";
import { getToken } from "@/lib/supabase/client";

// ── Types ─────────────────────────────────────────────────────────────────────

type ServiceQuote = {
  id: string;
  quote_number: string;
  status: "draft" | "offer_sent" | "accepted" | "paid" | "confirmed" | "expired" | "cancelled";
  customer_first_name: string;
  customer_last_name: string;
  customer_email: string;
  customer_phone: string | null;
  customer_language: "it" | "en";
  service_type: string;
  direction: "arrival" | "departure" | "round_trip" | null;
  arrival_date: string | null;
  departure_date: string | null;
  hotel_name: string | null;
  pax: number;
  price_cents: number;
  price_mode: "per_person" | "total";
  currency: string;
  offer_sent_at: string | null;
  accepted_at: string | null;
  paid_at: string | null;
  confirmed_at: string | null;
  expires_at: string | null;
  created_at: string;
  notes_internal: string | null;
  items?: Array<{ total_price_cents: number | null }>;
};

type QuoteFull = ServiceQuote & {
  arrival_time: string | null;
  arrival_flight_train: string | null;
  departure_time: string | null;
  departure_flight_train: string | null;
  hotel_address: string | null;
  luggage_notes: string | null;
  special_requests: string | null;
  price_notes: string | null;
  email_intro: string | null;
  payment_method: string | null;
  iban: string | null;
  swift_code: string | null;
  bank_account_holder: string | null;
  payment_instructions: string | null;
  payment_reference: string | null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export const STATUS_LABELS: Record<string, string> = {
  draft:      "Bozza",
  offer_sent: "Offerta inviata",
  accepted:   "Accettata",
  paid:       "Pagata",
  confirmed:  "Confermata",
  expired:    "Scaduta",
  cancelled:  "Cancellata",
};

export const STATUS_COLORS: Record<string, string> = {
  draft:      "bg-slate-100 text-slate-600",
  offer_sent: "bg-blue-100 text-blue-700",
  accepted:   "bg-yellow-100 text-yellow-700",
  paid:       "bg-purple-100 text-purple-700",
  confirmed:  "bg-green-100 text-green-700",
  expired:    "bg-orange-100 text-orange-700",
  cancelled:  "bg-red-100 text-red-700",
};

export const SERVICE_LABELS: Record<string, string> = {
  transfer_airport: "Transfer Aeroporto",
  transfer_station: "Transfer Stazione",
  transfer_port:    "Transfer Porto",
  excursion:        "Escursione",
  shuttle:          "Navetta",
  formula_snav:     "Formula SNAV",
  formula_medmar:   "Formula Medmar",
  custom:           "Su misura",
};

export function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("it-IT", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "UTC",
  });
}

export function fmtDatetime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("it-IT", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export function fmtEur(cents: number) {
  return `€ ${(cents / 100).toFixed(2)}`;
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PreventiviPage() {
  const [quotes, setQuotes]       = useState<ServiceQuote[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selected, setSelected]   = useState<QuoteFull | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [paymentRef, setPaymentRef] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLang, setPreviewLang] = useState<"it" | "en">("it");
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) { setError("Non autenticato."); setLoading(false); return; }
    setLoading(true);
    setError("");
    const url = statusFilter !== "all"
      ? `/api/ops/service-quotes?status=${statusFilter}`
      : "/api/ops/service-quotes";
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json() as { ok?: boolean; quotes?: ServiceQuote[]; error?: string };
    if (!body.ok) { setError(body.error ?? "Errore caricamento."); setLoading(false); return; }
    setQuotes(body.quotes ?? []);
    setLoading(false);
  }, [statusFilter]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  async function openDetail(id: string) {
    setDetailLoading(true);
    setActionError("");
    const token = await getToken();
    if (!token) { setDetailLoading(false); return; }
    const res = await fetch(`/api/ops/service-quotes/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json() as { ok?: boolean; quote?: QuoteFull };
    if (body.ok && body.quote) {
      setSelected(body.quote);
      setPreviewLang(body.quote.customer_language ?? "it");
    }
    setDetailLoading(false);
  }

  async function doAction(action: string, body?: Record<string, unknown>) {
    if (!selected) return;
    setActionBusy(action);
    setActionError("");
    const token = await getToken();
    if (!token) { setActionBusy(null); return; }
    const res = await fetch(`/api/ops/service-quotes/${selected.id}/${action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const resp = await res.json() as { ok?: boolean; error?: string };
    if (!resp.ok) { setActionError(resp.error ?? "Errore."); }
    else { await load(); await openDetail(selected.id); }
    setActionBusy(null);
  }

  async function loadPreview(id: string, lang: "it" | "en") {
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
    if (!selected) return;
    setPreviewOpen(true);
    void loadPreview(selected.id, previewLang);
  }

  function switchPreviewLang(lang: "it" | "en") {
    setPreviewLang(lang);
    if (selected) void loadPreview(selected.id, lang);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="quote-natural-text flex h-screen overflow-hidden">
        {/* ── Left — list ────────────────────────────────────────────────── */}
        <div className="w-80 shrink-0 border-r border-slate-200 flex flex-col">
          <div className="p-4 border-b border-slate-100">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div>
                <h1 className="font-bold text-slate-800">Preventivi clienti</h1>
                <p className="text-xs text-slate-400">{quotes.length} preventiv{quotes.length === 1 ? "o" : "i"}</p>
              </div>
              <a
                href="/preventivi/new"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-3 py-1.5 rounded-lg"
              >
                + Nuovo ↗
              </a>
            </div>
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white"
            >
              <option value="all">Tutti gli stati</option>
              {Object.entries(STATUS_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>

          <div className="flex-1 overflow-y-auto">
            {loading && <p className="p-4 text-xs text-slate-400">Caricamento…</p>}
            {error && <p className="p-4 text-xs text-red-500">{error}</p>}
            {!loading && quotes.length === 0 && (
              <p className="p-4 text-xs text-slate-400">Nessun preventivo trovato.</p>
            )}
            {quotes.map(q => (
              <div
                key={q.id}
                className={`group relative border-b border-slate-100 transition-colors ${selected?.id === q.id ? "bg-blue-50 border-l-2 border-l-blue-500" : "hover:bg-slate-50"}`}
              >
                <button
                  onClick={() => openDetail(q.id)}
                  className="w-full text-left px-4 py-3 pr-10"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-bold text-slate-700">{q.quote_number}</span>
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${STATUS_COLORS[q.status]}`}>
                      {STATUS_LABELS[q.status]}
                    </span>
                  </div>
                  <p className="text-sm font-medium text-slate-800 truncate">{q.customer_first_name} {q.customer_last_name}</p>
                  <p className="text-xs text-slate-400 truncate">{q.customer_email}</p>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-xs text-slate-500">{SERVICE_LABELS[q.service_type] ?? q.service_type}</span>
                    <span className="text-xs font-semibold text-blue-700">
                      {fmtEur(q.items?.length
                        ? q.items.reduce((sum, item) => sum + (item.total_price_cents ?? 0), 0)
                        : q.price_mode === "total" ? q.price_cents : q.price_cents * q.pax)}
                    </span>
                  </div>
                </button>
                {/* ↗ open in new tab */}
                <a
                  href={`/preventivi/${q.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Apri in nuova finestra"
                  className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 text-slate-300 hover:text-blue-500 text-xs px-1"
                >
                  ↗
                </a>
              </div>
            ))}
          </div>
        </div>

        {/* ── Right — detail ─────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto p-6">
          {detailLoading && (
            <div className="flex items-center justify-center h-40 text-slate-400 text-sm">Caricamento…</div>
          )}
          {!detailLoading && !selected && (
            <div className="flex flex-col items-center justify-center h-full text-slate-300">
              <p className="text-5xl mb-4">📋</p>
              <p className="text-sm mb-4">Seleziona un preventivo dalla lista</p>
              <a
                href="/preventivi/new"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2.5 rounded-xl"
              >
                + Nuovo preventivo ↗
              </a>
            </div>
          )}
          {!detailLoading && selected && (
            <QuoteDetailPanel
              quote={selected}
              actionBusy={actionBusy}
              actionError={actionError}
              paymentRef={paymentRef}
              setPaymentRef={setPaymentRef}
              onAction={doAction}
              onClose={() => setSelected(null)}
              onOpenPreview={openPreview}
              onRefresh={() => openDetail(selected.id)}
            />
          )}
        </div>
      </div>

      {/* ── Email preview modal ─────────────────────────────────────────────── */}
      {previewOpen && selected && (
        <EmailPreviewModal
          quoteNumber={selected.quote_number}
          customerEmail={selected.customer_email}
          html={previewHtml}
          loading={previewLoading}
          lang={previewLang}
          onSwitchLang={switchPreviewLang}
          onClose={() => setPreviewOpen(false)}
          onSend={() => {
            setPreviewOpen(false);
            void doAction("send");
          }}
          sendBusy={actionBusy === "send"}
          canSend={selected.status === "draft" || selected.status === "offer_sent"}
        />
      )}
    </>
  );
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function QuoteDetailPanel({
  quote, actionBusy, actionError, paymentRef, setPaymentRef,
  onAction, onClose, onOpenPreview, onRefresh,
}: {
  quote: QuoteFull;
  actionBusy: string | null;
  actionError: string;
  paymentRef: string;
  setPaymentRef: (v: string) => void;
  onAction: (action: string, body?: Record<string, unknown>) => void;
  onClose: () => void;
  onOpenPreview: () => void;
  onRefresh: () => void;
}) {
  const showArr = quote.direction === "arrival"  || quote.direction === "round_trip";
  const showDep = quote.direction === "departure" || quote.direction === "round_trip";
  const locked  = quote.status === "confirmed" || quote.status === "paid" || quote.status === "expired" || quote.status === "cancelled";

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap mb-1">
            <h2 className="text-xl font-bold text-slate-800">{quote.quote_number}</h2>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_COLORS[quote.status]}`}>
              {STATUS_LABELS[quote.status]}
            </span>
          </div>
          <p className="text-slate-500 text-sm truncate">{quote.customer_first_name} {quote.customer_last_name} — {quote.customer_email}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!locked && (
            <a href={`/preventivi/${quote.id}`} target="_blank" rel="noopener noreferrer"
              className="text-xs px-3 py-1.5 border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50">
              ✏️ Modifica ↗
            </a>
          )}
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none">✕</button>
        </div>
      </div>

      {actionError && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2 rounded-lg">{actionError}</div>
      )}

      {/* ── CLIENTE ── */}
      <Section title="Cliente">
        <Row label="Nome" value={`${quote.customer_first_name} ${quote.customer_last_name}`} />
        <Row label="Email" value={quote.customer_email} />
        {quote.customer_phone && <Row label="Telefono" value={quote.customer_phone} />}
        <Row label="Lingua email" value={quote.customer_language === "it" ? "🇮🇹 Italiano" : "🇬🇧 English"} />
      </Section>

      {/* ── SERVIZIO ── */}
      <Section title="Servizio">
        <Row label="Tipo" value={SERVICE_LABELS[quote.service_type] ?? quote.service_type} />
        {quote.direction && <Row label="Direzione" value={{ arrival: "Arrivo", departure: "Partenza", round_trip: "Andata e Ritorno" }[quote.direction] ?? quote.direction} />}
        {quote.hotel_name && <Row label="Hotel" value={quote.hotel_name} />}
        {quote.hotel_address && <Row label="Indirizzo hotel" value={quote.hotel_address} />}
        <Row label="Passeggeri" value={String(quote.pax)} />
        {quote.luggage_notes && <Row label="Bagagli" value={quote.luggage_notes} />}
        {quote.special_requests && <Row label="Richieste speciali" value={quote.special_requests} />}
      </Section>

      {/* ── ARRIVO ── */}
      {showArr && (
        <Section title="▼ Arrivo a Ischia">
          {quote.arrival_date && <Row label="Data" value={fmtDate(quote.arrival_date)} />}
          {quote.arrival_time && <Row label="Orario" value={quote.arrival_time.slice(0, 5)} />}
          {quote.arrival_flight_train && <Row label="Volo / Treno" value={quote.arrival_flight_train} />}
        </Section>
      )}

      {/* ── PARTENZA ── */}
      {showDep && (
        <Section title="▲ Partenza da Ischia">
          {quote.departure_date && <Row label="Data" value={fmtDate(quote.departure_date)} />}
          {quote.departure_time && <Row label="Orario" value={quote.departure_time.slice(0, 5)} />}
          {quote.departure_flight_train && <Row label="Volo / Treno" value={quote.departure_flight_train} />}
        </Section>
      )}

      {/* ── PREZZO ── */}
      <Section title="Prezzo">
        {quote.price_mode !== "total" && <Row label="Per persona" value={fmtEur(quote.price_cents)} />}
        <Row label={quote.price_mode === "total" ? "Totale" : `Totale (${quote.pax} pax)`} value={fmtEur(quote.price_mode === "total" ? quote.price_cents : quote.price_cents * quote.pax)} bold />
        {quote.price_notes && <Row label="Note" value={quote.price_notes} />}
      </Section>

      {/* ── PAGAMENTO ── */}
      <Section title="Pagamento">
        {quote.payment_method && <Row label="Metodo" value={quote.payment_method} />}
        {quote.iban && <Row label="IBAN" value={quote.iban} mono />}
        {quote.swift_code && <Row label="SWIFT/BIC" value={quote.swift_code} mono />}
        {quote.bank_account_holder && <Row label="Intestatario" value={quote.bank_account_holder} />}
        {quote.payment_instructions && <Row label="Istruzioni" value={quote.payment_instructions} />}
        {quote.payment_reference && <Row label="Riferimento CRO" value={quote.payment_reference} />}
      </Section>

      {/* ── EMAIL ── */}
      {quote.email_intro && (
        <Section title="Intro email">
          <p className="text-sm text-slate-600 italic py-2">{quote.email_intro}</p>
        </Section>
      )}

      {/* ── NOTE INTERNE ── */}
      <Section title="Note interne (solo operatore)">
        <p className="text-sm text-slate-600 py-2">{quote.notes_internal || <span className="text-slate-300 italic">Nessuna nota</span>}</p>
      </Section>

      {/* ── TIMELINE ── */}
      <Section title="Cronologia">
        <TimelineRow ts={quote.created_at} label="Preventivo creato" />
        {quote.offer_sent_at && <TimelineRow ts={quote.offer_sent_at} label="Offerta inviata al cliente" />}
        {quote.expires_at && <TimelineRow ts={quote.expires_at} label="Scadenza offerta" future />}
        {quote.accepted_at && <TimelineRow ts={quote.accepted_at} label="Offerta accettata dal cliente" />}
        {quote.paid_at && <TimelineRow ts={quote.paid_at} label="Pagamento registrato" />}
        {quote.confirmed_at && <TimelineRow ts={quote.confirmed_at} label="Prenotazione confermata" />}
      </Section>

      {/* ── AZIONI ── */}
      <div className="space-y-2 pt-2">
        {/* Anteprima email */}
        {(quote.status === "draft" || quote.status === "offer_sent") && (
          <button onClick={onOpenPreview}
            className="w-full border border-blue-200 text-blue-700 hover:bg-blue-50 font-medium py-2.5 rounded-xl text-sm">
            👁 Anteprima email
          </button>
        )}

        {/* Invia / Reinvia */}
        {(quote.status === "draft" || quote.status === "offer_sent") && (
          <button disabled={!!actionBusy} onClick={() => onAction("send")}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-semibold py-3 rounded-xl">
            {actionBusy === "send" ? "Invio…" : quote.status === "offer_sent" ? "📧 Re-invia offerta email" : "📧 Invia offerta email"}
          </button>
        )}

        {/* Registra pagamento */}
        {(quote.status === "accepted" || quote.status === "offer_sent") && (
          <div className="border border-purple-200 rounded-xl p-4 bg-purple-50 space-y-2">
            <p className="text-sm font-semibold text-purple-800">Registra pagamento</p>
            <input type="text" placeholder="Riferimento / CRO bonifico (opzionale)"
              value={paymentRef} onChange={e => setPaymentRef(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white" />
            <button disabled={!!actionBusy}
              onClick={() => onAction("register-payment", { payment_reference: paymentRef || null })}
              className="w-full bg-purple-600 hover:bg-purple-700 disabled:opacity-60 text-white font-semibold py-2.5 rounded-xl">
              {actionBusy === "register-payment" ? "Registrazione…" : "✅ Conferma pagamento ricevuto"}
            </button>
          </div>
        )}

        {/* Duplica (per expired/cancelled) */}
        {(quote.status === "expired" || quote.status === "cancelled") && (
          <a href={`/preventivi/new?from=${quote.id}`} target="_blank" rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium py-2.5 rounded-xl text-sm">
            📋 Duplica come nuova offerta ↗
          </a>
        )}

        {/* Cancella */}
        {!["confirmed", "cancelled"].includes(quote.status) && (
          <button disabled={!!actionBusy}
            onClick={() => { if (confirm("Cancellare questo preventivo?")) onAction("cancel"); }}
            className="w-full border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-60 font-medium py-2.5 rounded-xl text-sm">
            {actionBusy === "cancel" ? "Cancellazione…" : "✕ Cancella preventivo"}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Email preview modal ────────────────────────────────────────────────────────

function EmailPreviewModal({
  quoteNumber, customerEmail, html, loading, lang, onSwitchLang, onClose, onSend, sendBusy, canSend,
}: {
  quoteNumber: string;
  customerEmail: string;
  html: string;
  loading: boolean;
  lang: "it" | "en";
  onSwitchLang: (l: "it" | "en") => void;
  onClose: () => void;
  onSend: () => void;
  sendBusy: boolean;
  canSend: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 shrink-0">
          <div>
            <h3 className="font-bold text-slate-800">Anteprima email — {quoteNumber}</h3>
            <p className="text-xs text-slate-400">A: {customerEmail}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-semibold">
              <button onClick={() => onSwitchLang("it")}
                className={`px-3 py-1.5 ${lang === "it" ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                🇮🇹 IT
              </button>
              <button onClick={() => onSwitchLang("en")}
                className={`px-3 py-1.5 ${lang === "en" ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                🇬🇧 EN
              </button>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none ml-1">✕</button>
          </div>
        </div>

        {/* Email render */}
        <div className="flex-1 overflow-hidden p-4">
          {loading ? (
            <div className="flex items-center justify-center h-full text-slate-400">Caricamento anteprima…</div>
          ) : html ? (
            <iframe
              srcDoc={html}
              className="w-full h-full rounded-xl border border-slate-100"
              sandbox="allow-same-origin"
              title="Anteprima email"
            />
          ) : (
            <div className="flex items-center justify-center h-full text-slate-400">Anteprima non disponibile.</div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-slate-100 shrink-0">
          <button onClick={onClose} className="px-4 py-2 border border-slate-200 rounded-xl text-slate-600 hover:bg-slate-50 text-sm">
            Chiudi
          </button>
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

// ── Section + Row components ───────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[10px] font-bold text-blue-900 uppercase tracking-wider mb-1.5">{title}</h3>
      <div className="bg-slate-50 rounded-xl px-4 py-1">{children}</div>
    </div>
  );
}

function Row({ label, value, mono = false, bold = false }: { label: string; value: string; mono?: boolean; bold?: boolean }) {
  return (
    <div className="flex justify-between gap-4 py-2 border-b border-slate-100 last:border-0 text-sm">
      <span className="text-slate-500 shrink-0">{label}</span>
      <span className={`text-right ${mono ? "font-mono text-slate-700" : bold ? "font-bold text-blue-900" : "font-medium text-slate-800"}`}>{value}</span>
    </div>
  );
}

function TimelineRow({ ts, label, future = false }: { ts: string; label: string; future?: boolean }) {
  return (
    <div className="flex gap-3 py-2 border-b border-slate-100 last:border-0 text-sm items-start">
      <span className={`shrink-0 text-xs mt-0.5 ${future ? "text-orange-500" : "text-slate-400"}`}>
        {fmtDatetime(ts)}
      </span>
      <span className={`${future ? "text-orange-700" : "text-slate-700"}`}>{label}</span>
    </div>
  );
}
