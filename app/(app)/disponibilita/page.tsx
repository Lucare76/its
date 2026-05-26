"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { supabase } from "@/lib/supabase/client";
import { DateInput } from "@/components/ui/date-input";

// ─── Tipi ─────────────────────────────────────────────────────────────────────

type Driver = {
  id: string;
  user_id: string | null;
  full_name: string;
  phone: string | null;
  max_vehicle_capacity: number | null;
  has_access: boolean;
  access_suspended: boolean;
};

type Vehicle = {
  id: string;
  label: string;
  plate: string | null;
  capacity: number | null;
  vehicle_size: string | null;
};

type DriverAvail = {
  driver_profile_id: string;
  driver_user_id: string | null;
  available: boolean;
  available_from: string | null;
  available_to: string | null;
  notes: string | null;
  vehicle_1_id: string | null;
  vehicle_1_from: string | null;
  vehicle_1_to: string | null;
  vehicle_2_id: string | null;
  vehicle_2_from: string | null;
  vehicle_2_to: string | null;
};

type VehicleAvail = { vehicle_id: string; available: boolean; notes: string | null };
type TimeBlock = { id: string; vehicle_id: string; block_from: string; block_to: string; reason: string; reason_notes: string | null };
type VehicleCommitment = { id: string; vehicle_id: string; commitment_date: string; commitment_type: string; notes: string | null };

const BLOCK_REASONS: Record<string, string> = {
  escursione: "Escursione",
  manutenzione: "Manutenzione",
  fuori_servizio: "Fuori servizio",
  rientro_porto_ischia: "Rientro porto Ischia",
  rientro_porto_casamicciola: "Rientro porto Casamicciola",
  altro: "Altro",
};

