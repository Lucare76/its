"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

type CancellationRequest = {
  id: string;
  cancel_legs: "arrival" | "departure" | "both";
  status: string;
  penalty_cents: number | null;
  penalty_note: string | null;
  service: {
    customer_name: string;
    pax: number;
    hotel_name: string;
    arrival_date: string | null;
    departure_date: string | null;
    arrival_time: string | null;
  };
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return iso.split("-").reverse().join("/");
}

function formatEur(cents: number): string {
  return (cents / 100).toLocaleString("it-IT", { style: "currency", currency: "EUR" });
}

function legLabel(legs: string): string {
  if (legs === "arrival") return "Solo andata";
  if (legs === "departure") return "Solo ritorno";
  return "Intero servizio (andata + ritorno)";
}

export default function CancellationResponsePage() {
  const params = useParams();
  const token = params.token as string;

  const [crData, setCrData] = useState<CancellationRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [action, setAction] = useState<"accept" | "reject" | "counter" | null>(null);
  const [counterEur, setCounterEur] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<"accepted" | "rejected" | "counter" | null>(null);

  useEffect(() => {
    // Legge ?action= dalla URL (click diretto dai bottoni email)
    const searchParams = new URLSearchParams(window.location.search);
    const urlAction = searchParams.get("action") as "accept" | "reject" | "counter" | null;
    if (urlAction) setAction(urlAction);

    fetch(`/api/cancel-respond/info?token=${token}`)
      .then((r) => r.json())
      .then((body: { ok: boolean; data?: CancellationRequest; error?: string }) => {
        if (!body.ok || !body.data) { setError(body.error ?? "Richiesta non trovata."); return; }
        setCrData(body.data);
      })
      .catch(() => setError("Errore di rete."))
      .finally(() => setLoading(false));
  }, [token]);

  const submit = async () => {
    if (!action) return;
    setSubmitting(true);
    setError(null);
    try {
      const counterCents = action === "counter" && counterEur
        ? Math.round(Number(counterEur.replace(",", ".")) * 100)
        : undefined;
      const res = await fetch("/api/cancel-respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action, counter_cents: counterCents, note: note.trim() || undefined }),
      });
      const body = await res.json() as { ok: boolean; error?: string };
      if (!body.ok) { setError(body.error ?? "Errore nell'invio."); return; }
      const doneMap = { accept: "accepted", reject: "rejected", counter: "counter" } as const;
      setDone(doneMap[action]);
    } catch {
      setError("Errore di rete. Riprova.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <p className="text-slate-500 text-sm">Caricamento...</p>
      </div>
    );
  }

  if (error && !crData) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full rounded-2xl border border-rose-200 bg-white p-8 text-center shadow-sm">
          <p className="text-2xl mb-3">⚠️</p>
          <h1 className="text-lg font-semibold text-slate-800 mb-2">Link non valido</h1>
          <p className="text-sm text-slate-500">{error}</p>
        </div>
      </div>
    );
  }

  if (done) {
    const messages = {
      accepted: { icon: "✅", title: "Risposta inviata", body: "Hai accettato la cancellazione. L'operatore è stato notificato." },
      rejected: { icon: "❌", title: "Rifiuto inviato", body: "Hai rifiutato la penale. L'operatore valuterà e ti ricontatterà." },
      counter: { icon: "💬", title: "Controproposta inviata", body: "L'operatore ha ricevuto la tua proposta e ti farà sapere." },
    };
    const msg = messages[done];
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm space-y-3">
          <p className="text-4xl">{msg.icon}</p>
          <h1 className="text-lg font-semibold text-slate-800">{msg.title}</h1>
          <p className="text-sm text-slate-500">{msg.body}</p>
          <p className="text-xs text-slate-400 pt-2">Ischia Transfer Service</p>
        </div>
      </div>
    );
  }

  if (crData?.status !== "pending_agency_approval") {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <p className="text-2xl mb-3">ℹ️</p>
          <h1 className="text-lg font-semibold text-slate-800 mb-2">Richiesta già gestita</h1>
          <p className="text-sm text-slate-500">Questa richiesta di cancellazione è già stata elaborata.</p>
        </div>
      </div>
    );
  }

  const cr = crData!;
  const penaltyEur = cr.penalty_cents && cr.penalty_cents > 0 ? formatEur(cr.penalty_cents) : null;

  return (
    <div className="min-h-screen bg-slate-50 flex items-start justify-center p-4 pt-12">
      <div className="max-w-lg w-full space-y-4">
        {/* Header */}
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-4">
            <span className="text-2xl">🚢</span>
            <div>
              <h1 className="text-lg font-bold text-slate-800">Ischia Transfer Service</h1>
              <p className="text-xs text-slate-500">Richiesta di cancellazione</p>
            </div>
          </div>

          {/* Dettagli servizio */}
          <div className="rounded-xl border border-slate-100 bg-slate-50 divide-y divide-slate-100 text-sm mb-4">
            <div className="flex justify-between px-4 py-2.5">
              <span className="text-slate-500 font-medium">Cliente</span>
              <span className="font-semibold text-slate-800 uppercase">{cr.service.customer_name}</span>
            </div>
            <div className="flex justify-between px-4 py-2.5">
              <span className="text-slate-500 font-medium">Hotel</span>
              <span className="font-semibold text-slate-800 uppercase">{cr.service.hotel_name}</span>
            </div>
            <div className="flex justify-between px-4 py-2.5">
              <span className="text-slate-500 font-medium">Data arrivo</span>
              <span className="font-semibold text-slate-800">{formatDate(cr.service.arrival_date)}{cr.service.arrival_time ? ` · ${cr.service.arrival_time.slice(0, 5)}` : ""}</span>
            </div>
            {cr.service.departure_date && (
              <div className="flex justify-between px-4 py-2.5">
                <span className="text-slate-500 font-medium">Data rientro</span>
                <span className="font-semibold text-slate-800">{formatDate(cr.service.departure_date)}</span>
              </div>
            )}
            <div className="flex justify-between px-4 py-2.5">
              <span className="text-slate-500 font-medium">Passeggeri</span>
              <span className="font-semibold text-slate-800">{cr.service.pax}</span>
            </div>
            <div className="flex justify-between px-4 py-2.5">
              <span className="text-slate-500 font-medium">Tratta</span>
              <span className="font-semibold text-slate-800">{legLabel(cr.cancel_legs)}</span>
            </div>
          </div>

          {/* Penale */}
          {penaltyEur ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 mb-1">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-rose-700">Penale richiesta</span>
                <span className="text-xl font-bold text-rose-700">{penaltyEur}</span>
              </div>
              {cr.penalty_note && <p className="text-xs text-rose-500 mt-1">{cr.penalty_note}</p>}
              <p className="text-xs text-rose-400 mt-1">Sarà addebitata sull&apos;estratto conto solo dopo la tua approvazione.</p>
            </div>
          ) : (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 mb-1">
              <p className="text-sm font-semibold text-emerald-700">Nessuna penale applicata</p>
            </div>
          )}
        </div>

        {/* Risposta */}
        {!action ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-3">
            <h2 className="text-sm font-semibold text-slate-700">La tua risposta</h2>
            <button
              onClick={() => setAction("accept")}
              className="w-full rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700 hover:bg-emerald-100 transition text-left"
            >
              ✓ Accetto la cancellazione{penaltyEur ? ` con penale di ${penaltyEur}` : " senza penale"}
            </button>
            {penaltyEur && (
              <button
                onClick={() => setAction("counter")}
                className="w-full rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-700 hover:bg-amber-100 transition text-left"
              >
                💬 Propongo un importo diverso
              </button>
            )}
            <button
              onClick={() => setAction("reject")}
              className="w-full rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700 hover:bg-rose-100 transition text-left"
            >
              ✗ Rifiuto la penale
            </button>
          </div>
        ) : (
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
            <div className="flex items-center gap-2">
              <button onClick={() => setAction(null)} className="text-slate-400 hover:text-slate-600 text-lg leading-none">←</button>
              <h2 className="text-sm font-semibold text-slate-700">
                {action === "accept" && "Conferma accettazione"}
                {action === "reject" && "Conferma rifiuto"}
                {action === "counter" && "Proponi importo diverso"}
              </h2>
            </div>

            {action === "counter" && (
              <label className="block text-sm font-medium text-slate-700">
                Importo proposto (€)
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Es. 50.00"
                  value={counterEur}
                  onChange={(e) => setCounterEur(e.target.value)}
                  className="mt-1 block w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none"
                />
              </label>
            )}

            <label className="block text-sm font-medium text-slate-700">
              Note (facoltativo)
              <textarea
                rows={3}
                placeholder="Aggiungi una nota per l'operatore..."
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="mt-1 block w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none resize-none"
              />
            </label>

            {error && <p className="text-sm text-rose-600">{error}</p>}

            <button
              onClick={() => void submit()}
              disabled={submitting || (action === "counter" && !counterEur)}
              className="w-full rounded-xl bg-slate-800 py-3 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50 transition"
            >
              {submitting ? "Invio in corso..." : "Invia risposta"}
            </button>
          </div>
        )}

        <p className="text-center text-xs text-slate-400 pb-8">Ischia Transfer Service — per assistenza contatta il tuo operatore</p>
      </div>
    </div>
  );
}
