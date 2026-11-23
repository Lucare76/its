"use client";

import { useState } from "react";
import { getToken } from "@/lib/supabase/client";

type Line = { number: string; date: string; itinerary: string; amount: number; found: boolean };
type Result = { lines: Line[]; supplied_count: number; missing_from_invoice: string[]; error?: string };

export default function MedmarInvoiceComparisonPage() {
  const [invoice, setInvoice] = useState<File | null>(null);
  const [tickets, setTickets] = useState<File[]>([]);
  const [numbers, setNumbers] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function compare() {
    if (!invoice) return setError("Carica la fattura Medmar dettagliata.");
    const token = await getToken(); if (!token) return setError("Sessione non disponibile.");
    setBusy(true); setError(""); setResult(null);
    const form = new FormData(); form.set("invoice", invoice); form.set("numbers", numbers);
    tickets.forEach(ticket => form.append("ticket_pdf", ticket));
    const response = await fetch("/api/ops/medmar-invoice-compare", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
    const data = await response.json() as Result;
    setBusy(false);
    if (!response.ok) setError(data.error ?? "Confronto non riuscito."); else setResult(data);
  }
  return <main className="mx-auto max-w-6xl space-y-5 p-5">
    <a href="/biglietti-medmar" className="text-sm text-blue-700 underline">← Biglietti Medmar</a>
    <h1 className="text-2xl font-bold">Confronto fattura Medmar</h1>
    <p className="text-sm text-slate-600">Il confronto usa i numeri dei biglietti Me…, non il codice prenotazione AG…. La data sulla fattura può essere quella di emissione, diversa da quella del viaggio.</p>
    <section className="rounded-xl border bg-white p-4 space-y-4">
      <label className="block">Fattura dettagliata PDF<input type="file" accept="application/pdf" className="mt-1 block" onChange={e => setInvoice(e.target.files?.[0] ?? null)} /></label>
      <label className="block">PDF dei biglietti da verificare (facoltativi)<input type="file" multiple accept="application/pdf" className="mt-1 block" onChange={e => setTickets(Array.from(e.target.files ?? []))} /></label>
      <label className="block">Oppure incolla i numeri dei biglietti da verificare<textarea className="input-saas mt-1 w-full" rows={3} value={numbers} onChange={e => setNumbers(e.target.value)} placeholder="Me26AG190005689, Me26AG190005690…" /></label>
      <button disabled={busy || !invoice} className="btn-primary" onClick={() => void compare()}>{busy ? "Lettura in corso…" : "Confronta biglietti"}</button>
      <p className="text-xs text-slate-500">Il risultato è temporaneo: conserva i PDF originali per la verifica amministrativa.</p>
    </section>
    {error && <p role="alert" className="text-rose-700">{error}</p>}
    {result && <section className="rounded-xl border bg-white p-4 space-y-3">
      <h2 className="font-semibold">{result.lines.length} righe fattura · {result.supplied_count} biglietti forniti · {result.lines.filter(line => line.found).length} corrispondenti</h2>
      {!!result.missing_from_invoice.length && <p className="font-semibold text-rose-700">Biglietti forniti assenti dalla fattura: {result.missing_from_invoice.join(", ")}</p>}
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>Biglietto</th><th>Data fattura</th><th>Tratta</th><th>Importo</th><th>Esito</th></tr></thead><tbody>
        {result.lines.map((line, index) => <tr key={`${line.number}-${index}`} className="border-t"><td className="font-mono">{line.number}</td><td>{line.date}</td><td>{line.itinerary}</td><td>€{line.amount.toFixed(2)}</td><td className={line.found ? "text-emerald-700" : "text-slate-500"}>{line.found ? "Corrisponde" : "Non fornito per verifica"}</td></tr>)}
      </tbody></table></div>
    </section>}
  </main>;
}
