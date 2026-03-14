"use client";

import { useEffect, useMemo, useState } from "react";
import { DataTable, EmptyState, FilterBar, PageHeader } from "@/components/ui";
import { supabase } from "@/lib/supabase/client";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";
import type { ServiceStatus } from "@/lib/types";
import { SERVICE_STATUS_LABELS } from "@/lib/ui-labels";

export default function BusToursPage() {
  const { loading, tenantId, userId, errorMessage, data, refresh } = useTenantOperationalData();
  const [dateFilter, setDateFilter] = useState("all");
  const [tourNameFilter, setTourNameFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<ServiceStatus | "all">("all");
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [draftDrivers, setDraftDrivers] = useState<Record<string, string>>({});
  const [draftBus, setDraftBus] = useState<Record<string, string>>({});
  const [draftStatus, setDraftStatus] = useState<Record<string, ServiceStatus>>({});
  const [busyServiceId, setBusyServiceId] = useState<string | null>(null);
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(""), 2200);
    return () => window.clearTimeout(timeout);
  }, [message]);

  const busTours = data.services.filter((service) => (service.service_type ?? "transfer") === "bus_tour");
  const assignmentsByServiceId = new Map(data.assignments.map((assignment) => [assignment.service_id, assignment]));
  const hotelsById = new Map(data.hotels.map((hotel) => [hotel.id, hotel]));
  const drivers = data.memberships.filter((member) => member.role === "driver");
  const driverNameById = new Map(drivers.map((driver) => [driver.user_id, driver.full_name]));

  const availableDates = useMemo(() => [...new Set(busTours.map((service) => service.date))].sort(), [busTours]);
  const filteredTours = useMemo(() => {
    return busTours.filter((service) => {
      const byDate = dateFilter === "all" || service.date === dateFilter;
      const byTourName = tourNameFilter.trim().length === 0 || (service.tour_name ?? "").toLowerCase().includes(tourNameFilter.trim().toLowerCase());
      const byStatus = statusFilter === "all" || service.status === statusFilter;
      return byDate && byTourName && byStatus;
    });
  }, [busTours, dateFilter, statusFilter, tourNameFilter]);

  const selectedService = filteredTours.find((service) => service.id === selectedServiceId) ?? busTours.find((service) => service.id === selectedServiceId) ?? filteredTours[0] ?? null;
  const selectedHotel = selectedService ? hotelsById.get(selectedService.hotel_id) : null;
  const selectedAssignment = selectedService ? assignmentsByServiceId.get(selectedService.id) : null;

  const handleAssign = async (serviceId: string) => {
    const service = busTours.find((item) => item.id === serviceId);
    if (!service || !supabase || !tenantId) return;

    const existingAssignment = assignmentsByServiceId.get(serviceId);
    const nextDriverId = draftDrivers[serviceId] ?? existingAssignment?.driver_user_id ?? drivers[0]?.user_id ?? "";
    const nextBusLabel = (draftBus[serviceId] ?? existingAssignment?.vehicle_label ?? service.bus_plate ?? "").trim();

    if (!nextDriverId) {
      setMessage("Seleziona un driver.");
      return;
    }
    if (!nextBusLabel) {
      setMessage("Inserisci il bus/mezzo.");
      return;
    }

    setBusyServiceId(serviceId);
    if (existingAssignment) {
      const { error: updateAssignmentError } = await supabase
        .from("assignments")
        .update({ driver_user_id: nextDriverId, vehicle_label: nextBusLabel })
        .eq("id", existingAssignment.id)
        .eq("tenant_id", tenantId);
      if (updateAssignmentError) {
        setBusyServiceId(null);
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
        setBusyServiceId(null);
        setMessage("Errore creazione assegnazione.");
        return;
      }
    }

    const { error: updateServiceError } = await supabase
      .from("services")
      .update({ status: "assigned", bus_plate: nextBusLabel })
      .eq("id", serviceId)
      .eq("tenant_id", tenantId);
    if (updateServiceError) {
      setBusyServiceId(null);
      setMessage("Errore aggiornamento servizio.");
      return;
    }

    if (userId) {
      await supabase.from("status_events").insert({
        tenant_id: tenantId,
        service_id: serviceId,
        status: "assigned",
        by_user_id: userId
      });
    }
    await refresh();
    setDraftBus((prev) => ({ ...prev, [serviceId]: nextBusLabel }));
    setBusyServiceId(null);
    setMessage("Bus tour assegnato.");
  };

  const handleStatusChange = async (serviceId: string) => {
    const service = busTours.find((item) => item.id === serviceId);
    if (!service || !supabase || !tenantId) return;
    const nextStatus = draftStatus[serviceId] ?? service.status;
    if (nextStatus === service.status) {
      setMessage("Nessuna modifica stato.");
      return;
    }

    setBusyServiceId(serviceId);
    const { error: serviceUpdateError } = await supabase
      .from("services")
      .update({ status: nextStatus })
      .eq("id", serviceId)
      .eq("tenant_id", tenantId);
    if (serviceUpdateError) {
      setBusyServiceId(null);
      setMessage("Errore aggiornamento stato.");
      return;
    }

    if (userId) {
      await supabase.from("status_events").insert({
        tenant_id: tenantId,
        service_id: serviceId,
        status: nextStatus,
        by_user_id: userId
      });
    }

    await refresh();
    setBusyServiceId(null);
    setMessage(`Stato aggiornato: ${nextStatus}`);
  };

  if (loading) return <div className="card p-4 text-sm text-muted">Caricamento escursioni bus...</div>;
  if (errorMessage) return <div className="card p-4 text-sm text-muted">{errorMessage}</div>;

  return (
    <section className="page-section">
      <PageHeader title="Escursioni Bus" subtitle={`Totale: ${filteredTours.length}`} breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Escursioni bus" }]} />

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
          Nome tour
          <input className="input-saas mt-1 w-full" value={tourNameFilter} onChange={(event) => setTourNameFilter(event.target.value)} placeholder="Tour Ischia..." />
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

      {filteredTours.length === 0 ? (
        <EmptyState title="Nessuna escursione bus trovata." compact />
      ) : (
        <DataTable toolbar={<p className="text-xs text-muted">Righe visualizzate: {filteredTours.length}</p>} footer={<p className="text-xs text-muted">Totale escursioni filtrate: {filteredTours.length}</p>}>
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
            {filteredTours.map((service) => {
              const assignment = assignmentsByServiceId.get(service.id);
              const draftDriverValue = draftDrivers[service.id] ?? assignment?.driver_user_id ?? drivers[0]?.user_id ?? "";
              const draftBusValue = draftBus[service.id] ?? assignment?.vehicle_label ?? service.bus_plate ?? "";
              const draftStatusValue = draftStatus[service.id] ?? service.status;
              return (
                <tr key={service.id}>
                  <td className="whitespace-nowrap px-4 py-3">
                    {service.date} {service.time}
                  </td>
                  <td className="px-4 py-3">
                    <p className="line-clamp-2 text-safe-wrap font-medium">{service.tour_name ?? "Tour N/D"}</p>
                    <p className="line-clamp-1 text-xs text-muted">{hotelsById.get(service.hotel_id)?.zone ?? "Zona N/D"}</p>
                  </td>
                  <td className="px-4 py-3">{service.pax}</td>
                  <td className="px-4 py-3">
                    <span className="status-badge status-badge-assigned">{SERVICE_STATUS_LABELS[service.status]}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex min-w-[280px] items-center gap-2">
                      <select className="input-saas min-w-[120px]" value={draftDriverValue} onChange={(event) => setDraftDrivers((prev) => ({ ...prev, [service.id]: event.target.value }))}>
                        {drivers.map((driver) => (
                          <option key={driver.user_id} value={driver.user_id}>
                            {driver.full_name}
                          </option>
                        ))}
                      </select>
                      <input className="input-saas min-w-[120px]" value={draftBusValue} onChange={(event) => setDraftBus((prev) => ({ ...prev, [service.id]: event.target.value }))} placeholder="Targa bus" />
                      <button type="button" className="btn-secondary whitespace-nowrap px-3 py-2" disabled={busyServiceId === service.id} onClick={() => void handleAssign(service.id)}>
                        Assegna
                      </button>
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
                      <button type="button" className="btn-secondary whitespace-nowrap px-3 py-2" disabled={busyServiceId === service.id} onClick={() => void handleStatusChange(service.id)}>
                        Aggiorna
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <button type="button" className="btn-secondary px-3 py-2 text-xs" onClick={() => setSelectedServiceId(service.id)}>
                      Apri
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}

      {selectedService ? (
        <aside className="card space-y-2 p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Dettaglio escursione</h2>
            <button type="button" className="text-sm text-muted" onClick={() => setSelectedServiceId(null)}>
              Chiudi
            </button>
          </div>
          <p className="text-sm">Tour: {selectedService.tour_name ?? "N/D"}</p>
          <p className="text-sm">
            Data/Ora: {selectedService.date} {selectedService.time}
          </p>
          <p className="text-sm">Cliente: {selectedService.customer_name}</p>
          <p className="text-sm">
            Hotel: {selectedHotel?.name ?? "N/D"} ({selectedHotel?.zone ?? "N/D"})
          </p>
          <p className="text-sm">Meeting point: {selectedService.meeting_point ?? "N/D"}</p>
          <p className="text-sm">Fermate: {(selectedService.stops ?? []).join(", ") || "N/D"}</p>
          <p className="text-sm">Capacita: {selectedService.capacity ?? "N/D"}</p>
          <p className="text-sm">
            Autista:{" "}
            {selectedAssignment?.driver_user_id ? driverNameById.get(selectedAssignment.driver_user_id) ?? selectedAssignment.driver_user_id : "N/D"}
          </p>
          <p className="text-sm">Bus: {selectedAssignment?.vehicle_label ?? selectedService.bus_plate ?? "N/D"}</p>
        </aside>
      ) : null}

      {message ? <div className="fixed bottom-4 right-4 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white">{message}</div> : null}
    </section>
  );
}
