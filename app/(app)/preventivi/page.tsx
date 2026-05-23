"use client";

import { useState, useEffect, useCallback } from "react";
import { PageHeader, SectionCard } from "@/components/ui";
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
  currency: string;
  offer_sent_at: string | null;
  accepted_at: string | null;
  paid_at: string | null;
  confirmed_at: string | null;
  expires_at: string | null;
  created_at: string;
  notes_internal: string | null;
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
  bank_account_holder: string | null;
  payment_instructions: string | null;
  payment_reference: string | null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  draft:      "Bozza",
  offer_sent: "Offerta inviata",
  accepted:   "Accettata",
  paid:       "Pagata",
  confirmed:  "Confermata",
  expired:    "Scaduta",
  cancelled:  "Cancellata",
};

const STATUS_COLORS: Record<string, string> = {
  draft:      "bg-slate-100 text-slate-600",
  offer_sent: "bg-blue-100 text-blue-700",
  accepted:   "bg-yellow-100 text-yellow-700",
  paid:       "bg-purple-100 text-purple-700",
  confirmed:  "bg-green-100 text-green-700",
  expired:    "bg-orange-100 text-orange-700",
  cancelled:  "bg-red-100 text-red-700",
};

const SERVICE_LABELS: Record<string, string> = {
  transfer_airport: "Transfer Aeroporto",
  transfer_station: "Transfer Stazione",
  transfer_port:    "Transfer Porto",
  excursion:        "Escursione",
  shuttle:          "Navetta",
  formula_snav:     "Formula SNAV",
  formula_medmar:   "Formula Medmar",
  custom:           "Su misura",
};

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("it-IT", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "UTC",
  });
}

function fmtEur(cents: number) {
  return `€ ${(cents / 100).toFixed(2)}`;
}

// ── Create form state ─────────────────────────────────────────────────────────

