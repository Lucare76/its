"use client";

import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type BusLine = {
  id: string;
  code: string;
  name: string;
  family_code: string;
  family_name: string;
  variant_label?: string | null;
};

type BusStop = {
  id: string;
  bus_line_id: string;
  direction: "arrival" | "departure";
  stop_name: string;
  city: string;
  pickup_note?: string | null;
  stop_order: number;
  is_manual: boolean;
};

type BusUnit = {
  id: string;
  bus_line_id: string;
  label: string;
  capacity: number;
  low_seat_threshold: number;
  minimum_passengers?: number | null;
  status: "open" | "low" | "closed" | "completed";
  manual_close: boolean;
  close_reason?: string | null;
};

type BusAllocation = {
  id: string;
  service_id: string;
  bus_line_id: string;
  bus_unit_id: string;
  stop_id?: string | null;
  stop_name: string;
  direction: "arrival" | "departure";
  pax_assigned: number;
};

type BusMove = {
  id: string;
  service_id: string;
  from_bus_unit_id?: string | null;
  to_bus_unit_id?: string | null;
  stop_name?: string | null;
  pax_moved: number;
  reason?: string | null;
  created_at: string;
  customer_name?: string | null;
  customer_phone?: string | null;
  hotel_name?: string | null;
  source_bus_label?: string | null;
  target_bus_label?: string | null;
  moved_full_allocation?: boolean;
};

type AllocationDetail = {
  allocation_id: string;
  root_allocation_id: string;
  split_from_allocation_id?: string | null;
  service_id: string;
  bus_line_id: string;
  line_code: string;
  line_name: string;
  family_code: string;
  family_name: string;
  bus_unit_id: string;
  bus_label: string;
  stop_id?: string | null;
  stop_name: string;
  stop_city?: string | null;
  direction: "arrival" | "departure";
  pax_assigned: number;
  service_date: string;
  service_time: string;
  customer_name: string;
  customer_phone?: string | null;
  hotel_name?: string | null;
  notes?: string | null;
  created_at?: string;
};

type BusService = {
  id: string;
  customer_name: string;
  customer_display_name: string;
  date: string;
  time: string;
  pax: number;
  direction: "arrival" | "departure";
  bus_city_origin?: string | null;
  transport_code?: string | null;
  phone_display: string;
  hotel_name: string;
  derived_family_code: string;
  derived_family_name: string;
  derived_line_code?: string | null;
  derived_line_name?: string | null;
  suggested_stop_name?: string | null;
};

type UnitLoad = BusUnit & { pax_assigned: number; remaining_seats: number; suggested_status: string };
type StopLoad = BusStop & { pax_assigned: number };

type ApiPayload = {
  lines: BusLine[];
  stops: BusStop[];
  units: BusUnit[];
  allocations: BusAllocation[];
  allocation_details: AllocationDetail[];
  moves: BusMove[];
  services: BusService[];
  unit_loads: UnitLoad[];
  stop_loads: StopLoad[];
  redistribution_suggestions: Array<{ source_label: string; target_label: string | null; reason: string }>;
  geographic_suggestions: Array<{ service_id: string; customer_name: string; stop_name: string; grouped_zone: string; suggested_vehicle_type: string; suggested_stop_order: number | null }>;
  arrival_windows: Array<{ time: string; totalPax: number; snavPax: number; medmarPax: number; otherPax: number }>;
};

const emptyPayload: ApiPayload = {
  lines: [],
  stops: [],
  units: [],
  allocations: [],
  allocation_details: [],
  moves: [],
  services: [],
  unit_loads: [],
  stop_loads: [],
  redistribution_suggestions: [],
  geographic_suggestions: [],
  arrival_windows: []
};

