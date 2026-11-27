"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase, getToken } from "@/lib/supabase/client";
import { DateInput } from "@/components/ui";

type Device = { id: string; device_code: string; contract_ref: string | null; assigned_on: string; removed_on: string | null; note: string | null; shared_vehicle_ids?: string[] };
type Invoice = {
  id: string; device_id: string | null; invoice_number: string; invoice_date: string;
  period_from: string | null; period_to: string | null; amount: number | null; note: string | null;
  document_path: string | null; document_name: string | null;
};
type Card = { id: string; label: string; last_four: string | null; supplier: string | null; assigned_vehicle_id: string | null };
type CardHistory = { id: string; card_id: string; assigned_at: string; returned_at: string | null };
type VehicleRef = { id: string; label: string | null; plate: string | null };

const MAX_BYTES = 10 * 1024 * 1024;
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString("it-IT") : "—");
const fmtMoney = (value: number | null) => (value == null ? "—" : Number(value).toLocaleString("it-IT", { style: "currency", currency: "EUR" }));
const parseAmount = (raw: string) => (raw.trim() ? Number(raw.replace(",", ".")) : null);

export function VehicleTelepassCards({ vehicleId, onMessage }: { vehicleId: string; onMessage: (text: string, ok: boolean) => void }) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [decommissioned, setDecommissioned] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [cardHistory, setCardHistory] = useState<CardHistory[]>([]);
  const [vehicles, setVehicles] = useState<VehicleRef[]>([]);
  const [year, setYear] = useState("");

  const [deviceForm, setDeviceForm] = useState({ device_code: "", contract_ref: "", assigned_on: today(), note: "" });
  const [invoiceForm, setInvoiceForm] = useState({ invoice_number: "", invoice_date: today(), period_from: "", period_to: "", amount: "", device_id: "", note: "" });
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
  const [cardChoice, setCardChoice] = useState("");
  const [newCard, setNewCard] = useState({ label: "", supplier: "UTA", last_four: "" });

  const call = useCallback(async (action: string, data: Record<string, unknown>) => {
    const token = await getToken();
    if (!token) return { ok: false, json: { error: "Sessione scaduta." } as Record<string, unknown> };
    const res = await fetch("/api/ops/vehicle-telepass", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, data }),
    });
    return { ok: res.ok, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }, []);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const res = await fetch(`/api/ops/vehicle-telepass?vehicle_id=${vehicleId}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { onMessage(json.error ?? "Caricamento non riuscito.", false); setLoading(false); return; }
    setDecommissioned(Boolean(json.decommissioned));
    setDevices(json.devices ?? []); setInvoices(json.invoices ?? []); setCards(json.cards ?? []);
    setCardHistory(json.card_history ?? []); setVehicles(json.vehicles ?? []);
    setLoading(false);
  }, [onMessage, vehicleId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- caricamento iniziale dei dati
  useEffect(() => { void load(); }, [load]);

  const vehicleName = useCallback((id: string | null) => {
    const v = vehicles.find((item) => item.id === id);
    return v ? [v.label, v.plate].filter(Boolean).join(" · ") : "altro mezzo";
  }, [vehicles]);
  const activeDevices = devices.filter((d) => !d.removed_on);
  const myCards = cards.filter((c) => c.assigned_vehicle_id === vehicleId);
  const otherCards = cards.filter((c) => c.assigned_vehicle_id !== vehicleId);
  const years = useMemo(() => [...new Set(invoices.map((i) => i.invoice_date.slice(0, 4)))].sort().reverse(), [invoices]);
  const visibleInvoices = year ? invoices.filter((i) => i.invoice_date.startsWith(year)) : invoices;
  const visibleTotal = visibleInvoices.reduce((sum, i) => sum + (i.amount ?? 0), 0);
  const cardLabel = (c: Card) => `${c.label}${c.supplier ? ` · ${c.supplier}` : ""}${c.last_four ? ` · ****${c.last_four}` : ""}`;

  async function run(action: string, data: Record<string, unknown>, success: string) {
    setBusy(true);
    const result = await call(action, data);
    setBusy(false);
    onMessage(result.ok ? success : String(result.json.error ?? "Operazione non riuscita."), result.ok);
    if (result.ok) await load();
    return result;
  }

  async function uploadFile(invoiceId: string, file: File): Promise<boolean> {
    if (!supabase) return false;
    if (file.size > MAX_BYTES) { onMessage("File troppo grande (massimo 10 MB).", false); return false; }
    const signed = await call("invoice_upload_url", { id: invoiceId, file_name: file.name, content_type: file.type || "application/octet-stream", size: file.size });
    if (!signed.ok) { onMessage(String(signed.json.error ?? "Caricamento non disponibile."), false); return false; }
    const path = String(signed.json.path);
    const { error } = await supabase.storage.from("vehicle-documents").uploadToSignedUrl(path, String(signed.json.token), file, { contentType: file.type });
    if (error) { onMessage(`Caricamento fallito: ${error.message}`, false); return false; }
    const attached = await call("invoice_attach", { id: invoiceId, path, file_name: file.name });
    if (!attached.ok) { onMessage(String(attached.json.error ?? "Allegato non salvato."), false); return false; }
    return true;
  }

  async function addDevice() {
    const result = await run("device_add", { ...deviceForm, vehicle_id: vehicleId }, "Telepass aggiunto.");
    if (result.ok) setDeviceForm({ device_code: "", contract_ref: "", assigned_on: today(), note: "" });
  }

  async function removeDevice(device: Device) {
    const when = window.prompt(`Data in cui il Telepass ${device.device_code} è stato tolto dal mezzo (AAAA-MM-GG):`, today());
    if (!when) return;
    await run("device_remove", { id: device.id, removed_on: when.trim() }, "Telepass tolto dal mezzo.");
  }

  async function addInvoice() {
    const amount = parseAmount(invoiceForm.amount);
    if (amount !== null && !Number.isFinite(amount)) { onMessage("Importo non valido.", false); return; }
    setBusy(true);
    const created = await call("invoice_create", {
      vehicle_id: vehicleId, invoice_number: invoiceForm.invoice_number, invoice_date: invoiceForm.invoice_date,
      period_from: invoiceForm.period_from || null, period_to: invoiceForm.period_to || null,
      amount, device_id: invoiceForm.device_id || null, note: invoiceForm.note,
    });
    if (!created.ok) { setBusy(false); onMessage(String(created.json.error ?? "Fattura non salvata."), false); return; }
    const uploaded = invoiceFile ? await uploadFile(String(created.json.id), invoiceFile) : true;
    setBusy(false);
    if (uploaded) onMessage("Fattura Telepass salvata.", true);
    else onMessage("Fattura salvata, ma il file non è stato allegato: riprova con «Allega».", false);
    setInvoiceForm({ invoice_number: "", invoice_date: today(), period_from: "", period_to: "", amount: "", device_id: invoiceForm.device_id, note: "" });
    setInvoiceFile(null);
    await load();
  }

  async function attachTo(invoice: Invoice, file: File | undefined) {
    if (!file) return;
    setBusy(true);
    const ok = await uploadFile(invoice.id, file);
    setBusy(false);
    if (ok) { onMessage("File allegato.", true); await load(); }
  }

  async function openInvoice(invoice: Invoice) {
    const result = await call("invoice_open", { id: invoice.id });
    if (!result.ok) { onMessage(String(result.json.error ?? "File non disponibile."), false); return; }
    window.open(String(result.json.url), "_blank", "noopener");
  }

  async function deleteInvoice(invoice: Invoice) {
    if (!window.confirm(`Eliminare la fattura ${invoice.invoice_number}${invoice.document_path ? " e il file allegato" : ""}? Non si può annullare.`)) return;
    await run("invoice_delete", { id: invoice.id }, "Fattura eliminata.");
  }

  async function assignCard() {
    const card = cards.find((c) => c.id === cardChoice);
    if (!card) return;
    if (card.assigned_vehicle_id && !window.confirm(`La carta ${card.label} ora è su ${vehicleName(card.assigned_vehicle_id)}. Spostarla su questo mezzo?`)) return;
    const result = await run("card_assign", { card_id: card.id, vehicle_id: vehicleId }, "Carta abbinata al mezzo.");
    if (result.ok) setCardChoice("");
  }

  async function createCard() {
    const result = await run("card_create", { vehicle_id: vehicleId, label: newCard.label, supplier: newCard.supplier, last_four: newCard.last_four || null },
      "Carta creata e abbinata.");
    if (result.ok) setNewCard({ label: "", supplier: newCard.supplier, last_four: "" });
  }

  if (loading) return <div className="py-10 text-center text-sm text-slate-400">Caricamento…</div>;

  const box = "rounded-xl border border-slate-200 bg-white p-4 sm:p-5";
  const input = "input-saas mt-1 w-full";
  const label = "text-xs font-semibold text-slate-500";
  const btn = "inline-flex min-h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold disabled:opacity-50";

  return (
    <div className="space-y-5">
      {decommissioned ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">Mezzo dismesso: si possono consultare e caricare fatture, non aggiungere Telepass o carte.</p>
      ) : null}

      {/* Telepass */}
      <div className={box}>
        <h3 className="text-sm font-bold text-slate-700">Telepass</h3>
        <p className="mt-1 text-xs text-slate-500">Un apparato può essere abbinato al massimo a due targhe.</p>
        {activeDevices.length === 0 ? <p className="mt-2 text-sm text-slate-500">Nessun Telepass attivo su questo mezzo.</p> : (
          <ul className="mt-3 divide-y divide-slate-100">
            {activeDevices.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div>
                  <p className="font-mono text-sm font-semibold text-slate-900">{d.device_code}</p>
                  <p className="text-xs text-slate-500">Dal {fmtDate(d.assigned_on)}{d.contract_ref ? ` · contratto ${d.contract_ref}` : ""}{d.note ? ` · ${d.note}` : ""}</p>
                  {d.shared_vehicle_ids && d.shared_vehicle_ids.length > 0 ? (
                    <p className="text-xs font-medium text-blue-700">Abbinato anche a: {d.shared_vehicle_ids.map((id) => vehicleName(id)).join(", ")}</p>
                  ) : null}
                </div>
                <button type="button" disabled={busy} onClick={() => void removeDevice(d)} className={`${btn} border border-slate-200 text-slate-600 hover:bg-slate-50`}>Togli dal mezzo</button>
              </li>
            ))}
          </ul>
        )}
        {!decommissioned ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            <label className={label}>Codice dispositivo *
              <input className={input} value={deviceForm.device_code} placeholder="Es. 1234567890"
                onChange={(e) => setDeviceForm((f) => ({ ...f, device_code: e.target.value }))} />
            </label>
            <label className={label}>Contratto (facoltativo)
              <input className={input} value={deviceForm.contract_ref} onChange={(e) => setDeviceForm((f) => ({ ...f, contract_ref: e.target.value }))} />
            </label>
            <label className={label}>Montato dal *
              <DateInput className={input} value={deviceForm.assigned_on} onChange={(iso) => setDeviceForm((f) => ({ ...f, assigned_on: iso }))} />
            </label>
            <div className="flex items-end">
              <button type="button" disabled={busy || deviceForm.device_code.trim().length < 4 || !deviceForm.assigned_on} onClick={() => void addDevice()}
                className={`${btn} w-full bg-blue-600 text-white hover:bg-blue-700`}>Aggiungi Telepass</button>
            </div>
          </div>
        ) : null}
        {devices.some((d) => d.removed_on) ? (
          <details className="mt-3 text-xs text-slate-500">
            <summary className="cursor-pointer font-semibold">Storico dispositivi</summary>
            <ul className="mt-2 space-y-1">
              {devices.filter((d) => d.removed_on).map((d) => (
                <li key={d.id}><span className="font-mono">{d.device_code}</span> · {fmtDate(d.assigned_on)} → {fmtDate(d.removed_on)}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>

      {/* Fatture Telepass */}
      <div className={box}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-700">Fatture Telepass</h3>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <select className="input-saas" value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="">Tutti gli anni</option>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <span className="font-semibold text-slate-700">Totale {fmtMoney(visibleTotal)}</span>
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <label className={label}>N. fattura *
            <input className={input} value={invoiceForm.invoice_number} onChange={(e) => setInvoiceForm((f) => ({ ...f, invoice_number: e.target.value }))} />
          </label>
          <label className={label}>Data fattura *
            <DateInput className={input} value={invoiceForm.invoice_date} onChange={(iso) => setInvoiceForm((f) => ({ ...f, invoice_date: iso }))} />
          </label>
          <label className={label}>Periodo dal
            <DateInput className={input} value={invoiceForm.period_from} onChange={(iso) => setInvoiceForm((f) => ({ ...f, period_from: iso }))} />
          </label>
          <label className={label}>Periodo al
            <DateInput className={input} value={invoiceForm.period_to} onChange={(iso) => setInvoiceForm((f) => ({ ...f, period_to: iso }))} />
          </label>
          <label className={label}>Importo (€)
            <input className={input} inputMode="decimal" value={invoiceForm.amount} placeholder="Es. 42,50" onChange={(e) => setInvoiceForm((f) => ({ ...f, amount: e.target.value }))} />
          </label>
          <label className={label}>Dispositivo
            <select className={input} value={invoiceForm.device_id} onChange={(e) => setInvoiceForm((f) => ({ ...f, device_id: e.target.value }))}>
              <option value="">—</option>
              {devices.map((d) => <option key={d.id} value={d.id}>{d.device_code}{d.removed_on ? " (tolto)" : ""}</option>)}
            </select>
          </label>
          <label className={`${label} sm:col-span-2 lg:col-span-3`}>File fattura (PDF o foto, max 10 MB)
            <input className={input} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => setInvoiceFile(e.target.files?.[0] ?? null)} />
          </label>
          <label className={`${label} sm:col-span-1 lg:col-span-2`}>Nota
            <input className={input} value={invoiceForm.note} onChange={(e) => setInvoiceForm((f) => ({ ...f, note: e.target.value }))} />
          </label>
          <div className="flex items-end">
            <button type="button" disabled={busy || !invoiceForm.invoice_number.trim() || !invoiceForm.invoice_date} onClick={() => void addInvoice()}
              className={`${btn} w-full bg-blue-600 text-white hover:bg-blue-700`}>Salva fattura</button>
          </div>
        </div>
        {visibleInvoices.length === 0 ? <p className="mt-4 text-sm text-slate-500">Nessuna fattura{year ? ` nel ${year}` : ""}.</p> : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead><tr className="border-b border-slate-200 text-left text-[11px] uppercase text-slate-400">
                <th className="py-2 pr-3">Fattura</th><th className="py-2 pr-3">Data</th><th className="py-2 pr-3">Periodo</th>
                <th className="py-2 pr-3 text-right">Importo</th><th className="py-2 pr-3">File</th><th className="py-2" />
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {visibleInvoices.map((inv) => (
                  <tr key={inv.id}>
                    <td className="py-2 pr-3 font-semibold text-slate-900">{inv.invoice_number}{inv.note ? <span className="block text-xs font-normal text-slate-500">{inv.note}</span> : null}</td>
                    <td className="py-2 pr-3">{fmtDate(inv.invoice_date)}</td>
                    <td className="py-2 pr-3 text-slate-600">{inv.period_from || inv.period_to ? `${fmtDate(inv.period_from)} → ${fmtDate(inv.period_to)}` : "—"}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{fmtMoney(inv.amount)}</td>
                    <td className="py-2 pr-3">
                      {inv.document_path ? (
                        <button type="button" onClick={() => void openInvoice(inv)} className="text-blue-700 underline">Apri</button>
                      ) : (
                        <label className="cursor-pointer text-amber-700 underline">Allega
                          <input type="file" className="hidden" accept="application/pdf,image/jpeg,image/png,image/webp" disabled={busy}
                            onChange={(e) => void attachTo(inv, e.target.files?.[0])} />
                        </label>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <button type="button" disabled={busy} onClick={() => void deleteInvoice(inv)} className="text-xs text-rose-600 hover:underline">Elimina</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Carte carburante */}
      <div className={box}>
        <h3 className="text-sm font-bold text-slate-700">Carte carburante</h3>
        <p className="mt-1 text-xs text-slate-500">Solo nome e ultime 4 cifre: mai numero completo o PIN.</p>
        {myCards.length === 0 ? <p className="mt-2 text-sm text-slate-500">Nessuna carta abbinata.</p> : (
          <ul className="mt-3 divide-y divide-slate-100">
            {myCards.map((c) => {
              const since = cardHistory.find((h) => h.card_id === c.id && !h.returned_at)?.assigned_at;
              return (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{cardLabel(c)}</p>
                    {since ? <p className="text-xs text-slate-500">Abbinata dal {fmtDate(since)}</p> : null}
                  </div>
                  <button type="button" disabled={busy} onClick={() => void run("card_assign", { card_id: c.id, vehicle_id: null }, "Carta tolta dal mezzo.")}
                    className={`${btn} border border-slate-200 text-slate-600 hover:bg-slate-50`}>Togli dal mezzo</button>
                </li>
              );
            })}
          </ul>
        )}
        {!decommissioned ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="flex flex-wrap items-end gap-2">
              <label className={`${label} min-w-0 flex-1`}>Abbina una carta esistente
                <select className={input} value={cardChoice} onChange={(e) => setCardChoice(e.target.value)}>
                  <option value="">Seleziona…</option>
                  {otherCards.map((c) => <option key={c.id} value={c.id}>{cardLabel(c)}{c.assigned_vehicle_id ? ` (ora su ${vehicleName(c.assigned_vehicle_id)})` : ""}</option>)}
                </select>
              </label>
              <button type="button" disabled={busy || !cardChoice} onClick={() => void assignCard()} className={`${btn} bg-blue-600 text-white hover:bg-blue-700`}>Abbina</button>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <label className={`${label} col-span-2 sm:col-span-1`}>Nuova carta
                <input className={input} value={newCard.label} placeholder="Es. UTA Sprinter" onChange={(e) => setNewCard((f) => ({ ...f, label: e.target.value }))} />
              </label>
              <label className={label}>Fornitore
                <select className={input} value={newCard.supplier} onChange={(e) => setNewCard((f) => ({ ...f, supplier: e.target.value }))}>
                  <option value="UTA">UTA</option><option value="ENI">ENI</option><option value="Q8">Q8</option>
                </select>
              </label>
              <label className={label}>Ultime 4
                <input className={input} inputMode="numeric" maxLength={4} value={newCard.last_four}
                  onChange={(e) => setNewCard((f) => ({ ...f, last_four: e.target.value.replace(/\D/g, "").slice(0, 4) }))} />
              </label>
              <div className="col-span-2 flex items-end sm:col-span-1">
                <button type="button" disabled={busy || newCard.label.trim().length < 2 || (newCard.last_four !== "" && newCard.last_four.length !== 4)}
                  onClick={() => void createCard()} className={`${btn} w-full bg-blue-600 text-white hover:bg-blue-700`}>Crea</button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
