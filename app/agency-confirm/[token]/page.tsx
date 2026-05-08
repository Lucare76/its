"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

type ServiceData = {
  id: string;
  customer_name: string;
  pax: number;
  arrival_date: string;
  arrival_time: string;
  departure_date: string;
  departure_time: string;
  hotel_name: string;
  service_label: string;
  notes: string;
};

type PageState =
  | { kind: "loading" }
  | { kind: "error"; message: string; already_responded?: boolean; response?: string }
  | { kind: "ready"; service: ServiceData; price_cents: number | null }
  | { kind: "done"; response: "accepted" | "changes_requested" };

function fmt(cents: number) {
  return `€${(cents / 100).toFixed(2).replace(".", ",")}`;
}
function fmtDate(iso: string) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export default function AgencyConfirmPage() {
  const params = useParams();
  const token = typeof params.token === "string" ? params.token : Array.isArray(params.token) ? params.token[0] : "";

  const [state, setState] = useState<PageState>(token ? { kind: "loading" } : { kind: "error", message: "Link non valido." });
  const [responseStep, setResponseStep] = useState<"accepted" | "changes_requested" | null>(null);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/agency/confirm/${token}`)
      .then((r) => r.json())
      .then((body) => {
        if (!body.ok) {
          setState({ kind: "error", message: body.error ?? "Link non valido.", already_responded: body.already_responded, response: body.response });
        } else {
          setState({ kind: "ready", service: body.service, price_cents: body.price_cents });
        }
      })
      .catch(() => setState({ kind: "error", message: "Errore di rete." }));
  }, [token]);

  const submit = async (response: "accepted" | "changes_requested") => {
    setSubmitting(true);
    const res = await fetch(`/api/agency/confirm/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response, notes: notes.trim() || undefined }),
    });
    const body = await res.json().catch(() => null);
    setSubmitting(false);
    if (!res.ok || !body?.ok) { alert(body?.error ?? "Errore."); return; }
    setState({ kind: "done", response });
    setResponseStep(null);
  };

  if (state.kind === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-slate-500 text-sm">Caricamento…</p>
      </div>
    );
  }

  if (state.kind === "error") {
    const icon = state.already_responded ? (state.response === "accepted" ? "✅" : "✏️") : "⚠️";
    const title = state.already_responded ? "Risposta già registrata" : "Link non valido";
    const subtitle = state.already_responded
      ? state.response === "accepted"
        ? "Hai già confermato l'accettazione di questa prenotazione."
        : "Hai già richiesto modifiche per questa prenotazione."
      : state.message;
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-sm border border-slate-200 text-center space-y-3">
          <div className="text-4xl">{icon}</div>
          <h1 className="text-lg font-bold text-slate-800">{title}</h1>
          <p className="text-slate-500 text-sm">{subtitle}</p>
        </div>
      </div>
    );
  }

  if (state.kind === "done") {
    const accepted = state.response === "accepted";
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-sm border border-slate-200 text-center space-y-3">
          <div className="text-5xl">{accepted ? "✅" : "✏️"}</div>
          <h1 className="text-xl font-bold text-slate-800">{accepted ? "Accettazione registrata" : "Richiesta di modifica inviata"}</h1>
          <p className="text-slate-500 text-sm">
            {accepted
              ? "Grazie. La tua conferma è stata registrata correttamente."
              : "La tua richiesta di modifica è stata inviata. L'operatore ti contatterà a breve."}
          </p>
        </div>
      </div>
    );
  }

  const { service, price_cents } = state;

  return (
    <div className="min-h-screen bg-slate-50 py-10 px-4">
      <div className="mx-auto max-w-lg space-y-5">

        <div className="text-center space-y-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Ischia Transfer Service</p>
          <h1 className="text-2xl font-bold text-slate-800">Conferma prenotazione</h1>
          <p className="text-sm text-slate-500">Verifica i dettagli e accetta o richiedi modifiche</p>
        </div>

        {/* Riepilogo servizio */}
        <div className="rounded-2xl bg-white border border-slate-200 p-5 shadow-sm space-y-4">
          <div className="rounded-xl bg-slate-800 px-5 py-4 text-white">
            <p className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-1">Servizio confermato</p>
            <p className="text-lg font-bold leading-snug">{service.service_label}</p>
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
            <div>
              <dt className="text-xs text-slate-400 font-medium uppercase tracking-wide">Hotel</dt>
              <dd className="font-semibold text-slate-800">{service.hotel_name}</dd>
            </div>
          </dl>

          {service.notes && (
            <div className="rounded-lg bg-slate-50 border border-slate-200 px-4 py-3 text-sm text-slate-600">
              <span className="font-semibold text-slate-700">Note: </span>{service.notes}
            </div>
          )}
        </div>

        {/* Prezzo */}
        {price_cents != null && (
          <div className="rounded-2xl bg-white border border-slate-200 p-5 shadow-sm">
            <h2 className="font-bold text-slate-800 mb-2">Prezzo confermato</h2>
            <p className="text-3xl font-extrabold text-emerald-700">{fmt(price_cents)}</p>
            <p className="text-xs text-slate-400 mt-1">IVA e commissioni incluse secondo il contratto vigente.</p>
          </div>
        )}

        {/* Azioni */}
        {responseStep === null ? (
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setResponseStep("changes_requested")}
              disabled={submitting}
              className="rounded-xl border-2 border-amber-200 bg-amber-50 px-4 py-3 font-bold text-amber-700 hover:bg-amber-100 disabled:opacity-50 transition-colors"
            >
              ✏️ Richiedo modifiche
            </button>
            <button
              type="button"
              onClick={() => setResponseStep("accepted")}
              disabled={submitting}
              className="rounded-xl bg-emerald-600 px-4 py-3 font-bold text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
            >
              ✅ Accetto
            </button>
          </div>
        ) : (
          <div className="rounded-2xl border-2 border-slate-200 bg-white p-5 space-y-3">
            <p className="font-semibold text-slate-800">
              {responseStep === "accepted" ? "Confermi l'accettazione?" : "Richiedi modifiche"}
            </p>
            {responseStep === "changes_requested" && (
              <textarea
                rows={3}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300"
                placeholder="Descrivi le modifiche richieste (facoltativo)"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            )}
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setResponseStep(null)}
                disabled={submitting}
                className="flex-1 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Annulla
              </button>
              <button
                type="button"
                onClick={() => void submit(responseStep)}
                disabled={submitting}
                className={`flex-1 rounded-xl px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50 transition-colors ${responseStep === "accepted" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-amber-500 hover:bg-amber-600"}`}
              >
                {submitting ? "Invio…" : "Sì, conferma"}
              </button>
            </div>
          </div>
        )}

        <p className="text-center text-xs text-slate-400">Ischia Transfer Service · questo link è monouso</p>
      </div>
    </div>
  );
}
