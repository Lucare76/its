"use client";

import { useCallback, useEffect, useState } from "react";
import { getToken } from "@/lib/supabase/client";

type Fuel = { id: string; vehicle_id: string; fuel_date: string; station: string; invoice_supplier: string;
  cost: number | null; liters: number | null; km_at_fuel: number | null; fuel_type: string | null; notes: string | null };
type CandidateRow = { row: Fuel; amountDifference: number | null; litersDifference: number | null; stationMismatch: boolean };
type Candidate = ({ status: "candidate" } & CandidateRow) |
  { status: "missing" | "ambiguous"; candidates: CandidateRow[] };
type Line = { id: string; line_no: number; fuel_date: string; station: string; liters: number; amount: number;
  reference: string; matched_fuel_id: string | null; manual_match: Fuel | null; proposal: Candidate | null };
type Batch = { id: string; supplier: string; invoice_number: string; filename: string; created_at: string };
type Result = { imports: Batch[]; selected_import?: Batch; lines: Line[]; unbilled_manual?: Fuel[]; error?: string };

export default function FuelReconcilePage() {
  const [supplier, setSupplier] = useState<"ENI" | "UTA">("ENI");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [pdf, setPdf] = useState<File | null>(null);
  const [data, setData] = useState<Result>({ imports: [], lines: [] });
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async (id?: string) => {
    const token = await getToken();
    if (!token) return;
    const res = await fetch(`/api/ops/fuel-invoice-reconciliation${id ? `?import_id=${encodeURIComponent(id)}` : ""}`,
      { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    const result = await res.json() as Result;
    if (!res.ok) return setMessage(result.error ?? "Impossibile caricare il confronto.");
    setData(result); setSelectedId(result.selected_import?.id ?? "");
  }, []);
  useEffect(() => { void Promise.resolve().then(() => refresh()); }, [refresh]);

  async function upload() {
    if (!pdf || !invoiceNumber.trim()) return setMessage("Scegli il PDF e indica il numero della fattura.");
    const token = await getToken(); if (!token) return;
    setBusy(true); setMessage("");
    const form = new FormData();
    form.set("pdf", pdf); form.set("supplier", supplier); form.set("invoice_number", invoiceNumber.trim());
    const res = await fetch("/api/ops/fuel-invoice-reconciliation", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
    const result = await res.json();
    setBusy(false);
    if (!res.ok) return setMessage(result.error ?? "Importazione fallita.");
    setMessage(result.already_imported ? "Questo PDF era già stato importato." : `${result.count} operazioni lette. Controlla le proposte prima di collegarle.`);
    await refresh(result.import_id);
  }

  async function link(line: Line, candidate: CandidateRow) {
    if (candidate.stationMismatch && !window.confirm(`I luoghi sono diversi:\nFattura: ${line.station}\nRegistro: ${candidate.row.station}\n\nData e litri coincidono; l'importo differisce al massimo di 2 centesimi. Hai verificato che è lo stesso rifornimento?`)) return;
    const token = await getToken(); if (!token) return;
    setBusy(true);
    const res = await fetch("/api/ops/fuel-invoice-reconciliation", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "link", line_id: line.id, fuel_id: candidate.row.id }),
    });
    const result = await res.json(); setBusy(false);
    setMessage(res.ok ? "Operazione collegata. Controlla eventuali differenze." : result.error ?? "Collegamento fallito.");
    if (res.ok) await refresh(selectedId);
  }

  async function correct(row: Fuel, line: Line) {
    const raw = window.prompt(`Importo fattura €${Number(line.amount).toFixed(2)}. Importo manuale da correggere:`, String(row.cost ?? ""));
    if (raw === null) return;
    const cost = Number(raw.replace(",", "."));
    if (!raw.trim() || !Number.isFinite(cost) || cost < 0) return setMessage("Importo non valido.");
    const rawLiters = window.prompt(`Litri fattura ${Number(line.liters).toFixed(2)}. Litri manuali da correggere:`, String(row.liters ?? ""));
    if (rawLiters === null) return;
    const liters = Number(rawLiters.replace(",", "."));
    if (!rawLiters.trim() || !Number.isFinite(liters) || liters < 0) return setMessage("Litri non validi.");
    const token = await getToken(); if (!token) return;
    setBusy(true);
    const res = await fetch("/api/ops/fuel-entries", { method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "edit", data: {
        id: row.id, vehicle_id: row.vehicle_id, fuel_date: row.fuel_date,
        liters, cost, km_at_fuel: row.km_at_fuel,
        fuel_type: row.fuel_type, station: row.station, notes: row.notes,
        invoice_supplier: row.invoice_supplier,
      } }),
    });
    const result = await res.json(); setBusy(false);
    setMessage(res.ok ? "Importo e litri aggiornati; i valori precedenti sono nello storico." : result.error ?? "Correzione fallita.");
    if (res.ok) await refresh(selectedId);
  }

  function differences(line: Line, fuel: Fuel) {
    const amountDiff = fuel.cost == null ? null : Number((Number(line.amount) - Number(fuel.cost)).toFixed(2));
    const litersDiff = fuel.liters == null ? null : Number((Number(line.liters) - Number(fuel.liters)).toFixed(2));
    if (amountDiff === 0 && litersDiff === 0) return <span className="text-emerald-700">Importo e litri corrispondono</span>;
    return <span className="font-semibold text-amber-700">Attenzione: ufficio €{fuel.cost ?? "—"} / {fuel.liters ?? "—"} L;
      fattura €{Number(line.amount).toFixed(2)} / {Number(line.liters).toFixed(2)} L.
      {amountDiff != null && ` Differenza €${amountDiff.toFixed(2)}.`}</span>;
  }

  return <main className="mx-auto max-w-6xl space-y-6 p-5">
    <div><a href="/fleet-ops/fuel" className="text-sm text-blue-700 underline">← Rifornimenti</a>
      <h1 className="mt-2 text-2xl font-bold">Confronto fatture carburante</h1>
      <p className="text-sm text-slate-600">Carica la fattura ENI o il dettaglio UTA. Ogni riga si confronta solo con i rifornimenti attribuiti allo stesso fornitore.</p>
    </div>
    <section className="rounded-xl border bg-white p-5 space-y-3">
      <h2 className="font-semibold">Importa documento dettagliato</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <label>Fornitore<select className="input-saas mt-1 w-full" value={supplier} onChange={e => setSupplier(e.target.value as "ENI" | "UTA")}>
          <option value="ENI">ENI</option><option value="UTA">UTA (prospetto operazioni)</option></select></label>
        <label>Numero fattura<input className="input-saas mt-1 w-full" value={invoiceNumber} onChange={e => setInvoiceNumber(e.target.value)} /></label>
        <label>PDF<input className="mt-2 w-full" type="file" accept="application/pdf" onChange={e => setPdf(e.target.files?.[0] ?? null)} /></label>
      </div>
      <button className="btn-primary px-4 py-2 disabled:opacity-50" disabled={busy} onClick={() => void upload()}>Importa e confronta</button>
      <p className="text-xs text-slate-500">Con UTA usa la documentazione posizione singola: il foglio riepilogativo non contiene i singoli rifornimenti. Commissioni escluse.</p>
    </section>
    {message && <p role="status" className="rounded-lg bg-blue-50 p-3 text-sm text-blue-900">{message}</p>}
    <label className="block text-sm font-semibold">Fattura da controllare
      <select className="input-saas mt-1 w-full" value={selectedId} onChange={e => void refresh(e.target.value)}>
        {data.imports.length === 0 && <option value="">Nessuna fattura importata</option>}
        {data.imports.map(batch => <option key={batch.id} value={batch.id}>{batch.supplier} · {batch.invoice_number} · {batch.filename}</option>)}
      </select>
    </label>
    <div className="space-y-3">{data.lines.map(line => {
      const candidates: CandidateRow[] = line.proposal?.status === "candidate" ? [line.proposal]
        : line.proposal && "candidates" in line.proposal ? line.proposal.candidates : [];
      const fuel = line.manual_match;
      return <section key={line.id} className="rounded-xl border bg-white p-4 text-sm">
        <p className="font-semibold">{line.fuel_date} · {line.station} · {Number(line.liters).toFixed(2)} L · €{Number(line.amount).toFixed(2)}</p>
        <p className="text-xs text-slate-500">Documento/operazione: {line.reference}</p>
        {fuel ? <div className="mt-2 space-y-2">
          <p>{differences(line, fuel)}</p>
          {(fuel.cost == null || Math.round(Number(fuel.cost) * 100) !== Math.round(Number(line.amount) * 100) || fuel.liters !== Number(line.liters)) &&
            <button className="text-blue-700 underline disabled:opacity-50" disabled={busy} onClick={() => void correct(fuel, line)}>Correggi registrazione manuale</button>}
        </div> : candidates.length ? <div className="mt-2">
          <p className="font-medium text-amber-800">{candidates.length > 1 ? "Più registrazioni possibili: scegli quella corretta." : "Possibile corrispondenza: verifica prima di collegare."}</p>
          {candidates.map(candidate => <div key={candidate.row.id} className="mt-2 flex flex-wrap items-center gap-3">
            <span>Registro: {candidate.row.station} · €{candidate.row.cost ?? "—"} · {candidate.row.liters ?? "—"} L</span>
            {candidate.stationMismatch && <span className="font-semibold text-amber-700">Luogo scritto diversamente: verifica prima di collegare.</span>}
            <button disabled={busy} onClick={() => void link(line, candidate)} className="rounded-lg border border-blue-300 px-2 py-1 text-blue-700">{candidate.stationMismatch ? "Verifica e collega" : "Collega"}</button>
          </div>)}
        </div> : <p className="mt-2 font-medium text-rose-700">Nessuna registrazione compatibile per questo fornitore e questa data. Controlla se il rifornimento è stato inserito nel registro e verifica litri e importo.</p>}
      </section>;
    })}</div>
    {!!data.unbilled_manual?.length && <section className="rounded-xl border border-amber-200 bg-amber-50 p-4">
      <h2 className="font-semibold text-amber-900">Rifornimenti ufficio senza riga fatturata nel periodo</h2>
      <p className="text-xs text-amber-800">Sono registrazioni dello stesso fornitore non ancora collegate. Controlla anche eventuali altre fatture del periodo.</p>
      {data.unbilled_manual.map(row => <p key={row.id} className="mt-2 text-sm">{row.fuel_date} · {row.station} · €{row.cost ?? "—"} · {row.liters ?? "—"} L</p>)}
    </section>}
  </main>;
}
