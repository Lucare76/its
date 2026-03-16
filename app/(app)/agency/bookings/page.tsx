"use client";

import { useEffect, useMemo, useState } from "react";
import { DataTable, EmptyState, FilterBar, PageHeader } from "@/components/ui";
import { formatIsoDateShort } from "@/lib/service-display";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type BookingRow = {
  id: string;
  date: string;
  time: string;
  status: string;
  pax: number;
  customer_name: string;
  service_type: "transfer" | "bus_tour";
  vessel: string;
  booking_service_kind: string | null;
  arrival_date: string | null;
  arrival_time: string | null;
  departure_date: string | null;
  departure_time: string | null;
  transport_code: string | null;
  bus_city_origin: string | null;
  include_ferry_tickets: boolean | null;
  email_confirmation_status: string | null;
  email_confirmation_sent_at: string | null;
  hotel_name: string;
  hotel_zone: string | null;
};

const serviceKindLabels: Record<string, string> = {
  transfer_port_hotel: "Porto - Hotel",
  transfer_airport_hotel: "Aeroporto - Hotel",
  transfer_train_hotel: "Stazione - Hotel",
  bus_city_hotel: "Bus citta - Hotel",
  excursion: "Escursione"
};

function formatDateTime(date: string | null, time: string | null) {
  if (!date) return "-";
  return `${formatIsoDateShort(date)}${time ? ` ${time.slice(0, 5)}` : ""}`;
}

function formatEmailConfirmationStatus(value: string | null) {
  if (value === "sent") return "Conferma inviata";
  if (value === "failed") return "Invio fallito";
  if (value === "pending") return "Invio in attesa";
  if (value === "skipped") return "Invio saltato";
  return "-";
}

export default function AgencyBookingsPage() {
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const [bookings, setBookings] = useState<BookingRow[]>([]);

  useEffect(() => {
    let active = true;

    const load = async () => {
      const session = await getClientSessionContext();
      if (!active) return;

      if (session.mode === "demo" || !hasSupabaseEnv || !supabase) {
        setMessage("Area prenotazioni agenzia disponibile solo con Supabase reale.");
        setBookings([]);
        setLoading(false);
        return;
      }
      if (session.role !== "agency" && session.role !== "admin") {
        setMessage("Ruolo non autorizzato.");
        setBookings([]);
        setLoading(false);
        return;
      }

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        setMessage("Sessione non valida. Rifai login.");
        setBookings([]);
        setLoading(false);
        return;
      }

      const response = await fetch("/api/agency/bookings?limit=1000", {
        headers: { Authorization: `Bearer ${token}` }
      });
      const body = (await response.json().catch(() => null)) as { rows?: BookingRow[]; error?: string } | null;
      if (!active) return;

      if (!response.ok) {
        setMessage(body?.error ?? "Errore caricamento prenotazioni.");
        setBookings([]);
        setLoading(false);
        return;
      }

      setBookings(body?.rows ?? []);
      setLoading(false);
    };

    void load();
    return () => {
      active = false;
    };
  }, []);

  const filtered = useMemo(() => {
    return bookings.filter((row) => {
      const bySearch =
        row.customer_name.toLowerCase().includes(search.toLowerCase()) ||
        row.hotel_name.toLowerCase().includes(search.toLowerCase()) ||
        row.vessel.toLowerCase().includes(search.toLowerCase());
      const byKind = kindFilter === "all" || row.booking_service_kind === kindFilter;
      return bySearch && byKind;
    });
  }, [bookings, search, kindFilter]);

  if (loading) {
    return <div className="card p-4 text-sm text-slate-500">Caricamento prenotazioni...</div>;
  }

  return (
    <section className="page-section">
      <PageHeader
        title="Le mie prenotazioni"
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Agenzia", href: "/agency" }, { label: "Prenotazioni" }]}
        subtitle="Elenco prenotazioni agenzia su Supabase reale."
      />
      <FilterBar colsClassName="md:grid-cols-2">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Cerca cliente, hotel o riferimento"
          className="input-saas"
        />
        <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value)} className="input-saas">
          <option value="all">Tipo: tutti</option>
          <option value="transfer_port_hotel">Porto - Hotel</option>
          <option value="transfer_airport_hotel">Aeroporto - Hotel</option>
          <option value="transfer_train_hotel">Stazione - Hotel</option>
          <option value="bus_city_hotel">Bus citta - Hotel</option>
          <option value="excursion">Escursione</option>
        </select>
      </FilterBar>

      {filtered.length === 0 ? (
        <EmptyState title={message || "Nessuna prenotazione trovata."} compact />
      ) : (
        <DataTable toolbar={<p className="text-xs text-muted">Prenotazioni trovate: {filtered.length}</p>}>
          <thead>
            <tr>
              <th className="px-4 py-3">Cliente</th>
              <th className="px-4 py-3">Servizio</th>
              <th className="px-4 py-3">Arrivo</th>
              <th className="px-4 py-3">Partenza</th>
              <th className="px-4 py-3">Hotel</th>
              <th className="px-4 py-3">Pax</th>
              <th className="px-4 py-3">Stato</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr key={row.id}>
                <td className="px-4 py-3">
                  <p className="line-clamp-2 text-safe-wrap">{row.customer_name}</p>
                  <p className="text-xs text-slate-500">{row.transport_code || row.bus_city_origin || row.vessel}</p>
                </td>
                <td className="px-4 py-3">
                  <p>{serviceKindLabels[row.booking_service_kind ?? ""] ?? "Transfer"}</p>
                  <p className="text-xs text-slate-500">
                    {row.include_ferry_tickets ? "Con biglietti nave" : "Senza biglietti nave"}
                  </p>
                </td>
                <td className="px-4 py-3">{formatDateTime(row.arrival_date ?? row.date, row.arrival_time ?? row.time)}</td>
                <td className="px-4 py-3">{formatDateTime(row.departure_date, row.departure_time)}</td>
                <td className="px-4 py-3">
                  <p>{row.hotel_name}</p>
                  <p className="text-xs text-slate-500">{row.hotel_zone ?? "-"}</p>
                </td>
                <td className="px-4 py-3">{row.pax}</td>
                <td className="px-4 py-3">
                  <p className="uppercase">{row.status}</p>
                  <p className="text-xs text-slate-500">{formatEmailConfirmationStatus(row.email_confirmation_status)}</p>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </section>
  );
}
