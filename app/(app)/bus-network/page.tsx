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
  stop_name: string;
  direction: "arrival" | "departure";
  pax_assigned: number;
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

    const nextPayload = {
      lines: body.lines ?? [],
      stops: body.stops ?? [],
      units: body.units ?? [],
      allocations: body.allocations ?? [],
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
  const allocationService = payload.services.find((service) => service.id === selectedAllocation?.service_id) ?? null;
  const sourceUnit = selectedUnits.find((unit) => unit.id === selectedAllocation?.bus_unit_id) ?? null;
  const targetUnits = selectedUnits.filter((unit) => unit.id !== selectedAllocation?.bus_unit_id);
  const moveTargetUnit = targetUnits.find((unit) => unit.id === moveTargetUnitId) ?? targetUnits[0] ?? null;

  useEffect(() => {
    setSelectedServiceId((current) => {
      if (current && selectedServices.some((service) => service.id === current)) return current;
      return selectedServices[0]?.id ?? "";
    });
  }, [selectedLineId, selectedServices]);

  useEffect(() => {
    setSelectedUnitId((current) => {
      if (current && selectedUnits.some((unit) => unit.id === current)) return current;
      return selectedUnits[0]?.id ?? "";
    });
  }, [selectedLineId, selectedUnits]);

  useEffect(() => {
    setSelectedAllocationId((current) => {
      if (current && selectedAllocations.some((allocation) => allocation.id === current)) return current;
      return selectedAllocations[0]?.id ?? "";
    });
  }, [selectedLineId, selectedAllocations]);

  useEffect(() => {
    const suggestedStop =
      compatibleStops.find((stop) => stop.stop_name === selectedService?.suggested_stop_name) ??
      compatibleStops[0] ??
      null;
    setSelectedStopId((current) => {
      if (current && compatibleStops.some((stop) => stop.id === current)) return current;
      return suggestedStop?.id ?? "";
    });
  }, [selectedServiceId, selectedService, compatibleStops]);

  useEffect(() => {
    setMoveTargetUnitId((current) => {
      if (current && targetUnits.some((unit) => unit.id === current)) return current;
      return targetUnits[0]?.id ?? "";
    });
    setMovePax(selectedAllocation ? String(selectedAllocation.pax_assigned) : "");
    setMoveReason("");
  }, [selectedAllocationId, selectedAllocation, targetUnits]);

  useEffect(() => {
    const arrivalCount = selectedStops.filter((stop) => stop.direction === "arrival").length;
    const departureCount = selectedStops.filter((stop) => stop.direction === "departure").length;
    setNewArrivalStopOrder(String(arrivalCount + 1));
    setNewDepartureStopOrder(String(departureCount + 1));
  }, [selectedLineId, selectedStops]);

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

  const movePreview = useMemo(() => {
    if (!selectedAllocation || !sourceUnit || !moveTargetUnit) return null;
    const requested = Number(movePax || "0");
    const effective = Number.isFinite(requested) && requested > 0 ? Math.min(requested, selectedAllocation.pax_assigned) : 0;
    return {
      available: selectedAllocation.pax_assigned,
      destinationResidual: moveTargetUnit.remaining_seats,
      sourceAfter: Math.max(0, selectedAllocation.pax_assigned - effective),
      destinationAfter: moveTargetUnit.remaining_seats - effective,
      effective
    };
  }, [selectedAllocation, sourceUnit, moveTargetUnit, movePax]);

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
                onClick={() => setSelectedLineId(line.id)}
              >
                <p className="font-semibold">{line.name}</p>
                <p className="text-xs text-muted">{line.family_name} | {line.variant_label ?? "Variante manuale / futura"}</p>
              </button>
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Bus della linea" subtitle="Capienza, ultimi 5 posti e chiusura manuale">
          {!selectedLine ? (
            <p className="text-sm text-muted">Seleziona una linea.</p>
          ) : (
            <div className="space-y-3">
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
                        <td className="px-3 py-2">{unit.status} / suggerito {unit.suggested_status}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-2">
                            <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => void postAction({ action: "update_unit", unit_id: unit.id, capacity: unit.capacity, low_seat_threshold: unit.low_seat_threshold, minimum_passengers: unit.minimum_passengers ?? null, status: "closed", close_reason: "Chiusura manuale operatore" })}>Chiudi</button>
                            <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => void postAction({ action: "update_unit", unit_id: unit.id, capacity: unit.capacity, low_seat_threshold: unit.low_seat_threshold, minimum_passengers: unit.minimum_passengers ?? null, status: "open", close_reason: null })}>Riapri</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {selectedUnits.length === 0 ? <tr><td colSpan={5} className="px-3 py-4 text-sm text-muted">Nessun bus su questa linea.</td></tr> : null}
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
                <input className="input-saas" type="number" value={newArrivalStopOrder} onChange={(event) => setNewArrivalStopOrder(event.target.value)} placeholder="Ordine andata" />
                <input className="input-saas" type="number" value={newDepartureStopOrder} onChange={(event) => setNewDepartureStopOrder(event.target.value)} placeholder="Ordine ritorno" />
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
                      <th className="px-3 py-2">Pax</th>
                      <th className="px-3 py-2">Origine</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedStops.map((stop) => (
                      <tr key={stop.id} className="border-t border-slate-100">
                        <td className="px-3 py-2">{stop.direction === "arrival" ? "Andata" : "Ritorno"}</td>
                        <td className="px-3 py-2">{stop.stop_order}</td>
                        <td className="px-3 py-2">{stop.stop_name}</td>
                        <td className="px-3 py-2">{stop.pax_assigned}</td>
                        <td className="px-3 py-2">{stop.is_manual ? "Manuale A/R" : "PDF/catalogo"}</td>
                      </tr>
                    ))}
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
                  <select className="input-saas" value={selectedServiceId} onChange={(event) => setSelectedServiceId(event.target.value)}>
                    {selectedServices.map((service) => (
                      <option key={service.id} value={service.id}>
                        {service.date} {service.time} | {service.customer_display_name} | {service.pax} pax | {service.hotel_name}
                      </option>
                    ))}
                  </select>
                  {selectedService ? (
                    <div className="rounded-xl border border-border bg-white px-3 py-3 text-sm">
                      <p className="font-semibold">{selectedService.customer_display_name}</p>
                      <p className="text-muted">{selectedService.phone_display} | {selectedService.hotel_name}</p>
                      <p className="text-muted">
                        {selectedService.direction === "arrival" ? "Andata" : "Ritorno"} | linea suggerita {selectedService.derived_family_name} | fermata suggerita {selectedService.suggested_stop_name ?? "N/D"}
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-muted">Nessuna prenotazione disponibile su questa linea.</p>
                  )}
                  <select className="input-saas" value={selectedUnitId} onChange={(event) => setSelectedUnitId(event.target.value)}>
                    {selectedUnits.map((unit) => (
                      <option key={unit.id} value={unit.id}>
                        {unit.label} | residui {unit.remaining_seats}
                      </option>
                    ))}
                  </select>
                  <select className="input-saas" value={selectedStopId} onChange={(event) => setSelectedStopId(event.target.value)}>
                    {compatibleStops.map((stop) => (
                      <option key={stop.id} value={stop.id}>{stop.stop_name}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn-secondary px-3 py-2 text-sm"
                    disabled={!selectedService || !selectedUnit || !selectedStop}
                    onClick={() => {
                      if (!selectedService || !selectedUnit || !selectedStop || !selectedLine) return;
                      void postAction({
                        action: "allocate_service",
                        service_id: selectedService.id,
                        bus_line_id: selectedLine.id,
                        bus_unit_id: selectedUnit.id,
                        direction: selectedService.direction,
                        stop_id: selectedStop.id,
                        stop_name: selectedStop.stop_name,
                        pax_assigned: selectedService.pax,
                        notes: null
                      });
                    }}
                  >
                    Assegna al bus
                  </button>
                </div>
              </div>

              <div className="rounded-xl border border-border bg-surface-2 p-3">
                <p className="mb-2 text-sm font-medium">Sposta prenotazione / allocazione tra bus</p>
                <div className="grid gap-2">
                  <select className="input-saas" value={selectedAllocationId} onChange={(event) => setSelectedAllocationId(event.target.value)}>
                    {selectedAllocations.map((allocation) => {
                      const service = payload.services.find((item) => item.id === allocation.service_id);
                      const unit = selectedUnits.find((item) => item.id === allocation.bus_unit_id);
                      return (
                        <option key={allocation.id} value={allocation.id}>
                          {service?.customer_display_name ?? allocation.service_id} | {allocation.stop_name} | {allocation.pax_assigned} pax | {unit?.label ?? "Bus"}
                        </option>
                      );
                    })}
                  </select>
                  {selectedAllocation && allocationService ? (
                    <div className="rounded-xl border border-border bg-white px-3 py-3 text-sm">
                      <p className="font-semibold">{allocationService.customer_display_name}</p>
                      <p className="text-muted">{allocationService.phone_display} | {allocationService.hotel_name}</p>
                      <p className="text-muted">
                        {selectedAllocation.stop_name} | {selectedAllocation.direction === "arrival" ? "Andata" : "Ritorno"} | bus attuale {sourceUnit?.label ?? "N/D"}
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-muted">Nessuna allocazione presente su questa linea.</p>
                  )}
                  <select className="input-saas" value={moveTargetUnitId} onChange={(event) => setMoveTargetUnitId(event.target.value)}>
                    {targetUnits.map((unit) => (
                      <option key={unit.id} value={unit.id}>
                        {unit.label} | residui {unit.remaining_seats}
                      </option>
                    ))}
                  </select>
                  <input className="input-saas" value={movePax} onChange={(event) => setMovePax(event.target.value)} type="number" min={1} placeholder="Pax da spostare" />
                  <input className="input-saas" value={moveReason} onChange={(event) => setMoveReason(event.target.value)} placeholder="Motivo spostamento (opzionale)" />
                  {selectedAllocation && movePreview ? (
                    <div className="rounded-xl border border-border bg-white px-3 py-3 text-sm">
                      <p className="font-medium">Controllo prima della conferma</p>
                      <p className="text-muted">Disponibili da spostare: {movePreview.available}</p>
                      <p className="text-muted">Residui bus destinazione: {movePreview.destinationResidual}</p>
                      <p className="text-muted">Impatto dopo spostamento: origine {movePreview.sourceAfter}, destinazione residui {movePreview.destinationAfter}</p>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className="btn-secondary px-3 py-2 text-sm"
                    disabled={!selectedAllocation || !moveTargetUnit || !movePreview?.effective}
                    onClick={() => {
                      if (!selectedAllocation || !moveTargetUnit || !movePreview?.effective) return;
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
    </section>
  );
}
