"use client";

import { useMemo, useState } from "react";
import { useDemoStore } from "@/lib/use-demo-store";
import type { ServiceType } from "@/lib/types";

export default function AgencyBookingsPage() {
  const { state, loading } = useDemoStore();
  const [search, setSearch] = useState("");
  const [serviceTypeFilter, setServiceTypeFilter] = useState<ServiceType | "all">("all");

  const bookings = useMemo(() => {
    return state.services.filter((service) => {
      const bySearch = service.customer_name.toLowerCase().includes(search.toLowerCase());
      const byType = serviceTypeFilter === "all" || (service.service_type ?? "transfer") === serviceTypeFilter;
      return bySearch && byType;
    });
  }, [search, serviceTypeFilter, state.services]);

  if (loading) return <div className="card p-4 text-sm text-slate-500">Caricamento prenotazioni...</div>;

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Le mie prenotazioni</h1>
      <div className="card grid gap-3 p-3 md:grid-cols-2">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Cerca per cliente"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <select
          value={serviceTypeFilter}
          onChange={(event) => setServiceTypeFilter(event.target.value as ServiceType | "all")}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        >
          <option value="all">Tipo: tutti</option>
          <option value="transfer">transfer</option>
          <option value="bus_tour">bus_tour</option>
        </select>
      </div>
      {bookings.length === 0 ? (
        <div className="card p-4 text-sm text-slate-500">Nessuna prenotazione trovata.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left">
              <tr>
                <th className="px-4 py-3">Data</th>
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3">Tipo</th>
                <th className="px-4 py-3">Pax</th>
                <th className="px-4 py-3">Nave</th>
                <th className="px-4 py-3">Stato</th>
              </tr>
            </thead>
            <tbody>
              {bookings.map((service) => (
                <tr key={service.id} className="border-t border-slate-100">
                  <td className="px-4 py-3">
                    {service.date} {service.time}
                  </td>
                  <td className="px-4 py-3">{service.customer_name}</td>
                  <td className="px-4 py-3 uppercase">{service.service_type ?? "transfer"}</td>
                  <td className="px-4 py-3">{service.pax}</td>
                  <td className="px-4 py-3">{service.vessel}</td>
                  <td className="px-4 py-3 uppercase">{service.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
