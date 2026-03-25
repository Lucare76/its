"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type BusLine = { id: string; code: string; name: string; family_code: string; family_name: string; variant_label?: string | null };
type BusStop = { id: string; bus_line_id: string; direction: "arrival" | "departure"; stop_name: string; city: string; pickup_note?: string | null; stop_order: number; is_manual: boolean };
type BusUnit = { id: string; bus_line_id: string; label: string; capacity: number; low_seat_threshold: number; minimum_passengers?: number | null; status: "open" | "low" | "closed" | "completed"; manual_close: boolean; close_reason?: string | null; driver_name?: string | null; driver_phone?: string | null };
type BusAllocation = { id: string; service_id: string; bus_line_id: string; bus_unit_id: string; stop_id?: string | null; stop_name: string; direction: "arrival" | "departure"; pax_assigned: number };
type BusMove = { id: string; service_id: string; from_bus_unit_id?: string | null; to_bus_unit_id?: string | null; stop_name?: string | null; pax_moved: number; reason?: string | null; created_at: string; customer_name?: string | null; customer_phone?: string | null; hotel_name?: string | null; source_bus_label?: string | null; target_bus_label?: string | null; moved_full_allocation?: boolean };
type AllocationDetail = { allocation_id: string; root_allocation_id: string; split_from_allocation_id?: string | null; service_id: string; bus_line_id: string; line_code: string; line_name: string; family_code: string; family_name: string; bus_unit_id: string; bus_label: string; stop_id?: string | null; stop_name: string; stop_city?: string | null; direction: "arrival" | "departure"; pax_assigned: number; service_date: string; service_time: string; customer_name: string; customer_phone?: string | null; hotel_name?: string | null; notes?: string | null; created_at?: string };
type BusService = { id: string; customer_name: string; customer_display_name: string; date: string; time: string; pax: number; direction: "arrival" | "departure"; bus_city_origin?: string | null; transport_code?: string | null; phone_display: string; hotel_name: string; derived_family_code: string; derived_family_name: string; derived_line_code?: string | null; derived_line_name?: string | null; suggested_stop_name?: string | null };
type UnitLoad = BusUnit & { pax_assigned: number; remaining_seats: number; suggested_status: string };
type StopLoad = BusStop & { pax_assigned: number };
type ApiPayload = { lines: BusLine[]; stops: BusStop[]; units: BusUnit[]; allocations: BusAllocation[]; allocation_details: AllocationDetail[]; moves: BusMove[]; services: BusService[]; unit_loads: UnitLoad[]; stop_loads: StopLoad[]; redistribution_suggestions: Array<{ source_label: string; target_label: string | null; reason: string }>; geographic_suggestions: Array<{ service_id: string; customer_name: string; stop_name: string; grouped_zone: string; suggested_vehicle_type: string; suggested_stop_order: number | null }>; arrival_windows: Array<{ time: string; totalPax: number; snavPax: number; medmarPax: number; otherPax: number }> };

