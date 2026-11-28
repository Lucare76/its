"use client";
import { useEffect, useState } from "react";
import { timeLabel, timeMinutes, type CollectiveConvocation } from "@/lib/piano-collective-convocations";

type Props = { token: string; date: string; eventKey: string; arrival: string; onLoaded: (key: string, active: boolean) => void };
export function CollectiveConvocationSettings({ token, date, eventKey, arrival, onLoaded }: Props) {
  const [config, setConfig] = useState<CollectiveConvocation | null>(null);
  const [lastDeparture, setLastDeparture] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/ops/piano-giorno/collective-convocations?date=${date}`, {
          headers: { Authorization: `Bearer ${token}` }, signal: abort.signal,
        });
        const body = await response.json();
        if (!response.ok || !body.ok) throw new Error(body.error ?? "Errore convocazione");
        if (abort.signal.aborted) return;
        const saved = (body.convocations as CollectiveConvocation[]).find((entry) => entry.event_key === eventKey) ?? null;
        setConfig(saved);
        setLastDeparture(saved?.last_departure ?? "");
        onLoaded(`${date}:${eventKey}`, saved?.active ?? false);
      } catch (err) {
        if (!abort.signal.aborted) setError(err instanceof Error ? err.message : "Errore caricamento");
      } finally { if (!abort.signal.aborted) setBusy(false); }
    }
    void load();
    return () => abort.abort();
  }, [token, date, eventKey, onLoaded]);
  async function save(active: boolean) {
    setBusy(true); setError(""); setMessage("");
    const next: CollectiveConvocation = { date, event_key: eventKey, active,
      last_departure: active ? lastDeparture : config?.last_departure ?? arrival, margin_min: 25, margin_max: 35 };
    try {
      const response = await fetch("/api/ops/piano-giorno/collective-convocations", {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(next),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error ?? "Errore salvataggio");
      setConfig(next); onLoaded(`${date}:${eventKey}`, active);
      setMessage("Scelta salvata. Ricalcola il piano in Assegnazione Intelligente.");
    } catch (err) { setError(err instanceof Error ? err.message : "Errore salvataggio"); }
    finally { setBusy(false); }
  }
  return <div className="my-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
    <p className="font-bold">{config?.active ? "TUTTI — smistamento di Mario al porto" : "Convoca tutti gli autisti in servizio quel giorno"}</p>
    <p className="mt-1 text-xs">La scelta riguarda solo questo traghetto. Non crea abbinamenti, giri o notifiche agli autisti.</p>
    <label className="mt-3 block">Ultima partenza dei mezzi dal porto
      <input type="time" className="input-saas mt-1 block" value={lastDeparture} disabled={busy}
        onChange={(event) => { setLastDeparture(event.target.value); setError(""); }} />
    </label>
    <p className="mt-2 text-xs">Margine stimato: 25–35 minuti dall’ultima partenza, comprensivo delle consegne.
      {lastDeparture && ` Riferimento: ${timeLabel(timeMinutes(lastDeparture) + 25)}–${timeLabel(timeMinutes(lastDeparture) + 35)}.`}
      {" "}La posizione effettiva degli autisti resta da verificare con Mario.</p>
    <button type="button" className="btn-primary mt-3" disabled={busy || !lastDeparture || Boolean(error && !config)}
      onClick={() => void save(true)}>{busy ? "Attendi…" : config?.active ? "Aggiorna convocazione TUTTI" : "Conferma TUTTI per questo traghetto"}</button>
    {config?.active && <button type="button" className="btn-secondary ml-2 mt-3" disabled={busy} onClick={() => void save(false)}>Annulla TUTTI</button>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
    {message && <p role="status" className="mt-2 text-green-800">{message}</p>}
  </div>;
}
