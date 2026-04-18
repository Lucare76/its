"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type BookingRow = {
  id: string;
  status: string;
  approval_status: string | null;
  customer_name: string;
  customer_first_name: string | null;
  customer_last_name: string | null;
  pax: number;
  arrival_date: string | null;
  arrival_time: string | null;
  departure_date: string | null;
  booking_service_kind: string | null;
  hotel_name: string;
  agency_quoted_price_cents: number | null;
  agency_payment_status: string | null;
  created_at: string | null;
};

const KIND_LABELS: Record<string, string> = {
  transfer_port_hotel: "Transfer Porto",
  transfer_airport_hotel: "Transfer Aeroporto",
  transfer_airport_hotel_exclusive: "Transfer Aeroporto 🔒",
  transfer_train_hotel: "Transfer Stazione",
  transfer_train_hotel_exclusive: "Transfer Stazione 🔒",
  bus_city_hotel: "Bus da città",
  excursion: "Escursione",
  formula_snav: "Formula SNAV",
  formula_medmar_napoli: "Formula MEDMAR Napoli",
  formula_medmar_pozzuoli: "Formula MEDMAR Pozzuoli",
};

function fmtDate(iso?: string | null) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function fmtEur(cents: number | null | undefined) {
  if (cents == null) return "—";
  return `€${(cents / 100).toFixed(2).replace(".", ",")}`;
}

function ApprovalChip({ status }: { status: string | null }) {
  if (status === "confirmed")
    return <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">✅ Confermata</span>;
  if (status === "rejected")
    return <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-800">❌ Rifiutata</span>;
  if (status === "pending_operator")
    return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">⏳ In attesa</span>;
  return null;
}

