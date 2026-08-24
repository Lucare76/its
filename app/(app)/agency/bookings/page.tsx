"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { DateInput, EmptyState, FilterBar, PageHeader, SectionCard } from "@/components/ui";
import { WhatsAppButton } from "@/components/whatsapp-button";
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
  customer_first_name: string | null;
  customer_last_name: string | null;
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
  approval_status: string | null;
  hotel_id: string | null;
  phone: string | null;
  hotel_name: string;
  hotel_zone: string | null;
  notes: string | null;
  created_at: string | null;
  agency_quoted_price_cents: number | null;
  agency_payment_status: string | null;
};

type HotelOption = { id: string; name: string; zone: string | null };

type ModificationRequest = {
  id: string;
  service_id: string;
  status: "pending" | "approved" | "rejected";
  changes: Record<string, unknown>;
  operator_notes: string | null;
  created_at: string;
};

type ModDraft = {
  arrival_date: string;
  arrival_time: string;
  departure_date: string;
  departure_time: string;
  pax: string;
  hotel_id: string;
  booking_service_kind: string;
  phone: string;
  notes: string;
};

const serviceKindLabels: Record<string, string> = {
  transfer_port_hotel: "Porto - Hotel",
  transfer_airport_hotel: "Aeroporto - Hotel",
  transfer_airport_hotel_exclusive: "Aeroporto - Hotel (esclusivo)",
  transfer_airport_hotel_aliscafo: "Aeroporto - Hotel (aliscafo)",
  transfer_train_hotel: "Stazione - Hotel",
  transfer_train_hotel_exclusive: "Stazione - Hotel (esclusivo)",
  transfer_train_hotel_aliscafo: "Stazione - Hotel (aliscafo)",
  bus_city_hotel: "Bus città - Hotel",
  excursion: "Escursione",
  formula_snav: "Formula SNAV",
  formula_medmar_napoli: "Formula MEDMAR Napoli",
  formula_medmar_pozzuoli: "Formula MEDMAR Pozzuoli"
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

function ApprovalBadge({ status }: { status: string | null }) {
  if (status === "confirmed") return <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-800">✅ Confermata</span>;
  if (status === "rejected") return <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2.5 py-0.5 text-[11px] font-semibold text-rose-800">❌ Rifiutata</span>;
  if (status === "pending_operator") return <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800">⏳ In attesa</span>;
  return null;
}

function ModBadge({ mr }: { mr: ModificationRequest | undefined }) {
  if (!mr) return null;
  if (mr.status === "pending") return <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-700">Modifica in attesa</span>;
  if (mr.status === "approved") return <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">Modifica approvata</span>;
  if (mr.status === "rejected") return <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-700">Modifica rifiutata</span>;
  return null;
}

function serviceOperationalDetail(row: BookingRow) {
  if (row.booking_service_kind === "bus_city_hotel") return row.bus_city_origin ? `Origine: ${row.bus_city_origin}` : row.vessel;
  if (row.booking_service_kind === "transfer_train_hotel") return row.transport_code ? `Codice treno: ${row.transport_code}` : row.vessel;
  if (row.booking_service_kind === "transfer_airport_hotel") return row.transport_code ? `Codice volo: ${row.transport_code}` : row.vessel;
  return row.vessel;
}

function bookingCustomerLabel(row: Pick<BookingRow, "customer_name" | "customer_first_name" | "customer_last_name">) {
  const joined = [row.customer_first_name, row.customer_last_name]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" ");
  return row.customer_name?.trim() || joined || "Cliente N/D";
}

function normalizeSearchText(value?: string | null) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function toModDraft(row: BookingRow): ModDraft {
  return {
    arrival_date:         row.arrival_date ?? row.date,
    arrival_time:         (row.arrival_time ?? row.time ?? "").slice(0, 5),
    departure_date:       row.departure_date ?? "",
    departure_time:       (row.departure_time ?? "").slice(0, 5),
    pax:                  String(row.pax),
    hotel_id:             row.hotel_id ?? "",
    booking_service_kind: row.booking_service_kind ?? "transfer_port_hotel",
    phone:                row.phone ?? "",
    notes:                row.notes ?? "",
  };
}

