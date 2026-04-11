"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type BookingRow = {
  id: string;
  customer_name: string;
  customer_first_name: string | null;
  customer_last_name: string | null;
  phone: string | null;
  pax: number;
  arrival_date: string | null;
  arrival_time: string | null;
  departure_date: string | null;
  departure_time: string | null;
  booking_service_kind: string | null;
  approval_status: string | null;
  created_at: string;
  hotels: { name: string } | null;
  agencies: { name: string } | null;
  approval_token: string | null;
};

function fmtDate(iso?: string | null) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function kindLabel(kind: string | null) {
  const map: Record<string, string> = {
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
  return kind ? (map[kind] ?? kind) : "—";
}

export default function AgencyRequestsPage() {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<BookingRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"pending" | "all">("pending");

  useEffect(() => {
    let active = true;
    const load = async () => {
      const session = await getClientSessionContext();
      if (!active) return;
      if (!hasSupabaseEnv || !supabase || !session.tenantId) {
        setError("Configurazione non disponibile.");
        setLoading(false);
        return;
      }
      if (session.role !== "admin" && session.role !== "operator") {
        setError("Accesso non autorizzato.");
        setLoading(false);
        return;
      }

      let q = supabase
        .from("services")
        .select("id,customer_name,customer_first_name,customer_last_name,phone,pax,arrival_date,arrival_time,departure_date,departure_time,booking_service_kind,approval_status,created_at,hotels(name),agencies(name)")
        .eq("tenant_id", session.tenantId)
        .not("approval_status", "is", null)
        .order("created_at", { ascending: false })
        .limit(200);

      if (filter === "pending") {
        q = q.eq("approval_status", "pending_operator");
      }

      const { data, error: err } = await q;
      if (!active) return;
      if (err) { setError(err.message); setLoading(false); return; }

      // Per ogni servizio, cerca il token di approvazione attivo
      const serviceIds = (data ?? []).map((r) => r.id);
      let tokenMap: Record<string, string> = {};
      if (serviceIds.length > 0) {
        const { data: tokens } = await supabase
          .from("booking_approval_tokens")
          .select("service_id, token")
          .in("service_id", serviceIds)
          .is("used_at", null)
          .order("created_at", { ascending: false });
        for (const t of tokens ?? []) {
          if (t.service_id && t.token && !tokenMap[t.service_id]) {
            tokenMap[t.service_id] = t.token;
          }
        }
      }

      setRows(
        (data ?? []).map((r) => ({
          ...r,
          hotels: Array.isArray(r.hotels) ? r.hotels[0] ?? null : r.hotels,
          agencies: Array.isArray(r.agencies) ? r.agencies[0] ?? null : r.agencies,
          approval_token: tokenMap[r.id] ?? null,
        })) as BookingRow[]
      );
      setLoading(false);
    };
    void load();
    return () => { active = false; };
  }, [filter]);

  const pending = rows.filter((r) => r.approval_status === "pending_operator");
  const confirmed = rows.filter((r) => r.approval_status === "confirmed");
  const rejected = rows.filter((r) => r.approval_status === "rejected");

  return (
    <section className="mx-auto max-w-5xl page-section">
      <div className="section-head">
        <h1 className="section-title">Richieste prenotazioni agenzie</h1>
        <p className="section-subtitle">Elenco prenotazioni inviate dalle agenzie. Approva o rifiuta tramite il link dedicato.</p>
      </div>

      {/* Filtri + counter */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <button
          type="button"
          onClick={() => setFilter("pending")}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${filter === "pending" ? "bg-rose-600 text-white" : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"}`}
        >
          In attesa {pending.length > 0 && filter !== "pending" ? `(${pending.length})` : ""}
        </button>
        <button
          type="button"
          onClick={() => setFilter("all")}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${filter === "all" ? "bg-slate-800 text-white" : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"}`}
        >
          Tutte
        </button>
        {filter === "all" && (
          <span className="text-xs text-slate-400">
            {pending.length} in attesa · {confirmed.length} confermate · {rejected.length} rifiutate
          </span>
        )}
      </div>

      {loading && <p className="text-sm text-slate-500">Caricamento...</p>}
      {error && <p className="text-sm text-rose-600">{error}</p>}

      {!loading && !error && rows.length === 0 && (
        <div className="card p-8 text-center text-slate-400 text-sm">
          {filter === "pending" ? "Nessuna prenotazione in attesa di approvazione." : "Nessuna prenotazione trovata."}
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div className="space-y-3">
          {rows.map((row) => {
            const customerName = row.customer_first_name && row.customer_last_name
              ? `${row.customer_first_name} ${row.customer_last_name}`
              : row.customer_name;
            const isPending = row.approval_status === "pending_operator";
            const isConfirmed = row.approval_status === "confirmed";

            return (
              <div
                key={row.id}
                className={`card p-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4 ${isPending ? "border-amber-200 bg-amber-50/40" : ""}`}
              >
                {/* Status indicator */}
                <div className="shrink-0 pt-0.5">
                  {isPending && <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 border border-amber-300 px-2.5 py-1 text-xs font-semibold text-amber-800">⏳ In attesa</span>}
                  {isConfirmed && <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 border border-emerald-300 px-2.5 py-1 text-xs font-semibold text-emerald-800">✅ Confermata</span>}
                  {row.approval_status === "rejected" && <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 border border-rose-300 px-2.5 py-1 text-xs font-semibold text-rose-800">❌ Rifiutata</span>}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-800">{customerName}</span>
                    {row.phone && <span className="text-xs text-slate-500">{row.phone}</span>}
                    <span className="text-xs text-slate-400">· {row.pax} pax</span>
                  </div>
                  <div className="text-sm text-slate-600">
                    <span className="font-medium">{kindLabel(row.booking_service_kind)}</span>
                    {row.hotels?.name && <span className="text-slate-400"> → {row.hotels.name}</span>}
                  </div>
                  <div className="text-xs text-slate-500">
                    Arrivo: <span className="font-medium">{fmtDate(row.arrival_date)} {row.arrival_time ?? ""}</span>
                    {" · "}
                    Rientro: <span className="font-medium">{fmtDate(row.departure_date)} {row.departure_time ?? ""}</span>
                  </div>
                  {row.agencies?.name && (
                    <div className="text-xs text-slate-400">Agenzia: {row.agencies.name}</div>
                  )}
                  <div className="text-xs text-slate-300">Ricevuta il {new Date(row.created_at).toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
                </div>

                {/* Azione */}
                <div className="shrink-0">
                  {isPending && row.approval_token ? (
                    <Link
                      href={`/operator/approve/${row.approval_token}`}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700 transition"
                    >
                      Gestisci →
                    </Link>
                  ) : isPending ? (
                    <span className="text-xs text-slate-400 italic">Link approvazione scaduto</span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