const COMMITMENT_LABELS: Record<string, string> = {
  collaudo: "Collaudo",
  officina: "Officina",
  fermo_amministrativo: "Fermo amministrativo",
  altro: "Altro",
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

function emptyAvail(driverId: string, userId: string | null): DriverAvail {
  return {
    driver_profile_id: driverId,
    driver_user_id: userId,
    available: true,
    available_from: null,
    available_to: null,
    notes: null,
    vehicle_1_id: null,
    vehicle_1_from: null,
    vehicle_1_to: null,
    vehicle_2_id: null,
    vehicle_2_from: null,
    vehicle_2_to: null,
  };
}

// ─── Componente principale ────────────────────────────────────────────────────

export default function DisponibilitaPage() {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [date, setDate] = useState(tomorrowIso());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [driverAvail, setDriverAvail] = useState<Map<string, DriverAvail>>(new Map());
  const [vehicleAvail, setVehicleAvail] = useState<Map<string, VehicleAvail>>(new Map());

  // Refs for always-fresh state access inside async callbacks (avoids stale closures)
  const driverAvailRef = useRef<Map<string, DriverAvail>>(new Map());
  const driversRef = useRef<Driver[]>([]);
  useEffect(() => { driverAvailRef.current = driverAvail; }, [driverAvail]);
  useEffect(() => { driversRef.current = drivers; }, [drivers]);
  const [blocks, setBlocks] = useState<TimeBlock[]>([]);
  const [commitments, setCommitments] = useState<VehicleCommitment[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmedAt, setConfirmedAt] = useState<string | null>(null);

  // Stato "cambio mezzo" (mostra seconda fascia): derive da vehicle_2_id oppure attivato manualmente
  const [vehicleChangeEnabled, setVehicleChangeEnabled] = useState<Set<string>>(new Set());

  // Stato form aggiunta blocco mezzo
  const [addingBlockFor, setAddingBlockFor] = useState<string | null>(null);
  const [newBlock, setNewBlock] = useState({ block_from: "09:00", block_to: "13:00", reason: "escursione" as string, reason_notes: "" });

  // Stato form creazione account autista
  const [creatingAccessFor, setCreatingAccessFor] = useState<string | null>(null);
  const [createAccessPhone, setCreateAccessPhone] = useState("");
  const [createAccessLoading, setCreateAccessLoading] = useState(false);

  // Stato form creazione nuovo profilo autista
  const [showAddDriver, setShowAddDriver] = useState(false);
  const [newDriverName, setNewDriverName] = useState("");
  const [newDriverPhone, setNewDriverPhone] = useState("");
  const [addingDriver, setAddingDriver] = useState(false);

  useEffect(() => {
    supabase?.auth.getSession().then(({ data }: { data: { session: { access_token: string } | null } }) => {
      setAccessToken(data.session?.access_token ?? null);
    });
  }, []);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/ops/disponibilita?date=${date}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: "no-store",
      });
      const body = await res.json() as {
        ok: boolean; error?: string;
        drivers: Driver[]; vehicles: Vehicle[];
        driver_availability: DriverAvail[]; vehicle_availability: VehicleAvail[];
        vehicle_blocks: TimeBlock[];
        vehicle_commitments: VehicleCommitment[];
        confirmed: boolean; confirmed_at: string | null;
      };
      if (!body.ok) { setError(body.error ?? "Errore"); return; }
      setDrivers(body.drivers.sort((a, b) => a.full_name.localeCompare(b.full_name, "it")));
      setVehicles(body.vehicles);
      const availMap = new Map(body.driver_availability.map(a => [a.driver_profile_id, a]));
      setDriverAvail(availMap);
      // Inizializza vehicleChangeEnabled dai dati DB
      const cambio = new Set<string>();
      for (const [pid, a] of availMap.entries()) {
        if (a.vehicle_2_id) cambio.add(pid);
      }
      setVehicleChangeEnabled(cambio);
      setVehicleAvail(new Map(body.vehicle_availability.map(a => [a.vehicle_id, a])));
      setBlocks(body.vehicle_blocks);
      setCommitments(body.vehicle_commitments ?? []);
      setConfirmed(body.confirmed);
      setConfirmedAt(body.confirmed_at);
    } finally {
      setLoading(false);
    }
  }, [accessToken, date]);

  useEffect(() => { void load(); }, [load]);

  const post = useCallback(async (body: Record<string, unknown>) => {
    if (!accessToken) return;
    const res = await fetch("/api/ops/disponibilita", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    });
    return res.json() as Promise<{ ok: boolean; error?: string; id?: string }>;
  }, [accessToken]);

  // ── Salvataggio disponibilità autista (con tutti i campi) ─────────────────

  const saveDriverAvail = useCallback(async (driverId: string, overrides: Partial<DriverAvail> = {}) => {
    const driver = driversRef.current.find(d => d.id === driverId);
    const current = driverAvailRef.current.get(driverId) ?? emptyAvail(driverId, driver?.user_id ?? null);
    const merged = { ...current, ...overrides };
    setSaving(driverId);
    let result: { ok: boolean; error?: string } | undefined;
    try {
      result = await post({
        action: "save_driver",
        date,
        driver_profile_id: driverId,
        available: merged.available,
        available_from: merged.available_from,
        available_to: merged.available_to,
        notes: merged.notes,
        vehicle_1_id: merged.vehicle_1_id,
        vehicle_1_from: merged.vehicle_1_from,
        vehicle_1_to: merged.vehicle_1_to,
        vehicle_2_id: merged.vehicle_2_id,
        vehicle_2_from: merged.vehicle_2_from,
        vehicle_2_to: merged.vehicle_2_to,
      });
    } catch {
      setError("Errore di rete nel salvataggio disponibilità.");
      setSaving(null);
      return;
    }
    if (!result?.ok) {
      setError(result?.error ?? "Errore nel salvataggio disponibilità.");
      // Ripristina lo stato locale al valore prima della modifica
      setDriverAvail(prev => {
        const next = new Map(prev);
        next.set(driverId, current);
        return next;
      });
      setSaving(null);
      return;
    }
    setDriverAvail(prev => {
      const next = new Map(prev);
      next.set(driverId, merged);
      return next;
    });
    setSaving(null);
  }, [date, post]);

  const toggleDriver = async (driverId: string) => {
    const driver = driversRef.current.find(d => d.id === driverId);
    const current = driverAvailRef.current.get(driverId) ?? emptyAvail(driverId, driver?.user_id ?? null);
    await saveDriverAvail(driverId, { available: !current.available });
  };

  // ── Gestione mezzo ────────────────────────────────────────────────────────

  function updateAvailLocal(driverId: string, fields: Partial<DriverAvail>) {
    setDriverAvail(prev => {
      const next = new Map(prev);
      const driver = drivers.find(d => d.id === driverId);
      const ex = next.get(driverId) ?? emptyAvail(driverId, driver?.user_id ?? null);
      next.set(driverId, { ...ex, ...fields });
      return next;
    });
  }

  function toggleVehicleChange(driverId: string, checked: boolean) {
    setVehicleChangeEnabled(prev => {
      const next = new Set(prev);
      checked ? next.add(driverId) : next.delete(driverId);
      return next;
    });
    if (!checked) {
      // Azzera mezzo 2 e salva
      updateAvailLocal(driverId, { vehicle_2_id: null, vehicle_2_from: null, vehicle_2_to: null, vehicle_1_to: null });
      void saveDriverAvail(driverId, { vehicle_2_id: null, vehicle_2_from: null, vehicle_2_to: null, vehicle_1_to: null });
    }
  }

  // ── Validazione mezzo ────────────────────────────────────────────────────

  function vehicleWarning(driverId: string, vehicleId: string | null | undefined): string | null {
    if (!vehicleId) return null;
    const vehicle = vehicles.find(v => v.id === vehicleId);
    const driver = drivers.find(d => d.id === driverId);
    if (!vehicle) return null;
    if (driver?.max_vehicle_capacity && vehicle.capacity && vehicle.capacity > driver.max_vehicle_capacity) {
      return `${driver.full_name} non può guidare veicoli oltre ${driver.max_vehicle_capacity} posti (${vehicle.label}: ${vehicle.capacity} posti)`;
    }
    for (const [pid, av] of driverAvail.entries()) {
      if (pid === driverId || !av.available) continue;
      if (av.vehicle_1_id === vehicleId || av.vehicle_2_id === vehicleId) {
        const other = drivers.find(d => d.id === pid);
        return `${vehicle.label} è già assegnato a ${other?.full_name ?? "altro autista"}`;
      }
    }
    return null;
  }

  // ── Creazione account autista ────────────────────────────────────────────

  const handleCreateAccess = async (driverId: string) => {
    if (!accessToken) return;
    const phone = createAccessPhone.trim();
    if (!phone || phone.replace(/\D/g, "").length < 6) {
      alert("Inserisci un numero di telefono valido (minimo 6 cifre).");
      return;
    }
    setCreateAccessLoading(true);
    try {
      const res = await fetch(`/api/ops/driver-profiles/${driverId}/create-access`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ phone }),
      });
      const body = await res.json() as { ok: boolean; error?: string; username?: string; temporaryPassword?: string; created?: boolean };
      if (!body.ok) { alert(body.error ?? "Errore nella creazione dell'account."); return; }
      const action = body.created ? "creato" : "già esistente, aggiornato";
      setSuccessMsg(`Account ${action} per ${drivers.find(d => d.id === driverId)?.full_name}. Username: ${body.username} — Password: ${body.temporaryPassword}`);
      setCreatingAccessFor(null);
      setCreateAccessPhone("");
      await load();
    } finally {
      setCreateAccessLoading(false);
    }
  };

  // ── Aggiunta nuovo autista ───────────────────────────────────────────────

  const handleAddDriver = async () => {
    if (!accessToken || !newDriverName.trim()) return;
    setAddingDriver(true);
    try {
      const res = await fetch("/api/ops/driver-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ full_name: newDriverName.trim(), phone: newDriverPhone.trim() || null }),
      });
      const body = await res.json() as { ok: boolean; error?: string; reactivated?: boolean };
      if (!body.ok) { alert(body.error ?? "Errore nella creazione del profilo."); return; }
      const msg = body.reactivated ? "Profilo riattivato." : "Profilo autista creato.";
      setSuccessMsg(`${msg} Ora crea l'account dalla schermata autisti.`);
      setShowAddDriver(false);
      setNewDriverName("");
      setNewDriverPhone("");
      await load();
    } finally {
      setAddingDriver(false);
    }
  };

  // ── Mezzi ─────────────────────────────────────────────────────────────────

  const toggleVehicle = async (vehicleId: string, currentAvail: boolean) => {
    setSaving(vehicleId);
    const current = vehicleAvail.get(vehicleId);
    await post({ action: "save_vehicle", date, vehicle_id: vehicleId, available: !currentAvail, notes: current?.notes ?? null });
    setVehicleAvail(prev => {
      const next = new Map(prev);
      next.set(vehicleId, { vehicle_id: vehicleId, available: !currentAvail, notes: next.get(vehicleId)?.notes ?? null });
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
    if (res?.ok) { setConfirmed(!confirmed); setConfirmedAt(!confirmed ? new Date().toISOString() : null); }
    setConfirming(false);
  };

  // ── Statistiche ───────────────────────────────────────────────────────────

  const availableDrivers = drivers.filter(d => driverAvail.get(d.id)?.available !== false).length;
  const commitmentByVehicleId = new Map(commitments.map(c => [c.vehicle_id, c]));
  const availableVehicles = vehicles.filter(v => vehicleAvail.get(v.id)?.available !== false && !commitmentByVehicleId.has(v.id)).length;
  const availableVehiclesList = vehicles.filter(v => vehicleAvail.get(v.id)?.available !== false && !commitmentByVehicleId.has(v.id));

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <section className="mx-auto max-w-6xl page-section">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Operativo giornaliero</p>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-slate-950">Disponibilità del giorno</h1>
        </div>
        <p className="max-w-xl text-sm leading-6 text-slate-500">
          Dichiara quali autisti e mezzi sono disponibili. Conferma prima di aprire il Piano del Giorno.
        </p>
      </div>

      {/* Selettore data */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <label className="flex flex-wrap items-center gap-3 text-sm font-semibold text-slate-700">
          <span>Data</span>
          <DateInput
            value={date}
            onChange={setDate}
            className="h-10 w-36 rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-slate-400 focus:bg-white"
          />
        </label>
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm font-medium text-slate-500">
          {loading ? "Caricamento..." : `${availableDrivers}/${drivers.length} autisti · ${availableVehicles}/${vehicles.length} mezzi`}
        </div>
      </div>

      {error ? <div className="card p-4 text-rose-600 text-sm mb-4">{error}</div> : null}

      {successMsg ? (
        <div className="card p-4 mb-4 border-emerald-300 bg-emerald-50 flex items-start justify-between gap-2">
          <p className="text-sm text-emerald-800 font-medium">{successMsg}</p>
          <button type="button" onClick={() => setSuccessMsg(null)} className="text-emerald-500 hover:text-emerald-700 text-xs">✕</button>
        </div>
      ) : null}

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

        {/* ══ AUTISTI ══════════════════════════════════════════════════════════ */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-bold text-slate-700">Autisti ({availableDrivers}/{drivers.length} disponibili)</h2>
            <button
              type="button"
              onClick={() => setShowAddDriver(!showAddDriver)}
              className="text-xs border border-slate-300 rounded-lg px-2 py-1 text-slate-600 hover:bg-slate-50"
            >
              + Aggiungi autista
            </button>
          </div>

          {/* Form aggiunta autista */}
          {showAddDriver ? (
            <div className="card p-3 mb-3 border-blue-200 bg-blue-50 space-y-2">
              <p className="text-xs font-semibold text-blue-700">Nuovo autista (solo profilo — crea l&apos;account dopo)</p>
              <input
                type="text"
                placeholder="Nome completo (es. RICCARDO ESPOSITO)"
                value={newDriverName}
                onChange={e => setNewDriverName(e.target.value.toUpperCase())}
                className="w-full border rounded-lg px-2 py-1.5 text-xs uppercase"
              />
              <input
                type="tel"
                placeholder="Telefono (usato come password temporanea)"
                value={newDriverPhone}
                onChange={e => setNewDriverPhone(e.target.value)}
                className="w-full border rounded-lg px-2 py-1.5 text-xs"
              />
              <div className="flex gap-2">
                <button type="button" onClick={() => setShowAddDriver(false)} className="flex-1 text-xs border border-slate-200 rounded-lg py-1.5 text-slate-600">Annulla</button>
                <button
                  type="button"
                  disabled={addingDriver || !newDriverName.trim()}
                  onClick={() => void handleAddDriver()}
                  className="flex-1 text-xs bg-blue-600 text-white rounded-lg py-1.5 font-semibold disabled:opacity-60"
                >
                  {addingDriver ? "..." : "Crea profilo"}
                </button>
              </div>
            </div>
          ) : null}

          <div className="space-y-2">
            {loading ? (
              <div className="card p-4 text-sm text-slate-400">Caricamento...</div>
            ) : drivers.length === 0 ? (
              <div className="card p-4 text-sm text-slate-400">Nessun autista trovato.</div>
            ) : drivers.map(driver => {
              const avail = driverAvail.get(driver.id);
              const isAvailable = avail?.available !== false;
              const hasCambio = vehicleChangeEnabled.has(driver.id);
              const w1 = vehicleWarning(driver.id, avail?.vehicle_1_id);
              const w2 = vehicleWarning(driver.id, avail?.vehicle_2_id);

              return (
                <div key={driver.id} className={`card p-3 transition ${isAvailable ? "" : "opacity-60 bg-slate-50"}`}>
                  {/* ── Riga nome + toggle ─────────────────────────────── */}
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      disabled={saving === driver.id}
                      onClick={() => void toggleDriver(driver.id)}
                      className={`w-10 h-6 rounded-full transition-colors flex-shrink-0 ${isAvailable ? "bg-emerald-500" : "bg-slate-300"}`}
                    >
                      <span className={`block w-4 h-4 rounded-full bg-white shadow mx-1 transition-transform ${isAvailable ? "translate-x-4" : ""}`} />
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-slate-800">{driver.full_name}</p>
                      {driver.max_vehicle_capacity ? (
                        <p className="text-xs text-slate-400">Max {driver.max_vehicle_capacity} posti</p>
                      ) : null}
                    </div>
                    {/* Orari disponibilità */}
                    {isAvailable ? (
                      <div className="flex items-center gap-1 text-xs text-slate-500">
                        <input
                          type="time"
                          value={avail?.available_from ?? ""}
                          className="border rounded px-1 py-0.5 text-xs w-20"
                          onChange={e => updateAvailLocal(driver.id, { available_from: e.target.value || null })}
                          onBlur={() => void saveDriverAvail(driver.id)}
                        />
                        <span>–</span>
                        <input
                          type="time"
                          value={avail?.available_to ?? ""}
                          className="border rounded px-1 py-0.5 text-xs w-20"
                          onChange={e => updateAvailLocal(driver.id, { available_to: e.target.value || null })}
                          onBlur={() => void saveDriverAvail(driver.id)}
                        />
                      </div>
                    ) : null}
                  </div>

                  {/* ── Note ─────────────────────────────────────────── */}
                  {isAvailable ? (
                    <input
                      type="text"
                      placeholder="Note (opzionale)"
                      value={avail?.notes ?? ""}
                      maxLength={200}
                      className="mt-2 w-full border border-slate-200 rounded-lg px-2 py-1 text-xs text-slate-600 placeholder:text-slate-300"
                      onChange={e => updateAvailLocal(driver.id, { notes: e.target.value || null })}
                      onBlur={() => void saveDriverAvail(driver.id)}
                    />
                  ) : null}

                  {/* ── Assegnazione mezzo ────────────────────────────── */}
                  {isAvailable ? (
                    <div className="mt-2 space-y-1.5 border-t border-slate-100 pt-2">
                      {/* Mezzo 1 */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-slate-500 w-14 flex-shrink-0">Mezzo:</span>
                        <select
                          value={avail?.vehicle_1_id ?? ""}
                          className={`flex-1 min-w-0 border rounded-lg px-2 py-1 text-xs ${!avail?.vehicle_1_id ? "border-amber-300 bg-amber-50" : "border-slate-200"}`}
                          onChange={e => {
                            updateAvailLocal(driver.id, { vehicle_1_id: e.target.value || null });
                            void saveDriverAvail(driver.id, { vehicle_1_id: e.target.value || null });
                          }}
                        >
                          <option value="">— seleziona mezzo —</option>
                          {availableVehiclesList.map(v => {
                            const warn = vehicleWarning(driver.id, v.id);
                            const isOtherDriver = warn?.includes("già assegnato");
                            return (
                              <option key={v.id} value={v.id} disabled={Boolean(isOtherDriver)}>
                                {v.label}{v.capacity ? ` — ${v.capacity} posti` : ""}
                                {isOtherDriver ? ` (già assegnato)` : ""}
                              </option>
                            );
                          })}
                        </select>
                        {hasCambio && (
                          <input
                            type="time"
                            title="Fine utilizzo mezzo 1"
                            value={avail?.vehicle_1_to ?? ""}
                            className="border rounded px-1 py-0.5 text-xs w-20 flex-shrink-0"
                            onChange={e => updateAvailLocal(driver.id, { vehicle_1_to: e.target.value || null, vehicle_2_from: e.target.value || null })}
                            onBlur={() => void saveDriverAvail(driver.id)}
                          />
                        )}
                      </div>
                      {w1 ? <p className="text-xs text-amber-600 pl-16">{w1}</p> : null}

                      {/* Cambio mezzo checkbox */}
                      <label className="flex items-center gap-2 text-xs text-slate-500 cursor-pointer pl-16">
                        <input
                          type="checkbox"
                          checked={hasCambio}
                          onChange={e => toggleVehicleChange(driver.id, e.target.checked)}
                          className="accent-blue-600"
                        />
                        Cambio mezzo durante la giornata
                      </label>

                      {/* Mezzo 2 */}
                      {hasCambio ? (
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-slate-500 w-14 flex-shrink-0">Mezzo 2:</span>
                          <input
                            type="time"
                            title="Inizio utilizzo mezzo 2"
                            value={avail?.vehicle_2_from ?? avail?.vehicle_1_to ?? ""}
                            className="border rounded px-1 py-0.5 text-xs w-20 flex-shrink-0 bg-slate-50"
                            readOnly
                            tabIndex={-1}
                          />
                          <select
                            value={avail?.vehicle_2_id ?? ""}
                            className={`flex-1 min-w-0 border rounded-lg px-2 py-1 text-xs ${hasCambio && !avail?.vehicle_2_id ? "border-amber-300 bg-amber-50" : "border-slate-200"}`}
                            onChange={e => {
                              updateAvailLocal(driver.id, { vehicle_2_id: e.target.value || null });
                              void saveDriverAvail(driver.id, { vehicle_2_id: e.target.value || null });
                            }}
                          >
                            <option value="">— seleziona mezzo —</option>
                            {availableVehiclesList
                              .filter(v => v.id !== avail?.vehicle_1_id)
                              .map(v => {
                                const warn = vehicleWarning(driver.id, v.id);
                                const isOtherDriver = warn?.includes("già assegnato");
                                return (
                                  <option key={v.id} value={v.id} disabled={Boolean(isOtherDriver)}>
                                    {v.label}{v.capacity ? ` — ${v.capacity} posti` : ""}
                                    {isOtherDriver ? ` (già assegnato)` : ""}
                                  </option>
                                );
                              })}
                          </select>
                        </div>
                      ) : null}
                      {w2 ? <p className="text-xs text-amber-600 pl-16">{w2}</p> : null}
                    </div>
                  ) : null}

                  {/* ── Badge accesso + form crea account ────────────── */}
                  {driver.access_suspended ? (
                    <p className="mt-1.5 text-xs text-rose-600 font-medium">Accesso sospeso</p>
                  ) : !driver.has_access ? (
                    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2">
                      {creatingAccessFor === driver.id ? (
                        <div className="space-y-2">
                          <p className="text-xs font-semibold text-amber-700">Crea account per {driver.full_name}</p>
                          <div className="flex gap-2">
                            <input
                              type="tel"
                              placeholder="+39 3xx xxxxxxx"
                              value={createAccessPhone}
                              onChange={e => setCreateAccessPhone(e.target.value)}
                              className="flex-1 border rounded-lg px-2 py-1 text-xs"
                            />
                            <button
                              type="button"
                              disabled={createAccessLoading}
                              onClick={() => void handleCreateAccess(driver.id)}
                              className="text-xs bg-amber-500 text-white rounded-lg px-3 py-1 font-semibold disabled:opacity-60"
                            >
                              {createAccessLoading ? "..." : "Crea"}
                            </button>
                            <button
                              type="button"
                              onClick={() => { setCreatingAccessFor(null); setCreateAccessPhone(""); }}
                              className="text-xs text-slate-500"
                            >✕</button>
                          </div>
                          <p className="text-xs text-amber-500">Il telefono sarà usato come password temporanea.</p>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs text-amber-600">Senza accesso utente collegato</p>
                          <button
                            type="button"
                            onClick={() => { setCreatingAccessFor(driver.id); setCreateAccessPhone(driver.phone ?? ""); }}
                            className="text-xs bg-amber-500 text-white rounded-lg px-2 py-1 hover:bg-amber-600"
                          >
                            Crea account
                          </button>
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        {/* ══ MEZZI ════════════════════════════════════════════════════════════ */}
        <div>
          <h2 className="text-base font-bold text-slate-700 mb-3">Mezzi ({availableVehicles}/{vehicles.length} disponibili)</h2>
          <div className="space-y-2">
            {loading ? (
              <div className="card p-4 text-sm text-slate-400">Caricamento...</div>
            ) : vehicles.length === 0 ? (
              <div className="card p-4 text-sm text-slate-400">Nessun mezzo trovato.</div>
            ) : vehicles.map(vehicle => {
              const avail = vehicleAvail.get(vehicle.id);
              const commitment = commitmentByVehicleId.get(vehicle.id);
              const isAvailable = avail?.available !== false && !commitment;
              const vehicleBlocks = blocks.filter(b => b.vehicle_id === vehicle.id);

              // Mostra a quale autista è assegnato
              const assignedTo = (() => {
                for (const [pid, da] of driverAvail.entries()) {
                  if (!da.available) continue;
                  if (da.vehicle_1_id === vehicle.id || da.vehicle_2_id === vehicle.id) {
                    return drivers.find(d => d.id === pid)?.full_name ?? null;
                  }
                }
                return null;
              })();

              return (
                <div key={vehicle.id} className={`card p-3 transition ${isAvailable ? "" : "opacity-60 bg-slate-50"}`}>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      disabled={saving === vehicle.id || Boolean(commitment)}
                      onClick={() => void toggleVehicle(vehicle.id, isAvailable)}
                      className={`w-10 h-6 rounded-full transition-colors flex-shrink-0 ${isAvailable ? "bg-emerald-500" : "bg-slate-300"}`}
                    >
                      <span className={`block w-4 h-4 rounded-full bg-white shadow mx-1 transition-transform ${isAvailable ? "translate-x-4" : ""}`} />
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold text-slate-800">{vehicle.label}</p>
                        {vehicle.plate && (
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-slate-500">{vehicle.plate}</span>
                        )}
                        {assignedTo ? (
                          <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[11px] font-semibold text-blue-700">{assignedTo}</span>
                        ) : null}
                      </div>
                      {vehicle.capacity ? <p className="text-xs text-slate-500">{vehicle.capacity} posti</p> : null}
                      {commitment ? (
                        <p className="mt-1 text-xs font-semibold text-rose-700">
                          Impegno: {COMMITMENT_LABELS[commitment.commitment_type] ?? commitment.commitment_type}
                          {commitment.notes ? ` · ${commitment.notes}` : ""}
                        </p>
                      ) : null}
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
                          <span className="font-mono font-semibold text-orange-700">{block.block_from.slice(0, 5)}–{block.block_to.slice(0, 5)}</span>
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

      {/* Legenda date */}
      <div className="mt-6 flex items-center justify-end gap-1 text-xs text-slate-400">
        <span>Oggi: {isoToIt(todayIso())}</span>
      </div>
    </section>
  );
}
