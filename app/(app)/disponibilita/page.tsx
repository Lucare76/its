"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase/client";
import { DateInput } from "@/components/ui/date-input";

// ─── Tipi ─────────────────────────────────────────────────────────────────────

type Driver = { user_id: string; full_name: string; max_vehicle_capacity: number | null };
type Vehicle = { id: string; label: string; capacity: number | null; vehicle_size: string | null };
type DriverAvail = { driver_user_id: string; available: boolean; available_from: string | null; available_to: string | null; notes: string | null };
type VehicleAvail = { vehicle_id: string; available: boolean; notes: string | null };
type TimeBlock = { id: string; vehicle_id: string; block_from: string; block_to: string; reason: string; reason_notes: string | null };

const BLOCK_REASONS: Record<string, string> = {
  escursione:              "Escursione",
  manutenzione:            "Manutenzione",
  fuori_servizio:          "Fuori servizio",
  rientro_porto_ischia:    "Rientro porto Ischia",
  rientro_porto_casamicciola: "Rientro porto Casamicciola",
  altro:                   "Altro",
};

function todayIso() { return new Date().toISOString().slice(0, 10); }
function tomorrowIso() {
  const d = new Date(); d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
function isoToIt(iso: string) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// ─── Componente principale ────────────────────────────────────────────────────

export default function DisponibilitaPage() {

  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [date, setDate] = useState(tomorrowIso());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [driverAvail, setDriverAvail] = useState<Map<string, DriverAvail>>(new Map());
  const [vehicleAvail, setVehicleAvail] = useState<Map<string, VehicleAvail>>(new Map());
  const [blocks, setBlocks] = useState<TimeBlock[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmedAt, setConfirmedAt] = useState<string | null>(null);

  // Form aggiunta blocco
  const [addingBlockFor, setAddingBlockFor] = useState<string | null>(null);
  const [newBlock, setNewBlock] = useState({ block_from: "09:00", block_to: "13:00", reason: "escursione" as string, reason_notes: "" });

  useEffect(() => {
    supabase?.auth.getSession().then(({ data }: { data: { session: { access_token: string } | null } }) => {
      setAccessToken(data.session?.access_token ?? null);
    });
  }, [supabase]);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/ops/disponibilita?date=${date}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await res.json() as {
        ok: boolean; error?: string;
        drivers: Driver[]; vehicles: Vehicle[];
        driver_availability: DriverAvail[]; vehicle_availability: VehicleAvail[];
        vehicle_blocks: TimeBlock[];
        confirmed: boolean; confirmed_at: string | null;
      };
      if (!body.ok) { setError(body.error ?? "Errore"); return; }
      setDrivers(body.drivers);
      setVehicles(body.vehicles);
      setDriverAvail(new Map(body.driver_availability.map(a => [a.driver_user_id, a])));
      setVehicleAvail(new Map(body.vehicle_availability.map(a => [a.vehicle_id, a])));
      setBlocks(body.vehicle_blocks);
      setConfirmed(body.confirmed);
      setConfirmedAt(body.confirmed_at);
    } finally {
      setLoading(false);
    }
  }, [accessToken, date]);

  useEffect(() => { void load(); }, [load]);

  const post = async (body: Record<string, unknown>) => {
    if (!accessToken) return;
    const res = await fetch("/api/ops/disponibilita", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    });
    return res.json() as Promise<{ ok: boolean; error?: string; id?: string }>;
  };

  const toggleDriver = async (userId: string, currentAvail: boolean) => {
    setSaving(userId);
    const current = driverAvail.get(userId);
    await post({
      action: "save_driver", date,
      driver_user_id: userId,
      available: !currentAvail,
      available_from: current?.available_from ?? null,
      available_to: current?.available_to ?? null,
      notes: current?.notes ?? null,
    });
    setDriverAvail(prev => {
      const next = new Map(prev);
      const existing = next.get(userId);
      next.set(userId, { driver_user_id: userId, available: !currentAvail, available_from: existing?.available_from ?? null, available_to: existing?.available_to ?? null, notes: existing?.notes ?? null });
      return next;
    });
    setSaving(null);
  };

  const toggleVehicle = async (vehicleId: string, currentAvail: boolean) => {
    setSaving(vehicleId);
    const current = vehicleAvail.get(vehicleId);
    await post({ action: "save_vehicle", date, vehicle_id: vehicleId, available: !currentAvail, notes: current?.notes ?? null });
    setVehicleAvail(prev => {
      const next = new Map(prev);
      const existing = next.get(vehicleId);
      next.set(vehicleId, { vehicle_id: vehicleId, available: !currentAvail, notes: existing?.notes ?? null });
      return next;
    });
    setSaving(null);
  };

  const addBlock = async (vehicleId: string) => {
    if (newBlock.block_to <= newBlock.block_from) { alert("L'orario di fine deve essere successivo all'inizio."); return; }
    setSaving(vehicleId + "_block");
    const res = await post({
      action: "add_block", date, vehicle_id: vehicleId,
      block_from: newBlock.block_from, block_to: newBlock.block_to,
      reason: newBlock.reason, reason_notes: newBlock.reason_notes || null,
    });
    if (res?.ok && res.id) {
      setBlocks(prev => [...prev, { id: res.id!, vehicle_id: vehicleId, block_from: newBlock.block_from, block_to: newBlock.block_to, reason: newBlock.reason, reason_notes: newBlock.reason_notes || null }]);
    }
    setAddingBlockFor(null);
    setSaving(null);
  };

  const removeBlock = async (blockId: string) => {
    setSaving(blockId);
    await post({ action: "remove_block", block_id: blockId });
    setBlocks(prev => prev.filter(b => b.id !== blockId));
    setSaving(null);
  };

  const handleConfirm = async () => {
    setConfirming(true);
    const action = confirmed ? "unconfirm" : "confirm";
    const res = await post({ action, date });
    if (res?.ok) {
      setConfirmed(!confirmed);
      setConfirmedAt(!confirmed ? new Date().toISOString() : null);
    }
    setConfirming(false);
  };

  const availableDrivers = drivers.filter(d => driverAvail.get(d.user_id)?.available !== false).length;
  const availableVehicles = vehicles.filter(v => vehicleAvail.get(v.id)?.available !== false).length;

  return (
    <section className="mx-auto max-w-6xl page-section">
      <div className="section-head">
        <h1 className="section-title">Disponibilità del Giorno</h1>
        <p className="section-subtitle">Dichiara quali autisti e mezzi sono disponibili. Conferma prima di aprire il Piano del Giorno.</p>
      </div>

      {/* Selettore data */}
      <div className="card p-4 mb-4 flex flex-wrap items-end gap-4">
        <label className="text-sm font-medium text-slate-700">
          Data
          <DateInput
            value={date}
            onChange={setDate}
            className="mt-1"
          />
        </label>
        <div className="text-sm text-slate-500">
          {loading ? "Caricamento..." : `${availableDrivers}/${drivers.length} autisti · ${availableVehicles}/${vehicles.length} mezzi`}
        </div>
      </div>

      {error ? <div className="card p-4 text-rose-600 text-sm mb-4">{error}</div> : null}

      {/* Banner conferma */}
      <div className={`card p-4 mb-6 flex flex-col sm:flex-row items-start sm:items-center gap-3 ${confirmed ? "border-emerald-300 bg-emerald-50" : "border-amber-300 bg-amber-50"}`}>
        <div className="flex-1">
          {confirmed ? (
            <p className="text-sm font-semibold text-emerald-800">
              ✅ Disponibilità confermata per il {isoToIt(date)}
              {confirmedAt ? <span className="ml-2 font-normal text-emerald-600 text-xs">({new Date(confirmedAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })})</span> : null}
            </p>
          ) : (
            <p className="text-sm font-semibold text-amber-800">
              ⏳ Disponibilità non ancora confermata per il {isoToIt(date)}.
              Il Piano del Giorno non sarà operativo fino alla conferma.
            </p>
          )}
        </div>
        <button
          type="button"
          disabled={confirming || loading}
          onClick={() => void handleConfirm()}
          className={`px-4 py-2 rounded-xl text-sm font-bold transition disabled:opacity-60 ${confirmed ? "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50" : "bg-emerald-600 text-white hover:bg-emerald-700"}`}
        >
          {confirming ? "..." : confirmed ? "Annulla conferma" : "Conferma disponibilità del giorno"}
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* AUTISTI */}
        <div>
          <h2 className="text-base font-bold text-slate-700 mb-3">Autisti ({availableDrivers}/{drivers.length} disponibili)</h2>
          <div className="space-y-2">
            {loading ? (
              <div className="card p-4 text-sm text-slate-400">Caricamento...</div>
            ) : drivers.length === 0 ? (
              <div className="card p-4 text-sm text-slate-400">Nessun autista trovato.</div>
            ) : drivers.map(driver => {
              const avail = driverAvail.get(driver.user_id);
              const isAvailable = avail?.available !== false;
              return (
                <div key={driver.user_id} className={`card p-3 transition ${isAvailable ? "" : "opacity-60 bg-slate-50"}`}>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      disabled={saving === driver.user_id}
                      onClick={() => void toggleDriver(driver.user_id, isAvailable)}
                      className={`w-10 h-6 rounded-full transition-colors flex-shrink-0 ${isAvailable ? "bg-emerald-500" : "bg-slate-300"}`}
                    >
                      <span className={`block w-4 h-4 rounded-full bg-white shadow mx-1 transition-transform ${isAvailable ? "translate-x-4" : ""}`} />
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-slate-800">{driver.full_name}</p>
                      {driver.max_vehicle_capacity ? (
                        <p className="text-xs text-slate-500">Max {driver.max_vehicle_capacity} posti</p>
                      ) : null}
                    </div>
                    {isAvailable ? (
                      <div className="flex items-center gap-1 text-xs text-slate-500">
                        <input type="time" value={avail?.available_from ?? ""} className="border rounded px-1 py-0.5 text-xs w-20"
                          onChange={e => {
                            const val = e.target.value || null;
                            setDriverAvail(prev => { const next = new Map(prev); const ex = next.get(driver.user_id); next.set(driver.user_id, { driver_user_id: driver.user_id, available: true, available_from: val, available_to: ex?.available_to ?? null, notes: ex?.notes ?? null }); return next; });
                          }}
                          onBlur={() => void post({ action: "save_driver", date, driver_user_id: driver.user_id, available: true, available_from: avail?.available_from ?? null, available_to: avail?.available_to ?? null, notes: avail?.notes ?? null })}
                        />
                        <span>–</span>
                        <input type="time" value={avail?.available_to ?? ""} className="border rounded px-1 py-0.5 text-xs w-20"
                          onChange={e => {
                            const val = e.target.value || null;
                            setDriverAvail(prev => { const next = new Map(prev); const ex = next.get(driver.user_id); next.set(driver.user_id, { driver_user_id: driver.user_id, available: true, available_from: ex?.available_from ?? null, available_to: val, notes: ex?.notes ?? null }); return next; });
                          }}
                          onBlur={() => void post({ action: "save_driver", date, driver_user_id: driver.user_id, available: true, available_from: avail?.available_from ?? null, available_to: avail?.available_to ?? null, notes: avail?.notes ?? null })}
                        />
                      </div>
                    ) : null}
                  </div>
                  {isAvailable ? (
                    <input type="text" placeholder="Note (opzionale)" value={avail?.notes ?? ""} maxLength={200}
                      className="mt-2 w-full border border-slate-200 rounded-lg px-2 py-1 text-xs text-slate-600 placeholder:text-slate-300"
                      onChange={e => {
                        const val = e.target.value;
                        setDriverAvail(prev => { const next = new Map(prev); const ex = next.get(driver.user_id); next.set(driver.user_id, { driver_user_id: driver.user_id, available: true, available_from: ex?.available_from ?? null, available_to: ex?.available_to ?? null, notes: val || null }); return next; });
                      }}
                      onBlur={() => void post({ action: "save_driver", date, driver_user_id: driver.user_id, available: true, available_from: avail?.available_from ?? null, available_to: avail?.available_to ?? null, notes: avail?.notes ?? null })}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        {/* MEZZI */}
        <div>
          <h2 className="text-base font-bold text-slate-700 mb-3">Mezzi ({availableVehicles}/{vehicles.length} disponibili)</h2>
          <div className="space-y-2">
            {loading ? (
              <div className="card p-4 text-sm text-slate-400">Caricamento...</div>
            ) : vehicles.length === 0 ? (
              <div className="card p-4 text-sm text-slate-400">Nessun mezzo trovato.</div>
            ) : vehicles.map(vehicle => {
              const avail = vehicleAvail.get(vehicle.id);
              const isAvailable = avail?.available !== false;
              const vehicleBlocks = blocks.filter(b => b.vehicle_id === vehicle.id);
              return (
                <div key={vehicle.id} className={`card p-3 transition ${isAvailable ? "" : "opacity-60 bg-slate-50"}`}>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      disabled={saving === vehicle.id}
                      onClick={() => void toggleVehicle(vehicle.id, isAvailable)}
                      className={`w-10 h-6 rounded-full transition-colors flex-shrink-0 ${isAvailable ? "bg-emerald-500" : "bg-slate-300"}`}
                    >
                      <span className={`block w-4 h-4 rounded-full bg-white shadow mx-1 transition-transform ${isAvailable ? "translate-x-4" : ""}`} />
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-slate-800">{vehicle.label}</p>
                      {vehicle.capacity ? <p className="text-xs text-slate-500">{vehicle.capacity} posti</p> : null}
                    </div>
                    {isAvailable ? (
                      <button
                        type="button"
                        onClick={() => setAddingBlockFor(addingBlockFor === vehicle.id ? null : vehicle.id)}
                        className="text-xs border border-slate-300 rounded-lg px-2 py-1 text-slate-600 hover:bg-slate-50"
                      >
                        + Blocco
                      </button>
                    ) : null}
                  </div>

                  {/* Blocchi esistenti */}
                  {vehicleBlocks.length > 0 ? (
                    <div className="mt-2 space-y-1">
                      {vehicleBlocks.map(block => (
                        <div key={block.id} className="flex items-center gap-2 rounded-lg bg-orange-50 border border-orange-200 px-2 py-1.5 text-xs">
                          <span className="font-mono font-semibold text-orange-700">{block.block_from.slice(0,5)}–{block.block_to.slice(0,5)}</span>
                          <span className="flex-1 text-orange-600">{BLOCK_REASONS[block.reason] ?? block.reason}{block.reason_notes ? `: ${block.reason_notes}` : ""}</span>
                          <button type="button" disabled={saving === block.id} onClick={() => void removeBlock(block.id)} className="text-orange-400 hover:text-rose-600">✕</button>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {/* Form nuovo blocco */}
                  {addingBlockFor === vehicle.id ? (
                    <div className="mt-2 border border-slate-200 rounded-xl p-3 space-y-2 bg-slate-50">
                      <p className="text-xs font-semibold text-slate-600">Aggiungi blocco orario</p>
                      <div className="flex gap-2 items-center text-xs">
                        <input type="time" value={newBlock.block_from} onChange={e => setNewBlock(p => ({ ...p, block_from: e.target.value }))} className="border rounded px-1 py-0.5 w-20" />
                        <span className="text-slate-400">–</span>
                        <input type="time" value={newBlock.block_to} onChange={e => setNewBlock(p => ({ ...p, block_to: e.target.value }))} className="border rounded px-1 py-0.5 w-20" />
                      </div>
                      <select value={newBlock.reason} onChange={e => setNewBlock(p => ({ ...p, reason: e.target.value }))} className="w-full border rounded-lg px-2 py-1 text-xs">
                        {Object.entries(BLOCK_REASONS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                      <input type="text" placeholder="Note aggiuntive (opzionale)" value={newBlock.reason_notes} onChange={e => setNewBlock(p => ({ ...p, reason_notes: e.target.value }))} className="w-full border rounded-lg px-2 py-1 text-xs" />
                      <div className="flex gap-2">
                        <button type="button" onClick={() => setAddingBlockFor(null)} className="flex-1 text-xs border border-slate-200 rounded-lg py-1.5 text-slate-600 hover:bg-white">Annulla</button>
                        <button type="button" disabled={saving === vehicle.id + "_block"} onClick={() => void addBlock(vehicle.id)} className="flex-1 text-xs bg-orange-500 text-white rounded-lg py-1.5 font-semibold hover:bg-orange-600 disabled:opacity-60">
                          {saving === vehicle.id + "_block" ? "..." : "Aggiungi"}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
