"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase, hasSupabaseEnv } from "@/lib/supabase/client";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { DateInput, PageHeader } from "@/components/ui";

// ─── Tipi ─────────────────────────────────────────────────────────────────────

type Service = {
  id: string; date: string; time: string; direction: "arrival" | "departure";
  time_from: string | null; time_to: string | null;
  customer_name: string; customer_first_name?: string | null; customer_last_name?: string | null;
  pax: number; hotel_id: string | null; vessel: string | null; notes: string | null;
  status: string; meeting_point: string | null; place_type: string | null;
  pickup_hotel: string | null; phone: string | null;
  booking_service_kind: string | null; service_type: string | null;
};
type TripGroup = {
  id: string; date: string; driver_user_id: string | null; driver_profile_id: string | null;
  vehicle_label: string | null; vehicle_capacity: number | null; notes: string | null; status: string;
};
type Assignment = {
  id: string; service_id: string; driver_user_id: string | null;
  vehicle_label: string | null; group_id: string | null;
};
type Hotel = { id: string; name: string; zone: string | null; lat: number | null; lng: number | null };
type Member = { user_id: string; full_name: string; role: string };
type DriverProfile = {
  id: string; user_id: string | null; full_name: string; phone: string | null;
  active: boolean; has_access: boolean; access_suspended: boolean;
};
// Rappresentazione unificata usata nei dropdown autisti
type DriverEntry = { profileId: string; userId: string | null; name: string };
type Vehicle = { id: string; label: string; capacity: number | null; vehicle_size: string | null };
type FerrySchedule = { id: string; company: string; departure_port: string; arrival_port: string; departure_time: string; notes: string | null };

