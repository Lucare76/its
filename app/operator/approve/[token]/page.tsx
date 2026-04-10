"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

type ServiceData = {
  id: string;
  customer_name: string;
  customer_email: string | null;
  phone: string | null;
  pax: number;
  arrival_date: string;
  arrival_time: string;
  departure_date: string;
  departure_time: string;
  hotel_name: string;
  service_label: string;
  agency_name: string | null;
  notes: string;
};

type PageState =
  | { kind: "loading" }
  | { kind: "error"; message: string; alreadyUsed?: boolean; action?: string }
  | { kind: "ready"; service: ServiceData; suggestedPriceCents: number | null; priceSource: string }
  | { kind: "done"; action: "confirmed" | "rejected"; emailStatus: string };

function fmt(cents: number) {
  return (cents / 100).toFixed(2).replace(".", ",");
}
function fmtDate(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export default function OperatorApproveBookingPage() {
  const params = useParams();
  const token = typeof params.token === "string" ? params.token : Array.isArray(params.token) ? params.token[0] : "";

  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [priceInput, setPriceInput] = useState("");
  const [notes, setNotes] = useState("");
  const [resolvedByEmail, setResolvedByEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmStep, setConfirmStep] = useState<"confirmed" | "rejected" | null>(null);

  useEffect(() => {
    if (!token) { setState({ kind: "error", message: "Token mancante." }); return; }
    fetch(`/api/agency/bookings/approve/${token}`)
      .then(r => r.json())
      .then(body => {
        if (!body.ok) {
          setState({ kind: "error", message: body.error ?? "Link non valido.", alreadyUsed: body.already_used, action: body.action });
        } else {
          setState({ kind: "ready", service: body.service, suggestedPriceCents: body.pricing.suggested_price_cents, priceSource: body.pricing.source });
          if (body.pricing.suggested_price_cents != null) setPriceInput(fmt(body.pricing.suggested_price_cents));
        }
      })
      .catch(() => setState({ kind: "error", message: "Errore di rete." }));
  }, [token]);

  const submit = async (action: "confirmed" | "rejected") => {
    if (state.kind !== "ready") return;
    if (action === "confirmed") {
      const v = parseFloat(priceInput.replace(",", "."));
      if (isNaN(v) || v < 0) { alert("Inserisci un prezzo valido."); return; }
    }
    setSubmitting(true);
    const priceCents = action === "confirmed" ? Math.round(parseFloat(priceInput.replace(",", ".")) * 100) : undefined;
    const res = await fetch(`/api/agency/bookings/approve/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, price_cents: priceCents, notes: notes.trim() || undefined, resolved_by_email: resolvedByEmail.trim() || undefined })
    });
    const body = await res.json().catch(() => null);
    setSubmitting(false);
    if (!res.ok || !body?.ok) { alert(body?.error ?? "Errore."); return; }
    setState({ kind: "done", action, emailStatus: body.email_status });
    setConfirmStep(null);
  };

  if (state.kind === "loading") {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50"><p className="text-slate-500 text-sm">Caricamento…</p></div>;
  }

  if (state.kind === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-sm border border-slate-200 text-center space-y-3">
          <div className="text-4xl">{state.alreadyUsed ? "✅" : "⚠️"}</div>
          <h1 className="text-lg font-bold text-slate-800">{state.alreadyUsed ? "Link già utilizzato" : "Link non valido"}</h1>
          <p className="text-slate-500 text-sm">
            {state.alreadyUsed
              ? `Questa prenotazione è già stata ${state.action === "confirmed" ? "confermata" : state.action === "rejected" ? "rifiutata" : "gestita"}.`
              : state.message}
          </p>
        </div>
      </div>
    );
  }

  if (state.kind === "done") {
    const confirmed = state.action === "confirmed";
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-sm border border-slate-200 text-center space-y-3">
          <div className="text-5xl">{confirmed ? "✅" : "❌"}</div>
          <h1 className="text-xl font-bold text-slate-800">{confirmed ? "Prenotazione confermata" : "Prenotazione rifiutata"}</h1>
          <p className="text-slate-500 text-sm">
            {confirmed ? "L'agenzia ha ricevuto la conferma con il prezzo." : "L'agenzia è stata notificata con la motivazione."}
          </p>
          {state.emailStatus === "failed" && (
            <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2">⚠️ Email non inviata — verifica manualmente.</p>
          )}
        </div>
      </div>
    );
  }

  const { service, suggestedPriceCents, priceSource } = state;

  return (
    <div className="min-h-screen bg-slate-50 py-10 px-4">
      <div className="mx-auto max-w-lg space-y-5">

        <div className="text-center space-y-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Ischia Transfer Service</p>
          <h1 className="text-2xl font-bold text-slate-800">Gestione prenotazione</h1>
          <p className="text-sm text-slate-500">Conferma o rifiuta la richiesta agenzia</p>
        </div>

        {/* Riepilogo servizio */}
        <div className="rounded-2xl bg-white border border-slate-200 p-5 shadow-sm space-y-4">
          <div className="rounded-xl bg-slate-800 px-5 py-4 text-white">
            <p className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-1">Servizio richiesto</p>
            <p className="text-lg font-bold leading-snug">{service.service_label}</p>
            {service.agency_name && <p className="text-sm text-slate-300 mt-1">Agenzia: {service.agency_name}</p>}
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <div>
              <dt className="text-xs text-slate-400 font-medium uppercase tracking-wide">Cliente</dt>
              <dd className="font-semibold text-slate-800">{service.customer_name}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400 font-medium uppercase tracking-wide">Passeggeri</dt>
              <dd className="font-semibold text-slate-800">{service.pax} pax</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400 font-medium uppercase tracking-wide">Arrivo</dt>
              <dd className="font-semibold text-slate-800">{fmtDate(service.arrival_date)} {service.arrival_time}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400 font-medium uppercase tracking-wide">Rientro</dt>
              <dd className="font-semibold text-slate-800">{fmtDate(service.departure_date)} {service.departure_time}</dd>
            </div>
            {service.phone && (
              <div>
                <dt className="text-xs text-slate-400 font-medium uppercase tracking-wide">Telefono</dt>
                <dd className="font-semibold text-slate-800">{service.phone}</dd>
              </div>
            )}
            {service.customer_email && (
              <div className="col-span-2">
                <dt className="text-xs text-slate-400 font-medium uppercase tracking-wide">Email cliente</dt>
                <dd className="font-semibold text-slate-800 truncate">{service.customer_email}</dd>
              </div>
            )}
          </dl>

          {service.notes && (
            <div className="rounded-lg bg-slate-50 border border-slate-200 px-4 py-3 text-sm text-slate-600">
              <span className="font-semibold text-slate-700">Note: </span>{service.notes}
            </div>
          )}
        </div>

        {/* Prezzo */}
        <div className="rounded-2xl bg-white border border-slate-200 p-5 shadow-sm space-y-3">
          <h2 className="font-bold text-slate-800">Prezzo del servizio</h2>
          {suggestedPriceCents != null ? (
            <p className="text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2">
              💡 Suggerito dal listino: <strong>€{fmt(suggestedPriceCents)}</strong>
              <span className="text-emerald-600"> ({priceSource === "agency_rule" ? "listino agenzia" : "listino generico"})</span>
            </p>
          ) : (
            <p className="text-sm text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
              ⚠️ Nessuna regola trovata nel listino — inserisci il prezzo manualmente.
            </p>
          )}
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Prezzo finale (€) *</span>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-slate-500 font-semibold">€</span>
              <input
                type="number" min={0} step={0.01}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-400"
                placeholder="es. 120.00"
                value={priceInput}
                onChange={e => setPriceInput(e.target.value)}
              />
            </div>
            <span className="text-xs text-slate-400 mt-1 block">Obbligatorio per la conferma. Comunicato all'agenzia via email.</span>
          </label>
        </div>

        {/* Note + email operatore */}
        <div className="rounded-2xl bg-white border border-slate-200 p-5 shadow-sm space-y-3">
          <h2 className="font-bold text-slate-800">Note per l'agenzia</h2>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Nota operativa (opzionale)</span>
            <textarea rows={3}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-400"
              placeholder="Es. bus da Piazza Garibaldi alle 08:00"
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">La tua email (opzionale, per log)</span>
            <input type="email"
              className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-400"
              placeholder="operatore@ischiatransferservice.it"
              value={resolvedByEmail}
              onChange={e => setResolvedByEmail(e.target.value)}
            />
          </label>
        </div>

        {/* Bottoni */}
        {confirmStep === null ? (
          <div className="grid grid-cols-2 gap-3">
            <button type="button" onClick={() => setConfirmStep("rejected")} disabled={submitting}
              className="rounded-xl border-2 border-rose-200 bg-rose-50 px-4 py-3 font-bold text-rose-700 hover:bg-rose-100 disabled:opacity-50 transition-colors">
              ❌ Rifiuta
            </button>
            <button type="button" onClick={() => setConfirmStep("confirmed")} disabled={submitting}
              className="rounded-xl bg-emerald-600 px-4 py-3 font-bold text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors">
              ✅ Conferma
            </button>
          </div>
        ) : (
          <div className="rounded-2xl border-2 border-slate-200 bg-white p-5 space-y-3">
            <p className="font-semibold text-slate-800">
              {confirmStep === "confirmed" ? `Confermi il servizio a €${priceInput || "—"}?` : "Confermi il rifiuto?"}
            </p>
            {confirmStep === "confirmed" && !priceInput && (
              <p className="text-sm text-rose-600">Inserisci il prezzo prima di procedere.</p>
            )}
            <div className="flex gap-3">
              <button type="button" onClick={() => setConfirmStep(null)} disabled={submitting}
                className="flex-1 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                Annulla
              </button>
              <button type="button" onClick={() => void submit(confirmStep)}
                disabled={submitting || (confirmStep === "confirmed" && !priceInput)}
                className={`flex-1 rounded-xl px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50 transition-colors ${confirmStep === "confirmed" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-rose-600 hover:bg-rose-700"}`}>
                {submitting ? "Invio…" : "Sì, procedi"}
              </button>
            </div>
          </div>
        )}

        <p className="text-center text-xs text-slate-400">Ischia Transfer Service · link valido 48 ore</p>
      </div>
    </div>
  );
}
