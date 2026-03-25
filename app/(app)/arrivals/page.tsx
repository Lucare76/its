"use client";

import { useMemo, useState } from "react";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { buildOperationalInstances } from "@/lib/operational-service-instances";
import { formatIsoDateShort, getCustomerFullName, getTransportReferenceOutward } from "@/lib/service-display";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";

export default function ArrivalsPage() {
  const { loading, errorMessage, data } = useTenantOperationalData();
  const todayIso = new Date().toISOString().slice(0, 10);
  const [selectedDate, setSelectedDate] = useState(todayIso);

  const hotelsById = useMemo(() => new Map(data.hotels.map((hotel) => [hotel.id, hotel])), [data.hotels]);
  const arrivals = useMemo(
    () =>
      buildOperationalInstances(data.services)
        .filter((instance) => instance.direction === "arrival" && instance.date === selectedDate)
        .sort((left, right) => left.time.localeCompare(right.time)),
    [data.services, selectedDate]
  );

  const totalPax = arrivals.reduce((sum, item) => sum + item.service.pax, 0);
  const busCount = arrivals.filter(
    (item) => item.service.service_type_code === "bus_line" || item.service.booking_service_kind === "bus_city_hotel"
  ).length;

  return (
    <section className="page-section">
      <PageHeader
        title="Arrivi"
        subtitle="Vista dedicata agli arrivi operativi della giornata selezionata."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Arrivi" }]}
        actions={
          <label className="text-sm">
            Data
            <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} className="input-saas mt-1 min-w-40" />
          </label>
        }
      />

      {errorMessage ? <EmptyState title="Arrivi non disponibili" description={errorMessage} compact /> : null}

      <div className="grid gap-3 md:grid-cols-3">
        <SectionCard title="Servizi arrivo">
          <p className="text-3xl font-semibold text-text">{arrivals.length}</p>
        </SectionCard>
        <SectionCard title="Pax totali">
          <p className="text-3xl font-semibold text-text">{totalPax}</p>
        </SectionCard>
        <SectionCard title="Linea bus">
          <p className="text-3xl font-semibold text-text">{busCount}</p>
        </SectionCard>
      </div>

      <SectionCard title="Lista arrivi" subtitle={`Giornata ${formatIsoDateShort(selectedDate)}`} loading={loading} loadingLines={6}>
        {arrivals.length === 0 ? (
          <p className="text-sm text-muted">Nessun arrivo operativo per la data selezionata.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Ora</th>
                  <th className="px-3 py-2">Cliente</th>
                  <th className="px-3 py-2">Pax</th>
                  <th className="px-3 py-2">Hotel</th>
                  <th className="px-3 py-2">Meeting point</th>
                  <th className="px-3 py-2">Riferimento</th>
                  <th className="px-3 py-2">Tipo</th>
                </tr>
              </thead>
              <tbody>
                {arrivals.map((item) => (
                  <tr key={item.instanceId} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-medium">{item.time}</td>
                    <td className="px-3 py-2 uppercase">{getCustomerFullName(item.service)}</td>
                    <td className="px-3 py-2">{item.service.pax}</td>
                    <td className="px-3 py-2 uppercase">{hotelsById.get(item.service.hotel_id)?.name ?? "N/D"}</td>
                    <td className="px-3 py-2 uppercase">{item.service.meeting_point ?? item.service.vessel ?? "N/D"}</td>
                    <td className="px-3 py-2">{getTransportReferenceOutward(item.service) ?? item.service.transport_code ?? item.service.vessel}</td>
                    <td className="px-3 py-2">{item.service.service_type_code ?? item.service.booking_service_kind ?? item.service.service_type ?? "N/D"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </section>
  );
}
