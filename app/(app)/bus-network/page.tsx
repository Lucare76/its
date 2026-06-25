"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DateInput, PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import BusImportModal from "./BusImportModal";

function FerryIcon({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      {/* Hull */}
      <path d="M3 14 L5 19 L19 19 L21 14 Z" fill="#1d4ed8" />
      {/* Deck */}
      <rect x="5" y="10" width="14" height="4" rx="1" fill="#2563eb" />
      {/* Cabin */}
      <rect x="8" y="6" width="8" height="4" rx="1" fill="#60a5fa" />
      {/* Windows cabin */}
      <rect x="9.5" y="7" width="2" height="2" rx="0.5" fill="white" opacity="0.9" />
      <rect x="12.5" y="7" width="2" height="2" rx="0.5" fill="white" opacity="0.9" />
      {/* Chimney */}
      <rect x="13" y="3" width="2" height="3" rx="0.5" fill="#f97316" />
      {/* Smoke */}
      <circle cx="14" cy="2.5" r="0.8" fill="#94a3b8" opacity="0.6" />
      {/* Water waves */}
      <path d="M2 21 Q5 20 8 21 Q11 22 14 21 Q17 20 20 21 Q22 21.5 23 21" stroke="#93c5fd" strokeWidth="1.2" strokeLinecap="round" fill="none" />
    </svg>
  );
}

type BusLine = { id: string; code: string; name: string; family_code: string; family_name: string; variant_label?: string | null };
type BusStop = { id: string; bus_line_id: string; direction: "arrival" | "departure"; stop_name: string; city: string; pickup_note?: string | null; pickup_time?: string | null; stop_order: number; is_manual: boolean; lat?: number | null; lng?: number | null };
type BusUnit = { id: string; bus_line_id: string; label: string; capacity: number; low_seat_threshold: number; minimum_passengers?: number | null; status: "open" | "low" | "closed" | "completed"; manual_close: boolean; close_reason?: string | null; driver_name_outbound?: string | null; driver_phone_outbound?: string | null; driver_name_return?: string | null; driver_phone_return?: string | null; tag?: "gruppi" | "esclusivo" | null; group_name?: string | null };
type BusAllocation = { id: string; service_id: string; bus_line_id: string; bus_unit_id: string; stop_id?: string | null; stop_name: string; direction: "arrival" | "departure"; pax_assigned: number };
type BusMove = { id: string; service_id: string; from_bus_unit_id?: string | null; to_bus_unit_id?: string | null; stop_name?: string | null; pax_moved: number; reason?: string | null; created_at: string; customer_name?: string | null; customer_phone?: string | null; hotel_name?: string | null; source_bus_label?: string | null; target_bus_label?: string | null; moved_full_allocation?: boolean };
type AllocationDetail = { allocation_id: string; root_allocation_id: string; split_from_allocation_id?: string | null; service_id: string; bus_line_id: string; line_code: string; line_name: string; family_code: string; family_name: string; bus_unit_id: string; bus_label: string; stop_id?: string | null; stop_name: string; stop_city?: string | null; stop_pickup_note?: string | null; stop_pickup_time?: string | null; hotel_pickup_time?: string | null; direction: "arrival" | "departure"; pax_assigned: number; service_date: string; service_time: string; customer_name: string; customer_phone?: string | null; hotel_id?: string | null; hotel_name?: string | null; agency_name?: string | null; notes?: string | null; created_at?: string };
type BusService = { id: string; customer_name: string; customer_display_name: string; date: string; time: string; pax: number; direction: "arrival" | "departure"; bus_city_origin?: string | null; transport_code?: string | null; phone_display: string; hotel_name: string; hotel_zone?: string | null; derived_family_code: string; derived_family_name: string; derived_line_code?: string | null; derived_line_name?: string | null; suggested_stop_name?: string | null };
type UnitLoad = BusUnit & { pax_assigned: number; remaining_seats: number; suggested_status: string };
type StopLoad = BusStop & { pax_assigned: number };
type PendingPassenger = { id: string; bus_line_id: string; direction: "arrival" | "departure"; travel_date: string; passenger_name: string; passenger_phone: string | null; city_original: string; pax: number; notes: string | null; geo_suggested_stop: string | null; created_at: string };
type IschiaDistBus = { id: string; date: string; bus_line_id: string | null; label: string; zone: string; capacity: number; driver_name: string | null; driver_phone: string | null; driver_profile_id: string | null; vehicle_id: string | null; sort_order: number; section?: "ischia" | "pozzuoli" };
type BusLineFerryConfig = { id: string; bus_line_family_code: string; departure_port: string; arrival_port: string; departure_time: string; line_color: string; line_label: string; sort_order: number };
type IschiaDistAllocation = { id: string; dist_bus_id: string; service_id: string; pax_assigned: number; customer_name: string; hotel_name: string; hotel_zone: string; stop_order: number };
type IschiaDistVehicle = { id: string; label: string; plate: string; capacity: number };
type IschiaDistDriver = { id: string; full_name: string; phone: string | null };
type HotelListItem = { id: string; name: string; zone: string };
type ApiPayload = { lines: BusLine[]; stops: BusStop[]; units: BusUnit[]; allocations: BusAllocation[]; allocation_details: AllocationDetail[]; moves: BusMove[]; services: BusService[]; unit_loads: UnitLoad[]; stop_loads: StopLoad[]; redistribution_suggestions: Array<{ source_label: string; target_label: string | null; reason: string }>; geographic_suggestions: Array<{ service_id: string; customer_name: string; stop_name: string; grouped_zone: string; suggested_vehicle_type: string; suggested_stop_order: number | null }>; arrival_windows: Array<{ time: string; totalPax: number; snavPax: number; medmarPax: number; otherPax: number }>; pending_passengers: PendingPassenger[]; ischia_dist_buses: IschiaDistBus[]; pozzuoli_dist_buses: IschiaDistBus[]; ischia_dist_allocations: IschiaDistAllocation[]; ischia_dist_vehicles: IschiaDistVehicle[]; ischia_dist_drivers: IschiaDistDriver[]; hotels_list: HotelListItem[]; bus_line_ferry_config: BusLineFerryConfig[]; user_role?: string };

const emptyPayload: ApiPayload = { lines: [], stops: [], units: [], allocations: [], allocation_details: [], moves: [], services: [], unit_loads: [], stop_loads: [], redistribution_suggestions: [], geographic_suggestions: [], arrival_windows: [], pending_passengers: [], ischia_dist_buses: [], pozzuoli_dist_buses: [], ischia_dist_allocations: [], ischia_dist_vehicles: [], ischia_dist_drivers: [], hotels_list: [], bus_line_ferry_config: [], user_role: undefined };

async function getToken() {
  if (!hasSupabaseEnv || !supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

function getNextSunday(from?: Date): string {
  const d = from ? new Date(from) : new Date();
  const day = d.getDay();
  const add = day === 0 ? 0 : 7 - day;
  d.setDate(d.getDate() + add);
  return d.toISOString().slice(0, 10);
}

function shiftSunday(iso: string, weeks: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + weeks * 7);
  return d.toISOString().slice(0, 10);
}

function fmtDate(iso: string): string {
  return new Date(iso + "T12:00:00").toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function isValidClockTime(value: string) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value.trim());
}

function InlineCityEdit({ serviceId, currentCity, onSave, saving }: { serviceId: string; currentCity: string; onSave: (city: string) => Promise<unknown>; saving: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentCity);
  const [localSaving, setLocalSaving] = useState(false);

  useEffect(() => { setValue(currentCity); }, [currentCity]);

  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed.toUpperCase() === currentCity.toUpperCase()) { setEditing(false); return; }
    setLocalSaving(true);
    await onSave(trimmed);
    setLocalSaving(false);
    setEditing(false);
  };

  if (editing) {
    return (
      <span className="ml-2 inline-flex items-center gap-1">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(false); }}
          autoFocus
          disabled={localSaving || saving}
          placeholder="Città..."
          className="w-28 rounded border border-indigo-300 px-1.5 py-0.5 text-xs uppercase focus:outline-none focus:ring-1 focus:ring-indigo-400"
        />
        <button onClick={() => void save()} disabled={localSaving || saving} className="text-xs text-indigo-600 hover:text-indigo-800">✓</button>
        <button onClick={() => { setEditing(false); setValue(currentCity); }} className="text-xs text-slate-400 hover:text-slate-600">✕</button>
      </span>
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      title={currentCity ? "Modifica città" : "Aggiungi città"}
      className={`ml-2 text-xs ${currentCity ? "text-slate-400 hover:text-indigo-600" : "text-indigo-500 hover:text-indigo-700 font-medium"}`}
    >
      {currentCity ? `· ${currentCity} ✎` : "+ città"}
    </button>
  );
}

