"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import BusImportModal from "./BusImportModal";

type BusLine = { id: string; code: string; name: string; family_code: string; family_name: string; variant_label?: string | null };
type BusStop = { id: string; bus_line_id: string; direction: "arrival" | "departure"; stop_name: string; city: string; pickup_note?: string | null; pickup_time?: string | null; stop_order: number; is_manual: boolean };
type BusUnit = { id: string; bus_line_id: string; label: string; capacity: number; low_seat_threshold: number; minimum_passengers?: number | null; status: "open" | "low" | "closed" | "completed"; manual_close: boolean; close_reason?: string | null; driver_name?: string | null; driver_phone?: string | null };
type BusAllocation = { id: string; service_id: string; bus_line_id: string; bus_unit_id: string; stop_id?: string | null; stop_name: string; direction: "arrival" | "departure"; pax_assigned: number };
type BusMove = { id: string; service_id: string; from_bus_unit_id?: string | null; to_bus_unit_id?: string | null; stop_name?: string | null; pax_moved: number; reason?: string | null; created_at: string; customer_name?: string | null; customer_phone?: string | null; hotel_name?: string | null; source_bus_label?: string | null; target_bus_label?: string | null; moved_full_allocation?: boolean };
type AllocationDetail = { allocation_id: string; root_allocation_id: string; split_from_allocation_id?: string | null; service_id: string; bus_line_id: string; line_code: string; line_name: string; family_code: string; family_name: string; bus_unit_id: string; bus_label: string; stop_id?: string | null; stop_name: string; stop_city?: string | null; stop_pickup_note?: string | null; stop_pickup_time?: string | null; direction: "arrival" | "departure"; pax_assigned: number; service_date: string; service_time: string; customer_name: string; customer_phone?: string | null; hotel_name?: string | null; agency_name?: string | null; notes?: string | null; created_at?: string };
type BusService = { id: string; customer_name: string; customer_display_name: string; date: string; time: string; pax: number; direction: "arrival" | "departure"; bus_city_origin?: string | null; transport_code?: string | null; phone_display: string; hotel_name: string; derived_family_code: string; derived_family_name: string; derived_line_code?: string | null; derived_line_name?: string | null; suggested_stop_name?: string | null };
type UnitLoad = BusUnit & { pax_assigned: number; remaining_seats: number; suggested_status: string };
type StopLoad = BusStop & { pax_assigned: number };
type PendingPassenger = { id: string; bus_line_id: string; direction: "arrival" | "departure"; travel_date: string; passenger_name: string; passenger_phone: string | null; city_original: string; pax: number; notes: string | null; geo_suggested_stop: string | null; created_at: string };
type ApiPayload = { lines: BusLine[]; stops: BusStop[]; units: BusUnit[]; allocations: BusAllocation[]; allocation_details: AllocationDetail[]; moves: BusMove[]; services: BusService[]; unit_loads: UnitLoad[]; stop_loads: StopLoad[]; redistribution_suggestions: Array<{ source_label: string; target_label: string | null; reason: string }>; geographic_suggestions: Array<{ service_id: string; customer_name: string; stop_name: string; grouped_zone: string; suggested_vehicle_type: string; suggested_stop_order: number | null }>; arrival_windows: Array<{ time: string; totalPax: number; snavPax: number; medmarPax: number; otherPax: number }>; pending_passengers: PendingPassenger[]; user_role?: string };

