"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { useDemoStore } from "@/lib/use-demo-store";
import type { ServiceStatus, ServiceType } from "@/lib/types";

const DynamicMap = dynamic(() => import("@/components/leaflet-map").then((mod) => mod.LeafletMap), {
  ssr: false,
  loading: () => <div className="card p-4 text-sm text-slate-500">Caricamento mappa...</div>
});

export default function MapPage() {
  const { state, loading, setServiceStatus, assignDriver } = useDemoStore();
  const [statusFilter, setStatusFilter] = useState<ServiceStatus | "all">("all");
  const [serviceTypeFilter, setServiceTypeFilter] = useState<ServiceType | "all">("all");
  const [driverFilter, setDriverFilter] = useState<string>("all");
  const [vesselFilter, setVesselFilter] = useState("all");
  const [zoneFilter, setZoneFilter] = useState("all");
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const vessels = useMemo(() => [...new Set(state.services.map((service) => service.vessel))], [state.services]);
  const zones = useMemo(() => [...new Set(state.hotels.map((hotel) => hotel.zone))], [state.hotels]);
  const drivers = useMemo(() => state.memberships.filter((member) => member.role === "driver"), [state.memberships]);
  const assignmentsByServiceId = useMemo(
    () => new Map(state.assignments.map((assignment) => [assignment.service_id, assignment])),
    [state.assignments]
  );
  const hotelsById = useMemo(() => new Map(state.hotels.map((hotel) => [hotel.id, hotel])), [state.hotels]);
  const driverNamesById = useMemo(
    () => new Map(drivers.map((driver) => [driver.user_id, driver.full_name])),
    [drivers]
  );

  const filteredServices = useMemo(() => {
    return state.services.filter((service) => {
      const hotel = hotelsById.get(service.hotel_id);
      const assignment = assignmentsByServiceId.get(service.id);
      const byStatus = statusFilter === "all" || service.status === statusFilter;
      const byType = serviceTypeFilter === "all" || (service.service_type ?? "transfer") === serviceTypeFilter;
      const byDriver = driverFilter === "all" || assignment?.driver_user_id === driverFilter;
      const byVessel = vesselFilter === "all" || service.vessel === vesselFilter;
      const byZone = zoneFilter === "all" || hotel?.zone === zoneFilter;
      return byStatus && byType && byDriver && byVessel && byZone;
    });
  }, [state.services, hotelsById, assignmentsByServiceId, statusFilter, serviceTypeFilter, driverFilter, vesselFilter, zoneFilter]);

  const selectedService = useMemo(
    () => filteredServices.find((service) => service.id === selectedServiceId) ?? filteredServices[0] ?? null,
    [filteredServices, selectedServiceId]
  );

  const updateStatus = async (serviceId: string, nextStatus: ServiceStatus) => {
    const current = state.services.find((item) => item.id === serviceId);
    if (!current) return;

    if (hasSupabaseEnv && supabase) {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData.user) {
        setMessage("Utente non autenticato.");
        return;
      }

      const { data: membership, error: membershipError } = await supabase
        .from("memberships")
        .select("tenant_id")
        .eq("user_id", userData.user.id)
        .maybeSingle();

      if (membershipError || !membership?.tenant_id) {
        setMessage("Tenant non trovato.");
        return;
      }

      const { error: updateError } = await supabase
        .from("services")
        .update({ status: nextStatus })
        .eq("id", serviceId)
        .eq("tenant_id", membership.tenant_id);

      if (updateError) {
        setMessage(updateError.message);
        return;
      }

      await supabase.from("status_events").insert({
        tenant_id: membership.tenant_id,
        service_id: serviceId,
        status: nextStatus,
        by_user_id: userData.user.id
      });
    }

    setServiceStatus(serviceId, nextStatus, drivers[0]?.user_id ?? "system");
    setMessage(`Stato aggiornato: ${nextStatus}`);
  };

  const quickAssign = async (serviceId: string) => {
    const service = state.services.find((item) => item.id === serviceId);
    const targetDriver = drivers[0];
    if (!service || !targetDriver) return;

    const vehicleLabel = service.pax >= 6 ? "VAN" : "CAR";

    if (hasSupabaseEnv && supabase) {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData.user) {
        setMessage("Utente non autenticato.");
        return;
      }

      const { data: membership, error: membershipError } = await supabase
        .from("memberships")
        .select("tenant_id")
        .eq("user_id", userData.user.id)
        .maybeSingle();

      if (membershipError || !membership?.tenant_id) {
        setMessage("Tenant non trovato.");
        return;
      }

      const existing = state.assignments.find((item) => item.service_id === serviceId && item.tenant_id === membership.tenant_id);
      if (existing) {
        const { error: updateAssignmentError } = await supabase
          .from("assignments")
          .update({ driver_user_id: targetDriver.user_id, vehicle_label: vehicleLabel })
          .eq("id", existing.id)
          .eq("tenant_id", membership.tenant_id);
        if (updateAssignmentError) {
          setMessage(updateAssignmentError.message);
          return;
        }
      } else {
        const { error: insertAssignmentError } = await supabase.from("assignments").insert({
          tenant_id: membership.tenant_id,
          service_id: serviceId,
          driver_user_id: targetDriver.user_id,
          vehicle_label: vehicleLabel
        });
        if (insertAssignmentError) {
          setMessage(insertAssignmentError.message);
          return;
        }
      }

      await supabase.from("services").update({ status: "assigned" }).eq("id", serviceId).eq("tenant_id", membership.tenant_id);
      await supabase.from("status_events").insert({
        tenant_id: membership.tenant_id,
        service_id: serviceId,
        status: "assigned",
        by_user_id: userData.user.id
      });
    }

    assignDriver(serviceId, targetDriver.user_id, vehicleLabel);
    setMessage(`Assegnato a ${targetDriver.full_name}`);
  };

  if (loading) return <div className="card p-4 text-sm text-slate-500">Caricamento mappa...</div>;

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Mappa Operativa</h1>
      <div className="card grid gap-3 p-3 md:grid-cols-5">
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as ServiceStatus | "all")}
          className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
        >
          <option value="all">Stato: tutti</option>
          <option value="new">new</option>
          <option value="assigned">assigned</option>
          <option value="partito">partito</option>
          <option value="arrivato">arrivato</option>
          <option value="completato">completato</option>
          <option value="cancelled">cancelled</option>
        </select>
        <select
          value={driverFilter}
          onChange={(event) => setDriverFilter(event.target.value)}
          className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
        >
          <option value="all">Driver: tutti</option>
          {drivers.map((driver) => (
            <option key={driver.user_id} value={driver.user_id}>
              {driver.full_name}
            </option>
          ))}
        </select>
        <select
          value={serviceTypeFilter}
          onChange={(event) => setServiceTypeFilter(event.target.value as ServiceType | "all")}
          className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
        >
          <option value="all">Tipo: tutti</option>
          <option value="transfer">transfer</option>
          <option value="bus_tour">bus_tour</option>
        </select>
        <select
          value={vesselFilter}
          onChange={(event) => setVesselFilter(event.target.value)}
          className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
        >
          <option value="all">Nave: tutte</option>
          {vessels.map((vessel) => (
            <option key={vessel} value={vessel}>
              {vessel}
            </option>
          ))}
        </select>
        <select
          value={zoneFilter}
          onChange={(event) => setZoneFilter(event.target.value)}
          className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
        >
          <option value="all">Zona: tutte</option>
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <DynamicMap
          hotels={state.hotels}
          services={filteredServices}
          selectedServiceId={selectedService?.id ?? null}
          onSelectService={setSelectedServiceId}
        />
        <aside className="card max-h-[560px] space-y-2 overflow-y-auto p-3">
          <h2 className="text-sm font-semibold">Servizi filtrati ({filteredServices.length})</h2>
          {selectedService ? (
            <article className="rounded-lg border border-blue-200 bg-blue-50/40 p-3 text-sm">
              <p className="font-semibold">{selectedService.customer_name}</p>
              <p className="uppercase text-slate-600">{selectedService.status}</p>
              <p>Tipo: {selectedService.service_type ?? "transfer"}</p>
              <p>{selectedService.time} - {selectedService.vessel}</p>
              <p>Hotel: {hotelsById.get(selectedService.hotel_id)?.name ?? "N/D"}</p>
              <p>
                Driver:{" "}
                {driverNamesById.get(assignmentsByServiceId.get(selectedService.id)?.driver_user_id ?? "") ?? "Non assegnato"}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" onClick={() => void quickAssign(selectedService.id)} className="btn-secondary px-2 py-1 text-xs">
                  Quick assign
                </button>
                <button type="button" onClick={() => void updateStatus(selectedService.id, "assigned")} className="btn-secondary px-2 py-1 text-xs">
                  Set assigned
                </button>
                <button type="button" onClick={() => void updateStatus(selectedService.id, "partito")} className="btn-secondary px-2 py-1 text-xs">
                  Set partito
                </button>
                <button type="button" onClick={() => void updateStatus(selectedService.id, "arrivato")} className="btn-secondary px-2 py-1 text-xs">
                  Set arrivato
                </button>
                <button type="button" onClick={() => void updateStatus(selectedService.id, "completato")} className="btn-secondary px-2 py-1 text-xs">
                  Set completato
                </button>
              </div>
            </article>
          ) : null}
          {filteredServices.length === 0 ? (
            <p className="text-sm text-slate-500">Nessun servizio.</p>
          ) : (
            filteredServices.map((service) => {
              const hotel = hotelsById.get(service.hotel_id);
              return (
                <article
                  key={service.id}
                  className={`cursor-pointer rounded-lg border p-2 text-sm ${
                    selectedService?.id === service.id ? "border-blue-300 bg-blue-50/40" : "border-slate-200"
                  }`}
                  onClick={() => setSelectedServiceId(service.id)}
                >
                  <p className="font-medium">{service.customer_name}</p>
                  <p className="uppercase text-slate-600">{service.service_type ?? "transfer"}</p>
                  <p>{service.time} - {service.vessel}</p>
                  <p>{hotel?.name ?? "N/D"} ({hotel?.zone ?? "N/D"})</p>
                  <p className="uppercase text-slate-600">{service.status}</p>
                </article>
              );
            })
          )}
          {message ? <p className="rounded-lg bg-slate-100 px-2 py-1 text-xs text-slate-700">{message}</p> : null}
        </aside>
      </div>
    </section>
  );
}
