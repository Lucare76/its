"use client";

import { useMemo, useState } from "react";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { buildOperationalInstances } from "@/lib/operational-service-instances";
import { formatIsoDateShort, getCustomerFullName, getTransportReferenceReturn } from "@/lib/service-display";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";
import { supabase } from "@/lib/supabase/client";
import type { Service } from "@/lib/types";

export default function DeparturesPage() {
  const { loading, errorMessage, data, refresh } = useTenantOperationalData();
  const todayIso = new Date().toISOString().slice(0, 10);
  const [selectedDate, setSelectedDate] = useState(todayIso);
  const [agencyFilter, setAgencyFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const hotelsById = useMemo(() => new Map(data.hotels.map((hotel) => [hotel.id, hotel])), [data.hotels]);
  const tenantId = data.services[0]?.tenant_id ?? "";

  const agencyNames = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of data.services) {
      const name = s.billing_party_name?.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const existing = seen.get(key);
      if (!existing || (existing === existing.toUpperCase() && name !== name.toUpperCase())) {
        seen.set(key, name);
      }
    }
    return ["all", ...Array.from(seen.values()).sort((a, b) => a.localeCompare(b, "it"))];
  }, [data.services]);

  const departures = useMemo(() => {
    const q = search.trim().toLowerCase();
    return buildOperationalInstances(data.services)
      .filter((instance) =>
        instance.direction === "departure" &&
        instance.date === selectedDate &&
        (agencyFilter === "all" || instance.service.billing_party_name?.trim().toLowerCase() === agencyFilter.toLowerCase()) &&
        (!q || (instance.service.customer_name ?? "").toLowerCase().includes(q) || (instance.service.phone ?? "").toLowerCase().includes(q))
      )
      .sort((left, right) => left.time.localeCompare(right.time));
  }, [data.services, selectedDate, agencyFilter, search]);

  const totalPax = departures.reduce((sum, item) => sum + item.service.pax, 0);
  const busCount = departures.filter(
    (item) => item.service.service_type_code === "bus_line" || item.service.booking_service_kind === "bus_city_hotel"
  ).length;

  const deleteService = async (service: Service) => {
    if (!supabase || !tenantId) return;
    if (!confirm(`Eliminare il servizio di ${service.customer_name}? L'operazione non è reversibile.`)) return;
    await supabase.from("services").delete().eq("id", service.id).eq("tenant_id", tenantId);
    void refresh?.();
  };

  return (
    <section className="page-section">
      <PageHeader
        title="Partenze"
        subtitle="Vista dedicata alle partenze operative della giornata selezionata."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Partenze" }]}
        actions={
          <div className="flex flex-wrap gap-3">
            <label className="text-sm">
              Data
              <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} className="input-saas mt-1 min-w-40" />
            </label>
            <label className="text-sm">
              Agenzia
              <select value={agencyFilter} onChange={(e) => setAgencyFilter(e.target.value)} className="input-saas mt-1 min-w-44">
                {agencyNames.map((name) => (
                  <option key={name} value={name}>{name === "all" ? "Tutte le agenzie" : name}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Cerca
              <input
                type="search"
                placeholder="Nome, cognome o telefono..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="input-saas mt-1 min-w-52"
              />
            </label>
          </div>
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
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {departures.map((item) => (
                  <tr key={item.instanceId} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-3 py-2 font-medium">{item.time}</td>
                    <td className="px-3 py-2 uppercase">{getCustomerFullName(item.service)}</td>
                    <td className="px-3 py-2">{item.service.pax}</td>
                    <td className="px-3 py-2 uppercase">{hotelsById.get(item.service.hotel_id)?.name ?? item.service.meeting_point ?? "N/D"}</td>
                    <td className="px-3 py-2 uppercase">{item.service.meeting_point ?? "N/D"}</td>
                    <td className="px-3 py-2">{getTransportReferenceReturn(item.service) ?? item.service.transport_code ?? item.service.vessel}</td>
                    <td className="px-3 py-2">{item.service.service_type_code ?? item.service.booking_service_kind ?? item.service.service_type ?? "N/D"}</td>
                    <td className="px-3 py-2">
                      <button type="button" onClick={() => void deleteService(item.service)}
                        className="rounded-lg border border-rose-200 px-2 py-1 text-xs text-rose-500 hover:bg-rose-50">
                        Elimina
                      </button>
                    </td>
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
