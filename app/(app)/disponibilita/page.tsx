"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
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

function shiftIsoDate(iso: string, days: number) {
  const value = new Date(`${iso}T12:00:00`);
  value.setDate(value.getDate() + days);
  return value.toISOString().slice(0, 10);
}

function vehicleThumbnailSrc(vehicle: Vehicle) {
  const value = `${vehicle.label} ${vehicle.vehicle_size ?? ""}`.toLowerCase();
  if (value.includes("bus") || (vehicle.capacity ?? 0) >= 18) return "/images/fleet-bus.png";
  if (value.includes("auto") || value.includes("car") || (vehicle.capacity ?? 0) <= 5) return "/images/fleet-auto.png";
  return "/images/fleet-van.png";
}

function AvailabilityKpiIcon({ type }: { type: "driver" | "vehicle" | "unassigned" | "conflict" | "blocked" }) {
  const common = { width: 27, height: 27, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (type === "driver") return <svg {...common}><circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></svg>;
  if (type === "vehicle") return <svg {...common}><path d="M5 17h14l1-5-2-5H6l-2 5 1 5Z"/><path d="M7 7h10M5 12h14"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></svg>;
  if (type === "unassigned") return <svg {...common}><circle cx="10" cy="7" r="3.5"/><path d="M3.5 20a6.5 6.5 0 0 1 11.5-4.2"/><path d="m16 19 2 2 4-5"/></svg>;
  if (type === "conflict") return <svg {...common}><path d="M10.3 3.6 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z" fill="currentColor" stroke="none"/><path d="M12 8v5M12 17h.01" stroke="white"/></svg>;
  return <svg {...common}><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></svg>;
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
  const [search, setSearch] = useState("");
  const [driverFilter, setDriverFilter] = useState<"all" | "available" | "unavailable" | "no_access">("all");
  const [vehicleFilter, setVehicleFilter] = useState<"all" | "available" | "unavailable">("all");

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
      const sortedDrivers = body.drivers.sort((a, b) => a.full_name.localeCompare(b.full_name, "it"));
      setDrivers(sortedDrivers);
      driversRef.current = sortedDrivers;
      setVehicles(body.vehicles);
      const availMap = new Map(body.driver_availability.map(a => [a.driver_profile_id, a]));
      setDriverAvail(availMap);
      driverAvailRef.current = availMap;
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
      const next = new Map(driverAvailRef.current);
      next.set(driverId, current);
      driverAvailRef.current = next;
      setDriverAvail(next);
      setSaving(null);
      return;
    }
    const next = new Map(driverAvailRef.current);
    next.set(driverId, merged);
    driverAvailRef.current = next;
    setDriverAvail(next);
    setSaving(null);
  }, [date, post]);

  const toggleDriver = async (driverId: string) => {
    const driver = driversRef.current.find(d => d.id === driverId);
    const current = driverAvailRef.current.get(driverId) ?? emptyAvail(driverId, driver?.user_id ?? null);
    await saveDriverAvail(driverId, { available: !current.available });
  };

  // ── Gestione mezzo ────────────────────────────────────────────────────────

  function updateAvailLocal(driverId: string, fields: Partial<DriverAvail>) {
    const next = new Map(driverAvailRef.current);
    const driver = driversRef.current.find(d => d.id === driverId);
    const ex = next.get(driverId) ?? emptyAvail(driverId, driver?.user_id ?? null);
    next.set(driverId, { ...ex, ...fields });
    driverAvailRef.current = next;
    setDriverAvail(next);
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
    setError(null);
    try {
      if (!confirmed) {
        for (const driver of driversRef.current) {
          const current = driverAvailRef.current.get(driver.id) ?? emptyAvail(driver.id, driver.user_id);
          const res = await post({
            action: "save_driver",
            date,
            driver_profile_id: driver.id,
            available: current.available,
            available_from: current.available_from,
            available_to: current.available_to,
            notes: current.notes,
            vehicle_1_id: current.vehicle_1_id,
            vehicle_1_from: current.vehicle_1_from,
            vehicle_1_to: current.vehicle_1_to,
            vehicle_2_id: current.vehicle_2_id,
            vehicle_2_from: current.vehicle_2_from,
            vehicle_2_to: current.vehicle_2_to,
          });
          if (!res?.ok) {
            setError(res?.error ?? `Salvataggio disponibilita fallito per ${driver.full_name}.`);
            return;
          }
        }
      }

      const action = confirmed ? "unconfirm" : "confirm";
      const res = await post({ action, date });
      if (res?.ok) {
        setConfirmed(!confirmed);
        setConfirmedAt(!confirmed ? new Date().toISOString() : null);
        if (!confirmed) await load();
      } else {
        setError(res?.error ?? "Conferma disponibilita fallita.");
      }
    } finally {
      setConfirming(false);
    }
  };

  // ── Statistiche ───────────────────────────────────────────────────────────

  const availableDrivers = drivers.filter(d => driverAvail.get(d.id)?.available !== false).length;
  const commitmentByVehicleId = new Map(commitments.map(c => [c.vehicle_id, c]));
  const availableVehicles = vehicles.filter(v => vehicleAvail.get(v.id)?.available !== false && !commitmentByVehicleId.has(v.id)).length;
  const availableVehiclesList = vehicles.filter(v => vehicleAvail.get(v.id)?.available !== false && !commitmentByVehicleId.has(v.id));
  const unavailableDrivers = drivers.length - availableDrivers;
  const unavailableVehicles = vehicles.length - availableVehicles;
  const driversWithoutAccess = drivers.filter(driver => !driver.has_access || driver.access_suspended).length;
  const driversWithoutVehicle = drivers.filter(driver => {
    const availability = driverAvail.get(driver.id);
    return availability?.available !== false && !availability?.vehicle_1_id;
  }).length;
  const conflictDriverIds = new Set<string>();
  const vehicleOwners = new Map<string, string>();
  for (const driver of drivers) {
    const availability = driverAvail.get(driver.id);
    if (availability?.available === false) continue;
    for (const vehicleId of [availability?.vehicle_1_id, availability?.vehicle_2_id]) {
      if (!vehicleId) continue;
      const owner = vehicleOwners.get(vehicleId);
      if (owner && owner !== driver.id) {
        conflictDriverIds.add(owner);
        conflictDriverIds.add(driver.id);
      } else {
        vehicleOwners.set(vehicleId, driver.id);
      }
    }
  }
  const normalizedSearch = search.trim().toLocaleLowerCase("it");
  const visibleDrivers = drivers.filter(driver => {
    const availability = driverAvail.get(driver.id);
    const matchesSearch = !normalizedSearch || `${driver.full_name} ${driver.phone ?? ""}`.toLocaleLowerCase("it").includes(normalizedSearch);
    if (!matchesSearch) return false;
    if (driverFilter === "available") return availability?.available !== false;
    if (driverFilter === "unavailable") return availability?.available === false;
    if (driverFilter === "no_access") return !driver.has_access || driver.access_suspended;
    return true;
  });
  const visibleVehicles = vehicles.filter(vehicle => {
    const available = vehicleAvail.get(vehicle.id)?.available !== false && !commitmentByVehicleId.has(vehicle.id);
    const matchesSearch = !normalizedSearch || `${vehicle.label} ${vehicle.plate ?? ""}`.toLocaleLowerCase("it").includes(normalizedSearch);
    if (!matchesSearch) return false;
    if (vehicleFilter === "available") return available;
    if (vehicleFilter === "unavailable") return !available;
    return true;
  });

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <section className="page-section mx-auto max-w-[1280px] space-y-3">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-slate-950">Disponibilità</h1>
          <p className="mt-1 text-sm font-medium capitalize text-slate-500">{new Intl.DateTimeFormat("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${date}T12:00:00`))}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setDate(shiftIsoDate(date, -1))} className="btn-secondary h-11 w-11 p-0 text-xl" aria-label="Giorno precedente">‹</button>
          <DateInput
            value={date}
            onChange={setDate}
            className="h-11 w-40 rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-800 shadow-sm outline-none transition focus:border-indigo-400"
          />
          <button type="button" onClick={() => setDate(shiftIsoDate(date, 1))} className="btn-secondary h-11 w-11 p-0 text-xl" aria-label="Giorno successivo">›</button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={confirming || loading} onClick={() => void handleConfirm()} className={`h-11 rounded-xl px-5 text-sm font-bold shadow-sm transition disabled:opacity-60 ${confirmed ? "border border-emerald-300 bg-white text-emerald-700" : "bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-blue-200"}`}>
            {confirming ? "Salvataggio..." : confirmed ? "✓ Disponibilità confermata" : "✓ Conferma disponibilità"}
          </button>
          <Link href="/piano-giorno" className="btn-secondary flex h-11 items-center px-5">▣ Piano del Giorno</Link>
        </div>
      </div>

      <div className={`flex flex-col gap-3 rounded-xl border px-5 py-3.5 sm:flex-row sm:items-center ${confirmed ? "border-emerald-300 bg-emerald-50/80" : "border-amber-300 bg-amber-50/80"}`}>
        <span className={`flex h-7 w-7 items-center justify-center rounded-full text-sm font-black text-white ${confirmed ? "bg-emerald-500" : "bg-amber-500"}`}>{confirmed ? "✓" : "!"}</span>
        <p className={`flex-1 text-sm font-semibold ${confirmed ? "text-emerald-900" : "text-amber-900"}`}>{confirmed ? `Disponibilità confermata per il ${isoToIt(date)}${confirmedAt ? ` alle ${new Date(confirmedAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}` : ""}` : `Disponibilità non ancora confermata per il ${isoToIt(date)}. Il Piano del Giorno resta bloccato.`}</p>
        {confirmed ? <button type="button" disabled={confirming} onClick={() => void handleConfirm()} className="rounded-lg border border-emerald-400 bg-white px-4 py-2 text-xs font-bold text-emerald-700">Annulla conferma</button> : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {([
          ["driver", "Autisti disponibili", `${availableDrivers}/${drivers.length}`, "bg-blue-50 text-blue-600"],
          ["vehicle", "Mezzi disponibili", `${availableVehicles}/${vehicles.length}`, "bg-violet-50 text-violet-600"],
          ["unassigned", "Autisti senza mezzo", driversWithoutVehicle, "bg-orange-50 text-orange-600"],
          ["conflict", "Conflitti", conflictDriverIds.size, "bg-rose-50 text-rose-600"],
          ["blocked", "Mezzi con blocchi", new Set(blocks.map(block => block.vehicle_id)).size, "bg-amber-50 text-amber-600"],
        ] as const).map(([icon, label, value, tone]) => <div key={label} className="flex h-[78px] items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 shadow-sm"><span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-lg ${tone}`}><AvailabilityKpiIcon type={icon} /></span><div><p className="text-[11px] font-medium text-slate-500">{label}</p><strong className="text-xl leading-none text-slate-950">{value}</strong></div></div>)}
      </div>

      {error ? <div className="card p-4 text-rose-600 text-sm mb-4">{error}</div> : null}

      {successMsg ? (
        <div className="card p-4 mb-4 border-emerald-300 bg-emerald-50 flex items-start justify-between gap-2">
          <p className="text-sm text-emerald-800 font-medium">{successMsg}</p>
          <button type="button" onClick={() => setSuccessMsg(null)} className="text-emerald-500 hover:text-emerald-700 text-xs">✕</button>
        </div>
      ) : null}

      <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1.16fr)_minmax(0,.88fr)_205px]">

        {/* ══ AUTISTI ══════════════════════════════════════════════════════════ */}
        <section className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xl font-extrabold text-slate-950">Autisti</h2>
            <button
              type="button"
              onClick={() => setShowAddDriver(!showAddDriver)}
              className="rounded-lg border border-indigo-300 px-3 py-2 text-xs font-bold text-indigo-600 hover:bg-indigo-50"
            >
              + Aggiungi autista
            </button>
          </div>
          <div className="mb-3 space-y-2">
            <div className="relative"><span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400">⌕</span><input value={search} onChange={event => setSearch(event.target.value)} className="input-saas h-9 w-full text-xs" style={{ paddingLeft: "2.5rem" }} placeholder="Cerca autista..." /></div>
            <div className="flex flex-wrap gap-1.5">
              {([["all", `Tutti ${drivers.length}`], ["available", `Disponibili ${availableDrivers}`], ["unavailable", `Indisponibili ${unavailableDrivers}`], ["no_access", `Senza accesso ${driversWithoutAccess}`]] as const).map(([value, label]) => <button key={value} type="button" onClick={() => setDriverFilter(value)} className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-bold ${driverFilter === value ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-slate-200 text-slate-500"}`}>{label}</button>)}
            </div>
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
            ) : visibleDrivers.length === 0 ? (
              <div className="card p-4 text-sm text-slate-400">Nessun autista trovato.</div>
            ) : visibleDrivers.map((driver, driverIndex) => {
              const avail = driverAvail.get(driver.id);
              const isAvailable = avail?.available !== false;
              const hasCambio = vehicleChangeEnabled.has(driver.id);
              const w1 = vehicleWarning(driver.id, avail?.vehicle_1_id);
              const w2 = vehicleWarning(driver.id, avail?.vehicle_2_id);

              return (
                <div key={driver.id} className={`grid gap-x-3 gap-y-1 rounded-xl border border-slate-200 bg-white p-2.5 shadow-sm transition sm:grid-cols-2 ${isAvailable ? "" : "bg-slate-50 opacity-60"}`}>
                  {/* ── Riga nome + toggle ─────────────────────────────── */}
                  <div className="flex items-center gap-2 sm:col-span-2">
                    <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-slate-200 text-[10px] font-bold text-slate-600">{driverIndex + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-slate-800">{driver.full_name}</p>
                      {driver.max_vehicle_capacity ? (
                        <p className="text-xs text-slate-400">Max {driver.max_vehicle_capacity} posti</p>
                      ) : null}
                    </div>
                    <div className="text-center">
                      <button
                        type="button"
                        disabled={saving === driver.id}
                        onClick={() => void toggleDriver(driver.id)}
                        className={`h-5 w-9 rounded-full transition-colors ${isAvailable ? "bg-emerald-500" : "bg-slate-300"}`}
                      >
                        <span className={`mx-1 block h-3 w-3 rounded-full bg-white shadow transition-transform ${isAvailable ? "translate-x-4" : ""}`} />
                      </button>
                      <span className={`mt-0.5 block text-[9px] font-semibold ${isAvailable ? "text-emerald-600" : "text-slate-400"}`}>{isAvailable ? "Disponibile" : "Non disponibile"}</span>
                    </div>
                    {/* Orari disponibilità */}
                    {isAvailable ? (
                      <div className="flex items-end gap-1 text-xs text-slate-500">
                        <span className="mb-2 hidden text-[9px] font-semibold text-slate-500 2xl:inline">Orario disponibilità</span>
                        <input
                          type="time"
                          value={avail?.available_from ?? ""}
                          className="h-8 w-[74px] rounded-md border border-slate-200 px-1 text-xs"
                          onChange={e => updateAvailLocal(driver.id, { available_from: e.target.value || null })}
                          onBlur={() => void saveDriverAvail(driver.id)}
                        />
                        <span>–</span>
                        <input
                          type="time"
                          value={avail?.available_to ?? ""}
                          className="h-8 w-[74px] rounded-md border border-slate-200 px-1 text-xs"
                          onChange={e => updateAvailLocal(driver.id, { available_to: e.target.value || null })}
                          onBlur={() => void saveDriverAvail(driver.id)}
                        />
                      </div>
                    ) : null}
                  </div>

                  {/* ── Note ─────────────────────────────────────────── */}
                  {isAvailable ? (
                    <label className="block self-start text-[9px] font-semibold text-slate-500">Note
                      <input
                        type="text"
                        placeholder="Note (facoltative)..."
                        value={avail?.notes ?? ""}
                        maxLength={200}
                        className="mt-0.5 h-8 w-full rounded-lg border border-slate-200 px-2 text-xs font-normal text-slate-600 placeholder:text-slate-300"
                        onChange={e => updateAvailLocal(driver.id, { notes: e.target.value || null })}
                        onBlur={() => void saveDriverAvail(driver.id)}
                      />
                    </label>
                  ) : null}

                  {/* ── Assegnazione mezzo ────────────────────────────── */}
                  {isAvailable ? (
                    <div className="space-y-1 border-l border-slate-100 pl-3">
                      {/* Mezzo 1 */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="w-14 flex-shrink-0 text-[9px] font-semibold text-slate-500">Mezzo 1</span>
                        <select
                          value={avail?.vehicle_1_id ?? ""}
                          className={`h-8 min-w-0 flex-1 rounded-lg border px-2 text-xs ${!avail?.vehicle_1_id ? "border-amber-300 bg-amber-50" : "border-slate-200"}`}
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
                    <p className="mt-1.5 text-xs font-medium text-rose-600 sm:col-span-2">Accesso sospeso</p>
                  ) : !driver.has_access ? (
                    <div className="mt-1 rounded-lg border border-amber-200 bg-amber-50 p-2 sm:col-span-2">
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
        </section>

        {/* ══ MEZZI ════════════════════════════════════════════════════════════ */}
        <section className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
          <h2 className="text-xl font-extrabold text-slate-950">Mezzi</h2>
          <div className="mb-3 mt-2 flex flex-wrap gap-1.5">
            {([["all", `Tutti ${vehicles.length}`], ["available", `Disponibili ${availableVehicles}`], ["unavailable", `Indisponibili ${unavailableVehicles}`]] as const).map(([value, label]) => <button key={value} type="button" onClick={() => setVehicleFilter(value)} className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-bold ${vehicleFilter === value ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-slate-200 text-slate-500"}`}>{label}</button>)}
          </div>
          <div className="space-y-2">
            {loading ? (
              <div className="card p-4 text-sm text-slate-400">Caricamento...</div>
            ) : visibleVehicles.length === 0 ? (
              <div className="card p-4 text-sm text-slate-400">Nessun mezzo trovato.</div>
            ) : visibleVehicles.map(vehicle => {
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
                <div key={vehicle.id} className={`rounded-xl border border-slate-200 bg-white p-2 shadow-sm transition ${isAvailable ? "" : "bg-slate-50 opacity-70"}`}>
                  <div className="flex items-center gap-2">
                    <div className="relative h-14 w-[76px] flex-shrink-0 overflow-hidden rounded-lg bg-white">
                      <Image src={vehicleThumbnailSrc(vehicle)} alt={`Foto ${vehicle.label}`} fill sizes="76px" className="object-contain" quality={100} />
                    </div>
                    <button
                      type="button"
                      disabled={saving === vehicle.id || Boolean(commitment)}
                      onClick={() => void toggleVehicle(vehicle.id, isAvailable)}
                      className={`h-6 w-10 flex-shrink-0 rounded-full transition-colors ${isAvailable ? "bg-emerald-500" : "bg-slate-300"}`}
                    >
                      <span className={`block w-4 h-4 rounded-full bg-white shadow mx-1 transition-transform ${isAvailable ? "translate-x-4" : ""}`} />
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <p className="text-sm font-bold leading-5 text-slate-800">{vehicle.label}</p>
                        {vehicle.plate && (
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-slate-500">{vehicle.plate}</span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {vehicle.capacity ? <p className="text-[11px] text-slate-500">{vehicle.capacity} posti</p> : null}
                        {assignedTo ? <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">{assignedTo}</span> : null}
                      </div>
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
                        className="flex-shrink-0 rounded-lg border border-indigo-300 px-2 py-1.5 text-[11px] font-semibold text-indigo-600 hover:bg-indigo-50"
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
        </section>

        <aside className="space-y-3 xl:sticky xl:top-4">
          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-lg font-extrabold text-slate-950">Controllo disponibilità</h2>
            <div className="mt-3 divide-y divide-slate-100">
              {[
                ["▲", "Conflitti mezzo", conflictDriverIds.size, "bg-rose-100 text-rose-700"],
                ["♟", "Autisti senza mezzo", driversWithoutVehicle, "bg-orange-100 text-orange-700"],
                ["!", "Autisti senza accesso", driversWithoutAccess, "bg-amber-100 text-amber-700"],
              ].map(([icon, label, value, tone]) => <div key={String(label)} className="flex items-center gap-2 py-3"><span className={`flex h-8 w-8 items-center justify-center rounded-lg text-xs font-black ${tone}`}>{icon}</span><span className="min-w-0 flex-1 text-xs font-semibold text-slate-600">{label}</span><strong className="text-lg text-slate-950">{value}</strong></div>)}
            </div>
            <Link href="/dispatch" className="mt-3 block rounded-lg border border-indigo-400 px-3 py-2.5 text-center text-xs font-bold text-indigo-600 hover:bg-indigo-50">Risolvi conflitti</Link>
          </section>
          <section className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-500 shadow-sm">
            <h3 className="text-sm font-extrabold text-slate-900">Come funziona</h3>
            <p className="mt-2 leading-5">Imposta orari, mezzi e blocchi. Poi conferma la giornata per abilitare il Piano del Giorno.</p>
            <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 font-semibold">Oggi: {isoToIt(todayIso())}</div>
          </section>
        </aside>
      </div>

    </section>
  );
}