const emptyPayload: ApiPayload = { lines: [], stops: [], units: [], allocations: [], allocation_details: [], moves: [], services: [], unit_loads: [], stop_loads: [], redistribution_suggestions: [], geographic_suggestions: [], arrival_windows: [], pending_passengers: [], user_role: undefined };

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
  const [assignUnitId, setAssignUnitId] = useState("");
  const [assignStopId, setAssignStopId] = useState("");
  const [assignModalOpen, setAssignModalOpen] = useState(false);

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

  // Edit stop inline (nome e orario)
  const [editStopTimeId, setEditStopTimeId] = useState<string | null>(null);
  const [editStopTimeValue, setEditStopTimeValue] = useState("");
  const [editStopNameId, setEditStopNameId] = useState<string | null>(null);
  const [editStopNameValue, setEditStopNameValue] = useState("");

  // Geo sort progress
  const [geoSorting, setGeoSorting] = useState(false);

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

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) { setLoading(false); setMessage("Sessione non valida."); return; }
    const res = await fetch("/api/ops/bus-network", { headers: { Authorization: `Bearer ${token}` } });
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
      user_role: (body as { user_role?: string }).user_role ?? undefined,
    };
    setPayload(next);
    setSelectedLineId((cur) => (cur && next.lines.some((l) => l.id === cur)) ? cur : (next.lines[0]?.id ?? ""));
    setLoading(false);
  }, []);

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
  const isAdmin = payload.user_role === "admin";
  const selectedLine = payload.lines.find((l) => l.id === selectedLineId) ?? null;

  const lineUnits = useMemo(
    () => payload.unit_loads.filter((u) => u.bus_line_id === selectedLine?.id),
    [payload.unit_loads, selectedLine]
  );

  const lineStops = useMemo(
    () => payload.stops
      .filter((s) => s.bus_line_id === selectedLine?.id && s.direction === direction)
      .sort((a, b) => a.stop_order - b.stop_order),
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

  // --- Actions ---
  const openTransferModal = useCallback((alloc: AllocationDetail) => {
    setTransferAlloc(alloc);
    const otherLines = payload.lines.filter((l) => l.id !== alloc.bus_line_id);
    const firstLine = otherLines[0];
    const firstLineId = firstLine?.id ?? "";
    setTransferLineId(firstLineId);
    const firstStop = payload.stops.find((s) => s.bus_line_id === firstLineId && s.direction === direction);
    setTransferStopId(firstStop?.id ?? "");
    const firstUnit = payload.units.find((u) => u.bus_line_id === firstLineId && u.status !== "closed" && u.status !== "completed");
    setTransferUnitId(firstUnit?.id ?? "");
  }, [payload.lines, payload.stops, payload.units, direction]);

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

  const openAssignModal = useCallback((svc: BusService) => {
    setAssignService(svc);
    const available = dateUnitLoads.filter((u) => u.status !== "closed" && u.status !== "completed");
    setAssignUnitId(available[0]?.id ?? "");
    const suggestedStop = lineStops.find((s) => s.stop_name === svc.suggested_stop_name) ?? lineStops[0] ?? null;
    setAssignStopId(suggestedStop?.id ?? "");
    setAssignModalOpen(true);
  }, [dateUnitLoads, lineStops]);

  const confirmMove = useCallback(async () => {
    if (!moveSource || !moveTargetUnitId) return;
    const pax = Number(movePaxStr);
    if (!pax || pax < 1) return;
    await post("move_allocation", { allocation_id: moveSource.allocation_id, to_bus_unit_id: moveTargetUnitId, pax_moved: pax, reason: moveReason || null });
    setMoveModalOpen(false);
    setMoveSource(null);
  }, [moveSource, moveTargetUnitId, movePaxStr, moveReason, post]);

  const confirmAssign = useCallback(async () => {
    if (!assignService || !assignUnitId || !assignStopId) return;
    const stop = lineStops.find((s) => s.id === assignStopId);
    if (!stop) return;
    await post("allocate_service", {
      service_id: assignService.id, bus_line_id: selectedLine?.id,
      bus_unit_id: assignUnitId, direction: assignService.direction,
      stop_name: stop.stop_name, stop_id: stop.id, pax_assigned: assignService.pax
    });
    setAssignModalOpen(false);
    setAssignService(null);
  }, [assignService, assignUnitId, assignStopId, lineStops, selectedLine, post]);

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
    await post("update_stop_time", { stop_id: stopId, pickup_time: time.trim() || null });
    setEditStopTimeId(null);
  }, [post]);

  const geoSortStops = useCallback(async () => {
    if (!selectedLine) return;
    setGeoSorting(true);
    const res = await post("geo_sort_stops", { bus_line_id: selectedLine.id, direction, date }) as ({ geocoded?: number; skipped?: number; skipped_names?: string } | null);
    setGeoSorting(false);
    if (res) {
      const msg = `Ordinamento geografico: ${res.geocoded ?? 0} fermate ordinate per latitudine.`;
      const skip = res.skipped ?? 0;
      setMessage(skip > 0 ? `${msg} ${skip} non geocodificate (messe in fondo): ${res.skipped_names ?? ""}` : msg);
    }
  }, [selectedLine, direction, post]);

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
    const existing = payload.stops.filter((s) => s.bus_line_id === selectedLine.id && s.direction === direction);
    const maxOrder = existing.reduce((max, s) => Math.max(max, s.stop_order), 0);
    await post("add_stop", {
      bus_line_id: selectedLine.id, direction,
      stop_name: newStopName.trim().toUpperCase(), city: newStopCity.trim(),
      pickup_time: newStopPickupTime.trim() || null,
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
    unit: { label: string; driver_name?: string | null; driver_phone?: string | null },
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
        Incasso: "",
        Note: cleanNote,
        Pranzo: "",
        Agenzia: alloc.agency_name || agencyFromNotes || "",
        Linea: lineName,
        Bus: unit.label,
        Autista: unit.driver_name ?? "",
      };
    });
  }

  const colWidths = [
    { wch: 8 },  // Orario
    { wch: 36 }, // Punto di carico
    { wch: 7 },  // N° pax
    { wch: 30 }, // Nominativo
    { wch: 16 }, // Cell.
    { wch: 28 }, // Hotel destinazione
    { wch: 10 }, // Incasso
    { wch: 22 }, // Note
    { wch: 8 },  // Pranzo
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
    const rows: Record<string, string | number>[] = [];
    for (const { unit, allocations: cardAllocs } of busCards) {
      rows.push(...buildAllocRows(unit, cardAllocs, selectedLine?.name ?? "", lineStopsForExport));
    }
    const ws = utils.json_to_sheet(rows);
    ws["!cols"] = colWidths;
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, (selectedLine?.name ?? "Bus").slice(0, 31));
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
      const rows = buildAllocRows(targetCard.unit, dirAllocs, lineName, stopsForDir);
      const ws = utils.json_to_sheet(rows);
      ws["!cols"] = colWidths;
      utils.book_append_sheet(wb, ws, dir === "arrival" ? "Andata" : "Ritorno");
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
          const rows = buildAllocRows(unit, unitAllocs, line.name, stopsForDir);
          const ws = utils.json_to_sheet(rows);
          ws["!cols"] = colWidths;
          // Nome foglio univoco ≤ 31 char: LineaCode_BusLabel_Dir
          const lineShort = (line.code ?? line.name).slice(0, 14);
          const busShort = unit.label.replace(/\s+/g, "").slice(0, 12);
          let sheetName = `${lineShort}_${busShort}_${dirLabel}`.slice(0, 31);
          // Evita duplicati (Excel non permette fogli con lo stesso nome)
          if (usedNames.has(sheetName)) {
            sheetName = sheetName.slice(0, 28) + String(usedNames.size).padStart(2, "0");
          }
          usedNames.add(sheetName);
          utils.book_append_sheet(wb, ws, sheetName);
        }
      }
    }
    if (wb.SheetNames.length === 0) return;
    writeFile(wb, `bus_tutte_linee_${date}.xlsx`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, date]);

  const saveDriver = useCallback(async (unitId: string) => {
    await post("update_driver", { unit_id: unitId, driver_name: editDriverName.trim() || null, driver_phone: editDriverPhone.trim() || null });
    setEditDriverUnitId("");
  }, [post, editDriverName, editDriverPhone]);

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
          <input type="date" value={date}
            min="2024-01-01"
            max={`${new Date().getFullYear() + 1}-12-31`}
            onChange={(e) => { if (e.target.value) setDate(e.target.value); }}
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
                  (p) => p.bus_line_id === selectedLine?.id && p.direction === direction
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
              {activeTab === "bus" && (
                <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                  <button
                    onClick={() => setShowRouteStrip((v) => !v)}
                    className="flex w-full items-center justify-between px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-slate-500 hover:bg-slate-50">
                    <span>🗺 Percorso — {lineStops.length} fermate</span>
                    <span className="text-slate-300">{showRouteStrip ? "▲" : "▼"}</span>
                  </button>
                  {showRouteStrip && (
                    <div className="overflow-x-auto border-t border-slate-100 px-3 py-3">
                      <div className="flex min-w-max items-start gap-0">
                        {lineStops.map((stop, idx) => {
                          const stopPax = dateAllocations
                            .filter((a) => a.stop_name.toLowerCase() === stop.stop_name.toLowerCase())
                            .reduce((sum, a) => sum + a.pax_assigned, 0);
                          const hasPax = stopPax > 0;
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
                                  <span className="mt-1 rounded-full bg-emerald-600 px-1.5 text-[10px] font-bold text-white">{stopPax} pax</span>
                                )}
                                <div className="mt-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                                  <button onClick={() => void moveStopOrder(stop.id, "up")} disabled={idx === 0 || saving}
                                    className="rounded p-0.5 text-[10px] text-slate-300 hover:text-slate-700 disabled:opacity-20">↑</button>
                                  <button onClick={() => void moveStopOrder(stop.id, "down")} disabled={idx === lineStops.length - 1 || saving}
                                    className="rounded p-0.5 text-[10px] text-slate-300 hover:text-slate-700 disabled:opacity-20">↓</button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                        {lineStops.length === 0 && (
                          <div className="py-2 text-xs italic text-slate-300">Nessuna fermata. Usa &quot;Gestisci fermate&quot; per aggiungerne.</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Bus cards */}
              {activeTab === "bus" && <div className="flex gap-4 overflow-x-auto pb-2">
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
                      onDragOver={(e) => { e.preventDefault(); setDragOverUnitId(unit.id); }}
                      onDragLeave={() => setDragOverUnitId("")}
                      onDrop={(e) => { e.preventDefault(); handleDrop(unit.id); }}
                      onClick={() => setSelectedBusUnitId(isSelected ? null : unit.id)}
                      className={`relative flex w-72 flex-shrink-0 flex-col rounded-2xl border-2 bg-white shadow-sm transition-all cursor-pointer ${
                        isSelected ? "border-indigo-500 ring-2 ring-indigo-200" :
                        dragOverUnitId === unit.id ? "border-indigo-400 bg-indigo-50 shadow-indigo-100" :
                        isClosed ? "border-slate-200 opacity-60" :
                        isFull ? "border-rose-300" :
                        isLow ? "border-amber-300" : "border-slate-200"
                      }`}>

                      {/* Header */}
                      <div className="rounded-t-2xl border-b border-slate-100 px-4 py-3">
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
                              className="w-40 rounded border border-indigo-300 bg-indigo-50 px-2 py-0.5 text-base font-bold uppercase tracking-wide text-slate-900 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                            />
                          ) : (
                            <span
                              className="cursor-text text-base font-bold uppercase tracking-wide text-slate-900 hover:text-indigo-600"
                              title="Clicca per rinominare"
                              onClick={(e) => { e.stopPropagation(); setEditLabelUnitId(unit.id); setEditLabelValue(unit.label); }}
                            >{unit.label}</span>
                          )}
                          {isClosed ? (
                            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs text-slate-600">CHIUSO</span>
                          ) : isFull ? (
                            <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">PIENO</span>
                          ) : isLow ? (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">⚠ {remainingSeats} posti</span>
                          ) : (
                            <span className="text-xs text-slate-400">{remainingSeats} liberi</span>
                          )}
                        </div>
                        {/* Capacity bar */}
                        <div className="mt-2 flex items-center gap-2">
                          <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                            <div
                              className={`h-2 rounded-full transition-all ${isFull ? "bg-rose-400" : isLow ? "bg-amber-400" : "bg-emerald-400"}`}
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
                              className="w-16 rounded border border-indigo-300 bg-indigo-50 px-1 py-0.5 text-right text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-indigo-400"
                            />
                          ) : (
                            <span
                              className="w-14 cursor-pointer text-right text-xs tabular-nums text-slate-500 hover:text-indigo-600"
                              title="Clicca per modificare capienza"
                              onClick={(e) => { e.stopPropagation(); setEditCapUnitId(unit.id); setEditCapValue(String(unit.capacity)); }}
                            >{paxTotal}/{unit.capacity}</span>
                          )}
                        </div>
                        {/* Driver info */}
                        {editDriverUnitId === unit.id ? (
                          <div className="mt-2 flex gap-1">
                            <input value={editDriverName} onChange={(e) => setEditDriverName(e.target.value)}
                              placeholder="Nome autista" className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1 text-xs" />
                            <input value={editDriverPhone} onChange={(e) => setEditDriverPhone(e.target.value)}
                              placeholder="Telefono" className="w-24 rounded border border-slate-200 px-2 py-1 text-xs" />
                            <button onClick={() => void saveDriver(unit.id)} disabled={saving}
                              className="rounded bg-indigo-600 px-2 py-1 text-xs text-white hover:bg-indigo-700 disabled:opacity-40">✓</button>
                            <button onClick={() => setEditDriverUnitId("")} className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-600 hover:bg-slate-200">✕</button>
                          </div>
                        ) : (
                          <button onClick={() => { setEditDriverUnitId(unit.id); setEditDriverName(unit.driver_name ?? ""); setEditDriverPhone(unit.driver_phone ?? ""); }}
                            className="mt-1.5 flex w-full items-center gap-1 text-left text-xs text-slate-400 hover:text-slate-600">
                            🚗 {unit.driver_name ? <span className="font-medium text-slate-600">{unit.driver_name}{unit.driver_phone ? ` · ${unit.driver_phone}` : ""}</span> : <span className="italic">Aggiungi autista</span>}
                          </button>
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
                                  <div className="truncate text-xs uppercase text-slate-400">{alloc.hotel_name ?? "—"}</div>
                                  {alloc.customer_phone && (
                                    <div className="text-xs text-slate-300">{alloc.customer_phone}</div>
                                  )}
                                </div>
                                <div className="flex flex-shrink-0 flex-col items-end gap-1">
                                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
                                    {alloc.pax_assigned} pax
                                  </span>
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
                                <div className="truncate text-xs uppercase text-slate-400">{alloc.hotel_name ?? "—"}</div>
                              </div>
                              <div className="flex flex-shrink-0 flex-col items-end gap-1">
                                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">{alloc.pax_assigned} pax</span>
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

              {/* Da validare panel */}
              {activeTab === "da_validare" && (() => {
                const linePending = payload.pending_passengers.filter(
                  (p) => p.bus_line_id === selectedLine?.id && p.direction === direction
                );
                return (
                  <div className="space-y-3">
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
              {unassigned.length > 0 && (
                <SectionCard title={`👥 Da assegnare — ${selectedLine.name} (${unassigned.length})`}>
                  <div className="divide-y divide-slate-100">
                    {unassigned.map((svc) => (
                      <div key={svc.id} className="flex items-center gap-3 px-1 py-3">
                        <div className="min-w-0 flex-1">
                          <span className="font-semibold uppercase text-slate-800">{svc.customer_display_name}</span>
                          <span className="ml-2 uppercase text-sm text-slate-500">{svc.hotel_name}</span>
                          {svc.bus_city_origin && (
                            <span className="ml-2 text-xs text-slate-400">· {svc.bus_city_origin}</span>
                          )}
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
              )}

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
              {assignService.bus_city_origin && (
                <div className="text-sm text-slate-600">Città: <span className="font-medium">{assignService.bus_city_origin}</span></div>
              )}
              <div className="text-sm text-slate-600">Pax: <span className="font-medium">{assignService.pax}</span></div>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Bus:</label>
              <select value={assignUnitId} onChange={(e) => setAssignUnitId(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300">
                {dateUnitLoads.filter((u) => u.status !== "closed" && u.status !== "completed").map((u) => (
                  <option key={u.id} value={u.id}>{u.label} — {u.remaining_seats} posti liberi</option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Fermata di salita:</label>
              <select value={assignStopId} onChange={(e) => setAssignStopId(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300">
                {lineStops.map((stop) => (
                  <option key={stop.id} value={stop.id}>{stop.stop_name} — {stop.city}</option>
                ))}
              </select>
            </div>

            <div className="flex gap-3 pt-1">
              <button onClick={() => { setAssignModalOpen(false); setAssignService(null); }}
                className="btn-secondary flex-1 py-2.5">Annulla</button>
              <button onClick={() => void confirmAssign()}
                disabled={saving || !assignUnitId || !assignStopId}
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
          direction={direction}
          date={date}
          onClose={() => setImportModalOpen(false)}
          onImported={() => { setImportModalOpen(false); void load(); }}
        />
      )}
    </div>
  );
}