export default function BusNetworkPage() {
  const [payload, setPayload] = useState<ApiPayload>(emptyPayload);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [lowSeatAlert, setLowSeatAlert] = useState<{ busLabel: string; lineName: string; remainingSeats: number } | null>(null);

  // Navigation
  const [date, setDate] = useState(() => getNextSunday());
  const [direction, setDirection] = useState<"arrival" | "departure">("arrival");
  const [selectedLineId, setSelectedLineId] = useState("");

  // Move modal
  const [moveSource, setMoveSource] = useState<AllocationDetail | null>(null);
  const [moveTargetUnitId, setMoveTargetUnitId] = useState("");
  const [movePaxStr, setMovePaxStr] = useState("1");
  const [moveReason, setMoveReason] = useState("");
  const [moveModalOpen, setMoveModalOpen] = useState(false);

  // Assign modal
  const [assignService, setAssignService] = useState<BusService | null>(null);
  const [assignLineId, setAssignLineId] = useState("");
  const [assignUnitId, setAssignUnitId] = useState("");
  const [assignStopId, setAssignStopId] = useState("");
  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [assignCreatingStop, setAssignCreatingStop] = useState(false);

  // Modifica nome linea
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [editingLineName, setEditingLineName] = useState("");

  // Stop manager
  const [showStopManager, setShowStopManager] = useState(false);
  const [hideEmptyStops, setHideEmptyStops] = useState(false);
  const [newStopName, setNewStopName] = useState("");
  const [newStopCity, setNewStopCity] = useState("");
  const [newStopPickupTime, setNewStopPickupTime] = useState("");
  const [newUnitLabel, setNewUnitLabel] = useState("");
  const [dragOverUnitId, setDragOverUnitId] = useState("");

  // Driver editing
  const [editDriverUnitId, setEditDriverUnitId] = useState("");
  const [editDriverName, setEditDriverName] = useState("");
  const [editDriverPhone, setEditDriverPhone] = useState("");

  // Delete allocation confirm
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // Reset line/date modal
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [resetResult, setResetResult] = useState<{ allocations: number; services: number } | null>(null);

  // Auto-assign
  const [autoAssignResult, setAutoAssignResult] = useState<{ assigned: number; skipped: number; skipped_detail: Array<{ customerName: string; reason: string }> } | null>(null);

  // Import modal
  const [importModalOpen, setImportModalOpen] = useState(false);

  // Tab: "bus" | "da_validare"
  const [activeTab, setActiveTab] = useState<"bus" | "da_validare">("bus");

  // Route strip
  const [showRouteStrip, setShowRouteStrip] = useState(true);
  const [selectedBusUnitId, setSelectedBusUnitId] = useState<string | null>(null);

  // Editable bus label
  const [editLabelUnitId, setEditLabelUnitId] = useState<string | null>(null);
  const [editLabelValue, setEditLabelValue] = useState("");
  const [editCapUnitId, setEditCapUnitId] = useState<string | null>(null);
  const [editCapValue, setEditCapValue] = useState("");
  const [editGroupNameUnitId, setEditGroupNameUnitId] = useState<string | null>(null);
  const [editGroupNameValue, setEditGroupNameValue] = useState("");

  // Editable pax per allocation
  const [editPaxAllocId, setEditPaxAllocId] = useState<string | null>(null);
  const [editPaxValue, setEditPaxValue] = useState("");
  const [editCardHotelId, setEditCardHotelId] = useState<string | null>(null);
  const [editCardHotelValue, setEditCardHotelValue] = useState(""); // hotel_id
  const [editCardHotelSearch, setEditCardHotelSearch] = useState(""); // testo ricerca
  const [editCardPhoneId, setEditCardPhoneId] = useState<string | null>(null);
  const [editCardPhoneValue, setEditCardPhoneValue] = useState("");

  // Edit stop inline (nome e orario)
  const [editStopTimeId, setEditStopTimeId] = useState<string | null>(null);
  const [editStopTimeValue, setEditStopTimeValue] = useState("");
  const [editStopNameId, setEditStopNameId] = useState<string | null>(null);
  const [editStopNameValue, setEditStopNameValue] = useState("");

  // Geo sort progress
  const [geoSorting, setGeoSorting] = useState(false);

  // Distribuzione Ischia
  const [dragDistAllocId, setDragDistAllocId] = useState<string | null>(null);
  const [dragOverDistBusId, setDragOverDistBusId] = useState<string | null>(null);
  const [dragReorderTargetId, setDragReorderTargetId] = useState<string | null>(null);
  const [editDistBusId, setEditDistBusId] = useState<string | null>(null);
  const [distDriverQuery, setDistDriverQuery] = useState("");
  const [distDriverPhone, setDistDriverPhone] = useState("");
  const [distVehicleId, setDistVehicleId] = useState("");
  // Hotel edit inline
  const [editHotelAllocId, setEditHotelAllocId] = useState<string | null>(null);
  const [hotelSearchQuery, setHotelSearchQuery] = useState("");
  const [newHotelForm, setNewHotelForm] = useState<{ name: string; address: string; zone: string } | null>(null);
  // Conferma re-smistamento
  const [smistamentoConfirm, setSmistamentoConfirm] = useState(false);

  // Approve pending modal
  const [approvePending, setApprovePending] = useState<PendingPassenger | null>(null);
  const [approveUnitId, setApproveUnitId] = useState("");
  const [approveStopId, setApproveStopId] = useState("");

  // Create new stop from pending approval
  const [pendingNewStop, setPendingNewStop] = useState<{ name: string; city: string; note: string; afterStopId: string } | null>(null);

  // Transfer to another line modal (admin only)
  const [transferAlloc, setTransferAlloc] = useState<AllocationDetail | null>(null);
  const [transferLineId, setTransferLineId] = useState("");
  const [transferUnitId, setTransferUnitId] = useState("");
  const [transferStopId, setTransferStopId] = useState("");
  const [transferCreatingStop, setTransferCreatingStop] = useState(false);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) { setLoading(false); setMessage("Sessione non valida."); return; }
    const res = await fetch(`/api/ops/bus-network?date=${date}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await res.json().catch(() => null)) as ({ ok?: boolean; error?: string } & Partial<ApiPayload>) | null;
    if (!res.ok || !body?.ok) { setLoading(false); setMessage(body?.error ?? "Errore caricamento rete bus."); return; }
    const next: ApiPayload = {
      lines: body.lines ?? [], stops: body.stops ?? [], units: body.units ?? [],
      allocations: body.allocations ?? [], allocation_details: body.allocation_details ?? [],
      moves: body.moves ?? [], services: body.services ?? [],
      unit_loads: body.unit_loads ?? [], stop_loads: body.stop_loads ?? [],
      redistribution_suggestions: body.redistribution_suggestions ?? [],
      geographic_suggestions: body.geographic_suggestions ?? [],
      arrival_windows: body.arrival_windows ?? [],
      pending_passengers: body.pending_passengers ?? [],
      ischia_dist_buses: body.ischia_dist_buses ?? [],
      pozzuoli_dist_buses: body.pozzuoli_dist_buses ?? [],
      ischia_dist_allocations: body.ischia_dist_allocations ?? [],
      ischia_dist_vehicles: body.ischia_dist_vehicles ?? [],
      ischia_dist_drivers: body.ischia_dist_drivers ?? [],
      hotels_list: body.hotels_list ?? [],
      bus_line_ferry_config: body.bus_line_ferry_config ?? [],
      user_role: (body as { user_role?: string }).user_role ?? undefined,
    };
    setPayload(next);
    setSelectedLineId((cur) => (cur && next.lines.some((l) => l.id === cur)) ? cur : (next.lines[0]?.id ?? ""));
    setLoading(false);
  }, [date]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setSelectedBusUnitId(null); }, [selectedLineId, date, direction]);

  const applyPayload = useCallback((body: Partial<ApiPayload>) => {
    const next: ApiPayload = {
      lines: body.lines ?? [],
      stops: body.stops ?? [],
      units: body.units ?? [],
      allocations: body.allocations ?? [],
      allocation_details: body.allocation_details ?? [],
      moves: body.moves ?? [],
      services: body.services ?? [],
      unit_loads: body.unit_loads ?? [],
      stop_loads: body.stop_loads ?? [],
      redistribution_suggestions: body.redistribution_suggestions ?? [],
      geographic_suggestions: body.geographic_suggestions ?? [],
      arrival_windows: body.arrival_windows ?? [],
      pending_passengers: body.pending_passengers ?? [],
      ischia_dist_buses: body.ischia_dist_buses ?? [],
      pozzuoli_dist_buses: body.pozzuoli_dist_buses ?? [],
      ischia_dist_allocations: body.ischia_dist_allocations ?? [],
      ischia_dist_vehicles: body.ischia_dist_vehicles ?? [],
      ischia_dist_drivers: body.ischia_dist_drivers ?? [],
      hotels_list: body.hotels_list ?? [],
      bus_line_ferry_config: body.bus_line_ferry_config ?? [],
      user_role: body.user_role,
    };
    setPayload(next);
    setSelectedLineId((cur) => (cur && next.lines.some((l) => l.id === cur)) ? cur : (next.lines[0]?.id ?? ""));
  }, []);

  const post = useCallback(async (action: string, data: Record<string, unknown>) => {
    const token = await getToken();
    if (!token) return null;
    setSaving(true);
    setMessage("");
    const res = await fetch("/api/ops/bus-network", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, ...data })
    });
    const body = (await res.json().catch(() => null)) as ({ ok?: boolean; error?: string; low_seat_alert?: { busLabel: string; lineName: string; remainingSeats: number } | null } & Partial<ApiPayload>) | null;
    setSaving(false);
    if (!res.ok || !body?.ok) { setMessage(body?.error ?? "Errore operazione."); return null; }
    if (body?.low_seat_alert) setLowSeatAlert(body.low_seat_alert);
    // Aggiorna lo stato direttamente dalla risposta POST (evita un secondo GET che può tornare con dati vecchi)
    if (body?.lines !== undefined) {
      applyPayload(body);
    } else {
      await load();
    }
    return body;
  }, [load, applyPayload]);

  const saveLineName = useCallback(async (lineId: string, name: string) => {
    if (!name.trim()) return;
    await post("update_line_name", { line_id: lineId, name: name.trim() });
    setEditingLineId(null);
  }, [post]);

  // --- Derived data ---
  const isAdmin = payload.user_role === "admin" || payload.user_role === "supervisor" || payload.user_role === "operator";
  const selectedLine = payload.lines.find((l) => l.id === selectedLineId) ?? null;

  const lineUnits = useMemo(
    () => payload.unit_loads.filter((u) => u.bus_line_id === selectedLine?.id),
    [payload.unit_loads, selectedLine]
  );

  const lineStops = useMemo(
    () => {
      const filtered = payload.stops.filter(
        (s) => s.bus_line_id === selectedLine?.id && s.direction === direction
      );
      if (direction === "departure") {
        // Ritorno: ordina per latitudine crescente (sud→nord). Fallback su stop_order se lat mancante.
        return [...filtered].sort((a, b) => {
          if (a.lat != null && b.lat != null) return a.lat - b.lat;
          if (a.lat != null) return -1;
          if (b.lat != null) return 1;
          return a.stop_order - b.stop_order;
        });
      }
      // Andata: nord→sud = lat decrescente (o stop_order crescente come prima)
      return [...filtered].sort((a, b) => a.stop_order - b.stop_order);
    },
    [payload.stops, selectedLine, direction]
  );

  // Allocations for this date + direction + line — TUTTE (per calcoli capacità e card)
  const allDateAllocations = useMemo(
    () => payload.allocation_details.filter(
      (a) => a.bus_line_id === selectedLine?.id && a.service_date === date && a.direction === direction
    ),
    [payload.allocation_details, selectedLine, date, direction]
  );

  // Allocations filtrate per bus selezionato (per vista fermate/percorso)
  const dateAllocations = useMemo(
    () => selectedBusUnitId
      ? allDateAllocations.filter((a) => a.bus_unit_id === selectedBusUnitId)
      : allDateAllocations,
    [allDateAllocations, selectedBusUnitId]
  );

  // Stops WITH passengers today, ordered correctly
  const activeStopNames = useMemo(() => {
    const names = new Set<string>();
    for (const a of dateAllocations) names.add(a.stop_name);
    return names;
  }, [dateAllocations]);

  const activeStops = useMemo(
    () => lineStops.filter((s) => activeStopNames.has(s.stop_name)),
    [lineStops, activeStopNames]
  );

  // Unassigned services for this date + direction + line family
  const allocatedServiceIds = useMemo(
    () => new Set(payload.allocations.map((a) => a.service_id)),
    [payload.allocations]
  );

  const unassigned = useMemo(
    () => payload.services.filter(
      (s) => s.date === date && s.direction === direction &&
        s.derived_family_code === selectedLine?.family_code &&
        !allocatedServiceIds.has(s.id)
    ),
    [payload.services, date, direction, selectedLine, allocatedServiceIds]
  );

  // Per-unit loads filtered by date — usa TUTTE le allocazioni (non filtrate per bus selezionato)
  const dateUnitLoads = useMemo(
    () => lineUnits.map((unit) => {
      const datePax = allDateAllocations
        .filter((a) => a.bus_unit_id === unit.id)
        .reduce((sum, a) => sum + a.pax_assigned, 0);
      return { ...unit, pax_assigned: datePax, remaining_seats: Math.max(0, unit.capacity - datePax) };
    }),
    [lineUnits, allDateAllocations]
  );

  // Bus cards — usa TUTTE le allocazioni per mostrare pax corretti su ogni card
  const busCards = useMemo(
    () => dateUnitLoads.map((unit) => ({
      unit,
      allocations: allDateAllocations.filter((a) => a.bus_unit_id === unit.id)
    })),
    [dateUnitLoads, allDateAllocations]
  );

  // Ferry config della linea selezionata (per colorare le bus card)
  const selectedLineFerryConfig = useMemo(
    () => payload.bus_line_ferry_config.find(
      (c) => c.bus_line_family_code.toLowerCase() === (selectedLine?.family_code ?? "").toLowerCase()
    ) ?? null,
    [payload.bus_line_ferry_config, selectedLine]
  );

  // Line summary for sidebar
  const lineSummary = useMemo(() => payload.lines.map((line) => {
    const paxToday = payload.allocation_details
      .filter((a) => a.bus_line_id === line.id && a.service_date === date && a.direction === direction)
      .reduce((sum, a) => sum + a.pax_assigned, 0);
    const unassignedToday = payload.services.filter(
      (s) => s.date === date && s.direction === direction &&
        s.derived_family_code === line.family_code &&
        !allocatedServiceIds.has(s.id)
    ).length;
    const totalCapacity = payload.units
      .filter((u) => u.bus_line_id === line.id && u.status !== "closed" && u.status !== "completed")
      .reduce((sum, u) => sum + u.capacity, 0);
    return { ...line, paxToday, unassignedToday, totalCapacity };
  }), [payload.lines, payload.allocation_details, payload.services, payload.units, date, direction, allocatedServiceIds]);

  const totalPaxToday = dateAllocations.reduce((sum, a) => sum + a.pax_assigned, 0);

  // Derived data for transfer modal
  const transferTargetStops = useMemo(
    () => payload.stops.filter((s) => s.bus_line_id === transferLineId && s.direction === direction).sort((a, b) => a.stop_order - b.stop_order),
    [payload.stops, transferLineId, direction]
  );
  const transferTargetUnits = useMemo(
    () => payload.units.filter((u) => u.bus_line_id === transferLineId && u.status !== "closed" && u.status !== "completed"),
    [payload.units, transferLineId]
  );
  const transferStopMissing = useMemo(() => {
    if (!transferAlloc || !transferLineId) return false;
    const sourceStop = transferAlloc.stop_name?.toUpperCase().trim();
    if (!sourceStop) return false;
    return !transferTargetStops.some((s) => s.stop_name.toUpperCase().trim() === sourceStop);
  }, [transferAlloc, transferLineId, transferTargetStops]);

  // --- Actions ---
  const openTransferModal = useCallback((alloc: AllocationDetail) => {
    setTransferAlloc(alloc);
    setTransferCreatingStop(false);
    const otherLines = payload.lines.filter((l) => l.id !== alloc.bus_line_id);
    const firstLine = otherLines[0];
    const firstLineId = firstLine?.id ?? "";
    setTransferLineId(firstLineId);
    const firstStop = payload.stops.find((s) => s.bus_line_id === firstLineId && s.direction === direction);
    setTransferStopId(firstStop?.id ?? "");
    const firstUnit = payload.units.find((u) => u.bus_line_id === firstLineId && u.status !== "closed" && u.status !== "completed");
    setTransferUnitId(firstUnit?.id ?? "");
  }, [payload.lines, payload.stops, payload.units, direction]);

  const createStopForTransfer = useCallback(async () => {
    if (!transferAlloc || !transferLineId) return;
    setTransferCreatingStop(true);
    const result = await post("create_stop_for_transfer", {
      bus_line_id: transferLineId,
      stop_name: transferAlloc.stop_name,
      direction,
    }) as { stop_id?: string } | null;
    setTransferCreatingStop(false);
    if (result?.stop_id) {
      setTransferStopId(result.stop_id);
    }
  }, [transferAlloc, transferLineId, direction, post]);

  const confirmTransfer = useCallback(async () => {
    if (!transferAlloc || !transferLineId || !transferUnitId || !transferStopId) return;
    await post("transfer_allocation_line", {
      allocation_id: transferAlloc.allocation_id,
      target_bus_line_id: transferLineId,
      target_bus_unit_id: transferUnitId,
      target_stop_id: transferStopId,
    });
    setTransferAlloc(null);
  }, [transferAlloc, transferLineId, transferUnitId, transferStopId, post]);

  const openMoveModal = useCallback((alloc: AllocationDetail) => {
    setMoveSource(alloc);
    setMovePaxStr(String(alloc.pax_assigned));
    setMoveReason("");
    const compatible = dateUnitLoads.filter((u) => u.id !== alloc.bus_unit_id && u.status !== "closed" && u.status !== "completed");
    setMoveTargetUnitId(compatible[0]?.id ?? "");
    setMoveModalOpen(true);
  }, [dateUnitLoads]);

  const assignLineStops = useMemo(
    () => payload.stops.filter((s) => s.bus_line_id === assignLineId && s.direction === direction).sort((a, b) => a.stop_order - b.stop_order),
    [payload.stops, assignLineId, direction]
  );
  const assignLineUnits = useMemo(
    () => {
      const units = payload.units.filter((u) => u.bus_line_id === assignLineId && u.status !== "closed" && u.status !== "completed");
      if (!date) return units.map(u => ({ ...u, pax_assigned: 0, remaining_seats: u.capacity }));
      return units.map(u => {
        const datePax = payload.allocation_details
          .filter(a => a.bus_unit_id === u.id && a.service_date === date && a.direction === direction)
          .reduce((sum, a) => sum + a.pax_assigned, 0);
        return { ...u, pax_assigned: datePax, remaining_seats: Math.max(0, u.capacity - datePax) };
      });
    },
    [payload.units, payload.allocation_details, assignLineId, date, direction]
  );
  const assignStopMissing = useMemo(() => {
    if (!assignService || !assignLineId || assignLineId === selectedLineId) return false;
    const city = (assignService.bus_city_origin ?? "").toUpperCase().trim();
    if (!city) return false;
    return !assignLineStops.some(s => s.stop_name.toUpperCase().trim() === city);
  }, [assignService, assignLineId, selectedLineId, assignLineStops]);

  const openAssignModal = useCallback((svc: BusService) => {
    setAssignService(svc);
    setAssignCreatingStop(false);
    const currentLineId = selectedLine?.id ?? "";
    setAssignLineId(currentLineId);
    const firstAvailable = dateUnitLoads.find((u) => u.status !== "closed" && u.status !== "completed" && u.remaining_seats >= svc.pax)
      ?? dateUnitLoads.find((u) => u.status !== "closed" && u.status !== "completed")
      ?? null;
    setAssignUnitId(firstAvailable?.id ?? "");
    const suggestedStop = lineStops.find((s) => s.stop_name === svc.suggested_stop_name) ?? lineStops[0] ?? null;
    setAssignStopId(suggestedStop?.id ?? "");
    setAssignModalOpen(true);
  }, [dateUnitLoads, lineStops, selectedLine]);

  const onAssignLineChange = useCallback(async (newLineId: string) => {
    setAssignLineId(newLineId);
    const stops = payload.stops.filter((s) => s.bus_line_id === newLineId && s.direction === direction).sort((a, b) => a.stop_order - b.stop_order);
    const units = payload.units.filter((u) => u.bus_line_id === newLineId && u.status !== "closed" && u.status !== "completed");
    const unitsWithLoad = units.map(u => {
      const pax = payload.allocation_details
        .filter(a => a.bus_unit_id === u.id && a.service_date === date && a.direction === direction)
        .reduce((sum, a) => sum + a.pax_assigned, 0);
      return { ...u, remaining: Math.max(0, u.capacity - pax) };
    });
    const svcPax = assignService?.pax ?? 1;
    const firstAvailable = unitsWithLoad.find(u => u.remaining >= svcPax) ?? unitsWithLoad[0];
    setAssignUnitId(firstAvailable?.id ?? "");

    const city = (assignService?.bus_city_origin ?? "").toUpperCase().trim();
    const matchingStop = city
      ? stops.find(s => s.stop_name.toUpperCase().trim() === city || (s.city ?? "").toUpperCase().trim() === city)
      : null;

    if (matchingStop) {
      setAssignStopId(matchingStop.id);
    } else if (city && newLineId !== selectedLineId) {
      setAssignCreatingStop(true);
      const result = await post("create_stop_for_transfer", {
        bus_line_id: newLineId,
        stop_name: city,
        direction,
      }) as { stop_id?: string } | null;
      setAssignCreatingStop(false);
      if (result?.stop_id) {
        setAssignStopId(result.stop_id);
      } else {
        setAssignStopId(stops[0]?.id ?? "");
      }
    } else {
      setAssignStopId(stops[0]?.id ?? "");
    }
  }, [payload.stops, payload.units, payload.allocation_details, direction, date, assignService, selectedLineId, post]);

  const confirmMove = useCallback(async () => {
    if (!moveSource || !moveTargetUnitId) return;
    const pax = Number(movePaxStr);
    if (!pax || pax < 1) return;
    await post("move_allocation", { allocation_id: moveSource.allocation_id, to_bus_unit_id: moveTargetUnitId, pax_moved: pax, reason: moveReason || null });
    setMoveModalOpen(false);
    setMoveSource(null);
  }, [moveSource, moveTargetUnitId, movePaxStr, moveReason, post]);

  const confirmAssign = useCallback(async () => {
    if (!assignService || !assignUnitId || !assignStopId || !assignLineId) return;
    const allStops = payload.stops;
    const stop = allStops.find((s) => s.id === assignStopId);
    if (!stop) return;
    await post("allocate_service", {
      service_id: assignService.id, bus_line_id: assignLineId,
      bus_unit_id: assignUnitId, direction: assignService.direction,
      stop_name: stop.stop_name, stop_id: stop.id, pax_assigned: assignService.pax
    });
    setAssignModalOpen(false);
    setAssignService(null);
  }, [assignService, assignUnitId, assignStopId, assignLineId, payload.stops, post]);

  const deleteAllocation = useCallback(async (allocationId: string) => {
    setDeleteConfirmId(null);
    await post("delete_allocation", { allocation_id: allocationId });
  }, [post]);

  const resetLineDate = useCallback(async () => {
    if (!selectedLine) return;
    setResetModalOpen(false);
    const token = await getToken();
    if (!token) return;
    setSaving(true);
    try {
      const res = await fetch("/api/ops/bus-network", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset_line_date", bus_line_id: selectedLine.id, date, direction })
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) { setMessage(body?.error ?? "Errore reset."); return; }
      setResetResult({ allocations: body.deleted_allocations ?? 0, services: body.deleted_services ?? 0 });
      applyPayload(body);
    } finally {
      setSaving(false);
    }
  }, [selectedLine, date, direction, applyPayload]);

  const autoAssign = useCallback(async () => {
    const body = await post("auto_assign_date", { date, direction }) as ({ assigned?: number; skipped?: number; skipped_detail?: Array<{ customerName: string; reason: string }> } | null);
    if (body) {
      setAutoAssignResult({ assigned: body.assigned ?? 0, skipped: body.skipped ?? 0, skipped_detail: body.skipped_detail ?? [] });
    }
  }, [post, date, direction]);

  const saveStopName = useCallback(async (stopId: string, name: string) => {
    if (!name.trim()) return;
    await post("update_stop_name", { stop_id: stopId, stop_name: name.trim() });
    setEditStopNameId(null);
  }, [post]);

  const saveStopTime = useCallback(async (stopId: string, time: string) => {
    const normalizedTime = time.trim();
    if (normalizedTime && !isValidClockTime(normalizedTime)) return;
    await post("update_stop_time", { stop_id: stopId, pickup_time: normalizedTime || null });
    setEditStopTimeId(null);
  }, [post]);

  const geoSortStops = useCallback(async () => {
    if (!selectedLine) return;
    setGeoSorting(true);
    const res = await post("geo_sort_stops", { bus_line_id: selectedLine.id, direction, date }) as ({ geocoded?: number; skipped?: number; skipped_names?: string; debug_order?: string[] } | null);
    setGeoSorting(false);
    if (res) {
      const msg = `Ordinamento geografico: ${res.geocoded ?? 0} fermate ordinate per latitudine.`;
      const skip = res.skipped ?? 0;
      const debug = res.debug_order?.join(" | ") ?? "";
      setMessage(skip > 0
        ? `${msg} ${skip} non geocodificate: ${res.skipped_names ?? ""}. Ordine: ${debug}`
        : `${msg} Ordine: ${debug}`);
    }
  }, [date, selectedLine, direction, post]);

  const timeSortStops = useCallback(async () => {
    if (!selectedLine) return;
    const res = await post("sort_stops_by_time", { bus_line_id: selectedLine.id, direction }) as ({ sorted?: number } | null);
    if (res) setMessage(`Fermate riallineate per orario: ${res.sorted ?? 0} fermate riordinate.`);
  }, [selectedLine, direction, post]);

  const addUnit = useCallback(async () => {
    if (!newUnitLabel.trim() || !selectedLine) return;
    await post("add_unit", { bus_line_id: selectedLine.id, label: newUnitLabel.trim().toUpperCase(), capacity: 54 });
    setNewUnitLabel("");
  }, [newUnitLabel, selectedLine, post]);

  const addStop = useCallback(async () => {
    if (!newStopName.trim() || !newStopCity.trim() || !selectedLine) return;
    const normalizedPickupTime = newStopPickupTime.trim();
    if (normalizedPickupTime && !isValidClockTime(normalizedPickupTime)) return;
    const existing = payload.stops.filter((s) => s.bus_line_id === selectedLine.id && s.direction === direction);
    const maxOrder = existing.reduce((max, s) => Math.max(max, s.stop_order), 0);
    await post("add_stop", {
      bus_line_id: selectedLine.id, direction,
      stop_name: newStopName.trim().toUpperCase(), city: newStopCity.trim(),
      pickup_time: normalizedPickupTime || null,
      stop_order: maxOrder + 1, pickup_note: null, lat: null, lng: null
    });
    setNewStopName("");
    setNewStopCity("");
    setNewStopPickupTime("");
  }, [newStopName, newStopCity, newStopPickupTime, selectedLine, direction, payload.stops, post]);

  const moveStopOrder = useCallback(async (stopId: string, shift: "up" | "down") => {
    if (!selectedLine) return;
    const sorted = payload.stops
      .filter((s) => s.bus_line_id === selectedLine.id && s.direction === direction)
      .sort((a, b) => a.stop_order - b.stop_order);
    const idx = sorted.findIndex((s) => s.id === stopId);
    if (idx < 0) return;
    const swapIdx = shift === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    await post("swap_stops", { stop_id_a: sorted[idx].id, stop_id_b: sorted[swapIdx].id });
  }, [selectedLine, payload.stops, direction, post]);

  function buildAllocRows(
    unit: { label: string; driverName?: string | null; driverPhone?: string | null },
    allocs: AllocationDetail[],
    lineName: string,
    stops: BusStop[] = []
  ): Record<string, string | number>[] {
    // Mappa stop_name → stop_order per ordinare correttamente per fermata
    const stopOrderMap = new Map<string, number>();
    for (const s of stops) stopOrderMap.set(s.stop_name.toUpperCase(), s.stop_order);

    const sorted = [...allocs].sort((a, b) => {
      const oa = stopOrderMap.get(a.stop_name.toUpperCase()) ?? 9999;
      const ob = stopOrderMap.get(b.stop_name.toUpperCase()) ?? 9999;
      if (oa !== ob) return oa - ob;
      // Stessa fermata: ordina per orario servizio
      return (a.service_time ?? "").localeCompare(b.service_time ?? "");
    });
    return sorted.map((alloc) => {
      // Estrai hotel/agenzia dai notes se i campi dedicati sono vuoti (workaround PGRST204 o import vecchio)
      const rawNotes = alloc.notes ?? "";
      const hotelFromNotes = rawNotes.match(/Hotel:\s*([^·\n]+)/)?.[1]?.trim() ?? null;
      const agencyFromNotes = rawNotes.match(/Agenzia:\s*([^·\n]+)/)?.[1]?.trim() ?? null;
      const cleanNote = rawNotes
        .replace(/Hotel:\s*[^·\n]+·?\s*/gi, "")
        .replace(/Agenzia:\s*[^·\n]+·?\s*/gi, "")
        .trim();

      return {
        Orario: alloc.stop_pickup_time ?? "",
        "Punto di carico": alloc.stop_pickup_note ? `${alloc.stop_name} - ${alloc.stop_pickup_note}` : alloc.stop_name,
        "N° pax": alloc.pax_assigned,
        Nominativo: alloc.customer_name,
        "Cell.": alloc.customer_phone ?? "",
        "Hotel destinazione": alloc.hotel_name || hotelFromNotes || "",
        Note: cleanNote,
        Agenzia: alloc.agency_name || agencyFromNotes || "",
        Linea: lineName,
        Bus: unit.label,
        Autista: unit.driverName ?? "",
      };
    });
  }

  // Costruisce il foglio in formato PARTENZE (per direzione "departure")
  function buildDepartureSheet(
    utils: import("xlsx").XLSX$Utils,
    allocs: AllocationDetail[],
    stops: BusStop[],
    driverName?: string | null,
    driverPhone?: string | null
  ) {
    const stopOrderMap = new Map<string, number>();
    for (const s of stops) stopOrderMap.set(s.stop_name.toUpperCase(), s.stop_order);

    // Righe passeggeri: ordina per orario P.KUP hotel (ritorno), poi nominativo
    const sorted = [...allocs].sort((a, b) => {
      const ta = (a.hotel_pickup_time ?? a.stop_pickup_time ?? "99:99").slice(0, 5);
      const tb = (b.hotel_pickup_time ?? b.stop_pickup_time ?? "99:99").slice(0, 5);
      if (ta !== tb) return ta.localeCompare(tb);
      return (a.customer_name ?? "").localeCompare(b.customer_name ?? "");
    });

    // Header autista + titolo + intestazioni
    const aoa: (string | number)[][] = [
      [`AUTISTA: ${driverName || "N/D"}`, "", "", "", "", "", "", ""],
      [`CELL: ${driverPhone || "N/D"}`, "", "", "", "", "", "", ""],
      ["", "", "", "", "", "", "", ""],
      ["PARTENZE", "", "", "", "", "", "", ""],
      ["P.KUP", "hotel partenza", "n° pax", "nominativo", "cell", "destinazione", "agenzia", "note"],
    ];

    let totalPax = 0;
    for (const alloc of sorted) {
      const rawNotes = alloc.notes ?? "";
      const hotelFromNotes = rawNotes.match(/Hotel:\s*([^·\n]+)/)?.[1]?.trim() ?? "";
      const agencyFromNotes = rawNotes.match(/Agenzia:\s*([^·\n]+)/)?.[1]?.trim() ?? "";
      const cleanNote = rawNotes
        .replace(/Hotel:\s*[^·\n]+·?\s*/gi, "")
        .replace(/Agenzia:\s*[^·\n]+·?\s*/gi, "")
        .trim();

      // hotel partenza = hotel in Ischia (dove sale il passeggero)
      // destinazione   = solo il nome della fermata di scarico (senza note tecniche)
      const hotelPartenza = alloc.hotel_name || hotelFromNotes;
      const destinazione = alloc.stop_name;

      aoa.push([
        (alloc.hotel_pickup_time ?? alloc.stop_pickup_time ?? "").slice(0, 5),
        hotelPartenza,
        alloc.pax_assigned,
        alloc.customer_name,
        alloc.customer_phone ?? "",
        destinazione,
        alloc.agency_name || agencyFromNotes,
        cleanNote,
      ]);
      totalPax += alloc.pax_assigned;
    }

    // Riga vuota + TOTALE
    aoa.push(["", "", "", "", "", "", "", ""]);
    aoa.push(["", "TOTALE", totalPax, "", "", "", "", ""]);

    // Sezione SCARICO: solo fermate con passeggeri, in ordine di stop_order
    const usedStopNames = new Set(sorted.map((a) => a.stop_name.toUpperCase()));
    // SCARICO: fermate con passeggeri, ordinate geograficamente sud→nord (lat crescente)
    const usedStops = stops
      .filter((s) => usedStopNames.has(s.stop_name.toUpperCase()))
      .sort((a, b) => {
        if (a.lat != null && b.lat != null) return a.lat - b.lat;
        if (a.lat != null) return -1;
        if (b.lat != null) return 1;
        return a.stop_order - b.stop_order;
      });
    if (usedStops.length > 0) {
      aoa.push(["", "", "", "", "", "", "", ""]);
      aoa.push(["SCARICO", "", "", "", "", "", "", ""]);
      for (const stop of usedStops) {
        aoa.push(["", "", "", stop.stop_name, "", "", "", ""]);
      }
    }

    const ws = utils.aoa_to_sheet(aoa as (string | number)[][]);
    ws["!cols"] = [
      { wch: 8 },  // P.KUP
      { wch: 22 }, // hotel partenza
      { wch: 7 },  // n° pax
      { wch: 30 }, // nominativo
      { wch: 16 }, // cell
      { wch: 36 }, // destinazione
      { wch: 20 }, // agenzia
      { wch: 22 }, // note
    ];
    return ws;
  }

  const colWidths = [
    { wch: 8 },  // Orario
    { wch: 36 }, // Punto di carico
    { wch: 7 },  // N° pax
    { wch: 30 }, // Nominativo
    { wch: 16 }, // Cell.
    { wch: 28 }, // Hotel destinazione
    { wch: 22 }, // Note
    { wch: 22 }, // Agenzia
    { wch: 18 }, // Linea
    { wch: 14 }, // Bus
    { wch: 20 }, // Autista
  ];

  // Export linea corrente (tutti i bus della linea selezionata)
  const exportExcel = useCallback(async () => {
    const { utils, writeFile } = await import("xlsx");
    const lineStopsForExport = payload.stops
      .filter((s) => s.bus_line_id === selectedLine?.id && s.direction === direction)
      .sort((a, b) => a.stop_order - b.stop_order);
    let ws;
    if (direction === "departure") {
      const allAllocs = busCards.flatMap((c) => c.allocations);
      const firstUnit = busCards[0]?.unit;
      ws = buildDepartureSheet(utils, allAllocs, lineStopsForExport, firstUnit?.driver_name_return, firstUnit?.driver_phone_return);
    } else {
      const rows: Record<string, string | number>[] = [];
      for (const { unit, allocations: cardAllocs } of busCards) {
        rows.push(...buildAllocRows(
          { label: unit.label, driverName: unit.driver_name_outbound, driverPhone: unit.driver_phone_outbound },
          cardAllocs, selectedLine?.name ?? "", lineStopsForExport
        ));
      }
      ws = utils.json_to_sheet(rows);
      (ws as Record<string, unknown>)["!cols"] = colWidths;
    }
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws as never, (selectedLine?.name ?? "Bus").slice(0, 31));
    writeFile(wb, `bus_${selectedLine?.code ?? "export"}_${date}_${direction === "arrival" ? "Andata" : "Ritorno"}.xlsx`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busCards, date, direction, selectedLine]);

  // Export singolo bus: un foglio Andata + un foglio Ritorno
  const exportSingleBus = useCallback(async () => {
    const { utils, writeFile } = await import("xlsx");
    const targetCard = busCards.find((c) => c.unit.id === selectedBusUnitId) ?? busCards[0];
    if (!targetCard) return;
    const unitId = targetCard.unit.id;
    const lineName = selectedLine?.name ?? "";
    const wb = utils.book_new();
    for (const dir of ["arrival", "departure"] as const) {
      const dirAllocs = payload.allocation_details.filter(
        (a) => a.bus_unit_id === unitId && a.service_date === date && a.direction === dir
      );
      if (dirAllocs.length === 0) continue;
      const stopsForDir = payload.stops
        .filter((s) => s.bus_line_id === selectedLine?.id && s.direction === dir)
        .sort((a, b) => a.stop_order - b.stop_order);
      let ws;
      if (dir === "departure") {
        ws = buildDepartureSheet(utils, dirAllocs, stopsForDir, targetCard.unit.driver_name_return, targetCard.unit.driver_phone_return);
      } else {
        const rows = buildAllocRows(
          { label: targetCard.unit.label, driverName: targetCard.unit.driver_name_outbound, driverPhone: targetCard.unit.driver_phone_outbound },
          dirAllocs, lineName, stopsForDir
        );
        ws = utils.json_to_sheet(rows);
        (ws as Record<string, unknown>)["!cols"] = colWidths;
      }
      utils.book_append_sheet(wb, ws as never, dir === "arrival" ? "Andata" : "Ritorno");
    }
    if (wb.SheetNames.length === 0) return;
    const lineCode = selectedLine?.code ?? "bus";
    const busLabel = targetCard.unit.label.replace(/\s+/g, "_");
    writeFile(wb, `${lineCode}_${busLabel}_${date}.xlsx`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busCards, selectedBusUnitId, date, direction, selectedLine, payload.allocation_details]);

  // Export tutte le linee: un foglio per bus×direzione (1 bus = 1 sheet)
  const exportAllLines = useCallback(async () => {
    const { utils, writeFile } = await import("xlsx");
    const wb = utils.book_new();
    const usedNames = new Set<string>();
    for (const line of payload.lines) {
      // Andata prima, poi Ritorno — per ogni linea
      for (const dir of ["arrival", "departure"] as const) {
        const dirLabel = dir === "arrival" ? "And" : "Rit";
        // Unità di questa linea — già ordinate per sort_order dalla query API
        const lineUnitsAll = payload.units.filter((u) => u.bus_line_id === line.id);
        for (const unit of lineUnitsAll) {
          const unitAllocs = payload.allocation_details.filter(
            (a) => a.bus_unit_id === unit.id && a.service_date === date && a.direction === dir
          );
          if (unitAllocs.length === 0) continue;
          const stopsForDir = payload.stops
            .filter((s) => s.bus_line_id === line.id && s.direction === dir)
            .sort((a, b) => a.stop_order - b.stop_order);
          let ws;
          if (dir === "departure") {
            ws = buildDepartureSheet(utils, unitAllocs, stopsForDir, unit.driver_name_return, unit.driver_phone_return);
          } else {
            const rows = buildAllocRows(
              { label: unit.label, driverName: unit.driver_name_outbound, driverPhone: unit.driver_phone_outbound },
              unitAllocs, line.name, stopsForDir
            );
            ws = utils.json_to_sheet(rows);
            (ws as Record<string, unknown>)["!cols"] = colWidths;
          }
          // Nome foglio univoco ≤ 31 char: LineaCode_BusLabel_Dir
          const lineShort = (line.code ?? line.name).slice(0, 14);
          const busShort = unit.label.replace(/\s+/g, "").slice(0, 12);
          let sheetName = `${lineShort}_${busShort}_${dirLabel}`.slice(0, 31);
          // Evita duplicati (Excel non permette fogli con lo stesso nome)
          if (usedNames.has(sheetName)) {
            sheetName = sheetName.slice(0, 28) + String(usedNames.size).padStart(2, "0");
          }
          usedNames.add(sheetName);
          utils.book_append_sheet(wb, ws as never, sheetName);
        }
      }
    }
    if (wb.SheetNames.length === 0) return;
    writeFile(wb, `bus_tutte_linee_${date}.xlsx`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, date]);

  const saveDriver = useCallback(async (unitId: string) => {
    await post("update_driver", {
      unit_id: unitId,
      direction: direction === "departure" ? "return" : "outbound",
      driver_name: editDriverName.trim() || null,
      driver_phone: editDriverPhone.trim() || null,
      travel_date: date,
    });
    setEditDriverUnitId("");
  }, [post, editDriverName, editDriverPhone, direction, date]);

  const confirmApprovePendingWithNewStop = useCallback(async () => {
    if (!approvePending || !pendingNewStop || !selectedLine) return;
    const existing = payload.stops.filter((s) => s.bus_line_id === selectedLine.id && s.direction === direction);
    const afterStop = existing.find((s) => s.id === pendingNewStop.afterStopId);
    const insertOrder = afterStop
      ? afterStop.stop_order + 1
      : existing.reduce((max, s) => Math.max(max, s.stop_order), 0) + 1;
    const addResult = await post("add_stop", {
      bus_line_id: selectedLine.id,
      direction,
      stop_name: pendingNewStop.name.trim().toUpperCase(),
      city: pendingNewStop.city.trim(),
      pickup_note: pendingNewStop.note || null,
      stop_order: insertOrder,
      lat: null, lng: null
    }) as (Partial<ApiPayload> & { ok?: boolean }) | null;
    if (!addResult) return;
    const updatedStops = addResult.stops ?? [];
    const newStop = updatedStops.find(
      (s) => s.bus_line_id === selectedLine.id &&
        s.direction === direction &&
        s.stop_name.toUpperCase() === pendingNewStop.name.trim().toUpperCase()
    );
    if (!newStop) { setMessage("Fermata creata ma non trovata — riprova."); return; }
    await post("approve_pending", {
      pending_id: approvePending.id,
      bus_unit_id: approveUnitId,
      stop_id: newStop.id,
      travel_date: approvePending.travel_date,
    });
    setApprovePending(null);
    setPendingNewStop(null);
  }, [approvePending, pendingNewStop, selectedLine, direction, payload.stops, approveUnitId, post]);

  const handleDragStart = useCallback((alloc: AllocationDetail) => { setMoveSource(alloc); }, []);
  const handleDrop = useCallback((targetUnitId: string) => {
    setDragOverUnitId("");
    if (!moveSource || moveSource.bus_unit_id === targetUnitId) return;
    const target = dateUnitLoads.find((u) => u.id === targetUnitId && u.bus_line_id === moveSource.bus_line_id && u.status !== "closed" && u.status !== "completed");
    if (!target) return;
    setMoveTargetUnitId(targetUnitId);
    setMovePaxStr(String(moveSource.pax_assigned));
    setMoveReason("");
    setMoveModalOpen(true);
  }, [moveSource, dateUnitLoads]);

  // Move modal preview
  const moveTargetUnit = dateUnitLoads.find((u) => u.id === moveTargetUnitId);
  const movePax = Number(movePaxStr) || 0;
  const moveResidual = moveTargetUnit ? moveTargetUnit.remaining_seats - movePax : null;

  if (loading) return <div className="p-8 text-slate-500">Caricamento rete bus...</div>;

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Gestione Bus" subtitle="Linee nazionali — allocazione e spostamento passeggeri" />

      {message && (
        <div className="mx-6 mb-0 mt-2 rounded-lg bg-rose-50 px-4 py-2 text-sm text-rose-700">{message}</div>
      )}

      {lowSeatAlert && (
        <div className="mx-6 mb-0 mt-2 flex items-start justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span>
            <strong>Attenzione:</strong> il bus <strong>{lowSeatAlert.busLabel}</strong> ({lowSeatAlert.lineName}) ha solo{" "}
            <strong>{lowSeatAlert.remainingSeats} posti rimasti</strong>. È stata inviata una notifica via email.
          </span>
          <button onClick={() => setLowSeatAlert(null)} className="shrink-0 rounded p-0.5 text-amber-600 hover:bg-amber-100">✕</button>
        </div>
      )}

      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-6 py-3">
        {/* Date nav */}
        <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 px-2 py-1">
          <button onClick={() => setDate(shiftSunday(date, -1))} className="rounded p-1 text-slate-500 hover:bg-white hover:text-slate-800">←</button>
          <DateInput value={date}
            onChange={(iso) => { if (iso) setDate(iso); }}
            className="w-36 rounded-md border-0 bg-transparent px-2 py-0.5 text-sm font-medium text-slate-700 focus:outline-none" />
          <button onClick={() => setDate(shiftSunday(date, 1))} className="rounded p-1 text-slate-500 hover:bg-white hover:text-slate-800">→</button>
        </div>

        {/* Direction */}
        <div className="flex overflow-hidden rounded-lg border border-slate-200">
          <button onClick={() => setDirection("arrival")}
            className={`px-4 py-2 text-sm font-medium transition-colors ${direction === "arrival" ? "bg-indigo-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
            🚌 Andata (Nord → Sud)
          </button>
          <button onClick={() => setDirection("departure")}
            className={`px-4 py-2 text-sm font-medium transition-colors ${direction === "departure" ? "bg-indigo-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
            🏠 Ritorno (Sud → Nord)
          </button>
        </div>

        <div className="ml-auto flex items-center gap-3 text-sm">
          <span className="text-slate-500 capitalize">{fmtDate(date)}</span>
          <span className="font-medium text-slate-700">{totalPaxToday} pax assegnati</span>
          {unassigned.length > 0 && (
            <span className="rounded-full bg-amber-100 px-3 py-0.5 text-sm font-semibold text-amber-700">
              {unassigned.length} da assegnare
            </span>
          )}
        </div>
      </div>

      {/* Body: sidebar + main */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left sidebar: lines */}
        <div className="w-44 flex-shrink-0 overflow-y-auto border-r border-slate-200 bg-slate-50">
          {lineSummary.length === 0 && (
            <div className="p-4 text-xs text-slate-400">Nessuna linea. Vai su Impostazioni per caricare le linee base.</div>
          )}
          {lineSummary.map((line) => (
            <div key={line.id}
              className={`border-b border-slate-100 transition-colors ${
                selectedLineId === line.id ? "border-l-4 border-l-indigo-500 bg-white" : ""
              }`}>
              <div className="flex items-center gap-1 px-3 pt-3">
                {editingLineId === line.id ? (
                  <form className="flex flex-1 items-center gap-1" onSubmit={(e) => { e.preventDefault(); void saveLineName(line.id, editingLineName); }}>
                    <input
                      autoFocus
                      value={editingLineName}
                      onChange={(e) => setEditingLineName(e.target.value)}
                      onKeyDown={(e) => e.key === "Escape" && setEditingLineId(null)}
                      className="flex-1 rounded border border-indigo-300 px-2 py-0.5 text-sm font-medium text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                    <button type="submit" className="rounded p-0.5 text-indigo-600 hover:bg-indigo-50 text-xs font-bold">✓</button>
                    <button type="button" onClick={() => setEditingLineId(null)} className="rounded p-0.5 text-slate-400 hover:bg-slate-100 text-xs">✕</button>
                  </form>
                ) : (
                  <>
                    <button className="flex-1 text-left" onClick={() => setSelectedLineId(line.id)}>
                      <div className={`text-sm font-medium leading-tight ${selectedLineId === line.id ? "text-indigo-700 font-semibold" : "text-slate-700"}`}>
                        {line.name}
                      </div>
                    </button>
                    <button
                      title="Rinomina linea"
                      onClick={() => { setEditingLineId(line.id); setEditingLineName(line.name); }}
                      className="shrink-0 rounded p-0.5 text-slate-300 hover:text-indigo-500 hover:bg-indigo-50">
                      ✎
                    </button>
                  </>
                )}
              </div>
              <button className="w-full px-3 pb-3 text-left" onClick={() => setSelectedLineId(line.id)}>
                {line.totalCapacity > 0 && (
                  <div className="mt-1.5">
                    <div className="mb-0.5 flex items-center justify-between text-[10px] tabular-nums text-slate-400">
                      <span>{line.paxToday}/{line.totalCapacity}</span>
                      {line.unassignedToday > 0 && (
                        <span className="font-medium text-amber-600">+{line.unassignedToday}</span>
                      )}
                    </div>
                    <div className="h-1 w-full overflow-hidden rounded-full bg-slate-100">
                      <div
                        className={`h-1 rounded-full transition-all ${
                          line.totalCapacity > 0 && line.paxToday / line.totalCapacity >= 0.9
                            ? "bg-rose-400"
                            : line.totalCapacity > 0 && line.paxToday / line.totalCapacity >= 0.7
                            ? "bg-amber-400"
                            : "bg-emerald-400"
                        }`}
                        style={{ width: line.totalCapacity > 0 ? `${Math.min(100, Math.round((line.paxToday / line.totalCapacity) * 100))}%` : "0%" }}
                      />
                    </div>
                  </div>
                )}
                {line.totalCapacity === 0 && line.unassignedToday > 0 && (
                  <div className="mt-0.5 text-xs font-medium text-amber-600">{line.unassignedToday} da assegnare</div>
                )}
              </button>
            </div>
          ))}
        </div>

        {/* Main */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">

          {!selectedLine ? (
            <p className="text-slate-400 text-sm">Seleziona una linea.</p>
          ) : (
            <>
              {/* Toolbar */}
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-slate-600">
                  {selectedLine.name} — {direction === "arrival" ? "Andata" : "Ritorno"} — {fmtDate(date)}
                  {totalPaxToday > 0 && <span className="ml-2 text-slate-400">({totalPaxToday} pax allocati)</span>}
                </p>
                <div className="flex items-center gap-2">
                  <button onClick={() => void exportAllLines()} className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50" title="Esporta tutte le linee in un unico file Excel">
                    📥 Esporta tutte linee
                  </button>
                  <button onClick={() => void exportExcel()} className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50" title="Esporta tutti i bus della linea selezionata">
                    📥 Esporta linea
                  </button>
                  <button onClick={() => void exportSingleBus()} disabled={busCards.length === 0} className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40" title={selectedBusUnitId ? "Esporta bus selezionato" : "Esporta primo bus (seleziona un bus dalla lista per sceglierne uno specifico)"}>
                    📥 Esporta bus{selectedBusUnitId ? " ✓" : ""}
                  </button>
                  <button onClick={() => void autoAssign()} disabled={saving}
                    className="flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-white px-3 py-1.5 text-xs font-medium text-indigo-600 hover:bg-indigo-50 disabled:opacity-40">
                    ⚡ Auto-assegna
                  </button>
                  <button onClick={() => setResetModalOpen(true)} disabled={saving}
                    className="flex items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-40">
                    🗑 Svuota data
                  </button>
                  <button onClick={() => setImportModalOpen(true)}
                    className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-white px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50">
                    📥 Importa Excel
                  </button>
                </div>
              </div>

              {/* Tab switcher */}
              {(() => {
                const linePending = payload.pending_passengers.filter(
                  (p) => p.bus_line_id === selectedLine?.id && p.direction === direction && p.travel_date === date
                );
                return (
                  <div className="flex gap-0 overflow-hidden rounded-xl border border-slate-200 text-sm">
                    <button
                      onClick={() => setActiveTab("bus")}
                      className={`px-4 py-2 font-medium transition-colors ${activeTab === "bus" ? "bg-indigo-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
                      🚌 Bus
                    </button>
                    <button
                      onClick={() => setActiveTab("da_validare")}
                      className={`flex items-center gap-2 px-4 py-2 font-medium transition-colors ${activeTab === "da_validare" ? "bg-amber-500 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
                      ⚠ Da validare
                      {linePending.length > 0 && (
                        <span className={`rounded-full px-1.5 py-0.5 text-xs font-bold ${activeTab === "da_validare" ? "bg-white/30 text-white" : "bg-amber-100 text-amber-700"}`}>
                          {linePending.length}
                        </span>
                      )}
                    </button>
                  </div>
                );
              })()}

              {/* Route strip */}
              {activeTab === "bus" && (() => {
                const stopsWithPax = lineStops.map(stop => ({
                  stop,
                  pax: dateAllocations
                    .filter((a) => a.stop_name.toLowerCase() === stop.stop_name.toLowerCase())
                    .reduce((sum, a) => sum + a.pax_assigned, 0),
                }));
                const visibleStops = hideEmptyStops ? stopsWithPax.filter(s => s.pax > 0) : stopsWithPax;
                const stopsWithPaxCount = stopsWithPax.filter(s => s.pax > 0).length;
                return (
                  <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                    <div className="flex w-full items-center justify-between px-4 py-2.5">
                      <button
                        onClick={() => setShowRouteStrip((v) => !v)}
                        className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-700">
                        <span>🗺 Percorso — {hideEmptyStops ? `${stopsWithPaxCount} / ${lineStops.length} fermate` : `${lineStops.length} fermate`}</span>
                        <span className="text-slate-300">{showRouteStrip ? "▲" : "▼"}</span>
                      </button>
                      {stopsWithPaxCount > 0 && (
                        <button
                          onClick={() => setHideEmptyStops(v => !v)}
                          className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${hideEmptyStops ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}>
                          {hideEmptyStops ? "👁 Mostra tutte" : "👁 Nascondi vuote"}
                        </button>
                      )}
                    </div>
                    {showRouteStrip && (
                      <div className="overflow-x-auto border-t border-slate-100 px-3 py-3">
                        <div className="flex min-w-max items-start gap-0">
                          {visibleStops.map(({ stop, pax }, idx) => {
                            const hasPax = pax > 0;
                            return (
                              <div key={stop.id} className="flex items-center">
                                {idx > 0 && (
                                  <div className={`h-0.5 w-5 flex-shrink-0 ${hasPax ? "bg-emerald-300" : "bg-slate-200"}`} />
                                )}
                                <div className={`group flex w-[88px] flex-shrink-0 flex-col items-center rounded-xl border px-2 py-2 text-center transition-colors ${
                                  hasPax ? "border-emerald-200 bg-emerald-50" : "border-slate-100 bg-slate-50"
                                }`}>
                                  <span className="mb-0.5 text-[9px] font-bold tabular-nums text-slate-300">{stop.stop_order}</span>
                                  <span className={`text-[10px] font-bold leading-tight ${hasPax ? "text-emerald-800" : "text-slate-500"}`} style={{ wordBreak: "break-word" }}>
                                    {stop.stop_name}
                                  </span>
                                  {stop.pickup_note && (
                                    <span className="mt-0.5 text-[9px] text-slate-300 leading-tight">{stop.pickup_note}</span>
                                  )}
                                  {stop.pickup_time && (
                                    <span className="mt-0.5 rounded bg-indigo-50 px-1 text-[9px] font-semibold text-indigo-500">{stop.pickup_time}</span>
                                  )}
                                  {hasPax && (
                                    <span className="mt-1 rounded-full bg-emerald-600 px-1.5 text-[10px] font-bold text-white">{pax} pax</span>
                                  )}
                                  <div className="mt-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                                    <button onClick={() => void moveStopOrder(stop.id, "up")} disabled={idx === 0 || saving}
                                      className="rounded p-0.5 text-[10px] text-slate-300 hover:text-slate-700 disabled:opacity-20">↑</button>
                                    <button onClick={() => void moveStopOrder(stop.id, "down")} disabled={idx === visibleStops.length - 1 || saving}
                                      className="rounded p-0.5 text-[10px] text-slate-300 hover:text-slate-700 disabled:opacity-20">↓</button>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                          {visibleStops.length === 0 && (
                            <div className="py-2 text-xs italic text-slate-300">
                              {lineStops.length === 0 ? "Nessuna fermata. Usa \"Gestisci fermate\" per aggiungerne." : "Nessuna fermata con passeggeri per questa data."}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Bus cards */}
              {activeTab === "bus" && <div className="flex flex-nowrap gap-4 overflow-x-auto pb-2">
                {busCards.map(({ unit, allocations: cardAllocs }) => {
                  const paxTotal = cardAllocs.reduce((sum, a) => sum + a.pax_assigned, 0);
                  const remainingSeats = Math.max(0, unit.capacity - paxTotal);
                  const pct = unit.capacity > 0 ? Math.round((paxTotal / unit.capacity) * 100) : 0;
                  const isLow = remainingSeats <= unit.low_seat_threshold && remainingSeats > 0;
                  const isFull = remainingSeats <= 0;
                  const isClosed = unit.status === "closed" || unit.status === "completed";

                  // Group by stop in correct order, within each stop ordina per orario di partenza
                  const stopGroups = activeStops.map((stop) => ({
                    stop,
                    allocs: cardAllocs
                      .filter((a) => a.stop_name === stop.stop_name)
                      .sort((a, b) => (a.service_time ?? "99:99").localeCompare(b.service_time ?? "99:99"))
                  })).filter((g) => g.allocs.length > 0);

                  // Allocations at stops not in the active list
                  const ungrouped = cardAllocs.filter(
                    (a) => !activeStops.some((s) => s.stop_name === a.stop_name)
                  );

                  const isSelected = selectedBusUnitId === unit.id;
                  return (
                    <div key={unit.id}
                      onDragOver={(e) => { if (unit.tag === "esclusivo") return; e.preventDefault(); setDragOverUnitId(unit.id); }}
                      onDragLeave={() => setDragOverUnitId("")}
                      onDrop={(e) => { if (unit.tag === "esclusivo") return; e.preventDefault(); handleDrop(unit.id); }}
                      onClick={() => setSelectedBusUnitId(isSelected ? null : unit.id)}
                      className={`relative flex w-72 flex-shrink-0 flex-col rounded-2xl border-2 bg-white shadow-sm transition-all cursor-pointer ${
                        isSelected ? "border-indigo-500 ring-2 ring-indigo-200" :
                        dragOverUnitId === unit.id ? "border-indigo-400 bg-indigo-50 shadow-indigo-100" :
                        isClosed ? "border-slate-200 opacity-60" :
                        isFull ? "border-rose-300" :
                        isLow ? "border-amber-300" : "border-slate-200"
                      }`}>

                      {/* Header */}
                      <div
                        className="rounded-t-2xl border-b border-slate-100 px-4 py-3"
                        style={selectedLineFerryConfig ? { backgroundColor: selectedLineFerryConfig.line_color } : undefined}
                      >
                        <div className="flex items-center justify-between">
                          {editLabelUnitId === unit.id ? (
                            <input
                              autoFocus
                              value={editLabelValue}
                              onChange={(e) => setEditLabelValue(e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              onBlur={async () => {
                                if (editLabelValue.trim() && editLabelValue.trim() !== unit.label) {
                                  await post("update_label", { unit_id: unit.id, label: editLabelValue.trim() });
                                }
                                setEditLabelUnitId(null);
                              }}
                              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditLabelUnitId(null); }}
                              className="w-40 rounded border border-white/40 bg-white/20 px-2 py-0.5 text-base font-bold uppercase tracking-wide text-white focus:outline-none focus:ring-1 focus:ring-white/60"
                            />
                          ) : (
                            <div>
                              <span
                                className={`cursor-text text-base font-bold uppercase tracking-wide ${selectedLineFerryConfig ? "text-white hover:text-white/80" : "text-slate-900 hover:text-indigo-600"}`}
                                title="Clicca per rinominare"
                                onClick={(e) => { e.stopPropagation(); setEditLabelUnitId(unit.id); setEditLabelValue(unit.label); }}
                              >{unit.label}</span>
                            </div>
                          )}
                          <div className="flex items-center gap-1">
                            {/* Tag selector */}
                            <select
                              value={unit.tag ?? ""}
                              onClick={(e) => e.stopPropagation()}
                              onChange={async (e) => {
                                e.stopPropagation();
                                const newTag = e.target.value || null;
                                await post("update_tag", { unit_id: unit.id, tag: newTag });
                              }}
                              className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase cursor-pointer border-0 outline-none appearance-none ${
                                unit.tag === "esclusivo"
                                  ? selectedLineFerryConfig ? "bg-white/25 text-white" : "bg-yellow-100 text-yellow-700"
                                  : unit.tag === "gruppi"
                                  ? selectedLineFerryConfig ? "bg-white/25 text-white" : "bg-blue-100 text-blue-700"
                                  : selectedLineFerryConfig ? "bg-white/10 text-white/60" : "bg-slate-100 text-slate-400"
                              }`}
                              title="Tipo bus"
                            >
                              <option value="">— Tipo</option>
                              <option value="gruppi">👥 Gruppi</option>
                              <option value="esclusivo">⭐ Esclusivo</option>
                            </select>
                            {isClosed ? (
                              <span className={`rounded-full px-2 py-0.5 text-xs ${selectedLineFerryConfig ? "bg-white/20 text-white" : "bg-slate-200 text-slate-600"}`}>CHIUSO</span>
                            ) : isFull ? (
                              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${selectedLineFerryConfig ? "bg-white/20 text-white" : "bg-rose-100 text-rose-700"}`}>PIENO</span>
                            ) : isLow ? (
                              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${selectedLineFerryConfig ? "bg-white/20 text-white" : "bg-amber-100 text-amber-700"}`}>⚠ {remainingSeats} posti</span>
                            ) : (
                              <span className={`text-xs ${selectedLineFerryConfig ? "text-white/80" : "text-slate-400"}`}>{remainingSeats} liberi</span>
                            )}
                          </div>
                        </div>
                        {/* Capacity bar */}
                        <div className="mt-2 flex items-center gap-2">
                          <div className={`h-2 flex-1 overflow-hidden rounded-full ${selectedLineFerryConfig ? "bg-white/30" : "bg-slate-100"}`}>
                            <div
                              className={`h-2 rounded-full transition-all ${selectedLineFerryConfig ? "bg-white/80" : isFull ? "bg-rose-400" : isLow ? "bg-amber-400" : "bg-emerald-400"}`}
                              style={{ width: `${Math.min(100, pct)}%` }} />
                          </div>
                          {editCapUnitId === unit.id ? (
                            <input
                              autoFocus
                              type="number"
                              min={1}
                              max={300}
                              value={editCapValue}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => setEditCapValue(e.target.value)}
                              onBlur={async () => {
                                const cap = parseInt(editCapValue, 10);
                                if (!isNaN(cap) && cap >= 1 && cap !== unit.capacity) {
                                  await post("update_capacity", { unit_id: unit.id, capacity: cap });
                                }
                                setEditCapUnitId(null);
                              }}
                              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditCapUnitId(null); }}
                              className={`w-16 rounded border px-1 py-0.5 text-right text-xs tabular-nums focus:outline-none focus:ring-1 ${selectedLineFerryConfig ? "border-white/40 bg-white/20 text-white focus:ring-white/60" : "border-indigo-300 bg-indigo-50 text-slate-900 focus:ring-indigo-400"}`}
                            />
                          ) : (
                            <span
                              className={`w-14 cursor-pointer text-right text-xs tabular-nums ${selectedLineFerryConfig ? "text-white/90 hover:text-white" : "text-slate-500 hover:text-indigo-600"}`}
                              title="Clicca per modificare capienza"
                              onClick={(e) => { e.stopPropagation(); setEditCapUnitId(unit.id); setEditCapValue(String(unit.capacity)); }}
                            >{paxTotal}/{unit.capacity}</span>
                          )}
                        </div>
                        {/* Driver info */}
                        {editDriverUnitId === unit.id ? (
                          <div className="mt-2 space-y-1">
                            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                              Autista {direction === "departure" ? "Ritorno" : "Andata"}
                            </p>
                            <div className="flex gap-1">
                              <input value={editDriverName} onChange={(e) => setEditDriverName(e.target.value)}
                                placeholder="Nome autista" className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1 text-xs" />
                              <input value={editDriverPhone} onChange={(e) => setEditDriverPhone(e.target.value)}
                                placeholder="Telefono" className="w-24 rounded border border-slate-200 px-2 py-1 text-xs" />
                              <button onClick={() => void saveDriver(unit.id)} disabled={saving}
                                className="rounded bg-indigo-600 px-2 py-1 text-xs text-white hover:bg-indigo-700 disabled:opacity-40">✓</button>
                              <button onClick={() => setEditDriverUnitId("")} className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-600 hover:bg-slate-200">✕</button>
                            </div>
                          </div>
                        ) : (() => {
                          const dName = direction === "departure" ? unit.driver_name_return : unit.driver_name_outbound;
                          const dPhone = direction === "departure" ? unit.driver_phone_return : unit.driver_phone_outbound;
                          return (
                            <button onClick={() => { setEditDriverUnitId(unit.id); setEditDriverName(dName ?? ""); setEditDriverPhone(dPhone ?? ""); }}
                              className={`mt-1.5 flex w-full items-center gap-1 text-left text-xs ${selectedLineFerryConfig ? "text-white/70 hover:text-white" : "text-slate-400 hover:text-slate-600"}`}>
                              🚗 {dName
                                ? <span className={`font-medium ${selectedLineFerryConfig ? "text-white" : "text-slate-600"}`}>{dName}{dPhone ? ` · ${dPhone}` : ""}</span>
                                : <span className="italic">Autista {direction === "departure" ? "Ritorno" : "Andata"} — aggiungi</span>}
                            </button>
                          );
                        })()}
                        {/* Campo nome gruppo/cliente — visibile solo se tag gruppi o esclusivo */}
                        {(unit.tag === "gruppi" || unit.tag === "esclusivo") && (
                          <div className="mt-2">
                            {editGroupNameUnitId === unit.id ? (
                              <input
                                autoFocus
                                value={editGroupNameValue}
                                onChange={(e) => setEditGroupNameValue(e.target.value)}
                                onClick={(e) => e.stopPropagation()}
                                placeholder="Nome gruppo / cliente..."
                                onBlur={async () => {
                                  if (editGroupNameValue !== (unit.group_name ?? "")) {
                                    await post("update_group_name", { unit_id: unit.id, group_name: editGroupNameValue.trim() || null });
                                  }
                                  setEditGroupNameUnitId(null);
                                }}
                                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditGroupNameUnitId(null); }}
                                className={`w-full rounded border px-2 py-1 text-xs focus:outline-none focus:ring-1 ${selectedLineFerryConfig ? "border-white/40 bg-white/20 text-white placeholder-white/50 focus:ring-white/60" : "border-slate-200 bg-slate-50 text-slate-800 placeholder-slate-300 focus:ring-indigo-300"}`}
                              />
                            ) : (
                              <button
                                onClick={(e) => { e.stopPropagation(); setEditGroupNameUnitId(unit.id); setEditGroupNameValue(unit.group_name ?? ""); }}
                                className={`w-full text-left text-xs ${selectedLineFerryConfig ? "text-white/80 hover:text-white" : "text-slate-500 hover:text-indigo-600"}`}
                              >
                                {unit.group_name
                                  ? <span className={`font-semibold ${selectedLineFerryConfig ? "text-white" : "text-slate-700"}`}>👤 {unit.group_name}</span>
                                  : <span className="italic opacity-60">👤 {unit.tag === "esclusivo" ? "Nome cliente esclusivo..." : "Nome gruppo..."}</span>}
                              </button>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Passenger list grouped by stop */}
                      <div className="flex-1 divide-y divide-slate-50 overflow-y-auto" onDragOver={(e) => e.preventDefault()}>
                        {[...stopGroups.map(({ stop, allocs }) => (
                          <div key={stop.id} className="px-3 py-2">
                            <div className="mb-1 flex items-center justify-between">
                              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                                📍 {stop.stop_name}
                                {stop.city && stop.city.toLowerCase() !== stop.stop_name.toLowerCase() && (
                                  <span className="ml-1 font-normal normal-case text-slate-300">({stop.city})</span>
                                )}
                              </div>
                              {stop.pickup_time && (
                                <span className="ml-2 shrink-0 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-500">
                                  🕐 {stop.pickup_time}
                                </span>
                              )}
                            </div>
                            {allocs.map((alloc) => (
                              <div key={alloc.allocation_id}
                                draggable
                                onDragStart={() => handleDragStart(alloc)}
                                className="group mb-1 flex cursor-grab items-start gap-2 rounded-lg p-1.5 active:cursor-grabbing hover:bg-slate-50">
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-sm font-semibold uppercase text-slate-800">
                                    {alloc.customer_name}
                                  </div>
                                  <div className="flex items-center gap-1">
                                    {editCardHotelId === alloc.allocation_id ? (
                                      <div className="relative w-full" onClick={(e) => e.stopPropagation()}>
                                        <input
                                          autoFocus
                                          type="text"
                                          placeholder="Cerca hotel..."
                                          value={editCardHotelSearch}
                                          onChange={(e) => setEditCardHotelSearch(e.target.value)}
                                          onKeyDown={(e) => { if (e.key === "Escape") setEditCardHotelId(null); }}
                                          className="w-full rounded border border-indigo-300 bg-indigo-50 px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400"
                                        />
                                        <div className="absolute left-0 top-full z-50 max-h-40 w-48 overflow-y-auto rounded-b border border-t-0 border-indigo-200 bg-white shadow-lg">
                                          {payload.hotels_list
                                            .filter(h => !editCardHotelSearch.trim() || h.name.toLowerCase().includes(editCardHotelSearch.toLowerCase().trim()))
                                            .slice(0, 20)
                                            .map(h => (
                                              <button
                                                key={h.id}
                                                onMouseDown={async () => {
                                                  if (h.id !== alloc.hotel_id) {
                                                    await post("update_hotel", { service_id: alloc.service_id, hotel_id: h.id });
                                                  }
                                                  setEditCardHotelId(null);
                                                  setEditCardHotelSearch("");
                                                }}
                                                className={`w-full px-2 py-1 text-left text-xs uppercase hover:bg-indigo-50 ${h.id === editCardHotelValue ? "bg-indigo-100 font-semibold text-indigo-700" : "text-slate-700"}`}
                                              >
                                                {h.name}
                                              </button>
                                            ))}
                                          {payload.hotels_list.filter(h => !editCardHotelSearch.trim() || h.name.toLowerCase().includes(editCardHotelSearch.toLowerCase().trim())).length === 0 && (
                                            <div className="px-2 py-1 text-xs italic text-slate-400">Nessun hotel trovato</div>
                                          )}
                                        </div>
                                      </div>
                                    ) : (
                                      <span
                                        className="truncate cursor-pointer text-xs uppercase text-slate-400 hover:text-indigo-600"
                                        title="Clicca per cambiare hotel"
                                        onClick={(e) => { e.stopPropagation(); setEditCardHotelId(alloc.allocation_id); setEditCardHotelValue(alloc.hotel_id ?? ""); setEditCardHotelSearch(""); }}
                                      >
                                        {alloc.hotel_name ?? "—"}
                                      </span>
                                    )}
                                    {direction === "departure" && alloc.hotel_pickup_time && (
                                      <span className="shrink-0 rounded bg-amber-50 px-1 text-[9px] font-semibold text-amber-600">
                                        {alloc.hotel_pickup_time.slice(0, 5)}
                                      </span>
                                    )}
                                  </div>
                                  {editCardPhoneId === alloc.allocation_id ? (
                                    <input
                                      autoFocus
                                      type="text"
                                      value={editCardPhoneValue}
                                      onClick={(e) => e.stopPropagation()}
                                      onChange={(e) => setEditCardPhoneValue(e.target.value)}
                                      onBlur={async () => {
                                        if (editCardPhoneValue !== (alloc.customer_phone ?? "")) {
                                          await post("update_phone", { service_id: alloc.service_id, phone: editCardPhoneValue || null });
                                        }
                                        setEditCardPhoneId(null);
                                      }}
                                      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditCardPhoneId(null); }}
                                      className="w-full rounded border border-indigo-300 bg-indigo-50 px-1 py-0.5 text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-indigo-400"
                                    />
                                  ) : (
                                    <div
                                      className="cursor-pointer text-xs text-slate-300 hover:text-indigo-500"
                                      title="Clicca per modificare telefono"
                                      onClick={(e) => { e.stopPropagation(); setEditCardPhoneId(alloc.allocation_id); setEditCardPhoneValue(alloc.customer_phone ?? ""); }}
                                    >
                                      {alloc.customer_phone || <span className="italic">+ telefono</span>}
                                    </div>
                                  )}
                                </div>
                                <div className="flex flex-shrink-0 flex-col items-end gap-1">
                                  {editPaxAllocId === alloc.allocation_id ? (
                                    <input
                                      autoFocus
                                      type="number"
                                      min={1}
                                      max={120}
                                      value={editPaxValue}
                                      onClick={(e) => e.stopPropagation()}
                                      onChange={(e) => setEditPaxValue(e.target.value)}
                                      onBlur={async () => {
                                        const pax = parseInt(editPaxValue, 10);
                                        if (!isNaN(pax) && pax >= 1 && pax !== alloc.pax_assigned) {
                                          await post("update_pax", { allocation_id: alloc.allocation_id, pax_assigned: pax });
                                        }
                                        setEditPaxAllocId(null);
                                      }}
                                      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditPaxAllocId(null); }}
                                      className="w-14 rounded border border-indigo-300 bg-indigo-50 px-1 py-0.5 text-right text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-indigo-400"
                                    />
                                  ) : (
                                    <span
                                      className="cursor-pointer rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600 hover:bg-indigo-100 hover:text-indigo-700"
                                      title="Clicca per modificare pax"
                                      onClick={(e) => { e.stopPropagation(); setEditPaxAllocId(alloc.allocation_id); setEditPaxValue(String(alloc.pax_assigned)); }}
                                    >
                                      {alloc.pax_assigned} pax
                                    </span>
                                  )}
                                  <div className="flex gap-1">
                                    <button onClick={() => openMoveModal(alloc)}
                                      className="rounded border border-indigo-200 px-1.5 py-0.5 text-xs text-indigo-600 opacity-0 transition-opacity hover:bg-indigo-50 group-hover:opacity-100">
                                      Sposta
                                    </button>
                                    {isAdmin && (
                                      <button onClick={() => openTransferModal(alloc)}
                                        className="rounded border border-violet-200 px-1.5 py-0.5 text-xs text-violet-600 opacity-0 transition-opacity hover:bg-violet-50 group-hover:opacity-100">
                                        ↔ Linea
                                      </button>
                                    )}
                                    {deleteConfirmId === alloc.allocation_id ? (
                                      <button onClick={() => void deleteAllocation(alloc.allocation_id)} disabled={saving}
                                        className="rounded border border-rose-400 bg-rose-50 px-1.5 py-0.5 text-xs text-rose-700 opacity-100">
                                        Conferma ✕
                                      </button>
                                    ) : (
                                      <button onClick={() => setDeleteConfirmId(alloc.allocation_id)}
                                        className="rounded border border-slate-200 px-1.5 py-0.5 text-xs text-slate-400 opacity-0 transition-opacity hover:border-rose-300 hover:text-rose-500 group-hover:opacity-100">
                                        ✕
                                      </button>
                                    )}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )),
                        ...ungrouped.map((alloc) => (
                          <div key={alloc.allocation_id} className="px-3 py-2">
                            <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">📍 {alloc.stop_name}</div>
                            <div
                              draggable
                              onDragStart={() => handleDragStart(alloc)}
                              className="group flex cursor-grab items-start gap-2 rounded-lg p-1.5 active:cursor-grabbing hover:bg-slate-50">
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-semibold uppercase text-slate-800">{alloc.customer_name}</div>
                                {editCardHotelId === alloc.allocation_id ? (
                                  <div className="relative w-full" onClick={(e) => e.stopPropagation()}>
                                    <input
                                      autoFocus
                                      type="text"
                                      placeholder="Cerca hotel..."
                                      value={editCardHotelSearch}
                                      onChange={(e) => setEditCardHotelSearch(e.target.value)}
                                      onKeyDown={(e) => { if (e.key === "Escape") setEditCardHotelId(null); }}
                                      className="w-full rounded border border-indigo-300 bg-indigo-50 px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400"
                                    />
                                    <div className="absolute left-0 top-full z-50 max-h-40 w-48 overflow-y-auto rounded-b border border-t-0 border-indigo-200 bg-white shadow-lg">
                                      {payload.hotels_list
                                        .filter(h => !editCardHotelSearch.trim() || h.name.toLowerCase().includes(editCardHotelSearch.toLowerCase().trim()))
                                        .slice(0, 20)
                                        .map(h => (
                                          <button
                                            key={h.id}
                                            onMouseDown={async () => {
                                              if (h.id !== alloc.hotel_id) {
                                                await post("update_hotel", { service_id: alloc.service_id, hotel_id: h.id });
                                              }
                                              setEditCardHotelId(null);
                                              setEditCardHotelSearch("");
                                            }}
                                            className={`w-full px-2 py-1 text-left text-xs uppercase hover:bg-indigo-50 ${h.id === editCardHotelValue ? "bg-indigo-100 font-semibold text-indigo-700" : "text-slate-700"}`}
                                          >
                                            {h.name}
                                          </button>
                                        ))}
                                      {payload.hotels_list.filter(h => !editCardHotelSearch.trim() || h.name.toLowerCase().includes(editCardHotelSearch.toLowerCase().trim())).length === 0 && (
                                        <div className="px-2 py-1 text-xs italic text-slate-400">Nessun hotel trovato</div>
                                      )}
                                    </div>
                                  </div>
                                ) : (
                                  <div
                                    className="truncate cursor-pointer text-xs uppercase text-slate-400 hover:text-indigo-600"
                                    title="Clicca per cambiare hotel"
                                    onClick={(e) => { e.stopPropagation(); setEditCardHotelId(alloc.allocation_id); setEditCardHotelValue(alloc.hotel_id ?? ""); setEditCardHotelSearch(""); }}
                                  >
                                    {alloc.hotel_name ?? "—"}
                                  </div>
                                )}
                                {editCardPhoneId === alloc.allocation_id ? (
                                  <input
                                    autoFocus
                                    type="text"
                                    value={editCardPhoneValue}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => setEditCardPhoneValue(e.target.value)}
                                    onBlur={async () => {
                                      if (editCardPhoneValue !== (alloc.customer_phone ?? "")) {
                                        await post("update_phone", { service_id: alloc.service_id, phone: editCardPhoneValue || null });
                                      }
                                      setEditCardPhoneId(null);
                                    }}
                                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditCardPhoneId(null); }}
                                    className="w-full rounded border border-indigo-300 bg-indigo-50 px-1 py-0.5 text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-indigo-400"
                                  />
                                ) : (
                                  <div
                                    className="cursor-pointer text-xs text-slate-300 hover:text-indigo-500"
                                    title="Clicca per modificare telefono"
                                    onClick={(e) => { e.stopPropagation(); setEditCardPhoneId(alloc.allocation_id); setEditCardPhoneValue(alloc.customer_phone ?? ""); }}
                                  >
                                    {alloc.customer_phone || <span className="italic">+ telefono</span>}
                                  </div>
                                )}
                              </div>
                              <div className="flex flex-shrink-0 flex-col items-end gap-1">
                                {editPaxAllocId === alloc.allocation_id ? (
                                  <input
                                    autoFocus
                                    type="number"
                                    min={1}
                                    max={120}
                                    value={editPaxValue}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => setEditPaxValue(e.target.value)}
                                    onBlur={async () => {
                                      const pax = parseInt(editPaxValue, 10);
                                      if (!isNaN(pax) && pax >= 1 && pax !== alloc.pax_assigned) {
                                        await post("update_pax", { allocation_id: alloc.allocation_id, pax_assigned: pax });
                                      }
                                      setEditPaxAllocId(null);
                                    }}
                                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditPaxAllocId(null); }}
                                    className="w-14 rounded border border-indigo-300 bg-indigo-50 px-1 py-0.5 text-right text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-indigo-400"
                                  />
                                ) : (
                                  <span
                                    className="cursor-pointer rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600 hover:bg-indigo-100 hover:text-indigo-700"
                                    title="Clicca per modificare pax"
                                    onClick={(e) => { e.stopPropagation(); setEditPaxAllocId(alloc.allocation_id); setEditPaxValue(String(alloc.pax_assigned)); }}
                                  >
                                    {alloc.pax_assigned} pax
                                  </span>
                                )}
                                <div className="flex gap-1">
                                  <button onClick={() => openMoveModal(alloc)}
                                    className="rounded border border-indigo-200 px-1.5 py-0.5 text-xs text-indigo-600 opacity-0 transition-opacity hover:bg-indigo-50 group-hover:opacity-100">
                                    Sposta
                                  </button>
                                  {isAdmin && (
                                    <button onClick={() => openTransferModal(alloc)}
                                      className="rounded border border-violet-200 px-1.5 py-0.5 text-xs text-violet-600 opacity-0 transition-opacity hover:bg-violet-50 group-hover:opacity-100">
                                      ↔ Linea
                                    </button>
                                  )}
                                  {deleteConfirmId === alloc.allocation_id ? (
                                    <button onClick={() => void deleteAllocation(alloc.allocation_id)} disabled={saving}
                                      className="rounded border border-rose-400 bg-rose-50 px-1.5 py-0.5 text-xs text-rose-700 opacity-100">
                                      Conferma ✕
                                    </button>
                                  ) : (
                                    <button onClick={() => setDeleteConfirmId(alloc.allocation_id)}
                                      className="rounded border border-slate-200 px-1.5 py-0.5 text-xs text-slate-400 opacity-0 transition-opacity hover:border-rose-300 hover:text-rose-500 group-hover:opacity-100">
                                      ✕
                                    </button>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        ))]}

                        {cardAllocs.length === 0 && (
                          <div className="px-4 py-6 text-center text-xs text-slate-300 italic">
                            Trascina qui un passeggero
                          </div>
                        )}
                      </div>

                      {/* Footer */}
                      <div className="rounded-b-2xl border-t border-slate-50 px-3 py-2">
                        {isClosed ? (
                          <button
                            onClick={() => void post("update_unit", { unit_id: unit.id, status: "open", close_reason: null })}
                            disabled={saving}
                            className="w-full rounded-lg py-1.5 text-xs text-emerald-700 hover:bg-emerald-50 disabled:opacity-40">
                            ↩ Riapri bus
                          </button>
                        ) : (
                          <button
                            onClick={() => {
                              const reason = window.prompt("Motivo chiusura (opzionale):") ?? "";
                              void post("update_unit", { unit_id: unit.id, status: "closed", close_reason: reason || null });
                            }}
                            disabled={saving}
                            className="w-full rounded-lg py-1.5 text-xs text-rose-500 hover:bg-rose-50 disabled:opacity-40">
                            🔒 Chiudi bus
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}

                {/* Add bus */}
                <div className="flex w-48 flex-shrink-0 flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-slate-200 p-4">
                  <input value={newUnitLabel} onChange={(e) => setNewUnitLabel(e.target.value.toUpperCase())}
                    placeholder={`Es: ${selectedLine.code} 6`}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-center text-sm uppercase tracking-wide" />
                  <button onClick={() => void addUnit()} disabled={saving || !newUnitLabel.trim()}
                    className="btn-secondary w-full py-2 text-sm disabled:opacity-40">
                    + Aggiungi bus
                  </button>
                </div>
              </div>}

              {/* ── Distribuzione Ischia ── */}
              {activeTab === "bus" && direction === "arrival" && (
                <div className="mt-6">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="flex items-center gap-1.5 text-base font-bold text-slate-800"><FerryIcon size={22} /> Distribuzione Ischia</span>
                      <span className="text-xs text-slate-400">Tutti gli arrivi del giorno smistati per zona</span>
                    </div>
                    <button
                      onClick={() => {
                        const hasExisting = payload.ischia_dist_buses.some(b => b.date === date);
                        if (hasExisting && !smistamentoConfirm) { setSmistamentoConfirm(true); return; }
                        setSmistamentoConfirm(false);
                        void post("smista_ischia", { date });
                      }}
                      disabled={saving}
                      className={`flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-40 ${smistamentoConfirm ? "bg-rose-600 hover:bg-rose-700" : "bg-violet-600 hover:bg-violet-700"}`}>
                      {smistamentoConfirm ? "⚠ Conferma (sovrascrive)" : "⚡ Smista per zona"}
                    </button>
                  </div>

                  {payload.ischia_dist_buses.filter((b) => b.date === date && (b.bus_line_id === selectedLine?.id || !b.bus_line_id)).length === 0 ? (
                    <div className="rounded-xl border-2 border-dashed border-slate-200 p-8 text-center text-sm text-slate-400">
                      Nessun bus distribuzione per questa linea. Clicca <strong>⚡ Smista per zona</strong> per generarli automaticamente.
                    </div>
                  ) : (() => {
                    // Mostra solo i bus della linea selezionata (ogni linea ha il suo traghetto)
                    const busesForDate = payload.ischia_dist_buses
                      .filter((b) => b.date === date && (b.bus_line_id === selectedLine?.id || !b.bus_line_id))
                      .sort((a, b) => a.sort_order - b.sort_order);

                    // Costruisce mappa bus_line_id → ferry config (tramite lines)
                    const lineToConfig = new Map<string, BusLineFerryConfig>();
                    for (const line of payload.lines) {
                      const cfg = payload.bus_line_ferry_config.find(
                        (c) => c.bus_line_family_code.toLowerCase() === line.family_code?.toLowerCase()
                      );
                      if (cfg) lineToConfig.set(line.id, cfg);
                    }

                    // Raggruppa bus per ferry config (o "senza linea")
                    type BusGroup = { config: BusLineFerryConfig | null; buses: typeof busesForDate };
                    const groups: BusGroup[] = [];
                    const usedConfigs = new Set<string>();

                    // Prima aggiungi i gruppi con config nell'ordine sort_order
                    for (const cfg of [...payload.bus_line_ferry_config].sort((a, b) => a.sort_order - b.sort_order)) {
                      const groupBuses = busesForDate.filter((b) => b.bus_line_id && lineToConfig.get(b.bus_line_id)?.id === cfg.id);
                      if (groupBuses.length > 0) {
                        groups.push({ config: cfg, buses: groupBuses });
                        usedConfigs.add(cfg.id);
                      }
                    }
                    // Poi i bus senza linea configurata
                    const ungrouped = busesForDate.filter((b) => !b.bus_line_id || !lineToConfig.has(b.bus_line_id));
                    if (ungrouped.length > 0) groups.push({ config: null, buses: ungrouped });

                    return (
                    <div className="space-y-5">
                      {groups.map((group, gi) => (
                        <div key={gi}>
                          {/* Header blocco linea */}
                          {group.config && (
                            <div className="mb-2 flex items-center gap-2">
                              <span
                                className="rounded-full px-3 py-0.5 text-xs font-bold text-white"
                                style={{ backgroundColor: group.config.line_color }}>
                                {group.config.line_label}
                              </span>
                              <span className="flex items-center gap-1.5 text-sm font-bold text-slate-700">
                                <FerryIcon size={20} /> {group.config.departure_time.slice(0, 5)} · {group.config.arrival_port === "casamicciola" ? "Casamicciola" : "Ischia Porto"}
                              </span>
                            </div>
                          )}
                          {!group.config && (
                            <div className="mb-2 flex items-center gap-2">
                              <span className="rounded-full bg-slate-200 px-3 py-0.5 text-xs font-bold text-slate-600">Altri bus</span>
                            </div>
                          )}
                    <div className="flex gap-4 overflow-x-auto pb-2">
                      {group.buses.map((bus) => {
                          const busAllocs = payload.ischia_dist_allocations.filter((a) => a.dist_bus_id === bus.id);
                          const totalPax = busAllocs.reduce((s, a) => s + a.pax_assigned, 0);
                          const pct = bus.capacity > 0 ? Math.round((totalPax / bus.capacity) * 100) : 0;
                          const isDragOver = dragOverDistBusId === bus.id;
                          const isExclusive = bus.label.startsWith("⭐");

                          return (
                            <div
                              key={bus.id}
                              onDragOver={(e) => { if (isExclusive) return; e.preventDefault(); setDragOverDistBusId(bus.id); }}
                              onDragLeave={() => setDragOverDistBusId(null)}
                              onDrop={(e) => {
                                e.preventDefault();
                                setDragOverDistBusId(null);
                                setDragReorderTargetId(null);
                                if (!dragDistAllocId) return;
                                const isFromThisBus = busAllocs.some(a => a.id === dragDistAllocId);
                                if (isFromThisBus) {
                                  // Drop in fondo al bus (non su una card specifica) → sposta in fondo
                                  void post("reorder_dist_alloc", { allocation_id: dragDistAllocId, before_allocation_id: null });
                                } else if (!isExclusive) {
                                  // Da bus diverso → sposta su questo bus (non esclusivo)
                                  void post("move_dist", { allocation_id: dragDistAllocId, to_dist_bus_id: bus.id });
                                }
                                setDragDistAllocId(null);
                              }}
                              className={`flex w-56 flex-shrink-0 flex-col rounded-2xl border bg-white shadow-sm transition-colors ${isExclusive ? "border-yellow-400 ring-1 ring-yellow-200" : isDragOver ? "border-violet-400 bg-violet-50" : "border-slate-200"}`}>
                              {/* Header bus — colorato con il colore della linea se disponibile */}
                              <div
                                className="rounded-t-2xl px-4 py-3 text-white"
                                style={{ backgroundColor: group.config?.line_color ?? "#1e293b" }}>
                                <div className="flex items-center justify-between">
                                  <div className="min-w-0">
                                    <span className="font-bold text-sm truncate block max-w-[140px]">{bus.label}</span>
                                    {isExclusive && (
                                      <span className="rounded-full bg-yellow-400/30 px-1.5 py-0.5 text-[9px] font-bold uppercase text-yellow-200">🔒 Riservato</span>
                                    )}
                                    {group.config && (
                                      <span className="flex items-center gap-1 text-xs font-semibold text-white/90"><FerryIcon size={14} /> {group.config.departure_time.slice(0, 5)}</span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-1.5">
                                    <button
                                      title="Scarica lista autista (Excel)"
                                      className="text-slate-400 hover:text-emerald-400 text-xs disabled:opacity-30"
                                      disabled={saving}
                                      onClick={async () => {
                                        const token = await getToken();
                                        if (!token) return;
                                        const res = await fetch(`/api/ops/bus-ischia-export?dist_bus_id=${bus.id}`, {
                                          headers: { Authorization: `Bearer ${token}` }
                                        });
                                        if (!res.ok) return;
                                        const blob = await res.blob();
                                        const url = URL.createObjectURL(blob);
                                        const a = document.createElement("a");
                                        const cd = res.headers.get("content-disposition") ?? "";
                                        const match = cd.match(/filename="([^"]+)"/);
                                        a.href = url; a.download = match?.[1] ?? `lista_autista_${bus.date}.xlsx`;
                                        a.click(); URL.revokeObjectURL(url);
                                      }}>📥</button>
                                    <button
                                      title="Clona bus"
                                      onClick={() => void post("clone_dist_bus", { dist_bus_id: bus.id })}
                                      disabled={saving}
                                      className="text-slate-400 hover:text-sky-400 disabled:opacity-30 text-xs">⧉</button>
                                    <button
                                      onClick={() => {
                                        if (!window.confirm("Sei sicuro di voler rimuovere questo bus di distribuzione Ischia? Le assegnazioni collegate potrebbero essere eliminate o rigenerate.")) return;
                                        void post("remove_dist_bus", { dist_bus_id: bus.id });
                                      }}
                                      disabled={saving}
                                      className="text-slate-400 hover:text-rose-400 disabled:opacity-30 text-xs">✕</button>
                                  </div>
                                </div>
                                <div className="mt-1 flex items-center gap-2">
                                  <div className="h-1.5 flex-1 rounded-full bg-slate-600">
                                    <div className="h-1.5 rounded-full bg-violet-400" style={{ width: `${Math.min(pct, 100)}%` }} />
                                  </div>
                                  <span className="text-xs text-slate-300">{totalPax}/{bus.capacity}</span>
                                </div>
                              </div>

                              {/* Veicolo + Autista */}
                              <div className="border-b border-slate-100 px-3 py-2 space-y-1.5">
                                {editDistBusId === bus.id ? (() => {
                                  const driverMatches = payload.ischia_dist_drivers.filter((d) =>
                                    distDriverQuery.length >= 2 && d.full_name.toLowerCase().includes(distDriverQuery.toLowerCase())
                                  );
                                  const exactMatch = payload.ischia_dist_drivers.find((d) => d.full_name.toLowerCase() === distDriverQuery.toLowerCase());
                                  const showCreate = distDriverQuery.length >= 2 && !exactMatch;
                                  return (
                                    <div className="space-y-1.5">
                                      {/* Veicolo dalla flotta */}
                                      <select
                                        value={distVehicleId}
                                        onChange={(e) => setDistVehicleId(e.target.value)}
                                        className="w-full rounded border border-slate-200 px-2 py-1 text-xs text-slate-700">
                                        <option value="">— Seleziona veicolo —</option>
                                        {payload.ischia_dist_vehicles.map((v) => (
                                          <option key={v.id} value={v.id}>{v.label} · {v.plate} ({v.capacity}p.)</option>
                                        ))}
                                      </select>
                                      {/* Autocomplete autista */}
                                      <div className="relative">
                                        <input
                                          value={distDriverQuery}
                                          onChange={(e) => setDistDriverQuery(e.target.value)}
                                          placeholder="Cerca autista..."
                                          className="w-full rounded border border-slate-200 px-2 py-1 text-xs" />
                                        {driverMatches.length > 0 && (
                                          <div className="absolute left-0 right-0 top-full z-20 rounded border border-slate-200 bg-white shadow-md">
                                            {driverMatches.map((d) => (
                                              <button key={d.id}
                                                onClick={() => {
                                                  void post("update_dist_bus", { dist_bus_id: bus.id, driver_profile_id: d.id, driver_name: d.full_name, driver_phone: d.phone ?? null, vehicle_id: distVehicleId || null });
                                                  setEditDistBusId(null); setDistDriverQuery(""); setDistVehicleId("");
                                                }}
                                                className="block w-full px-3 py-1.5 text-left text-xs hover:bg-slate-50">
                                                👤 {d.full_name}{d.phone ? ` · ${d.phone}` : ""}
                                              </button>
                                            ))}
                                          </div>
                                        )}
                                        {showCreate && driverMatches.length === 0 && (
                                          <div className="absolute left-0 right-0 top-full z-20 rounded border border-violet-200 bg-violet-50 shadow-md">
                                            <button
                                              onClick={() => {
                                                const phone = window.prompt(`Telefono di ${distDriverQuery} (lascia vuoto se non disponibile):`) ?? "";
                                                void post("create_driver_profile", { full_name: distDriverQuery, phone: phone || null, dist_bus_id: bus.id });
                                                if (distVehicleId) void post("update_dist_bus", { dist_bus_id: bus.id, vehicle_id: distVehicleId });
                                                setEditDistBusId(null); setDistDriverQuery(""); setDistVehicleId("");
                                              }}
                                              className="block w-full px-3 py-1.5 text-left text-xs font-semibold text-violet-700 hover:bg-violet-100">
                                              ＋ Aggiungi &quot;{distDriverQuery}&quot; come nuovo autista
                                            </button>
                                          </div>
                                        )}
                                      </div>
                                      <div className="flex gap-1 pt-0.5">
                                        <button
                                          onClick={() => {
                                            void post("update_dist_bus", { dist_bus_id: bus.id, vehicle_id: distVehicleId || null });
                                            setEditDistBusId(null); setDistDriverQuery(""); setDistVehicleId("");
                                          }}
                                          className="flex-1 rounded bg-slate-800 py-0.5 text-xs text-white">Salva</button>
                                        <button onClick={() => { setEditDistBusId(null); setDistDriverQuery(""); setDistVehicleId(""); }} className="rounded px-2 py-0.5 text-xs text-slate-400">✕</button>
                                      </div>
                                    </div>
                                  );
                                })() : (
                                  <button
                                    onClick={() => { setEditDistBusId(bus.id); setDistVehicleId(bus.vehicle_id ?? ""); setDistDriverQuery(bus.driver_name ?? ""); }}
                                    className="w-full text-left text-xs text-slate-500 hover:text-slate-800 space-y-0.5">
                                    {bus.vehicle_id
                                      ? <div>🚌 {payload.ischia_dist_vehicles.find((v) => v.id === bus.vehicle_id)?.label ?? "Veicolo"}</div>
                                      : <div className="text-slate-300">＋ Assegna veicolo</div>
                                    }
                                    {bus.driver_name
                                      ? <div>👤 {bus.driver_name}{bus.driver_phone ? ` · ${bus.driver_phone}` : ""}</div>
                                      : <div className="text-slate-300">＋ Assegna autista</div>
                                    }
                                  </button>
                                )}
                              </div>

                              {/* Passeggeri */}
                              <div className="flex-1 space-y-1 overflow-y-auto p-2" style={{ maxHeight: 320 }}>
                                {busAllocs.length === 0 && (
                                  <p className="py-4 text-center text-xs text-slate-300">Trascina qui i passeggeri</p>
                                )}
                                {[...busAllocs].sort((a, b) => (a.stop_order ?? 0) - (b.stop_order ?? 0)).map((alloc) => (
                                  <div key={alloc.id}>
                                    {/* Indicatore visivo di inserimento sopra questa card */}
                                    {dragReorderTargetId === alloc.id && dragDistAllocId && busAllocs.some(a => a.id === dragDistAllocId) && (
                                      <div className="h-0.5 w-full rounded-full bg-violet-500 mb-1" />
                                    )}
                                    <div
                                      draggable
                                      onDragStart={() => { setDragDistAllocId(alloc.id); setDragReorderTargetId(null); }}
                                      onDragEnd={() => { setDragDistAllocId(null); setDragReorderTargetId(null); }}
                                      onDragOver={(e) => {
                                        e.preventDefault();
                                        // Mostra indicatore riordino solo se stiamo trascinando dal STESSO bus
                                        if (dragDistAllocId && dragDistAllocId !== alloc.id && busAllocs.some(a => a.id === dragDistAllocId)) {
                                          e.stopPropagation(); // Non attivare il bus container
                                          setDragReorderTargetId(alloc.id);
                                          setDragOverDistBusId(null);
                                        }
                                      }}
                                      onDragLeave={() => setDragReorderTargetId(null)}
                                      onDrop={(e) => {
                                        e.preventDefault();
                                        if (!dragDistAllocId || dragDistAllocId === alloc.id) return;
                                        const isFromSameBus = busAllocs.some(a => a.id === dragDistAllocId);
                                        if (isFromSameBus) {
                                          e.stopPropagation(); // Impedisce al bus container di chiamare move_dist
                                          void post("reorder_dist_alloc", {
                                            allocation_id: dragDistAllocId,
                                            before_allocation_id: alloc.id,
                                          });
                                          setDragDistAllocId(null);
                                          setDragReorderTargetId(null);
                                        }
                                        // Se da bus diverso: NON stopPropagation → gestisce il bus container
                                      }}
                                      className={`cursor-grab rounded-lg border px-2 py-1.5 text-xs transition-opacity ${dragDistAllocId === alloc.id ? "opacity-40" : "border-slate-200 bg-slate-50 hover:border-violet-200 hover:bg-violet-50"}`}>
                                      <div className="flex items-center justify-between gap-1">
                                        <div className="flex items-center gap-1 min-w-0">
                                          <span className="shrink-0 rounded bg-slate-200 px-1 text-[9px] font-bold text-slate-500">{(alloc.stop_order ?? 0) + 1}</span>
                                          <span className="font-semibold uppercase text-slate-800 truncate">{alloc.customer_name}</span>
                                        </div>
                                        <span className="shrink-0 rounded-full bg-slate-200 px-1.5 text-[10px] font-bold text-slate-600">{alloc.pax_assigned}</span>
                                      </div>
                                      <div className="mt-0.5 flex items-center gap-1">
                                        <span className={`truncate uppercase ${alloc.hotel_name === "Hotel N/D" ? "text-rose-400 font-medium" : "text-slate-400"}`}>{alloc.hotel_name}</span>
                                        {alloc.hotel_name === "Hotel N/D" && (
                                          <button
                                            onClick={() => { setEditHotelAllocId(alloc.id); setHotelSearchQuery(""); setNewHotelForm(null); }}
                                            className="shrink-0 rounded px-1 text-[10px] text-rose-500 hover:bg-rose-50">✏</button>
                                        )}
                                      </div>
                                    </div>
                                    {/* Hotel edit inline */}
                                    {editHotelAllocId === alloc.id && (() => {
                                      const hotelMatches = hotelSearchQuery.length >= 2
                                        ? payload.hotels_list.filter(h => h.name.toLowerCase().includes(hotelSearchQuery.toLowerCase()))
                                        : [];
                                      return (
                                        <div className="mt-1 rounded-lg border border-rose-200 bg-rose-50 p-2 text-xs">
                                          {newHotelForm ? (
                                            <div className="space-y-1">
                                              <input placeholder="Nome hotel *" value={newHotelForm.name} onChange={e => setNewHotelForm(f => f ? { ...f, name: e.target.value } : f)} className="w-full rounded border border-slate-200 px-2 py-1 text-xs" />
                                              <input placeholder="Indirizzo *" value={newHotelForm.address} onChange={e => setNewHotelForm(f => f ? { ...f, address: e.target.value } : f)} className="w-full rounded border border-slate-200 px-2 py-1 text-xs" />
                                              <select value={newHotelForm.zone} onChange={e => setNewHotelForm(f => f ? { ...f, zone: e.target.value } : f)} className="w-full rounded border border-slate-200 px-2 py-1 text-xs">
                                                {["ischia","barano","casamicciola","lacco","forio","sant'angelo","serrara"].map(z => <option key={z} value={z}>{z}</option>)}
                                              </select>
                                              <div className="flex gap-1 pt-1">
                                                <button onClick={() => { if (newHotelForm.name && newHotelForm.address) { void post("set_service_hotel", { allocation_id: alloc.id, new_hotel: { name: newHotelForm.name, address: newHotelForm.address, zone: newHotelForm.zone } }); setEditHotelAllocId(null); } }} disabled={saving || !newHotelForm.name || !newHotelForm.address} className="flex-1 rounded bg-rose-600 py-1 text-[10px] font-semibold text-white disabled:opacity-40">Crea e assegna</button>
                                                <button onClick={() => setNewHotelForm(null)} className="rounded border border-slate-200 px-2 py-1 text-[10px]">←</button>
                                              </div>
                                            </div>
                                          ) : (
                                            <div className="space-y-1">
                                              <input autoFocus placeholder="Cerca hotel..." value={hotelSearchQuery} onChange={e => setHotelSearchQuery(e.target.value)} className="w-full rounded border border-slate-200 px-2 py-1 text-xs" />
                                              {hotelMatches.map(h => (
                                                <button key={h.id} onClick={() => { void post("set_service_hotel", { allocation_id: alloc.id, hotel_id: h.id }); setEditHotelAllocId(null); }} className="w-full rounded border border-slate-200 bg-white px-2 py-1 text-left text-[10px] hover:bg-violet-50">
                                                  <span className="font-medium uppercase">{h.name}</span> <span className="text-slate-400">({h.zone})</span>
                                                </button>
                                              ))}
                                              <div className="flex gap-1 pt-0.5">
                                                <button onClick={() => setNewHotelForm({ name: hotelSearchQuery, address: "", zone: "ischia" })} className="flex-1 rounded border border-dashed border-rose-300 py-1 text-[10px] text-rose-600 hover:bg-rose-100">+ Crea nuovo hotel</button>
                                                <button onClick={() => setEditHotelAllocId(null)} className="rounded border border-slate-200 px-2 py-1 text-[10px]">✕</button>
                                              </div>
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })()}
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })}

                      {/* Aggiungi bus manuale nel gruppo */}
                      <div className="flex w-44 flex-shrink-0 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-200 p-4">
                        <span className="text-xs text-slate-400 text-center">Bus extra</span>
                        <button
                          onClick={() => {
                            const label = window.prompt("Etichetta bus (es. Bus Forio 2):");
                            const zone = window.prompt("Zona (es. forio, ischia, casamicciola):");
                            if (label && zone) void post("add_dist_bus", { date, label, zone, capacity: 50 });
                          }}
                          disabled={saving}
                          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40">
                          + Aggiungi bus
                        </button>
                      </div>
                    </div>
                        </div>
                      ))}
                    </div>
                    );
                  })()}
                </div>
              )}

              {/* ── Smistamento Pozzuoli ── */}
              {activeTab === "bus" && direction === "departure" && (
                <div className="mt-6">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="flex items-center gap-1.5 text-base font-bold text-slate-800"><FerryIcon size={22} /> Smistamento Pozzuoli</span>
                      <span className="text-xs text-slate-400">Bus continentali per le partenze da Ischia</span>
                    </div>
                  </div>

                  {payload.pozzuoli_dist_buses.filter((b) => b.date === date && (b.bus_line_id === selectedLine?.id || !b.bus_line_id)).length === 0 ? (
                    <div className="rounded-xl border-2 border-dashed border-slate-200 p-8 text-center text-sm text-slate-400">
                      Nessun bus smistamento Pozzuoli per questa linea. Aggiungili manualmente con il tasto qui sotto.
                    </div>
                  ) : (
                    <div className="flex gap-4 overflow-x-auto pb-2">
                      {payload.pozzuoli_dist_buses
                        .filter((b) => b.date === date && (b.bus_line_id === selectedLine?.id || !b.bus_line_id))
                        .sort((a, b) => a.sort_order - b.sort_order)
                        .map((bus) => {
                          const busAllocs = payload.ischia_dist_allocations.filter((a) => a.dist_bus_id === bus.id);
                          const totalPax = busAllocs.reduce((s, a) => s + a.pax_assigned, 0);
                          const pct = bus.capacity > 0 ? Math.round((totalPax / bus.capacity) * 100) : 0;
                          return (
                            <div key={bus.id} className="flex w-56 flex-shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-sm">
                              <div className="rounded-t-2xl bg-emerald-700 px-4 py-3 text-white">
                                <div className="flex items-center justify-between">
                                  <div className="min-w-0">
                                    <span className="font-bold text-sm truncate block max-w-[140px]">{bus.label}</span>
                                    {bus.zone && <span className="text-xs text-white/80">{bus.zone}</span>}
                                  </div>
                                  <div className="flex items-center gap-1.5">
                                    <button
                                      title="Clona bus"
                                      onClick={() => void post("clone_dist_bus", { dist_bus_id: bus.id })}
                                      disabled={saving}
                                      className="text-white/60 hover:text-sky-300 disabled:opacity-30 text-xs">⧉</button>
                                    <button
                                      onClick={() => {
                                        if (!window.confirm("Sei sicuro di voler rimuovere questo bus di distribuzione Ischia? Le assegnazioni collegate potrebbero essere eliminate o rigenerate.")) return;
                                        void post("remove_dist_bus", { dist_bus_id: bus.id });
                                      }}
                                      disabled={saving}
                                      className="text-white/60 hover:text-rose-300 disabled:opacity-30 text-xs">✕</button>
                                  </div>
                                </div>
                                <div className="mt-1 flex items-center gap-2">
                                  <div className="h-1.5 flex-1 rounded-full bg-slate-600">
                                    <div className="h-1.5 rounded-full bg-emerald-300" style={{ width: `${Math.min(pct, 100)}%` }} />
                                  </div>
                                  <span className="text-xs text-slate-300">{totalPax}/{bus.capacity}</span>
                                </div>
                              </div>
                              <div className="p-3 text-xs text-slate-500">
                                {bus.driver_name
                                  ? <div className="font-medium text-slate-700">👤 {bus.driver_name}</div>
                                  : <div className="italic text-slate-400">Autista da assegnare</div>}
                                {busAllocs.length === 0
                                  ? <div className="mt-2 text-center text-slate-300 italic">Nessun passeggero</div>
                                  : busAllocs.map((a) => (
                                      <div key={a.id} className="mt-1 flex items-center justify-between gap-1 rounded bg-slate-50 px-2 py-1">
                                        <span className="truncate">{a.customer_name}</span>
                                        <span className="shrink-0 font-semibold text-slate-600">{a.pax_assigned}p</span>
                                      </div>
                                    ))}
                              </div>
                            </div>
                          );
                        })}
                    </div>
                  )}

                  {/* Aggiungi bus Pozzuoli manuale */}
                  <div className="mt-3">
                    <button
                      onClick={() => {
                        const label = window.prompt("Etichetta bus (es. Bus Napoli Nord):");
                        const zone = window.prompt("Zona/destinazione (es. Napoli, Caserta, Roma):");
                        if (label && zone) void post("add_dist_bus", { date, label, zone, capacity: 50, section: "pozzuoli" });
                      }}
                      disabled={saving}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40">
                      + Aggiungi bus Pozzuoli
                    </button>
                  </div>
                </div>
              )}

              {/* Da validare panel */}
              {activeTab === "da_validare" && (() => {
                const linePending = payload.pending_passengers.filter(
                  (p) => p.bus_line_id === selectedLine?.id && p.direction === direction && p.travel_date === date
                );
                return (
                  <div className="space-y-3">
                    {linePending.length > 0 && (
                      <div className="flex justify-end">
                        <button
                          onClick={() => void post("clear_pending", { date, bus_line_id: selectedLine?.id, direction })}
                          className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs text-rose-600 hover:bg-rose-50"
                        >
                          🗑 Svuota tutti i da validare ({linePending.length})
                        </button>
                      </div>
                    )}
                    {linePending.length === 0 ? (
                      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-400">
                        Nessun passeggero da validare per questa linea e direzione.
                      </div>
                    ) : (
                      linePending.map((p) => (
                        <div key={p.id} className="flex items-center gap-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold uppercase text-slate-900">{p.passenger_name}</div>
                            <div className="text-sm text-slate-500">
                              Città: <span className="font-medium text-rose-600">{p.city_original}</span>
                              {p.geo_suggested_stop && (
                                <span className="ml-2 text-amber-600">· Suggerita: {p.geo_suggested_stop}</span>
                              )}
                            </div>
                            <div className="text-xs text-slate-400">
                              {p.pax} pax · {p.travel_date}
                              {p.passenger_phone && ` · ${p.passenger_phone}`}
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => {
                                setApprovePending(p);
                                setPendingNewStop(null);
                                const firstUnit = dateUnitLoads.filter((u) => u.status !== "closed").at(0);
                                setApproveUnitId(firstUnit?.id ?? "");
                                // pre-select geo-suggested stop, fallback to first stop
                                const suggestedStop = lineStops.find(
                                  (s) => p.geo_suggested_stop && s.stop_name.toLowerCase() === p.geo_suggested_stop.toLowerCase().trim()
                                ) ?? lineStops.find(
                                  (s) => s.city.toLowerCase() === p.city_original.toLowerCase().trim()
                                ) ?? lineStops[0];
                                setApproveStopId(suggestedStop?.id ?? "");
                              }}
                              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700">
                              Assegna
                            </button>
                            <button
                              onClick={() => void post("reject_pending", { pending_id: p.id })}
                              disabled={saving}
                              className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50">
                              Rifiuta
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                );
              })()}

              {/* Unassigned passengers */}
              {unassigned.length > 0 && (() => {
                const stopSummary = new Map<string, number>();
                let totalUnassignedPax = 0;
                for (const svc of unassigned) {
                  const city = (svc.bus_city_origin ?? "Sconosciuta").toUpperCase();
                  stopSummary.set(city, (stopSummary.get(city) ?? 0) + svc.pax);
                  totalUnassignedPax += svc.pax;
                }
                const stopOrderMap = new Map(lineStops.map(s => [s.stop_name.toUpperCase(), s.stop_order]));
                const sortedStops = [...stopSummary.entries()].sort((a, b) => (stopOrderMap.get(a[0]) ?? 999) - (stopOrderMap.get(b[0]) ?? 999));
                return (
                <SectionCard title={`👥 Da assegnare — ${selectedLine.name} (${unassigned.length} prenotazioni · ${totalUnassignedPax} pax)`}>
                  <div className="mb-3 flex flex-wrap gap-2 rounded-lg bg-slate-50 px-3 py-2.5">
                    {sortedStops.map(([city, pax]) => (
                      <span key={city} className="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-700 shadow-sm border border-slate-200">
                        <span className="uppercase">{city}</span>
                        <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700">{pax}</span>
                      </span>
                    ))}
                  </div>
                  <div className="divide-y divide-slate-100">
                    {unassigned.map((svc) => (
                      <div key={svc.id} className="flex items-center gap-3 px-1 py-3">
                        <div className="min-w-0 flex-1">
                          <span className="font-semibold uppercase text-slate-800">{svc.customer_display_name}</span>
                          <span className="ml-2 uppercase text-sm text-slate-500">{svc.hotel_name}</span>
                          <InlineCityEdit
                            serviceId={svc.id}
                            currentCity={svc.bus_city_origin ?? ""}
                            onSave={async (city) => { await post("update_service_city", { service_id: svc.id, bus_city_origin: city }); }}
                            saving={saving}
                          />
                          {svc.phone_display && (
                            <span className="ml-2 text-xs text-slate-400">{svc.phone_display}</span>
                          )}
                        </div>
                        <span className="text-sm text-slate-500">{svc.pax} pax</span>
                        <button onClick={() => openAssignModal(svc)}
                          className="btn-primary px-4 py-1.5 text-sm">
                          Assegna →
                        </button>
                      </div>
                    ))}
                  </div>
                </SectionCard>
                );
              })()}

              {/* Stop manager (collapsible) */}
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                <button onClick={() => setShowStopManager(!showStopManager)}
                  className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50">
                  <span>⚙ Gestisci fermate — {selectedLine.name} {direction === "arrival" ? "(Andata)" : "(Ritorno)"}</span>
                  <span className="text-slate-400">{showStopManager ? "▲" : "▼"}</span>
                </button>

                {showStopManager && (
                  <div className="space-y-4 border-t border-slate-100 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                        {direction === "arrival" ? "Fermate andata — dal nord verso il sud" : "Fermate ritorno — dal sud verso il nord"}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => void timeSortStops()} disabled={saving}
                          title="Riordina le fermate in base all'orario di partenza (crescente)"
                          className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40">
                          🕐 Riallinea per orario
                        </button>
                        <button onClick={() => void geoSortStops()} disabled={saving || geoSorting}
                          title="Geocodifica le fermate e le ordina automaticamente per latitudine (nord→sud)"
                          className="flex items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-100 disabled:opacity-40">
                          {geoSorting ? "⏳ Geocoding..." : "🌍 Ordina per geografia"}
                        </button>
                        <button onClick={() => setHideEmptyStops((v) => !v)}
                          className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50">
                          {hideEmptyStops ? "👁 Mostra tutte" : "👁 Nascondi vuote"}
                        </button>
                      </div>
                    </div>

                    <div className="space-y-1">
                      {payload.stops
                        .filter((s) => s.bus_line_id === selectedLine.id && s.direction === direction)
                        .sort((a, b) => a.stop_order - b.stop_order)
                        .map((stop, idx, arr) => {
                          const stopAllocs = dateAllocations
                            .filter((a) => a.stop_name.toLowerCase() === stop.stop_name.toLowerCase());
                          const stopPaxToday = stopAllocs.reduce((sum, a) => sum + a.pax_assigned, 0);
                          if (hideEmptyStops && stopPaxToday === 0) return null;
                          return (
                            <div key={stop.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
                              <span className="w-5 text-center text-xs tabular-nums text-slate-300">{stop.stop_order}</span>
                              <div className="min-w-0 flex-1">
                                {editStopNameId === stop.id ? (
                                  <div className="flex items-center gap-1">
                                    <input
                                      autoFocus
                                      value={editStopNameValue}
                                      onChange={(e) => setEditStopNameValue(e.target.value.toUpperCase())}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") void saveStopName(stop.id, editStopNameValue);
                                        if (e.key === "Escape") setEditStopNameId(null);
                                      }}
                                      className="rounded border border-indigo-300 px-1.5 py-0.5 text-sm font-medium uppercase focus:outline-none focus:ring-1 focus:ring-indigo-400" />
                                    <button onClick={() => void saveStopName(stop.id, editStopNameValue)} disabled={saving}
                                      className="rounded bg-indigo-600 px-1.5 py-0.5 text-[10px] text-white hover:bg-indigo-700 disabled:opacity-40">✓</button>
                                    <button onClick={() => setEditStopNameId(null)}
                                      className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-slate-300">✕</button>
                                  </div>
                                ) : (
                                  <button
                                    onClick={() => { setEditStopNameId(stop.id); setEditStopNameValue(stop.stop_name); }}
                                    title="Modifica nome fermata"
                                    className="text-sm font-medium uppercase text-slate-800 hover:text-indigo-600">
                                    {stop.stop_name}
                                  </button>
                                )}
                                {editStopNameId !== stop.id && stop.pickup_note && <span className="ml-1 text-xs text-slate-300">· {stop.pickup_note}</span>}
                                {stop.is_manual && <span className="ml-1 rounded bg-indigo-50 px-1 text-[10px] text-indigo-500">manuale</span>}
                                {stopAllocs.length > 0 && (
                                  <div className="mt-0.5 space-y-0.5 text-[10px] text-slate-400">
                                    {stopAllocs.map((a) => (
                                      <div key={a.allocation_id}>
                                        {a.customer_name} — {a.pax_assigned} pax — {a.bus_label} — <span className="font-medium text-amber-600">{a.service_date}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                              {stopPaxToday > 0 && (
                                <span className="rounded bg-emerald-50 px-2 text-xs font-medium text-emerald-700">{stopPaxToday} pax</span>
                              )}
                              {/* Orario editabile inline */}
                              {editStopTimeId === stop.id ? (
                                <div className="flex items-center gap-1">
                                  <input type="time" value={editStopTimeValue}
                                    onChange={(e) => setEditStopTimeValue(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") void saveStopTime(stop.id, editStopTimeValue);
                                      if (e.key === "Escape") setEditStopTimeId(null);
                                    }}
                                    autoFocus
                                    className="w-20 rounded border border-indigo-300 px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400" />
                                  <button onClick={() => void saveStopTime(stop.id, editStopTimeValue)} disabled={saving}
                                    className="rounded bg-indigo-600 px-1.5 py-0.5 text-[10px] text-white hover:bg-indigo-700 disabled:opacity-40">✓</button>
                                  <button onClick={() => setEditStopTimeId(null)}
                                    className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-slate-300">✕</button>
                                </div>
                              ) : (
                                <button onClick={() => { setEditStopTimeId(stop.id); setEditStopTimeValue(stop.pickup_time ?? ""); }}
                                  title="Modifica orario di partenza"
                                  className="min-w-[52px] rounded border border-slate-200 bg-white px-1.5 py-0.5 text-center text-xs text-slate-500 hover:border-indigo-300 hover:text-indigo-600">
                                  {stop.pickup_time ?? "⏱ orario"}
                                </button>
                              )}
                              <div className="flex gap-0.5">
                                <button onClick={() => void moveStopOrder(stop.id, "up")} disabled={idx === 0 || saving}
                                  className="rounded p-1 text-slate-400 hover:bg-white hover:text-slate-700 disabled:opacity-20">↑</button>
                                <button onClick={() => void moveStopOrder(stop.id, "down")} disabled={idx === arr.length - 1 || saving}
                                  className="rounded p-1 text-slate-400 hover:bg-white hover:text-slate-700 disabled:opacity-20">↓</button>
                              </div>
                            </div>
                          );
                        })}
                    </div>

                    {/* Add stop */}
                    <div className="flex gap-2">
                      <input value={newStopName} onChange={(e) => setNewStopName(e.target.value)}
                        placeholder="Nome fermata (es: FIRENZE)" onKeyDown={(e) => { if (e.key === "Enter") void addStop(); }}
                        className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm uppercase" />
                      <input value={newStopCity} onChange={(e) => setNewStopCity(e.target.value)}
                        placeholder="Città" onKeyDown={(e) => { if (e.key === "Enter") void addStop(); }}
                        className="w-28 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
                      <input type="time" value={newStopPickupTime} onChange={(e) => setNewStopPickupTime(e.target.value)}
                        title="Orario di partenza" onKeyDown={(e) => { if (e.key === "Enter") void addStop(); }}
                        className="w-24 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
                      <button onClick={() => void addStop()} disabled={saving || !newStopName.trim() || !newStopCity.trim()}
                        className="btn-secondary px-4 py-2 text-sm disabled:opacity-40">
                        + Fermata
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Move modal ── */}
      {moveModalOpen && moveSource && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md space-y-4 rounded-2xl bg-white p-6 shadow-2xl">
            <h2 className="text-lg font-bold text-slate-900">Sposta passeggero</h2>

            {/* Passenger summary */}
            <div className="space-y-1 rounded-xl bg-slate-50 p-4">
              <div className="text-base font-bold uppercase text-slate-900">{moveSource.customer_name}</div>
              {moveSource.hotel_name && (
                <div className="text-sm text-slate-600">Hotel: <span className="font-medium uppercase">{moveSource.hotel_name}</span></div>
              )}
              {moveSource.customer_phone && (
                <div className="text-sm text-slate-600">Tel: <span className="font-medium">{moveSource.customer_phone}</span></div>
              )}
              <div className="text-sm text-slate-600">Fermata: <span className="font-medium">{moveSource.stop_name}</span></div>
              <div className="text-sm text-slate-600">Bus attuale: <span className="font-medium">{moveSource.bus_label}</span></div>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Trasferisci a:</label>
              <select value={moveTargetUnitId} onChange={(e) => setMoveTargetUnitId(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300">
                <option value="">— Scegli bus —</option>
                {payload.lines.map((line) => {
                  const lineUnits = dateUnitLoads.filter((u) => u.bus_line_id === line.id && u.id !== moveSource.bus_unit_id && u.status !== "closed" && u.status !== "completed");
                  if (lineUnits.length === 0) return null;
                  return (
                    <optgroup key={line.id} label={line.name}>
                      {lineUnits.map((u) => (
                        <option key={u.id} value={u.id}>{u.label} — {u.remaining_seats} posti liberi</option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Pax da spostare (max {moveSource.pax_assigned}):</label>
              <input type="number" value={movePaxStr} onChange={(e) => setMovePaxStr(e.target.value)}
                min={1} max={moveSource.pax_assigned}
                className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300" />
            </div>

            {moveResidual !== null && (
              <div className={`rounded-lg px-3 py-2 text-sm font-medium ${moveResidual < 0 ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`}>
                {moveResidual < 0
                  ? `⚠ Capienza superata di ${Math.abs(moveResidual)} posti`
                  : `✓ Posti liberi dopo lo spostamento: ${moveResidual}`}
              </div>
            )}

            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Motivo (opzionale):</label>
              <input value={moveReason} onChange={(e) => setMoveReason(e.target.value)}
                placeholder="Es: richiesta cliente, bus pieno..."
                className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300" />
            </div>

            <div className="flex gap-3 pt-1">
              <button onClick={() => { setMoveModalOpen(false); setMoveSource(null); }}
                className="btn-secondary flex-1 py-2.5">Annulla</button>
              <button onClick={() => void confirmMove()}
                disabled={saving || !moveTargetUnitId || movePax < 1 || (moveResidual !== null && moveResidual < 0)}
                className="btn-primary flex-1 py-2.5 disabled:opacity-40">
                {saving ? "Spostamento..." : "Conferma"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Assign modal ── */}
      {assignModalOpen && assignService && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md space-y-4 rounded-2xl bg-white p-6 shadow-2xl">
            <h2 className="text-lg font-bold text-slate-900">Assegna a bus</h2>

            <div className="space-y-1 rounded-xl bg-slate-50 p-4">
              <div className="text-base font-bold uppercase text-slate-900">{assignService.customer_display_name}</div>
              <div className="text-sm text-slate-600">Hotel: <span className="font-medium uppercase">{assignService.hotel_name}</span></div>
              <div className="text-sm text-slate-600">Tel: <span className="font-medium">{assignService.phone_display}</span></div>
              <div className="text-sm text-slate-600">
                Città: <InlineCityEdit
                  serviceId={assignService.id}
                  currentCity={assignService.bus_city_origin ?? ""}
                  onSave={async (city) => { await post("update_service_city", { service_id: assignService.id, bus_city_origin: city }); }}
                  saving={saving}
                />
              </div>
              <div className="text-sm text-slate-600">Pax: <span className="font-medium">{assignService.pax}</span></div>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Linea:</label>
              <select value={assignLineId} onChange={(e) => onAssignLineChange(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300">
                {payload.lines.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Bus:</label>
              <select value={assignUnitId} onChange={(e) => setAssignUnitId(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300">
                {assignLineUnits.map((u) => (
                  <option key={u.id} value={u.id}>{u.label} — {u.remaining_seats} posti liberi</option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Fermata di salita:</label>
              <select value={assignStopId} onChange={(e) => setAssignStopId(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300">
                {assignLineStops.map((stop) => (
                  <option key={stop.id} value={stop.id}>{stop.stop_name}{stop.city && stop.city !== stop.stop_name ? ` (${stop.city})` : ""}</option>
                ))}
              </select>
              {assignCreatingStop && (
                <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
                  Creazione fermata in corso...
                </div>
              )}
            </div>

            <div className="flex gap-3 pt-1">
              <button onClick={() => { setAssignModalOpen(false); setAssignService(null); }}
                className="btn-secondary flex-1 py-2.5">Annulla</button>
              <button onClick={() => void confirmAssign()}
                disabled={saving || !assignUnitId || !assignStopId || !assignLineId}
                className="btn-primary flex-1 py-2.5 disabled:opacity-40">
                {saving ? "Assegnazione..." : "Assegna"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Reset modal ── */}
      {resetModalOpen && selectedLine && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-6 shadow-2xl">
            <h2 className="text-lg font-bold text-slate-900">Svuota {direction === "arrival" ? "Andata" : "Ritorno"} — {fmtDate(date)}</h2>
            <p className="text-sm text-slate-600">
              Questa operazione elimina tutte le allocazioni e i servizi bus di{" "}
              <span className="font-semibold">{selectedLine.name}</span> del{" "}
              <span className="font-semibold">{fmtDate(date)}</span> ({direction === "arrival" ? "Andata" : "Ritorno"}).
            </p>
            <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">
              ⚠ Tutte le allocazioni e i relativi servizi bus del {fmtDate(date)} verranno eliminati. Azione irreversibile.
            </p>
            <p className="text-xs text-slate-400">
              Dopo il reset puoi reimportare il file Excel dalla pagina Importa e rilanciare l&apos;assegnazione automatica.
            </p>
            <div className="flex gap-3 pt-1">
              <button onClick={() => setResetModalOpen(false)} className="btn-secondary flex-1 py-2.5">Annulla</button>
              <button onClick={() => void resetLineDate()} disabled={saving}
                className="flex-1 rounded-xl bg-rose-600 py-2.5 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-40">
                {saving ? "Eliminazione..." : "Conferma svuota"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Reset result banner ── */}
      {resetResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-6 shadow-2xl">
            <h2 className="text-lg font-bold text-emerald-700">✓ Reset completato</h2>
            <p className="text-sm text-slate-600">
              Eliminati <span className="font-semibold">{resetResult.allocations}</span> allocazioni
              e <span className="font-semibold">{resetResult.services}</span> servizi.
            </p>
            <p className="text-sm text-slate-600">
              Ora puoi reimportare il file Excel dalla pagina <span className="font-semibold">Importa</span> e poi rieseguire l&apos;assegnazione automatica.
            </p>
            <div className="flex gap-3 pt-1">
              <button onClick={() => setResetResult(null)} className="btn-secondary flex-1 py-2.5">Chiudi</button>
              <a href="/excel-import" className="flex-1 rounded-xl bg-indigo-600 py-2.5 text-center text-sm font-semibold text-white hover:bg-indigo-700">
                Vai a Importa →
              </a>
            </div>
          </div>
        </div>
      )}
      {/* ── Auto-assign result ── */}
      {autoAssignResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-6 shadow-2xl">
            <h2 className="text-lg font-bold text-emerald-700">⚡ Auto-assegnazione completata</h2>
            <p className="text-sm text-slate-600">
              Assegnati: <span className="font-semibold">{autoAssignResult.assigned}</span> servizi
              {autoAssignResult.skipped > 0 && (
                <> — Saltati: <span className="font-semibold text-amber-600">{autoAssignResult.skipped}</span></>
              )}
            </p>
            {autoAssignResult.skipped_detail.length > 0 && (
              <div className="max-h-40 overflow-y-auto rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 space-y-1">
                {autoAssignResult.skipped_detail.map((d, i) => (
                  <div key={i}><span className="font-semibold">{d.customerName}</span>: {d.reason}</div>
                ))}
              </div>
            )}
            <button onClick={() => setAutoAssignResult(null)} className="btn-primary w-full py-2.5">Chiudi</button>
          </div>
        </div>
      )}

      {/* ── Approva pending modal ── */}
      {approvePending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg space-y-4 rounded-2xl bg-white p-6 shadow-2xl">
            <h2 className="text-lg font-bold text-slate-900">Assegna passeggero</h2>
            <div className="rounded-xl bg-slate-50 p-4 space-y-1">
              <div className="font-bold uppercase text-slate-900">{approvePending.passenger_name}</div>
              <div className="text-sm text-slate-600">Città dichiarata: <span className="font-medium text-rose-600">{approvePending.city_original}</span></div>
              <div className="text-sm text-slate-600">Pax: <span className="font-medium">{approvePending.pax}</span> · Data: <span className="font-medium">{approvePending.travel_date}</span></div>
              {approvePending.notes && (
                <div className="text-xs text-slate-400">Note: {approvePending.notes}</div>
              )}
              {approvePending.geo_suggested_stop && (
                <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 mt-1">
                  <span className="text-sm text-amber-700">🗺 Fermata suggerita da geocoding: <strong>{approvePending.geo_suggested_stop}</strong></span>
                  <button
                    onClick={() => {
                      const s = lineStops.find((s) => s.stop_name.toLowerCase() === approvePending.geo_suggested_stop!.toLowerCase().trim());
                      if (s) setApproveStopId(s.id);
                    }}
                    className="ml-auto shrink-0 rounded-lg border border-amber-300 bg-white px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50">
                    Usa questa
                  </button>
                </div>
              )}
            </div>

            {!pendingNewStop ? (
              <>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-700">Fermata:</label>
                  <select value={approveStopId} onChange={(e) => setApproveStopId(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300">
                    {lineStops.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.stop_name}{s.city && s.city.toLowerCase() !== s.stop_name.toLowerCase() ? ` (${s.city})` : ""}{s.pickup_note ? ` — ${s.pickup_note}` : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={() => setPendingNewStop({
                    name: approvePending.city_original,
                    city: approvePending.city_original,
                    note: "",
                    afterStopId: lineStops.at(-1)?.id ?? ""
                  })}
                  className="w-full rounded-lg border border-dashed border-slate-300 py-2 text-xs font-medium text-slate-400 hover:border-indigo-300 hover:text-indigo-500">
                  + Crea nuova fermata per questa città
                </button>
              </>
            ) : (
              <div className="space-y-3 rounded-xl border border-indigo-200 bg-indigo-50 p-4">
                <div className="text-sm font-semibold text-indigo-800">Nuova fermata</div>
                <div className="flex gap-2">
                  <input
                    value={pendingNewStop.name}
                    onChange={(e) => setPendingNewStop((v) => v && { ...v, name: e.target.value })}
                    placeholder="Nome fermata"
                    className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm uppercase"
                  />
                  <input
                    value={pendingNewStop.city}
                    onChange={(e) => setPendingNewStop((v) => v && { ...v, city: e.target.value })}
                    placeholder="Città"
                    className="w-32 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                  />
                </div>
                <input
                  value={pendingNewStop.note}
                  onChange={(e) => setPendingNewStop((v) => v && { ...v, note: e.target.value })}
                  placeholder="Punto raccolta (es: Stazione FS) — opzionale"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                />
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-600">Inserisci dopo:</label>
                  <select
                    value={pendingNewStop.afterStopId}
                    onChange={(e) => setPendingNewStop((v) => v && { ...v, afterStopId: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
                    <option value="">— All&apos;inizio —</option>
                    {lineStops.map((s) => (
                      <option key={s.id} value={s.id}>{s.stop_order}. {s.stop_name}</option>
                    ))}
                  </select>
                </div>
                <button onClick={() => setPendingNewStop(null)} className="text-xs text-slate-400 hover:text-slate-600">
                  ← Torna alla selezione fermata esistente
                </button>
              </div>
            )}

            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Bus:</label>
              <select value={approveUnitId} onChange={(e) => setApproveUnitId(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300">
                {dateUnitLoads.filter((u) => u.status !== "closed" && u.status !== "completed").map((u) => (
                  <option key={u.id} value={u.id}>{u.label} — {u.remaining_seats} posti liberi</option>
                ))}
              </select>
            </div>
            <div className="flex gap-3 pt-1">
              <button onClick={() => { setApprovePending(null); setPendingNewStop(null); }} className="btn-secondary flex-1 py-2.5">Annulla</button>
              {pendingNewStop ? (
                <button
                  onClick={() => void confirmApprovePendingWithNewStop()}
                  disabled={saving || !approveUnitId || !pendingNewStop.name.trim() || !pendingNewStop.city.trim()}
                  className="btn-primary flex-1 py-2.5 disabled:opacity-40">
                  {saving ? "Salvataggio..." : "Crea fermata e assegna"}
                </button>
              ) : (
                <button
                  onClick={async () => {
                    if (!approveUnitId || !approveStopId || !approvePending) return;
                    await post("approve_pending", {
                      pending_id: approvePending.id,
                      bus_unit_id: approveUnitId,
                      stop_id: approveStopId,
                      travel_date: approvePending.travel_date,
                    });
                    setApprovePending(null);
                  }}
                  disabled={saving || !approveUnitId || !approveStopId}
                  className="btn-primary flex-1 py-2.5 disabled:opacity-40">
                  {saving ? "Salvataggio..." : "Conferma assegnazione"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Transfer to another line modal (admin only) ── */}
      {transferAlloc && isAdmin && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md space-y-4 rounded-2xl bg-white p-6 shadow-2xl">
            <div>
              <h2 className="text-lg font-bold text-slate-900">Cambia linea</h2>
              <p className="text-xs text-slate-400 mt-0.5">Solo admin — sposta la prenotazione su un&apos;altra linea bus</p>
            </div>

            <div className="rounded-xl bg-slate-50 p-4 space-y-1">
              <div className="text-base font-bold uppercase text-slate-900">{transferAlloc.customer_name}</div>
              {transferAlloc.hotel_name && <div className="text-sm text-slate-600">Hotel: <span className="font-medium uppercase">{transferAlloc.hotel_name}</span></div>}
              <div className="text-sm text-slate-600">Linea attuale: <span className="font-medium">{transferAlloc.line_name}</span></div>
              <div className="text-sm text-slate-600">Bus attuale: <span className="font-medium">{transferAlloc.bus_label}</span></div>
              <div className="text-sm text-slate-600">Fermata attuale: <span className="font-medium">{transferAlloc.stop_name}</span></div>
              <div className="text-sm text-slate-600">Pax: <span className="font-medium">{transferAlloc.pax_assigned}</span></div>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Linea destinazione:</label>
              <select value={transferLineId}
                onChange={(e) => {
                  const lid = e.target.value;
                  setTransferLineId(lid);
                  const firstStop = payload.stops.find((s) => s.bus_line_id === lid && s.direction === direction);
                  setTransferStopId(firstStop?.id ?? "");
                  const firstUnit = payload.units.find((u) => u.bus_line_id === lid && u.status !== "closed" && u.status !== "completed");
                  setTransferUnitId(firstUnit?.id ?? "");
                }}
                className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-300">
                {payload.lines.filter((l) => l.id !== transferAlloc.bus_line_id).map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Fermata:</label>
              <select value={transferStopId} onChange={(e) => setTransferStopId(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-300">
                {transferTargetStops.length === 0
                  ? <option value="">— nessuna fermata —</option>
                  : transferTargetStops.map((s) => <option key={s.id} value={s.id}>{s.stop_name}{s.city && s.city !== s.stop_name ? ` (${s.city})` : ""}</option>)
                }
              </select>
              {transferStopMissing && transferAlloc && (
                <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2.5 text-sm">
                  <div className="font-medium text-amber-800">
                    La fermata &quot;{transferAlloc.stop_name}&quot; non esiste su questa linea.
                  </div>
                  <button
                    onClick={() => void createStopForTransfer()}
                    disabled={saving || transferCreatingStop}
                    className="mt-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-40">
                    {transferCreatingStop ? "Creazione..." : `Crea fermata "${transferAlloc.stop_name}" su questa linea`}
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Bus:</label>
              <select value={transferUnitId} onChange={(e) => setTransferUnitId(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-300">
                {transferTargetUnits.length === 0
                  ? <option value="">— nessun bus disponibile —</option>
                  : transferTargetUnits.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)
                }
              </select>
            </div>

            <div className="flex gap-3 pt-1">
              <button onClick={() => setTransferAlloc(null)}
                className="btn-secondary flex-1 py-2.5">Annulla</button>
              <button
                onClick={() => void confirmTransfer()}
                disabled={saving || !transferLineId || !transferUnitId || !transferStopId}
                className="flex-1 rounded-lg bg-violet-600 py-2.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-40">
                {saving ? "Trasferimento..." : "Conferma trasferimento"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Import modal ── */}
      {importModalOpen && (
        <BusImportModal
          allLines={payload.lines}
          allStops={payload.stops}
          hotelsList={payload.hotels_list}
          direction={direction}
          date={date}
          onClose={() => setImportModalOpen(false)}
          onImported={() => { setImportModalOpen(false); void load(); }}
        />
      )}
    </div>
  );
}
