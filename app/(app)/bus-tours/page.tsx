"use client";

import { useEffect, useMemo, useState } from "react";
import { DataTable, EmptyState, FilterBar, PageHeader } from "@/components/ui";
import { buildBusLotAggregates, isBusLineService, isTrueBusTour } from "@/lib/bus-lot-utils";
import { supabase } from "@/lib/supabase/client";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";
import type { BusLotConfig, ServiceStatus } from "@/lib/types";
import { SERVICE_STATUS_LABELS } from "@/lib/ui-labels";

export default function BusToursPage() {
  const { loading, tenantId, userId, errorMessage, data, refresh } = useTenantOperationalData();
  const [dateFilter, setDateFilter] = useState("all");
  const [tourNameFilter, setTourNameFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<ServiceStatus | "all">("all");
  const [selectedLotKey, setSelectedLotKey] = useState<string | null>(null);
  const [selectedTourServiceId, setSelectedTourServiceId] = useState<string | null>(null);
  const [draftDrivers, setDraftDrivers] = useState<Record<string, string>>({});
  const [draftBus, setDraftBus] = useState<Record<string, string>>({});
  const [draftStatus, setDraftStatus] = useState<Record<string, ServiceStatus>>({});
  const [lotDrafts, setLotDrafts] = useState<Record<string, { title: string; capacity: string; lowSeatThreshold: string; minimumPassengers: string; waitlistEnabled: boolean; waitlistCount: string; notes: string }>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(""), 2500);
    return () => window.clearTimeout(timeout);
  }, [message]);

  const busLineServices = data.services.filter((service) => isBusLineService(service));
  const busTours = data.services.filter((service) => isTrueBusTour(service));
  const assignmentsByServiceId = useMemo(() => new Map(data.assignments.map((assignment) => [assignment.service_id, assignment])), [data.assignments]);
  const hotelsById = useMemo(() => new Map(data.hotels.map((hotel) => [hotel.id, hotel])), [data.hotels]);
  const drivers = data.memberships.filter((member) => member.role === "driver");
  const driverNameById = useMemo(() => new Map(drivers.map((driver) => [driver.user_id, driver.full_name])), [drivers]);

  const availableDates = useMemo(
    () => [...new Set([...busLineServices, ...busTours].map((service) => service.date))].sort(),
    [busLineServices, busTours]
  );

  const filteredBusLineServices = useMemo(() => {
    return busLineServices.filter((service) => {
      const byDate = dateFilter === "all" || service.date === dateFilter;
      const text = `${service.customer_name} ${service.billing_party_name ?? ""} ${service.bus_city_origin ?? ""} ${service.transport_code ?? ""}`.toLowerCase();
      const byText = !tourNameFilter.trim() || text.includes(tourNameFilter.trim().toLowerCase());
      const byStatus = statusFilter === "all" || service.status === statusFilter;
      return byDate && byText && byStatus;
    });
  }, [busLineServices, dateFilter, tourNameFilter, statusFilter]);

  const filteredBusTours = useMemo(() => {
    return busTours.filter((service) => {
      const byDate = dateFilter === "all" || service.date === dateFilter;
      const byTourName = !tourNameFilter.trim() || `${service.tour_name ?? ""} ${service.customer_name}`.toLowerCase().includes(tourNameFilter.trim().toLowerCase());
      const byStatus = statusFilter === "all" || service.status === statusFilter;
      return byDate && byTourName && byStatus;
    });
  }, [busTours, dateFilter, tourNameFilter, statusFilter]);

  const busLots = useMemo(() => buildBusLotAggregates(filteredBusLineServices, data.busLotConfigs), [filteredBusLineServices, data.busLotConfigs]);
  const selectedLot = busLots.find((item) => item.key === selectedLotKey) ?? busLots[0] ?? null;
  const selectedTour = filteredBusTours.find((service) => service.id === selectedTourServiceId) ?? filteredBusTours[0] ?? null;
  const selectedTourHotel = selectedTour ? hotelsById.get(selectedTour.hotel_id) : null;
  const selectedTourAssignment = selectedTour ? assignmentsByServiceId.get(selectedTour.id) : null;

  const lotSummary = useMemo(() => {
    return busLots.reduce(
      (acc, lot) => {
        acc.lots += 1;
        acc.totalPax += lot.pax_total;
        if (lot.alerts.some((item) => item.label.startsWith("Pochi posti") || item.label === "Completo")) acc.lowSeats += 1;
        if (lot.alerts.some((item) => item.label.startsWith("Waiting list"))) acc.waitlists += 1;
        if (lot.alerts.some((item) => item.label.startsWith("Sotto minimo"))) acc.belowMinimum += 1;
        return acc;
      },
      { lots: 0, totalPax: 0, lowSeats: 0, waitlists: 0, belowMinimum: 0 }
    );
  }, [busLots]);
  const missingLotConfigs = useMemo(() => busLots.filter((lot) => !lot.config), [busLots]);

  const getLotDraft = (lot: typeof selectedLot extends null ? never : NonNullable<typeof selectedLot>) => {
    const config = lot.config;
    return (
      lotDrafts[lot.key] ?? {
        title: config?.title ?? lot.title ?? "",
        capacity: config?.capacity ? String(config.capacity) : "54",
        lowSeatThreshold: String(config?.low_seat_threshold ?? 5),
        minimumPassengers: config?.minimum_passengers ? String(config.minimum_passengers) : "",
        waitlistEnabled: config?.waitlist_enabled ?? false,
        waitlistCount: String(config?.waitlist_count ?? 0),
        notes: config?.notes ?? ""
      }
    );
  };

  const saveLotConfig = async (lot: NonNullable<typeof selectedLot>) => {
    if (!supabase || !tenantId) return;
    const draft = getLotDraft(lot);
    const capacity = Number(draft.capacity);
    const lowSeatThreshold = Number(draft.lowSeatThreshold);
    const minimumPassengers = draft.minimumPassengers ? Number(draft.minimumPassengers) : null;
    const waitlistCount = Number(draft.waitlistCount || "0");

    if (!Number.isFinite(capacity) || capacity < lot.pax_total) {
      setMessage("La capacita del lotto deve essere >= pax totali.");
      return;
    }
    if (Number.isFinite(lowSeatThreshold) && lowSeatThreshold > capacity) {
      setMessage("La soglia pochi posti non puo superare la capacita del lotto.");
      return;
    }
    if (minimumPassengers !== null && minimumPassengers > capacity) {
      setMessage("Il minimo passeggeri non puo superare la capacita del lotto.");
      return;
    }

    setBusyId(lot.key);
    const payload: Omit<BusLotConfig, "id"> = {
      tenant_id: tenantId,
      lot_key: lot.key,
      service_date: lot.date,
      direction: lot.direction,
      billing_party_name: lot.billing_party_name,
      bus_city_origin: lot.bus_city_origin,
      transport_code: lot.transport_code,
      title: draft.title || lot.title || null,
      meeting_point: lot.meeting_point,
      capacity,
      low_seat_threshold: lowSeatThreshold,
      minimum_passengers: minimumPassengers,
      waitlist_enabled: draft.waitlistEnabled,
      waitlist_count: Math.max(0, waitlistCount),
      notes: draft.notes || null
    };

    const { error } = await supabase.from("bus_lot_configs").upsert(payload, { onConflict: "tenant_id,lot_key" });
    setBusyId(null);
    if (error) {
      setMessage("Errore salvataggio lotto bus.");
      return;
    }
    await refresh();
    setMessage("Lotto bus aggiornato.");
  };

  const createMissingLotConfigs = async () => {
    if (!supabase || !tenantId || missingLotConfigs.length === 0) return;

    setBusyId("create-missing-lots");
    const payload: Array<Omit<BusLotConfig, "id">> = missingLotConfigs.map((lot) => ({
      tenant_id: tenantId,
      lot_key: lot.key,
      service_date: lot.date,
      direction: lot.direction,
      billing_party_name: lot.billing_party_name,
      bus_city_origin: lot.bus_city_origin,
      transport_code: lot.transport_code,
      title: lot.title || null,
      meeting_point: lot.meeting_point,
      capacity: 54,
      low_seat_threshold: 5,
      minimum_passengers: null,
      waitlist_enabled: false,
      waitlist_count: 0,
      notes: null
    }));

    const { error } = await supabase.from("bus_lot_configs").upsert(payload, { onConflict: "tenant_id,lot_key" });
    setBusyId(null);
    if (error) {
      setMessage("Errore creazione lotti bus.");
      return;
    }
    await refresh();
    if (!selectedLotKey && missingLotConfigs[0]) {
      setSelectedLotKey(missingLotConfigs[0].key);
    }
    setMessage(`${missingLotConfigs.length} lotti bus creati con 54 posti.`);
  };

  const handleAssignTour = async (serviceId: string) => {
    const service = filteredBusTours.find((item) => item.id === serviceId) ?? busTours.find((item) => item.id === serviceId);
    if (!service || !supabase || !tenantId) return;

    const existingAssignment = assignmentsByServiceId.get(serviceId);
    const nextDriverId = draftDrivers[serviceId] ?? existingAssignment?.driver_user_id ?? drivers[0]?.user_id ?? "";
    const nextBusLabel = (draftBus[serviceId] ?? existingAssignment?.vehicle_label ?? service.bus_plate ?? "").trim();

    if (!nextDriverId || !nextBusLabel) {
      setMessage("Seleziona driver e mezzo.");
      return;
    }

    setBusyId(serviceId);
    if (existingAssignment) {
      const { error: updateAssignmentError } = await supabase
        .from("assignments")
        .update({ driver_user_id: nextDriverId, vehicle_label: nextBusLabel })
        .eq("id", existingAssignment.id)
        .eq("tenant_id", tenantId);
      if (updateAssignmentError) {
        setBusyId(null);
        setMessage("Errore aggiornamento assegnazione.");
        return;
      }
    } else {
      const { error: insertAssignmentError } = await supabase.from("assignments").insert({
        tenant_id: tenantId,
        service_id: serviceId,
        driver_user_id: nextDriverId,
        vehicle_label: nextBusLabel
      });
      if (insertAssignmentError) {
        setBusyId(null);
        setMessage("Errore creazione assegnazione.");
        return;
      }
    }

    await supabase.from("services").update({ status: "assigned", bus_plate: nextBusLabel }).eq("id", serviceId).eq("tenant_id", tenantId);
    if (userId) {
      await supabase.from("status_events").insert({ tenant_id: tenantId, service_id: serviceId, status: "assigned", by_user_id: userId });
    }
    await refresh();
    setBusyId(null);
    setMessage("Tour bus assegnato.");
  };

  const handleTourStatusChange = async (serviceId: string) => {
    const service = filteredBusTours.find((item) => item.id === serviceId) ?? busTours.find((item) => item.id === serviceId);
    if (!service || !supabase || !tenantId) return;
    const nextStatus = draftStatus[serviceId] ?? service.status;
    if (nextStatus === service.status) {
      setMessage("Nessuna modifica stato.");
      return;
    }

    setBusyId(serviceId);
    const { error } = await supabase.from("services").update({ status: nextStatus }).eq("id", serviceId).eq("tenant_id", tenantId);
    if (error) {
      setBusyId(null);
      setMessage("Errore aggiornamento stato.");
      return;
    }
    if (userId) {
      await supabase.from("status_events").insert({ tenant_id: tenantId, service_id: serviceId, status: nextStatus, by_user_id: userId });
    }
    await refresh();
    setBusyId(null);
    setMessage(`Stato aggiornato: ${nextStatus}`);
  };

  if (loading) return <div className="card p-4 text-sm text-muted">Caricamento servizi bus...</div>;
  if (errorMessage) return <div className="card p-4 text-sm text-muted">{errorMessage}</div>;

  return (
    <section className="page-section">
      <PageHeader title="Servizi Bus" subtitle={`Lotti linea bus: ${busLots.length} | Tour bus: ${filteredBusTours.length}`} breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Servizi bus" }]} />

      <div className="grid gap-3 md:grid-cols-4">
        <div className="card p-4"><p className="text-xs uppercase tracking-[0.14em] text-muted">Lotti bus</p><p className="mt-2 text-2xl font-semibold text-text">{lotSummary.lots}</p></div>
        <div className="card p-4"><p className="text-xs uppercase tracking-[0.14em] text-muted">Pax linea bus</p><p className="mt-2 text-2xl font-semibold text-text">{lotSummary.totalPax}</p></div>
        <div className="card p-4"><p className="text-xs uppercase tracking-[0.14em] text-muted">Lotti critici</p><p className="mt-2 text-2xl font-semibold text-amber-700">{lotSummary.lowSeats}</p></div>
        <div className="card p-4"><p className="text-xs uppercase tracking-[0.14em] text-muted">Waiting / sotto minimo</p><p className="mt-2 text-2xl font-semibold text-rose-700">{lotSummary.waitlists + lotSummary.belowMinimum}</p></div>
      </div>

      <FilterBar colsClassName="md:grid-cols-3">
        <label className="text-xs text-muted">
          Data
          <select className="input-saas mt-1 w-full" value={dateFilter} onChange={(event) => setDateFilter(event.target.value)}>
            <option value="all">Tutte</option>
            {availableDates.map((date) => (
              <option key={date} value={date}>
                {date}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted">
          Cerca bus
          <input className="input-saas mt-1 w-full" value={tourNameFilter} onChange={(event) => setTourNameFilter(event.target.value)} placeholder="Agenzia, origine, codice, tour..." />
        </label>
        <label className="text-xs text-muted">
          Stato
          <select className="input-saas mt-1 w-full" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as ServiceStatus | "all")}>
            <option value="all">Tutti</option>
            <option value="new">{SERVICE_STATUS_LABELS.new}</option>
            <option value="assigned">{SERVICE_STATUS_LABELS.assigned}</option>
            <option value="partito">{SERVICE_STATUS_LABELS.partito}</option>
            <option value="arrivato">{SERVICE_STATUS_LABELS.arrivato}</option>
            <option value="completato">{SERVICE_STATUS_LABELS.completato}</option>
            <option value="cancelled">{SERVICE_STATUS_LABELS.cancelled}</option>
          </select>
        </label>
      </FilterBar>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="card p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="font-semibold">Lotti linea bus</h2>
              <p className="text-sm text-muted">Capacita e waiting list si gestiscono qui, a livello lotto e non sul singolo passeggero.</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted">Da configurare: {missingLotConfigs.length}</span>
              <button
                type="button"
                className="btn-secondary px-3 py-2 text-xs"
                disabled={missingLotConfigs.length === 0 || busyId === "create-missing-lots"}
                onClick={() => void createMissingLotConfigs()}
              >
                {busyId === "create-missing-lots" ? "Creazione..." : "Crea lotti mancanti (54 posti)"}
              </button>
            </div>
          </div>
          {busLots.length === 0 ? (
            <EmptyState title="Nessun lotto linea bus trovato." compact />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Data / dir</th>
                    <th className="px-3 py-2">Linea / origine</th>
                    <th className="px-3 py-2">Codice</th>
                    <th className="px-3 py-2">Servizi</th>
                    <th className="px-3 py-2">Pax</th>
                    <th className="px-3 py-2">Posti</th>
                    <th className="px-3 py-2">Alert</th>
                    <th className="px-3 py-2">Dettaglio</th>
                  </tr>
                </thead>
                <tbody>
                  {busLots.map((lot) => (
                    <tr key={lot.key} className="border-t border-slate-100">
                      <td className="px-3 py-2">{lot.date}<br />{lot.direction === "arrival" ? "Arrivo" : "Partenza"}</td>
                      <td className="px-3 py-2">{lot.title ?? "Linea bus"}<br /><span className="text-xs text-muted">{lot.bus_city_origin ?? "Origine N/D"}</span></td>
                      <td className="px-3 py-2">{lot.transport_code ?? "N/D"}</td>
                      <td className="px-3 py-2">{lot.service_count}</td>
                      <td className="px-3 py-2">{lot.pax_total}</td>
                      <td className="px-3 py-2">Cap: {lot.capacity ?? "N/D"}<br />Disp: {lot.remaining_seats ?? "N/D"}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {lot.alerts.length > 0 ? lot.alerts.map((alert) => (
                            <span key={`${lot.key}-${alert.label}`} className={alert.severity === "high" ? "rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-700" : alert.severity === "medium" ? "rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700" : "rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-700"}>{alert.label}</span>
                          )) : <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">Disponibile</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => setSelectedLotKey(lot.key)}>
                          Modifica
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card space-y-3 p-4">
          <h2 className="font-semibold">Dettaglio lotto bus</h2>
          {!selectedLot ? (
            <p className="text-sm text-muted">Seleziona un lotto linea bus.</p>
          ) : (
            <>
              <p className="text-sm"><span className="font-medium">Titolo:</span> {selectedLot.title ?? "N/D"}</p>
              <p className="text-sm"><span className="font-medium">Agenzie:</span> {selectedLot.billing_party_name ?? "N/D"}</p>
              <p className="text-sm"><span className="font-medium">Origine:</span> {selectedLot.bus_city_origin ?? "N/D"}</p>
              <p className="text-sm"><span className="font-medium">Codice bus:</span> {selectedLot.transport_code ?? "N/D"}</p>
              <p className="text-sm"><span className="font-medium">Meeting point:</span> {selectedLot.meeting_point ?? "N/D"}</p>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="text-sm">Titolo lotto
                  <input className="input-saas mt-1" value={getLotDraft(selectedLot).title} onChange={(event) => setLotDrafts((prev) => ({ ...prev, [selectedLot.key]: { ...getLotDraft(selectedLot), title: event.target.value } }))} />
                </label>
                <label className="text-sm">Capacita
                  <input className="input-saas mt-1" type="number" min={selectedLot.pax_total} value={getLotDraft(selectedLot).capacity} onChange={(event) => setLotDrafts((prev) => ({ ...prev, [selectedLot.key]: { ...getLotDraft(selectedLot), capacity: event.target.value } }))} />
                </label>
                <label className="text-sm">Soglia pochi posti
                  <input className="input-saas mt-1" type="number" min={0} value={getLotDraft(selectedLot).lowSeatThreshold} onChange={(event) => setLotDrafts((prev) => ({ ...prev, [selectedLot.key]: { ...getLotDraft(selectedLot), lowSeatThreshold: event.target.value } }))} />
                </label>
                <label className="text-sm">Minimo passeggeri
                  <input className="input-saas mt-1" type="number" min={1} value={getLotDraft(selectedLot).minimumPassengers} onChange={(event) => setLotDrafts((prev) => ({ ...prev, [selectedLot.key]: { ...getLotDraft(selectedLot), minimumPassengers: event.target.value } }))} />
                </label>
                <label className="text-sm">Pax waiting list
                  <input className="input-saas mt-1" type="number" min={0} value={getLotDraft(selectedLot).waitlistCount} onChange={(event) => setLotDrafts((prev) => ({ ...prev, [selectedLot.key]: { ...getLotDraft(selectedLot), waitlistCount: event.target.value } }))} />
                </label>
                <label className="text-sm">Disponibilita residua
                  <input className="input-saas mt-1 bg-slate-100" value={selectedLot.remaining_seats ?? "N/D"} readOnly disabled />
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={getLotDraft(selectedLot).waitlistEnabled} onChange={(event) => setLotDrafts((prev) => ({ ...prev, [selectedLot.key]: { ...getLotDraft(selectedLot), waitlistEnabled: event.target.checked } }))} />
                  Waiting list attiva
                </label>
                <label className="text-sm md:col-span-2">Note lotto
                  <textarea className="input-saas mt-1 min-h-[84px]" value={getLotDraft(selectedLot).notes} onChange={(event) => setLotDrafts((prev) => ({ ...prev, [selectedLot.key]: { ...getLotDraft(selectedLot), notes: event.target.value } }))} />
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                <span>Servizi: {selectedLot.service_count}</span>
                <span>Pax: {selectedLot.pax_total}</span>
                <span>Posti disponibili: {selectedLot.remaining_seats ?? "N/D"}</span>
              </div>
              <button type="button" className="btn-primary px-3 py-2 text-sm" disabled={busyId === selectedLot.key} onClick={() => void saveLotConfig(selectedLot)}>
                {busyId === selectedLot.key ? "Salvataggio..." : "Salva lotto bus"}
              </button>
              <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="text-sm font-medium text-text">Servizi inclusi nel lotto</p>
                {selectedLot.services.map((service) => (
                  <div key={service.id} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
                    {service.time} | {service.customer_name} | {service.pax} pax | {hotelsById.get(service.hotel_id)?.name ?? "Hotel N/D"}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-3">
          <h2 className="font-semibold">Escursioni bus / altri servizi singoli</h2>
          <p className="text-sm text-muted">Qui restano i bus veri singoli, non i lotti della linea bus.</p>
        </div>
        {filteredBusTours.length === 0 ? (
          <EmptyState title="Nessuna escursione bus trovata." compact />
        ) : (
          <DataTable toolbar={<p className="text-xs text-muted">Righe visualizzate: {filteredBusTours.length}</p>} footer={<p className="text-xs text-muted">Totale escursioni filtrate: {filteredBusTours.length}</p>}>
            <thead>
              <tr>
                <th className="px-4 py-3">Data/Ora</th>
                <th className="px-4 py-3">Tour</th>
                <th className="px-4 py-3">Pax</th>
                <th className="px-4 py-3">Stato</th>
                <th className="px-4 py-3">Assegna bus/driver</th>
                <th className="px-4 py-3">Cambia stato</th>
                <th className="px-4 py-3">Dettaglio</th>
              </tr>
            </thead>
            <tbody>
              {filteredBusTours.map((service) => {
                const assignment = assignmentsByServiceId.get(service.id);
                const draftDriverValue = draftDrivers[service.id] ?? assignment?.driver_user_id ?? drivers[0]?.user_id ?? "";
                const draftBusValue = draftBus[service.id] ?? assignment?.vehicle_label ?? service.bus_plate ?? "";
                const draftStatusValue = draftStatus[service.id] ?? service.status;
                return (
                  <tr key={service.id}>
                    <td className="whitespace-nowrap px-4 py-3">{service.date} {service.time}</td>
                    <td className="px-4 py-3">
                      <p className="line-clamp-2 text-safe-wrap font-medium">{service.tour_name ?? "Tour N/D"}</p>
                      <p className="line-clamp-1 text-xs text-muted">{hotelsById.get(service.hotel_id)?.zone ?? "Zona N/D"}</p>
                    </td>
                    <td className="px-4 py-3">{service.pax}</td>
                    <td className="px-4 py-3"><span className="status-badge status-badge-assigned">{SERVICE_STATUS_LABELS[service.status]}</span></td>
                    <td className="px-4 py-3">
                      <div className="flex min-w-[280px] items-center gap-2">
                        <select className="input-saas min-w-[120px]" value={draftDriverValue} onChange={(event) => setDraftDrivers((prev) => ({ ...prev, [service.id]: event.target.value }))}>
                          {drivers.map((driver) => (
                            <option key={driver.user_id} value={driver.user_id}>{driver.full_name}</option>
                          ))}
                        </select>
                        <input className="input-saas min-w-[120px]" value={draftBusValue} onChange={(event) => setDraftBus((prev) => ({ ...prev, [service.id]: event.target.value }))} placeholder="Targa bus" />
                        <button type="button" className="btn-secondary whitespace-nowrap px-3 py-2" disabled={busyId === service.id} onClick={() => void handleAssignTour(service.id)}>Assegna</button>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex min-w-[220px] items-center gap-2">
                        <select className="input-saas" value={draftStatusValue} onChange={(event) => setDraftStatus((prev) => ({ ...prev, [service.id]: event.target.value as ServiceStatus }))}>
                          <option value="new">{SERVICE_STATUS_LABELS.new}</option>
                          <option value="assigned">{SERVICE_STATUS_LABELS.assigned}</option>
                          <option value="partito">{SERVICE_STATUS_LABELS.partito}</option>
                          <option value="arrivato">{SERVICE_STATUS_LABELS.arrivato}</option>
                          <option value="completato">{SERVICE_STATUS_LABELS.completato}</option>
                          <option value="cancelled">{SERVICE_STATUS_LABELS.cancelled}</option>
                        </select>
                        <button type="button" className="btn-secondary whitespace-nowrap px-3 py-2" disabled={busyId === service.id} onClick={() => void handleTourStatusChange(service.id)}>Aggiorna</button>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <button type="button" className="btn-secondary px-3 py-2 text-xs" onClick={() => setSelectedTourServiceId(service.id)}>Apri</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        )}
      </div>

      {selectedTour ? (
        <aside className="card space-y-2 p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Dettaglio escursione bus</h2>
            <button type="button" className="text-sm text-muted" onClick={() => setSelectedTourServiceId(null)}>Chiudi</button>
          </div>
          <p className="text-sm">Tour: {selectedTour.tour_name ?? "N/D"}</p>
          <p className="text-sm">Data/Ora: {selectedTour.date} {selectedTour.time}</p>
          <p className="text-sm">Cliente: {selectedTour.customer_name}</p>
          <p className="text-sm">Hotel: {selectedTourHotel?.name ?? "N/D"} ({selectedTourHotel?.zone ?? "N/D"})</p>
          <p className="text-sm">Meeting point: {selectedTour.meeting_point ?? "N/D"}</p>
          <p className="text-sm">Fermate: {(selectedTour.stops ?? []).join(", ") || "N/D"}</p>
          <p className="text-sm">Capacita: {selectedTour.capacity ?? "N/D"}</p>
          <p className="text-sm">Autista: {selectedTourAssignment?.driver_user_id ? driverNameById.get(selectedTourAssignment.driver_user_id) ?? selectedTourAssignment.driver_user_id : "N/D"}</p>
          <p className="text-sm">Bus: {selectedTourAssignment?.vehicle_label ?? selectedTour.bus_plate ?? "N/D"}</p>
        </aside>
      ) : null}

      {message ? <div className="fixed bottom-4 right-4 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white">{message}</div> : null}
    </section>
  );
}
