"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { EmptyState, FilterBar, PageHeader, SectionCard } from "@/components/ui";
import { supabase } from "@/lib/supabase/client";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";
import type { ServiceStatus, ServiceType } from "@/lib/types";
import { SERVICE_STATUS_LABELS, SERVICE_TYPE_LABELS } from "@/lib/ui-labels";

const DynamicMap = dynamic(() => import("@/components/leaflet-map").then((mod) => mod.LeafletMap), {
  ssr: false,
  loading: () => <div className="card p-4 text-sm text-slate-500">Caricamento mappa...</div>
});

export default function MapPage() {
  const { loading, tenantId, userId, errorMessage, data, refresh } = useTenantOperationalData();
  const [statusFilter, setStatusFilter] = useState<ServiceStatus | "all">("all");
  const [serviceTypeFilter, setServiceTypeFilter] = useState<ServiceType | "all">("all");
  const [driverFilter, setDriverFilter] = useState<string>("all");
  const [vesselFilter, setVesselFilter] = useState("all");
  const [zoneFilter, setZoneFilter] = useState("all");
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const vessels = useMemo(() => [...new Set(data.services.map((service) => service.vessel))], [data.services]);
  const zones = useMemo(() => [...new Set(data.hotels.map((hotel) => hotel.zone))], [data.hotels]);
  const drivers = useMemo(() => data.memberships.filter((member) => member.role === "driver"), [data.memberships]);
  const assignmentsByServiceId = useMemo(() => new Map(data.assignments.map((assignment) => [assignment.service_id, assignment])), [data.assignments]);
  const hotelsById = useMemo(() => new Map(data.hotels.map((hotel) => [hotel.id, hotel])), [data.hotels]);
  const driverNamesById = useMemo(() => new Map(drivers.map((driver) => [driver.user_id, driver.full_name])), [drivers]);

  const filteredServices = useMemo(() => {
    return data.services.filter((service) => {
      const hotel = hotelsById.get(service.hotel_id);
      const assignment = assignmentsByServiceId.get(service.id);
      const byStatus = statusFilter === "all" || service.status === statusFilter;
      const byType = serviceTypeFilter === "all" || (service.service_type ?? "transfer") === serviceTypeFilter;
      const byDriver = driverFilter === "all" || assignment?.driver_user_id === driverFilter;
      const byVessel = vesselFilter === "all" || service.vessel === vesselFilter;
      const byZone = zoneFilter === "all" || hotel?.zone === zoneFilter;
      return byStatus && byType && byDriver && byVessel && byZone;
    });
  }, [assignmentsByServiceId, data.services, driverFilter, hotelsById, serviceTypeFilter, statusFilter, vesselFilter, zoneFilter]);

  const selectedService = useMemo(
    () => filteredServices.find((service) => service.id === selectedServiceId) ?? filteredServices[0] ?? null,
    [filteredServices, selectedServiceId]
  );

  const updateStatus = async (serviceId: string, nextStatus: ServiceStatus) => {
    if (!supabase || !tenantId || !userId) {
      setMessage("Tenant non disponibile.");
      return;
    }

    const { error: updateError } = await supabase
      .from("services")
      .update({ status: nextStatus })
      .eq("id", serviceId)
      .eq("tenant_id", tenantId);
    if (updateError) {
      setMessage(updateError.message);
      return;
    }

    await supabase.from("status_events").insert({
      tenant_id: tenantId,
      service_id: serviceId,
      status: nextStatus,
      by_user_id: userId
    });
    await refresh();
    setMessage(`Stato aggiornato: ${nextStatus}`);
  };

  const quickAssign = async (serviceId: string) => {
    const service = data.services.find((item) => item.id === serviceId);
    const targetDriver = drivers[0];
    if (!service || !targetDriver || !supabase || !tenantId || !userId) return;

    const vehicleLabel = service.pax >= 6 ? "VAN" : "CAR";
    const existing = data.assignments.find((item) => item.service_id === serviceId && item.tenant_id === tenantId);
    if (existing) {
      const { error: updateAssignmentError } = await supabase
        .from("assignments")
        .update({ driver_user_id: targetDriver.user_id, vehicle_label: vehicleLabel })
        .eq("id", existing.id)
        .eq("tenant_id", tenantId);
      if (updateAssignmentError) {
        setMessage(updateAssignmentError.message);
        return;
      }
    } else {
      const { error: insertAssignmentError } = await supabase.from("assignments").insert({
        tenant_id: tenantId,
        service_id: serviceId,
        driver_user_id: targetDriver.user_id,
        vehicle_label: vehicleLabel
      });
      if (insertAssignmentError) {
        setMessage(insertAssignmentError.message);
        return;
      }
    }

    await supabase.from("services").update({ status: "assigned" }).eq("id", serviceId).eq("tenant_id", tenantId);
    await supabase.from("status_events").insert({
      tenant_id: tenantId,
      service_id: serviceId,
      status: "assigned",
      by_user_id: userId
    });
    await refresh();
    setMessage(`Assegnato a ${targetDriver.full_name}`);
  };

  if (loading) return <div className="card p-4 text-sm text-slate-500">Caricamento mappa...</div>;
  if (errorMessage) return <div className="card p-4 text-sm text-muted">{errorMessage}</div>;

  return (
    <section className="page-section">
      <PageHeader title="Mappa Operativa" breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Mappa" }]} />
      <FilterBar colsClassName="md:grid-cols-5">
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as ServiceStatus | "all")} className="input-saas">
          <option value="all">Stato: tutti</option>
          <option value="new">{SERVICE_STATUS_LABELS.new}</option>
          <option value="assigned">{SERVICE_STATUS_LABELS.assigned}</option>
          <option value="partito">{SERVICE_STATUS_LABELS.partito}</option>
          <option value="arrivato">{SERVICE_STATUS_LABELS.arrivato}</option>
          <option value="completato">{SERVICE_STATUS_LABELS.completato}</option>
          <option value="cancelled">{SERVICE_STATUS_LABELS.cancelled}</option>
        </select>
        <select value={driverFilter} onChange={(event) => setDriverFilter(event.target.value)} className="input-saas">
          <option value="all">Autista: tutti</option>
          {drivers.map((driver) => (
            <option key={driver.user_id} value={driver.user_id}>
              {driver.full_name}
            </option>
          ))}
        </select>
        <select value={serviceTypeFilter} onChange={(event) => setServiceTypeFilter(event.target.value as ServiceType | "all")} className="input-saas">
          <option value="all">Tipo: tutti</option>
          <option value="transfer">{SERVICE_TYPE_LABELS.transfer}</option>
          <option value="bus_tour">{SERVICE_TYPE_LABELS.bus_tour}</option>
        </select>
        <select value={vesselFilter} onChange={(event) => setVesselFilter(event.target.value)} className="input-saas">
          <option value="all">Nave: tutte</option>
          {vessels.map((vessel) => (
            <option key={vessel} value={vessel}>
              {vessel}
            </option>
          ))}
        </select>
        <select value={zoneFilter} onChange={(event) => setZoneFilter(event.target.value)} className="input-saas">
          <option value="all">Zona: tutte</option>
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </FilterBar>
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <DynamicMap hotels={data.hotels} services={filteredServices} selectedServiceId={selectedService?.id ?? null} onSelectService={setSelectedServiceId} />
        <SectionCard title={`Servizi filtrati (${filteredServices.length})`} className="max-h-[560px] overflow-y-auto p-3 md:p-4" bodyClassName="space-y-2">
          {selectedService ? (
            <article className="rounded-xl border border-blue-200 bg-blue-50/40 p-3 text-sm">
              <p className="line-clamp-2 font-semibold text-safe-wrap">{selectedService.customer_name}</p>
              <p className="uppercase text-slate-600">{selectedService.status}</p>
              <p>Tipo: {selectedService.service_type ?? "transfer"}</p>
              <p className="text-safe-wrap">
                {selectedService.time} - {selectedService.vessel}
              </p>
              <p className="text-safe-wrap">Hotel: {hotelsById.get(selectedService.hotel_id)?.name ?? "N/D"}</p>
              <p>Autista: {driverNamesById.get(assignmentsByServiceId.get(selectedService.id)?.driver_user_id ?? "") ?? "Non assegnato"}</p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button type="button" onClick={() => void quickAssign(selectedService.id)} className="btn-secondary px-2 py-1 text-xs">
                  Assegna rapido
                </button>
                <button type="button" onClick={() => void updateStatus(selectedService.id, "assigned")} className="btn-secondary px-2 py-1 text-xs">
                  Imposta assegnato
                </button>
                <button type="button" onClick={() => void updateStatus(selectedService.id, "partito")} className="btn-secondary px-2 py-1 text-xs">
                  Imposta partito
                </button>
                <button type="button" onClick={() => void updateStatus(selectedService.id, "arrivato")} className="btn-secondary px-2 py-1 text-xs">
                  Imposta arrivato
                </button>
                <button type="button" onClick={() => void updateStatus(selectedService.id, "completato")} className="btn-secondary px-2 py-1 text-xs">
                  Imposta completato
                </button>
              </div>
            </article>
          ) : null}
          {filteredServices.length === 0 ? (
            <EmptyState title="Nessun servizio." compact />
          ) : (
            filteredServices.map((service) => {
              const hotel = hotelsById.get(service.hotel_id);
              return (
                <article key={service.id} className={`cursor-pointer rounded-xl border p-2 text-sm ${selectedService?.id === service.id ? "border-blue-300 bg-blue-50/40" : "border-slate-200"}`} onClick={() => setSelectedServiceId(service.id)}>
                  <p className="line-clamp-2 text-safe-wrap font-medium" title={service.customer_name}>
                    {service.customer_name}
                  </p>
                  <p className="uppercase text-slate-600">{service.service_type ?? "transfer"}</p>
                  <p className="truncate" title={`${service.time} - ${service.vessel}`}>
                    {service.time} - {service.vessel}
                  </p>
                  <p className="truncate" title={`${hotel?.name ?? "N/D"} (${hotel?.zone ?? "N/D"})`}>
                    {hotel?.name ?? "N/D"} ({hotel?.zone ?? "N/D"})
                  </p>
                  <p className="uppercase text-slate-600">{service.status}</p>
                </article>
              );
            })
          )}
          {message ? <p className="rounded-lg bg-slate-100 px-2 py-1 text-xs text-slate-700">{message}</p> : null}
        </SectionCard>
      </div>
    </section>
  );
}
