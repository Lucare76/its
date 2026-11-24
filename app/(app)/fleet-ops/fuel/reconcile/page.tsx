"use client";

import { useCallback, useEffect, useState } from "react";
import { getToken } from "@/lib/supabase/client";

type Fuel = { id: string; vehicle_id: string; fuel_date: string; station: string; invoice_supplier: string;
  cost: number | null; liters: number | null; km_at_fuel: number | null; fuel_type: string | null; notes: string | null };
type CandidateRow = { row: Fuel; amountDifference: number | null; litersDifference: number | null; stationMismatch: boolean };
type Candidate = ({ status: "candidate" } & CandidateRow) |
  { status: "missing" | "ambiguous"; candidates: CandidateRow[] };
type Line = { id: string; line_no: number; fuel_date: string; station: string; liters: number; amount: number;
  reference: string; matched_fuel_id: string | null; match_method: "auto" | "manual" | "unlinked" | null;
  manual_match: Fuel | null; proposal: Candidate | null };
type Batch = { id: string; supplier: string; invoice_number: string; filename: string; created_at: string;
  status: "open" | "closed"; closed_at: string | null; close_outcome: "ok" | "with_notes" | null; close_note: string | null };
type Summary = {
  lines_count: number; lines_linked: number; invoice_total: number; linked_total: number;
  unlinked_amount: number; linked_difference: number; pending_approval: number; all_match: boolean;
  lines_with_differences: Array<{ line_id: string; line_no: number }>; unlinked_lines: Array<{ line_id: string; line_no: number }>;
  document_conflicts: Array<{ fuel_id: string; fiscal_document_name: string | null }>;
};
type Review = { id: string; event: "closed" | "reopened"; outcome: "ok" | "with_notes" | null; note: string | null;
  invoice_total: number | null; linked_total: number | null; user_name: string | null; created_at: string };
type Permissions = { can_close: boolean; can_reopen: boolean; can_manage_closers: boolean };
type Closer = { user_id: string; full_name: string; enabled: boolean };
type Result = { imports: Batch[]; selected_import?: Batch; lines: Line[]; unbilled_manual?: Fuel[]; auto_linked?: number;
  summary?: Summary; document_name?: string; reviews?: Review[]; permissions?: Permissions; closers?: Closer[]; error?: string };

const euro = (value: number | null | undefined) => value == null ? "—"
  : new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(Number(value));
const dateTime = (value: string) => new Date(value).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
function statusLabel(batch: Batch) {
  if (batch.status !== "closed") return "Da controllare";
  return batch.close_outcome === "ok" ? "Controllata ✓" : "Controllata con note ⚠";
}

