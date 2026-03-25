"use client";

import { useMemo, useState } from "react";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { buildOperationalInstances } from "@/lib/operational-service-instances";
import { formatIsoDateShort, getCustomerFullName, getTransportReferenceReturn } from "@/lib/service-display";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";

export default function DeparturesPage() {
  const { loading, errorMessage, data } = useTenantOperationalData();
  const todayIso = new Date().toISOString().slice(0, 10);
  const [selectedDate, setSelectedDate] = useState(todayIso);

  const hotelsById = useMemo(() => new Map(data.hotels.map((hotel) => [hotel.id, hotel])), [data.hotels]);
  const departures = useMemo(
    () =>
      buildOperationalInstances(data.services)
        .filter((instance) => instance.direction === "departure" && instance.date === selectedDate)
        .sort((left, right) => left.time.localeCompare(right.time)),
    [data.services, selectedDate]
  );

  const totalPax = departures.reduce((sum, item) => sum + item.service.pax, 0);
  const busCount = departures.filter(
    (item) => item.service.service_type_code === "bus_line" || item.service.booking_service_kind === "bus_city_hotel"
  ).length;

  return (
    <section className="page-section">
      <PageHeader
        title="Partenze"
        subtitle="Vista dedicata alle partenze operative della giornata selezionata."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Partenze" }]}
        actions={
          <label className="text-sm">
            Data
            <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} className="input-saas mt-1 min-w-40" />
          </label>
        }
      />

      {errorMessage ? <EmptyState title="Partenze non disponibili" description={errorMessage} compact /> : null}

      <div className="grid gap-3 md:grid-cols-3">
        <SectionCard title="Servizi partenza">
          <p className="text-3xl font-semibold text-text">{departures.length}</p>
        </SectionCard>
        <SectionCard title="Pax totali">
          <p className="text-3xl font-semibold text-text">{totalPax}</p>
        </SectionCard>
        <SectionCard title="Linea bus">
          <p className="text-3xl font-semibold text-text">{busCount}</p>
        </SectionCard>
      </div>

      <SectionCard title="Lista partenze" subtitle={`Giornata ${formatIsoDateShort(selectedDate)}`} loading={loading} loadingLines={6}>
        {departures.length === 0 ? (
          <p className="text-sm text-muted">Nessuna partenza operativa per la data selezionata.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Ora</th>
                  <th className="px-3 py-2">Cliente</th>
                  <th className="px-3 py-2">Pax</th>
                  <th className="px-3 py-2">Origine / hotel</th>
                  <th className="px-3 py-2">Meeting point</th>
                  <th className="px-3 py-2">Riferimento</th>
                  <th className="px-3 py-2">Tipo</th>
                </tr>
              </thead>
              <tbody>
                {departures.map((item) => (
                  <tr key={item.instanceId} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-medium">{item.time}</td>
                    <td className="px-3 py-2 uppercase">{getCustomerFullName(item.service)}</td>
                    <td className="px-3 py-2">{item.service.pax}</td>
                    <td className="px-3 py-2 uppercase">{hotelsById.get(item.service.hotel_id)?.name ?? "N/D"}</td>
                    <td className="px-3 py-2 uppercase">{item.service.meeting_point ?? "N/D"}</td>
                    <td className="px-3 py-2">{getTransportReferenceReturn(item.service) ?? item.service.transport_code ?? item.service.vessel}</td>
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