async function getAccessToken() {
  if (!hasSupabaseEnv || !supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

function directionLabel(direction: "arrival" | "departure") {
  return direction === "arrival" ? "Andata" : "Ritorno";
}

function nextWeekdayIso(targetDay: number) {
  const today = new Date();
  const result = new Date(today);
  const delta = (targetDay - today.getDay() + 7) % 7;
  result.setDate(today.getDate() + delta);
  return result.toISOString().slice(0, 10);
}

export default function BusNetworkPage() {
  const [payload, setPayload] = useState<ApiPayload>(emptyPayload);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("Rete bus nazionale: linee, fermate, capienza e ridistribuzione prenotazioni.");
  const [selectedLineId, setSelectedLineId] = useState("");
  const [selectedServiceId, setSelectedServiceId] = useState("");
  const [selectedUnitId, setSelectedUnitId] = useState("");
  const [selectedStopId, setSelectedStopId] = useState("");
  const [selectedAllocationId, setSelectedAllocationId] = useState("");
  const [moveTargetUnitId, setMoveTargetUnitId] = useState("");
  const [movePax, setMovePax] = useState("");
  const [moveReason, setMoveReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [newUnitLabel, setNewUnitLabel] = useState("");
  const [newStopName, setNewStopName] = useState("");
  const [newStopCity, setNewStopCity] = useState("");
  const [newArrivalStopOrder, setNewArrivalStopOrder] = useState("1");
  const [newDepartureStopOrder, setNewDepartureStopOrder] = useState("1");
  const [compareDateA, setCompareDateA] = useState(() => nextWeekdayIso(5));
  const [compareDateB, setCompareDateB] = useState(() => nextWeekdayIso(6));
  const [draggedAllocationId, setDraggedAllocationId] = useState("");
  const [moveModalOpen, setMoveModalOpen] = useState(false);
  const [draggedStopId, setDraggedStopId] = useState("");

  const load = useEffectEvent(async () => {
    const token = await getAccessToken();
    if (!token) {
      setLoading(false);
      setMessage("Sessione non valida.");
      return;
    }
    const response = await fetch("/api/ops/bus-network", {
      headers: { Authorization: `Bearer ${token}` }
    });
    const body = (await response.json().catch(() => null)) as ({ ok?: boolean; error?: string } & Partial<ApiPayload>) | null;
    if (!response.ok || !body?.ok) {
      setLoading(false);
      setMessage(body?.error ?? "Errore caricamento rete bus.");
      return;
    }

    const nextPayload: ApiPayload = {
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

    setPayload(nextPayload);
    setSelectedLineId((current) => {
      if (current && nextPayload.lines.some((line) => line.id === current)) return current;
      return nextPayload.lines[0]?.id || "";
    });
    setLoading(false);
  });

  useEffect(() => {
    void load();
  }, []);

  const selectedLine = payload.lines.find((line) => line.id === selectedLineId) ?? payload.lines[0] ?? null;
  const selectedUnits = payload.unit_loads.filter((unit) => unit.bus_line_id === selectedLine?.id);
  const selectedStops = payload.stop_loads.filter((stop) => stop.bus_line_id === selectedLine?.id);
  const selectedAllocations = payload.allocations.filter((allocation) => allocation.bus_line_id === selectedLine?.id);
  const selectedAllocationDetails = payload.allocation_details.filter((allocation) => allocation.bus_line_id === selectedLine?.id);
  const selectedMoves = payload.moves.filter((move) => {
    const fromMatch = move.from_bus_unit_id ? selectedUnits.some((unit) => unit.id === move.from_bus_unit_id) : false;
    const toMatch = move.to_bus_unit_id ? selectedUnits.some((unit) => unit.id === move.to_bus_unit_id) : false;
    return fromMatch || toMatch;
  });
  const selectedServices = payload.services.filter((service) => {
    if (!selectedLine) return false;
    if (payload.allocations.some((allocation) => allocation.service_id === service.id)) return false;
    return service.derived_family_code === selectedLine.family_code;
  });

  const selectedService = selectedServices.find((service) => service.id === selectedServiceId) ?? selectedServices[0] ?? null;
  const compatibleStops = selectedStops.filter((stop) => stop.direction === (selectedService?.direction ?? "arrival"));
  const selectedStop = compatibleStops.find((stop) => stop.id === selectedStopId) ?? null;
  const selectedUnit = selectedUnits.find((unit) => unit.id === selectedUnitId) ?? selectedUnits[0] ?? null;
  const selectedAllocation = selectedAllocations.find((allocation) => allocation.id === selectedAllocationId) ?? selectedAllocations[0] ?? null;
  const selectedAllocationDetail = selectedAllocationDetails.find((allocation) => allocation.allocation_id === selectedAllocation?.id) ?? selectedAllocationDetails[0] ?? null;
  const allocationService = payload.services.find((service) => service.id === selectedAllocation?.service_id) ?? null;
  const sourceUnit = selectedUnits.find((unit) => unit.id === selectedAllocation?.bus_unit_id) ?? null;
  const targetUnits = selectedUnits.filter((unit) => unit.id !== selectedAllocation?.bus_unit_id);
  const moveTargetUnit = targetUnits.find((unit) => unit.id === moveTargetUnitId) ?? targetUnits[0] ?? null;
  const selectedLineArrivalTotal = selectedStops.filter((stop) => stop.direction === "arrival").reduce((sum, stop) => sum + stop.pax_assigned, 0);
  const selectedLineDepartureTotal = selectedStops.filter((stop) => stop.direction === "departure").reduce((sum, stop) => sum + stop.pax_assigned, 0);

  const familySummary = useMemo(() => {
    const families = new Map<string, { lines: number; buses: number; pax: number }>();
    for (const line of payload.lines) {
      const lineUnits = payload.unit_loads.filter((unit) => unit.bus_line_id === line.id);
      const pax = lineUnits.reduce((sum, unit) => sum + unit.pax_assigned, 0);
      const current = families.get(line.family_name) ?? { lines: 0, buses: 0, pax: 0 };
      current.lines += 1;
      current.buses += lineUnits.length;
      current.pax += pax;
      families.set(line.family_name, current);
    }
    return Array.from(families.entries()).map(([family, info]) => ({ family, ...info }));
  }, [payload.lines, payload.unit_loads]);

  const defaultArrivalStopOrder = String(selectedStops.filter((stop) => stop.direction === "arrival").length + 1);
  const defaultDepartureStopOrder = String(selectedStops.filter((stop) => stop.direction === "departure").length + 1);
  const effectiveSelectedStop =
    compatibleStops.find((stop) => stop.id === selectedStopId) ??
    compatibleStops.find((stop) => stop.stop_name === selectedService?.suggested_stop_name) ??
    compatibleStops[0] ??
    null;
  const effectiveMovePaxValue = movePax || (selectedAllocation ? String(selectedAllocation.pax_assigned) : "");
  const movePreview = !selectedAllocation || !sourceUnit || !moveTargetUnit
    ? null
    : (() => {
        const requested = Number(effectiveMovePaxValue || "0");
        const effective = Number.isFinite(requested) && requested > 0 ? Math.min(requested, selectedAllocation.pax_assigned) : 0;
        return {
          available: selectedAllocation.pax_assigned,
          destinationResidual: moveTargetUnit.remaining_seats,
          sourceAfter: Math.max(0, selectedAllocation.pax_assigned - effective),
          destinationAfter: moveTargetUnit.remaining_seats - effective,
          effective
        };
      })();
  const moveWouldOverflow = Boolean(movePreview && movePreview.destinationAfter < 0);

  const allocationsByUnit = selectedUnits.map((unit) => ({
    unit,
    allocations: selectedAllocationDetails
      .filter((allocation) => allocation.bus_unit_id === unit.id)
      .sort((left, right) => {
        if (left.direction !== right.direction) return left.direction.localeCompare(right.direction);
        if (left.stop_name !== right.stop_name) return left.stop_name.localeCompare(right.stop_name);
        return `${left.service_date} ${left.service_time}`.localeCompare(`${right.service_date} ${right.service_time}`);
      })
  }));

  const stopComparisonRows = selectedStops
    .filter((stop) => stop.direction === "arrival")
    .map((stop) => {
      const paxA = selectedAllocationDetails
        .filter((allocation) => allocation.stop_name === stop.stop_name && allocation.direction === "arrival" && allocation.service_date === compareDateA)
        .reduce((sum, allocation) => sum + allocation.pax_assigned, 0);
      const paxB = selectedAllocationDetails
        .filter((allocation) => allocation.stop_name === stop.stop_name && allocation.direction === "arrival" && allocation.service_date === compareDateB)
        .reduce((sum, allocation) => sum + allocation.pax_assigned, 0);
      return {
        stop_name: stop.stop_name,
        city: stop.city,
        paxA,
        paxB,
        difference: paxB - paxA
      };
    });

  const reorderStops = async (direction: "arrival" | "departure", sourceId: string, targetId: string) => {
    if (!selectedLine || !sourceId || !targetId || sourceId === targetId) return;
    const current = selectedStops
      .filter((stop) => stop.direction === direction)
      .sort((left, right) => left.stop_order - right.stop_order);
    const sourceIndex = current.findIndex((stop) => stop.id === sourceId);
    const targetIndex = current.findIndex((stop) => stop.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const next = [...current];
    const [moved] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moved);
    await postAction({
      action: "reorder_stops",
      bus_line_id: selectedLine.id,
      direction,
      stop_ids: next.map((stop) => stop.id)
    });
  };

  const postAction = async (body: Record<string, unknown>) => {
    const token = await getAccessToken();
    if (!token) {
      setMessage("Sessione non valida.");
      return false;
    }
    setSaving(true);
    const response = await fetch("/api/ops/bus-network", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    });
    const json = (await response.json().catch(() => null)) as ({ ok?: boolean; error?: string } & Partial<ApiPayload>) | null;
    if (!response.ok || !json?.ok) {
      setSaving(false);
      setMessage(json?.error ?? "Operazione non riuscita.");
      return false;
    }
    setPayload({
      lines: json.lines ?? [],
      stops: json.stops ?? [],
      units: json.units ?? [],
      allocations: json.allocations ?? [],
      allocation_details: json.allocation_details ?? [],
      moves: json.moves ?? [],
      services: json.services ?? [],
      unit_loads: json.unit_loads ?? [],
      stop_loads: json.stop_loads ?? [],
      redistribution_suggestions: json.redistribution_suggestions ?? [],
      geographic_suggestions: json.geographic_suggestions ?? [],
      arrival_windows: json.arrival_windows ?? []
    });
    setSelectedLineId((current) => {
      const nextLines = json.lines ?? [];
      if (current && nextLines.some((line) => line.id === current)) return current;
      return nextLines[0]?.id ?? "";
    });
    setSaving(false);
    setMessage("Operazione completata.");
    return true;
  };

  if (loading) {
    return <section className="page-section"><p className="text-sm text-muted">Caricamento rete bus...</p></section>;
  }

  return (
    <section className="page-section">
      <PageHeader
        title="Rete Bus Nazionale"
        subtitle="Linee, bus, fermate, capienza e spostamenti prenotazioni con controllo operativo."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Rete Bus" }]}
        actions={
          <button type="button" className="btn-primary px-4 py-2 text-sm" disabled={saving} onClick={() => void postAction({ action: "bootstrap_defaults" })}>
            {saving ? "Preparazione..." : "Precarica linee base"}
          </button>
        }
      />

      <p className="text-sm text-muted">{message}</p>

      <div className="grid gap-3 md:grid-cols-4">
        <SectionCard title="Linee operative"><p className="text-3xl font-semibold text-text">{payload.lines.length}</p></SectionCard>
        <SectionCard title="Bus configurati"><p className="text-3xl font-semibold text-text">{payload.unit_loads.length}</p></SectionCard>
        <SectionCard title="Pax assegnati"><p className="text-3xl font-semibold text-text">{payload.allocations.reduce((sum, allocation) => sum + allocation.pax_assigned, 0)}</p></SectionCard>
        <SectionCard title="Fermate gestite"><p className="text-3xl font-semibold text-text">{payload.stop_loads.length}</p></SectionCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
        <SectionCard title="Famiglie linee" subtitle="Bootstrap iniziale richiesto dal cliente">
          <div className="space-y-3">
            {familySummary.map((family) => (
              <article key={family.family} className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm">
                <p className="font-semibold">{family.family}</p>
                <p className="text-muted">{family.lines} linee / {family.buses} bus / {family.pax} pax assegnati</p>
              </article>
            ))}
            {familySummary.length === 0 ? <p className="text-sm text-muted">Nessuna linea precaricata ancora.</p> : null}
          </div>
        </SectionCard>

        <SectionCard title="Report arrivi a orario" subtitle="Formula SNAV / MEDMAR / altri vettori">
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Ora</th>
                  <th className="px-3 py-2">Tot pax</th>
                  <th className="px-3 py-2">SNAV</th>
                  <th className="px-3 py-2">MEDMAR</th>
                  <th className="px-3 py-2">Altri</th>
                </tr>
              </thead>
              <tbody>
                {payload.arrival_windows.map((item) => (
                  <tr key={item.time} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-medium">{item.time}</td>
                    <td className="px-3 py-2">{item.totalPax}</td>
                    <td className="px-3 py-2">{item.snavPax}</td>
                    <td className="px-3 py-2">{item.medmarPax}</td>
                    <td className="px-3 py-2">{item.otherPax}</td>
                  </tr>
                ))}
                {payload.arrival_windows.length === 0 ? (
                  <tr><td colSpan={5} className="px-3 py-4 text-sm text-muted">Nessun arrivo aggregato disponibile.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </SectionCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <SectionCard title="Linee nazionali" subtitle="Italia, Centro, Adriatica e varianti">
          <div className="space-y-2">
            {payload.lines.map((line) => (
              <button
                key={line.id}
                type="button"
                className={`w-full rounded-xl border px-4 py-3 text-left ${selectedLine?.id === line.id ? "border-blue-300 bg-blue-50/60" : "border-border bg-white"}`}
                onClick={() => {
                  setSelectedLineId(line.id);
                  setSelectedServiceId("");
                  setSelectedUnitId("");
                  setSelectedStopId("");
                  setSelectedAllocationId("");
                  setMoveTargetUnitId("");
                  setMovePax("");
                  setMoveReason("");
                  const nextStops = payload.stop_loads.filter((stop) => stop.bus_line_id === line.id);
                  setNewArrivalStopOrder(String(nextStops.filter((stop) => stop.direction === "arrival").length + 1));
                  setNewDepartureStopOrder(String(nextStops.filter((stop) => stop.direction === "departure").length + 1));
                }}
              >
                <p className="font-semibold">{line.name}</p>
                <p className="text-xs text-muted">{line.family_name} | {line.variant_label ?? "Variante standard"}</p>
              </button>
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Bus della linea" subtitle="Capienza, ultimi 5 posti e chiusura manuale">
          {!selectedLine ? (
            <p className="text-sm text-muted">Seleziona una linea.</p>
          ) : (
            <div className="space-y-3">
              <div className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm">
                <p className="font-semibold">{selectedLine.name}</p>
                <p className="text-muted">
                  Famiglia {selectedLine.family_name}. Andata {selectedLineArrivalTotal} pax / ritorno {selectedLineDepartureTotal} pax.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <input className="input-saas max-w-52" placeholder="Nuovo bus (es. ITALIA 6)" value={newUnitLabel} onChange={(event) => setNewUnitLabel(event.target.value)} />
                <button
                  type="button"
                  className="btn-secondary px-3 py-2 text-sm"
                  disabled={saving || !newUnitLabel.trim()}
                  onClick={() =>
                    void postAction({ action: "add_unit", bus_line_id: selectedLine.id, label: newUnitLabel.trim(), capacity: 54 }).then((ok) => {
                      if (ok) setNewUnitLabel("");
                    })
                  }
                >
                  Aggiungi bus
                </button>
              </div>
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Bus</th>
                      <th className="px-3 py-2">Cap</th>
                      <th className="px-3 py-2">Residui</th>
                      <th className="px-3 py-2">Alert</th>
                      <th className="px-3 py-2">Stato</th>
                      <th className="px-3 py-2">Azione rapida</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedUnits.map((unit) => (
                      <tr key={unit.id} className="border-t border-slate-100">
                        <td className="px-3 py-2 font-medium">{unit.label}</td>
                        <td className="px-3 py-2">{unit.capacity}</td>
                        <td className="px-3 py-2">{unit.remaining_seats}</td>
                        <td className="px-3 py-2">{unit.remaining_seats <= unit.low_seat_threshold ? `Ultimi ${unit.low_seat_threshold}` : "OK"}</td>
                        <td className="px-3 py-2">{unit.status} / suggerito {unit.suggested_status}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-2">
                            <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => void postAction({ action: "update_unit", unit_id: unit.id, capacity: unit.capacity, low_seat_threshold: unit.low_seat_threshold, minimum_passengers: unit.minimum_passengers ?? null, status: "closed", close_reason: "Chiusura manuale operatore" })}>Chiudi</button>
                            <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => void postAction({ action: "update_unit", unit_id: unit.id, capacity: unit.capacity, low_seat_threshold: unit.low_seat_threshold, minimum_passengers: unit.minimum_passengers ?? null, status: "open", close_reason: null })}>Riapri</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {selectedUnits.length === 0 ? <tr><td colSpan={6} className="px-3 py-4 text-sm text-muted">Nessun bus su questa linea.</td></tr> : null}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </SectionCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <SectionCard
          title="Fermate e ordine operativo"
          subtitle={selectedLine ? `Linea selezionata: ${selectedLine.name}. Nord-sud per andata, inverso per ritorno, con override manuale.` : "Nord-sud per andata, inverso per ritorno, con override manuale."}
        >
          {!selectedLine ? (
            <p className="text-sm text-muted">Seleziona una linea per vedere le fermate.</p>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-2 md:grid-cols-2">
                <input className="input-saas" placeholder="Nuova fermata" value={newStopName} onChange={(event) => setNewStopName(event.target.value)} />
                <input className="input-saas" placeholder="Citta" value={newStopCity} onChange={(event) => setNewStopCity(event.target.value)} />
                <input className="input-saas" type="number" value={newArrivalStopOrder || defaultArrivalStopOrder} onChange={(event) => setNewArrivalStopOrder(event.target.value)} placeholder="Ordine andata" />
                <input className="input-saas" type="number" value={newDepartureStopOrder || defaultDepartureStopOrder} onChange={(event) => setNewDepartureStopOrder(event.target.value)} placeholder="Ordine ritorno" />
                <button
                  type="button"
                  className="btn-secondary px-3 py-2 text-sm md:col-span-2"
                  disabled={saving || !newStopName.trim() || !newStopCity.trim()}
                  onClick={() =>
                    void postAction({
                      action: "add_stop",
                      bus_line_id: selectedLine.id,
                      direction: "arrival",
                      stop_name: newStopName.trim(),
                      city: newStopCity.trim(),
                      stop_order: Number(newArrivalStopOrder || "0"),
                      departure_stop_order: Number(newDepartureStopOrder || "0"),
                      pickup_note: null
                    }).then((ok) => {
                      if (!ok) return;
                      setNewStopName("");
                      setNewStopCity("");
                    })
                  }
                >
                  Aggiungi fermata bidirezionale
                </button>
              </div>
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Dir</th>
                      <th className="px-3 py-2">Ord.</th>
                      <th className="px-3 py-2">Fermata</th>
                      <th className="px-3 py-2">Citta</th>
                      <th className="px-3 py-2">Pax</th>
                      <th className="px-3 py-2">Origine</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedStops.map((stop) => (
                      <tr
                        key={stop.id}
                        draggable
                        onDragStart={() => setDraggedStopId(stop.id)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault();
                          void reorderStops(stop.direction, draggedStopId, stop.id);
                          setDraggedStopId("");
                        }}
                        className="border-t border-slate-100"
                      >
                        <td className="px-3 py-2">{directionLabel(stop.direction)}</td>
                        <td className="px-3 py-2">{stop.stop_order}</td>
                        <td className="px-3 py-2">{stop.stop_name}</td>
                        <td className="px-3 py-2">{stop.city}</td>
                        <td className="px-3 py-2">{stop.pax_assigned}</td>
                        <td className="px-3 py-2">{stop.is_manual ? "Manuale A/R" : "PDF/catalogo"}</td>
                      </tr>
                    ))}
                    {selectedStops.length === 0 ? <tr><td colSpan={6} className="px-3 py-4 text-sm text-muted">Nessuna fermata configurata su questa linea.</td></tr> : null}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </SectionCard>

        <SectionCard title="Allocazioni e spostamenti prenotazioni" subtitle="Movimenti controllati tra bus con capienza e dati servizio">
          {!selectedLine ? (
            <p className="text-sm text-muted">Seleziona una linea per allocare o spostare prenotazioni.</p>
          ) : (
            <div className="space-y-3">
              <div className="rounded-xl border border-border bg-surface-2 p-3">
                <p className="mb-2 text-sm font-medium">Assegna prenotazione a un bus</p>
                <div className="grid gap-2">
                  <select className="input-saas" value={selectedService?.id ?? ""} onChange={(event) => {
                    setSelectedServiceId(event.target.value);
                    setSelectedStopId("");
                  }}>
                    {selectedServices.map((service) => (
                      <option key={service.id} value={service.id}>
                        {service.date} {service.time} | {service.customer_display_name} | {service.pax} pax | {service.hotel_name}
                      </option>
                    ))}
                  </select>
                  {selectedServices.length === 0 ? <p className="text-sm text-muted">Nessuna prenotazione disponibile per questa famiglia linea.</p> : null}
                  {selectedService ? (
                    <div className="rounded-xl border border-border bg-white px-3 py-3 text-sm">
                      <p className="font-semibold">{selectedService.customer_display_name}</p>
                      <p className="text-muted">{selectedService.phone_display} | {selectedService.pax} pax | {selectedService.hotel_name}</p>
                      <p className="text-muted">
                        {directionLabel(selectedService.direction)} | linea suggerita {selectedService.derived_line_name ?? selectedService.derived_family_name} | fermata suggerita {selectedService.suggested_stop_name ?? "N/D"}
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-muted">Nessuna prenotazione disponibile su questa linea.</p>
                  )}
                  <select className="input-saas" value={selectedUnit?.id ?? ""} onChange={(event) => setSelectedUnitId(event.target.value)}>
                    {selectedUnits.map((unit) => (
                      <option key={unit.id} value={unit.id}>
                        {unit.label} | residui {unit.remaining_seats} | stato {unit.status}
                      </option>
                    ))}
                  </select>
                  <select className="input-saas" value={effectiveSelectedStop?.id ?? ""} onChange={(event) => setSelectedStopId(event.target.value)}>
                    {compatibleStops.map((stop) => (
                      <option key={stop.id} value={stop.id}>{directionLabel(stop.direction)} | {stop.stop_order}. {stop.stop_name} | pax fermata {stop.pax_assigned}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn-secondary px-3 py-2 text-sm"
                    disabled={!selectedService || !selectedUnit || !effectiveSelectedStop}
                    onClick={() => {
                      if (!selectedService || !selectedUnit || !effectiveSelectedStop || !selectedLine) return;
                      void postAction({
                        action: "allocate_service",
                        service_id: selectedService.id,
                        bus_line_id: selectedLine.id,
                        bus_unit_id: selectedUnit.id,
                        direction: selectedService.direction,
                        stop_id: effectiveSelectedStop.id,
                        stop_name: effectiveSelectedStop.stop_name,
                        pax_assigned: selectedService.pax,
                        notes: null
                      });
                    }}
                  >
                    Assegna prenotazione
                  </button>
                </div>
              </div>

              <div className="rounded-xl border border-border bg-surface-2 p-3">
                <p className="mb-2 text-sm font-medium">Sposta prenotazione / allocazione tra bus</p>
                <div className="grid gap-2">
                  <select className="input-saas" value={selectedAllocation?.id ?? ""} onChange={(event) => {
                    const nextId = event.target.value;
                    setSelectedAllocationId(nextId);
                    const nextAllocation = selectedAllocations.find((allocation) => allocation.id === nextId);
                    setMovePax(nextAllocation ? String(nextAllocation.pax_assigned) : "");
                    setMoveReason("");
                    setMoveTargetUnitId("");
                  }}>
                    {selectedAllocationDetails.map((allocation) => {
                      return (
                        <option key={allocation.allocation_id} value={allocation.allocation_id}>
                          {allocation.customer_name} | {allocation.stop_name} | {allocation.pax_assigned} pax | {allocation.bus_label}
                        </option>
                      );
                    })}
                  </select>
                  {selectedAllocations.length === 0 ? <p className="text-sm text-muted">Nessuna allocazione attiva da spostare su questa linea.</p> : null}
                  {selectedAllocationDetail ? (
                    <div className="rounded-xl border border-border bg-white px-3 py-3 text-sm">
                      <p className="font-semibold">{selectedAllocationDetail.customer_name}</p>
                      <p className="text-muted">{selectedAllocationDetail.customer_phone ?? "Telefono N/D"} | {selectedAllocationDetail.pax_assigned} pax allocati | {selectedAllocationDetail.hotel_name ?? "Hotel N/D"}</p>
                      <p className="text-muted">
                        {selectedAllocationDetail.stop_name} | {directionLabel(selectedAllocationDetail.direction)} | bus attuale {selectedAllocationDetail.bus_label}
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-muted">Nessuna allocazione presente su questa linea.</p>
                  )}
                  <select className="input-saas" value={moveTargetUnit?.id ?? ""} onChange={(event) => setMoveTargetUnitId(event.target.value)}>
                    {targetUnits.map((unit) => (
                      <option key={unit.id} value={unit.id}>
                        {unit.label} | residui {unit.remaining_seats} | stato {unit.status}
                      </option>
                    ))}
                  </select>
                  <input className="input-saas" value={effectiveMovePaxValue} onChange={(event) => setMovePax(event.target.value)} type="number" min={1} placeholder="Pax da spostare" />
                  <input className="input-saas" value={moveReason} onChange={(event) => setMoveReason(event.target.value)} placeholder="Motivo spostamento (opzionale)" />
                  {selectedAllocation && movePreview ? (
                    <div className="rounded-xl border border-border bg-white px-3 py-3 text-sm">
                      <p className="font-medium">Controllo prima della conferma</p>
                      <p className="text-muted">Disponibili da spostare: {movePreview.available}</p>
                      <p className="text-muted">Residui bus destinazione: {movePreview.destinationResidual}</p>
                      <p className="text-muted">Dopo conferma origine: {movePreview.sourceAfter}</p>
                      <p className="text-muted">Dopo conferma residui destinazione: {movePreview.destinationAfter}</p>
                    </div>
                  ) : null}
                  {moveWouldOverflow ? (
                    <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-700">
                      Il bus destinazione non ha posti sufficienti per questo spostamento. Riduci i pax o scegli un altro bus.
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className="btn-secondary px-3 py-2 text-sm"
                    disabled={!selectedAllocation || !moveTargetUnit || !movePreview?.effective || moveWouldOverflow}
                    onClick={() => {
                      if (!selectedAllocation || !moveTargetUnit || !movePreview?.effective || moveWouldOverflow) return;
                      void postAction({
                        action: "move_allocation",
                        allocation_id: selectedAllocation.id,
                        to_bus_unit_id: moveTargetUnit.id,
                        pax_moved: movePreview.effective,
                        reason: moveReason || null
                      });
                    }}
                  >
                    Sposta prenotazione
                  </button>
                </div>
              </div>
            </div>
          )}
        </SectionCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <SectionCard title="Drag and drop operativo" subtitle="Trascina prenotazioni tra bus, conferma sempre in modale">
          {!selectedLine ? (
            <p className="text-sm text-muted">Seleziona una linea per usare il drag and drop.</p>
          ) : (
            <div className="grid gap-3 xl:grid-cols-3">
              {allocationsByUnit.map(({ unit, allocations }) => (
                <div
                  key={unit.id}
                  className="rounded-xl border border-border bg-surface-2 p-3"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (!draggedAllocationId || draggedAllocationId === selectedAllocation?.id && unit.id === selectedAllocation?.bus_unit_id) return;
                    const draggedDetail = selectedAllocationDetails.find((item) => item.allocation_id === draggedAllocationId);
                    if (!draggedDetail || draggedDetail.bus_unit_id === unit.id) return;
                    setSelectedAllocationId(draggedDetail.allocation_id);
                    setMoveTargetUnitId(unit.id);
                    setMovePax(String(draggedDetail.pax_assigned));
                    setMoveReason("");
                    setMoveModalOpen(true);
                    setDraggedAllocationId("");
                  }}
                >
                  <p className="font-semibold">{unit.label}</p>
                  <p className="mb-3 text-xs text-muted">Residui {unit.remaining_seats} | stato {unit.status}</p>
                  <div className="space-y-2">
                    {allocations.map((allocation) => (
                      <button
                        key={allocation.allocation_id}
                        type="button"
                        draggable
                        onDragStart={() => setDraggedAllocationId(allocation.allocation_id)}
                        onClick={() => {
                          setSelectedAllocationId(allocation.allocation_id);
                          setMovePax(String(allocation.pax_assigned));
                          setMoveReason("");
                        }}
                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-sm"
                      >
                        <p className="font-medium">{allocation.customer_name}</p>
                        <p className="text-xs text-muted">{allocation.stop_name} | {allocation.pax_assigned} pax | {allocation.hotel_name ?? "Hotel N/D"}</p>
                      </button>
                    ))}
                    {allocations.length === 0 ? <p className="text-xs text-muted">Nessuna prenotazione su questo bus.</p> : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Confronto venerdi / sabato" subtitle="Pax per fermata su due giorni operativi">
          {!selectedLine ? (
            <p className="text-sm text-muted">Seleziona una linea per confrontare i giorni.</p>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-2 md:grid-cols-2">
                <label className="text-sm text-muted">
                  Data 1
                  <input className="input-saas mt-1" type="date" value={compareDateA} onChange={(event) => setCompareDateA(event.target.value)} />
                </label>
                <label className="text-sm text-muted">
                  Data 2
                  <input className="input-saas mt-1" type="date" value={compareDateB} onChange={(event) => setCompareDateB(event.target.value)} />
                </label>
              </div>
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Fermata</th>
                      <th className="px-3 py-2">Citta</th>
                      <th className="px-3 py-2">{compareDateA}</th>
                      <th className="px-3 py-2">{compareDateB}</th>
                      <th className="px-3 py-2">Diff</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stopComparisonRows.map((row) => (
                      <tr key={row.stop_name} className={`border-t border-slate-100 ${Math.abs(row.difference) >= 8 ? "bg-amber-50/60" : ""}`}>
                        <td className="px-3 py-2 font-medium">{row.stop_name}</td>
                        <td className="px-3 py-2">{row.city}</td>
                        <td className="px-3 py-2">{row.paxA}</td>
                        <td className="px-3 py-2">{row.paxB}</td>
                        <td className="px-3 py-2">{row.difference}</td>
                      </tr>
                    ))}
                    {stopComparisonRows.length === 0 ? <tr><td colSpan={5} className="px-3 py-4 text-sm text-muted">Nessun dato fermata da confrontare.</td></tr> : null}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </SectionCard>

        <SectionCard title="Suggerimenti geografici" subtitle="Raggruppamento automatico con override sempre manuale">
          <div className="space-y-2">
            {payload.geographic_suggestions.map((suggestion) => (
              <article key={suggestion.service_id} className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm">
                <p className="font-semibold">{suggestion.customer_name}</p>
                <p className="text-muted">
                  Fermata suggerita {suggestion.stop_name} | zona {suggestion.grouped_zone} | mezzo {suggestion.suggested_vehicle_type}
                </p>
              </article>
            ))}
            {payload.geographic_suggestions.length === 0 ? <p className="text-sm text-muted">Nessun suggerimento geografico disponibile.</p> : null}
          </div>
        </SectionCard>

        <SectionCard title="Ridistribuzione operativa" subtitle="Suggerimenti automatici, conferma sempre manuale">
          <div className="space-y-2">
            {payload.redistribution_suggestions.map((item, index) => (
              <article key={`${item.source_label}-${item.target_label ?? "none"}-${index}`} className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm">
                <p className="font-semibold">{item.source_label} -&gt; {item.target_label ?? "Nuovo bus"}</p>
                <p className="text-muted">{item.reason}</p>
              </article>
            ))}
            {payload.redistribution_suggestions.length === 0 ? <p className="text-sm text-muted">Nessuna ridistribuzione suggerita.</p> : null}
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Storico movimenti" subtitle="Audit degli spostamenti prenotazione tra bus">
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Quando</th>
                <th className="px-3 py-2">Cliente</th>
                <th className="px-3 py-2">Telefono</th>
                <th className="px-3 py-2">Hotel</th>
                <th className="px-3 py-2">Fermata</th>
                <th className="px-3 py-2">Bus</th>
                <th className="px-3 py-2">Pax</th>
                <th className="px-3 py-2">Tipo</th>
                <th className="px-3 py-2">Motivo</th>
              </tr>
            </thead>
            <tbody>
              {selectedMoves.map((move) => (
                <tr key={move.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{new Date(move.created_at).toLocaleString("it-IT")}</td>
                  <td className="px-3 py-2">{move.customer_name ?? "N/D"}</td>
                  <td className="px-3 py-2">{move.customer_phone ?? "N/D"}</td>
                  <td className="px-3 py-2">{move.hotel_name ?? "N/D"}</td>
                  <td className="px-3 py-2">{move.stop_name ?? "N/D"}</td>
                  <td className="px-3 py-2">{move.source_bus_label ?? "N/D"} -&gt; {move.target_bus_label ?? "N/D"}</td>
                  <td className="px-3 py-2">{move.pax_moved}</td>
                  <td className="px-3 py-2">{move.moved_full_allocation ? "Completo" : "Parziale"}</td>
                  <td className="px-3 py-2">{move.reason ?? "Nessun motivo"}</td>
                </tr>
              ))}
              {selectedMoves.length === 0 ? <tr><td colSpan={9} className="px-3 py-4 text-sm text-muted">Nessun movimento registrato su questa linea.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {moveModalOpen && selectedAllocationDetail && moveTargetUnit ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4">
          <div className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
            <div className="space-y-2">
              <p className="text-lg font-semibold">Conferma spostamento prenotazione</p>
              <p className="text-sm text-muted">{selectedAllocationDetail.customer_name} | {selectedAllocationDetail.customer_phone ?? "Telefono N/D"} | {selectedAllocationDetail.hotel_name ?? "Hotel N/D"}</p>
              <p className="text-sm text-muted">
                Fermata {selectedAllocationDetail.stop_name} | bus origine {selectedAllocationDetail.bus_label} | bus destinazione {moveTargetUnit.label}
              </p>
              {movePreview ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm">
                  <p>Disponibili da spostare: {movePreview.available}</p>
                  <p>Residui bus destinazione: {movePreview.destinationResidual}</p>
                  <p>Dopo conferma origine: {movePreview.sourceAfter}</p>
                  <p>Dopo conferma residui destinazione: {movePreview.destinationAfter}</p>
                </div>
              ) : null}
              {moveWouldOverflow ? (
                <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-700">
                  Il bus destinazione non ha posti sufficienti per questo spostamento. Riduci i pax o scegli un altro bus.
                </div>
              ) : null}
              <div className="grid gap-2">
                <input className="input-saas" value={effectiveMovePaxValue} onChange={(event) => setMovePax(event.target.value)} type="number" min={1} />
                <input className="input-saas" value={moveReason} onChange={(event) => setMoveReason(event.target.value)} placeholder="Motivo opzionale" />
              </div>
              <div className="flex flex-wrap justify-end gap-2 pt-2">
                <button type="button" className="btn-secondary px-4 py-2 text-sm" onClick={() => setMoveModalOpen(false)}>
                  Annulla
                </button>
                <button
                  type="button"
                  className="btn-primary px-4 py-2 text-sm"
                  disabled={saving || !selectedAllocation || !movePreview?.effective || moveWouldOverflow}
                  onClick={() =>
                    selectedAllocation && !moveWouldOverflow
                      ? void postAction({
                          action: "move_allocation",
                          allocation_id: selectedAllocation.id,
                          to_bus_unit_id: moveTargetUnit.id,
                          pax_moved: movePreview?.effective ?? Number(effectiveMovePaxValue || "0"),
                          reason: moveReason || null
                        }).then((ok) => {
                          if (ok) {
                            setMoveModalOpen(false);
                            setDraggedAllocationId("");
                          }
                        })
                      : undefined
                  }
                >
                  Conferma spostamento
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
