"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { useDemoStore } from "@/lib/use-demo-store";
import type { ServiceStatus } from "@/lib/types";

export default function BusToursPage() {
  const { state, loading, replaceTenantOperationalData, assignDriver, setServiceStatus } = useDemoStore();
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [actorUserId, setActorUserId] = useState<string | null>(null);
  const [dateFilter, setDateFilter] = useState("all");
  const [tourNameFilter, setTourNameFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<ServiceStatus | "all">("all");
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [draftDrivers, setDraftDrivers] = useState<Record<string, string>>({});
  const [draftBus, setDraftBus] = useState<Record<string, string>>({});
  const [draftStatus, setDraftStatus] = useState<Record<string, ServiceStatus>>({});
  const [busyServiceId, setBusyServiceId] = useState<string | null>(null);
  const [message, setMessage] = useState<string>("");

  const loadTenantData = useCallback(
    async (currentTenantId: string) => {
      if (!hasSupabaseEnv || !supabase) return;
      const [servicesResult, assignmentsResult, statusEventsResult, hotelsResult, membershipsResult] = await Promise.all([
        supabase.from("services").select("*").eq("tenant_id", currentTenantId),
        supabase.from("assignments").select("*").eq("tenant_id", currentTenantId),
        supabase.from("status_events").select("*").eq("tenant_id", currentTenantId),
        supabase.from("hotels").select("*").eq("tenant_id", currentTenantId),
        supabase.from("memberships").select("*").eq("tenant_id", currentTenantId)
      ]);

      if (
        servicesResult.error ||
        assignmentsResult.error ||
        statusEventsResult.error ||
        hotelsResult.error ||
        membershipsResult.error
      ) {
        return;
      }

      replaceTenantOperationalData(currentTenantId, {
        services: servicesResult.data ?? [],
        assignments: assignmentsResult.data ?? [],
        statusEvents: statusEventsResult.data ?? [],
        hotels: hotelsResult.data ?? [],
        memberships: membershipsResult.data ?? []
      });
    },
    [replaceTenantOperationalData]
  );

  useEffect(() => {
    const client = supabase;
    if (!hasSupabaseEnv || !client) return;
    let active = true;

    const init = async () => {
      const { data: userData, error: userError } = await client.auth.getUser();
      if (userError || !userData.user || !active) return;
      setActorUserId(userData.user.id);

      const { data: membership, error: membershipError } = await client
        .from("memberships")
        .select("tenant_id")
        .eq("user_id", userData.user.id)
        .maybeSingle();

      if (membershipError || !membership?.tenant_id || !active) return;
      setTenantId(membership.tenant_id);
      await loadTenantData(membership.tenant_id);
    };

    void init();
    return () => {
      active = false;
    };
  }, [loadTenantData]);

  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(""), 2200);
    return () => window.clearTimeout(timeout);
  }, [message]);

  const effectiveTenantId = tenantId ?? state.memberships[0]?.tenant_id ?? state.services[0]?.tenant_id ?? null;
  const tenantServices = effectiveTenantId
    ? state.services.filter((service) => service.tenant_id === effectiveTenantId)
    : state.services;
  const tenantAssignments = effectiveTenantId
    ? state.assignments.filter((assignment) => assignment.tenant_id === effectiveTenantId)
    : state.assignments;
  const tenantMemberships = effectiveTenantId
    ? state.memberships.filter((membership) => membership.tenant_id === effectiveTenantId)
    : state.memberships;
  const tenantHotels = effectiveTenantId
    ? state.hotels.filter((hotel) => hotel.tenant_id === effectiveTenantId)
    : state.hotels;

  const busTours = tenantServices.filter((service) => (service.service_type ?? "transfer") === "bus_tour");
  const assignmentsByServiceId = new Map(tenantAssignments.map((assignment) => [assignment.service_id, assignment]));
  const hotelsById = new Map(tenantHotels.map((hotel) => [hotel.id, hotel]));
  const drivers = tenantMemberships.filter((member) => member.role === "driver");
  const driverNameById = new Map(drivers.map((driver) => [driver.user_id, driver.full_name]));

  const availableDates = useMemo(() => [...new Set(busTours.map((service) => service.date))].sort(), [busTours]);
  const filteredTours = useMemo(() => {
    return busTours.filter((service) => {
      const byDate = dateFilter === "all" || service.date === dateFilter;
      const byTourName =
        tourNameFilter.trim().length === 0 || (service.tour_name ?? "").toLowerCase().includes(tourNameFilter.trim().toLowerCase());
      const byStatus = statusFilter === "all" || service.status === statusFilter;
      return byDate && byTourName && byStatus;
    });
  }, [busTours, dateFilter, statusFilter, tourNameFilter]);

  const selectedService =
    filteredTours.find((service) => service.id === selectedServiceId) ??
    busTours.find((service) => service.id === selectedServiceId) ??
    filteredTours[0] ??
    null;
  const selectedHotel = selectedService ? hotelsById.get(selectedService.hotel_id) : null;
  const selectedAssignment = selectedService ? assignmentsByServiceId.get(selectedService.id) : null;

  const handleAssign = async (serviceId: string) => {
    const service = busTours.find((item) => item.id === serviceId);
    if (!service) return;

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

    const client = supabase;
    if (hasSupabaseEnv && client && effectiveTenantId) {
      if (existingAssignment) {
        const { error: updateAssignmentError } = await client
          .from("assignments")
          .update({ driver_user_id: nextDriverId, vehicle_label: nextBusLabel })
          .eq("id", existingAssignment.id)
          .eq("tenant_id", effectiveTenantId);
        if (updateAssignmentError) {
          setBusyServiceId(null);
          setMessage("Errore aggiornamento assegnazione.");
          return;
        }
      } else {
        const { error: insertAssignmentError } = await client.from("assignments").insert({
          tenant_id: effectiveTenantId,
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

      const { error: updateServiceError } = await client
        .from("services")
        .update({ status: "assigned", bus_plate: nextBusLabel })
        .eq("id", serviceId)
        .eq("tenant_id", effectiveTenantId);
      if (updateServiceError) {
        setBusyServiceId(null);
        setMessage("Errore aggiornamento servizio.");
        return;
      }

      const { error: insertStatusEventError } = await client.from("status_events").insert({
        tenant_id: effectiveTenantId,
        service_id: serviceId,
        status: "assigned",
        by_user_id: actorUserId
      });
      if (insertStatusEventError) {
        setBusyServiceId(null);
        setMessage("Errore inserimento status event.");
        return;
      }
    }

    assignDriver(serviceId, nextDriverId, nextBusLabel);
    if (service.status !== "assigned") {
      setServiceStatus(serviceId, "assigned", actorUserId ?? "system");
    }
    setDraftBus((prev) => ({ ...prev, [serviceId]: nextBusLabel }));
    setBusyServiceId(null);
    setMessage("Bus tour assegnato.");
    if (effectiveTenantId) {
      void loadTenantData(effectiveTenantId);
    }
  };

  const handleStatusChange = async (serviceId: string) => {
    const service = busTours.find((item) => item.id === serviceId);
    if (!service) return;
    const nextStatus = draftStatus[serviceId] ?? service.status;
    if (nextStatus === service.status) {
      setMessage("Nessuna modifica stato.");
      return;
    }

    setBusyServiceId(serviceId);

    const client = supabase;
    if (hasSupabaseEnv && client && effectiveTenantId) {
      const { error: serviceUpdateError } = await client
        .from("services")
        .update({ status: nextStatus })
        .eq("id", serviceId)
        .eq("tenant_id", effectiveTenantId);
      if (serviceUpdateError) {
        setBusyServiceId(null);
        setMessage("Errore aggiornamento stato.");
        return;
      }

      const { error: eventInsertError } = await client.from("status_events").insert({
        tenant_id: effectiveTenantId,
        service_id: serviceId,
        status: nextStatus,
        by_user_id: actorUserId
      });
      if (eventInsertError) {
        setBusyServiceId(null);
        setMessage("Errore salvataggio status event.");
        return;
      }
    }

    setServiceStatus(serviceId, nextStatus, actorUserId ?? "system");
    setBusyServiceId(null);
    setMessage(`Stato aggiornato: ${nextStatus}`);
    if (effectiveTenantId) {
      void loadTenantData(effectiveTenantId);
    }
  };

  if (loading) return <div className="card p-4 text-sm text-muted">Caricamento escursioni bus...</div>;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Escursioni Bus</h1>
        <p className="text-sm text-muted">Totale: {filteredTours.length}</p>
      </div>

      <div className="card grid gap-3 p-3 md:grid-cols-3">
        <label className="text-xs text-muted">
          Data
          <select className="input-saas mt-1 w-full" value={dateFilter} onChange={(event) => setDateFilter(event.target.value)}>
            <option value="all">all</option>
            {availableDates.map((date) => (
              <option key={date} value={date}>
                {date}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted">
          Tour name
          <input
            className="input-saas mt-1 w-full"
            value={tourNameFilter}
            onChange={(event) => setTourNameFilter(event.target.value)}
            placeholder="Tour Ischia..."
          />
        </label>
        <label className="text-xs text-muted">
          Status
          <select
            className="input-saas mt-1 w-full"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as ServiceStatus | "all")}
          >
            <option value="all">all</option>
            <option value="new">new</option>
            <option value="assigned">assigned</option>
            <option value="partito">partito</option>
            <option value="arrivato">arrivato</option>
            <option value="completato">completato</option>
            <option value="cancelled">cancelled</option>
          </select>
        </label>
      </div>

      {filteredTours.length === 0 ? (
        <div className="card p-4 text-sm text-muted">Nessuna escursione bus trovata.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="sticky top-0 z-10 border-b border-border bg-white text-left text-muted">
              <tr>
                <th className="px-4 py-3">Data/Ora</th>
                <th className="px-4 py-3">Tour</th>
                <th className="px-4 py-3">Pax</th>
                <th className="px-4 py-3">Status</th>
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
                  <tr key={service.id} className="border-t border-border/50 odd:bg-white even:bg-slate-50/60 hover:bg-blue-50/80">
                    <td className="px-4 py-3">{service.date} {service.time}</td>
                    <td className="px-4 py-3">
                      <p className="font-medium">{service.tour_name ?? "Tour N/D"}</p>
                      <p className="text-xs text-muted">{hotelsById.get(service.hotel_id)?.zone ?? "Zona N/D"}</p>
                    </td>
                    <td className="px-4 py-3">{service.pax}</td>
                    <td className="px-4 py-3">
                      <span className="status-badge status-badge-assigned">{service.status}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex min-w-[280px] items-center gap-2">
                        <select
                          className="input-saas min-w-[120px]"
                          value={draftDriverValue}
                          onChange={(event) => setDraftDrivers((prev) => ({ ...prev, [service.id]: event.target.value }))}
                        >
                          {drivers.map((driver) => (
                            <option key={driver.user_id} value={driver.user_id}>
                              {driver.full_name}
                            </option>
                          ))}
                        </select>
                        <input
                          className="input-saas min-w-[120px]"
                          value={draftBusValue}
                          onChange={(event) => setDraftBus((prev) => ({ ...prev, [service.id]: event.target.value }))}
                          placeholder="Bus plate"
                        />
                        <button
                          type="button"
                          className="btn-secondary whitespace-nowrap px-3 py-2"
                          disabled={busyServiceId === service.id}
                          onClick={() => void handleAssign(service.id)}
                        >
                          Assign
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex min-w-[220px] items-center gap-2">
                        <select
                          className="input-saas"
                          value={draftStatusValue}
                          onChange={(event) =>
                            setDraftStatus((prev) => ({ ...prev, [service.id]: event.target.value as ServiceStatus }))
                          }
                        >
                          <option value="new">new</option>
                          <option value="assigned">assigned</option>
                          <option value="partito">partito</option>
                          <option value="arrivato">arrivato</option>
                          <option value="completato">completato</option>
                          <option value="cancelled">cancelled</option>
                        </select>
                        <button
                          type="button"
                          className="btn-secondary whitespace-nowrap px-3 py-2"
                          disabled={busyServiceId === service.id}
                          onClick={() => void handleStatusChange(service.id)}
                        >
                          Update
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        className="btn-secondary px-3 py-2 text-xs"
                        onClick={() => setSelectedServiceId(service.id)}
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
          <p className="text-sm">Data/Ora: {selectedService.date} {selectedService.time}</p>
          <p className="text-sm">Cliente: {selectedService.customer_name}</p>
          <p className="text-sm">Hotel: {selectedHotel?.name ?? "N/D"} ({selectedHotel?.zone ?? "N/D"})</p>
          <p className="text-sm">Meeting point: {selectedService.meeting_point ?? "N/D"}</p>
          <p className="text-sm">Stops: {(selectedService.stops ?? []).join(", ") || "N/D"}</p>
          <p className="text-sm">Capacity: {selectedService.capacity ?? "N/D"}</p>
          <p className="text-sm">Driver: {selectedAssignment?.driver_user_id ? driverNameById.get(selectedAssignment.driver_user_id) ?? selectedAssignment.driver_user_id : "N/D"}</p>
          <p className="text-sm">Bus: {selectedAssignment?.vehicle_label ?? selectedService.bus_plate ?? "N/D"}</p>
        </aside>
      ) : null}

      {message ? <div className="fixed bottom-4 right-4 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white">{message}</div> : null}
    </section>
  );
}
