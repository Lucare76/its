"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

// ── Tipi ─────────────────────────────────────────────────────────────────────

type ExcursionLine = {
  id: string; name: string; description: string | null;
  color: string; icon: string; active: boolean; sort_order: number;
  days_of_week: number[]; excursion_type: string;
  price_agency_cents: number; price_retail_cents: number;
  return_time: string | null; min_pax: number; valid_from: string | null;
};
type ExcursionPickup = {
  id: string; excursion_line_id: string; location: string;
  pickup_time: string; sort_order: number;
};
type ExcursionUnit = {
  id: string; excursion_line_id: string; excursion_date: string;
  label: string; capacity: number; departure_time: string | null;
  vehicle_id: string | null; driver_profile_id: string | null;
  notes: string | null; status: string;
};
type ExcursionAllocation = {
  id: string; excursion_unit_id: string; customer_name: string;
  pax: number; hotel_name: string | null; pickup_time: string | null;
  phone: string | null; agency_name: string | null; notes: string | null;
};
type Vehicle = { id: string; label: string; plate: string; capacity: number };
type Driver = { id: string; full_name: string; phone: string | null };

const DAYS_LABEL = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];
const TYPE_LABEL: Record<string, string> = { mare: "🌊 Mare", terra: "🏔 Terra", misto: "🌍 Misto" };

