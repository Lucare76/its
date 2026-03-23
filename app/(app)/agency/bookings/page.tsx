"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { EmptyState, FilterBar, PageHeader, SectionCard } from "@/components/ui";
import { formatIsoDateShort, formatIsoDateTimeShort } from "@/lib/service-display";
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
  email_confirmation_to: string | null;
  hotel_name: string;
  hotel_zone: string | null;
  notes: string | null;
  created_at: string | null;
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

function serviceOperationalDetail(row: BookingRow) {
  if (row.booking_service_kind === "bus_city_hotel") {
    return row.bus_city_origin ? `Origine: ${row.bus_city_origin}` : row.vessel;
  }
  if (row.booking_service_kind === "transfer_train_hotel") {
    return row.transport_code ? `Codice treno: ${row.transport_code}` : row.vessel;
  }
  if (row.booking_service_kind === "transfer_airport_hotel") {
    return row.transport_code ? `Codice volo: ${row.transport_code}` : row.vessel;
  }
  return row.vessel;
}

export default function AgencyBookingsPage() {
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [confirmationFilter, setConfirmationFilter] = useState("all");
  const [windowFilter, setWindowFilter] = useState<"all" | "future" | "past">("future");
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [selectedBookingId, setSelectedBookingId] = useState<string | null>(null);

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
    const today = new Date().toISOString().slice(0, 10);
    return bookings.filter((row) => {
      const bySearch =
        row.customer_name.toLowerCase().includes(search.toLowerCase()) ||
        row.hotel_name.toLowerCase().includes(search.toLowerCase()) ||
        row.vessel.toLowerCase().includes(search.toLowerCase());
      const byKind = kindFilter === "all" || row.booking_service_kind === kindFilter;
      const byStatus = statusFilter === "all" || row.status === statusFilter;
      const byConfirmation = confirmationFilter === "all" || row.email_confirmation_status === confirmationFilter;
      const pivotDate = row.arrival_date ?? row.departure_date ?? row.date;
      const byWindow = windowFilter === "all" ? true : windowFilter === "future" ? pivotDate >= today : pivotDate < today;
      return bySearch && byKind && byStatus && byConfirmation && byWindow;
    });
  }, [bookings, confirmationFilter, kindFilter, search, statusFilter, windowFilter]);

  const summary = useMemo(
    () => ({
      total: bookings.length,
      future: bookings.filter((row) => (row.arrival_date ?? row.departure_date ?? row.date) >= new Date().toISOString().slice(0, 10)).length,
      needsReview: bookings.filter((row) => row.status === "needs_review").length,
      sentConfirmations: bookings.filter((row) => row.email_confirmation_status === "sent").length
    }),
    [bookings]
  );

  const selectedBooking = filtered.find((row) => row.id === selectedBookingId) ?? filtered[0] ?? null;

  if (loading) {
    return <div className="card p-4 text-sm text-slate-500">Caricamento prenotazioni...</div>;
  }

  return (
    <section className="page-section">
      <PageHeader
        title="Le mie prenotazioni"
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Agenzia", href: "/agency" }, { label: "Prenotazioni" }]}
        subtitle="Storico richieste agenzia con filtri, KPI e dettaglio operativo del singolo servizio."
      />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SectionCard title="Prenotazioni totali" subtitle="Storico disponibile" loading={loading}>
          <p className="text-3xl font-semibold text-text">{summary.total}</p>
        </SectionCard>
        <SectionCard title="Servizi futuri" subtitle="Arrivi o partenze in programma" loading={loading}>
          <p className="text-3xl font-semibold text-text">{summary.future}</p>
        </SectionCard>
        <SectionCard title="Da verificare" subtitle="Servizi in review" loading={loading}>
          <p className="text-3xl font-semibold text-text">{summary.needsReview}</p>
        </SectionCard>
        <SectionCard title="Conferme inviate" subtitle="Email conferma spedite" loading={loading}>
          <p className="text-3xl font-semibold text-text">{summary.sentConfirmations}</p>
        </SectionCard>
      </div>

      <FilterBar colsClassName="md:grid-cols-2 xl:grid-cols-5">
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
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="input-saas">
          <option value="all">Stato: tutti</option>
          <option value="needs_review">Da verificare</option>
          <option value="new">Pronti operativi</option>
          <option value="assigned">Presi in carico</option>
          <option value="partito">Partiti</option>
          <option value="arrivato">Arrivati</option>
          <option value="completato">Chiusi</option>
          <option value="problema">Problema</option>
          <option value="cancelled">Annullati</option>
        </select>
        <select value={confirmationFilter} onChange={(event) => setConfirmationFilter(event.target.value)} className="input-saas">
          <option value="all">Conferma email: tutte</option>
          <option value="sent">Inviata</option>
          <option value="pending">In attesa</option>
          <option value="failed">Fallita</option>
          <option value="skipped">Saltata</option>
        </select>
        <select value={windowFilter} onChange={(event) => setWindowFilter(event.target.value as "all" | "future" | "past")} className="input-saas">
          <option value="future">Finestra: future</option>
          <option value="past">Storico passato</option>
          <option value="all">Tutte</option>
        </select>
      </FilterBar>

      {filtered.length === 0 ? (
        <EmptyState title={message || "Nessuna prenotazione trovata."} compact />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
          <SectionCard title="Lista prenotazioni" subtitle={`Prenotazioni trovate: ${filtered.length}`}>
            <div className="space-y-3">
              {filtered.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => setSelectedBookingId(row.id)}
                  className={`w-full rounded-2xl border p-4 text-left ${selectedBooking?.id === row.id ? "border-primary bg-blue-50/40" : "border-border bg-surface/80"}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-text">{row.customer_name}</p>
                      <p className="text-xs text-muted">{serviceKindLabels[row.booking_service_kind ?? ""] ?? "Transfer"}</p>
                    </div>
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] text-slate-700">
                      {row.status}
                    </span>
                  </div>
                  <div className="mt-3 grid gap-1 text-xs text-muted md:grid-cols-2">
                    <p>Arrivo: {formatDateTime(row.arrival_date ?? row.date, row.arrival_time ?? row.time)}</p>
                    <p>Partenza: {formatDateTime(row.departure_date, row.departure_time)}</p>
                    <p>Hotel: {row.hotel_name}</p>
                    <p>Conferma: {formatEmailConfirmationStatus(row.email_confirmation_status)}</p>
                  </div>
                </button>
              ))}
            </div>
          </SectionCard>

          <SectionCard title="Dettaglio prenotazione" subtitle="Vista completa lato agenzia del servizio selezionato.">
            {!selectedBooking ? (
              <EmptyState title="Nessuna prenotazione selezionata" description="Scegli una prenotazione dalla lista per vederne il dettaglio." compact />
            ) : (
              <div className="space-y-4">
                <article className="rounded-2xl border border-border bg-surface/80 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-lg font-semibold text-text">{selectedBooking.customer_name}</p>
                      <p className="text-sm text-muted">{serviceKindLabels[selectedBooking.booking_service_kind ?? ""] ?? "Transfer"}</p>
                    </div>
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] text-slate-700">
                      {selectedBooking.status}
                    </span>
                  </div>
                  <div className="mt-4 grid gap-2 text-sm text-text md:grid-cols-2">
                    <p><span className="text-muted">Arrivo:</span> {formatDateTime(selectedBooking.arrival_date ?? selectedBooking.date, selectedBooking.arrival_time ?? selectedBooking.time)}</p>
                    <p><span className="text-muted">Partenza:</span> {formatDateTime(selectedBooking.departure_date, selectedBooking.departure_time)}</p>
                    <p><span className="text-muted">Hotel:</span> {selectedBooking.hotel_name}</p>
                    <p><span className="text-muted">Zona:</span> {selectedBooking.hotel_zone ?? "-"}</p>
                    <p><span className="text-muted">Pax:</span> {selectedBooking.pax}</p>
                    <p><span className="text-muted">Operativo:</span> {serviceOperationalDetail(selectedBooking)}</p>
                    <p><span className="text-muted">Biglietti nave:</span> {selectedBooking.include_ferry_tickets ? "Si" : "No"}</p>
                    <p><span className="text-muted">Creata il:</span> {selectedBooking.created_at ? formatIsoDateTimeShort(selectedBooking.created_at) : "-"}</p>
                  </div>
                </article>

                <article className="rounded-2xl border border-border bg-surface/80 p-4">
                  <p className="text-sm font-semibold text-text">Conferma email</p>
                  <div className="mt-3 grid gap-2 text-sm text-text">
                    <p><span className="text-muted">Stato:</span> {formatEmailConfirmationStatus(selectedBooking.email_confirmation_status)}</p>
                    <p><span className="text-muted">Destinatario:</span> {selectedBooking.email_confirmation_to ?? "-"}</p>
                    <p><span className="text-muted">Ultimo invio:</span> {selectedBooking.email_confirmation_sent_at ? formatIsoDateTimeShort(selectedBooking.email_confirmation_sent_at) : "-"}</p>
                  </div>
                </article>

                <article className="rounded-2xl border border-border bg-surface/80 p-4">
                  <p className="text-sm font-semibold text-text">Note prenotazione</p>
                  <p className="mt-2 text-sm text-muted whitespace-pre-wrap">{selectedBooking.notes?.trim() || "Nessuna nota disponibile."}</p>
                </article>

                <div className="flex flex-wrap gap-2">
                  <Link href="/agency/new-booking" className="btn-primary">
                    Nuova prenotazione
                  </Link>
                  <Link href={`/dispatch?serviceId=${selectedBooking.id}`} className="btn-secondary">
                    Apri in dispatch
                  </Link>
                </div>
              </div>
            )}
          </SectionCard>
        </div>
      )}
    </section>
  );
}