const emptyPayload: ApiPayload = { lines: [], stops: [], units: [], allocations: [], allocation_details: [], moves: [], services: [], unit_loads: [], stop_loads: [], redistribution_suggestions: [], geographic_suggestions: [], arrival_windows: [] };

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

  // Stop manager
  const [showStopManager, setShowStopManager] = useState(false);
  const [hideEmptyStops, setHideEmptyStops] = useState(false);
  const [newStopName, setNewStopName] = useState("");
  const [newStopCity, setNewStopCity] = useState("");
  const [newUnitLabel, setNewUnitLabel] = useState("");
  const [dragOverUnitId, setDragOverUnitId] = useState("");

  // Driver editing
  const [editDriverUnitId, setEditDriverUnitId] = useState("");
  const [editDriverName, setEditDriverName] = useState("");
  const [editDriverPhone, setEditDriverPhone] = useState("");

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
      arrival_windows: body.arrival_windows ?? []
    };
    setPayload(next);
    setSelectedLineId((cur) => (cur && next.lines.some((l) => l.id === cur)) ? cur : (next.lines[0]?.id ?? ""));
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

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
      arrival_windows: body.arrival_windows ?? []
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

  // --- Derived data ---
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

  // Allocations for this date + direction + line
  const dateAllocations = useMemo(
    () => payload.allocation_details.filter(
      (a) => a.bus_line_id === selectedLine?.id && a.service_date === date && a.direction === direction
    ),
    [payload.allocation_details, selectedLine, date, direction]
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

  // Per-unit loads filtered by date (capacity must be evaluated per date, not across all dates)
  const dateUnitLoads = useMemo(
    () => lineUnits.map((unit) => {
      const datePax = dateAllocations
        .filter((a) => a.bus_unit_id === unit.id)
        .reduce((sum, a) => sum + a.pax_assigned, 0);
      return { ...unit, pax_assigned: datePax, remaining_seats: Math.max(0, unit.capacity - datePax) };
    }),
    [lineUnits, dateAllocations]
  );

  // Bus cards
  const busCards = useMemo(
    () => dateUnitLoads.map((unit) => ({
      unit,
      allocations: dateAllocations.filter((a) => a.bus_unit_id === unit.id)
    })),
    [dateUnitLoads, dateAllocations]
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
    return { ...line, paxToday, unassignedToday };
  }), [payload.lines, payload.allocation_details, payload.services, date, direction, allocatedServiceIds]);

  const totalPaxToday = dateAllocations.reduce((sum, a) => sum + a.pax_assigned, 0);

  // --- Actions ---
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
      stop_order: maxOrder + 1, pickup_note: null, lat: null, lng: null
    });
    setNewStopName("");
    setNewStopCity("");
  }, [newStopName, newStopCity, selectedLine, direction, payload.stops, post]);

  const moveStopOrder = useCallback(async (stopId: string, shift: "up" | "down") => {
    if (!selectedLine) return;
    const sorted = payload.stops
      .filter((s) => s.bus_line_id === selectedLine.id && s.direction === direction)
      .sort((a, b) => a.stop_order - b.stop_order);
    const idx = sorted.findIndex((s) => s.id === stopId);
    if (idx < 0) return;
    const swapIdx = shift === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    const reordered = sorted.map((s) => s.id);
    [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];
    await post("reorder_stops", { bus_line_id: selectedLine.id, direction, stop_ids: reordered });
  }, [selectedLine, payload.stops, direction, post]);

  const exportExcel = useCallback(async () => {
    const { utils, writeFile } = await import("xlsx");
    const rows: Record<string, string | number>[] = [];
    for (const { unit, allocations: cardAllocs } of busCards) {
      for (const alloc of cardAllocs) {
        rows.push({
          Bus: unit.label,
          Autista: unit.driver_name ?? "",
          "Tel. Autista": unit.driver_phone ?? "",
          Fermata: alloc.stop_name,
          Cliente: alloc.customer_name,
          Hotel: alloc.hotel_name ?? "",
          Telefono: alloc.customer_phone ?? "",
          Pax: alloc.pax_assigned,
          Data: date,
          Direzione: direction === "arrival" ? "Andata" : "Ritorno"
        });
      }
    }
    const ws = utils.json_to_sheet(rows);
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, "Bus");
    writeFile(wb, `bus_${selectedLine?.code ?? "export"}_${date}_${direction}.xlsx`);
  }, [busCards, date, direction, selectedLine]);

  const saveDriver = useCallback(async (unitId: string) => {
    await post("update_driver", { unit_id: unitId, driver_name: editDriverName.trim() || null, driver_phone: editDriverPhone.trim() || null });
    setEditDriverUnitId("");
  }, [post, editDriverName, editDriverPhone]);

  const handleDragStart = useCallback((alloc: AllocationDetail) => { setMoveSource(alloc); }, []);
  const handleDrop = useCallback((targetUnitId: string) => {
    setDragOverUnitId("");
    if (!moveSource || moveSource.bus_unit_id === targetUnitId) return;
    const target = dateUnitLoads.find((u) => u.id === targetUnitId && u.status !== "closed" && u.status !== "completed");
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
          <input type="date" value={date} onChange={(e) => { if (e.target.value) setDate(e.target.value); }}
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
            <button key={line.id} onClick={() => setSelectedLineId(line.id)}
              className={`w-full border-b border-slate-100 px-3 py-3 text-left transition-colors hover:bg-white ${
                selectedLineId === line.id ? "border-l-4 border-l-indigo-500 bg-white font-semibold text-indigo-700" : "text-slate-700"
              }`}>
              <div className="text-sm font-medium leading-tight">{line.name}</div>
              {line.paxToday > 0 && <div className="mt-0.5 text-xs text-slate-400">{line.paxToday} pax</div>}
              {line.unassignedToday > 0 && (
                <div className="mt-0.5 text-xs font-medium text-amber-600">{line.unassignedToday} da assegnare</div>
              )}
            </button>
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
                </p>
                <button onClick={() => exportExcel()} className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">
                  📥 Esporta Excel
                </button>
              </div>

              {/* Bus cards */}
              <div className="flex gap-4 overflow-x-auto pb-2">
                {busCards.map(({ unit, allocations: cardAllocs }) => {
                  const paxTotal = cardAllocs.reduce((sum, a) => sum + a.pax_assigned, 0);
                  const pct = unit.capacity > 0 ? Math.round((paxTotal / unit.capacity) * 100) : 0;
                  const isLow = unit.remaining_seats <= unit.low_seat_threshold && unit.remaining_seats > 0;
                  const isFull = unit.remaining_seats <= 0;
                  const isClosed = unit.status === "closed" || unit.status === "completed";

                  // Group by stop in correct order
                  const stopGroups = activeStops.map((stop) => ({
                    stop,
                    allocs: cardAllocs.filter((a) => a.stop_name === stop.stop_name)
                  })).filter((g) => g.allocs.length > 0);

                  // Allocations at stops not in the active list
                  const ungrouped = cardAllocs.filter(
                    (a) => !activeStops.some((s) => s.stop_name === a.stop_name)
                  );

                  return (
                    <div key={unit.id}
                      onDragOver={(e) => { e.preventDefault(); setDragOverUnitId(unit.id); }}
                      onDragLeave={() => setDragOverUnitId("")}
                      onDrop={() => handleDrop(unit.id)}
                      className={`relative flex w-72 flex-shrink-0 flex-col rounded-2xl border-2 bg-white shadow-sm transition-all ${
                        dragOverUnitId === unit.id ? "border-indigo-400 bg-indigo-50 shadow-indigo-100" :
                        isClosed ? "border-slate-200 opacity-60" :
                        isFull ? "border-rose-300" :
                        isLow ? "border-amber-300" : "border-slate-200"
                      }`}>

                      {/* Header */}
                      <div className="rounded-t-2xl border-b border-slate-100 px-4 py-3">
                        <div className="flex items-center justify-between">
                          <span className="text-base font-bold uppercase tracking-wide text-slate-900">{unit.label}</span>
                          {isClosed ? (
                            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs text-slate-600">CHIUSO</span>
                          ) : isFull ? (
                            <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">PIENO</span>
                          ) : isLow ? (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">⚠ {unit.remaining_seats} posti</span>
                          ) : (
                            <span className="text-xs text-slate-400">{unit.remaining_seats} liberi</span>
                          )}
                        </div>
                        {/* Capacity bar */}
                        <div className="mt-2 flex items-center gap-2">
                          <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                            <div
                              className={`h-2 rounded-full transition-all ${isFull ? "bg-rose-400" : isLow ? "bg-amber-400" : "bg-emerald-400"}`}
                              style={{ width: `${Math.min(100, pct)}%` }} />
                          </div>
                          <span className="w-14 text-right text-xs tabular-nums text-slate-500">{paxTotal}/{unit.capacity}</span>
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
                      <div className="flex-1 divide-y divide-slate-50 overflow-y-auto">
                        {[...stopGroups.map(({ stop, allocs }) => (
                          <div key={stop.id} className="px-3 py-2">
                            <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                              📍 {stop.stop_name}
                              {stop.city && stop.city.toLowerCase() !== stop.stop_name.toLowerCase() && (
                                <span className="ml-1 font-normal normal-case text-slate-300">({stop.city})</span>
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
                                  <button onClick={() => openMoveModal(alloc)}
                                    className="rounded border border-indigo-200 px-1.5 py-0.5 text-xs text-indigo-600 opacity-0 transition-opacity hover:bg-indigo-50 group-hover:opacity-100">
                                    Sposta
                                  </button>
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
                                <button onClick={() => openMoveModal(alloc)}
                                  className="rounded border border-indigo-200 px-1.5 py-0.5 text-xs text-indigo-600 opacity-0 transition-opacity hover:bg-indigo-50 group-hover:opacity-100">
                                  Sposta
                                </button>
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
              </div>

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
                    <div className="flex items-center justify-between">
                      <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                        {direction === "arrival" ? "Fermate andata — dal nord verso il sud" : "Fermate ritorno — dal sud verso il nord"}
                      </div>
                      <button onClick={() => setHideEmptyStops((v) => !v)}
                        className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50">
                        {hideEmptyStops ? "👁 Mostra tutte" : "👁 Nascondi vuote"}
                      </button>
                    </div>

                    <div className="space-y-1">
                      {payload.stops
                        .filter((s) => s.bus_line_id === selectedLine.id && s.direction === direction)
                        .sort((a, b) => a.stop_order - b.stop_order)
                        .map((stop, idx, arr) => {
                          const stopPaxToday = dateAllocations
                            .filter((a) => a.stop_name.toLowerCase() === stop.stop_name.toLowerCase())
                            .reduce((sum, a) => sum + a.pax_assigned, 0);
                          if (hideEmptyStops && stopPaxToday === 0) return null;
                          return (
                            <div key={stop.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
                              <span className="w-5 text-center text-xs tabular-nums text-slate-300">{stop.stop_order}</span>
                              <div className="min-w-0 flex-1">
                                <span className="text-sm font-medium uppercase text-slate-800">{stop.stop_name}</span>
                                {stop.city && <span className="ml-2 text-xs text-slate-400">{stop.city}</span>}
                                {stop.pickup_note && <span className="ml-1 text-xs text-slate-300">· {stop.pickup_note}</span>}
                                {stop.is_manual && <span className="ml-1 rounded bg-indigo-50 px-1 text-[10px] text-indigo-500">manuale</span>}
                              </div>
                              {stopPaxToday > 0 && (
                                <span className="rounded bg-emerald-50 px-2 text-xs font-medium text-emerald-700">{stopPaxToday} pax</span>
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
                {dateUnitLoads
                  .filter((u) => u.id !== moveSource.bus_unit_id && u.status !== "closed" && u.status !== "completed")
                  .map((u) => (
                    <option key={u.id} value={u.id}>{u.label} — {u.remaining_seats} posti liberi</option>
                  ))}
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
    </div>
  );
}
