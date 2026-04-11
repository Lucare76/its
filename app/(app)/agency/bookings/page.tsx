"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
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
  approval_status: string | null;
  hotel_name: string;
  hotel_zone: string | null;
  notes: string | null;
  created_at: string | null;
  agency_quoted_price_cents: number | null;
  agency_payment_status: string | null;
};

const serviceKindLabels: Record<string, string> = {
  transfer_port_hotel: "Porto - Hotel",
  transfer_airport_hotel: "Aeroporto - Hotel",
  transfer_airport_hotel_exclusive: "Aeroporto - Hotel 🔒",
  transfer_train_hotel: "Stazione - Hotel",
  transfer_train_hotel_exclusive: "Stazione - Hotel 🔒",
  bus_city_hotel: "Bus città - Hotel",
  excursion: "Escursione",
  formula_snav: "Formula SNAV",
  formula_medmar: "Formula MEDMAR"
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
  if (status === "confirmed") return <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-800">✅ Confermato</span>;
  if (status === "rejected") return <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2.5 py-0.5 text-[11px] font-semibold text-rose-800">❌ Rifiutato</span>;
  if (status === "pending_operator") return <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800">⏳ In attesa operatore</span>;
  return null;
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

type EditDraft = {
  customer_first_name: string;
  customer_last_name: string;
  customer_phone: string;
  pax: string;
  arrival_date: string;
  arrival_time: string;
  departure_date: string;
  departure_time: string;
  transport_code: string;
  bus_city_origin: string;
  notes: string;
};

function toEditDraft(row: BookingRow): EditDraft {
  const nameParts = row.customer_name.split(" ");
  return {
    customer_first_name: nameParts[0] ?? "",
    customer_last_name: nameParts.slice(1).join(" "),
    customer_phone: "",
    pax: String(row.pax),
    arrival_date: row.arrival_date ?? row.date,
    arrival_time: (row.arrival_time ?? row.time ?? "").slice(0, 5),
    departure_date: row.departure_date ?? row.date,
    departure_time: (row.departure_time ?? "").slice(0, 5),
    transport_code: row.transport_code ?? "",
    bus_city_origin: row.bus_city_origin ?? "",
    notes: row.notes ?? ""
  };
}

function AgencyBookingsPageInner() {
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [kindFilter, setKindFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [confirmationFilter, setConfirmationFilter] = useState("all");
  const [windowFilter, setWindowFilter] = useState<"all" | "future" | "past">("all");
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [selectedBookingId, setSelectedBookingId] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [editMessage, setEditMessage] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [cancelLeg, setCancelLeg] = useState<"arrival" | "departure" | "both">("both");
  const [cancelNote, setCancelNote] = useState("");

  // Mesi collassabili: aperto di default solo il mese corrente e quelli futuri (max 2)
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
      setAccessToken(token);

      const response = await fetch("/api/agency/bookings?limit=2000", {
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

  const summary = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return {
      total: bookings.length,
      future: bookings.filter((row) => (row.arrival_date ?? row.departure_date ?? row.date) >= today && row.status !== "cancelled").length,
      pending: bookings.filter((row) => row.approval_status === "pending_operator" && row.status !== "cancelled").length,
      confirmed: bookings.filter((row) => row.approval_status === "confirmed" && row.status !== "cancelled").length,
    };
  }, [bookings]);

  const selectedBooking = filtered.find((row) => row.id === selectedBookingId) ?? filtered[0] ?? null;

  // Raggruppa per mese (YYYY-MM) basato su arrival_date
  // Futuro → mese più vicino prima (ascendente); passato/tutto → più recente prima (discendente)
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
    const sorted = [...map.entries()].sort(([a], [b]) =>
      ascending ? a.localeCompare(b) : b.localeCompare(a)
    );
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

  // Espande tutti i mesi durante la ricerca; ripristina il mese corrente quando si cancella
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

  const saveEdit = async () => {
    if (!editDraft || !selectedBooking || !accessToken) return;
    setSaving(true);
    setEditMessage("");
    const body: Record<string, unknown> = {
      customer_first_name: editDraft.customer_first_name.trim(),
      customer_last_name: editDraft.customer_last_name.trim(),
      pax: Number(editDraft.pax),
      arrival_date: editDraft.arrival_date,
      arrival_time: editDraft.arrival_time,
      departure_date: editDraft.departure_date,
      departure_time: editDraft.departure_time,
      notes: editDraft.notes,
      transport_code: editDraft.transport_code.trim() || null,
      bus_city_origin: editDraft.bus_city_origin.trim() || null
    };
    if (editDraft.customer_phone.trim()) body.customer_phone = editDraft.customer_phone.trim();
    const res = await fetch(`/api/agency/bookings/${selectedBooking.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body)
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    setSaving(false);
    if (!res.ok) {
      setEditMessage(data?.error ?? "Salvataggio fallito.");
      return;
    }
    setBookings((prev) =>
      prev.map((row) =>
        row.id === selectedBooking.id
          ? {
              ...row,
              customer_name: `${editDraft.customer_first_name.trim()} ${editDraft.customer_last_name.trim()}`.trim(),
              pax: Number(editDraft.pax),
              arrival_date: editDraft.arrival_date,
              arrival_time: editDraft.arrival_time,
              departure_date: editDraft.departure_date,
              departure_time: editDraft.departure_time,
              transport_code: editDraft.transport_code.trim() || null,
              bus_city_origin: editDraft.bus_city_origin.trim() || null,
              notes: editDraft.notes
            }
          : row
      )
    );
    setIsEditing(false);
    setEditMessage("Salvato.");
  };

  const cancelBooking = async () => {
    if (!selectedBooking || !accessToken) return;
    setCancelling(true);
    setCancelConfirm(false);
    const res = await fetch(`/api/agency/bookings/${selectedBooking.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ cancel_legs: cancelLeg, cancel_note: cancelNote || undefined })
    });
    const data = await res.json().catch(() => null) as { ok?: boolean; already_cancelled?: boolean; error?: string } | null;
    setCancelling(false);
    if (data?.already_cancelled) {
      setBookings((prev) => prev.map((row) => row.id === selectedBooking.id ? { ...row, status: "cancelled" } : row));
      setEditMessage("Tratta già annullata.");
      return;
    }
    if (!res.ok) { setEditMessage(data?.error ?? "Annullamento fallito."); return; }
    setBookings((prev) => prev.map((row) => row.id === selectedBooking.id ? { ...row, status: "cancelled" } : row));
    setEditMessage("Tratta annullata. L'operatore è stato notificato.");
  };

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

      {/* Barra di ricerca rapida per nome cliente */}
      <div className="flex items-center gap-2 rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-3">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 shrink-0 text-indigo-500">
          <circle cx="6.5" cy="6.5" r="4" /><path d="M10.5 10.5 14 14" />
        </svg>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Cerca per nome o cognome del cliente..."
          className="flex-1 bg-transparent text-sm text-slate-700 placeholder:text-slate-400 outline-none"
        />
        {search && (
          <button onClick={() => setSearch("")} className="text-slate-400 hover:text-slate-600 text-lg leading-none">×</button>
        )}
      </div>

      <FilterBar colsClassName="md:grid-cols-2 xl:grid-cols-4">
        <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value)} className="input-saas">
          <option value="all">Tipo: tutti</option>
          <option value="transfer_port_hotel">Porto - Hotel</option>
          <option value="transfer_airport_hotel">Aeroporto - Hotel</option>
          <option value="transfer_train_hotel">Stazione - Hotel</option>
          <option value="bus_city_hotel">Bus città - Hotel</option>
          <option value="excursion">Escursione</option>
          <option value="formula_snav">Formula SNAV</option>
          <option value="formula_medmar">Formula MEDMAR</option>
        </select>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="input-saas">
          <option value="all">Stato: tutti</option>
          <option value="new">Operativi</option>
          <option value="assigned">Presi in carico</option>
          <option value="completato">Chiusi</option>
          <option value="cancelled">Annullati</option>
        </select>
        <select value={windowFilter} onChange={(event) => setWindowFilter(event.target.value as "all" | "future" | "past")} className="input-saas">
          <option value="all">Tutti i periodi</option>
          <option value="future">Solo prossimi</option>
          <option value="past">Solo passati</option>
        </select>
        <select value={confirmationFilter} onChange={(event) => setConfirmationFilter(event.target.value)} className="input-saas">
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
                  {/* Intestazione mese — cliccabile */}
                  <button
                    type="button"
                    onClick={() => toggleMonth(monthKey)}
                    className="flex w-full items-center gap-3 mb-2 group"
                  >
                    <span className="text-xs font-bold uppercase tracking-widest text-slate-500 group-hover:text-slate-700 transition-colors">{label}</span>
                    <span className="text-[10px] rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">{monthRows.length}</span>
                    <div className="flex-1 h-px bg-slate-100" />
                    <svg
                      viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"
                      className={`h-3.5 w-3.5 text-slate-400 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                    >
                      <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>

                  {isOpen && <div className="space-y-2">
                    {monthRows.map((row) => (
                      <button
                        key={row.id}
                        type="button"
                        onClick={() => { setSelectedBookingId(row.id); setIsEditing(false); setEditMessage(""); setCancelConfirm(false); }}
                        className={`w-full rounded-2xl border p-3.5 text-left transition-colors ${selectedBooking?.id === row.id ? "border-indigo-300 bg-indigo-50/60" : "border-border bg-surface/80 hover:bg-slate-50"}`}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <p className="text-sm font-semibold text-text">{row.customer_name}</p>
                            <p className="text-xs text-muted">{serviceKindLabels[row.booking_service_kind ?? ""] ?? "Transfer"} · {row.hotel_name}</p>
                          </div>
                          <div className="flex flex-col items-end gap-1">
                            <ApprovalBadge status={row.approval_status} />
                            {row.status === "cancelled" && (
                              <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] text-slate-500">Annullata</span>
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
                    ))}
                  </div>}
                </div>
                );
              })}
            </div>
          </SectionCard>

          <SectionCard title="Dettaglio prenotazione" subtitle="Vista completa lato agenzia del servizio selezionato.">
            {!selectedBooking ? (
              <EmptyState title="Nessuna prenotazione selezionata" description="Scegli una prenotazione dalla lista per vederne il dettaglio." compact />
            ) : isEditing && editDraft ? (
              <div className="space-y-4">
                <article className="rounded-2xl border border-primary/30 bg-blue-50/30 p-4">
                  <p className="text-sm font-semibold text-text mb-3">Modifica prenotazione</p>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div>
                      <label className="text-xs text-muted">Nome</label>
                      <input className="input-saas mt-1" value={editDraft.customer_first_name} onChange={(e) => setEditDraft((d) => d && ({ ...d, customer_first_name: e.target.value }))} />
                    </div>
                    <div>
                      <label className="text-xs text-muted">Cognome</label>
                      <input className="input-saas mt-1" value={editDraft.customer_last_name} onChange={(e) => setEditDraft((d) => d && ({ ...d, customer_last_name: e.target.value }))} />
                    </div>
                    <div>
                      <label className="text-xs text-muted">Telefono (lascia vuoto per non modificare)</label>
                      <input className="input-saas mt-1" value={editDraft.customer_phone} onChange={(e) => setEditDraft((d) => d && ({ ...d, customer_phone: e.target.value }))} />
                    </div>
                    <div>
                      <label className="text-xs text-muted">Passeggeri</label>
                      <input className="input-saas mt-1" type="number" min="1" max="16" value={editDraft.pax} onChange={(e) => setEditDraft((d) => d && ({ ...d, pax: e.target.value }))} />
                    </div>
                    <div>
                      <label className="text-xs text-muted">Data andata</label>
                      <input className="input-saas mt-1" type="date" value={editDraft.arrival_date} onChange={(e) => setEditDraft((d) => d && ({ ...d, arrival_date: e.target.value }))} />
                    </div>
                    <div>
                      <label className="text-xs text-muted">Ora andata</label>
                      <input className="input-saas mt-1" type="time" value={editDraft.arrival_time} onChange={(e) => setEditDraft((d) => d && ({ ...d, arrival_time: e.target.value }))} />
                    </div>
                    <div>
                      <label className="text-xs text-muted">Data ritorno</label>
                      <input className="input-saas mt-1" type="date" value={editDraft.departure_date} onChange={(e) => setEditDraft((d) => d && ({ ...d, departure_date: e.target.value }))} />
                    </div>
                    <div>
                      <label className="text-xs text-muted">Ora ritorno</label>
                      <input className="input-saas mt-1" type="time" value={editDraft.departure_time} onChange={(e) => setEditDraft((d) => d && ({ ...d, departure_time: e.target.value }))} />
                    </div>
                    {(selectedBooking.booking_service_kind === "transfer_airport_hotel" || selectedBooking.booking_service_kind === "transfer_train_hotel") && (
                      <div className="md:col-span-2">
                        <label className="text-xs text-muted">Codice volo / treno</label>
                        <input className="input-saas mt-1" value={editDraft.transport_code} onChange={(e) => setEditDraft((d) => d && ({ ...d, transport_code: e.target.value }))} />
                      </div>
                    )}
                    {selectedBooking.booking_service_kind === "bus_city_hotel" && (
                      <div className="md:col-span-2">
                        <label className="text-xs text-muted">Citta origine bus</label>
                        <input className="input-saas mt-1" value={editDraft.bus_city_origin} onChange={(e) => setEditDraft((d) => d && ({ ...d, bus_city_origin: e.target.value }))} />
                      </div>
                    )}
                    <div className="md:col-span-2">
                      <label className="text-xs text-muted">Note</label>
                      <textarea className="input-saas mt-1 min-h-[80px]" value={editDraft.notes} onChange={(e) => setEditDraft((d) => d && ({ ...d, notes: e.target.value }))} />
                    </div>
                  </div>
                  {editMessage && <p className="mt-2 text-xs text-red-600">{editMessage}</p>}
                </article>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => void saveEdit()} disabled={saving} className="btn-primary">
                    {saving ? "Salvataggio..." : "Salva modifiche"}
                  </button>
                  <button type="button" onClick={() => { setIsEditing(false); setEditMessage(""); }} className="btn-secondary">
                    Annulla
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">

                {/* ── Header cliente ── */}
                <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-100">
                  <div className="min-w-0">
                    <p className="text-xl font-bold text-slate-900 leading-tight truncate">{selectedBooking.customer_name}</p>
                    <p className="mt-0.5 text-xs text-slate-500 font-medium uppercase tracking-wide">
                      {serviceKindLabels[selectedBooking.booking_service_kind ?? ""] ?? "Transfer"}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <ApprovalBadge status={selectedBooking.approval_status} />
                    {selectedBooking.status === "cancelled" && (
                      <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Annullata</span>
                    )}
                  </div>
                </div>

                {/* ── Date in evidenza ── */}
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

                {/* ── Info principali ── */}
                <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100">
                  {[
                    { label: "Hotel", value: selectedBooking.hotel_name },
                    { label: "Zona", value: selectedBooking.hotel_zone ?? "—" },
                    { label: "Pax", value: String(selectedBooking.pax) },
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

                {/* ── Conferma email ── */}
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

                {/* ── Note ── */}
                {selectedBooking.notes?.trim() ? (
                  <div className="rounded-xl border border-slate-200 bg-amber-50/40 px-3 py-2.5">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Note operative</p>
                    <p className="text-sm text-slate-700 whitespace-pre-wrap">{selectedBooking.notes.trim()}</p>
                  </div>
                ) : null}

                {/* ── Feedback azione ── */}
                {editMessage && (
                  <p className={`text-xs font-semibold px-1 ${editMessage.includes("annullat") ? "text-amber-700" : editMessage === "Salvato." ? "text-emerald-600" : "text-rose-600"}`}>
                    {editMessage}
                  </p>
                )}

                {/* ── Azioni principali ── */}
                <div className="flex flex-wrap gap-2 pt-1">
                  {selectedBooking.status !== "cancelled" && (
                    <button
                      type="button"
                      onClick={() => { setEditDraft(toEditDraft(selectedBooking)); setIsEditing(true); setEditMessage(""); setCancelConfirm(false); setCancelLeg("both"); setCancelNote(""); }}
                      className="btn-primary text-sm"
                    >
                      Modifica
                    </button>
                  )}
                  <Link href="/agency/new-booking" className="btn-secondary text-sm">
                    + Nuova prenotazione
                  </Link>
                </div>

                {selectedBooking.status !== "cancelled" && (
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
                        <p className="text-sm font-semibold text-amber-900">
                          Annullamento — {selectedBooking.customer_name}
                        </p>

                        {/* Selezione tratta */}
                        <div>
                          <p className="text-xs font-semibold text-amber-700 mb-1.5">Quale tratta vuoi annullare?</p>
                          <div className="flex flex-wrap gap-1.5">
                            {(["arrival", "departure", "both"] as const).map((leg) => {
                              const label = leg === "arrival" ? "Solo andata" : leg === "departure" ? "Solo ritorno" : "Andata + Ritorno";
                              return (
                                <button
                                  key={leg}
                                  type="button"
                                  onClick={() => setCancelLeg(leg)}
                                  className={`rounded-lg border px-3 py-1 text-xs font-semibold transition ${
                                    cancelLeg === leg
                                      ? "border-amber-700 bg-amber-700 text-white"
                                      : "border-amber-300 bg-white text-amber-700 hover:bg-amber-100"
                                  }`}
                                >
                                  {label}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {/* Motivo (opzionale) */}
                        <div>
                          <p className="text-xs text-amber-600 mb-1">Motivo (facoltativo)</p>
                          <input
                            className="input-saas w-full text-xs"
                            placeholder="es. cambio programma, maltempo..."
                            value={cancelNote}
                            onChange={(e) => setCancelNote(e.target.value)}
                          />
                        </div>

                        <p className="text-xs text-amber-700">
                          La prenotazione rimarrà in archivio. L'operatore valuterà eventuali penali.
                        </p>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => void cancelBooking()}
                            disabled={cancelling}
                            className="rounded-lg bg-amber-700 px-4 py-2 text-xs font-bold text-white hover:bg-amber-800 disabled:opacity-60"
                          >
                            {cancelling ? "Invio richiesta..." : "Conferma annullamento"}
                          </button>
                          <button
                            type="button"
                            onClick={() => { setCancelConfirm(false); setCancelNote(""); }}
                            className="rounded-lg border border-amber-300 px-4 py-2 text-xs font-medium text-amber-700 hover:bg-amber-100"
                          >
                            Indietro
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {selectedBooking.status === "cancelled" && (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
                    Tratta annullata — in attesa di verifica operatore per penali/sconti.
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