export default function AgencyPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [agencyName, setAgencyName] = useState<string | null>(null);
  const [rows, setRows] = useState<BookingRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let active = true;
    const load = async () => {
      const session = await getClientSessionContext();
      if (!active) return;

      if (!hasSupabaseEnv || !supabase || !session.tenantId) {
        setError("Area agenzia disponibile solo con Supabase reale.");
        setLoading(false);
        return;
      }
      if (session.role !== "agency" && session.role !== "admin") {
        setError("Ruolo non autorizzato.");
        setLoading(false);
        return;
      }

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) { setError("Sessione non valida."); setLoading(false); return; }

      const res = await fetch("/api/agency/bookings?limit=500", {
        headers: { Authorization: `Bearer ${token}` }
      });
      const body = await res.json().catch(() => null) as { rows?: BookingRow[]; error?: string } | null;
      if (!active) return;
      if (!res.ok) { setError(body?.error ?? "Errore caricamento."); setLoading(false); return; }

      if (session.tenantId) {
        const { data: mem } = await supabase
          .from("memberships")
          .select("agency_id")
          .eq("user_id", session.userId ?? "")
          .eq("tenant_id", session.tenantId)
          .maybeSingle();
        if (mem?.agency_id) {
          const { data: ag } = await supabase.from("agencies").select("name").eq("id", mem.agency_id).maybeSingle();
          if (ag?.name && active) setAgencyName(ag.name);
        }
      }

      setRows(body?.rows ?? []);
      setLoading(false);
    };
    void load();
    return () => { active = false; };
  }, []);

  const today = new Date().toISOString().slice(0, 10);

  const kpi = useMemo(() => {
    const active = rows.filter((r) => r.status !== "cancelled");
    const pending = active.filter((r) => r.approval_status === "pending_operator");
    const confirmed = active.filter((r) => r.approval_status === "confirmed");
    const upcoming = active.filter((r) => {
      const d = r.arrival_date ?? r.departure_date;
      return d && d >= today;
    });
    return {
      pending: pending.length,
      confirmed: confirmed.length,
      upcoming: upcoming.length,
      total: rows.length
    };
  }, [rows, today]);

  // Contabilità
  const accounting = useMemo(() => {
    const billable = rows.filter((r) => r.status !== "cancelled" && r.agency_quoted_price_cents != null);
    const toPay = billable
      .filter((r) => r.agency_payment_status !== "paid" && r.agency_payment_status !== "waived")
      .reduce((sum, r) => sum + (r.agency_quoted_price_cents ?? 0), 0);
    const paid = rows
      .filter((r) => r.agency_payment_status === "paid" && r.agency_quoted_price_cents != null)
      .reduce((sum, r) => sum + (r.agency_quoted_price_cents ?? 0), 0);
    const total = billable.reduce((sum, r) => sum + (r.agency_quoted_price_cents ?? 0), 0);
    return { toPay, paid, total };
  }, [rows]);

  // Ultime 5 prenotazioni (ordine cronologico inverso di created_at)
  const lastFive = useMemo(
    () =>
      [...rows]
        .sort((a, b) => (b.created_at ?? "") > (a.created_at ?? "") ? 1 : -1)
        .slice(0, 5),
    [rows]
  );

  const doSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (search.trim()) {
      router.push(`/agency/bookings?q=${encodeURIComponent(search.trim())}`);
    }
  };

  return (
    <section className="mx-auto max-w-5xl page-section">
      {/* Header */}
      <div className="section-head">
        <div>
          <h1 className="section-title">
            {agencyName ? `Benvenuto, ${agencyName}` : "Area Agenzia"}
          </h1>
          <p className="section-subtitle">Gestisci le tue prenotazioni e monitora lo stato delle richieste.</p>
        </div>
        <Link href="/agency/new-booking" className="btn-primary px-5 py-2.5 text-sm font-semibold">
          + Nuova prenotazione
        </Link>
      </div>

      {error && <p className="text-sm text-rose-600 mb-4">{error}</p>}

      {/* Ricerca rapida */}
      <form onSubmit={doSearch} className="flex items-center gap-2 rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-3">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 shrink-0 text-indigo-500">
          <circle cx="6.5" cy="6.5" r="4" /><path d="M10.5 10.5 14 14" />
        </svg>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Cerca prenotazione per nome o cognome cliente..."
          className="flex-1 bg-transparent text-sm text-slate-700 placeholder:text-slate-400 outline-none"
        />
        {search && (
          <button type="button" onClick={() => setSearch("")} className="text-slate-400 hover:text-slate-600 text-lg leading-none">×</button>
        )}
        <button
          type="submit"
          className="rounded-xl bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 transition shrink-0"
        >
          Cerca
        </button>
      </form>

      {/* KPI */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className={`card p-4 flex flex-col gap-1 ${kpi.pending > 0 ? "border-amber-200 bg-amber-50" : ""}`}>
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-600">In attesa</p>
          <p className={`text-3xl font-bold ${kpi.pending > 0 ? "text-amber-700" : "text-slate-700"}`}>
            {loading ? "—" : kpi.pending}
          </p>
          <p className="text-xs text-slate-400">Risposta operatore</p>
        </div>
        <div className="card p-4 flex flex-col gap-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-600">Confermate</p>
          <p className="text-3xl font-bold text-emerald-700">{loading ? "—" : kpi.confirmed}</p>
          <p className="text-xs text-slate-400">Approvate dall'operatore</p>
        </div>
        <div className="card p-4 flex flex-col gap-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">Prossimi</p>
          <p className="text-3xl font-bold text-indigo-700">{loading ? "—" : kpi.upcoming}</p>
          <p className="text-xs text-slate-400">Servizi futuri</p>
        </div>
        <div className="card p-4 flex flex-col gap-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Totale</p>
          <p className="text-3xl font-bold text-slate-700">{loading ? "—" : kpi.total}</p>
          <p className="text-xs text-slate-400">Prenotazioni storiche</p>
        </div>
      </div>

      {/* Contabilità */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-bold text-slate-800">Contabilità</h2>
          <Link href="/agency/bookings" className="text-xs text-indigo-600 hover:underline">Vedi dettaglio →</Link>
        </div>
        <div className="grid grid-cols-3 gap-4">
          {/* Da pagare */}
          <div className="rounded-xl bg-rose-50 border border-rose-100 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-rose-600 mb-1">Da pagare</p>
            <p className="text-2xl font-bold text-rose-700">
              {loading ? "—" : fmtEur(accounting.toPay)}
            </p>
            <p className="text-xs text-slate-400 mt-1">Servizi confermati non ancora saldati</p>
          </div>
          {/* Pagato */}
          <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-600 mb-1">Pagato</p>
            <p className="text-2xl font-bold text-emerald-700">
              {loading ? "—" : fmtEur(accounting.paid)}
            </p>
            <p className="text-xs text-slate-400 mt-1">Saldato all'operatore</p>
          </div>
          {/* Totale impegnato */}
          <div className="rounded-xl bg-slate-50 border border-slate-200 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Totale impegnato</p>
            <p className="text-2xl font-bold text-slate-700">
              {loading ? "—" : fmtEur(accounting.total)}
            </p>
            <p className="text-xs text-slate-400 mt-1">Somma prezzi dichiarati</p>
          </div>
        </div>
        {accounting.total === 0 && !loading && (
          <p className="mt-3 text-xs text-slate-400 text-center">
            I totali si aggiornano inserendo il prezzo concordato nella prenotazione.
          </p>
        )}
      </div>

      {/* Ultime 5 prenotazioni */}
      <div className="card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-800">Ultime prenotazioni</h2>
          <Link href="/agency/bookings" className="text-xs text-indigo-600 hover:underline">Vedi tutte →</Link>
        </div>
        {loading ? (
          <p className="text-xs text-slate-400">Caricamento...</p>
        ) : lastFive.length === 0 ? (
          <div className="rounded-xl bg-slate-50 border border-slate-100 px-4 py-5 text-center">
            <p className="text-sm font-medium text-slate-600">Nessuna prenotazione</p>
            <p className="text-xs text-slate-400 mt-1">Crea la tua prima prenotazione.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {lastFive.map((row) => {
              const name = row.customer_first_name && row.customer_last_name
                ? `${row.customer_first_name} ${row.customer_last_name}`
                : row.customer_name;
              const isPaid = row.agency_payment_status === "paid";
              return (
                <div
                  key={row.id}
                  className="rounded-xl border border-slate-100 bg-slate-50 p-3 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-slate-800 truncate">{name}</p>
                      <ApprovalChip status={row.approval_status} />
                    </div>
                    <p className="text-xs text-slate-500">
                      {KIND_LABELS[row.booking_service_kind ?? ""] ?? row.booking_service_kind} · {row.hotel_name}
                    </p>
                    <p className="text-xs text-slate-400">{fmtDate(row.arrival_date)} {row.pax} pax</p>
                  </div>
                  <div className="shrink-0 text-right">
                    {row.agency_quoted_price_cents != null && (
                      <p className={`text-sm font-bold ${isPaid ? "text-emerald-600" : "text-slate-700"}`}>
                        {fmtEur(row.agency_quoted_price_cents)}
                      </p>
                    )}
                    {isPaid ? (
                      <span className="text-[10px] font-semibold text-emerald-600">✓ Pagato</span>
                    ) : row.agency_quoted_price_cents != null ? (
                      <span className="text-[10px] text-rose-500">Da pagare</span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Azioni rapide */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Link
          href="/agency/new-booking"
          className="card p-5 flex items-center gap-4 hover:shadow-md transition-shadow group"
        >
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-indigo-600 text-white text-2xl group-hover:bg-indigo-700 transition-colors">
            +
          </div>
          <div>
            <p className="font-bold text-slate-800">Nuova prenotazione</p>
            <p className="text-xs text-slate-500 mt-0.5">Transfer, bus, escursione o formula traghetto.</p>
          </div>
        </Link>
        <Link
          href="/agency/bookings"
          className="card p-5 flex items-center gap-4 hover:shadow-md transition-shadow group"
        >
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-slate-100 text-slate-600 text-2xl group-hover:bg-slate-200 transition-colors">
            📋
          </div>
          <div>
            <p className="font-bold text-slate-800">Le mie prenotazioni</p>
            <p className="text-xs text-slate-500 mt-0.5">Storico completo per mese, con ricerca e filtri.</p>
          </div>
        </Link>
      </div>

      {/* Info cancellazione */}
      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500">
        Per annullare una prenotazione vai in <strong>Le mie prenotazioni</strong>, seleziona la tratta e usa il pulsante <strong>Annulla tratta</strong>. L'operatore riceverà una notifica automatica.
      </div>
    </section>
  );
}