export default function FuelReconcilePage() {
  const [supplier, setSupplier] = useState<"ENI" | "UTA">("ENI");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [pdf, setPdf] = useState<File | null>(null);
  const [data, setData] = useState<Result>({ imports: [], lines: [] });
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [closeNote, setCloseNote] = useState("");

  const refresh = useCallback(async (id?: string) => {
    const token = await getToken();
    if (!token) return;
    const res = await fetch(`/api/ops/fuel-invoice-reconciliation${id ? `?import_id=${encodeURIComponent(id)}` : ""}`,
      { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    const result = await res.json() as Result;
    if (!res.ok) return setMessage(result.error ?? "Impossibile caricare il confronto.");
    setData(result); setSelectedId(result.selected_import?.id ?? "");
    return result;
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
    const autoLinked = Number(result.auto_linked ?? 0);
    const autoText = autoLinked > 0 ? ` ${autoLinked} collegate in automatico perché tutto corrisponde.` : "";
    setMessage(result.already_imported
      ? `Questo PDF era già stato importato.${autoText}`
      : `${result.count} operazioni lette.${autoText} Controlla le altre proposte prima di collegarle.`);
    await refresh(result.import_id);
  }

  async function postAction(body: Record<string, unknown>) {
    const token = await getToken(); if (!token) return null;
    setBusy(true);
    const res = await fetch("/api/ops/fuel-invoice-reconciliation", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await res.json().catch(() => ({})); setBusy(false);
    return { ok: res.ok, result };
  }

  async function closeInvoice() {
    const batch = data.selected_import; const summary = data.summary;
    if (!batch || !summary) return;
    if (!summary.all_match && !closeNote.trim()) return setMessage("La fattura non torna del tutto: scrivi una nota che spieghi le differenze.");
    const confirmText = `Segnare la fattura ${batch.supplier} ${batch.invoice_number} come controllata?\n\n`
      + `Fattura ${euro(summary.invoice_total)} · Registro ${euro(summary.linked_total)}\n`
      + "Dopo la chiusura righe e rifornimenti collegati sono bloccati: per correggerli un admin dovrà riaprirla.";
    if (!window.confirm(confirmText)) return;
    const response = await postAction({ action: "close", import_id: batch.id, note: closeNote.trim() || undefined });
    if (!response) return;
    if (!response.ok) return setMessage(response.result.error ?? "Chiusura non riuscita.");
    const written = Number(response.result.documents_written ?? 0);
    const conflicts = Number(response.result.document_conflicts ?? 0);
    setMessage(`Fattura controllata. Documento fiscale scritto su ${written} rifornimenti.`
      + (conflicts ? ` ${conflicts} avevano già un documento diverso: non è stato sovrascritto, controllali.` : ""));
    setCloseNote("");
    await refresh(batch.id);
  }

  async function reopenInvoice() {
    const batch = data.selected_import; if (!batch) return;
    const reason = window.prompt(`Motivo della riapertura della fattura ${batch.supplier} ${batch.invoice_number}:`);
    if (reason === null) return;
    if (reason.trim().length < 5) return setMessage("Scrivi il motivo della riapertura (almeno 5 caratteri).");
    const response = await postAction({ action: "reopen", import_id: batch.id, reason: reason.trim() });
    if (!response) return;
    setMessage(response.ok ? "Fattura riaperta: ora si possono correggere collegamenti e rifornimenti." : response.result.error ?? "Riapertura non riuscita.");
    if (response.ok) await refresh(batch.id);
  }

  async function toggleCloser(closer: Closer) {
    const response = await postAction({ action: "set_closer", user_id: closer.user_id, enabled: !closer.enabled });
    if (!response) return;
    setMessage(response.ok ? `${closer.full_name}: chiusura fatture ${closer.enabled ? "disabilitata" : "abilitata"}.` : response.result.error ?? "Operazione non riuscita.");
    if (response.ok) await refresh(selectedId);
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

  async function unlink(line: Line) {
    if (!window.confirm("Scollegare questa riga dal rifornimento? Non verrà più collegata in automatico: potrai ricollegarla a mano.")) return;
    const token = await getToken(); if (!token) return;
    setBusy(true);
    const res = await fetch("/api/ops/fuel-invoice-reconciliation", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "unlink", line_id: line.id }),
    });
    const result = await res.json(); setBusy(false);
    setMessage(res.ok ? "Riga scollegata." : result.error ?? "Operazione non riuscita.");
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
        {data.imports.map(batch => <option key={batch.id} value={batch.id}>{batch.supplier} · {batch.invoice_number} · {batch.filename} · {statusLabel(batch)}</option>)}
      </select>
    </label>
    {data.selected_import && data.summary && (() => {
      const batch = data.selected_import; const summary = data.summary;
      const closed = batch.status === "closed";
      return <section className={`rounded-xl border p-5 space-y-3 ${closed ? (batch.close_outcome === "ok" ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50") : "bg-white"}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Riepilogo fattura {batch.supplier} {batch.invoice_number}</h2>
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${closed ? (batch.close_outcome === "ok" ? "bg-emerald-600 text-white" : "bg-amber-500 text-white") : "bg-slate-100 text-slate-700"}`}>{statusLabel(batch)}</span>
        </div>
        <dl className="grid gap-3 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-slate-500">Righe collegate</dt><dd className="font-semibold">{summary.lines_linked} su {summary.lines_count}</dd></div>
          <div><dt className="text-xs text-slate-500">Totale fattura (carburante)</dt><dd className="font-semibold">{euro(summary.invoice_total)}</dd></div>
          <div><dt className="text-xs text-slate-500">Totale rifornimenti collegati</dt><dd className="font-semibold">{euro(summary.linked_total)}</dd></div>
          <div><dt className="text-xs text-slate-500">Differenza</dt>
            <dd className={`font-semibold ${Math.abs(summary.invoice_total - summary.linked_total) < 0.005 ? "text-emerald-700" : "text-rose-700"}`}>{euro(summary.invoice_total - summary.linked_total)}</dd></div>
        </dl>
        {!summary.all_match && <ul className="list-disc pl-5 text-sm text-amber-800">
          {summary.unlinked_lines.length > 0 && <li>{summary.unlinked_lines.length} righe senza rifornimento collegato ({euro(summary.unlinked_amount)}): righe {summary.unlinked_lines.map(row => row.line_no).join(", ")}</li>}
          {summary.lines_with_differences.length > 0 && <li>{summary.lines_with_differences.length} righe collegate con importo o litri diversi (differenza {euro(summary.linked_difference)}): righe {summary.lines_with_differences.map(row => row.line_no).join(", ")}</li>}
        </ul>}
        {summary.pending_approval > 0 && <p className="text-sm text-amber-800">{summary.pending_approval} rifornimenti collegati sono ancora da approvare.</p>}
        {summary.document_conflicts.length > 0 && <p className="text-sm text-amber-800">{summary.document_conflicts.length} rifornimenti hanno già un documento fiscale diverso da “{data.document_name}”: alla chiusura non viene sovrascritto.</p>}
        {closed ? <div className="space-y-2 text-sm">
          {batch.closed_at && <p>Chiusa il {dateTime(batch.closed_at)}.{batch.close_note ? ` Nota: ${batch.close_note}` : ""}</p>}
          <p className="text-xs text-slate-600">Righe e rifornimenti collegati sono bloccati.</p>
          {data.permissions?.can_reopen && <button className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold disabled:opacity-50" disabled={busy} onClick={() => void reopenInvoice()}>Riapri fattura</button>}
        </div> : data.permissions?.can_close ? <div className="space-y-2">
          {summary.all_match
            ? <p className="text-sm font-medium text-emerald-700">Tutte le righe sono collegate e corrispondono: puoi segnarla come controllata.</p>
            : <p className="text-sm font-medium text-amber-800">La fattura non torna del tutto: per chiuderla scrivi una nota (es. “riga 7 contestata a ENI”).</p>}
          <textarea className="input-saas w-full text-sm" rows={2} maxLength={2000} value={closeNote}
            placeholder={summary.all_match ? "Nota (facoltativa)" : "Nota obbligatoria: spiega le differenze"} onChange={e => setCloseNote(e.target.value)} />
          <button className="btn-primary px-4 py-2 disabled:opacity-50" disabled={busy || (!summary.all_match && !closeNote.trim())} onClick={() => void closeInvoice()}>Segna come controllata</button>
        </div> : <p className="text-xs text-slate-500">Solo admin e operatori abilitati possono segnare la fattura come controllata.</p>}
        {!!data.reviews?.length && <details className="text-sm"><summary className="cursor-pointer text-slate-600">Storico chiusure e riaperture ({data.reviews.length})</summary>
          <ul className="mt-2 space-y-1">{data.reviews.map(review => <li key={review.id} className="text-slate-700">
            {dateTime(review.created_at)} · {review.event === "closed" ? (review.outcome === "ok" ? "Chiusa ✓" : "Chiusa con note") : "Riaperta"}
            {review.user_name ? ` da ${review.user_name}` : ""}{review.event === "closed" ? ` · fattura ${euro(review.invoice_total)} / registro ${euro(review.linked_total)}` : ""}{review.note ? ` · ${review.note}` : ""}
          </li>)}</ul>
        </details>}
      </section>;
    })()}
    {data.permissions?.can_manage_closers && !!data.closers?.length && <details className="rounded-xl border bg-white p-4 text-sm">
      <summary className="cursor-pointer font-semibold">Operatori abilitati a chiudere le fatture</summary>
      <p className="mt-1 text-xs text-slate-500">Gli admin possono sempre. Gli operatori solo se abilitati qui.</p>
      <ul className="mt-2 space-y-1">{data.closers.map(closer => <li key={closer.user_id}>
        <label className="flex items-center gap-2"><input type="checkbox" checked={closer.enabled} disabled={busy} onChange={() => void toggleCloser(closer)} />{closer.full_name}</label>
      </li>)}</ul>
    </details>}
    <div className="space-y-3">{data.lines.map(line => {
      const candidates: CandidateRow[] = line.proposal?.status === "candidate" ? [line.proposal]
        : line.proposal && "candidates" in line.proposal ? line.proposal.candidates : [];
      const fuel = line.manual_match;
      const locked = data.selected_import?.status === "closed";
      return <section key={line.id} className="rounded-xl border bg-white p-4 text-sm">
        <p className="font-semibold">{line.fuel_date} · {line.station} · {Number(line.liters).toFixed(2)} L · €{Number(line.amount).toFixed(2)}</p>
        <p className="text-xs text-slate-500">Documento/operazione: {line.reference}</p>
        {fuel ? <div className="mt-2 space-y-2">
          <p className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${line.match_method === "auto" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
              {line.match_method === "auto" ? "Collegata automaticamente" : "Collegata"}
            </span>
            <span className="text-slate-600">Registro: {fuel.station} · €{fuel.cost ?? "—"} · {fuel.liters ?? "—"} L</span>
            {!locked && <button className="text-xs text-rose-700 underline disabled:opacity-50" disabled={busy} onClick={() => void unlink(line)}>Scollega</button>}
          </p>
          <p>{differences(line, fuel)}</p>
          {!locked && (fuel.cost == null || Math.round(Number(fuel.cost) * 100) !== Math.round(Number(line.amount) * 100) || fuel.liters !== Number(line.liters)) &&
            <button className="text-blue-700 underline disabled:opacity-50" disabled={busy} onClick={() => void correct(fuel, line)}>Correggi registrazione manuale</button>}
        </div> : candidates.length ? <div className="mt-2">
          {line.match_method === "unlinked" && <p className="text-xs text-slate-500">Scollegata a mano: non viene ricollegata in automatico.</p>}
          <p className="font-medium text-amber-800">{candidates.length > 1 ? "Più registrazioni possibili: scegli quella corretta." : "Possibile corrispondenza: verifica prima di collegare."}</p>
          {candidates.map(candidate => <div key={candidate.row.id} className="mt-2 flex flex-wrap items-center gap-3">
            <span>Registro: {candidate.row.station} · €{candidate.row.cost ?? "—"} · {candidate.row.liters ?? "—"} L</span>
            {candidate.stationMismatch && <span className="font-semibold text-amber-700">Luogo scritto diversamente: verifica prima di collegare.</span>}
            {!locked && <button disabled={busy} onClick={() => void link(line, candidate)} className="rounded-lg border border-blue-300 px-2 py-1 text-blue-700">{candidate.stationMismatch ? "Verifica e collega" : "Collega"}</button>}
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
