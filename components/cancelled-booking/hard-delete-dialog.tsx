"use client";

import { useState } from "react";
import { getToken } from "@/lib/supabase/client";

/**
 * Unica implementazione dell'eliminazione definitiva (Inbox e /cancellazioni):
 * motivo obbligatorio, doppio passaggio di conferma e
 * confirmation="ELIMINA_DEFINITIVAMENTE" verso DELETE /api/ops/services/[id]
 * (che resta SOLO admin lato server).
 */

export const HARD_DELETE_REASONS = ["Prenotazione di test", "Inserimento errato", "Altro"] as const;

export function HardDeleteDialog({
  service,
  onClose,
  onDeleted,
}: {
  service: { id: string; label: string };
  onClose: () => void;
  onDeleted: (message: string) => void;
}) {
  const [reason, setReason] = useState<(typeof HARD_DELETE_REASONS)[number]>("Prenotazione di test");
  const [note, setNote] = useState("");
  const [step, setStep] = useState<1 | 2>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    if (step === 1) {
      setStep(2);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) { setError("Sessione scaduta."); return; }
      const res = await fetch(`/api/ops/services/${service.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ reason, note, confirmation: "ELIMINA_DEFINITIVAMENTE" }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(body?.error ?? "Eliminazione definitiva non riuscita.");
        return;
      }
      onDeleted(`Prenotazione di ${service.label} eliminata definitivamente.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl">
        <h2 className="text-lg font-extrabold text-slate-950">Elimina definitivamente</h2>
        <p className="mt-1 text-sm text-rose-700">
          Questa azione rimuove la pratica di {service.label} dal database operativo. Usa questa opzione solo per test o inserimenti errati.
          Non è una normale cancellazione e non è reversibile.
        </p>
        <label className="mt-4 block text-sm font-semibold text-slate-700">
          Motivo*
          <select value={reason} onChange={(event) => setReason(event.target.value as (typeof HARD_DELETE_REASONS)[number])} className="input-saas mt-1 w-full">
            {HARD_DELETE_REASONS.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label className="mt-3 block text-sm font-semibold text-slate-700">
          Note
          <textarea value={note} onChange={(event) => setNote(event.target.value)} className="input-saas mt-1 min-h-[90px] w-full" placeholder={reason === "Altro" ? "Obbligatorio per Altro..." : "Dettaglio facoltativo..."} />
        </label>
        {step === 2 ? (
          <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800">
            Conferma finale: dopo questo click la prenotazione verrà eliminata definitivamente.
          </p>
        ) : null}
        {error ? <p className="mt-3 text-sm text-rose-600">{error}</p> : null}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-secondary px-4 py-2 text-sm" onClick={onClose} disabled={busy}>Annulla</button>
          <button type="button" className="btn-primary bg-rose-600 px-4 py-2 text-sm hover:bg-rose-700" onClick={() => void submit()} disabled={busy}>
            {busy ? "Eliminazione..." : step === 1 ? "Continua" : "Elimina definitivamente"}
          </button>
        </div>
      </div>
    </div>
  );
}
