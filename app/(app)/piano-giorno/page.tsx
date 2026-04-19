"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase, hasSupabaseEnv } from "@/lib/supabase/client";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { PageHeader } from "@/components/ui";

// ─── Tipi ─────────────────────────────────────────────────────────────────────

type Service = {
  id: string; date: string; time: string; direction: "arrival" | "departure";
  customer_name: string; customer_first_name?: string | null; customer_last_name?: string | null;
  pax: number; hotel_id: string | null; vessel: string | null; notes: string | null;
  status: string; meeting_point: string | null; place_type: string | null;
  pickup_hotel: string | null; phone: string | null;
};
type TripGroup = {
  id: string; date: string; driver_user_id: string | null; vehicle_label: string | null;
  vehicle_capacity: number | null; notes: string | null; status: string;
};
type Assignment = {
  id: string; service_id: string; driver_user_id: string | null;
  vehicle_label: string | null; group_id: string | null;
};
type Hotel = { id: string; name: string; zone: string | null };
type Member = { user_id: string; full_name: string; role: string };
type Vehicle = { id: string; label: string; capacity: number | null; vehicle_size: string | null };
type FerrySchedule = { id: string; company: string; departure_port: string; arrival_port: string; departure_time: string; notes: string | null };

type DayData = {
  services: Service[]; trip_groups: TripGroup[]; assignments: Assignment[];
  hotels: Hotel[]; memberships: Member[]; vehicles: Vehicle[]; ferry_schedules: FerrySchedule[];
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(time: string) { return time?.slice(0, 5) ?? "—"; }
function today() { return new Date().toISOString().slice(0, 10); }
function companyLabel(c: string) {
  return c === "medmar" ? "Medmar" : c === "snav" ? "SNAV" : c === "alilauro" ? "Alilauro" : c;
}
function portLabel(p: string) {
  if (p === "ischia_porto") return "Ischia Porto";
  if (p === "casamicciola") return "Casamicciola";
  if (p === "napoli_beverello") return "Napoli Bev.";
  if (p === "pozzuoli") return "Pozzuoli";
  return p;
}
function customerName(s: Service) {
  return [s.customer_first_name, s.customer_last_name].filter(Boolean).join(" ") || s.customer_name;
}
function tripServiceStatus(services: Service[]): "todo" | "ongoing" | "done" {
  if (!services.length) return "todo";
  const statuses = services.map((s) => s.status);
  if (statuses.every((s) => s === "completato")) return "done";
  if (statuses.some((s) => ["partito", "arrivato", "completato"].includes(s))) return "ongoing";
  return "todo";
}

// ─── Hook caricamento dati ────────────────────────────────────────────────────

function usePianoGiornoData(date: string) {
  const [data, setData] = useState<DayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (tok: string) => {
    const res = await fetch(`/api/ops/piano-giorno?date=${date}`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) { setError("Errore caricamento dati."); return; }
    const json = (await res.json()) as DayData & { ok: boolean };
    if (json.ok) setData(json);
  }, [date]);

  useEffect(() => {
    let active = true;
    const boot = async () => {
      setLoading(true); setError(null);
      const session = await getClientSessionContext();
      if (!hasSupabaseEnv || !supabase || !session.userId || !session.tenantId) {
        if (active) { setError("Login richiesto."); setLoading(false); }
        return;
      }
      setTenantId(session.tenantId);
      const { data: s } = await supabase.auth.getSession();
      const tok = s.session?.access_token ?? null;
      if (!tok) { if (active) { setError("Sessione non valida."); setLoading(false); } return; }
      setToken(tok);
      await load(tok);
      if (active) setLoading(false);
    };
    void boot();
    return () => { active = false; };
  }, [date, load]);

  // Realtime
  useEffect(() => {
    if (!supabase || !tenantId || !token) return;
    const scheduleRefresh = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => { void load(token); }, 500);
    };
    const channel = supabase
      .channel(`piano-giorno-${tenantId}-${date}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "services", filter: `tenant_id=eq.${tenantId}` }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "assignments", filter: `tenant_id=eq.${tenantId}` }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "trip_groups", filter: `tenant_id=eq.${tenantId}` }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "status_events", filter: `tenant_id=eq.${tenantId}` }, scheduleRefresh)
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [supabase, tenantId, token, date, load]);

  const reload = useCallback(() => { if (token) void load(token); }, [token, load]);
  return { data, loading, error, token, reload };
}

// ─── Trip action helper ────────────────────────────────────────────────────────

async function tripAction(token: string, body: Record<string, unknown>) {
  const res = await fetch("/api/ops/piano-giorno/trips", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok: boolean; group_id?: string; error?: string };
}

// ─── Driver Timeline ──────────────────────────────────────────────────────────

function DriverTimeline({ trips, tripServices }: {
  trips: TripGroup[];
  tripServices: Map<string, Service[]>;
}) {
  const slots = useMemo(() => {
    const all: Array<{ time: string; label: string; status: string }> = [];
    for (const t of trips) {
      const svcs = tripServices.get(t.id) ?? [];
      const time = svcs[0]?.time ?? "";
      const st = tripServiceStatus(svcs);
      all.push({ time, label: fmt(time), status: st });
    }
    return all.sort((a, b) => a.time.localeCompare(b.time));
  }, [trips, tripServices]);

  if (!slots.length) return <span className="text-xs text-slate-400">Nessun giro</span>;

  return (
    <div className="flex gap-1 flex-wrap">
      {slots.map((s, i) => (
        <span
          key={i}
          className={`rounded px-1.5 py-0.5 text-[10px] font-mono font-semibold ${
            s.status === "done" ? "bg-emerald-100 text-emerald-700"
            : s.status === "ongoing" ? "bg-amber-100 text-amber-700"
            : "bg-slate-100 text-slate-600"
          }`}
        >
          {s.label}
        </span>
      ))}
    </div>
  );
}

// ─── Pannello POOL (sinistra) ─────────────────────────────────────────────────

type PoolProps = {
  services: Service[];
  hotels: Map<string, Hotel>;
  assignments: Map<string, Assignment>;
  ferrySchedules: FerrySchedule[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onSelectGroup: (ids: string[]) => void;
};

function PoolPanel({ services, hotels, assignments, ferrySchedules, selectedIds, onToggle, onSelectGroup }: PoolProps) {
  const [tab, setTab] = useState<"arrivals" | "departures">("arrivals");
  const [filter, setFilter] = useState<"all" | "unassigned" | "assigned">("unassigned");
  const [search, setSearch] = useState("");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const arrivals = useMemo(() => services.filter((s) => s.direction === "arrival"), [services]);
  const departures = useMemo(() => services.filter((s) => s.direction === "departure"), [services]);

  const filterSvc = useCallback((list: Service[]) => {
    let out = list;
    if (filter === "unassigned") out = out.filter((s) => !assignments.has(s.id));
    if (filter === "assigned") out = out.filter((s) => assignments.has(s.id));
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter((s) => customerName(s).toLowerCase().includes(q) || (hotels.get(s.hotel_id ?? "")?.name ?? "").toLowerCase().includes(q));
    }
    return out;
  }, [filter, search, assignments, hotels]);

  // Raggruppa arrivi per vessel (corsa traghetto)
  const arrivalGroups = useMemo(() => {
    const filtered = filterSvc(arrivals);
    const map = new Map<string, Service[]>();
    for (const s of filtered) {
      const key = s.vessel?.trim() || "—";
      map.set(key, [...(map.get(key) ?? []), s]);
    }
    // Ordina per orario arrivo del primo elemento
    return Array.from(map.entries()).sort((a, b) => (a[1][0]?.time ?? "").localeCompare(b[1][0]?.time ?? ""));
  }, [arrivals, filterSvc]);

  // Raggruppa partenze per fascia pickup + zona hotel
  const departureGroups = useMemo(() => {
    const filtered = filterSvc(departures);
    const map = new Map<string, Service[]>();
    for (const s of filtered) {
      const zone = hotels.get(s.hotel_id ?? "")?.zone ?? "—";
      const pickupTime = s.pickup_hotel ? fmt(s.pickup_hotel) : fmt(s.time);
      const key = `${pickupTime}|${zone}`;
      map.set(key, [...(map.get(key) ?? []), s]);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [departures, filterSvc, hotels]);

  const groups = tab === "arrivals" ? arrivalGroups : departureGroups;
  const totalUnassigned = (tab === "arrivals" ? arrivals : departures).filter((s) => !assignments.has(s.id)).length;
  const totalPax = (tab === "arrivals" ? arrivals : departures).reduce((n, s) => n + s.pax, 0);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Tab */}
      <div className="flex border-b border-slate-200 mb-2">
        {(["arrivals", "departures"] as const).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); setExpandedKey(null); }}
            className={`flex-1 py-2 text-xs font-semibold uppercase tracking-wide transition-colors ${
              tab === t ? "border-b-2 border-blue-600 text-blue-700" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {t === "arrivals" ? `Arrivi (${arrivals.length})` : `Partenze (${departures.length})`}
          </button>
        ))}
      </div>

      {/* Filtri */}
      <div className="flex gap-1.5 mb-2 flex-wrap">
        <input
          className="input-saas flex-1 min-w-[120px] text-xs"
          placeholder="Cerca cliente…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {(["unassigned", "assigned", "all"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
              filter === f ? "bg-slate-700 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {f === "unassigned" ? "Non assegnati" : f === "assigned" ? "Assegnati" : "Tutti"}
          </button>
        ))}
      </div>

      <p className="text-[11px] text-slate-500 mb-2">
        Non assegnati: <strong>{totalUnassigned}</strong> · PAX totali: <strong>{totalPax}</strong>
      </p>

      {/* Gruppi */}
      <div className="flex-1 overflow-y-auto space-y-1 pr-1">
        {groups.length === 0 && (
          <p className="text-sm text-slate-400 text-center py-8">Nessun servizio</p>
        )}
        {groups.map(([key, svcs]) => {
          const isOpen = expandedKey === key;
          const groupPax = svcs.reduce((n, s) => n + s.pax, 0);
          const assignedCount = svcs.filter((s) => assignments.has(s.id)).length;
          const allSelected = svcs.every((s) => selectedIds.has(s.id));

          // Label gruppo
          let groupLabel = "";
          let groupSub = "";
          if (tab === "arrivals") {
            const ferry = ferrySchedules.find((f) => svcs[0]?.vessel?.toLowerCase().includes(f.company.toLowerCase()));
            groupLabel = svcs[0]?.vessel || "—";
            groupSub = `ore ${fmt(svcs[0]?.time ?? "")}`;
            if (ferry) groupSub += ` · ${portLabel(ferry.arrival_port)}`;
          } else {
            const [time, zone] = key.split("|");
            groupLabel = `Pickup ${time}`;
            groupSub = zone;
          }

          return (
            <div key={key} className="rounded-lg border border-slate-200 bg-white overflow-hidden">
              {/* Header gruppo */}
              <button
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-slate-50 transition-colors text-left"
                onClick={() => setExpandedKey(isOpen ? null : key)}
              >
                <span className={`transition-transform ${isOpen ? "rotate-90" : ""} text-slate-400 text-xs`}>▶</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-slate-800 truncate">{groupLabel}</p>
                  <p className="text-[10px] text-slate-500">{groupSub}</p>
                </div>
                <div className="flex flex-col items-end gap-0.5">
                  <span className="text-[10px] font-mono text-slate-600">{groupPax} PAX</span>
                  <span className={`text-[10px] ${assignedCount === svcs.length ? "text-emerald-600" : "text-amber-600"}`}>
                    {assignedCount}/{svcs.length} ass.
                  </span>
                </div>
                {/* Seleziona tutto il gruppo */}
                <button
                  className={`ml-1 text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                    allSelected ? "bg-blue-600 border-blue-600 text-white" : "border-slate-300 text-slate-500 hover:border-blue-400"
                  }`}
                  onClick={(e) => { e.stopPropagation(); onSelectGroup(svcs.map((s) => s.id)); }}
                  title={allSelected ? "Deseleziona tutto" : "Seleziona tutto il gruppo"}
                >
                  {allSelected ? "✓ tutto" : "+ tutto"}
                </button>
              </button>

              {/* Righe clienti */}
              {isOpen && (
                <div className="border-t border-slate-100">
                  {svcs.map((svc) => {
                    const hotel = hotels.get(svc.hotel_id ?? "");
                    const isSelected = selectedIds.has(svc.id);
                    const isAssigned = assignments.has(svc.id);
                    return (
                      <label
                        key={svc.id}
                        className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors ${
                          isSelected ? "bg-blue-50" : isAssigned ? "bg-slate-50" : "hover:bg-slate-50"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => onToggle(svc.id)}
                          className="rounded accent-blue-600 shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-slate-800 truncate">{customerName(svc)}</p>
                          <p className="text-[10px] text-slate-500 truncate">
                            {hotel?.name ?? "—"} {hotel?.zone ? `(${hotel.zone})` : ""}
                            {svc.phone ? ` · ${svc.phone}` : ""}
                          </p>
                        </div>
                        <div className="flex flex-col items-end shrink-0">
                          <span className="text-[10px] font-semibold text-slate-700">{svc.pax} px</span>
                          {isAssigned && <span className="text-[10px] text-emerald-600">✓ ass.</span>}
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Pannello BUILDER (centro) ────────────────────────────────────────────────

type BuilderProps = {
  selectedIds: Set<string>;
  services: Map<string, Service>;
  hotels: Map<string, Hotel>;
  drivers: Member[];
  vehicles: Vehicle[];
  tripGroups: TripGroup[];
  assignments: Map<string, Assignment>;
  token: string;
  date: string;
  onRemove: (id: string) => void;
  onClear: () => void;
  onDone: () => void;
};

function TripBuilder({ selectedIds, services, hotels, drivers, vehicles, tripGroups, assignments, token, date, onRemove, onClear, onDone }: BuilderProps) {
  const [driverId, setDriverId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selectedList = useMemo(() => [...selectedIds].map((id) => services.get(id)).filter(Boolean) as Service[], [selectedIds, services]);
  const totalPax = selectedList.reduce((n, s) => n + s.pax, 0);
  const selectedVehicle = vehicles.find((v) => v.id === vehicleId);
  const overbooking = selectedVehicle?.capacity ? totalPax - selectedVehicle.capacity : 0;

  // Occupazione autista: giri già assegnati nel giorno
  const driverBusy = useMemo(() => {
    const map = new Map<string, string[]>(); // driver_user_id → orari
    for (const tg of tripGroups) {
      if (!tg.driver_user_id) continue;
      map.set(tg.driver_user_id, [...(map.get(tg.driver_user_id) ?? []), tg.id]);
    }
    return map;
  }, [tripGroups]);

  // Orario del primo servizio selezionato (per conflict check)
  const firstTime = selectedList.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""))[0]?.time ?? "";

  // Controlla se un autista ha un giro a meno di 30 min dal primo servizio selezionato
  const driverConflict = useCallback((dId: string): "busy" | "close" | "ok" => {
    const groupIds = driverBusy.get(dId) ?? [];
    if (!groupIds.length) return "ok";
    // Se ha giri che includono servizi allo stesso orario → busy
    return groupIds.length > 0 ? "close" : "ok";
  }, [driverBusy]);

  const confirm = async () => {
    if (!selectedIds.size) return;
    setSaving(true); setErr(null);
    const vehicle = vehicles.find((v) => v.id === vehicleId);
    const res = await tripAction(token, {
      action: "create_trip",
      date,
      service_ids: [...selectedIds],
      driver_user_id: driverId || null,
      vehicle_label: vehicle?.label ?? vehicleId ?? null,
      vehicle_capacity: vehicle?.capacity ?? null,
      notes: notes || null,
    });
    setSaving(false);
    if (!res.ok) { setErr(res.error ?? "Errore salvataggio."); return; }
    onClear();
    onDone();
  };

  if (!selectedIds.size) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6">
        <div className="text-4xl mb-3">🚐</div>
        <p className="text-sm font-semibold text-slate-600">Seleziona clienti dal pool</p>
        <p className="text-xs text-slate-400 mt-1">Usa le checkbox a sinistra per creare un giro</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-slate-800">Nuovo giro</h3>
        <button onClick={onClear} className="text-xs text-slate-400 hover:text-slate-600">✕ Svuota</button>
      </div>

      {/* Clienti selezionati */}
      <div className="flex-1 overflow-y-auto space-y-1 mb-3 min-h-0">
        {selectedList.map((svc) => (
          <div key={svc.id} className="flex items-center gap-2 bg-blue-50 border border-blue-100 rounded px-2 py-1.5">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-slate-800 truncate">{customerName(svc)}</p>
              <p className="text-[10px] text-slate-500">{hotels.get(svc.hotel_id ?? "")?.name ?? "—"} · {fmt(svc.time)}</p>
            </div>
            <span className="text-[10px] font-semibold text-slate-600 shrink-0">{svc.pax} px</span>
            <button onClick={() => onRemove(svc.id)} className="text-slate-300 hover:text-red-500 text-xs shrink-0">✕</button>
          </div>
        ))}
      </div>

      {/* Totale PAX + overbooking */}
      <div className={`rounded px-3 py-1.5 mb-3 text-sm font-bold text-center ${
        overbooking > 0 ? "bg-red-50 text-red-600 border border-red-200" : "bg-slate-100 text-slate-700"
      }`}>
        {overbooking > 0
          ? `⚠️ OVERBOOKING: +${overbooking} posti (${totalPax} su ${selectedVehicle?.capacity})`
          : `Totale: ${totalPax} PAX`}
      </div>

      {/* Autista */}
      <label className="block mb-2">
        <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wide">Autista</span>
        <select
          className="input-saas mt-1 text-sm w-full"
          value={driverId}
          onChange={(e) => setDriverId(e.target.value)}
        >
          <option value="">— Seleziona autista —</option>
          {drivers.filter((d) => d.role === "driver").map((d) => {
            const conflict = driverConflict(d.user_id);
            return (
              <option key={d.user_id} value={d.user_id}>
                {d.full_name}
                {conflict === "close" ? " ⚠" : ""}
                {` (${driverBusy.get(d.user_id)?.length ?? 0} giri)`}
              </option>
            );
          })}
        </select>
        {driverId && driverConflict(driverId) === "close" && (
          <p className="text-[10px] text-amber-600 mt-0.5">⚠ Autista ha già giri assegnati oggi — verifica disponibilità</p>
        )}
      </label>

      {/* Mezzo */}
      <label className="block mb-2">
        <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wide">Mezzo</span>
        <select
          className="input-saas mt-1 text-sm w-full"
          value={vehicleId}
          onChange={(e) => setVehicleId(e.target.value)}
        >
          <option value="">— Seleziona mezzo —</option>
          {vehicles.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}{v.capacity ? ` (${v.capacity} posti)` : ""}
            </option>
          ))}
        </select>
      </label>

      {/* Note */}
      <label className="block mb-3">
        <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wide">Note giro</span>
        <textarea
          className="input-saas mt-1 text-sm w-full resize-none"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Note opzionali…"
        />
      </label>

      {err && <p className="text-xs text-red-600 mb-2">{err}</p>}

      <button
        onClick={() => void confirm()}
        disabled={saving}
        className="btn-primary w-full text-sm disabled:opacity-50"
      >
        {saving ? "Salvataggio…" : "Conferma giro"}
      </button>
    </div>
  );
}

// ─── Pannello AUTISTI (destra) ────────────────────────────────────────────────

type DriverPanelProps = {
  drivers: Member[];
  tripGroups: TripGroup[];
  tripServices: Map<string, Service[]>;
  token: string;
  vehicles: Vehicle[];
  onUpdated: () => void;
};

function DriverPanel({ drivers, tripGroups, tripServices, token, vehicles, onUpdated }: DriverPanelProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [editDriver, setEditDriver] = useState("");
  const [editVehicle, setEditVehicle] = useState("");
  const [saving, setSaving] = useState(false);

  const byDriver = useMemo(() => {
    const map = new Map<string, TripGroup[]>();
    for (const tg of tripGroups) {
      const key = tg.driver_user_id ?? "__unassigned__";
      map.set(key, [...(map.get(key) ?? []), tg]);
    }
    return map;
  }, [tripGroups]);

  const driverList = useMemo(() => {
    const active = drivers.filter((d) => d.role === "driver");
    // Ordina: chi ha giri assegnati prima
    return active.sort((a, b) => {
      const aTrips = byDriver.get(a.user_id)?.length ?? 0;
      const bTrips = byDriver.get(b.user_id)?.length ?? 0;
      return bTrips - aTrips;
    });
  }, [drivers, byDriver]);

  const deleteTrip = async (groupId: string) => {
    if (!confirm("Eliminare questo giro? I clienti torneranno nel pool.")) return;
    setSaving(true);
    await tripAction(token, { action: "delete_trip", group_id: groupId });
    setSaving(false);
    onUpdated();
  };

  const saveEdit = async (groupId: string) => {
    setSaving(true);
    const vehicle = vehicles.find((v) => v.id === editVehicle);
    await tripAction(token, {
      action: "update_trip",
      group_id: groupId,
      driver_user_id: editDriver || null,
      vehicle_label: vehicle?.label ?? editVehicle ?? null,
      vehicle_capacity: vehicle?.capacity ?? null,
    });
    setSaving(false);
    setEditingGroup(null);
    onUpdated();
  };

  const unassigned = byDriver.get("__unassigned__") ?? [];

  return (
    <div className="flex flex-col h-full min-h-0">
      <h3 className="text-xs font-bold text-slate-600 uppercase tracking-wide mb-2">
        Autisti del giorno
      </h3>

      <div className="flex-1 overflow-y-auto space-y-2 pr-1">
        {/* Giri non assegnati */}
        {unassigned.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-2">
            <p className="text-xs font-semibold text-amber-700 mb-1">⚠ Giri senza autista ({unassigned.length})</p>
            {unassigned.map((tg) => {
              const svcs = tripServices.get(tg.id) ?? [];
              return (
                <div key={tg.id} className="text-[11px] text-amber-800">
                  {svcs.length} servizi · {svcs.reduce((n, s) => n + s.pax, 0)} PAX · {tg.vehicle_label ?? "—"}
                </div>
              );
            })}
          </div>
        )}

        {/* Per ogni autista */}
        {driverList.map((driver) => {
          const trips = byDriver.get(driver.user_id) ?? [];
          const totalPax = trips.flatMap((t) => tripServices.get(t.id) ?? []).reduce((n, s) => n + s.pax, 0);
          const vehicles_used = [...new Set(trips.map((t) => t.vehicle_label).filter(Boolean))];
          const isOpen = expandedId === driver.user_id;

          return (
            <div key={driver.user_id} className={`rounded-lg border overflow-hidden ${trips.length > 0 ? "border-slate-200 bg-white" : "border-slate-100 bg-slate-50"}`}>
              {/* Header autista */}
              <button
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-slate-50 transition-colors text-left"
                onClick={() => setExpandedId(isOpen ? null : driver.user_id)}
              >
                <span className={`transition-transform text-xs text-slate-400 ${isOpen ? "rotate-90" : ""}`}>▶</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-slate-800">{driver.full_name}</p>
                  <div className="mt-0.5">
                    <DriverTimeline trips={trips} tripServices={tripServices} />
                  </div>
                </div>
                <div className="flex flex-col items-end shrink-0">
                  <span className="text-[10px] font-semibold text-slate-600">{trips.length} giri</span>
                  <span className="text-[10px] text-slate-500">{totalPax} PAX</span>
                </div>
              </button>

              {/* Dettaglio giri */}
              {isOpen && (
                <div className="border-t border-slate-100 divide-y divide-slate-100">
                  {trips.length === 0 && (
                    <p className="text-xs text-slate-400 px-3 py-2">Nessun giro assegnato</p>
                  )}
                  {trips.map((tg) => {
                    const svcs = tripServices.get(tg.id) ?? [];
                    const pax = svcs.reduce((n, s) => n + s.pax, 0);
                    const st = tripServiceStatus(svcs);
                    const isEditing = editingGroup === tg.id;

                    return (
                      <div key={tg.id} className="px-3 py-2">
                        {/* Header giro */}
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${
                            st === "done" ? "bg-emerald-500" : st === "ongoing" ? "bg-amber-400" : "bg-slate-300"
                          }`} />
                          <span className="text-[11px] font-semibold text-slate-700 flex-1">
                            {tg.vehicle_label ?? "—"} · {pax} PAX · {fmt(svcs[0]?.time ?? "")}
                          </span>
                          <button
                            className="text-[10px] text-slate-400 hover:text-blue-600 mr-1"
                            onClick={() => { setEditingGroup(isEditing ? null : tg.id); setEditDriver(tg.driver_user_id ?? ""); setEditVehicle(""); }}
                          >
                            ✏
                          </button>
                          <button
                            className="text-[10px] text-slate-400 hover:text-red-500"
                            onClick={() => void deleteTrip(tg.id)}
                            disabled={saving}
                          >
                            ✕
                          </button>
                        </div>

                        {/* Edit inline */}
                        {isEditing && (
                          <div className="bg-slate-50 rounded p-2 mb-1 space-y-1">
                            <select className="input-saas text-xs w-full" value={editDriver} onChange={(e) => setEditDriver(e.target.value)}>
                              <option value="">— Autista —</option>
                              {driverList.map((d) => <option key={d.user_id} value={d.user_id}>{d.full_name}</option>)}
                            </select>
                            <select className="input-saas text-xs w-full" value={editVehicle} onChange={(e) => setEditVehicle(e.target.value)}>
                              <option value="">— Mezzo ({tg.vehicle_label ?? "invariato"}) —</option>
                              {vehicles.map((v) => <option key={v.id} value={v.id}>{v.label}{v.capacity ? ` (${v.capacity}p)` : ""}</option>)}
                            </select>
                            <div className="flex gap-1">
                              <button onClick={() => void saveEdit(tg.id)} disabled={saving} className="btn-primary text-xs px-2 py-1 flex-1">
                                {saving ? "…" : "Salva"}
                              </button>
                              <button onClick={() => setEditingGroup(null)} className="btn-secondary text-xs px-2 py-1">Annulla</button>
                            </div>
                          </div>
                        )}

                        {/* Clienti del giro */}
                        {svcs.map((svc) => (
                          <div key={svc.id} className="flex items-center gap-1 text-[10px] text-slate-600 py-0.5">
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                              svc.status === "completato" ? "bg-emerald-500"
                              : ["partito","arrivato"].includes(svc.status) ? "bg-amber-400"
                              : "bg-slate-300"
                            }`} />
                            <span className="flex-1 truncate">{customerName(svc)}</span>
                            <span className="shrink-0">{svc.pax}px</span>
                          </div>
                        ))}

                        {tg.notes && (
                          <p className="text-[10px] text-slate-400 italic mt-0.5">{tg.notes}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Stampa ───────────────────────────────────────────────────────────────────

function printDriverPlans(drivers: Member[], tripGroups: TripGroup[], tripServices: Map<string, Service[]>, hotels: Map<string, Hotel>, date: string) {
  const pages = drivers
    .filter((d) => d.role === "driver")
    .map((driver) => {
      const trips = tripGroups.filter((t) => t.driver_user_id === driver.user_id);
      if (!trips.length) return "";
      const rows = trips
        .sort((a, b) => {
          const at = tripServices.get(a.id)?.[0]?.time ?? "";
          const bt = tripServices.get(b.id)?.[0]?.time ?? "";
          return at.localeCompare(bt);
        })
        .map((tg) => {
          const svcs = tripServices.get(tg.id) ?? [];
          return svcs.map((svc) => {
            const hotel = hotels.get(svc.hotel_id ?? "");
            return `<tr>
              <td>${fmt(svc.pickup_hotel ?? svc.time)}</td>
              <td>${svc.direction === "arrival" ? svc.vessel ?? "—" : hotel?.zone ?? "—"}</td>
              <td>${customerName(svc)} (${svc.pax}p)</td>
              <td>${hotel?.name ?? "—"}</td>
              <td>${svc.phone ?? "—"}</td>
              <td>${svc.notes ?? ""}</td>
            </tr>`;
          }).join("");
        }).join("");

      return `<div style="page-break-after:always;font-family:Arial,sans-serif;font-size:11pt;padding:20px">
        <h2 style="margin:0 0 4px">${driver.full_name}</h2>
        <p style="margin:0 0 12px;font-size:10pt;color:#555">Data: ${date} · Mezzo: ${trips[0]?.vehicle_label ?? "—"}</p>
        <table style="width:100%;border-collapse:collapse;font-size:10pt">
          <thead>
            <tr style="border-bottom:2px solid #000">
              <th style="text-align:left;padding:3px 6px">Orario</th>
              <th style="text-align:left;padding:3px 6px">Porto/Zona</th>
              <th style="text-align:left;padding:3px 6px">Cliente</th>
              <th style="text-align:left;padding:3px 6px">Hotel</th>
              <th style="text-align:left;padding:3px 6px">Telefono</th>
              <th style="text-align:left;padding:3px 6px">Note</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    }).join("");

  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(`<!DOCTYPE html><html><head><title>Piano del Giorno ${date}</title>
    <style>@media print{body{margin:0}}</style>
  </head><body>${pages}</body></html>`);
  win.document.close();
  win.print();
}

// ─── Pagina principale ────────────────────────────────────────────────────────

export default function PianoGiornoPage() {
  const [date, setDate] = useState(today());
  const { data, loading, error, token, reload } = usePianoGiornoData(date);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Maps per lookup O(1)
  const serviceMap = useMemo(() => new Map((data?.services ?? []).map((s) => [s.id, s])), [data]);
  const hotelMap = useMemo(() => new Map((data?.hotels ?? []).map((h) => [h.id, h])), [data]);
  const assignmentMap = useMemo(() => new Map((data?.assignments ?? []).map((a) => [a.service_id, a])), [data]);
  const driversList = useMemo(() => (data?.memberships ?? []).filter((m) => m.role === "driver"), [data]);

  // Map group_id → servizi
  const tripServices = useMemo(() => {
    const map = new Map<string, Service[]>();
    for (const a of data?.assignments ?? []) {
      if (!a.group_id) continue;
      const svc = serviceMap.get(a.service_id);
      if (!svc) continue;
      map.set(a.group_id, [...(map.get(a.group_id) ?? []), svc]);
    }
    return map;
  }, [data, serviceMap]);

  // KPI globali
  const totalServices = data?.services.length ?? 0;
  const assignedServices = (data?.assignments ?? []).filter((a) => a.group_id).length;
  const conflicts = useMemo(() => {
    const list: string[] = [];
    for (const tg of data?.trip_groups ?? []) {
      const svcs = tripServices.get(tg.id) ?? [];
      const pax = svcs.reduce((n, s) => n + s.pax, 0);
      if (tg.vehicle_capacity && pax > tg.vehicle_capacity) {
        list.push(`Giro ${tg.vehicle_label ?? tg.id.slice(0, 6)}: overbooking ${pax}/${tg.vehicle_capacity}`);
      }
    }
    return list;
  }, [data, tripServices]);

  const toggleService = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const selectGroup = useCallback((ids: string[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allIn = ids.every((id) => next.has(id));
      if (allIn) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }, []);

  return (
    <>
      {/* Stile stampa */}
      <style>{`@media print { .no-print { display: none !important; } }`}</style>

      <section className="page-section no-print">
        <PageHeader
          title="Piano del Giorno"
          subtitle="Organizza giri, autisti e mezzi per il trasferimento giornaliero."
          breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Piano del Giorno" }]}
        />

        {/* Barra superiore */}
        <div className="toolbar flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-600 font-medium">Data</label>
            <input
              type="date"
              className="input-saas text-sm"
              value={date}
              onChange={(e) => { setDate(e.target.value); setSelectedIds(new Set()); }}
            />
          </div>

          {/* Progress */}
          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
            <div className="flex-1 bg-slate-100 rounded-full h-2 overflow-hidden">
              <div
                className="h-2 bg-blue-500 rounded-full transition-all"
                style={{ width: totalServices ? `${(assignedServices / totalServices) * 100}%` : "0%" }}
              />
            </div>
            <span className="text-xs font-mono text-slate-600 whitespace-nowrap">
              {assignedServices}/{totalServices} assegnati
            </span>
          </div>

          {/* Conflitti */}
          {conflicts.length > 0 && (
            <div className="flex items-center gap-1 bg-red-600 text-white text-xs font-semibold px-3 py-1.5 rounded">
              ⚠ {conflicts.length} conflitt{conflicts.length === 1 ? "o" : "i"}: {conflicts[0]}
            </div>
          )}

          <div className="flex gap-2 ml-auto">
            <button
              className="btn-secondary text-xs"
              onClick={() => printDriverPlans(
                data?.memberships ?? [],
                data?.trip_groups ?? [],
                tripServices,
                hotelMap,
                date
              )}
            >
              Stampa piani
            </button>
          </div>
        </div>

        {error && <p className="text-sm text-red-600 p-4">{error}</p>}

        {loading && !data && (
          <p className="text-sm text-slate-500 p-4">Caricamento piano del giorno…</p>
        )}

        {data && (
          <div className="grid grid-cols-[minmax(300px,1fr)_280px_minmax(280px,1fr)] gap-3 h-[calc(100vh-220px)] min-h-[500px]">

            {/* ── POOL (sinistra) ── */}
            <div className="card p-3 flex flex-col min-h-0 overflow-hidden">
              <h2 className="text-xs font-bold text-slate-700 uppercase tracking-wide mb-2">
                Pool servizi
              </h2>
              <PoolPanel
                services={data.services}
                hotels={hotelMap}
                assignments={assignmentMap}
                ferrySchedules={data.ferry_schedules}
                selectedIds={selectedIds}
                onToggle={toggleService}
                onSelectGroup={selectGroup}
              />
            </div>

            {/* ── BUILDER (centro) ── */}
            <div className="card p-3 flex flex-col min-h-0 overflow-hidden">
              <TripBuilder
                selectedIds={selectedIds}
                services={serviceMap}
                hotels={hotelMap}
                drivers={data.memberships}
                vehicles={data.vehicles}
                tripGroups={data.trip_groups}
                assignments={assignmentMap}
                token={token!}
                date={date}
                onRemove={(id) => toggleService(id)}
                onClear={() => setSelectedIds(new Set())}
                onDone={reload}
              />
            </div>

            {/* ── AUTISTI (destra) ── */}
            <div className="card p-3 flex flex-col min-h-0 overflow-hidden">
              <DriverPanel
                drivers={data.memberships}
                tripGroups={data.trip_groups}
                tripServices={tripServices}
                token={token!}
                vehicles={data.vehicles}
                onUpdated={reload}
              />
            </div>
          </div>
        )}
      </section>
    </>
  );
}