function fmtPrice(cents: number) {
  return cents > 0 ? `€${(cents / 100).toFixed(0)}` : "—";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getToken() {
  if (!hasSupabaseEnv || !supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function downloadExcel(date: string) {
  const token = await getToken();
  if (!token) return;
  const res = await fetch(`/api/exports/escursioni?date=${date}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `escursioni_${date}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function printPdf(
  date: string,
  lines: ExcursionLine[],
  units: ExcursionUnit[],
  allocations: ExcursionAllocation[],
  vehicles: Vehicle[],
  drivers: Driver[]
) {
  const dateLabel = new Date(date + "T12:00:00").toLocaleDateString("it-IT", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  const sections = lines
    .map((line) => {
      const lineUnits = units.filter((u) => u.excursion_line_id === line.id);
      if (lineUnits.length === 0) return "";

      const busBlocks = lineUnits.map((unit) => {
        const driver = drivers.find((d) => d.id === unit.driver_profile_id);
        const vehicle = vehicles.find((v) => v.id === unit.vehicle_id);
        const unitAllocs = allocations.filter((a) => a.excursion_unit_id === unit.id);
        const totalPax = unitAllocs.reduce((s, a) => s + a.pax, 0);

        const rows = unitAllocs.length === 0
          ? `<tr><td colspan="6" style="color:#94a3b8;font-style:italic;padding:6px 8px">Nessun passeggero</td></tr>`
          : unitAllocs.map((a) => `
              <tr>
                <td>${a.pickup_time?.slice(0, 5) ?? "—"}</td>
                <td><strong>${a.customer_name}</strong></td>
                <td style="text-align:center">${a.pax}</td>
                <td>${a.hotel_name ?? "—"}</td>
                <td>${a.agency_name ?? "—"}</td>
                <td>${a.phone ?? ""} ${a.notes ? `· ${a.notes}` : ""}</td>
              </tr>`).join("");

        return `
          <div style="margin-bottom:20px;break-inside:avoid">
            <div style="background:#1e293b;color:white;padding:8px 12px;border-radius:6px 6px 0 0;display:flex;justify-content:space-between;align-items:center">
              <span style="font-weight:700;font-size:14px">🚌 ${unit.label}${unit.departure_time ? ` — partenza ${unit.departure_time.slice(0, 5)}` : ""}</span>
              <span style="font-size:12px;opacity:.75">${totalPax}/${unit.capacity} pax${driver ? ` · ${driver.full_name}${driver.phone ? ` 📞 ${driver.phone}` : ""}` : ""}${vehicle ? ` · ${vehicle.label}` : ""}</span>
            </div>
            <table width="100%" style="border-collapse:collapse;font-size:12px;border:1px solid #e2e8f0;border-top:none">
              <thead>
                <tr style="background:#f8fafc;color:#64748b;font-size:10px;text-transform:uppercase">
                  <th style="padding:5px 8px;text-align:left">Pickup</th>
                  <th style="padding:5px 8px;text-align:left">Cliente</th>
                  <th style="padding:5px 8px;text-align:center">Pax</th>
                  <th style="padding:5px 8px;text-align:left">Hotel</th>
                  <th style="padding:5px 8px;text-align:left">Agenzia</th>
                  <th style="padding:5px 8px;text-align:left">Tel / Note</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`;
      }).join("");

      return `
        <div style="margin-bottom:32px">
          <h2 style="font-size:16px;font-weight:700;margin:0 0 10px;color:#0f172a;border-bottom:2px solid #e2e8f0;padding-bottom:6px">
            ${line.icon} ${line.name}
          </h2>
          ${busBlocks}
        </div>`;
    })
    .filter(Boolean)
    .join("");

  const html = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">
    <title>Escursioni ${dateLabel}</title>
    <style>
      body { font-family: -apple-system, Arial, sans-serif; margin: 0; padding: 20px; color: #0f172a; }
      table td, table th { border-bottom: 1px solid #e2e8f0; padding: 5px 8px; }
      @media print { body { padding: 10px; } }
    </style></head><body>
    <div style="margin-bottom:20px">
      <p style="margin:0;font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.1em">Ischia Transfer Service</p>
      <h1 style="margin:4px 0;font-size:20px">Escursioni — ${dateLabel}</h1>
    </div>
    ${sections || "<p style='color:#94a3b8'>Nessuna escursione per questa data.</p>"}
  </body></html>`;

  const win = window.open("", "_blank", "width=900,height=700");
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => { win.print(); }, 400);
}

function fmtDate(iso: string) {
  return new Date(iso + "T12:00:00").toLocaleDateString("it-IT", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
}

function shiftDate(iso: string, days: number) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const STATUS_LABEL: Record<string, string> = {
  open: "Aperto", full: "Completo", completed: "Completato", cancelled: "Annullato",
};
const STATUS_COLOR: Record<string, string> = {
  open: "bg-emerald-100 text-emerald-700",
  full: "bg-amber-100 text-amber-700",
  completed: "bg-slate-100 text-slate-600",
  cancelled: "bg-rose-100 text-rose-600",
};

// ── BusCard ───────────────────────────────────────────────────────────────────

function UnitCard({
  unit, allocations, vehicles, drivers, hotelNames, agencyNames, saving,
  onUpdate, onDelete, onAddPassenger, onRemovePassenger,
}: {
  unit: ExcursionUnit;
  allocations: ExcursionAllocation[];
  vehicles: Vehicle[];
  drivers: Driver[];
  hotelNames: string[];
  agencyNames: string[];
  saving: boolean;
  onUpdate: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
  onAddPassenger: (data: Record<string, unknown>) => void;
  onRemovePassenger: (id: string) => void;
}) {
  const [addingPax, setAddingPax] = useState(false);
  const [paxForm, setPaxForm] = useState({ customer_name: "", pax: 1, hotel_name: "", pickup_time: "", phone: "", agency_name: "", notes: "" });

  const unitAllocs = allocations.filter((a) => a.excursion_unit_id === unit.id);
  const totalPax = unitAllocs.reduce((s, a) => s + a.pax, 0);
  const remaining = unit.capacity - totalPax;
  const pctFull = Math.min(100, Math.round((totalPax / unit.capacity) * 100));
  const vehicle = vehicles.find((v) => v.id === unit.vehicle_id);
  const driver = drivers.find((d) => d.id === unit.driver_profile_id);

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* Header bus */}
      <div className="border-b border-slate-100 bg-slate-50 px-4 py-3 space-y-2">
        {/* Riga 1: nome + stato + azioni */}
        <div className="flex items-center gap-2">
          <span className="font-bold text-slate-900">{unit.label}</span>
          {unit.departure_time && (
            <span className="font-mono text-sm text-slate-600">⏰ {unit.departure_time.slice(0, 5)}</span>
          )}
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[unit.status]}`}>
            {STATUS_LABEL[unit.status]}
          </span>
          <div className="ml-auto flex gap-1">
            <select
              value={unit.status}
              disabled={saving}
              onChange={(e) => onUpdate({ status: e.target.value })}
              className="rounded border border-slate-200 px-1.5 py-0.5 text-xs text-slate-600 disabled:opacity-50">
              <option value="open">Aperto</option>
              <option value="full">Completo</option>
              <option value="completed">Completato</option>
              <option value="cancelled">Annullato</option>
            </select>
            <button
              onClick={onDelete}
              disabled={saving}
              className="rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-400 hover:border-rose-300 hover:text-rose-500 disabled:opacity-40">
              ✕
            </button>
          </div>
        </div>

        {/* Barra capacità */}
        <div className="flex items-center gap-2">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200">
            <div
              className={`h-full rounded-full transition-all ${pctFull >= 100 ? "bg-rose-500" : pctFull >= 80 ? "bg-amber-400" : "bg-emerald-500"}`}
              style={{ width: `${pctFull}%` }}
            />
          </div>
          <span className="shrink-0 text-xs font-semibold text-slate-600">{totalPax}/{unit.capacity} pax</span>
          {remaining > 0 && <span className="shrink-0 text-xs text-slate-400">({remaining} liberi)</span>}
        </div>

        {/* Riga 2: autista + mezzo — sempre visibili */}
        <div className="grid grid-cols-2 gap-2">
          {/* Autista */}
          <div>
            <label className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">Autista</label>
            <select
              value={unit.driver_profile_id ?? ""}
              disabled={saving}
              onChange={(e) => onUpdate({ driver_profile_id: e.target.value || null })}
              className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700 disabled:opacity-50">
              <option value="">— Nessun autista —</option>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.full_name}{d.phone ? ` · ${d.phone}` : ""}
                </option>
              ))}
            </select>
            {driver?.phone && (
              <a href={`tel:${driver.phone}`} className="mt-0.5 block text-[11px] font-medium text-indigo-600 hover:text-indigo-800">
                📞 {driver.phone}
              </a>
            )}
          </div>
          {/* Mezzo */}
          <div>
            <label className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">Mezzo</label>
            <select
              value={unit.vehicle_id ?? ""}
              disabled={saving}
              onChange={(e) => onUpdate({ vehicle_id: e.target.value || null })}
              className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700 disabled:opacity-50">
              <option value="">— Nessun mezzo —</option>
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>{v.label} ({v.capacity}p) · {v.plate}</option>
              ))}
            </select>
            {vehicle && (
              <p className="mt-0.5 text-[11px] text-slate-500">🚌 {vehicle.label} · {vehicle.plate}</p>
            )}
          </div>
        </div>
      </div>

      {/* Lista passeggeri */}
      <div className="divide-y divide-slate-100">
        {unitAllocs.length === 0 && !addingPax && (
          <p className="px-4 py-3 text-xs text-slate-400">Nessun passeggero. Clicca + per aggiungere.</p>
        )}
        {unitAllocs.map((alloc) => (
          <div key={alloc.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50">
            {alloc.pickup_time && (
              <span className="w-10 shrink-0 font-mono text-xs text-slate-500">{alloc.pickup_time.slice(0, 5)}</span>
            )}
            <div className="min-w-0 flex-1">
              <span className="font-medium text-slate-800">{alloc.customer_name}</span>
              {alloc.hotel_name && <span className="ml-2 text-xs text-slate-500">🏨 {alloc.hotel_name}</span>}
              {alloc.agency_name && <span className="ml-2 text-xs text-slate-400">[{alloc.agency_name}]</span>}
              {alloc.notes && <span className="ml-2 text-xs text-slate-400">{alloc.notes}</span>}
            </div>
            <span className="shrink-0 rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700">
              {alloc.pax} pax
            </span>
            {alloc.phone && <span className="shrink-0 text-xs text-slate-400">{alloc.phone}</span>}
            <button
              onClick={() => onRemovePassenger(alloc.id)}
              disabled={saving}
              className="text-slate-300 hover:text-rose-500 disabled:opacity-40">✕</button>
          </div>
        ))}

        {/* Form aggiungi passeggero */}
        {addingPax && (
          <div className="space-y-2 border-t border-indigo-100 bg-indigo-50 px-4 py-3">
            {/* datalist per autocomplete */}
            <datalist id={`hotels-${unit.id}`}>
              {hotelNames.map((h) => <option key={h} value={h} />)}
            </datalist>
            <datalist id={`agencies-${unit.id}`}>
              {agencyNames.map((a) => <option key={a} value={a} />)}
            </datalist>

            <div className="grid grid-cols-2 gap-2">
              <input value={paxForm.customer_name}
                onChange={(e) => setPaxForm((f) => ({ ...f, customer_name: e.target.value }))}
                placeholder="Nome cliente *" className="col-span-2 rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
              <input
                list={`hotels-${unit.id}`}
                value={paxForm.hotel_name}
                onChange={(e) => setPaxForm((f) => ({ ...f, hotel_name: e.target.value }))}
                placeholder="Hotel" className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
              <input
                list={`agencies-${unit.id}`}
                value={paxForm.agency_name}
                onChange={(e) => setPaxForm((f) => ({ ...f, agency_name: e.target.value }))}
                placeholder="Agenzia" className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
              <input type="time" value={paxForm.pickup_time}
                onChange={(e) => setPaxForm((f) => ({ ...f, pickup_time: e.target.value }))}
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
              <input value={paxForm.phone}
                onChange={(e) => setPaxForm((f) => ({ ...f, phone: e.target.value }))}
                placeholder="Telefono" className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-600">Pax:</label>
                <input type="number" value={paxForm.pax} min={1} max={99}
                  onChange={(e) => setPaxForm((f) => ({ ...f, pax: parseInt(e.target.value) || 1 }))}
                  className="w-16 rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-center" />
              </div>
              <input value={paxForm.notes}
                onChange={(e) => setPaxForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="Note" className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setAddingPax(false)} className="text-xs text-slate-500 hover:text-slate-700">Annulla</button>
              <button
                disabled={saving || !paxForm.customer_name.trim()}
                onClick={() => {
                  onAddPassenger({ ...paxForm, pickup_time: paxForm.pickup_time || null });
                  setPaxForm({ customer_name: "", pax: 1, hotel_name: "", pickup_time: "", phone: "", agency_name: "", notes: "" });
                  setAddingPax(false);
                }}
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40">
                Aggiungi
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Footer: aggiungi passeggero */}
      <div className="border-t border-slate-100 px-4 py-2">
        <button
          onClick={() => setAddingPax(true)}
          disabled={saving || addingPax}
          className="text-xs font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-40">
          + Aggiungi passeggero
        </button>
      </div>
    </div>
  );
}

// ── Pagina principale ─────────────────────────────────────────────────────────

export default function EscursioniPage() {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [selectedLineId, setSelectedLineId] = useState("");
  const [lines, setLines] = useState<ExcursionLine[]>([]);
  const [units, setUnits] = useState<ExcursionUnit[]>([]);
  const [allocations, setAllocations] = useState<ExcursionAllocation[]>([]);
  const [pickups, setPickups] = useState<ExcursionPickup[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [hotelNames, setHotelNames] = useState<string[]>([]);
  const [agencyNames, setAgencyNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  // Form nuovo bus
  const [showAddUnit, setShowAddUnit] = useState(false);
  const [unitForm, setUnitForm] = useState({ label: "Bus 1", capacity: 50, departure_time: "" });
  const [exportingExcel, setExportingExcel] = useState(false);

  const load = useCallback(async (d: string) => {
    const token = await getToken();
    if (!token) { setLoading(false); return; }
    setLoading(true);
    const res = await fetch(`/api/ops/escursioni?date=${d}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => null);
    if (body?.ok) {
      const newLines = body.lines ?? [];
      setLines(newLines);
      setUnits(body.units ?? []);
      setAllocations(body.allocations ?? []);
      setPickups(body.pickups ?? []);
      setVehicles(body.vehicles ?? []);
      setDrivers(body.drivers ?? []);
      setHotelNames(body.hotelNames ?? []);
      setAgencyNames(body.agencyNames ?? []);
      if (!selectedLineId && newLines.length > 0) {
        setSelectedLineId(newLines[0].id);
      } else if (selectedLineId && !newLines.find((l: ExcursionLine) => l.id === selectedLineId) && newLines.length > 0) {
        setSelectedLineId(newLines[0].id);
      }
    }
    setLoading(false);
  }, [selectedLineId]);

  useEffect(() => { void load(date); }, [load, date]);

  const post = useCallback(async (action: string, data: Record<string, unknown>) => {
    const token = await getToken();
    if (!token) return;
    setSaving(true);
    setMessage("");
    const res = await fetch("/api/ops/escursioni", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, date, ...data }),
    });
    const body = await res.json().catch(() => null);
    setSaving(false);
    if (!res.ok || !body?.ok) { setMessage(body?.error ?? "Errore."); return; }
    setUnits(body.units ?? []);
    setAllocations(body.allocations ?? []);
    setLines(body.lines ?? []);
  }, [date]);

  const selectedLine = lines.find((l) => l.id === selectedLineId);
  const lineUnits = units.filter((u) => u.excursion_line_id === selectedLineId);
  const totalLinePax = allocations.filter((a) => lineUnits.some((u) => u.id === a.excursion_unit_id)).reduce((s, a) => s + a.pax, 0);

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Escursioni" subtitle="Gestione bus escursioni — assegnazione passeggeri" />

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-6 py-3">
        <button onClick={() => setDate((d) => shiftDate(d, -1))} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm hover:bg-slate-50">‹</button>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm" />
        <button onClick={() => setDate((d) => shiftDate(d, 1))} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm hover:bg-slate-50">›</button>
        <span className="text-sm text-slate-500">{fmtDate(date)}</span>

        {message && <span className="ml-2 text-xs text-rose-600">{message}</span>}

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => printPdf(date, lines, units, allocations, vehicles, drivers)}
            disabled={units.length === 0}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40">
            🖨️ Stampa PDF
          </button>
          <button
            onClick={async () => { setExportingExcel(true); await downloadExcel(date); setExportingExcel(false); }}
            disabled={exportingExcel || units.length === 0}
            className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-40">
            {exportingExcel ? "..." : "📊 Excel"}
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar: linee escursione */}
        <div className="w-56 shrink-0 overflow-y-auto border-r border-slate-200 bg-slate-50 p-3">
          <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Oggi disponibili</p>
          {loading ? (
            <p className="px-2 text-xs text-slate-400">Caricamento...</p>
          ) : lines.length === 0 ? (
            <p className="px-2 text-xs text-slate-400">Nessuna escursione oggi.</p>
          ) : (
            <div className="space-y-1">
              {lines.map((line) => {
                const lineUnitCount = units.filter((u) => u.excursion_line_id === line.id).length;
                const linePax = allocations
                  .filter((a) => units.some((u) => u.id === a.excursion_unit_id && u.excursion_line_id === line.id))
                  .reduce((s, a) => s + a.pax, 0);
                const active = selectedLineId === line.id;
                return (
                  <button
                    key={line.id}
                    onClick={() => setSelectedLineId(line.id)}
                    className={`flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition ${
                      active ? "border-slate-200 bg-white shadow-sm" : "border-transparent hover:bg-white/80"
                    }`}>
                    <span className="text-xl">{line.icon}</span>
                    <div className="min-w-0 flex-1">
                      <p className={`truncate text-sm font-medium ${active ? "text-slate-900" : "text-slate-600"}`}>
                        {line.name}
                      </p>
                      <p className="text-[10px] text-slate-400">
                        {line.price_retail_cents > 0 ? `${fmtPrice(line.price_agency_cents)} · ${fmtPrice(line.price_retail_cents)}` : ""}
                        {lineUnitCount > 0 ? ` · ${lineUnitCount} bus · ${linePax} pax` : ""}
                      </p>
                    </div>
                    {active && (
                      <div className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: line.color }} />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Main: bus della linea selezionata */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {!selectedLine ? (
            <p className="text-sm text-slate-400">Seleziona un'escursione.</p>
          ) : (
            <>
              {/* Header linea */}
              <div className="mb-4 space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <span className="text-3xl">{selectedLine.icon}</span>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-lg font-bold text-slate-900">{selectedLine.name}</h2>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                          {TYPE_LABEL[selectedLine.excursion_type] ?? selectedLine.excursion_type}
                        </span>
                        {selectedLine.min_pax > 0 && (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                            min {selectedLine.min_pax} pax
                          </span>
                        )}
                        {totalLinePax > 0 && (
                          <span className="rounded-full px-2 py-0.5 text-xs font-semibold text-white" style={{ backgroundColor: selectedLine.color }}>
                            {totalLinePax} pax · {lineUnits.length} bus
                          </span>
                        )}
                      </div>
                      {selectedLine.description && (
                        <p className="text-sm text-slate-500">{selectedLine.description}</p>
                      )}
                      <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-500">
                        {selectedLine.price_agency_cents > 0 && (
                          <span>💼 Netto: <strong>{fmtPrice(selectedLine.price_agency_cents)}</strong></span>
                        )}
                        {selectedLine.price_retail_cents > 0 && (
                          <span>🏷️ Vendita: <strong>{fmtPrice(selectedLine.price_retail_cents)}</strong></span>
                        )}
                        {selectedLine.return_time && (
                          <span>🔄 Ritorno: <strong>{selectedLine.return_time.slice(0, 5)}</strong></span>
                        )}
                        <span>📅 {selectedLine.days_of_week.map((d) => DAYS_LABEL[d]).join(", ")}</span>
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => setShowAddUnit(true)}
                    disabled={saving}
                    className="shrink-0 rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40">
                    + Aggiungi bus
                  </button>
                </div>

                {/* Orari pickup per questa linea */}
                {(() => {
                  const linePickups = pickups.filter((p) => p.excursion_line_id === selectedLine.id);
                  if (linePickups.length === 0) return null;
                  return (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Orari raccolta</p>
                      <div className="flex flex-wrap gap-3">
                        {linePickups.map((p) => (
                          <div key={p.id} className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5">
                            <span className="text-xs font-semibold text-slate-700">{p.pickup_time.slice(0, 5)}</span>
                            <span className="text-xs text-slate-500">{p.location}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* Bus list */}
              {lineUnits.length === 0 && (
                <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-400">
                  <p className="text-lg">Nessun bus per questa escursione in data {fmtDate(date)}.</p>
                  <p className="mt-1 text-sm">Clicca <strong>+ Aggiungi bus</strong> per iniziare.</p>
                </div>
              )}

              <div className="grid gap-4 lg:grid-cols-2">
                {lineUnits.map((unit) => (
                  <UnitCard
                    key={unit.id}
                    unit={unit}
                    allocations={allocations}
                    vehicles={vehicles}
                    drivers={drivers}
                    hotelNames={hotelNames}
                    agencyNames={agencyNames}
                    saving={saving}
                    onUpdate={(patch) => void post("update_unit", { unit_id: unit.id, ...patch })}
                    onDelete={() => void post("delete_unit", { unit_id: unit.id })}
                    onAddPassenger={(data) => void post("add_passenger", { excursion_unit_id: unit.id, ...data })}
                    onRemovePassenger={(id) => void post("remove_passenger", { allocation_id: id })}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Modal aggiungi bus */}
      {showAddUnit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-6 shadow-2xl">
            <h2 className="text-lg font-bold text-slate-900">Nuovo bus — {selectedLine?.name}</h2>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Nome bus</label>
              <input value={unitForm.label}
                onChange={(e) => setUnitForm((f) => ({ ...f, label: e.target.value }))}
                placeholder="es. Bus 1, Bus Giallo"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="mb-1 block text-xs font-medium text-slate-600">Capienza</label>
                <input type="number" value={unitForm.capacity} min={1} max={200}
                  onChange={(e) => setUnitForm((f) => ({ ...f, capacity: parseInt(e.target.value) || 50 }))}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-center" />
              </div>
              <div className="flex-1">
                <label className="mb-1 block text-xs font-medium text-slate-600">Partenza</label>
                <input type="time" value={unitForm.departure_time}
                  onChange={(e) => setUnitForm((f) => ({ ...f, departure_time: e.target.value }))}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
              </div>
            </div>
            <div className="flex gap-3 pt-1">
              <button onClick={() => setShowAddUnit(false)}
                className="flex-1 rounded-lg border border-slate-200 py-2 text-sm text-slate-600 hover:bg-slate-50">
                Annulla
              </button>
              <button
                disabled={saving || !unitForm.label.trim()}
                onClick={() => {
                  void post("add_unit", {
                    excursion_line_id: selectedLineId,
                    label: unitForm.label,
                    capacity: unitForm.capacity,
                    departure_time: unitForm.departure_time || null,
                  }).then(() => setShowAddUnit(false));
                }}
                className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">
                {saving ? "..." : "Crea bus"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