type DayData = {
  services: Service[]; trip_groups: TripGroup[]; assignments: Assignment[];
  hotels: Hotel[]; memberships: Member[]; driver_profiles: DriverProfile[];
  vehicles: Vehicle[]; ferry_schedules: FerrySchedule[];
};
type PlanIssue = {
  id: string;
  severity: "blocker" | "warning" | "info";
  title: string;
  detail: string;
};
type TripOverview = {
  group: TripGroup;
  services: Service[];
  time: string;
  direction: "arrival" | "departure" | "mixed";
  pax: number;
  status: "todo" | "ongoing" | "done";
  driverName: string;
  routeLabel: string;
  hotelLabel: string;
  issueCount: number;
};
type PlanWindow = {
  id: string;
  direction: "arrival" | "departure";
  label: string;
  startMin: number;
  endMin: number;
  trips: number;
  services: number;
  pax: number;
  issues: number;
  missingDrivers: number;
};
type UnassignedWindow = {
  id: string;
  direction: "arrival" | "departure";
  label: string;
  startMin: number;
  endMin: number;
  services: Service[];
  pax: number;
  missingHotels: number;
  groups: string[];
};
type ArrivalMergeSuggestion = {
  id: string;
  port: string;
  firstTime: string;
  lastTime: string;
  services: number;
  pax: number;
  vessels: string[];
};
type AiPlanResult = {
  summary: string;
  confidence: "alta" | "media" | "bassa";
  priority_actions: Array<{
    priority: "alta" | "media" | "bassa";
    title: string;
    reason: string;
    operator_action: string;
  }>;
  suggested_batches: Array<{
    direction: "arrival" | "departure";
    time_window: string;
    port: string | null;
    zone: string | null;
    services: number;
    pax: number;
    recommendation: string;
    risk: string | null;
  }>;
  warnings: string[];
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(time: string) { return time?.slice(0, 5) ?? "—"; }
function fmtNullable(time: string | null | undefined) { return time ? fmt(time) : null; }
function isPrivateIslandService(service: Service) {
  return service.booking_service_kind === "private_island" || service.service_type === "private_island";
}
function serviceSortTime(service: Service) {
  return isPrivateIslandService(service) ? service.time_from ?? service.time : service.pickup_hotel ?? service.time;
}
function serviceDisplayTime(service: Service) {
  if (isPrivateIslandService(service)) {
    const from = fmtNullable(service.time_from);
    const to = fmtNullable(service.time_to);
    if (from && to) return `${from}-${to}`;
    return from ?? to ?? fmt(service.time);
  }
  return fmt(service.direction === "departure" ? service.pickup_hotel ?? service.time : service.time);
}
function today() { return new Date().toISOString().slice(0, 10); }
const STRESS_TEST_DATE = "2025-10-12";
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
function directionLabel(direction: TripOverview["direction"]) {
  if (direction === "arrival") return "Arrivo";
  if (direction === "departure") return "Partenza";
  return "Misto";
}
function statusLabel(status: TripOverview["status"]) {
  if (status === "done") return "Completato";
  if (status === "ongoing") return "In corso";
  return "Da fare";
}
function planFilterLabel(filter: "all" | "issues" | "missing_driver" | "departures" | "arrivals") {
  if (filter === "issues") return "Da verificare";
  if (filter === "missing_driver") return "Senza autista";
  if (filter === "departures") return "Partenze";
  if (filter === "arrivals") return "Arrivi";
  return "Tutti";
}
function minutesFromTime(time: string) {
  const [h, m] = fmt(time).split(":").map((part) => Number.parseInt(part, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}
function addIsoDays(iso: string, days: number) {
  const date = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return today();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function timeDiffMinutes(a: string, b: string) {
  const left = minutesFromTime(a);
  const right = minutesFromTime(b);
  if (left == null || right == null) return Infinity;
  return Math.abs(right - left);
}
function readableDate(iso: string) {
  const date = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return "Data non valida";
  return new Intl.DateTimeFormat("it-IT", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(date);
}
function timeFromMinutes(total: number) {
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
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

  // Realtime — richiede migration 0158_realtime_publications.sql
  useEffect(() => {
    const client = supabase;
    if (!client || !tenantId || !token) return;
    const scheduleRefresh = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => { void load(token); }, 500);
    };
    const channel = client
      .channel(`piano-giorno-${tenantId}-${date}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "services", filter: `tenant_id=eq.${tenantId}` }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "assignments", filter: `tenant_id=eq.${tenantId}` }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "trip_groups", filter: `tenant_id=eq.${tenantId}` }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "status_events", filter: `tenant_id=eq.${tenantId}` }, scheduleRefresh)
      .subscribe();
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      void client.removeChannel(channel);
    };
  }, [tenantId, token, date, load]);

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
      const firstService = svcs[0];
      const time = firstService ? serviceSortTime(firstService) : "";
      const st = tripServiceStatus(svcs);
      all.push({ time, label: firstService ? serviceDisplayTime(firstService) : fmt(time), status: st });
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
      const pickupTime = serviceDisplayTime(s);
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
            groupSub = `ore ${svcs[0] ? serviceDisplayTime(svcs[0]) : "—"}`;
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
                <div
                  role="button"
                  tabIndex={0}
                  className={`ml-1 text-[10px] px-1.5 py-0.5 rounded border transition-colors cursor-pointer ${
                    allSelected ? "bg-blue-600 border-blue-600 text-white" : "border-slate-300 text-slate-500 hover:border-blue-400"
                  }`}
                  onClick={(e) => { e.stopPropagation(); onSelectGroup(svcs.map((s) => s.id)); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); onSelectGroup(svcs.map((s) => s.id)); } }}
                  title={allSelected ? "Deseleziona tutto" : "Seleziona tutto il gruppo"}
                >
                  {allSelected ? "✓ tutto" : "+ tutto"}
                </div>
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
  drivers: DriverEntry[];
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
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selectedList = useMemo(() => [...selectedIds].map((id) => services.get(id)).filter(Boolean) as Service[], [selectedIds, services]);
  const totalPax = selectedList.reduce((n, s) => n + s.pax, 0);
  const selectedVehicle = vehicles.find((v) => v.id === vehicleId);
  const overbooking = selectedVehicle?.capacity ? totalPax - selectedVehicle.capacity : 0;

  // Occupazione autista: giri già assegnati nel giorno (keyed by profileId o userId)
  const driverBusy = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const tg of tripGroups) {
      const key = tg.driver_profile_id ?? tg.driver_user_id;
      if (!key) continue;
      map.set(key, [...(map.get(key) ?? []), tg.id]);
    }
    return map;
  }, [tripGroups]);

  const driverConflict = useCallback((profileId: string): "busy" | "close" | "ok" => {
    const groupIds = driverBusy.get(profileId) ?? [];
    return groupIds.length > 0 ? "close" : "ok";
  }, [driverBusy]);

  const confirm = async () => {
    if (!selectedIds.size || !selectedProfileId) return;
    setSaving(true); setErr(null);
    const vehicle = vehicles.find((v) => v.id === vehicleId);
    const selectedDriver = drivers.find((d) => d.profileId === selectedProfileId);
    const res = await tripAction(token, {
      action: "create_trip",
      date,
      service_ids: [...selectedIds],
      driver_user_id: selectedDriver?.userId ?? null,
      driver_profile_id: selectedProfileId || null,
      vehicle_id: vehicle?.id ?? vehicleId ?? null,
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
              <p className="text-[10px] text-slate-500">{hotels.get(svc.hotel_id ?? "")?.name ?? "—"} · {serviceDisplayTime(svc)}</p>
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
          value={selectedProfileId}
          onChange={(e) => setSelectedProfileId(e.target.value)}
        >
          <option value="">— Seleziona autista —</option>
          {drivers.map((d) => {
            const conflict = driverConflict(d.profileId);
            return (
              <option key={d.profileId} value={d.profileId}>
                {d.name}
                {conflict === "close" ? " ⚠" : ""}
                {` (${driverBusy.get(d.profileId)?.length ?? 0} giri)`}
              </option>
            );
          })}
        </select>
        {selectedProfileId && driverConflict(selectedProfileId) === "close" && (
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
        disabled={saving || !selectedProfileId}
        className="btn-primary w-full text-sm disabled:opacity-50"
      >
        {saving ? "Salvataggio…" : "Conferma giro"}
      </button>
    </div>
  );
}

// ─── Pannello AUTISTI (destra) ────────────────────────────────────────────────

type DriverPanelProps = {
  drivers: DriverEntry[];
  tripGroups: TripGroup[];
  tripServices: Map<string, Service[]>;
  token: string;
  vehicles: Vehicle[];
  onUpdated: () => void;
};

function DriverPanel({ drivers, tripGroups, tripServices, token, vehicles, onUpdated }: DriverPanelProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [editProfileId, setEditProfileId] = useState("");
  const [editVehicle, setEditVehicle] = useState("");
  const [saving, setSaving] = useState(false);

  const byDriver = useMemo(() => {
    const map = new Map<string, TripGroup[]>();
    for (const tg of tripGroups) {
      const key = tg.driver_profile_id ?? tg.driver_user_id ?? "__unassigned__";
      map.set(key, [...(map.get(key) ?? []), tg]);
    }
    return map;
  }, [tripGroups]);

  const driverList = useMemo(() => {
    return [...drivers].sort((a, b) => {
      const aTrips = byDriver.get(a.profileId)?.length ?? 0;
      const bTrips = byDriver.get(b.profileId)?.length ?? 0;
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
    const selectedDriver = drivers.find((d) => d.profileId === editProfileId);
    await tripAction(token, {
      action: "update_trip",
      group_id: groupId,
      driver_user_id: selectedDriver?.userId ?? null,
      driver_profile_id: editProfileId || null,
      vehicle_id: vehicle?.id ?? editVehicle ?? null,
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
          const trips = byDriver.get(driver.profileId) ?? [];
          const totalPax = trips.flatMap((t) => tripServices.get(t.id) ?? []).reduce((n, s) => n + s.pax, 0);
          const isOpen = expandedId === driver.profileId;

          return (
            <div key={driver.profileId} className={`rounded-lg border overflow-hidden ${trips.length > 0 ? "border-slate-200 bg-white" : "border-slate-100 bg-slate-50"}`}>
              {/* Header autista */}
              <button
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-slate-50 transition-colors text-left"
                onClick={() => setExpandedId(isOpen ? null : driver.profileId)}
              >
                <span className={`transition-transform text-xs text-slate-400 ${isOpen ? "rotate-90" : ""}`}>▶</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-slate-800">{driver.name}</p>
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
                            {tg.vehicle_label ?? "—"} · {pax} PAX · {svcs[0] ? serviceDisplayTime(svcs[0]) : "—"}
                          </span>
                          <button
                            className="text-[10px] text-slate-400 hover:text-blue-600 mr-1"
                            onClick={() => { setEditingGroup(isEditing ? null : tg.id); setEditProfileId(tg.driver_profile_id ?? tg.driver_user_id ?? ""); setEditVehicle(""); }}
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
                            <select className="input-saas text-xs w-full" value={editProfileId} onChange={(e) => setEditProfileId(e.target.value)}>
                              <option value="">— Autista —</option>
                              {driverList.map((d) => <option key={d.profileId} value={d.profileId}>{d.name}</option>)}
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

function addMinutes(time: string, mins: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = (h ?? 0) * 60 + (m ?? 0) + mins;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function normalizeCompany(value: string | null | undefined): string {
  const raw = (value ?? "").toLowerCase();
  if (raw.includes("snav")) return "snav";
  if (raw.includes("medmar")) return "medmar";
  if (raw.includes("alilauro")) return "alilauro";
  if (raw.includes("caremar")) return "caremar";
  return raw;
}

function inferDeparturePort(company: string, vessel: string | null | undefined, meetingPoint: string | null | undefined): string {
  const raw = `${vessel ?? ""} ${meetingPoint ?? ""}`.toLowerCase();
  if (raw.includes("pozzuoli")) return "pozzuoli";
  if (raw.includes("beverello") || raw.includes("napoli")) return "napoli_beverello";
  if (company === "medmar") return "pozzuoli";
  if (company === "snav") return "napoli_beverello";
  return "";
}

function travelMinutes(company: string, departurePort: string): number {
  if (company === "snav") return 65;
  if (company === "medmar" && departurePort === "pozzuoli") return 60;
  return 95; // medmar napoli e default
}

function findFerryScheduleForService(service: Service, ferrySchedules: FerrySchedule[]): FerrySchedule | null {
  const company = normalizeCompany(service.vessel);
  const time = fmt(service.time);
  const inferredPort = inferDeparturePort(company, service.vessel, service.meeting_point);
  const sameTimeAndCompany = ferrySchedules.filter(
    (schedule) => fmt(schedule.departure_time) === time && normalizeCompany(schedule.company) === company
  );
  return (
    sameTimeAndCompany.find((schedule) => schedule.departure_port === inferredPort) ??
    sameTimeAndCompany[0] ??
    null
  );
}

// Coordinate dei porti di arrivo sull'isola
const PORT_COORDS: Record<string, { lat: number; lng: number }> = {
  "casamicciola": { lat: 40.7507, lng: 13.9013 },
  "ischia porto": { lat: 40.7329, lng: 13.9477 },
  "ischia":       { lat: 40.7329, lng: 13.9477 },
  "forio":        { lat: 40.7355, lng: 13.8675 },
  "lacco ameno":  { lat: 40.7580, lng: 13.8887 },
};

function portCoords(arrPorto: string): { lat: number; lng: number } {
  const key = arrPorto.toLowerCase();
  for (const [k, v] of Object.entries(PORT_COORDS)) {
    if (key.includes(k)) return v;
  }
  return PORT_COORDS["ischia porto"]!;
}

function nearestNeighborSort(services: Service[], hotels: Map<string, Hotel>, startLat: number, startLng: number): Service[] {
  // Raggruppa per hotel_id, ordina clienti per cognome dentro ogni hotel
  const byHotel = new Map<string, Service[]>();
  for (const svc of services) {
    const key = svc.hotel_id ?? "__no_hotel__";
    const list = byHotel.get(key) ?? [];
    list.push(svc);
    byHotel.set(key, list);
  }
  for (const list of byHotel.values()) {
    list.sort((a, b) => (a.customer_last_name ?? a.customer_name).localeCompare(b.customer_last_name ?? b.customer_name));
  }

  // Nearest-neighbor sugli hotel unici
  const hotelIds = Array.from(byHotel.keys());
  const remaining = [...hotelIds];
  const sortedHotelIds: string[] = [];
  let curLat = startLat;
  let curLng = startLng;
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const h = hotels.get(remaining[i]!);
      const dLat = (h?.lat ?? curLat) - curLat;
      const dLng = (h?.lng ?? curLng) - curLng;
      const dist = dLat * dLat + dLng * dLng;
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
    const nearestId = remaining.splice(bestIdx, 1)[0]!;
    sortedHotelIds.push(nearestId);
    const h = hotels.get(nearestId);
    if (h?.lat != null && h?.lng != null) { curLat = h.lat; curLng = h.lng; }
  }

  return sortedHotelIds.flatMap((id) => byHotel.get(id) ?? []);
}

function distanceFromPoint(hotel: Hotel | undefined, lat: number, lng: number) {
  const dLat = (hotel?.lat ?? lat) - lat;
  const dLng = (hotel?.lng ?? lng) - lng;
  return dLat * dLat + dLng * dLng;
}

function sortTripRouteServices(services: Service[], hotels: Map<string, Hotel>): Service[] {
  if (!services.length) return [];
  const first = services[0]!;
  const port = portCoords(cleanPortName(first.meeting_point) || "Ischia Porto");

  if (services.every((svc) => svc.direction === "arrival")) {
    return nearestNeighborSort(services, hotels, port.lat, port.lng);
  }

  if (services.every((svc) => svc.direction === "departure")) {
    return [...services].sort((a, b) => {
      const aHotel = hotels.get(a.hotel_id ?? "");
      const bHotel = hotels.get(b.hotel_id ?? "");
      const dist = distanceFromPoint(bHotel, port.lat, port.lng) - distanceFromPoint(aHotel, port.lat, port.lng);
      return dist !== 0 ? dist : serviceSortTime(a).localeCompare(serviceSortTime(b));
    });
  }

  return [...services].sort((a, b) => serviceSortTime(a).localeCompare(serviceSortTime(b)));
}

function companyFromVessel(vessel: string | null | undefined): string {
  if (!vessel) return "—";
  const v = vessel.toLowerCase();
  if (v.startsWith("snav")) return "SNAV";
  if (v.startsWith("medmar")) return "Medmar";
  if (v.startsWith("alilauro")) return "Alilauro";
  if (v.startsWith("caremar")) return "Caremar";
  return vessel.split(" ")[0] ?? vessel;
}

function cleanPortName(mp: string | null | undefined): string {
  if (!mp) return "";
  const l = mp.toLowerCase();
  if (l.includes("casamicciola")) return "Casamicciola";
  if (l.includes("pozzuoli")) return "Pozzuoli";
  if (l.includes("beverello") || l.includes("napoli")) return "Napoli Beverello";
  if (l.includes("ischia porto") || l.includes("uscita arrivi") || l.includes("ischia")) return "Ischia Porto";
  if (l.includes("forio")) return "Forio";
  if (l.includes("lacco")) return "Lacco Ameno";
  return mp;
}

function printDriverPlans(drivers: DriverEntry[], tripGroups: TripGroup[], tripServices: Map<string, Service[]>, hotels: Map<string, Hotel>, date: string, ferrySchedules: FerrySchedule[] = []) {
  const pages = drivers
    .map((driver) => {
      const trips = tripGroups.filter((t) =>
        (t.driver_profile_id && t.driver_profile_id === driver.profileId) ||
        (!t.driver_profile_id && t.driver_user_id && t.driver_user_id === driver.userId)
      );
      if (!trips.length) return "";
      const rows = trips
        .sort((a, b) => {
          const aTime = (tripServices.get(a.id) ?? [])[0]?.time ?? "";
          const bTime = (tripServices.get(b.id) ?? [])[0]?.time ?? "";
          return aTime.localeCompare(bTime);
        })
        .flatMap((tg) => {
          const svcs = tripServices.get(tg.id) ?? [];
          const isArrivalGroup = svcs.length > 0 && svcs.every((s) => s.direction === "arrival");
          if (isArrivalGroup) {
            const arrPorto = cleanPortName(svcs[0]?.meeting_point) || "Ischia Porto";
            const { lat, lng } = portCoords(arrPorto);
            return nearestNeighborSort(svcs, hotels, lat, lng);
          }
          return [...svcs].sort((a, b) => serviceSortTime(a).localeCompare(serviceSortTime(b)));
        })
        .map((svc) => {
          const hotel = hotels.get(svc.hotel_id ?? "");
          const isArr = svc.direction === "arrival";
          const badge = isArr
            ? `<span style="background:#dbeafe;color:#1e3a8a;padding:1px 5px;border-radius:3px;font-size:8.5pt;font-weight:bold">ARR</span>`
            : `<span style="background:#fef3c7;color:#92400e;padding:1px 5px;border-radius:3px;font-size:8.5pt;font-weight:bold">PAR</span>`;
          const g = (lbl: string, val: string | null | undefined) =>
            val ? `<span style="color:#444;font-size:8.5pt"><b>${lbl}:</b> ${val}</span>` : "";

          let portZona: string;
          let arrivoIschia = "";
          if (isArr) {
            const arrPorto = cleanPortName(svc.meeting_point) || "Ischia Porto";
            const schedule = findFerryScheduleForService(svc, ferrySchedules);
            const company = normalizeCompany(schedule?.company ?? svc.vessel);
            const departurePort = schedule?.departure_port ?? inferDeparturePort(company, svc.vessel, svc.meeting_point);
            const partenzaPorto = departurePort ? portLabel(departurePort) : "";
            const travelMins = travelMinutes(company, departurePort);
            arrivoIschia = addMinutes(fmt(svc.time), travelMins);
            portZona = [
              badge,
              `<b>${companyFromVessel(svc.vessel)}</b> <span style="color:#666;font-size:8.5pt">(part. ${fmt(svc.time)}${partenzaPorto ? ` da ${partenzaPorto}` : ""})</span>`,
              g("Arriva a", arrPorto),
              g("Zona consegna", hotel?.zone),
            ].filter(Boolean).join(" &nbsp;·&nbsp; ");
          } else {
            const imbarco = cleanPortName(svc.meeting_point);
            const vesselTime = svc.vessel
              ? `→ <b>${companyFromVessel(svc.vessel)}</b>${svc.pickup_hotel ? ` <span style="color:#666;font-size:8.5pt">ore ${fmt(svc.time)}</span>` : ""}`
              : "";
            portZona = [
              badge,
              g("Pickup zona", hotel?.zone),
              g("Porto imbarco", imbarco),
              vesselTime,
            ].filter(Boolean).join(" &nbsp;·&nbsp; ");
          }

          const orarioCell = isPrivateIslandService(svc)
            ? serviceDisplayTime(svc)
            : isArr
              ? arrivoIschia
              : fmt(svc.pickup_hotel ?? svc.time);

          return `<tr style="border-bottom:1px solid #eee">
              <td style="padding:3px 6px;white-space:nowrap">${orarioCell}</td>
              <td style="padding:3px 6px">${portZona}</td>
              <td style="padding:3px 6px">${customerName(svc)} (${svc.pax}p)</td>
              <td style="padding:3px 6px">${hotel?.name ?? "—"}</td>
              <td style="padding:3px 6px">${svc.phone ?? "—"}</td>
              <td style="padding:3px 6px">${svc.notes ?? ""}</td>
            </tr>`;
        }).join("");

      return `<div style="page-break-after:always;font-family:Arial,sans-serif;font-size:11pt;padding:20px">
        <h2 style="margin:0 0 4px">${driver.name}</h2>
        <p style="margin:0 0 12px;font-size:10pt;color:#555">Data: ${date} · Mezzo: ${[...new Set(trips.map(t => t.vehicle_label).filter(Boolean))].join(" / ") || "—"}</p>
        <table style="width:100%;border-collapse:collapse;font-size:10pt">
          <thead>
            <tr style="border-bottom:2px solid #000">
              <th style="text-align:left;padding:3px 6px">Orario</th>
              <th style="text-align:left;padding:3px 6px">Dettagli</th>
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
  const [autoAssigning, setAutoAssigning] = useState(false);
  const [autoResult, setAutoResult] = useState<{ assigned: number; trips: number; skipped: number; report: string[] } | null>(null);
  const [aiPlanning, setAiPlanning] = useState(false);
  const [aiPlan, setAiPlan] = useState<{ plan: AiPlanResult; usage: { input_tokens?: number; output_tokens?: number } | null } | null>(null);
  const [aiPlanError, setAiPlanError] = useState<string | null>(null);
  const [showAutoModal, setShowAutoModal] = useState(false);
  const [viewMode, setViewMode] = useState<"plan" | "manual">("plan");
  const [planFilter, setPlanFilter] = useState<"all" | "issues" | "missing_driver" | "departures" | "arrivals">("all");
  const [planSearch, setPlanSearch] = useState("");
  const [expandedTripId, setExpandedTripId] = useState<string | null>(null);
  const [activeWindowId, setActiveWindowId] = useState<string | null>(null);

  // ─── Pannello imprevisti ───────────────────────────────────────────────────
  const [showImprevisti, setShowImprevisti] = useState(false);
  const [imprevistiTab, setImprevistiTab] = useState<"driver" | "vehicle" | "vessel">("driver");
  const [impSwapFromDriver, setImpSwapFromDriver] = useState("");
  const [impSwapToDriver, setImpSwapToDriver] = useState("");
  const [impSwapFromVehicle, setImpSwapFromVehicle] = useState("");
  const [impSwapToVehicle, setImpSwapToVehicle] = useState("");
  const [impVessel, setImpVessel] = useState("");
  const [impOriginalTime, setImpOriginalTime] = useState("");
  const [impDelayMinutes, setImpDelayMinutes] = useState("");
  const [impSaving, setImpSaving] = useState(false);
  const [impResult, setImpResult] = useState<{ ok: boolean; text: string } | null>(null);

  const runImprevisto = async (action: "swap_driver" | "swap_vehicle" | "delay_vessel") => {
    if (!token) return;
    setImpSaving(true); setImpResult(null);
    const payload: Record<string, unknown> = { action, date };
    if (action === "swap_driver") {
      payload.from_driver_id = impSwapFromDriver;
      payload.to_driver_id = impSwapToDriver;
    } else if (action === "swap_vehicle") {
      payload.from_vehicle_label = impSwapFromVehicle;
      payload.to_vehicle_label = impSwapToVehicle;
    } else {
      payload.vessel = impVessel;
      payload.original_time = impOriginalTime;
      payload.delay_minutes = Number(impDelayMinutes);
    }
    const res = await fetch("/api/ops/piano-giorno/trips", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const json = await res.json() as { ok?: boolean; error?: string; affected?: number; warnings?: string[]; new_time?: string };
    setImpSaving(false);
    if (!json.ok) { setImpResult({ ok: false, text: json.error ?? "Errore." }); return; }
    const warnings = json.warnings?.length ? ` Attenzione: ${json.warnings.join("; ")}` : "";
    const detail = action === "swap_driver"
      ? `${json.affected ?? 0} giri riassegnati.`
      : action === "swap_vehicle"
      ? `${json.affected ?? 0} giri aggiornati.${warnings}`
      : `${json.affected ?? 0} giri segnalati. Nuovo orario stimato: ${json.new_time ?? "—"}.`;
    setImpResult({ ok: true, text: detail });
    void reload();
  };

  const hasGroups = (data?.trip_groups.length ?? 0) > 0;

  // Check disponibilità confermata per la data
  const [availConfirmed, setAvailConfirmed] = useState<boolean | null>(null);
  useEffect(() => {
    if (!token) return;
    fetch(`/api/ops/disponibilita?date=${date}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((b: { ok: boolean; confirmed?: boolean }) => { if (b.ok) setAvailConfirmed(b.confirmed ?? false); })
      .catch(() => setAvailConfirmed(null));
  }, [token, date]);

  const availabilityLocked = availConfirmed === false;

  const runAutoAssign = useCallback(async (mode: "unassigned_only" | "regenerate_all") => {
    if (!token || availabilityLocked) return;
    setShowAutoModal(false);
    setAutoAssigning(true);
    setAutoResult(null);
    try {
      const res = await fetch("/api/ops/piano-giorno/auto-assign", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ date, mode }),
      });
      const json = await res.json() as { ok: boolean; assigned?: number; trips?: number; skipped?: number; report?: string[]; error?: string };
      if (json.ok) {
        setAutoResult({ assigned: json.assigned ?? 0, trips: json.trips ?? 0, skipped: json.skipped ?? 0, report: json.report ?? [] });
        reload();
      } else {
        setAutoResult({ assigned: 0, trips: 0, skipped: 0, report: [json.error ?? "Errore sconosciuto."] });
      }
    } catch {
      setAutoResult({ assigned: 0, trips: 0, skipped: 0, report: ["Errore di rete."] });
    } finally {
      setAutoAssigning(false);
    }
  }, [availabilityLocked, token, date, reload]);

  const runAiPlan = useCallback(async () => {
    if (!token) return;
    setAiPlanning(true);
    setAiPlan(null);
    setAiPlanError(null);
    try {
      const res = await fetch("/api/ops/piano-giorno/ai-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ date }),
      });
      const json = await res.json() as {
        ok: boolean;
        plan?: AiPlanResult;
        usage?: { input_tokens?: number; output_tokens?: number } | null;
        error?: string;
      };
      if (json.ok && json.plan) {
        setAiPlan({ plan: json.plan, usage: json.usage ?? null });
      } else {
        setAiPlanError(json.error ?? "Analisi AI non riuscita.");
      }
    } catch {
      setAiPlanError("Errore di rete durante l'analisi AI.");
    } finally {
      setAiPlanning(false);
    }
  }, [token, date]);

  const handleAutoAssign = useCallback(() => {
    if (availabilityLocked) return;
    if (hasGroups) setShowAutoModal(true);
    else void runAutoAssign("unassigned_only");
  }, [availabilityLocked, hasGroups, runAutoAssign]);

  // Maps per lookup O(1)
  const serviceMap = useMemo(() => new Map((data?.services ?? []).map((s) => [s.id, s])), [data]);
  const hotelMap = useMemo(() => new Map((data?.hotels ?? []).map((h) => [h.id, h])), [data]);
  const assignmentMap = useMemo(() => new Map((data?.assignments ?? []).map((a) => [a.service_id, a])), [data]);
  const driversList = useMemo(() => (data?.memberships ?? []).filter((m) => m.role === "driver" || m.role === "autista"), [data]);

  // Lista unificata: profili attivi non sospesi (include driver senza account)
  const driverEntries = useMemo<DriverEntry[]>(() => {
    const profiles = (data?.driver_profiles ?? []).filter((p) => !p.access_suspended);
    if (profiles.length > 0) {
      return profiles.map((p) => ({ profileId: p.id, userId: p.user_id ?? null, name: p.full_name }));
    }
    // Fallback: usa memberships se driver_profiles non presenti
    return driversList.map((m) => ({ profileId: m.user_id, userId: m.user_id, name: m.full_name }));
  }, [data, driversList]);

  const driverNameById = useMemo(
    () => new Map((data?.memberships ?? []).map((m) => [m.user_id, m.full_name])),
    [data]
  );

  // Lookup nome da profile_id o user_id
  const driverNameByProfileId = useMemo(
    () => new Map((data?.driver_profiles ?? []).map((p) => [p.id, p.full_name])),
    [data]
  );

  const resolveDriverName = useCallback((tg: TripGroup): string => {
    if (tg.driver_profile_id) return driverNameByProfileId.get(tg.driver_profile_id) ?? driverNameById.get(tg.driver_user_id ?? "") ?? "Autista non trovato";
    if (tg.driver_user_id) return driverNameById.get(tg.driver_user_id) ?? "Autista non trovato";
    return "Da assegnare";
  }, [driverNameByProfileId, driverNameById]);

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
  const assignedServices = (data?.services ?? []).filter(
    (s) => s.status === "assigned" || s.status === "partito" || s.status === "arrivato" || s.status === "completato"
  ).length;
  const unassignedServices = useMemo(
    () => (data?.services ?? []).filter((s) => !assignmentMap.has(s.id)),
    [data, assignmentMap]
  );
  const unassignedWindows = useMemo<UnassignedWindow[]>(() => {
    const map = new Map<string, UnassignedWindow>();
    for (const svc of unassignedServices) {
      const displayTime = serviceSortTime(svc);
      const minutes = minutesFromTime(displayTime);
      const startMin = minutes == null ? 0 : Math.floor(minutes / 60) * 60;
      const endMin = startMin + 60;
      const id = `${svc.direction}-${startMin}`;
      const hotel = hotelMap.get(svc.hotel_id ?? "");
      const groupLabel = svc.direction === "arrival"
        ? ((svc.vessel ?? cleanPortName(svc.meeting_point)) || "Arrivo da verificare")
        : ((hotel?.zone ?? cleanPortName(svc.meeting_point)) || "Partenza da verificare");
      const current = map.get(id) ?? {
        id,
        direction: svc.direction,
        label: `${timeFromMinutes(startMin)}-${timeFromMinutes(endMin)}`,
        startMin,
        endMin,
        services: [],
        pax: 0,
        missingHotels: 0,
        groups: [],
      };
      current.services.push(svc);
      current.pax += svc.pax;
      current.missingHotels += !svc.hotel_id || !hotel ? 1 : 0;
      if (!current.groups.includes(groupLabel)) current.groups.push(groupLabel);
      map.set(id, current);
    }
    return Array.from(map.values()).sort((a, b) =>
      a.direction === b.direction ? a.startMin - b.startMin : a.direction.localeCompare(b.direction)
    );
  }, [unassignedServices, hotelMap]);
  const arrivalMergeSuggestions = useMemo<ArrivalMergeSuggestion[]>(() => {
    const arrivals = unassignedServices
      .filter((svc) => svc.direction === "arrival")
      .sort((a, b) => a.time.localeCompare(b.time));
    const byPort = new Map<string, Service[]>();
    for (const svc of arrivals) {
      const port = cleanPortName(svc.meeting_point) || "Ischia Porto";
      byPort.set(port, [...(byPort.get(port) ?? []), svc]);
    }

    const suggestions: ArrivalMergeSuggestion[] = [];
    for (const [port, services] of byPort.entries()) {
      let current: Service[] = [];
      for (const svc of services) {
        const previous = current[current.length - 1];
        if (!previous || timeDiffMinutes(previous.time, svc.time) <= 25) {
          current.push(svc);
        } else {
          if (new Set(current.map((item) => item.time)).size > 1) {
            suggestions.push({
              id: `${port}-${current[0]?.time}`,
              port,
              firstTime: fmt(current[0]?.time ?? ""),
              lastTime: fmt(current[current.length - 1]?.time ?? ""),
              services: current.length,
              pax: current.reduce((n, item) => n + item.pax, 0),
              vessels: Array.from(new Set(current.map((item) => item.vessel ?? "Nave non indicata"))),
            });
          }
          current = [svc];
        }
      }
      if (new Set(current.map((item) => item.time)).size > 1) {
        suggestions.push({
          id: `${port}-${current[0]?.time}`,
          port,
          firstTime: fmt(current[0]?.time ?? ""),
          lastTime: fmt(current[current.length - 1]?.time ?? ""),
          services: current.length,
          pax: current.reduce((n, item) => n + item.pax, 0),
          vessels: Array.from(new Set(current.map((item) => item.vessel ?? "Nave non indicata"))),
        });
      }
    }

    return suggestions.sort((a, b) => a.firstTime.localeCompare(b.firstTime));
  }, [unassignedServices]);
  const tripRows = useMemo<TripOverview[]>(() => {
    return (data?.trip_groups ?? [])
      .map((group) => {
        const services = sortTripRouteServices(tripServices.get(group.id) ?? [], hotelMap);
        const time = services[0] ? serviceDisplayTime(services[0]) : "—";
        const directions = new Set(services.map((s) => s.direction));
        const direction: TripOverview["direction"] =
          directions.size > 1 ? "mixed" : services[0]?.direction ?? "mixed";
        const pax = services.reduce((n, s) => n + s.pax, 0);
        const zones = new Set(
          services
            .map((s) => hotelMap.get(s.hotel_id ?? "")?.zone)
            .filter(Boolean) as string[]
        );
        const hotels = new Set(
          services
            .map((s) => hotelMap.get(s.hotel_id ?? "")?.name)
            .filter(Boolean) as string[]
        );
        const missingHotel = services.filter((s) => !s.hotel_id || !hotelMap.get(s.hotel_id)).length;
        const issueCount =
          (group.driver_user_id || group.driver_profile_id ? 0 : 1) +
          (group.vehicle_label ? 0 : 1) +
          (group.vehicle_capacity && pax > group.vehicle_capacity ? 1 : 0) +
          missingHotel;

        return {
          group,
          services,
          time,
          direction,
          pax,
          status: tripServiceStatus(services),
          driverName: resolveDriverName(group),
          routeLabel: direction === "arrival"
            ? cleanPortName(services[0]?.meeting_point) || "Porto da verificare"
            : cleanPortName(services[0]?.meeting_point) || "Imbarco da verificare",
          hotelLabel: zones.size > 0
            ? Array.from(zones).slice(0, 2).join(" / ")
            : hotels.size > 0
              ? Array.from(hotels).slice(0, 2).join(" / ")
              : "Hotel o zona mancanti",
          issueCount,
        };
      })
      .sort((a, b) => a.time.localeCompare(b.time));
  }, [data, tripServices, hotelMap, driverNameById]);
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
  const planIssues = useMemo<PlanIssue[]>(() => {
    const issues: PlanIssue[] = [];

    if (unassignedServices.length > 0) {
      issues.push({
        id: "unassigned-services",
        severity: "blocker",
        title: `${unassignedServices.length} servizi fuori piano`,
        detail: "Apri la modalità manuale o genera una proposta per inserirli nei giri.",
      });
    }

    for (const trip of tripRows) {
      const label = `${trip.time} ${directionLabel(trip.direction).toLowerCase()}`;
      if (!trip.services.length) {
        issues.push({
          id: `${trip.group.id}-empty`,
          severity: "warning",
          title: `Giro ${label} senza servizi`,
          detail: "Eliminalo o sposta dentro i servizi corretti.",
        });
      }
      if (!trip.group.driver_user_id && !trip.group.driver_profile_id) {
        issues.push({
          id: `${trip.group.id}-driver`,
          severity: "blocker",
          title: `Giro ${label} senza autista`,
          detail: `${trip.pax} pax · ${trip.hotelLabel}`,
        });
      }
      if (!trip.group.vehicle_label) {
        issues.push({
          id: `${trip.group.id}-vehicle`,
          severity: "warning",
          title: `Giro ${label} senza mezzo`,
          detail: `${trip.driverName} · ${trip.pax} pax`,
        });
      }
      if (trip.group.vehicle_capacity && trip.pax > trip.group.vehicle_capacity) {
        issues.push({
          id: `${trip.group.id}-capacity`,
          severity: "blocker",
          title: `Overbooking ${trip.pax}/${trip.group.vehicle_capacity}`,
          detail: `${trip.time} · ${trip.group.vehicle_label ?? "Mezzo non assegnato"} · ${trip.hotelLabel}`,
        });
      }
      const missingHotelCount = trip.services.filter((s) => !s.hotel_id || !hotelMap.get(s.hotel_id)).length;
      if (missingHotelCount > 0) {
        issues.push({
          id: `${trip.group.id}-missing-hotel`,
          severity: "warning",
          title: `${missingHotelCount} clienti senza hotel`,
          detail: `${trip.time} · il percorso non puo essere ordinato bene.`,
        });
      }
    }

    const byDriver = new Map<string, TripOverview[]>();
    for (const trip of tripRows) {
      const key = trip.group.driver_profile_id ?? trip.group.driver_user_id;
      if (!key) continue;
      byDriver.set(key, [...(byDriver.get(key) ?? []), trip]);
    }
    for (const [driverId, trips] of byDriver.entries()) {
      const ordered = [...trips].sort((a, b) => a.time.localeCompare(b.time));
      for (let i = 1; i < ordered.length; i++) {
        const prev = ordered[i - 1]!;
        const current = ordered[i]!;
        const prevMin = minutesFromTime(prev.time);
        const currentMin = minutesFromTime(current.time);
        if (prevMin == null || currentMin == null) continue;
        if (Math.abs(currentMin - prevMin) < 75) {
          issues.push({
            id: `${driverId}-${prev.group.id}-${current.group.id}`,
            severity: "warning",
            title: `Possibile sovrapposizione autista`,
            detail: `${driverNameByProfileId.get(driverId) ?? driverNameById.get(driverId) ?? "Autista"} · ${prev.time} e ${current.time}`,
          });
        }
      }
    }

    return issues.sort((a, b) => {
      const score = { blocker: 0, warning: 1, info: 2 };
      return score[a.severity] - score[b.severity];
    });
  }, [tripRows, unassignedServices, hotelMap, driverNameById]);
  const blockerCount = planIssues.filter((issue) => issue.severity === "blocker").length;
  const planWindows = useMemo<PlanWindow[]>(() => {
    const map = new Map<string, PlanWindow>();
    for (const trip of tripRows) {
      if (trip.direction === "mixed") continue;
      const minutes = minutesFromTime(trip.time);
      if (minutes == null) continue;
      const startMin = Math.floor(minutes / 60) * 60;
      const endMin = startMin + 60;
      const id = `${trip.direction}-${startMin}`;
      const current = map.get(id) ?? {
        id,
        direction: trip.direction,
        label: `${timeFromMinutes(startMin)}-${timeFromMinutes(endMin)}`,
        startMin,
        endMin,
        trips: 0,
        services: 0,
        pax: 0,
        issues: 0,
        missingDrivers: 0,
      };
      current.trips += 1;
      current.services += trip.services.length;
      current.pax += trip.pax;
      current.issues += trip.issueCount;
      current.missingDrivers += trip.group.driver_user_id ? 0 : 1;
      map.set(id, current);
    }
    return Array.from(map.values()).sort((a, b) =>
      a.direction === b.direction ? a.startMin - b.startMin : a.direction.localeCompare(b.direction)
    );
  }, [tripRows]);
  const activeWindow = useMemo(
    () => planWindows.find((window) => window.id === activeWindowId) ?? null,
    [planWindows, activeWindowId]
  );
  const filteredTripRows = useMemo(() => {
    const q = planSearch.trim().toLowerCase();
    return tripRows.filter((trip) => {
      if (planFilter === "issues" && trip.issueCount === 0) return false;
      if (planFilter === "missing_driver" && trip.group.driver_user_id) return false;
      if (planFilter === "departures" && trip.direction !== "departure") return false;
      if (planFilter === "arrivals" && trip.direction !== "arrival") return false;
      if (activeWindow) {
        const minutes = minutesFromTime(trip.time);
        if (trip.direction !== activeWindow.direction || minutes == null || minutes < activeWindow.startMin || minutes >= activeWindow.endMin) {
          return false;
        }
      }
      if (!q) return true;
      return [
        trip.time,
        trip.driverName,
        trip.group.vehicle_label ?? "",
        trip.routeLabel,
        trip.hotelLabel,
        ...trip.services.flatMap((svc) => [
          customerName(svc),
          svc.phone ?? "",
          hotelMap.get(svc.hotel_id ?? "")?.name ?? "",
          hotelMap.get(svc.hotel_id ?? "")?.zone ?? "",
        ]),
      ].some((value) => value.toLowerCase().includes(q));
    });
  }, [tripRows, planFilter, activeWindow, planSearch, hotelMap]);

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
  const changeDate = useCallback((nextDate: string) => {
    setDate(nextDate);
    setSelectedIds(new Set());
    setExpandedTripId(null);
    setActiveWindowId(null);
    setAutoResult(null);
    setAiPlan(null);
    setAiPlanError(null);
  }, []);

  return (
    <>
      {/* Stile stampa */}
      <style>{`@media print { .no-print { display: none !important; } }`}</style>

      {/* Modal imprevisti */}
      {showImprevisti && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center no-print p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
            <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-slate-100">
              <h3 className="font-bold text-slate-800">⚠️ Gestione imprevisti</h3>
              <button onClick={() => { setShowImprevisti(false); setImpResult(null); }} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
            </div>
            <div className="flex border-b border-slate-100">
              {(["driver", "vehicle", "vessel"] as const).map((tab) => (
                <button key={tab} onClick={() => { setImprevistiTab(tab); setImpResult(null); }}
                  className={`flex-1 py-2.5 text-xs font-semibold transition-colors ${imprevistiTab === tab ? "border-b-2 border-blue-500 text-blue-600" : "text-slate-500 hover:text-slate-700"}`}>
                  {tab === "driver" ? "👤 Autista" : tab === "vehicle" ? "🚐 Mezzo" : "🚢 Ritardo corsa"}
                </button>
              ))}
            </div>
            <div className="p-5 space-y-3">
              {imprevistiTab === "driver" && (
                <>
                  <p className="text-xs text-slate-500">Tutti i giri dell&apos;autista selezionato verranno riassegnati al sostituto.</p>
                  <div>
                    <label className="text-xs font-semibold text-slate-600 block mb-1">Autista da sostituire</label>
                    <select value={impSwapFromDriver} onChange={e => setImpSwapFromDriver(e.target.value)} className="input-saas w-full text-sm" data-no-uppercase>
                      <option value="">— Seleziona —</option>
                      {(data?.memberships ?? []).filter(m => m.role === "driver" || m.role === "autista").map(m => (
                        <option key={m.user_id} value={m.user_id}>{m.full_name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-600 block mb-1">Sostituto</label>
                    <select value={impSwapToDriver} onChange={e => setImpSwapToDriver(e.target.value)} className="input-saas w-full text-sm" data-no-uppercase>
                      <option value="">— Seleziona —</option>
                      {(data?.memberships ?? []).filter(m => (m.role === "driver" || m.role === "autista") && m.user_id !== impSwapFromDriver).map(m => (
                        <option key={m.user_id} value={m.user_id}>{m.full_name}</option>
                      ))}
                    </select>
                  </div>
                  <button onClick={() => void runImprevisto("swap_driver")} disabled={!impSwapFromDriver || !impSwapToDriver || impSaving}
                    className="btn-primary w-full text-sm disabled:opacity-50">
                    {impSaving ? "Applicazione…" : "Applica sostituzione"}
                  </button>
                </>
              )}
              {imprevistiTab === "vehicle" && (
                <>
                  <p className="text-xs text-slate-500">Tutti i giri con il mezzo selezionato verranno riassegnati al mezzo sostituto.</p>
                  <div>
                    <label className="text-xs font-semibold text-slate-600 block mb-1">Mezzo da sostituire</label>
                    <select value={impSwapFromVehicle} onChange={e => setImpSwapFromVehicle(e.target.value)} className="input-saas w-full text-sm" data-no-uppercase>
                      <option value="">— Seleziona —</option>
                      {[...new Set((data?.trip_groups ?? []).map(g => g.vehicle_label).filter(Boolean))].map(v => (
                        <option key={v!} value={v!}>{v}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-600 block mb-1">Mezzo sostituto</label>
                    <select value={impSwapToVehicle} onChange={e => setImpSwapToVehicle(e.target.value)} className="input-saas w-full text-sm" data-no-uppercase>
                      <option value="">— Seleziona —</option>
                      {(data?.vehicles ?? []).filter(v => v.label !== impSwapFromVehicle).map(v => (
                        <option key={v.id} value={v.label}>{v.label} ({v.capacity ?? "?"}pax)</option>
                      ))}
                    </select>
                  </div>
                  <button onClick={() => void runImprevisto("swap_vehicle")} disabled={!impSwapFromVehicle || !impSwapToVehicle || impSaving}
                    className="btn-primary w-full text-sm disabled:opacity-50">
                    {impSaving ? "Applicazione…" : "Applica sostituzione"}
                  </button>
                </>
              )}
              {imprevistiTab === "vessel" && (
                <>
                  <p className="text-xs text-slate-500">Segnala il ritardo ai giri collegati e notifica gli autisti.</p>
                  <div>
                    <label className="text-xs font-semibold text-slate-600 block mb-1">Corsa in ritardo</label>
                    <select value={impVessel} onChange={e => { const v = e.target.value; setImpVessel(v); const fs = (data?.ferry_schedules ?? []).find(f => f.company + "|" + f.departure_time === v); if (fs) setImpOriginalTime(fs.departure_time.slice(0,5)); }} className="input-saas w-full text-sm" data-no-uppercase>
                      <option value="">— Seleziona corsa —</option>
                      {(data?.ferry_schedules ?? []).map(fs => (
                        <option key={fs.id} value={fs.company + "|" + fs.departure_time}>{companyLabel(fs.company)} {fs.departure_time.slice(0,5)} ({portLabel(fs.departure_port)}→{portLabel(fs.arrival_port)})</option>
                      ))}
                    </select>
                    <input placeholder="oppure scrivi il nome traghetto" value={impVessel.includes("|") ? "" : impVessel} onChange={e => { setImpVessel(e.target.value); }} className="input-saas w-full text-sm mt-1" />
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className="text-xs font-semibold text-slate-600 block mb-1">Orario previsto</label>
                      <input type="time" value={impOriginalTime} onChange={e => setImpOriginalTime(e.target.value)} className="input-saas w-full text-sm" />
                    </div>
                    <div className="w-28">
                      <label className="text-xs font-semibold text-slate-600 block mb-1">Ritardo (min)</label>
                      <input type="number" min="1" max="300" value={impDelayMinutes} onChange={e => setImpDelayMinutes(e.target.value)} className="input-saas w-full text-sm" data-no-uppercase placeholder="es. 40" />
                    </div>
                  </div>
                  <button onClick={() => void runImprevisto("delay_vessel")} disabled={!impVessel || !impOriginalTime || !impDelayMinutes || impSaving}
                    className="btn-primary w-full text-sm disabled:opacity-50">
                    {impSaving ? "Applicazione…" : "Segnala ritardo"}
                  </button>
                </>
              )}
              {impResult && (
                <div className={`rounded-xl px-3 py-2 text-sm font-medium ${impResult.ok ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
                  {impResult.ok ? "✓ " : "✗ "}{impResult.text}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal conferma secondo click */}
      {showAutoModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center no-print">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
            <h3 className="font-bold text-slate-800 mb-1">Rigenera proposta?</h3>
            <p className="text-sm text-slate-500 mb-5">
              Ci sono già {data?.trip_groups.length} giri pianificati. Come vuoi procedere?
            </p>
            <div className="space-y-2">
              <button
                onClick={() => void runAutoAssign("unassigned_only")}
                className="btn-primary w-full text-sm"
              >
                Assegna solo i servizi non ancora assegnati
              </button>
              <button
                onClick={() => void runAutoAssign("regenerate_all")}
                className="w-full text-sm border border-red-200 text-red-600 rounded px-3 py-2 hover:bg-red-50 transition-colors"
              >
                Rigenera tutto — cancella assegnazioni esistenti
              </button>
              <button
                onClick={() => setShowAutoModal(false)}
                className="w-full text-xs text-slate-400 hover:text-slate-600 mt-1 py-1"
              >
                Annulla
              </button>
            </div>
          </div>
        </div>
      )}

      <section className="page-section no-print">
        {availConfirmed === false ? (
          <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 flex flex-col sm:flex-row items-start sm:items-center gap-3">
            <p className="text-sm font-semibold text-amber-800 flex-1">
              ⚠️ Disponibilità di autisti e mezzi non ancora confermata per questa data.
              Il Piano del Giorno è in sola lettura fino alla conferma.
            </p>
            <a href={`/disponibilita?date=${date}`} className="px-3 py-1.5 rounded-xl bg-amber-500 text-white text-xs font-bold hover:bg-amber-600 whitespace-nowrap">
              Vai a Disponibilità →
            </a>
          </div>
        ) : null}
        <PageHeader
          title="Piano del Giorno"
          subtitle="Controlla la giornata, risolvi le eccezioni e stampa i piani autista."
          breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Piano del Giorno" }]}
        />

        {/* Barra superiore */}
        <div className="toolbar flex-wrap gap-2">
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white/80 px-3 py-2.5 shadow-sm backdrop-blur-sm">
            <div className="min-w-[180px] px-1">
              <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">Giornata operativa</p>
              <p className="text-sm font-semibold capitalize text-slate-800">{readableDate(date)}</p>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 transition"
                onClick={() => changeDate(addIsoDays(date, -1))}
                title="Giorno precedente"
              >
                ‹
              </button>
              <DateInput
                className="input-saas h-10 w-40 text-sm font-semibold"
                value={date}
                onChange={changeDate}
              />
              <button
                type="button"
                className="rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 transition"
                onClick={() => changeDate(addIsoDays(date, 1))}
                title="Giorno successivo"
              >
                ›
              </button>
            </div>
            <button
              type="button"
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition"
              onClick={() => changeDate(today())}
            >
              Oggi
            </button>
            <button
              type="button"
              className={`rounded border px-3 py-2 text-xs font-semibold ${
                date === STRESS_TEST_DATE
                  ? "border-slate-800 bg-slate-900 text-white"
                  : "border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100"
              }`}
              onClick={() => changeDate(STRESS_TEST_DATE)}
            >
              Stress test
            </button>
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
              onClick={() => setViewMode(viewMode === "plan" ? "manual" : "plan")}
              className="btn-secondary text-xs"
            >
              {viewMode === "plan" ? "Strumenti manuali" : "Torna al piano"}
            </button>
            <button
              onClick={() => void runAiPlan()}
              disabled={aiPlanning || autoAssigning || !token || !data}
              className="btn-secondary text-sm px-4 font-semibold disabled:opacity-50"
              title="Claude analizza il carico del giorno e propone priorita operative senza applicare modifiche"
            >
              {aiPlanning ? "AI al lavoro..." : "Analizza con AI"}
            </button>
            <button
              onClick={handleAutoAssign}
              disabled={availabilityLocked || autoAssigning || !token || !data}
              className="btn-primary text-sm px-4 font-semibold disabled:opacity-50"
            >
              {autoAssigning ? "Generazione giri…" : "Applica piano automatico"}
            </button>
            <button
              onClick={() => { setShowImprevisti(true); setImpResult(null); }}
              disabled={!token || !data}
              className="btn-secondary text-sm px-3 disabled:opacity-50"
              title="Gestisci imprevisti: sostituzione autista/mezzo o ritardo corsa"
            >
              ⚠ Imprevisto
            </button>
            <button
              className="btn-secondary text-xs"
              onClick={() => printDriverPlans(
                driverEntries,
                data?.trip_groups ?? [],
                tripServices,
                hotelMap,
                date,
                data?.ferry_schedules ?? []
              )}
            >
              Stampa piani
            </button>
            {(() => {
              const missingDriver = tripRows.filter(t => (!t.group.driver_user_id && !t.group.driver_profile_id) || !t.group.vehicle_label);
              const canExport = unassignedServices.length === 0 && missingDriver.length === 0 && (data?.trip_groups.length ?? 0) > 0;
              const blockerDetail = unassignedServices.length > 0
                ? `${unassignedServices.length} servizi senza giro`
                : missingDriver.length > 0
                  ? `${missingDriver.length} giri senza autista/mezzo`
                  : "";
              return (
                <a
                  href={canExport ? `/api/ops/piano-giorno/export-excel?date=${date}&token=${token ?? ""}` : undefined}
                  onClick={e => {
                    if (!canExport || !token) { e.preventDefault(); return; }
                    const url = `/api/ops/piano-giorno/export-excel?date=${date}`;
                    void fetch(url, { headers: { Authorization: `Bearer ${token}` } })
                      .then(r => r.blob())
                      .then(blob => {
                        const a = document.createElement("a");
                        a.href = URL.createObjectURL(blob);
                        a.download = `piano-giorno-${date.replace(/-/g, "")}.xlsx`;
                        a.click();
                      });
                    e.preventDefault();
                  }}
                  title={canExport ? "Scarica Excel completo del giorno" : `Non disponibile: ${blockerDetail}`}
                  className={`btn-secondary text-xs ${canExport ? "cursor-pointer" : "opacity-40 cursor-not-allowed pointer-events-auto"}`}
                >
                  📥 Genera file del giorno
                  {!canExport && blockerDetail ? <span className="ml-1 text-amber-600">({blockerDetail})</span> : null}
                </a>
              );
            })()}
          </div>
        </div>

        {/* Banner risultato proposta automatica */}
        {autoResult && (
          <div className={`flex items-center justify-between px-4 py-2 rounded mb-2 text-sm ${
            autoResult.assigned > 0
              ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
              : "bg-amber-50 border border-amber-200 text-amber-800"
          }`}>
            <span>{autoResult.report.join(" · ")}</span>
            <button onClick={() => setAutoResult(null)} className="ml-4 opacity-60 hover:opacity-100 text-xs">✕</button>
          </div>
        )}

        {aiPlanError && (
          <div className="flex items-center justify-between rounded border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-800">
            <span>{aiPlanError}</span>
            <button onClick={() => setAiPlanError(null)} className="ml-4 text-xs opacity-60 hover:opacity-100">Chiudi</button>
          </div>
        )}

        {aiPlan && (
          <div className="card border border-cyan-200 bg-cyan-50/40 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-cyan-700">Analisi AI</p>
                <h2 className="mt-1 text-lg font-bold text-slate-900">Priorita operative</h2>
                <p className="mt-1 max-w-4xl text-sm text-slate-700">{aiPlan.plan.summary}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded border border-cyan-200 bg-white px-2 py-1 text-xs font-semibold text-cyan-800">
                  confidenza {aiPlan.plan.confidence}
                </span>
                <button onClick={() => setAiPlan(null)} className="rounded border border-cyan-200 bg-white px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-cyan-50">
                  Chiudi
                </button>
              </div>
            </div>

            <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="space-y-2">
                <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Azioni consigliate</p>
                {aiPlan.plan.priority_actions.length === 0 ? (
                  <p className="rounded border border-cyan-100 bg-white px-3 py-2 text-sm text-slate-600">Nessuna azione critica suggerita.</p>
                ) : (
                  aiPlan.plan.priority_actions.map((action, index) => (
                    <div key={`${action.title}-${index}`} className="rounded border border-cyan-100 bg-white px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${
                          action.priority === "alta" ? "bg-rose-50 text-rose-700" : action.priority === "media" ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-600"
                        }`}>
                          {action.priority}
                        </span>
                        <p className="text-sm font-bold text-slate-900">{action.title}</p>
                      </div>
                      <p className="mt-1 text-xs text-slate-600">{action.reason}</p>
                      <p className="mt-1 text-xs font-semibold text-cyan-800">{action.operator_action}</p>
                    </div>
                  ))
                )}
              </div>

              <div className="space-y-2">
                <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Batch suggeriti</p>
                {aiPlan.plan.suggested_batches.length === 0 ? (
                  <p className="rounded border border-cyan-100 bg-white px-3 py-2 text-sm text-slate-600">Nessun batch specifico suggerito.</p>
                ) : (
                  aiPlan.plan.suggested_batches.map((batch, index) => (
                    <div key={`${batch.direction}-${batch.time_window}-${index}`} className="rounded border border-cyan-100 bg-white px-3 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${
                            batch.direction === "arrival" ? "bg-blue-50 text-blue-700" : "bg-amber-50 text-amber-700"
                          }`}>
                            {directionLabel(batch.direction)}
                          </span>
                          <span className="font-mono text-sm font-bold text-slate-900">{batch.time_window}</span>
                        </div>
                        <span className="text-xs font-semibold text-slate-600">{batch.services} servizi · {batch.pax} pax</span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {[batch.port, batch.zone].filter(Boolean).join(" · ") || "Area da verificare"}
                      </p>
                      <p className="mt-1 text-xs font-semibold text-slate-800">{batch.recommendation}</p>
                      {batch.risk ? <p className="mt-1 text-xs text-rose-700">{batch.risk}</p> : null}
                    </div>
                  ))
                )}
              </div>
            </div>

            {aiPlan.plan.warnings.length > 0 && (
              <div className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2">
                <p className="text-xs font-bold uppercase tracking-wide text-amber-700">Attenzioni</p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-amber-800">
                  {aiPlan.plan.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}
                </ul>
              </div>
            )}

            {aiPlan.usage ? (
              <p className="mt-2 text-[11px] text-slate-500">
                Token usati: input {aiPlan.usage.input_tokens ?? "n/d"}, output {aiPlan.usage.output_tokens ?? "n/d"}.
              </p>
            ) : null}
          </div>
        )}

        {error && <p className="text-sm text-red-600 p-4">{error}</p>}

        {loading && !data && (
          <p className="text-sm text-slate-500 p-4">Caricamento piano del giorno…</p>
        )}

        {data && viewMode === "plan" && (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-4">
              <div className="card p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Servizi</p>
                <p className="mt-1 text-3xl font-bold text-slate-900">{totalServices}</p>
                <p className="text-xs text-slate-500">{assignedServices} gia pianificati</p>
              </div>
              <div className="card p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Giri</p>
                <p className="mt-1 text-3xl font-bold text-slate-900">{tripRows.length}</p>
                <p className="text-xs text-slate-500">{tripRows.filter((t) => t.group.driver_user_id || t.group.driver_profile_id).length} con autista</p>
              </div>
              <div className="card p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Da sistemare</p>
                <p className={`mt-1 text-3xl font-bold ${blockerCount > 0 ? "text-red-600" : "text-emerald-600"}`}>
                  {planIssues.length}
                </p>
                <p className="text-xs text-slate-500">{blockerCount} bloccanti</p>
              </div>
              <div className="card p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Fuori piano</p>
                <p className={`mt-1 text-3xl font-bold ${unassignedServices.length > 0 ? "text-amber-600" : "text-slate-900"}`}>
                  {unassignedServices.length}
                </p>
                <p className="text-xs text-slate-500">servizi non inseriti in un giro</p>
              </div>
            </div>

            {planWindows.length > 0 && (
              <div className="card p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-bold text-slate-800">Fasce operative</h2>
                    <p className="text-xs text-slate-500">Per giornate grandi, controlla blocchi orari invece dei singoli servizi.</p>
                  </div>
                  {activeWindow && (
                    <button
                      onClick={() => setActiveWindowId(null)}
                      className="rounded border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                    >
                      Mostra tutte le fasce
                    </button>
                  )}
                </div>

                <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                  {planWindows.slice(0, 16).map((window) => (
                    <button
                      key={window.id}
                      onClick={() => {
                        setActiveWindowId(activeWindowId === window.id ? null : window.id);
                        setPlanFilter(window.direction === "arrival" ? "arrivals" : "departures");
                      }}
                      className={`rounded border p-3 text-left transition-colors ${
                        activeWindowId === window.id
                          ? "border-slate-800 bg-slate-900 text-white"
                          : window.issues > 0
                            ? "border-amber-200 bg-amber-50 hover:bg-amber-100"
                            : "border-slate-200 bg-white hover:bg-slate-50"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-bold uppercase tracking-wide">
                          {directionLabel(window.direction)}
                        </span>
                        <span className="font-mono text-sm font-bold">{window.label}</span>
                      </div>
                      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                        <span><b>{window.trips}</b> giri</span>
                        <span><b>{window.services}</b> servizi</span>
                        <span><b>{window.pax}</b> pax</span>
                      </div>
                      <p className={`mt-2 text-xs font-semibold ${
                        activeWindowId === window.id
                          ? "text-white"
                          : window.issues > 0
                            ? "text-amber-800"
                            : "text-emerald-700"
                      }`}>
                        {window.issues > 0
                          ? `${window.issues} verifiche · ${window.missingDrivers} senza autista`
                          : "fascia pronta"}
                      </p>
                    </button>
                  ))}
                </div>

                {planWindows.length > 16 && (
                  <p className="mt-2 text-xs text-slate-500">
                    Mostrate le prime 16 fasce. Usa Arrivi/Partenze e la ricerca per restringere il controllo.
                  </p>
                )}
              </div>
            )}

            {unassignedServices.length > 0 && (
              <div className="card p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-bold text-slate-800">Carico da organizzare</h2>
                    <p className="text-xs text-slate-500">
                      I servizi appena inseriti partono da qui: prima trasformali in giri, poi correggi solo le eccezioni.
                    </p>
                  </div>
                  <button
                    onClick={handleAutoAssign}
                    disabled={availabilityLocked || autoAssigning || !token || !data}
                    className="btn-primary text-sm disabled:opacity-50"
                  >
                    {autoAssigning ? "Creo la proposta..." : "Crea piano dai servizi non assegnati"}
                  </button>
                </div>

                <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                  {unassignedWindows.slice(0, 20).map((window) => (
                    <div
                      key={window.id}
                      className={`rounded border p-3 ${
                        window.missingHotels > 0 ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                          window.direction === "arrival" ? "bg-blue-50 text-blue-700" : "bg-amber-100 text-amber-800"
                        }`}>
                          {directionLabel(window.direction)}
                        </span>
                        <span className="font-mono text-sm font-bold text-slate-900">{window.label}</span>
                      </div>
                      <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-slate-600">
                        <span><b>{window.services.length}</b> servizi</span>
                        <span><b>{window.pax}</b> pax</span>
                        <span><b>{window.groups.length}</b> gruppi</span>
                      </div>
                      <p className="mt-2 line-clamp-2 text-xs text-slate-500">
                        {window.groups.slice(0, 3).join(" · ")}
                        {window.groups.length > 3 ? ` · +${window.groups.length - 3}` : ""}
                      </p>
                      {window.missingHotels > 0 && (
                        <p className="mt-2 text-xs font-semibold text-amber-800">
                          {window.missingHotels} senza hotel/zona
                        </p>
                      )}
                    </div>
                  ))}
                </div>

                {unassignedWindows.length > 20 && (
                  <p className="mt-2 text-xs text-slate-500">
                    Mostrate le prime 20 fasce da organizzare. La proposta automatica lavora comunque su tutti i {unassignedServices.length} servizi.
                  </p>
                )}
              </div>
            )}

            {arrivalMergeSuggestions.length > 0 && (
              <div className="card p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-bold text-slate-800">Accorpamenti arrivi possibili</h2>
                    <p className="text-xs text-slate-500">
                      Navi sullo stesso porto a distanza breve: operatore puo decidere di aspettare e fare un unico giro.
                    </p>
                  </div>
                  <span className="rounded bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700">
                    finestra 25 minuti
                  </span>
                </div>

                <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                  {arrivalMergeSuggestions.slice(0, 9).map((item) => (
                    <div key={item.id} className="rounded border border-blue-100 bg-blue-50 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-bold text-blue-900">{item.port}</p>
                        <p className="font-mono text-sm font-bold text-blue-900">{item.firstTime}-{item.lastTime}</p>
                      </div>
                      <p className="mt-1 text-xs text-blue-800">
                        {item.services} servizi · {item.pax} pax · {item.vessels.slice(0, 3).join(" + ")}
                        {item.vessels.length > 3 ? ` +${item.vessels.length - 3}` : ""}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
              <div className="space-y-4">
                <div className="card p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-bold text-slate-800">Problemi da risolvere</h2>
                      <p className="text-xs text-slate-500">Prima stampa solo quando questa lista e pulita.</p>
                    </div>
                    {planIssues.length === 0 && (
                      <span className="rounded bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">Ok</span>
                    )}
                  </div>

                  <div className="mt-3 space-y-2">
                    {planIssues.length === 0 ? (
                      <p className="rounded border border-emerald-100 bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
                        Nessun problema evidente. Puoi stampare i piani autista.
                      </p>
                    ) : (
                      planIssues.slice(0, 8).map((issue) => (
                        <div
                          key={issue.id}
                          className={`rounded border px-3 py-2 ${
                            issue.severity === "blocker"
                              ? "border-red-200 bg-red-50"
                              : "border-amber-200 bg-amber-50"
                          }`}
                        >
                          <p className={`text-sm font-semibold ${issue.severity === "blocker" ? "text-red-800" : "text-amber-800"}`}>
                            {issue.title}
                          </p>
                          <p className={`text-xs ${issue.severity === "blocker" ? "text-red-600" : "text-amber-700"}`}>
                            {issue.detail}
                          </p>
                        </div>
                      ))
                    )}
                    {planIssues.length > 8 && (
                      <button
                        onClick={() => setViewMode("manual")}
                        className="w-full rounded border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                      >
                        Apri strumenti manuali per vedere gli altri {planIssues.length - 8}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <div className="card overflow-hidden">
                <div className="border-b border-slate-100 px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-bold text-slate-800">Giri del giorno</h2>
                      <p className="text-xs text-slate-500">Lista ordinata per orario, pensata per controllo rapido.</p>
                    </div>
                    <button
                      onClick={() => setViewMode("manual")}
                      className="rounded border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                    >
                      Modifica piano
                    </button>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <input
                      className="input-saas min-w-[220px] flex-1 text-sm"
                      placeholder="Cerca cliente, hotel, autista..."
                      value={planSearch}
                      onChange={(e) => setPlanSearch(e.target.value)}
                    />
                    {(["all", "issues", "missing_driver", "arrivals", "departures"] as const).map((filter) => (
                      <button
                        key={filter}
                        onClick={() => setPlanFilter(filter)}
                        className={`rounded border px-3 py-1.5 text-xs font-semibold transition-colors ${
                          planFilter === filter
                            ? "border-slate-800 bg-slate-800 text-white"
                            : "border-slate-200 text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        {planFilterLabel(filter)}
                      </button>
                    ))}
                  </div>

                  <p className="mt-2 text-xs text-slate-500">
                    {filteredTripRows.length} giri visibili su {tripRows.length}
                    {activeWindow ? ` · fascia ${directionLabel(activeWindow.direction).toLowerCase()} ${activeWindow.label}` : ""}
                  </p>
                </div>

                <div className="max-h-[calc(100vh-360px)] min-h-[420px] overflow-y-auto divide-y divide-slate-100">
                  {tripRows.length === 0 ? (
                    <div className="flex min-h-[300px] flex-col items-center justify-center px-6 text-center">
                      <p className="text-lg font-bold text-slate-800">Nessun giro pianificato</p>
                      <p className="mt-1 max-w-md text-sm text-slate-500">
                        Genera una proposta automatica per costruire il piano, poi correggi solo le eccezioni.
                      </p>
                      <button
                        onClick={handleAutoAssign}
                        disabled={availabilityLocked || autoAssigning || !token}
                        className="btn-primary mt-4 text-sm disabled:opacity-50"
                      >
                        {autoAssigning ? "Generazione giri…" : "Applica piano automatico"}
                      </button>
                    </div>
                  ) : filteredTripRows.length === 0 ? (
                    <div className="flex min-h-[240px] flex-col items-center justify-center px-6 text-center">
                      <p className="text-base font-bold text-slate-800">Nessun giro con questi filtri</p>
                      <p className="mt-1 text-sm text-slate-500">Togli un filtro o cerca un altro nome.</p>
                    </div>
                  ) : (
                    filteredTripRows.map((trip) => {
                      const isExpanded = expandedTripId === trip.group.id;
                      return (
                      <div key={trip.group.id} className="px-4 py-3 hover:bg-slate-50">
                        <div className="flex flex-wrap items-start gap-3">
                          <div className="w-16 shrink-0">
                            <p className="font-mono text-lg font-bold text-slate-900">{trip.time}</p>
                            <span className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                              trip.direction === "arrival"
                                ? "bg-blue-50 text-blue-700"
                                : trip.direction === "departure"
                                  ? "bg-amber-50 text-amber-700"
                                  : "bg-slate-100 text-slate-600"
                            }`}>
                              {directionLabel(trip.direction)}
                            </span>
                          </div>

                          <div className="min-w-[220px] flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-semibold text-slate-900">{trip.routeLabel}</p>
                              <span className="text-xs text-slate-400">verso</span>
                              <p className="font-semibold text-slate-700">{trip.hotelLabel}</p>
                            </div>
                            <p className="mt-1 text-xs text-slate-500">
                              {trip.services.length} servizi · {trip.pax} pax · {statusLabel(trip.status)}
                            </p>
                          </div>

                          <div className="min-w-[180px] shrink-0 text-sm">
                            <p className={(trip.group.driver_user_id || trip.group.driver_profile_id) ? "font-semibold text-slate-800" : "font-semibold text-red-700"}>
                              {trip.driverName}
                            </p>
                            <p className={trip.group.vehicle_label ? "text-xs text-slate-500" : "text-xs text-amber-700"}>
                              {trip.group.vehicle_label ?? "Mezzo da assegnare"}
                              {trip.group.vehicle_capacity ? ` · ${trip.group.vehicle_capacity} posti` : ""}
                            </p>
                          </div>

                          <div className="shrink-0">
                            {trip.issueCount > 0 ? (
                              <span className="rounded bg-red-50 px-2 py-1 text-xs font-semibold text-red-700">
                                {trip.issueCount} da verificare
                              </span>
                            ) : (
                              <span className="rounded bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">
                                pronto
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          {trip.services.slice(0, 6).map((svc) => (
                            <span key={svc.id} className="rounded bg-slate-100 px-2 py-1 text-[11px] text-slate-600">
                              {customerName(svc)} · {svc.pax}p
                            </span>
                          ))}
                          {trip.services.length > 6 && (
                            <span className="rounded bg-slate-100 px-2 py-1 text-[11px] text-slate-500">
                              +{trip.services.length - 6} altri
                            </span>
                          )}
                          <button
                            onClick={() => setExpandedTripId(isExpanded ? null : trip.group.id)}
                            className="rounded border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-white"
                          >
                            {isExpanded ? "Chiudi dettagli" : "Dettagli"}
                          </button>
                        </div>

                        {isExpanded && (
                          <div className="mt-3 rounded border border-slate-200 bg-white">
                            <div className="grid gap-2 border-b border-slate-100 px-3 py-2 text-xs text-slate-600 sm:grid-cols-3">
                              <div>
                                <span className="font-semibold text-slate-800">Autista:</span> {trip.driverName}
                              </div>
                              <div>
                                <span className="font-semibold text-slate-800">Mezzo:</span> {trip.group.vehicle_label ?? "Da assegnare"}
                              </div>
                              <div>
                                <span className="font-semibold text-slate-800">Totale:</span> {trip.pax} pax
                              </div>
                            </div>

                            <div className="divide-y divide-slate-100">
                              {trip.services.map((svc) => {
                                const hotel = hotelMap.get(svc.hotel_id ?? "");
                                return (
                                  <div key={svc.id} className="grid gap-2 px-3 py-2 text-xs sm:grid-cols-[70px_minmax(160px,1fr)_minmax(160px,1fr)_120px]">
                                    <div className="font-mono font-semibold text-slate-700">
                                      {serviceDisplayTime(svc)}
                                    </div>
                                    <div>
                                      <p className="font-semibold text-slate-800">{customerName(svc)} · {svc.pax}p</p>
                                      <p className="text-slate-500">{svc.phone ?? "telefono mancante"}</p>
                                    </div>
                                    <div>
                                      <p className="font-semibold text-slate-700">{hotel?.name ?? "hotel mancante"}</p>
                                      <p className="text-slate-500">{hotel?.zone ?? "zona mancante"}</p>
                                    </div>
                                    <div className="text-slate-500">
                                      {svc.direction === "arrival" ? cleanPortName(svc.meeting_point) || svc.vessel || "arrivo" : cleanPortName(svc.meeting_point) || svc.vessel || "partenza"}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>

                            {trip.group.notes && (
                              <p className="border-t border-slate-100 px-3 py-2 text-xs italic text-slate-500">{trip.group.notes}</p>
                            )}
                          </div>
                        )}
                      </div>
                    );})
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {data && viewMode === "manual" && (
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
                drivers={driverEntries}
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
                drivers={driverEntries}
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
