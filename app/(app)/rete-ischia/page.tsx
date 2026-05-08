"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DateInput, PageHeader } from "@/components/ui";
import { hasSupabaseEnv, supabase, getToken} from "@/lib/supabase/client";
import { getPickupRule, getPickupRuleByRange, normalizeZonaIschia } from "@/lib/departure-pickup-rules";

// ── Tipi ─────────────────────────────────────────────────────────────────────

type Driver = { id: string; name: string; phone: string | null; vehicle_type: string | null; capacity: number; active: boolean };
type Hotel = { id: string; name: string; zone: string | null };
type ServiceIschia = {
  id: string;
  customer_name: string;
  customer_phone: string | null;
  hotel_partenza_name: string;
  hotel_arrivo_name: string;
  hotel_partenza_id: string | null;
  hotel_arrivo_id: string | null;
  travel_date: string;
  orario: string | null;
  pax: number;
  driver_id: string | null;
  status: "pending" | "assigned" | "completed" | "cancelled";
  notes: string | null;
  created_at: string;
};

type PickupRun = {
  id: string;
  run_date: string;
  port: string;
  direction: "arrival" | "departure";
  window_open: string;
  window_close: string;
  total_pax: number;
  status: string;
  notes: string | null;
  bus_line_family_code: string | null;
  line_color: string | null;
};

type PickupRunArrival = {
  id: string;
  run_id: string;
  service_id: string | null;
  ferry_name: string;
  arrival_time: string;
  pax: number;
  notes: string | null;
};

type PickupRunBus = {
  id: string;
  run_id: string;
  direction: string;
  direction_label: string;
  vehicle_id: string | null;
  driver_profile_id: string | null;
  pax_assigned: number;
  notes: string | null;
};

type PickupRunPassenger = {
  id: string;
  run_id: string;
  service_id: string | null;
  passenger_name: string;
  passenger_phone: string | null;
  hotel_name: string;
  hotel_zone: string | null;
  pax: number;
  moved_to_dist_bus_id: string | null;
};

type DistBusAlert = {
  dist_bus_id: string;
  dist_bus_label: string;
  dist_bus_zone: string;
  line_label: string;
  line_color: string;
  free_seats: number;
  matching_passenger_ids: string[];
};

type Vehicle = { id: string; label: string; plate: string; capacity: number; vehicle_size: string };
type DriverProfile = { id: string; full_name: string; phone: string | null };
type RoutingRule = { id: string; port: string; direction: string; label: string; zone_filter: string[]; sort_order: number };

// ── Helpers ───────────────────────────────────────────────────────────────────


const STATUS_LABELS: Record<string, string> = {
  pending: "Da assegnare", assigned: "Assegnato",
  completed: "Completato", cancelled: "Annullato",
};
const STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700", assigned: "bg-emerald-100 text-emerald-700",
  completed: "bg-slate-100 text-slate-600", cancelled: "bg-rose-100 text-rose-600",
};

const RUN_STATUS_COLORS: Record<string, string> = {
  planned: "bg-sky-100 text-sky-700",
  active: "bg-amber-100 text-amber-700",
  completed: "bg-emerald-100 text-emerald-700",
  cancelled: "bg-rose-100 text-rose-600",
};
const RUN_STATUS_LABELS: Record<string, string> = {
  planned: "Pianificata", active: "In corso",
  completed: "Completata", cancelled: "Annullata",
};

const PORT_LABELS: Record<string, string> = {
  casamicciola: "Casamicciola", ischia: "Ischia Porto",
  napoli: "Napoli", pozzuoli: "Pozzuoli",
};

const PORT_COLORS: Record<string, string> = {
  casamicciola: "border-l-violet-500",
  ischia: "border-l-sky-500",
  napoli: "border-l-orange-500",
  pozzuoli: "border-l-rose-500",
};

function fmtDate(iso: string) {
  return new Date(iso + "T12:00:00").toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" });
}

function fmtTime(t: string) {
  return t?.slice(0, 5) ?? "";
}

// ── Componente BusRow ─────────────────────────────────────────────────────────

function BusRow({
  bus, vehicles, drivers, saving, onUpdate, onRemove,
}: {
  bus: PickupRunBus;
  vehicles: Vehicle[];
  drivers: DriverProfile[];
  saving: boolean;
  onUpdate: (patch: Partial<PickupRunBus>) => void;
  onRemove: () => void;
}) {
  const vehicle = vehicles.find((v) => v.id === bus.vehicle_id);
  const driver = drivers.find((d) => d.id === bus.driver_profile_id);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold text-slate-700">{bus.direction_label}</span>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700">
            {bus.pax_assigned} pax
          </span>
          <button onClick={onRemove} disabled={saving}
            className="text-xs text-slate-400 hover:text-rose-500 disabled:opacity-40">✕</button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <select
          value={bus.vehicle_id ?? ""}
          disabled={saving}
          onChange={(e) => onUpdate({ vehicle_id: e.target.value || null })}
          className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-700 disabled:opacity-50">
          <option value="">— Mezzo —</option>
          {vehicles.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label} ({v.capacity} p.)
            </option>
          ))}
        </select>
        <select
          value={bus.driver_profile_id ?? ""}
          disabled={saving}
          onChange={(e) => onUpdate({ driver_profile_id: e.target.value || null })}
          className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-700 disabled:opacity-50">
          <option value="">— Autista —</option>
          {drivers.map((d) => (
            <option key={d.id} value={d.id}>{d.full_name}</option>
          ))}
        </select>
      </div>
      {(vehicle || driver) && (
        <div className="mt-1.5 text-xs text-slate-500 flex gap-3">
          {vehicle && <span>🚌 {vehicle.label} · {vehicle.plate}</span>}
          {driver && <span>👤 {driver.full_name}{driver.phone ? ` · ${driver.phone}` : ""}</span>}
        </div>
      )}
    </div>
  );
}

// ── Componente PickupRunCard ──────────────────────────────────────────────────