function AgencyBookingsPageInner() {
  const [loading, setLoading]           = useState(true);
  const [message, setMessage]           = useState("");
  const searchParams                    = useSearchParams();
  const [search, setSearch]             = useState(() => searchParams.get("q") ?? "");
  const [kindFilter, setKindFilter]     = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [confirmationFilter, setConfirmationFilter] = useState("all");
  const [windowFilter, setWindowFilter] = useState<"all" | "future" | "past">("all");
  const [bookings, setBookings]         = useState<BookingRow[]>([]);
  const [hotels, setHotels]             = useState<HotelOption[]>([]);
  const [modRequests, setModRequests]   = useState<ModificationRequest[]>([]);
  const [selectedBookingId, setSelectedBookingId] = useState<string | null>(null);
  const [accessToken, setAccessToken]   = useState<string | null>(null);

  // Modifica (richiesta)
  const [isModifying, setIsModifying]   = useState(false);
  const [modDraft, setModDraft]         = useState<ModDraft | null>(null);
  const [modSaving, setModSaving]       = useState(false);
  const [modMessage, setModMessage]     = useState("");

  // Cancellazione
  const [cancelling, setCancelling]     = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [cancelLeg, setCancelLeg]       = useState<"arrival" | "departure" | "both">("both");
  const [cancelNote, setCancelNote]     = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [tenantId, setTenantId] = useState<string | null>(null);

  // Contestazione prezzo su una riga già fatturata (estratto conto)
  const [disputeOpen, setDisputeOpen]       = useState(false);
  const [disputePrice, setDisputePrice]     = useState("");
  const [disputeNote, setDisputeNote]       = useState("");
  const [disputing, setDisputing]           = useState(false);
  const [disputeMessage, setDisputeMessage] = useState("");

  const currentMonthKey = new Date().toISOString().slice(0, 7);
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(() => new Set([currentMonthKey]));
  const toggleMonth = (key: string) =>
    setExpandedMonths((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  useEffect(() => {
    let active = true;

    const load = async () => {
      const session = await getClientSessionContext();
      if (!active) return;

      if (session.mode === "demo" || !hasSupabaseEnv || !supabase) {
        setMessage("Area prenotazioni agenzia disponibile solo con Supabase reale.");
        setLoading(false);
        return;
      }
      if (session.role !== "agency" && session.role !== "admin") {
        setMessage("Ruolo non autorizzato.");
        setLoading(false);
        return;
      }
      setTenantId(session.tenantId);

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        setMessage("Sessione non valida. Rifai login.");
        setLoading(false);
        return;
      }
      setAccessToken(token);

      const [bookingsRes, hotelsRes, modRes] = await Promise.all([
        fetch("/api/agency/bookings?limit=2000", { headers: { Authorization: `Bearer ${token}` } }),
        supabase.from("hotels").select("id, name, zone").order("name").limit(500),
        supabase.from("modification_requests")
          .select("id, service_id, status, changes, operator_notes, created_at")
          .order("created_at", { ascending: false }),
      ]);

      if (!active) return;

      const body = (await bookingsRes.json().catch(() => null)) as { rows?: BookingRow[]; error?: string } | null;
      if (!bookingsRes.ok) {
        setMessage(body?.error ?? "Errore caricamento prenotazioni.");
        setLoading(false);
        return;
      }

      setBookings(body?.rows ?? []);
      setHotels((hotelsRes.data ?? []) as HotelOption[]);
      setModRequests((modRes.data ?? []) as ModificationRequest[]);
      setLoading(false);
    };

    void load();
    return () => { active = false; };
  }, []);

  const filtered = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const query = normalizeSearchText(search);
    const queryDigits = query.replace(/\D/g, "");
    return bookings.filter((row) => {
      const haystack = [
        bookingCustomerLabel(row),
        row.customer_name,
        row.customer_first_name,
        row.customer_last_name,
        row.hotel_name,
        row.hotel_zone,
        row.vessel,
        row.phone,
        row.transport_code,
        row.bus_city_origin,
        row.notes,
        row.booking_service_kind,
        serviceKindLabels[row.booking_service_kind ?? ""],
        row.id,
      ].map((value) => normalizeSearchText(value)).join(" ");
      const bySearch = !query
        || haystack.includes(query)
        || (queryDigits.length > 0 && String(row.phone ?? "").replace(/\D/g, "").includes(queryDigits));
      const byKind        = kindFilter === "all" || row.booking_service_kind === kindFilter;
      const byStatus      = statusFilter === "all" || row.status === statusFilter;
      const byConfirmation = confirmationFilter === "all" || row.email_confirmation_status === confirmationFilter;
      const pivotDate     = row.arrival_date ?? row.departure_date ?? row.date;
      const byWindow      = windowFilter === "all" ? true : windowFilter === "future" ? pivotDate >= today : pivotDate < today;
      return bySearch && byKind && byStatus && byConfirmation && byWindow;
    });
  }, [bookings, confirmationFilter, kindFilter, search, statusFilter, windowFilter]);

  const summary = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return {
      total:     bookings.length,
      future:    bookings.filter((row) => (row.arrival_date ?? row.departure_date ?? row.date) >= today && row.status !== "cancelled").length,
      pending:   bookings.filter((row) => row.approval_status === "pending_operator" && row.status !== "cancelled").length,
      confirmed: bookings.filter((row) => row.approval_status === "confirmed" && row.status !== "cancelled").length,
    };
  }, [bookings]);

  const selectedBooking = filtered.find((row) => row.id === selectedBookingId) ?? filtered[0] ?? null;

  const groupedByMonth = useMemo(() => {
    const groups: { monthKey: string; label: string; rows: BookingRow[] }[] = [];
    const map = new Map<string, BookingRow[]>();
    for (const row of filtered) {
      const pivot = row.arrival_date ?? row.departure_date ?? row.date;
      const key = pivot ? pivot.slice(0, 7) : "senza-data";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(row);
    }
    const ascending = windowFilter === "future";
    const sorted = [...map.entries()].sort(([a], [b]) => ascending ? a.localeCompare(b) : b.localeCompare(a));
    for (const [key, rows] of sorted) {
      let label = "Senza data";
      if (key !== "senza-data") {
        const [y, m] = key.split("-");
        const monthName = new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("it-IT", { month: "long", year: "numeric" });
        label = monthName.charAt(0).toUpperCase() + monthName.slice(1);
      }
      groups.push({ monthKey: key, label, rows });
    }
    return groups;
  }, [filtered, windowFilter]);

  useEffect(() => {
    if (search.trim()) {
      setExpandedMonths(new Set(filtered.map((row) => {
        const pivot = row.arrival_date ?? row.departure_date ?? row.date;
        return pivot ? pivot.slice(0, 7) : "senza-data";
      })));
    } else {
      setExpandedMonths(new Set([currentMonthKey]));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // Ultima modifica per il servizio selezionato
  const latestMod = useMemo(() => {
    if (!selectedBooking) return undefined;
    return modRequests.find((mr) => mr.service_id === selectedBooking.id);
  }, [selectedBooking, modRequests]);

  const submitModificationRequest = async () => {
    if (!modDraft || !selectedBooking || !accessToken) return;
    setModSaving(true);
    setModMessage("");

    // Costruisci solo i campi che sono cambiati
    const changes: Record<string, unknown> = {};
    const orig = toModDraft(selectedBooking);
    if (modDraft.arrival_date !== orig.arrival_date)               changes.arrival_date         = modDraft.arrival_date;
    if (modDraft.arrival_time !== orig.arrival_time)               changes.arrival_time         = modDraft.arrival_time || null;
    if (modDraft.departure_date !== orig.departure_date)           changes.departure_date       = modDraft.departure_date || null;
    if (modDraft.departure_time !== orig.departure_time)           changes.departure_time       = modDraft.departure_time || null;
    if (modDraft.pax !== orig.pax)                                 changes.pax                  = Number(modDraft.pax);
    if (modDraft.hotel_id !== orig.hotel_id)                       changes.hotel_id             = modDraft.hotel_id || null;
    if (modDraft.booking_service_kind !== orig.booking_service_kind) changes.booking_service_kind = modDraft.booking_service_kind;
    if (modDraft.phone !== orig.phone)                             changes.phone                = modDraft.phone || null;
    if (modDraft.notes !== orig.notes)                             changes.notes                = modDraft.notes || null;

    if (Object.keys(changes).length === 0) {
      setModMessage("Nessuna modifica rilevata.");
      setModSaving(false);
      return;
    }

    const res  = await fetch("/api/agency/modification-request", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ service_id: selectedBooking.id, changes }),
    });
    const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; request_id?: string } | null;
    setModSaving(false);

    if (!res.ok) {
      setModMessage(data?.error ?? "Errore nell'invio della richiesta.");
      return;
    }

    // Aggiungi la nuova richiesta alla lista locale
    if (data?.request_id) {
      setModRequests((prev) => [
        { id: data.request_id!, service_id: selectedBooking.id, status: "pending", changes, operator_notes: null, created_at: new Date().toISOString() },
        ...prev.filter((mr) => mr.service_id !== selectedBooking.id),
      ]);
    }

    setIsModifying(false);
    setActionMessage("Richiesta di modifica inviata. L'operatore la esaminerà e riceverai una notifica.");
  };

  const cancelBooking = async () => {
    if (!selectedBooking || !accessToken) return;
    setCancelling(true);
    setCancelConfirm(false);
    const res  = await fetch("/api/ops/cancellation-requests", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ service_id: selectedBooking.id, cancel_legs: cancelLeg }),
    });
    const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    setCancelling(false);
    if (!res.ok) { setActionMessage(data?.error ?? "Richiesta fallita."); return; }
    setBookings((prev) => prev.map((row) => row.id === selectedBooking.id ? { ...row, status: "pending_cancellation" } : row));
    setActionMessage("Richiesta di annullamento inviata. L'operatore la gestirà e ti contatterà per eventuali penali.");
  };

  const submitPriceDispute = async () => {
    if (!selectedBooking || !accessToken) return;
    const eur = Number(disputePrice.trim().replace(",", "."));
    if (!Number.isFinite(eur) || eur < 0) { setDisputeMessage("Inserisci un importo valido."); return; }
    setDisputing(true);
    setDisputeMessage("");
    const res = await fetch("/api/agency/invoice-disputes", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id: selectedBooking.id,
        proposed_price_cents: Math.round(eur * 100),
        note: disputeNote.trim() || undefined,
      }),
    });
    const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    setDisputing(false);
    if (!res.ok) { setDisputeMessage(data?.error ?? "Segnalazione non riuscita."); return; }
    setDisputeOpen(false);
    setDisputePrice("");
    setDisputeNote("");
    setActionMessage("Segnalazione inviata. L'operatore la valuterà.");
  };

  if (loading) return <div className="card p-4 text-sm text-slate-500">Caricamento prenotazioni...</div>;

  return (
    <section className="page-section">
      <PageHeader
        title="Le mie prenotazioni"
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Agenzia", href: "/agency" }, { label: "Prenotazioni" }]}
        subtitle="Storico richieste agenzia con filtri, KPI e dettaglio operativo del singolo servizio."
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SectionCard title="Totale prenotazioni" subtitle="Storico disponibile" loading={loading}>
          <p className="text-3xl font-semibold text-text">{summary.total}</p>
        </SectionCard>
        <SectionCard title="Servizi futuri" subtitle="In programma" loading={loading}>
          <p className="text-3xl font-semibold text-text">{summary.future}</p>
        </SectionCard>
        <SectionCard title="In attesa" subtitle="Risposta operatore" loading={loading}>
          <p className="text-3xl font-semibold text-text">{summary.pending}</p>
        </SectionCard>
        <SectionCard title="Confermate" subtitle="Approvate dall'operatore" loading={loading}>
          <p className="text-3xl font-semibold text-text">{summary.confirmed}</p>
        </SectionCard>
      </div>

      <div className="flex items-center gap-2 rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-3">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 shrink-0 text-indigo-500">
          <circle cx="6.5" cy="6.5" r="4" /><path d="M10.5 10.5 14 14" />
        </svg>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Cerca cliente, telefono, hotel, codice..."
          className="flex-1 bg-transparent text-sm text-slate-700 placeholder:text-slate-400 outline-none"
        />
        {search && <button onClick={() => setSearch("")} className="text-slate-400 hover:text-slate-600 text-lg leading-none">×</button>}
      </div>

      <FilterBar colsClassName="md:grid-cols-2 xl:grid-cols-4">
        <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} className="input-saas">
          <option value="all">Tipo: tutti</option>
          {Object.entries(serviceKindLabels).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="input-saas">
          <option value="all">Stato: tutti</option>
          <option value="new">Operativi</option>
          <option value="assigned">Presi in carico</option>
          <option value="completato">Chiusi</option>
          <option value="cancelled">Annullati</option>
          <option value="pending_cancellation">Cancellazione in attesa</option>
        </select>
        <select value={windowFilter} onChange={(e) => setWindowFilter(e.target.value as "all" | "future" | "past")} className="input-saas">
          <option value="all">Tutti i periodi</option>
          <option value="future">Solo prossimi</option>
          <option value="past">Solo passati</option>
        </select>
        <select value={confirmationFilter} onChange={(e) => setConfirmationFilter(e.target.value)} className="input-saas">
          <option value="all">Email: tutte</option>
          <option value="sent">Conferma inviata</option>
          <option value="pending">In attesa</option>
          <option value="failed">Fallita</option>
        </select>
      </FilterBar>

      {filtered.length === 0 ? (
        <EmptyState title={message || "Nessuna prenotazione trovata."} compact />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
          <SectionCard title="Lista prenotazioni" subtitle={`${filtered.length} prenotazion${filtered.length === 1 ? "e" : "i"} trovate`}>
            <div className="space-y-5">
              {groupedByMonth.map(({ monthKey, label, rows: monthRows }) => {
                const isOpen = expandedMonths.has(monthKey);
                return (
                  <div key={monthKey}>
                    <button
                      type="button"
                      onClick={() => toggleMonth(monthKey)}
                      className="flex w-full items-center gap-3 mb-2 group"
                    >
                      <span className="text-xs font-bold uppercase tracking-widest text-slate-500 group-hover:text-slate-700 transition-colors">{label}</span>
                      <span className="text-[10px] rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">{monthRows.length}</span>
                      <div className="flex-1 h-px bg-slate-100" />
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"
                        className={`h-3.5 w-3.5 text-slate-400 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}>
                        <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>

                    {isOpen && (
                      <div className="space-y-2">
                        {monthRows.map((row) => {
                          const mr = modRequests.find((m) => m.service_id === row.id);
                          return (
                            <button
                              key={row.id}
                              type="button"
                              onClick={() => { setSelectedBookingId(row.id); setIsModifying(false); setModMessage(""); setCancelConfirm(false); setActionMessage(""); }}
                              className={`w-full rounded-2xl border p-3.5 text-left transition-colors ${selectedBooking?.id === row.id ? "border-indigo-300 bg-indigo-50/60" : "border-border bg-surface/80 hover:bg-slate-50"}`}
                            >
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div>
                                  <p className="text-sm font-semibold text-text">{bookingCustomerLabel(row)}</p>
                                  <p className="text-xs text-muted">{serviceKindLabels[row.booking_service_kind ?? ""] ?? "Transfer"} · {row.hotel_name}</p>
                                </div>
                                <div className="flex flex-col items-end gap-1">
                                  <ApprovalBadge status={row.approval_status} />
                                  <ModBadge mr={mr} />
                                  {row.status === "cancelled" && (
                                    <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] text-slate-500">Annullata</span>
                                  )}
                                  {row.status === "pending_cancellation" && (
                                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">Cancellazione in attesa</span>
                                  )}
                                </div>
                              </div>
                              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
                                <span>Arrivo: {formatDateTime(row.arrival_date ?? row.date, row.arrival_time ?? row.time)}</span>
                                {row.departure_date && <span>Rientro: {formatDateTime(row.departure_date, row.departure_time)}</span>}
                                {row.agency_quoted_price_cents != null && (
                                  <span className={`ml-auto font-semibold ${row.agency_payment_status === "paid" ? "text-emerald-600" : "text-slate-600"}`}>
                                    €{(row.agency_quoted_price_cents / 100).toFixed(2).replace(".", ",")}
                                    {row.agency_payment_status === "paid" ? " ✓" : ""}
                                  </span>
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </SectionCard>

          <SectionCard title="Dettaglio prenotazione" subtitle="Vista completa lato agenzia del servizio selezionato.">
            {!selectedBooking ? (
              <EmptyState title="Nessuna prenotazione selezionata" description="Scegli una prenotazione dalla lista per vederne il dettaglio." compact />
            ) : isModifying && modDraft ? (
              /* ── Form richiesta modifica ── */
              <div className="space-y-4 overflow-y-auto max-h-[80vh] pr-1">
                <article className="rounded-2xl border border-blue-200 bg-blue-50/40 p-4">
                  <p className="text-sm font-semibold text-slate-800 mb-1">Richiedi modifica prenotazione</p>
                  <p className="text-xs text-slate-500 mb-4">
                    L&apos;operatore riceverà una notifica e potrà approvare o rifiutare le modifiche.
                    Modifica solo i campi che vuoi cambiare.
                  </p>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div>
                      <label className="text-xs text-muted">Data andata</label>
                      <DateInput className="input-saas mt-1" value={modDraft.arrival_date}
                        onChange={(iso) => setModDraft((d) => d && ({ ...d, arrival_date: iso }))} />
                    </div>
                    <div>
                      <label className="text-xs text-muted">Ora andata</label>
                      <input className="input-saas mt-1" type="time" value={modDraft.arrival_time}
                        onChange={(e) => setModDraft((d) => d && ({ ...d, arrival_time: e.target.value }))} />
                    </div>
                    <div>
                      <label className="text-xs text-muted">Data ritorno</label>
                      <DateInput className="input-saas mt-1" value={modDraft.departure_date}
                        onChange={(iso) => setModDraft((d) => d && ({ ...d, departure_date: iso }))} />
                    </div>
                    <div>
                      <label className="text-xs text-muted">Ora ritorno</label>
                      <input className="input-saas mt-1" type="time" value={modDraft.departure_time}
                        onChange={(e) => setModDraft((d) => d && ({ ...d, departure_time: e.target.value }))} />
                    </div>
                    <div>
                      <label className="text-xs text-muted">Passeggeri</label>
                      <input className="input-saas mt-1" type="number" min="1" max="100" value={modDraft.pax}
                        onChange={(e) => setModDraft((d) => d && ({ ...d, pax: e.target.value }))} />
                    </div>
                    <div>
                      <label className="text-xs text-muted">Telefono cliente</label>
                      <input className="input-saas mt-1" type="tel" value={modDraft.phone}
                        onChange={(e) => setModDraft((d) => d && ({ ...d, phone: e.target.value }))} />
                    </div>
                    <div>
                      <label className="text-xs text-muted">Tipologia servizio</label>
                      <select className="input-saas mt-1" value={modDraft.booking_service_kind}
                        onChange={(e) => setModDraft((d) => d && ({ ...d, booking_service_kind: e.target.value }))}>
                        {Object.entries(serviceKindLabels).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </div>
                    <div className="md:col-span-2">
                      <label className="text-xs text-muted">Hotel</label>
                      <select className="input-saas mt-1" value={modDraft.hotel_id}
                        onChange={(e) => setModDraft((d) => d && ({ ...d, hotel_id: e.target.value }))}>
                        <option value="">— Invariato —</option>
                        {hotels.map((h) => (
                          <option key={h.id} value={h.id}>{h.name}{h.zone ? ` (${h.zone})` : ""}</option>
                        ))}
                      </select>
                    </div>
                    <div className="md:col-span-2">
                      <label className="text-xs text-muted">Note</label>
                      <textarea className="input-saas mt-1 min-h-[70px]" value={modDraft.notes}
                        onChange={(e) => setModDraft((d) => d && ({ ...d, notes: e.target.value }))} />
                    </div>
                  </div>
                  {modMessage && <p className="mt-2 text-xs text-rose-600">{modMessage}</p>}
                </article>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => void submitModificationRequest()} disabled={modSaving} className="btn-primary">
                    {modSaving ? "Invio..." : "Invia richiesta modifica"}
                  </button>
                  <button type="button" onClick={() => { setIsModifying(false); setModMessage(""); }} className="btn-secondary">
                    Annulla
                  </button>
                </div>
              </div>
            ) : (
              /* ── Vista dettaglio ── */
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-100">
                  <div className="min-w-0">
                    <p className="text-xl font-bold text-slate-900 leading-tight truncate">{bookingCustomerLabel(selectedBooking)}</p>
                    <p className="mt-0.5 text-xs text-slate-500 font-medium uppercase tracking-wide">
                      {serviceKindLabels[selectedBooking.booking_service_kind ?? ""] ?? "Transfer"}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <ApprovalBadge status={selectedBooking.approval_status} />
                    <ModBadge mr={latestMod} />
                    {selectedBooking.status === "cancelled" && (
                      <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Annullata</span>
                    )}
                    {selectedBooking.status === "pending_cancellation" && (
                      <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[10px] font-semibold text-amber-700 uppercase tracking-wide">Canc. in attesa</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                  <span>Telefono: {selectedBooking.phone || "N/D"}</span>
                  <WhatsAppButton phone={selectedBooking.phone} name={bookingCustomerLabel(selectedBooking)} tenantId={tenantId} />
                </div>

                {/* Esito ultima modifica */}
                {latestMod && latestMod.status !== "pending" && (
                  <div className={`rounded-xl border px-3 py-2.5 text-sm ${latestMod.status === "approved" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800"}`}>
                    <p className="font-semibold">{latestMod.status === "approved" ? "Modifica approvata" : "Modifica rifiutata"}</p>
                    {latestMod.operator_notes && <p className="text-xs mt-0.5 opacity-80">{latestMod.operator_notes}</p>}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Arrivo</p>
                    <p className="mt-1 text-sm font-semibold text-slate-800">
                      {formatDateTime(selectedBooking.arrival_date ?? selectedBooking.date, selectedBooking.arrival_time ?? selectedBooking.time)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Rientro</p>
                    <p className="mt-1 text-sm font-semibold text-slate-800">
                      {selectedBooking.departure_date ? formatDateTime(selectedBooking.departure_date, selectedBooking.departure_time) : "—"}
                    </p>
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100">
                  {[
                    { label: "Hotel",     value: selectedBooking.hotel_name },
                    { label: "Zona",      value: selectedBooking.hotel_zone ?? "—" },
                    { label: "Pax",       value: String(selectedBooking.pax) },
                    { label: "Operativo", value: serviceOperationalDetail(selectedBooking) || "—" },
                    { label: "Creata il", value: selectedBooking.created_at ? formatIsoDateTimeShort(selectedBooking.created_at) : "—" },
                  ].map(({ label, value }) => (
                    <div key={label} className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm">
                      <span className="text-slate-400 font-medium shrink-0">{label}</span>
                      <span className="text-slate-800 text-right truncate">{value}</span>
                    </div>
                  ))}
                  {selectedBooking.agency_quoted_price_cents != null && (
                    <div className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm">
                      <span className="text-slate-400 font-medium shrink-0">Importo</span>
                      <span className={`font-semibold ${selectedBooking.agency_payment_status === "paid" ? "text-emerald-600" : "text-slate-700"}`}>
                        €{(selectedBooking.agency_quoted_price_cents / 100).toFixed(2).replace(".", ",")}
                        {selectedBooking.agency_payment_status === "paid" ? " ✓ Saldato" : ""}
                      </span>
                    </div>
                  )}
                </div>

                {/* Contestazione prezzo — solo se c'è un prezzo concordato da mettere in discussione */}
                {selectedBooking.agency_quoted_price_cents != null && (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    {!disputeOpen ? (
                      <button
                        type="button"
                        onClick={() => { setDisputeOpen(true); setDisputePrice(""); setDisputeNote(""); setDisputeMessage(""); }}
                        className="text-sm font-semibold text-slate-600 hover:text-slate-900"
                      >
                        Segnala prezzo errato →
                      </button>
                    ) : (
                      <div className="space-y-2.5">
                        <p className="text-sm font-semibold text-slate-800">Segnala prezzo errato</p>
                        <label className="block text-xs font-medium text-slate-600">
                          Prezzo corretto secondo te (€)
                          <input
                            type="text"
                            inputMode="decimal"
                            placeholder="0.00"
                            value={disputePrice}
                            onChange={(e) => setDisputePrice(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))}
                            className="mt-1 input-saas w-full"
                          />
                        </label>
                        <label className="block text-xs font-medium text-slate-600">
                          Nota (facoltativa)
                          <textarea
                            rows={2}
                            value={disputeNote}
                            onChange={(e) => setDisputeNote(e.target.value)}
                            className="mt-1 input-saas w-full"
                            placeholder="Spiega perché ritieni sbagliato l'importo..."
                          />
                        </label>
                        {disputeMessage && <p className="text-xs font-semibold text-rose-600">{disputeMessage}</p>}
                        <div className="flex gap-2">
                          <button type="button" onClick={() => void submitPriceDispute()} disabled={disputing}
                            className="rounded-lg bg-slate-700 px-4 py-2 text-xs font-bold text-white hover:bg-slate-800 disabled:opacity-60">
                            {disputing ? "Invio..." : "Invia segnalazione"}
                          </button>
                          <button type="button" onClick={() => setDisputeOpen(false)}
                            className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100">
                            Annulla
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {selectedBooking.email_confirmation_status && selectedBooking.email_confirmation_status !== "skipped" && (
                  <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100">
                    <div className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm">
                      <span className="text-slate-400 font-medium">Email conferma</span>
                      <span className={`font-semibold ${selectedBooking.email_confirmation_status === "sent" ? "text-emerald-600" : selectedBooking.email_confirmation_status === "failed" ? "text-rose-600" : "text-slate-600"}`}>
                        {formatEmailConfirmationStatus(selectedBooking.email_confirmation_status)}
                      </span>
                    </div>
                    {selectedBooking.email_confirmation_to && (
                      <div className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm">
                        <span className="text-slate-400 font-medium">Inviata a</span>
                        <span className="text-slate-700 truncate">{selectedBooking.email_confirmation_to}</span>
                      </div>
                    )}
                  </div>
                )}

                {selectedBooking.notes?.trim() && (
                  <div className="rounded-xl border border-slate-200 bg-amber-50/40 px-3 py-2.5">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Note operative</p>
                    <p className="text-sm text-slate-700 whitespace-pre-wrap">{selectedBooking.notes.trim()}</p>
                  </div>
                )}

                {actionMessage && (
                  <p className="text-xs font-semibold px-1 text-blue-700">{actionMessage}</p>
                )}

                {/* Azioni principali */}
                <div className="flex flex-wrap gap-2 pt-1">
                  {selectedBooking.status !== "cancelled" && !latestMod?.status.startsWith("pending" as never) && (
                    <button
                      type="button"
                      onClick={() => {
                        setModDraft(toModDraft(selectedBooking));
                        setIsModifying(true);
                        setModMessage("");
                        setCancelConfirm(false);
                        setActionMessage("");
                      }}
                      className="btn-primary text-sm"
                      disabled={latestMod?.status === "pending"}
                    >
                      Richiedi modifica
                    </button>
                  )}
                  {latestMod?.status === "pending" && (
                    <span className="inline-flex items-center gap-1.5 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2 text-xs font-semibold text-blue-700">
                      Modifica in attesa di risposta
                    </span>
                  )}
                  <Link href="/agency/new-booking" className="btn-secondary text-sm">
                    + Nuova prenotazione
                  </Link>
                </div>

                {/* Pannello cancellazione */}
                {selectedBooking.status !== "cancelled" && selectedBooking.status !== "pending_cancellation" && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                    {!cancelConfirm ? (
                      <button
                        type="button"
                        onClick={() => { setCancelConfirm(true); setCancelLeg("both"); setCancelNote(""); }}
                        className="text-sm font-semibold text-amber-700 hover:text-amber-900"
                      >
                        Richiedi annullamento →
                      </button>
                    ) : (
                      <div className="space-y-3">
                        <p className="text-sm font-semibold text-amber-900">Annullamento — {bookingCustomerLabel(selectedBooking)}</p>
                        <div>
                          <p className="text-xs font-semibold text-amber-700 mb-1.5">Quale tratta vuoi annullare?</p>
                          <div className="flex flex-wrap gap-1.5">
                            {(["arrival", "departure", "both"] as const).map((leg) => {
                              const label = leg === "arrival" ? "Solo andata" : leg === "departure" ? "Solo ritorno" : "Andata + Ritorno";
                              return (
                                <button key={leg} type="button" onClick={() => setCancelLeg(leg)}
                                  className={`rounded-lg border px-3 py-1 text-xs font-semibold transition ${cancelLeg === leg ? "border-amber-700 bg-amber-700 text-white" : "border-amber-300 bg-white text-amber-700 hover:bg-amber-100"}`}>
                                  {label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        <div>
                          <p className="text-xs text-amber-600 mb-1">Motivo (facoltativo)</p>
                          <input
                            className="input-saas w-full text-xs"
                            placeholder="es. cambio programma, maltempo..."
                            value={cancelNote}
                            onChange={(e) => setCancelNote(e.target.value)}
                          />
                        </div>
                        <p className="text-xs text-amber-700">La prenotazione rimarrà in archivio. L&apos;operatore valuterà eventuali penali.</p>
                        <div className="flex gap-2">
                          <button type="button" onClick={() => void cancelBooking()} disabled={cancelling}
                            className="rounded-lg bg-amber-700 px-4 py-2 text-xs font-bold text-white hover:bg-amber-800 disabled:opacity-60">
                            {cancelling ? "Invio..." : "Conferma annullamento"}
                          </button>
                          <button type="button" onClick={() => { setCancelConfirm(false); setCancelNote(""); }}
                            className="rounded-lg border border-amber-300 px-4 py-2 text-xs font-medium text-amber-700 hover:bg-amber-100">
                            Indietro
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {selectedBooking.status === "cancelled" && (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
                    Tratta annullata.
                  </div>
                )}
                {selectedBooking.status === "pending_cancellation" && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                    Richiesta di cancellazione in attesa — l&apos;operatore la gestirà a breve.
                  </div>
                )}
              </div>
            )}
          </SectionCard>
        </div>
      )}
    </section>
  );
}

export default function AgencyBookingsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-slate-500">Caricamento...</div>}>
      <AgencyBookingsPageInner />
    </Suspense>
  );
}
