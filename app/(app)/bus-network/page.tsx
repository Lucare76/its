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
  date: string;
  time: string;
  pax: number;
  direction: "arrival" | "departure";
  bus_city_origin?: string | null;
  transport_code?: string | null;
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
  const [message, setMessage] = useState("Rete bus nazionale: linee, fermate, capienza e ridistribuzione pax.");
  const [selectedLineId, setSelectedLineId] = useState<string>("");
  const [selectedAllocationId, setSelectedAllocationId] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [newUnitLabel, setNewUnitLabel] = useState("");
  const [newStopName, setNewStopName] = useState("");
  const [newStopCity, setNewStopCity] = useState("");

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
    setSelectedLineId((current) => current || nextPayload.lines[0]?.id || "");
    setSelectedAllocationId((current) => current || nextPayload.allocations[0]?.id || "");
    setLoading(false);
  });

  useEffect(() => {
    void load();
  }, []);

  const selectedLine = payload.lines.find((line) => line.id === selectedLineId) ?? payload.lines[0] ?? null;
  const selectedUnits = payload.unit_loads.filter((unit) => unit.bus_line_id === selectedLine?.id);
  const selectedStops = payload.stop_loads.filter((stop) => stop.bus_line_id === selectedLine?.id);
  const selectedAllocations = payload.allocations.filter((allocation) => allocation.bus_line_id === selectedLine?.id);
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

  const postAction = async (body: Record<string, unknown>) => {
    const token = await getAccessToken();
    if (!token) {
      setMessage("Sessione non valida.");
      return;
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
      return;
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
    setSaving(false);
    setMessage("Operazione completata.");
  };

  return (
    <section className="page-section">
      <PageHeader
        title="Rete Bus Nazionale"
        subtitle="Linee, bus, fermate, capienza, ridistribuzione pax e suggerimenti geografici."
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

        <SectionCard title="Bus della linea" subtitle="Capienza, chiusura manuale e alert posti">
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
                  onClick={() => void postAction({ action: "add_unit", bus_line_id: selectedLine.id, label: newUnitLabel.trim(), capacity: 54 }).then(() => setNewUnitLabel(""))}
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
        <SectionCard title="Fermate e ordine operativo" subtitle="Nord-sud per andata, inverso per ritorno, con override manuale">
          {!selectedLine ? (
            <p className="text-sm text-muted">Seleziona una linea per vedere le fermate.</p>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-2 md:grid-cols-[1fr_1fr_120px_auto]">
                <input className="input-saas" placeholder="Nuova fermata" value={newStopName} onChange={(event) => setNewStopName(event.target.value)} />
                <input className="input-saas" placeholder="Citta" value={newStopCity} onChange={(event) => setNewStopCity(event.target.value)} />
                <input className="input-saas" type="number" defaultValue={selectedStops.filter((stop) => stop.direction === "arrival").length + 1} id="bus-stop-order" />
                <button
                  type="button"
                  className="btn-secondary px-3 py-2 text-sm"
                  disabled={saving || !newStopName.trim() || !newStopCity.trim()}
                  onClick={() => {
                    const orderInput = document.getElementById("bus-stop-order") as HTMLInputElement | null;
                    void postAction({
                      action: "add_stop",
                      bus_line_id: selectedLine.id,
                      direction: "arrival",
                      stop_name: newStopName.trim(),
                      city: newStopCity.trim(),
                      stop_order: Number(orderInput?.value || selectedStops.length + 1),
                      pickup_note: null
                    }).then(() => {
                      setNewStopName("");
                      setNewStopCity("");
                    });
                  }}
                >
                  Aggiungi fermata
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
                        <td className="px-3 py-2">{stop.is_manual ? "Manuale" : "PDF/catalogo"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </SectionCard>

        <SectionCard title="Allocazioni e spostamenti pax" subtitle="Redistribuzione fra bus con controllo capienza">
          {!selectedLine ? (
            <p className="text-sm text-muted">Seleziona una linea per allocare o spostare pax.</p>
          ) : (
            <div className="space-y-3">
              <div className="rounded-xl border border-border bg-surface-2 p-3">
                <p className="mb-2 text-sm font-medium">Assegna prenotazione a un bus</p>
                <div className="grid gap-2">
                  <select className="input-saas" id="allocation-service">
                    {payload.services
                      .filter((service) => service.direction && !payload.allocations.some((allocation) => allocation.service_id === service.id))
                      .map((service) => (
                        <option key={service.id} value={service.id}>
                          {service.date} {service.time} | {service.customer_name} | {service.pax} pax | {service.bus_city_origin ?? "N/D"}
                        </option>
                      ))}
                  </select>
                  <select className="input-saas" id="allocation-unit">
                    {selectedUnits.map((unit) => (
                      <option key={unit.id} value={unit.id}>
                        {unit.label} | residui {unit.remaining_seats}
                      </option>
                    ))}
                  </select>
                  <select className="input-saas" id="allocation-stop">
                    {selectedStops.filter((stop) => stop.direction === "arrival").map((stop) => (
                      <option key={stop.id} value={stop.id}>{stop.stop_name}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn-secondary px-3 py-2 text-sm"
                    onClick={() => {
                      const serviceId = (document.getElementById("allocation-service") as HTMLSelectElement | null)?.value ?? "";
                      const unitId = (document.getElementById("allocation-unit") as HTMLSelectElement | null)?.value ?? "";
                      const stopId = (document.getElementById("allocation-stop") as HTMLSelectElement | null)?.value ?? "";
                      const service = payload.services.find((item) => item.id === serviceId);
                      const stop = selectedStops.find((item) => item.id === stopId);
                      if (!service || !stop) return;
                      void postAction({
                        action: "allocate_service",
                        service_id: service.id,
                        bus_line_id: selectedLine.id,
                        bus_unit_id: unitId,
                        direction: service.direction,
                        stop_id: stop.id,
                        stop_name: stop.stop_name,
                        pax_assigned: service.pax,
                        notes: null
                      });
                    }}
                  >
                    Assegna al bus
                  </button>
                </div>
              </div>

              <div className="rounded-xl border border-border bg-surface-2 p-3">
                <p className="mb-2 text-sm font-medium">Sposta pax tra bus</p>
                <div className="grid gap-2">
                  <select className="input-saas" value={selectedAllocationId} onChange={(event) => setSelectedAllocationId(event.target.value)}>
                    {selectedAllocations.map((allocation) => {
                      const service = payload.services.find((item) => item.id === allocation.service_id);
                      const unit = selectedUnits.find((item) => item.id === allocation.bus_unit_id);
                      return (
                        <option key={allocation.id} value={allocation.id}>
                          {service?.customer_name ?? allocation.service_id} | {allocation.stop_name} | {allocation.pax_assigned} pax | {unit?.label ?? "Bus"}
                        </option>
                      );
                    })}
                  </select>
                  <select className="input-saas" id="move-target-unit">
                    {selectedUnits.map((unit) => (
                      <option key={unit.id} value={unit.id}>
                        {unit.label} | residui {unit.remaining_seats}
                      </option>
                    ))}
                  </select>
                  <input className="input-saas" id="move-pax" type="number" min={1} placeholder="Pax da spostare" />
                  <input className="input-saas" id="move-reason" placeholder="Motivo spostamento" />
                  <button
                    type="button"
                    className="btn-secondary px-3 py-2 text-sm"
                    disabled={!selectedAllocationId}
                    onClick={() => {
                      const targetUnitId = (document.getElementById("move-target-unit") as HTMLSelectElement | null)?.value ?? "";
                      const paxMoved = Number((document.getElementById("move-pax") as HTMLInputElement | null)?.value ?? "0");
                      const reason = (document.getElementById("move-reason") as HTMLInputElement | null)?.value ?? "";
                      if (!targetUnitId || !paxMoved) return;
                      void postAction({
                        action: "move_allocation",
                        allocation_id: selectedAllocationId,
                        to_bus_unit_id: targetUnitId,
                        pax_moved: paxMoved,
                        reason
                      });
                    }}
                  >
                    Sposta passeggeri
                  </button>
                </div>
              </div>
            </div>
          )}
        </SectionCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <SectionCard title="Suggerimenti geografici / AI" subtitle="Supporto decisionale con override sempre manuale">
          <div className="space-y-2">
            {payload.geographic_suggestions.slice(0, 12).map((item) => (
              <article key={item.service_id} className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm">
                <p className="font-semibold">{item.customer_name}</p>
                <p className="text-muted">Fermata {item.stop_name} | Zona {item.grouped_zone}</p>
                <p className="text-muted">Mezzo suggerito {item.suggested_vehicle_type} | Ordine fermata {item.suggested_stop_order ?? "N/D"}</p>
              </article>
            ))}
            {payload.geographic_suggestions.length === 0 ? <p className="text-sm text-muted">Nessun suggerimento disponibile.</p> : null}
          </div>
        </SectionCard>

        <SectionCard title="Ridistribuzione consigliata" subtitle="Bus quasi pieni o senza compatibilita">
          <div className="space-y-2">
            {payload.redistribution_suggestions.map((item, index) => (
              <article key={`${item.source_label}-${index}`} className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm">
                <p className="font-semibold">{item.source_label} → {item.target_label ?? "nessun bus libero"}</p>
                <p className="text-muted">{item.reason}</p>
              </article>
            ))}
            {payload.redistribution_suggestions.length === 0 ? <p className="text-sm text-muted">Nessuna redistribuzione suggerita ora.</p> : null}
          </div>
        </SectionCard>
      </div>
    </section>
  );
}