function PickupRunCard({
  run, arrivals, buses, passengers, alerts, vehicles, drivers, routingRules, saving,
  onPost, date,
}: {
  run: PickupRun;
  arrivals: PickupRunArrival[];
  buses: PickupRunBus[];
  passengers: PickupRunPassenger[];
  alerts: DistBusAlert[];
  vehicles: Vehicle[];
  drivers: DriverProfile[];
  routingRules: RoutingRule[];
  saving: boolean;
  onPost: (action: string, data: Record<string, unknown>) => Promise<void>;
  date: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const [addingArrival, setAddingArrival] = useState(false);
  const [arrForm, setArrForm] = useState({ ferry_name: "", arrival_time: "", pax: 0 });

  const portRules = routingRules.filter((r) => r.port === run.port).sort((a, b) => a.sort_order - b.sort_order);
  const runArrivals = arrivals.filter((a) => a.run_id === run.id);
  const runBuses = buses.filter((b) => b.run_id === run.id);

  // Usa il colore linea se disponibile, altrimenti colore porto
  const borderColor = run.line_color
    ? `border-l-[${run.line_color}]`
    : PORT_COLORS[run.port] ?? "border-l-slate-400";

  // Passeggeri attivi (non ancora spostati su bus smistamento)
  const activePassengers = passengers.filter((p) => !p.moved_to_dist_bus_id);
  const movedPassengers = passengers.filter((p) => p.moved_to_dist_bus_id);

  return (
    <div
      className={`rounded-xl border-l-4 border border-slate-200 bg-slate-50 shadow-sm ${PORT_COLORS[run.port] ?? "border-l-slate-400"}`}
      style={run.line_color ? { borderLeftColor: run.line_color } : undefined}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <button onClick={() => setExpanded((e) => !e)} className="text-slate-400 hover:text-slate-700">
          {expanded ? "▾" : "▸"}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {/* Badge linea colorato */}
            {run.bus_line_family_code && run.line_color && (
              <span
                className="rounded-full px-2 py-0.5 text-xs font-bold text-white"
                style={{ backgroundColor: run.line_color }}>
                {run.bus_line_family_code.charAt(0).toUpperCase() + run.bus_line_family_code.slice(1)}
              </span>
            )}
            <span className="font-bold text-slate-900">{PORT_LABELS[run.port] ?? run.port}</span>
            <span className="text-sm text-slate-600">
              {fmtTime(run.window_open)} – {fmtTime(run.window_close)}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${RUN_STATUS_COLORS[run.status]}`}>
              {RUN_STATUS_LABELS[run.status]}
            </span>
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-700">
              {run.total_pax} pax
            </span>
            {passengers.length > 0 && (
              <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700">
                {passengers.length} passeggeri Transfer
              </span>
            )}
            {alerts.length > 0 && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                ⚠ {alerts.length} alert posti
              </span>
            )}
          </div>
          {run.notes && <p className="mt-0.5 text-xs text-slate-500">{run.notes}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {run.status === "planned" && (
            <button
              onClick={() => void onPost("update_run", { run_id: run.id, status: "active", date })}
              disabled={saving}
              className="rounded border border-amber-200 px-2 py-0.5 text-xs text-amber-700 hover:bg-amber-50 disabled:opacity-40">
              ▶ Avvia
            </button>
          )}
          {run.status === "active" && (
            <button
              onClick={() => void onPost("update_run", { run_id: run.id, status: "completed", date })}
              disabled={saving}
              className="rounded border border-emerald-200 px-2 py-0.5 text-xs text-emerald-700 hover:bg-emerald-50 disabled:opacity-40">
              ✓ Completa
            </button>
          )}
          <button
            onClick={() => void onPost("delete_run", { run_id: run.id, date })}
            disabled={saving}
            className="rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-400 hover:border-rose-300 hover:text-rose-500 disabled:opacity-40">
            ✕
          </button>
        </div>
      </div>

      {/* Body espandibile */}
      {expanded && (
        <div className="border-t border-slate-200 px-4 py-3 space-y-4">
          {/* Traghetti */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Traghetti</p>
              <button onClick={() => setAddingArrival(true)}
                className="text-xs text-indigo-600 hover:underline">+ aggiungi</button>
            </div>
            {runArrivals.length === 0 && (
              <p className="text-xs text-slate-400">Nessun traghetto agganciato.</p>
            )}
            <div className="space-y-1.5">
              {runArrivals.map((arr) => (
                <div key={arr.id} className="flex items-center gap-3 rounded-lg bg-white border border-slate-200 px-3 py-2 text-sm">
                  <span className="font-mono text-slate-700">{fmtTime(arr.arrival_time)}</span>
                  <span className="flex-1 font-medium text-slate-800">{arr.ferry_name}</span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{arr.pax} pax</span>
                  {arr.notes && <span className="text-xs text-slate-400">{arr.notes}</span>}
                  <button
                    onClick={() => void onPost("remove_arrival", { arrival_id: arr.id, run_id: run.id, date })}
                    disabled={saving}
                    className="text-xs text-slate-300 hover:text-rose-500 disabled:opacity-40">✕</button>
                </div>
              ))}
            </div>

            {/* Form aggiungi traghetto */}
            {addingArrival && (
              <div className="mt-2 flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2">
                <input value={arrForm.ferry_name}
                  onChange={(e) => setArrForm((f) => ({ ...f, ferry_name: e.target.value }))}
                  placeholder="Nome traghetto" className="flex-1 rounded border border-slate-200 px-2 py-1 text-xs" />
                <input type="time" value={arrForm.arrival_time}
                  onChange={(e) => setArrForm((f) => ({ ...f, arrival_time: e.target.value }))}
                  className="w-24 rounded border border-slate-200 px-2 py-1 text-xs" />
                <input type="number" value={arrForm.pax || ""} min={0}
                  onChange={(e) => setArrForm((f) => ({ ...f, pax: parseInt(e.target.value) || 0 }))}
                  placeholder="Pax" className="w-14 rounded border border-slate-200 px-2 py-1 text-xs text-center" />
                <button
                  disabled={saving || !arrForm.ferry_name.trim() || !arrForm.arrival_time}
                  onClick={() => {
                    void onPost("add_arrival", {
                      run_id: run.id, ...arrForm, date,
                    }).then(() => {
                      setAddingArrival(false);
                      setArrForm({ ferry_name: "", arrival_time: "", pax: 0 });
                    });
                  }}
                  className="rounded bg-indigo-600 px-2 py-1 text-xs text-white hover:bg-indigo-700 disabled:opacity-40">
                  Aggiungi
                </button>
                <button onClick={() => setAddingArrival(false)} className="text-xs text-slate-400 hover:text-slate-700">Annulla</button>
              </div>
            )}
          </div>

          {/* Bus per direzione */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Bus assegnati</p>
              {/* Aggiungi bus: pulsanti rapidi per le direzioni disponibili non ancora usate */}
              <div className="flex gap-1">
                {portRules
                  .filter((rule) => !runBuses.some((b) => b.direction === rule.direction))
                  .map((rule) => (
                    <button key={rule.direction}
                      onClick={() => void onPost("upsert_bus", {
                        run_id: run.id,
                        direction: rule.direction,
                        direction_label: rule.label,
                        pax_assigned: 0,
                        date,
                      })}
                      disabled={saving}
                      className="rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-40">
                      + {rule.direction}
                    </button>
                  ))}
              </div>
            </div>
            {runBuses.length === 0 && (
              <p className="text-xs text-slate-400">Nessun bus assegnato. Clicca + per aggiungere una direzione.</p>
            )}
            <div className="space-y-2">
              {runBuses.map((bus) => (
                <BusRow
                  key={bus.id}
                  bus={bus}
                  vehicles={vehicles}
                  drivers={drivers}
                  saving={saving}
                  onUpdate={(patch) => { const { run_id: _r, ...busRest } = bus; void onPost("upsert_bus", { bus_id: bus.id, run_id: run.id, ...busRest, ...patch, date }); }}
                  onRemove={() => void onPost("remove_bus", { bus_id: bus.id, date })}
                />
              ))}
            </div>
          </div>

          {/* Passeggeri Transfer Ischia */}
          {passengers.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                Passeggeri Transfer Ischia ({activePassengers.length} attivi
                {movedPassengers.length > 0 ? `, ${movedPassengers.length} spostati` : ""})
              </p>
              <div className="space-y-1.5">
                {activePassengers.map((p) => (
                  <div key={p.id} className="flex items-center gap-3 rounded-lg bg-white border border-slate-200 px-3 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <span className="font-semibold text-slate-800">{p.passenger_name}</span>
                      {p.passenger_phone && <span className="ml-2 text-xs text-slate-400">📞 {p.passenger_phone}</span>}
                      <div className="mt-0.5 text-xs text-slate-500">
                        🏨 {p.hotel_name}
                        {p.hotel_zone && <span className="ml-1 text-slate-400">({p.hotel_zone})</span>}
                        <span className="ml-2">👥 {p.pax} pax</span>
                      </div>
                    </div>
                  </div>
                ))}
                {movedPassengers.map((p) => (
                  <div key={p.id} className="flex items-center gap-3 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm opacity-60">
                    <div className="min-w-0 flex-1">
                      <span className="font-semibold text-slate-700 line-through">{p.passenger_name}</span>
                      <span className="ml-2 text-xs text-emerald-600">✓ spostato su bus linea</span>
                      <div className="mt-0.5 text-xs text-slate-400">🏨 {p.hotel_name} · 👥 {p.pax} pax</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Alert posti liberi su bus smistamento linea */}
          {alerts.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-500">
                ⚠ Alert posti liberi su bus linea
              </p>
              <div className="space-y-2">
                {alerts.map((alert) => (
                  <div key={alert.dist_bus_id}
                    className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className="rounded-full px-2 py-0.5 text-xs font-bold text-white"
                            style={{ backgroundColor: alert.line_color }}>
                            {alert.line_label}
                          </span>
                          <span className="font-semibold text-slate-800">{alert.dist_bus_label}</span>
                          <span className="text-xs text-slate-500">zona {alert.dist_bus_zone}</span>
                        </div>
                        <p className="mt-0.5 text-xs text-amber-700">
                          {alert.free_seats} posti liberi · {alert.matching_passenger_ids.length} passeggeri Transfer compatibili
                        </p>
                      </div>
                      <button
                        disabled={saving}
                        onClick={() => {
                          void Promise.all(
                            alert.matching_passenger_ids.map((pid) =>
                              onPost("move_to_dist_bus", { run_service_id: pid, dist_bus_id: alert.dist_bus_id })
                            )
                          );
                        }}
                        className="shrink-0 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-40">
                        Sposta su bus linea
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Tipi partenze ─────────────────────────────────────────────────────────────

type DepartureService = {
  id: string;
  customer_name: string;
  phone: string | null;
  vessel: string | null;
  pax: number;
  departure_time: string | null;
  time: string | null;
  return_time: string | null;
  hotel_id: string | null;
  hotel_name: string | null;
  hotel_zone: string | null;
  notes: string | null;
  status: string;
  booking_service_kind: string | null;
  billing_party_name: string | null;
  transport_code: string | null;
};

type DepBusGroup = {
  key: string;
  pickup_time: string;
  boat_co: string;
  boat_t: string;
  porto_p: string;
  total_pax: number;
  services: Array<DepartureService & { computed_pickup: string }>;
  assigned_driver_user_id: string | null;
  vehicle_label: string | null;
};

type DepDriver = {
  profile_id: string;
  full_name: string;
  phone: string | null;
  user_id: string | null;
  has_account: boolean;
};

function computePickupHint(svc: DepartureService): { pickup: string; boat_co: string; boat_t: string; porto_p: string; notes?: string } | null {
  const kind = svc.booking_service_kind;
  // Escludi bus linea — non incluso per ora
  if (!kind || kind === "bus_city_hotel" || kind === "excursion") return null;

  const zona = normalizeZonaIschia(svc.hotel_zone);
  const agency = svc.billing_party_name?.trim() ?? "";
  const tFrom = (svc.departure_time ?? svc.return_time ?? svc.time ?? "").trim();
  if (!tFrom) return null;

  let rule = null;

  if (kind === "formula_snav" || (kind === "transfer_port_hotel" && svc.vessel?.toLowerCase().includes("snav"))) {
    rule = getPickupRule(agency, "snav", tFrom, zona);
  } else if (kind === "formula_medmar_napoli" || kind === "formula_medmar_pozzuoli" || (kind === "transfer_port_hotel" && svc.vessel?.toLowerCase().includes("medmar"))) {
    rule = getPickupRule(agency, "medmar", tFrom, zona);
  } else if (kind === "transfer_train_hotel") {
    rule = getPickupRule(agency, "treno_traghetto", tFrom, zona)
      ?? getPickupRuleByRange(agency, "treno_traghetto", tFrom, zona)
      ?? getPickupRule(agency, "treno_aliscafo", tFrom, zona)
      ?? getPickupRuleByRange(agency, "treno_aliscafo", tFrom, zona);
  } else if (kind === "transfer_airport_hotel") {
    rule = getPickupRule("", "volo_traghetto", tFrom, zona)
      ?? getPickupRuleByRange("", "volo_traghetto", tFrom, zona)
      ?? getPickupRule("", "volo_aliscafo", tFrom, zona)
      ?? getPickupRuleByRange("", "volo_aliscafo", tFrom, zona);
  }

  if (!rule) return null;
  return { pickup: rule.pickup, boat_co: rule.boat_co, boat_t: rule.boat_t, porto_p: rule.porto_p, notes: rule.notes };
}

// ── Tab Corse Porto ───────────────────────────────────────────────────────────

function TabCorsePorto() {
  const [date, setDate] = useState(() => {
    // Default: prossima domenica
    const d = new Date();
    const diff = (7 - d.getDay()) % 7 || 7;
    d.setDate(d.getDate() + diff);
    return d.toISOString().slice(0, 10);
  });
  const [direction, setDirection] = useState<"arrival" | "departure">("arrival");

  // Stato arrivi (pickup_runs)
  const [runs, setRuns] = useState<PickupRun[]>([]);
  const [arrivals, setArrivals] = useState<PickupRunArrival[]>([]);
  const [buses, setBuses] = useState<PickupRunBus[]>([]);
  const [passengers, setPassengers] = useState<PickupRunPassenger[]>([]);
  const [alertsByRun, setAlertsByRun] = useState<Record<string, DistBusAlert[]>>({});
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<DriverProfile[]>([]);
  const [routing, setRouting] = useState<RoutingRule[]>([]);

  // Stato partenze
  const [depServices, setDepServices] = useState<DepartureService[]>([]);
  const [depAssignments, setDepAssignments] = useState<Map<string, { driver_user_id: string; vehicle_label: string }>>(new Map());
  const [depDrivers, setDepDrivers] = useState<DepDriver[]>([]);
  const [activatingDriver, setActivatingDriver] = useState<DepDriver | null>(null);
  const [activateEmail, setActivateEmail] = useState("");
  const [activateError, setActivateError] = useState("");
  const [activateSaving, setActivateSaving] = useState(false);
  const [assignSaving, setAssignSaving] = useState<string | null>(null); // group key being saved

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [showNewRun, setShowNewRun] = useState(false);
  const [newRunForm, setNewRunForm] = useState({ port: "casamicciola", window_open: "13:00", window_close: "14:00", notes: "" });
  const [autoPort, setAutoPort] = useState("casamicciola");

  const load = useCallback(async (d: string, dir: string) => {
    const token = await getToken();
    if (!token) { setLoading(false); return; }
    setLoading(true);

    if (dir === "departure") {
      const [svcRes, drvRes] = await Promise.all([
        fetch(`/api/ops/departure-services?date=${d}`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/ops/departure-bus-assign", { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      const svcBody = await svcRes.json().catch(() => null);
      const drvBody = await drvRes.json().catch(() => null);
      if (svcBody?.ok) {
        setDepServices(svcBody.services ?? []);
        const amap = new Map<string, { driver_user_id: string; vehicle_label: string }>();
        for (const a of (svcBody.assignments ?? []) as Array<{ service_id: string; driver_user_id: string; vehicle_label: string }>) {
          amap.set(a.service_id, { driver_user_id: a.driver_user_id, vehicle_label: a.vehicle_label });
        }
        setDepAssignments(amap);
      }
      if (drvBody?.ok) setDepDrivers(drvBody.drivers ?? []);
    } else {
      // Carica blocchi arrivi da pickup_runs
      const res = await fetch(`/api/ops/pickup-runs?date=${d}&direction=${dir}`, { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json().catch(() => null);
      if (body?.ok) {
        setRuns(body.runs ?? []);
        setArrivals(body.arrivals ?? []);
        setBuses(body.buses ?? []);
        setPassengers(body.passengers ?? []);
        setAlertsByRun(body.alerts_by_run ?? {});
        setVehicles(body.vehicles ?? []);
        setDrivers(body.drivers ?? []);
        setRouting(body.routing ?? []);
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(date, direction); }, [load, date, direction]);

  const post = useCallback(async (action: string, data: Record<string, unknown>) => {
    const token = await getToken();
    if (!token) return;
    setSaving(true);
    setMessage("");
    const res = await fetch("/api/ops/pickup-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, date, ...data }),
    });
    const body = await res.json().catch(() => null);
    setSaving(false);
    if (!res.ok || !body?.ok) { setMessage(body?.error ?? "Errore."); return; }
    setRuns(body.runs ?? []);
    setArrivals(body.arrivals ?? []);
    setBuses(body.buses ?? []);
    setPassengers(body.passengers ?? []);
    setAlertsByRun(body.alerts_by_run ?? {});
  }, [date]);

  // ── Stampa lista giro bus ───────────────────────────────────────────────────
  const printBusGroup = (group: DepBusGroup) => {
    const driverInfo = depDrivers.find((d) => d.user_id === group.assigned_driver_user_id);
    const title = group.key === "__no_pickup__"
      ? "Servizi senza orario calcolato"
      : `Bus ${group.pickup_time} · ${group.boat_co} ${group.boat_t} → ${group.porto_p}`;
    const readableVehicleLabel = (group.vehicle_label ?? "").replace(/^DEP_BUS:/, "");
    const rows = group.services.map((s) => ({
      "Prelevamento": s.computed_pickup || "--:--",
      "Cliente": s.customer_name,
      "Hotel": s.hotel_name ?? "N/D",
      "Zona": normalizeZonaIschia(s.hotel_zone),
      "Pax": s.pax,
      "Telefono": s.phone ?? "",
      "Traghetto ore": s.departure_time ?? s.return_time ?? s.time ?? "",
    }));
    const cols = Object.keys(rows[0] ?? {});
    const thead = cols.map((c) => `<th style="padding:6px 10px;background:#1e293b;color:#fff;font-size:11px;text-align:left">${c}</th>`).join("");
    const tbody = rows.map((r) =>
      `<tr>${cols.map((c) => `<td style="padding:5px 10px;font-size:12px;border-bottom:1px solid #e2e8f0">${(r as Record<string, unknown>)[c] ?? ""}</td>`).join("")}</tr>`
    ).join("");
    const html = `<!DOCTYPE html><html><head><title>${title}</title>
<style>body{font-family:Arial,sans-serif;margin:20px}@media print{@page{size:A4 landscape}}</style>
</head><body>
<h2 style="font-size:15px;margin-bottom:4px">${title}</h2>
${driverInfo ? `<p style="font-size:12px;margin:0 0 12px;color:#475569">Autista: ${driverInfo.full_name}${driverInfo.phone ? ` · ${driverInfo.phone}` : ""} · ${readableVehicleLabel}</p>` : ""}
<p style="font-size:11px;color:#94a3b8;margin-bottom:12px">${fmtDate(date)} · ${group.total_pax} pax · ${group.services.length} clienti</p>
<table style="border-collapse:collapse;width:100%"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>
<script>window.print()<\/script></body></html>`;
    const w = window.open("", "_blank", "width=1000,height=600");
    w?.document.write(html);
    w?.document.close();
  };

  // ── Assegna/rimuovi autista a gruppo bus ────────────────────────────────────
  const assignDriver = async (group: DepBusGroup, driverUserId: string) => {
    const token = await getToken();
    if (!token) return;
    setAssignSaving(group.key);
    const vehicleLabel = group.key === "__no_pickup__"
      ? "DEP_BUS:senza orario calcolato"
      : `DEP_BUS:${group.pickup_time} · ${group.boat_co} ${group.boat_t} → ${group.porto_p}`;
    const res = await fetch("/api/ops/departure-bus-assign", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        action: "assign_driver",
        service_ids: group.services.map((s) => s.id),
        driver_user_id: driverUserId,
        vehicle_label: vehicleLabel,
      }),
    });
    const body = await res.json().catch(() => null);
    setAssignSaving(null);
    if (body?.ok) void load(date, direction);
    else setMessage(body?.error ?? "Errore assegnazione.");
  };

  const removeDriver = async (group: DepBusGroup) => {
    const token = await getToken();
    if (!token) return;
    setAssignSaving(group.key);
    await fetch("/api/ops/departure-bus-assign", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "remove_driver", service_ids: group.services.map((s) => s.id) }),
    });
    setAssignSaving(null);
    void load(date, direction);
  };

  // ── Attiva account driver ───────────────────────────────────────────────────
  const activateAccount = async () => {
    if (!activatingDriver || !activateEmail.trim()) return;
    setActivateError("");
    setActivateSaving(true);
    const token = await getToken();
    if (!token) { setActivateSaving(false); return; }
    const res = await fetch("/api/ops/departure-bus-assign", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        action: "create_driver_account",
        driver_profile_id: activatingDriver.profile_id,
        email: activateEmail.trim(),
        phone: activatingDriver.phone ?? "",
      }),
    });
    const body = await res.json().catch(() => null);
    setActivateSaving(false);
    if (body?.ok) {
      setActivatingDriver(null);
      setActivateEmail("");
      void load(date, direction);
    } else {
      setActivateError(body?.error ?? "Errore creazione account.");
    }
  };

  const availablePorts = [...new Set(routing.map((r) => r.port))];

  // Raggruppa run per porto (arrivi)
  const runsByPort = runs.reduce<Record<string, PickupRun[]>>((acc, r) => {
    (acc[r.port] ??= []).push(r);
    return acc;
  }, {});

  // Raggruppa servizi partenza in bus per (pickup_time + boat_co + boat_t + porto_p)
  const depBusGroups = useMemo((): DepBusGroup[] => {
    const map = new Map<string, DepBusGroup>();
    const noPickup: Array<DepartureService & { computed_pickup: string }> = [];

    for (const svc of depServices) {
      const hint = computePickupHint(svc);
      if (!hint) {
        noPickup.push({ ...svc, computed_pickup: "" });
        continue;
      }
      const key = `${hint.pickup}|${hint.boat_co}|${hint.boat_t}|${hint.porto_p}`;
      const existing = map.get(key);
      const entry = { ...svc, computed_pickup: hint.pickup };
      if (existing) {
        existing.services.push(entry);
        existing.total_pax += svc.pax;
      } else {
        map.set(key, {
          key,
          pickup_time: hint.pickup,
          boat_co: hint.boat_co,
          boat_t: hint.boat_t,
          porto_p: hint.porto_p,
          total_pax: svc.pax,
          services: [entry],
          assigned_driver_user_id: null,
          vehicle_label: null,
        });
      }
    }

    // Leggi gli assignments per ogni gruppo (dal primo servizio)
    for (const group of map.values()) {
      const asgn = group.services[0] ? depAssignments.get(group.services[0].id) : undefined;
      group.assigned_driver_user_id = asgn?.driver_user_id ?? null;
      group.vehicle_label = asgn?.vehicle_label ?? null;
    }

    const groups = Array.from(map.values()).sort((a, b) => a.pickup_time.localeCompare(b.pickup_time));

    if (noPickup.length > 0) {
      const noPickupAsgn = noPickup[0] ? depAssignments.get(noPickup[0].id) : undefined;
      groups.push({
        key: "__no_pickup__",
        pickup_time: "99:99",
        boat_co: "",
        boat_t: "",
        porto_p: "",
        total_pax: noPickup.reduce((s, x) => s + x.pax, 0),
        services: noPickup,
        assigned_driver_user_id: noPickupAsgn?.driver_user_id ?? null,
        vehicle_label: noPickupAsgn?.vehicle_label ?? null,
      });
    }

    return groups;
  }, [depServices, depAssignments]);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-6 py-3">
        <DateInput value={date} onChange={(iso) => setDate(iso)}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm" />

        {/* Toggle Arrivi / Partenze */}
        <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-medium">
          <button
            onClick={() => setDirection("arrival")}
            className={`px-4 py-1.5 transition-colors ${direction === "arrival" ? "bg-sky-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
            ⬇ Arrivi
          </button>
          <button
            onClick={() => setDirection("departure")}
            className={`px-4 py-1.5 transition-colors ${direction === "departure" ? "bg-amber-500 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
            ⬆ Partenze
          </button>
        </div>

        {/* Auto-group: solo per arrivi */}
        {direction === "arrival" && (
          <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5">
            <span className="text-xs text-slate-500">Auto:</span>
            <select value={autoPort} onChange={(e) => setAutoPort(e.target.value)}
              className="rounded border-0 bg-transparent text-xs text-slate-700">
              {availablePorts.map((p) => (
                <option key={p} value={p}>{PORT_LABELS[p] ?? p}</option>
              ))}
            </select>
            <button
              onClick={() => void post("auto_group", { port: autoPort })}
              disabled={saving}
              className="rounded bg-violet-600 px-2 py-1 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-40">
              ⚡ Auto
            </button>
          </div>
        )}

        {direction === "arrival" && (
          <div className="ml-auto flex gap-2">
            <button onClick={() => setShowNewRun(true)}
              className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-indigo-700">
              + Blocco manuale
            </button>
          </div>
        )}
      </div>

      {message && (
        <div className="mx-6 mt-2 rounded-lg bg-rose-50 px-4 py-2 text-sm text-rose-700">{message}</div>
      )}

      {/* Lista run / partenze */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
        {loading && <p className="text-sm text-slate-500">Caricamento...</p>}

        {/* Vista PARTENZE — gruppi bus per orario prelevamento */}
        {!loading && direction === "departure" && (
          <>
            {depServices.length === 0 && (
              <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-400">
                <p className="text-lg font-semibold">Nessuna partenza per {fmtDate(date)}</p>
                <p className="mt-1 text-sm">Le partenze compaiono automaticamente dai servizi inseriti.</p>
              </div>
            )}
            {depBusGroups.map((group) => {
              const isNoPickup = group.key === "__no_pickup__";
              const assignedDriver = depDrivers.find((d) => d.user_id === group.assigned_driver_user_id);
              const isSaving = assignSaving === group.key;
              return (
                <div key={group.key}
                  className={`rounded-xl border shadow-sm overflow-hidden ${isNoPickup ? "border-slate-200 bg-slate-50" : "border-l-4 border-amber-400 border-y-slate-200 border-r-slate-200 bg-white"}`}>

                  {/* Header gruppo bus */}
                  <div className="px-4 py-3 border-b border-slate-100">
                    <div className="flex flex-wrap items-center gap-2">
                      {isNoPickup ? (
                        <span className="font-semibold text-slate-500 text-sm">Senza orario prelevamento calcolato</span>
                      ) : (
                        <>
                          <span className="text-base font-black text-amber-600">🕐 {group.pickup_time}</span>
                          <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-800">
                            {group.boat_co} {group.boat_t}
                          </span>
                          <span className="text-sm font-medium text-slate-600">→ {group.porto_p}</span>
                        </>
                      )}
                      <div className="ml-auto flex items-center gap-2">
                        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-700">
                          👥 {group.total_pax}
                        </span>
                        <button
                          onClick={() => printBusGroup(group)}
                          className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">
                          🖨️ Lista
                        </button>
                      </div>
                    </div>

                    {/* Selettore autista */}
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {assignedDriver ? (
                        <>
                          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2">
                            <span className="text-emerald-600 text-sm">🧑‍✈️</span>
                            <div className="min-w-0">
                              <p className="text-sm font-bold text-emerald-800 truncate">{assignedDriver.full_name}</p>
                              {assignedDriver.phone && (
                                <a href={`tel:${assignedDriver.phone}`}
                                  className="text-xs text-emerald-600 hover:underline">
                                  📞 {assignedDriver.phone}
                                </a>
                              )}
                            </div>
                          </div>
                          <button
                            onClick={() => void removeDriver(group)}
                            disabled={isSaving}
                            className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-400 hover:border-rose-300 hover:text-rose-500 disabled:opacity-40">
                            {isSaving ? "..." : "✕"}
                          </button>
                        </>
                      ) : (
                        <select
                          defaultValue=""
                          disabled={isSaving}
                          onChange={(e) => { if (e.target.value) void assignDriver(group, e.target.value); }}
                          className="flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 disabled:opacity-50">
                          <option value="">— Assegna autista —</option>
                          {depDrivers.filter((d) => d.has_account).map((d) => (
                            <option key={d.user_id} value={d.user_id!}>
                              {d.full_name}{d.phone ? ` · ${d.phone}` : ""}
                            </option>
                          ))}
                          {depDrivers.some((d) => !d.has_account) && (
                            <option disabled>── Non attivati ──</option>
                          )}
                          {depDrivers.filter((d) => !d.has_account).map((d) => (
                            <option key={d.profile_id} value="" disabled>
                              {d.full_name} (no account)
                            </option>
                          ))}
                        </select>
                      )}
                    </div>

                    {/* Autisti senza account → pulsante attivazione */}
                    {!assignedDriver && depDrivers.some((d) => !d.has_account) && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {depDrivers.filter((d) => !d.has_account).map((d) => (
                          <button key={d.profile_id}
                            onClick={() => { setActivatingDriver(d); setActivateEmail(""); setActivateError(""); }}
                            className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600 hover:bg-indigo-100 hover:text-indigo-700">
                            Attiva app: {d.full_name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Lista clienti del bus */}
                  <div className="divide-y divide-slate-100">
                    {group.services.map((svc) => {
                      const depTime = svc.departure_time ?? svc.return_time ?? svc.time;
                      const zona = normalizeZonaIschia(svc.hotel_zone);
                      return (
                        <div key={svc.id} className="px-4 py-2.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-bold text-slate-900">{svc.customer_name}</span>
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                              👥 {svc.pax}
                            </span>
                            {depTime && (
                              <span className="text-xs text-slate-400">⛴ {fmtTime(depTime)}</span>
                            )}
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-slate-500">
                            {svc.hotel_name && <span>🏨 {svc.hotel_name}</span>}
                            {svc.hotel_zone && (
                              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600 capitalize">
                                {zona}
                              </span>
                            )}
                            {svc.phone && (
                              <a href={`tel:${svc.phone}`} className="text-indigo-600 hover:underline">📞 {svc.phone}</a>
                            )}
                          </div>
                          {svc.notes && <p className="mt-0.5 text-xs text-slate-400">{svc.notes}</p>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </>
        )}

        {/* Vista ARRIVI (pickup_runs) */}
        {!loading && direction === "arrival" && (
          <>
            {runs.length === 0 && (
              <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-400">
                <p className="text-lg font-semibold">Nessun blocco arrivi per {fmtDate(date)}</p>
                <p className="mt-1 text-sm">
                  I blocchi vengono creati automaticamente quando arrivano le prenotazioni,
                  oppure usa <strong>+ Blocco manuale</strong>.
                </p>
              </div>
            )}
            {Object.entries(runsByPort).map(([port, portRuns]) => (
              <div key={port}>
                <h3 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-500">
                  {PORT_LABELS[port] ?? port} — {portRuns.length} blocc{portRuns.length === 1 ? "o" : "hi"}
                </h3>
                <div className="space-y-4">
                  {portRuns.map((run) => (
                    <PickupRunCard
                      key={run.id}
                      run={run}
                      arrivals={arrivals}
                      buses={buses}
                      passengers={passengers.filter((p) => p.run_id === run.id)}
                      alerts={alertsByRun[run.id] ?? []}
                      vehicles={vehicles}
                      drivers={drivers}
                      routingRules={routing}
                      saving={saving}
                      onPost={post}
                      date={date}
                    />
                  ))}
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Modal attivazione account driver */}
      {activatingDriver && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-6 shadow-2xl">
            <h2 className="text-lg font-bold text-slate-900">Attiva app — {activatingDriver.full_name}</h2>
            <p className="text-sm text-slate-500">
              Crea l&apos;account per permettere all&apos;autista di accedere all&apos;app driver.
              La password iniziale sarà il numero di telefono.
            </p>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Email autista</label>
              <input
                type="email"
                value={activateEmail}
                onChange={(e) => setActivateEmail(e.target.value)}
                placeholder="mario@esempio.com"
                className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
              <span className="font-medium">Password iniziale: </span>
              <span className="font-mono">{activatingDriver.phone ?? "Ischia2025!"}</span>
              <p className="mt-1 text-xs text-slate-400">L&apos;autista dovrà cambiarla al primo accesso.</p>
            </div>
            {activateError && (
              <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{activateError}</p>
            )}
            <div className="flex gap-3">
              <button
                onClick={() => setActivatingDriver(null)}
                className="flex-1 rounded-xl border border-slate-200 py-2.5 text-sm text-slate-600 hover:bg-slate-50">
                Annulla
              </button>
              <button
                onClick={() => void activateAccount()}
                disabled={activateSaving || !activateEmail.trim()}
                className="flex-1 rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-40">
                {activateSaving ? "Creazione..." : "Attiva account"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal nuovo blocco manuale */}
      {showNewRun && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-6 shadow-2xl">
            <h2 className="text-lg font-bold text-slate-900">Nuovo blocco traghetto</h2>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Porto</label>
              <select value={newRunForm.port}
                onChange={(e) => setNewRunForm((f) => ({ ...f, port: e.target.value }))}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <option value="casamicciola">Casamicciola</option>
                <option value="ischia">Ischia Porto</option>
              </select>
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="mb-1 block text-xs font-medium text-slate-600">Apertura finestra</label>
                <input type="time" value={newRunForm.window_open}
                  onChange={(e) => setNewRunForm((f) => ({ ...f, window_open: e.target.value }))}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
              </div>
              <div className="flex-1">
                <label className="mb-1 block text-xs font-medium text-slate-600">Chiusura finestra</label>
                <input type="time" value={newRunForm.window_close}
                  onChange={(e) => setNewRunForm((f) => ({ ...f, window_close: e.target.value }))}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Note (opzionale)</label>
              <input value={newRunForm.notes}
                onChange={(e) => setNewRunForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="es. Medmar 15:00" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            </div>
            <div className="flex gap-3 pt-1">
              <button onClick={() => setShowNewRun(false)}
                className="flex-1 rounded-lg border border-slate-200 py-2 text-sm text-slate-600 hover:bg-slate-50">
                Annulla
              </button>
              <button
                disabled={saving}
                onClick={() => void post("create_run", { ...newRunForm, direction }).then(() => setShowNewRun(false))}
                className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">
                {saving ? "..." : "Crea blocco"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tab Servizi Isola ─────────────────────────────────────────────────────────

function TabServiziIsola() {
  const [services, setServices] = useState<ServiceIschia[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [filterDate, setFilterDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [showNewService, setShowNewService] = useState(false);
  const [showNewDriver, setShowNewDriver] = useState(false);
  const [form, setForm] = useState({
    customer_name: "", customer_phone: "", hotel_partenza_name: "",
    hotel_arrivo_name: "", travel_date: new Date().toISOString().slice(0, 10),
    orario: "", pax: 1, notes: "",
  });
  const [driverForm, setDriverForm] = useState({ name: "", phone: "", vehicle_type: "", capacity: 8 });

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) { setLoading(false); return; }
    const res = await fetch("/api/ops/rete-ischia", { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => null);
    if (body?.ok) {
      setServices(body.services ?? []);
      setDrivers(body.drivers ?? []);
      setHotels(body.hotels ?? []);
    }
    setLoading(false);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const post = useCallback(async (action: string, data: Record<string, unknown>) => {
    const token = await getToken();
    if (!token) return null;
    setSaving(true);
    setMessage("");
    const res = await fetch("/api/ops/rete-ischia", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, ...data }),
    });
    const body = await res.json().catch(() => null);
    setSaving(false);
    if (!res.ok || !body?.ok) { setMessage(body?.error ?? "Errore."); return null; }
    if (body.services) { setServices(body.services); setDrivers(body.drivers); setHotels(body.hotels); }
    return body;
  }, []);

  const createService = useCallback(async () => {
    if (!form.customer_name.trim() || !form.hotel_partenza_name.trim() || !form.hotel_arrivo_name.trim()) return;
    const partenzaHotel = hotels.find((h) => h.name.toLowerCase().includes(form.hotel_partenza_name.toLowerCase()));
    const arrivoHotel = hotels.find((h) => h.name.toLowerCase().includes(form.hotel_arrivo_name.toLowerCase()));
    const result = await post("create_service", {
      customer_name: form.customer_name.trim(),
      customer_phone: form.customer_phone.trim() || null,
      hotel_partenza_name: form.hotel_partenza_name.trim(),
      hotel_arrivo_name: form.hotel_arrivo_name.trim(),
      hotel_partenza_id: partenzaHotel?.id ?? null,
      hotel_arrivo_id: arrivoHotel?.id ?? null,
      travel_date: form.travel_date,
      orario: form.orario.trim() || null,
      pax: form.pax,
      notes: form.notes.trim() || null,
    });
    if (result) {
      setShowNewService(false);
      setForm({ customer_name: "", customer_phone: "", hotel_partenza_name: "", hotel_arrivo_name: "", travel_date: form.travel_date, orario: "", pax: 1, notes: "" });
    }
  }, [form, hotels, post]);

  const createDriver = useCallback(async () => {
    if (!driverForm.name.trim()) return;
    const result = await post("create_driver", {
      name: driverForm.name.trim(),
      phone: driverForm.phone.trim() || null,
      vehicle_type: driverForm.vehicle_type.trim() || null,
      capacity: driverForm.capacity,
    });
    if (result) {
      setShowNewDriver(false);
      setDriverForm({ name: "", phone: "", vehicle_type: "", capacity: 8 });
    }
  }, [driverForm, post]);

  const filteredServices = services.filter((s) => {
    if (filterStatus !== "all" && s.status !== filterStatus) return false;
    if (filterDate && s.travel_date !== filterDate) return false;
    return true;
  });

  if (loading) return <div className="p-8 text-slate-500">Caricamento...</div>;

  return (
    <div className="flex flex-col h-full">
      {message && (
        <div className="mx-6 mb-0 mt-2 rounded-lg bg-rose-50 px-4 py-2 text-sm text-rose-700">{message}</div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-6 py-3">
        <DateInput value={filterDate} onChange={(iso) => setFilterDate(iso)}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm" />
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-700">
          <option value="all">Tutti gli stati</option>
          <option value="pending">Da assegnare</option>
          <option value="assigned">Assegnati</option>
          <option value="completed">Completati</option>
          <option value="cancelled">Annullati</option>
        </select>
        <div className="ml-auto flex gap-2">
          <button onClick={() => setShowNewDriver(true)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">
            + Autista
          </button>
          <button onClick={() => setShowNewService(true)}
            className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-indigo-700">
            + Servizio
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Servizi */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            {filteredServices.length} servizi · {filterDate ? fmtDate(filterDate) : "tutte le date"}
          </p>

          {filteredServices.length === 0 && (
            <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-400">
              Nessun servizio. Clicca <strong>+ Servizio</strong> per aggiungerne uno.
            </div>
          )}

          {filteredServices.map((svc) => {
            const driver = drivers.find((d) => d.id === svc.driver_id) ?? null;
            return (
              <div key={svc.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-start gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold uppercase text-slate-900">{svc.customer_name}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[svc.status]}`}>
                        {STATUS_LABELS[svc.status]}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-sm text-slate-600">
                      <span>🏨 {svc.hotel_partenza_name} → {svc.hotel_arrivo_name}</span>
                      <span>📅 {fmtDate(svc.travel_date)}{svc.orario ? ` · ${svc.orario}` : ""}</span>
                      <span>👥 {svc.pax} pax</span>
                      {svc.customer_phone && <span>📞 {svc.customer_phone}</span>}
                    </div>
                    {svc.notes && <div className="mt-0.5 text-xs text-slate-400">{svc.notes}</div>}
                  </div>
                  <div className="flex flex-shrink-0 flex-col items-end gap-2">
                    <select
                      value={svc.driver_id ?? ""}
                      disabled={saving || svc.status === "completed" || svc.status === "cancelled"}
                      onChange={(e) => void post("assign_driver", { service_id: svc.id, driver_id: e.target.value || null })}
                      className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700 disabled:opacity-50">
                      <option value="">— Assegna autista —</option>
                      {drivers.map((d) => (
                        <option key={d.id} value={d.id}>{d.name}{d.vehicle_type ? ` (${d.vehicle_type})` : ""}</option>
                      ))}
                    </select>
                    <div className="flex gap-1">
                      {svc.status === "assigned" && (
                        <button onClick={() => void post("update_status", { service_id: svc.id, status: "completed" })}
                          disabled={saving}
                          className="rounded border border-emerald-200 px-2 py-0.5 text-xs text-emerald-700 hover:bg-emerald-50">
                          ✓ Completato
                        </button>
                      )}
                      {svc.status !== "cancelled" && svc.status !== "completed" && (
                        <button onClick={() => void post("update_status", { service_id: svc.id, status: "cancelled" })}
                          disabled={saving}
                          className="rounded border border-rose-200 px-2 py-0.5 text-xs text-rose-600 hover:bg-rose-50">
                          Annulla
                        </button>
                      )}
                      <button onClick={() => void post("delete_service", { service_id: svc.id })}
                        disabled={saving}
                        className="rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-400 hover:border-rose-300 hover:text-rose-500">
                        ✕
                      </button>
                    </div>
                    {driver && (
                      <div className="text-right text-xs text-slate-500">
                        🚗 {driver.name}{driver.phone ? ` · ${driver.phone}` : ""}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Sidebar autisti */}
        <div className="w-56 flex-shrink-0 overflow-y-auto border-l border-slate-200 bg-slate-50 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Autisti ({drivers.length})</p>
          {drivers.length === 0 && <p className="text-xs text-slate-400">Nessun autista.</p>}
          {drivers.map((d) => {
            const today = services.filter((s) => s.driver_id === d.id && s.travel_date === filterDate && s.status === "assigned");
            return (
              <div key={d.id} className="mb-2 rounded-lg bg-white border border-slate-200 px-3 py-2">
                <div className="font-medium text-slate-800">{d.name}</div>
                {d.vehicle_type && <div className="text-xs text-slate-400">{d.vehicle_type} · {d.capacity} pax</div>}
                {d.phone && <div className="text-xs text-slate-400">{d.phone}</div>}
                {today.length > 0 && (
                  <div className="mt-1 text-xs font-medium text-emerald-600">{today.length} servizi oggi</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Modal: nuovo servizio */}
      {showNewService && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md space-y-3 rounded-2xl bg-white p-6 shadow-2xl">
            <h2 className="text-lg font-bold text-slate-900">Nuovo servizio Ischia</h2>
            <input value={form.customer_name} onChange={(e) => setForm((f) => ({ ...f, customer_name: e.target.value }))}
              placeholder="Nome cliente *" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <input value={form.customer_phone} onChange={(e) => setForm((f) => ({ ...f, customer_phone: e.target.value }))}
              placeholder="Telefono" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <input value={form.hotel_partenza_name} onChange={(e) => setForm((f) => ({ ...f, hotel_partenza_name: e.target.value }))}
              placeholder="Hotel partenza *" list="hotels-list" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <input value={form.hotel_arrivo_name} onChange={(e) => setForm((f) => ({ ...f, hotel_arrivo_name: e.target.value }))}
              placeholder="Hotel arrivo *" list="hotels-list" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <datalist id="hotels-list">
              {hotels.map((h) => <option key={h.id} value={h.name} />)}
            </datalist>
            <div className="flex gap-2">
              <DateInput value={form.travel_date} onChange={(iso) => setForm((f) => ({ ...f, travel_date: iso }))}
                className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
              <input type="time" value={form.orario} onChange={(e) => setForm((f) => ({ ...f, orario: e.target.value }))}
                className="w-28 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
              <input type="number" value={form.pax} min={1} max={60} onChange={(e) => setForm((f) => ({ ...f, pax: parseInt(e.target.value) || 1 }))}
                placeholder="Pax" className="w-16 rounded-lg border border-slate-200 px-3 py-2 text-sm text-center" />
            </div>
            <textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="Note" rows={2} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <div className="flex gap-3 pt-1">
              <button onClick={() => setShowNewService(false)} className="flex-1 rounded-lg border border-slate-200 py-2 text-sm text-slate-600 hover:bg-slate-50">Annulla</button>
              <button onClick={() => void createService()} disabled={saving || !form.customer_name.trim()}
                className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">
                {saving ? "..." : "Crea servizio"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: nuovo autista */}
      {showNewDriver && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-6 shadow-2xl">
            <h2 className="text-lg font-bold text-slate-900">Nuovo autista</h2>
            <input value={driverForm.name} onChange={(e) => setDriverForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Nome *" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <input value={driverForm.phone} onChange={(e) => setDriverForm((f) => ({ ...f, phone: e.target.value }))}
              placeholder="Telefono" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <input value={driverForm.vehicle_type} onChange={(e) => setDriverForm((f) => ({ ...f, vehicle_type: e.target.value }))}
              placeholder="Tipo veicolo" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <input type="number" value={driverForm.capacity} min={1} max={60} onChange={(e) => setDriverForm((f) => ({ ...f, capacity: parseInt(e.target.value) || 8 }))}
              placeholder="Capienza" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <div className="flex gap-3 pt-1">
              <button onClick={() => setShowNewDriver(false)} className="flex-1 rounded-lg border border-slate-200 py-2 text-sm text-slate-600 hover:bg-slate-50">Annulla</button>
              <button onClick={() => void createDriver()} disabled={saving || !driverForm.name.trim()}
                className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">
                {saving ? "..." : "Aggiungi autista"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Pagina principale ─────────────────────────────────────────────────────────

type Tab = "corse-porto" | "servizi-isola";

export default function ReteIschiaPage() {
  const [activeTab, setActiveTab] = useState<Tab>("corse-porto");

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Transfer Ischia" subtitle="Corse porto e servizi interni all'isola" />

      {/* Tab bar */}
      <div className="flex border-b border-slate-200 bg-white px-6">
        {(
          [
            { key: "corse-porto", label: "Transfer Ischia", icon: "⛴" },
            { key: "servizi-isola", label: "Servizi Isola", icon: "🏨" },
          ] as const
        ).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-1.5 border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === tab.key
                ? "border-indigo-600 text-indigo-700"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}>
            <span>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-hidden">
        {activeTab === "corse-porto" ? <TabCorsePorto /> : <TabServiziIsola />}
      </div>
    </div>
  );
}
