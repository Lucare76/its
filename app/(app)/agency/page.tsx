"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
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
  departure_time: string | null;
  booking_service_kind: string | null;
  hotel_name: string;
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
  formula_medmar: "Formula MEDMAR",
};

function fmtDate(iso?: string | null) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function ApprovalChip({ status }: { status: string | null }) {
  if (status === "confirmed")
    return <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-800">✅ Confermata</span>;
  if (status === "rejected")
    return <span className="rounded-full bg-rose-100 px-2.5 py-0.5 text-[11px] font-semibold text-rose-800">❌ Rifiutata</span>;
  if (status === "pending_operator")
    return <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800">⏳ In attesa</span>;
  return <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-semibold text-slate-600">—</span>;
}

export default function AgencyPage() {
  const [loading, setLoading] = useState(true);
  const [agencyName, setAgencyName] = useState<string | null>(null);
  const [rows, setRows] = useState<BookingRow[]>([]);
  const [error, setError] = useState<string | null>(null);

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

      // Carica prenotazioni
      const res = await fetch("/api/agency/bookings?limit=500", {
        headers: { Authorization: `Bearer ${token}` }
      });
      const body = await res.json().catch(() => null) as { rows?: BookingRow[]; error?: string } | null;
      if (!active) return;
      if (!res.ok) { setError(body?.error ?? "Errore caricamento."); setLoading(false); return; }

      // Carica nome agenzia
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
    const pending = rows.filter((r) => r.approval_status === "pending_operator" && r.status !== "cancelled");
    const confirmed = rows.filter((r) => r.approval_status === "confirmed" && r.status !== "cancelled");
    const upcoming = rows.filter((r) => {
      const d = r.arrival_date ?? r.departure_date;
      return d && d >= today && r.status !== "cancelled";
    });
    const cancelled = rows.filter((r) => r.status === "cancelled");
    return { pending: pending.length, confirmed: confirmed.length, upcoming: upcoming.length, cancelled: cancelled.length, total: rows.length };
  }, [rows, today]);

  const recentUpcoming = useMemo(
    () =>
      rows
        .filter((r) => {
          const d = r.arrival_date ?? r.departure_date;
          return d && d >= today && r.status !== "cancelled";
        })
        .sort((a, b) => (a.arrival_date ?? "") > (b.arrival_date ?? "") ? 1 : -1)
        .slice(0, 6),
    [rows, today]
  );

  const pendingRows = useMemo(
    () => rows.filter((r) => r.approval_status === "pending_operator" && r.status !== "cancelled").slice(0, 4),
    [rows]
  );

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

      {/* KPI */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {/* In attesa */}
        <div className={`card p-4 flex flex-col gap-1 ${kpi.pending > 0 ? "border-amber-200 bg-amber-50" : ""}`}>
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-600">In attesa</p>
          <p className={`text-3xl font-bold ${kpi.pending > 0 ? "text-amber-700" : "text-slate-700"}`}>
            {loading ? "—" : kpi.pending}
          </p>
          <p className="text-xs text-slate-400">Risposta operatore</p>
        </div>
        {/* Confermate */}
        <div className="card p-4 flex flex-col gap-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-600">Confermate</p>
          <p className="text-3xl font-bold text-emerald-700">{loading ? "—" : kpi.confirmed}</p>
          <p className="text-xs text-slate-400">Approvate dall'operatore</p>
        </div>
        {/* Prossimi servizi */}
        <div className="card p-4 flex flex-col gap-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">Prossimi</p>
          <p className="text-3xl font-bold text-indigo-700">{loading ? "—" : kpi.upcoming}</p>
          <p className="text-xs text-slate-400">Servizi futuri</p>
        </div>
        {/* Totale */}
        <div className="card p-4 flex flex-col gap-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Totale</p>
          <p className="text-3xl font-bold text-slate-700">{loading ? "—" : kpi.total}</p>
          <p className="text-xs text-slate-400">Prenotazioni storiche</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* In attesa di approvazione */}
        <div className="card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-800">In attesa di risposta</h2>
            <Link href="/agency/bookings" className="text-xs text-indigo-600 hover:underline">Vedi tutte →</Link>
          </div>
          {loading ? (
            <p className="text-xs text-slate-400">Caricamento...</p>
          ) : pendingRows.length === 0 ? (
            <div className="rounded-xl bg-slate-50 border border-slate-100 px-4 py-5 text-center">
              <p className="text-sm font-medium text-slate-600">Nessuna prenotazione in attesa</p>
              <p className="text-xs text-slate-400 mt-1">Tutte le richieste sono state elaborate.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {pendingRows.map((row) => {
                const name = row.customer_first_name && row.customer_last_name
                  ? `${row.customer_first_name} ${row.customer_last_name}`
                  : row.customer_name;
                return (
                  <div key={row.id} className="rounded-xl border border-amber-100 bg-amber-50 p-3 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-800 truncate">{name}</p>
                      <p className="text-xs text-slate-500">{KIND_LABELS[row.booking_service_kind ?? ""] ?? row.booking_service_kind}</p>
                      <p className="text-xs text-slate-400">{row.hotel_name} · {fmtDate(row.arrival_date)}</p>
                    </div>
                    <span className="shrink-0 text-lg">⏳</span>
                  </div>
                );
              })}
              {kpi.pending > 4 && (
                <p className="text-xs text-center text-slate-400">+ altri {kpi.pending - 4} in attesa</p>
              )}
            </div>
          )}
        </div>

        {/* Prossimi servizi */}
        <div className="card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-800">Prossimi servizi</h2>
            <Link href="/agency/bookings" className="text-xs text-indigo-600 hover:underline">Vedi tutti →</Link>
          </div>
          {loading ? (
            <p className="text-xs text-slate-400">Caricamento...</p>
          ) : recentUpcoming.length === 0 ? (
            <div className="rounded-xl bg-slate-50 border border-slate-100 px-4 py-5 text-center">
              <p className="text-sm font-medium text-slate-600">Nessun servizio in programma</p>
              <p className="text-xs text-slate-400 mt-1">Crea una nuova prenotazione per iniziare.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {recentUpcoming.map((row) => {
                const name = row.customer_first_name && row.customer_last_name
                  ? `${row.customer_first_name} ${row.customer_last_name}`
                  : row.customer_name;
                return (
                  <div key={row.id} className="rounded-xl border border-slate-100 bg-slate-50 p-3 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-800 truncate">{name}</p>
                      <p className="text-xs text-slate-500">{row.hotel_name}</p>
                      <p className="text-xs text-slate-400">
                        {fmtDate(row.arrival_date)} {row.arrival_time?.slice(0,5) ?? ""}
                        {row.departure_date && ` → ${fmtDate(row.departure_date)}`}
                      </p>
                    </div>
                    <ApprovalChip status={row.approval_status} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
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
            <p className="text-xs text-slate-500 mt-0.5">Storico completo con filtri e dettaglio operativo.</p>
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