const EMPTY_FORM = {
  customer_first_name: "",
  customer_last_name:  "",
  customer_email:      "",
  customer_phone:      "",
  customer_language:   "it" as "it" | "en",
  service_type:        "transfer_airport" as string,
  direction:           "arrival" as string,
  arrival_date:        "",
  arrival_time:        "",
  arrival_flight_train: "",
  departure_date:      "",
  departure_time:      "",
  departure_flight_train: "",
  hotel_name:          "",
  hotel_address:       "",
  pax:                 1,
  luggage_notes:       "",
  special_requests:    "",
  price_cents:         0,
  price_notes:         "",
  email_intro:         "",
  payment_instructions: "",
  notes_internal:      "",
};

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PreventiviPage() {
  const [quotes, setQuotes]   = useState<ServiceQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm]       = useState(EMPTY_FORM);
  const [saving, setSaving]   = useState(false);
  const [formError, setFormError] = useState("");

  const [selected, setSelected] = useState<QuoteFull | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  const [paymentRef, setPaymentRef] = useState("");

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
    if (!token) return;
    const res = await fetch(`/api/ops/service-quotes/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json() as { ok?: boolean; quote?: QuoteFull };
    if (body.ok && body.quote) setSelected(body.quote);
    setDetailLoading(false);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError("");
    const token = await getToken();
    if (!token) { setFormError("Non autenticato."); setSaving(false); return; }

    const payload = {
      ...form,
      pax: Number(form.pax),
      price_cents: Math.round(parseFloat(String(form.price_cents)) * 100) || 0,
      direction: form.direction || null,
      customer_phone: form.customer_phone || null,
      arrival_time: form.arrival_time || null,
      arrival_date: form.arrival_date || null,
      arrival_flight_train: form.arrival_flight_train || null,
      departure_date: form.departure_date || null,
      departure_time: form.departure_time || null,
      departure_flight_train: form.departure_flight_train || null,
      hotel_name: form.hotel_name || null,
      hotel_address: form.hotel_address || null,
      luggage_notes: form.luggage_notes || null,
      special_requests: form.special_requests || null,
      price_notes: form.price_notes || null,
      email_intro: form.email_intro || null,
      payment_instructions: form.payment_instructions || null,
      notes_internal: form.notes_internal || null,
    };

    const res = await fetch("/api/ops/service-quotes", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json() as { ok?: boolean; error?: string; quote?: { id: string } };
    if (!body.ok) { setFormError(body.error ?? "Errore creazione."); setSaving(false); return; }
    setShowCreate(false);
    setForm(EMPTY_FORM);
    await load();
    if (body.quote?.id) await openDetail(body.quote.id);
    setSaving(false);
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

  function setField(field: string, value: string | number) {
    setForm(f => ({ ...f, [field]: value }));
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const filtered = quotes;

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Left pane — list */}
      <div className="w-80 shrink-0 border-r border-slate-200 flex flex-col">
        <div className="p-4 border-b border-slate-100 flex items-center justify-between gap-2">
          <div>
            <h1 className="font-bold text-slate-800">Preventivi clienti</h1>
            <p className="text-xs text-slate-400">{quotes.length} preventiv{quotes.length === 1 ? "o" : "i"}</p>
          </div>
          <button
            onClick={() => { setShowCreate(true); setSelected(null); }}
            className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-3 py-1.5 rounded-lg"
          >
            + Nuovo
          </button>
        </div>

        {/* Status filter */}
        <div className="px-3 py-2 border-b border-slate-100">
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

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {loading && <p className="p-4 text-xs text-slate-400">Caricamento…</p>}
          {error && <p className="p-4 text-xs text-red-500">{error}</p>}
          {!loading && filtered.length === 0 && (
            <p className="p-4 text-xs text-slate-400">Nessun preventivo trovato.</p>
          )}
          {filtered.map(q => (
            <button
              key={q.id}
              onClick={() => openDetail(q.id)}
              className={`w-full text-left px-4 py-3 border-b border-slate-100 hover:bg-slate-50 transition-colors ${selected?.id === q.id ? "bg-blue-50 border-l-2 border-l-blue-500" : ""}`}
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
                <span className="text-xs font-semibold text-blue-700">{fmtEur(q.price_cents * q.pax)}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Right pane — detail or create form */}
      <div className="flex-1 overflow-y-auto p-6">
        {/* Create form */}
        {showCreate && (
          <div className="max-w-2xl mx-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-slate-800">Nuovo preventivo</h2>
              <button onClick={() => setShowCreate(false)} className="text-slate-400 hover:text-slate-600 text-sm">✕ Chiudi</button>
            </div>
            <form onSubmit={handleCreate} className="space-y-5">
              {/* Cliente */}
              <SectionCard title="Cliente">
                <div className="grid grid-cols-2 gap-3">
                  <LabelInput label="Nome *" value={form.customer_first_name} onChange={v => setField("customer_first_name", v)} required />
                  <LabelInput label="Cognome *" value={form.customer_last_name} onChange={v => setField("customer_last_name", v)} required />
                  <LabelInput label="Email *" type="email" value={form.customer_email} onChange={v => setField("customer_email", v)} required className="col-span-2" />
                  <LabelInput label="Telefono" value={form.customer_phone} onChange={v => setField("customer_phone", v)} />
                  <LabelSelect label="Lingua email" value={form.customer_language} onChange={v => setField("customer_language", v)}
                    options={[{ value: "it", label: "Italiano" }, { value: "en", label: "English" }]} />
                </div>
              </SectionCard>

              {/* Servizio */}
              <SectionCard title="Servizio">
                <div className="grid grid-cols-2 gap-3">
                  <LabelSelect label="Tipo servizio *" value={form.service_type} onChange={v => setField("service_type", v)}
                    options={Object.entries(SERVICE_LABELS).map(([k, v]) => ({ value: k, label: v }))} />
                  <LabelSelect label="Direzione" value={form.direction} onChange={v => setField("direction", v)}
                    options={[
                      { value: "arrival", label: "Arrivo" },
                      { value: "departure", label: "Partenza" },
                      { value: "round_trip", label: "A/R" },
                      { value: "", label: "Non specificata" },
                    ]} />
                  <LabelInput label="Data arrivo" type="date" value={form.arrival_date} onChange={v => setField("arrival_date", v)} />
                  <LabelInput label="Orario arrivo" type="time" value={form.arrival_time} onChange={v => setField("arrival_time", v)} />
                  <LabelInput label="Volo / Treno arrivo" value={form.arrival_flight_train} onChange={v => setField("arrival_flight_train", v)} className="col-span-2" />
                  <LabelInput label="Data partenza" type="date" value={form.departure_date} onChange={v => setField("departure_date", v)} />
                  <LabelInput label="Orario partenza" type="time" value={form.departure_time} onChange={v => setField("departure_time", v)} />
                  <LabelInput label="Volo / Treno partenza" value={form.departure_flight_train} onChange={v => setField("departure_flight_train", v)} className="col-span-2" />
                  <LabelInput label="Hotel" value={form.hotel_name} onChange={v => setField("hotel_name", v)} />
                  <LabelInput label="Indirizzo hotel" value={form.hotel_address} onChange={v => setField("hotel_address", v)} />
                  <LabelInput label="Pax *" type="number" value={String(form.pax)} onChange={v => setField("pax", Number(v))} required />
                  <LabelInput label="Note bagagli" value={form.luggage_notes} onChange={v => setField("luggage_notes", v)} />
                  <LabelInput label="Richieste speciali" value={form.special_requests} onChange={v => setField("special_requests", v)} className="col-span-2" />
                </div>
              </SectionCard>

              {/* Prezzo */}
              <SectionCard title="Prezzo">
                <div className="grid grid-cols-2 gap-3">
                  <LabelInput label="Prezzo per persona (€) *" type="number" value={String(form.price_cents / 100 || "")}
                    onChange={v => setField("price_cents", Math.round(parseFloat(v) * 100) || 0)} required />
                  <div />
                  <LabelInput label="Note prezzo" value={form.price_notes} onChange={v => setField("price_notes", v)} className="col-span-2" />
                </div>
              </SectionCard>

              {/* Email */}
              <SectionCard title="Email offerta">
                <LabelTextarea label="Intro personalizzata (opzionale)" value={form.email_intro} onChange={v => setField("email_intro", v)} rows={3} />
                <LabelTextarea label="Istruzioni pagamento (opzionale)" value={form.payment_instructions} onChange={v => setField("payment_instructions", v)} rows={2} />
              </SectionCard>

              {/* Note interne */}
              <SectionCard title="Note interne">
                <LabelTextarea label="Note (non visibili al cliente)" value={form.notes_internal} onChange={v => setField("notes_internal", v)} rows={2} />
              </SectionCard>

              {formError && <p className="text-red-600 text-sm">{formError}</p>}
              <div className="flex gap-3">
                <button type="submit" disabled={saving}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-semibold py-2.5 rounded-xl">
                  {saving ? "Salvataggio…" : "Crea preventivo"}
                </button>
                <button type="button" onClick={() => setShowCreate(false)}
                  className="px-4 py-2.5 border border-slate-200 rounded-xl text-slate-600 hover:bg-slate-50">
                  Annulla
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Detail view */}
        {!showCreate && detailLoading && (
          <div className="flex items-center justify-center h-40 text-slate-400 text-sm">Caricamento…</div>
        )}

        {!showCreate && !detailLoading && !selected && (
          <div className="flex flex-col items-center justify-center h-full text-slate-300">
            <p className="text-5xl mb-4">📋</p>
            <p className="text-sm">Seleziona un preventivo o creane uno nuovo</p>
          </div>
        )}

        {!showCreate && selected && (
          <QuoteDetail
            quote={selected}
            actionBusy={actionBusy}
            actionError={actionError}
            paymentRef={paymentRef}
            setPaymentRef={setPaymentRef}
            onAction={doAction}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
}

// ── Detail component ──────────────────────────────────────────────────────────

function QuoteDetail({
  quote, actionBusy, actionError, paymentRef, setPaymentRef, onAction, onClose,
}: {
  quote: QuoteFull;
  actionBusy: string | null;
  actionError: string;
  paymentRef: string;
  setPaymentRef: (v: string) => void;
  onAction: (action: string, body?: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const showArrival   = quote.direction === "arrival"   || quote.direction === "round_trip";
  const showDeparture = quote.direction === "departure" || quote.direction === "round_trip";

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h2 className="text-xl font-bold text-slate-800">{quote.quote_number}</h2>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_COLORS[quote.status]}`}>
              {STATUS_LABELS[quote.status]}
            </span>
          </div>
          <p className="text-slate-500 text-sm">{quote.customer_first_name} {quote.customer_last_name} — {quote.customer_email}</p>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600">✕</button>
      </div>

      {actionError && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2 rounded-lg">{actionError}</div>
      )}

      {/* Service info */}
      <InfoSection title="Servizio">
        <Row label="Tipo" value={SERVICE_LABELS[quote.service_type] ?? quote.service_type} />
        {quote.hotel_name && <Row label="Hotel" value={quote.hotel_name} />}
        {quote.hotel_address && <Row label="Indirizzo" value={quote.hotel_address} />}
        <Row label="Passeggeri" value={String(quote.pax)} />
        {quote.luggage_notes && <Row label="Bagagli" value={quote.luggage_notes} />}
        {quote.special_requests && <Row label="Richieste speciali" value={quote.special_requests} />}
      </InfoSection>

      {showArrival && (
        <InfoSection title="▼ Arrivo a Ischia">
          {quote.arrival_date && <Row label="Data" value={fmtDate(quote.arrival_date)} />}
          {quote.arrival_time && <Row label="Orario" value={quote.arrival_time.slice(0, 5)} />}
          {quote.arrival_flight_train && <Row label="Volo / Treno" value={quote.arrival_flight_train} />}
        </InfoSection>
      )}

      {showDeparture && (
        <InfoSection title="▲ Partenza da Ischia">
          {quote.departure_date && <Row label="Data" value={fmtDate(quote.departure_date)} />}
          {quote.departure_time && <Row label="Orario" value={quote.departure_time.slice(0, 5)} />}
          {quote.departure_flight_train && <Row label="Volo / Treno" value={quote.departure_flight_train} />}
        </InfoSection>
      )}

      <InfoSection title="Prezzo">
        <Row label="Prezzo/persona" value={fmtEur(quote.price_cents)} />
        <Row label={`Totale (${quote.pax} pax)`} value={fmtEur(quote.price_cents * quote.pax)} />
        {quote.price_notes && <Row label="Note" value={quote.price_notes} />}
      </InfoSection>

      <InfoSection title="Pagamento">
        {quote.iban && <Row label="IBAN" value={quote.iban} mono />}
        {quote.bank_account_holder && <Row label="Intestatario" value={quote.bank_account_holder} />}
        {quote.payment_instructions && <Row label="Istruzioni" value={quote.payment_instructions} />}
        {quote.payment_reference && <Row label="Riferimento" value={quote.payment_reference} />}
      </InfoSection>

      {quote.email_intro && (
        <InfoSection title="Intro email">
          <p className="text-sm text-slate-600 italic">{quote.email_intro}</p>
        </InfoSection>
      )}

      {quote.notes_internal && (
        <InfoSection title="Note interne">
          <p className="text-sm text-slate-600">{quote.notes_internal}</p>
        </InfoSection>
      )}

      {/* Timeline */}
      <InfoSection title="Timeline">
        <Row label="Creato" value={fmtDate(quote.created_at)} />
        {quote.offer_sent_at && <Row label="Offerta inviata" value={fmtDate(quote.offer_sent_at)} />}
        {quote.expires_at && <Row label="Scade il" value={fmtDate(quote.expires_at)} />}
        {quote.accepted_at && <Row label="Accettata" value={fmtDate(quote.accepted_at)} />}
        {quote.paid_at && <Row label="Pagata" value={fmtDate(quote.paid_at)} />}
        {quote.confirmed_at && <Row label="Confermata" value={fmtDate(quote.confirmed_at)} />}
      </InfoSection>

      {/* Actions */}
      <div className="space-y-3">
        {(quote.status === "draft" || quote.status === "offer_sent") && (
          <button
            disabled={!!actionBusy}
            onClick={() => onAction("send")}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-semibold py-3 rounded-xl"
          >
            {actionBusy === "send" ? "Invio in corso…" : quote.status === "offer_sent" ? "📧 Re-invia offerta" : "📧 Invia offerta email"}
          </button>
        )}

        {(quote.status === "accepted" || quote.status === "offer_sent") && (
          <div className="border border-purple-200 rounded-xl p-4 bg-purple-50 space-y-3">
            <p className="text-sm font-semibold text-purple-800">Registra pagamento</p>
            <input
              type="text"
              placeholder="Riferimento / CRO bonifico (opzionale)"
              value={paymentRef}
              onChange={e => setPaymentRef(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white"
            />
            <button
              disabled={!!actionBusy}
              onClick={() => onAction("register-payment", { payment_reference: paymentRef || null })}
              className="w-full bg-purple-600 hover:bg-purple-700 disabled:opacity-60 text-white font-semibold py-2.5 rounded-xl"
            >
              {actionBusy === "register-payment" ? "Registrazione…" : "✅ Conferma pagamento ricevuto"}
            </button>
          </div>
        )}

        {!["confirmed", "cancelled"].includes(quote.status) && (
          <button
            disabled={!!actionBusy}
            onClick={() => { if (confirm("Cancellare questo preventivo?")) onAction("cancel"); }}
            className="w-full border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-60 font-medium py-2.5 rounded-xl text-sm"
          >
            {actionBusy === "cancel" ? "Cancellazione…" : "✕ Cancella preventivo"}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function InfoSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-bold text-blue-900 uppercase tracking-wider mb-2">{title}</h3>
      <div className="bg-slate-50 rounded-xl px-4 py-1">{children}</div>
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 py-2 border-b border-slate-100 last:border-0 text-sm">
      <span className="text-slate-500 shrink-0">{label}</span>
      <span className={`text-slate-800 text-right ${mono ? "font-mono" : "font-medium"}`}>{value}</span>
    </div>
  );
}

function LabelInput({
  label, value, onChange, type = "text", required = false, className = "",
}: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; required?: boolean; className?: string;
}) {
  return (
    <div className={className}>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        required={required}
        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
      />
    </div>
  );
}

function LabelSelect({
  label, value, onChange, options,
}: {
  label: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function LabelTextarea({
  label, value, onChange, rows = 3,
}: {
  label: string; value: string; onChange: (v: string) => void; rows?: number;
}) {
  return (
    <div className="mb-3">
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={rows}
        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 resize-none"
      />
    </div>
  );
}
