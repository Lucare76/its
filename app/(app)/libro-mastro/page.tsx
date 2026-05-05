"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type Agency = { id: string; name: string };

type LedgerEntry = {
  id: string;
  date: string;
  customer_name: string;
  booking_service_kind: string | null;
  hotel_name: string;
  pax: number;
  agency_id: string | null;
  agency_name: string;
  amount_cents: number;
  payment_status: string;
  paid_at: string | null;
  is_paid: boolean;
  is_waived: boolean;
  running_balance_cents: number;
};

type Summary = {
  total_debit_cents: number;
  total_paid_cents: number;
  outstanding_cents: number;
};

const KIND_LABELS: Record<string, string> = {
  transfer_port_hotel: "Transfer Porto",
  transfer_airport_hotel: "Transfer Aeroporto",
  transfer_airport_hotel_exclusive: "Transfer Aeroporto (escl.)",
  transfer_train_hotel: "Transfer Stazione",
  transfer_train_hotel_exclusive: "Transfer Stazione (escl.)",
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

function fmtEur(cents: number) {
  const abs = Math.abs(cents);
  const sign = cents < 0 ? "-" : "";
  return `${sign}€${(abs / 100).toFixed(2).replace(".", ",")}`;
}

export default function LibroMastroPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [summary, setSummary] = useState<Summary>({ total_debit_cents: 0, total_paid_cents: 0, outstanding_cents: 0 });
  const [selectedAgencyId, setSelectedAgencyId] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<"all" | "unpaid" | "paid">("all");

  const loadData = useCallback(async (tk: string, agencyId: string | null) => {
    const url = agencyId ? `/api/agency/ledger?agency_id=${agencyId}` : "/api/agency/ledger";
    const res = await fetch(url, { headers: { Authorization: `Bearer ${tk}` } });
    const body = await res.json().catch(() => null) as {
      agencies?: Agency[];
      entries?: LedgerEntry[];
      summary?: Summary;
    } | null;
    if (!res.ok || !body) { setError("Errore caricamento libro mastro."); return; }
    setAgencies(body.agencies ?? []);
    setEntries(body.entries ?? []);
    setSummary(body.summary ?? { total_debit_cents: 0, total_paid_cents: 0, outstanding_cents: 0 });
  }, []);

  useEffect(() => {
    let active = true;
    const boot = async () => {
      const session = await getClientSessionContext();
      if (!active) return;
      if (!hasSupabaseEnv || !supabase) { setError("Supabase non configurato."); setLoading(false); return; }
      if (session.role !== "admin" && session.role !== "operator") { setError("Accesso non autorizzato."); setLoading(false); return; }
      const { data: sd } = await supabase.auth.getSession();
      const tk = sd.session?.access_token ?? null;
      if (!tk) { setError("Sessione non valida."); setLoading(false); return; }
      setToken(tk);
      await loadData(tk, null);
      setLoading(false);
    };
    void boot();
    return () => { active = false; };
  }, [loadData]);

  useEffect(() => {
    if (!token) return;
    const t = window.setTimeout(() => void loadData(token, selectedAgencyId), 0);
    return () => window.clearTimeout(t);
  }, [selectedAgencyId, token, loadData]);

  // Saldi per sidebar
  const agencyBalances = useMemo(() => {
    const map = new Map<string, { name: string; outstanding: number; total: number }>();
    for (const e of entries) {
      const id = e.agency_id ?? "__none__";
      if (!map.has(id)) map.set(id, { name: e.agency_name, outstanding: 0, total: 0 });
      const a = map.get(id)!;
      if (!e.is_waived) {
        a.total += e.amount_cents;
        if (!e.is_paid) a.outstanding += e.amount_cents;
      }
    }
    return [...map.entries()].sort(([, a], [, b]) => b.outstanding - a.outstanding);
  }, [entries]);

  // Voci visibili (filtrate + ordinate newest-first per la visualizzazione)
  const visibleEntries = useMemo(() => {
    let list = selectedAgencyId ? entries.filter((e) => e.agency_id === selectedAgencyId) : entries;
    if (filterStatus === "unpaid") list = list.filter((e) => !e.is_paid && !e.is_waived);
    if (filterStatus === "paid") list = list.filter((e) => e.is_paid);
    // Mostra dal più recente al più vecchio
    return [...list].sort((a, b) => b.date.localeCompare(a.date));
  }, [entries, selectedAgencyId, filterStatus]);

  // Saldo attuale (ultimo della serie cronologica filtrata)
  const currentBalance = useMemo(() => {
    const chronological = selectedAgencyId
      ? entries.filter((e) => e.agency_id === selectedAgencyId)
      : entries;
    return chronological.length > 0 ? chronological[chronological.length - 1].running_balance_cents : 0;
  }, [entries, selectedAgencyId]);

  const markPayment = async (serviceId: string, status: "paid" | "unpaid") => {
    if (!token) return;
    setUpdatingId(serviceId);
    await fetch(`/api/agency/statement/${serviceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ payment_status: status }),
    });
    await loadData(token, selectedAgencyId);
    setUpdatingId(null);
  };

  if (loading) return <div className="p-6 text-sm text-slate-500">Caricamento...</div>;
  if (error) return <div className="p-6 text-sm text-rose-600">{error}</div>;

  const selectedAgency = selectedAgencyId ? agencies.find((a) => a.id === selectedAgencyId) : null;

  return (
    <section className="mx-auto max-w-7xl page-section">
      <div className="section-head">
        <div>
          <h1 className="section-title">Libro mastro agenzie</h1>
          <p className="section-subtitle">Vista cronologica con saldo progressivo per ogni agenzia.</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">

        {/* Sidebar agenzie */}
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setSelectedAgencyId(null)}
            className={`w-full rounded-2xl border p-3 text-left transition-colors ${!selectedAgencyId ? "border-indigo-300 bg-indigo-50" : "border-slate-200 bg-white hover:bg-slate-50"}`}
          >
            <p className="text-xs font-bold text-slate-700">Tutte le agenzie</p>
            <p className="text-xs text-slate-400 mt-0.5">Vista consolidata</p>
          </button>

          {agencyBalances.map(([agId, data]) => {
            const isSelected = selectedAgencyId === agId;
            return (
              <button
                key={agId}
                type="button"
                onClick={() => setSelectedAgencyId(agId === "__none__" ? null : agId)}
                className={`w-full rounded-2xl border p-3 text-left transition-colors ${isSelected ? "border-indigo-300 bg-indigo-50" : data.outstanding > 0 ? "border-rose-100 bg-rose-50/50 hover:bg-rose-50" : "border-slate-200 bg-white hover:bg-slate-50"}`}
              >
                <p className="text-xs font-bold text-slate-800 truncate">{data.name}</p>
                <div className="mt-1 flex items-center justify-between gap-2">
                  {data.outstanding > 0 ? (
                    <span className="text-xs font-semibold text-rose-600">{fmtEur(data.outstanding)} da incassare</span>
                  ) : (
                    <span className="text-xs font-semibold text-emerald-600">✓ In pari</span>
                  )}
                  <span className="text-[10px] text-slate-400">{fmtEur(data.total)} tot.</span>
                </div>
              </button>
            );
          })}

          {agencyBalances.length === 0 && (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-center text-xs text-slate-400">
              Nessuna voce disponibile.
            </div>
          )}
        </div>

        {/* Pannello principale */}
        <div className="space-y-4">

          {/* KPI */}
          <div className="grid grid-cols-3 gap-3">
            <div className="card p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Addebitato</p>
              <p className="text-2xl font-bold text-slate-700 mt-1">{fmtEur(summary.total_debit_cents)}</p>
            </div>
            <div className="card p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-600">Incassato</p>
              <p className="text-2xl font-bold text-emerald-700 mt-1">{fmtEur(summary.total_paid_cents)}</p>
            </div>
            <div className="card p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-rose-600">Saldo residuo</p>
              <p className={`text-2xl font-bold mt-1 ${currentBalance > 0 ? "text-rose-700" : "text-emerald-700"}`}>
                {fmtEur(currentBalance)}
              </p>
            </div>
          </div>

          {/* Filtri */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex rounded-xl border border-slate-200 overflow-hidden text-xs font-semibold">
              {(["all", "unpaid", "paid"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilterStatus(f)}
                  className={`px-3 py-2 transition-colors ${filterStatus === f ? "bg-slate-800 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
                >
                  {f === "all" ? "Tutte" : f === "unpaid" ? "Da incassare" : "Incassate"}
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-400 ml-auto">
              {visibleEntries.length} voc{visibleEntries.length === 1 ? "e" : "i"}
              {selectedAgency ? ` · ${selectedAgency.name}` : ""}
            </p>
          </div>

          {/* Tabella libro mastro */}
          {visibleEntries.length === 0 ? (
            <div className="card p-8 text-center text-sm text-slate-400">
              Nessuna voce.
            </div>
          ) : (
            <div className="card overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50 text-[11px] font-bold uppercase tracking-widest text-slate-500">
                    <th className="px-4 py-3 text-left">Data</th>
                    <th className="px-4 py-3 text-left">Descrizione</th>
                    {!selectedAgencyId && <th className="px-4 py-3 text-left">Agenzia</th>}
                    <th className="px-4 py-3 text-right">Addebito</th>
                    <th className="px-4 py-3 text-right">Pagamento</th>
                    <th className="px-4 py-3 text-right">Saldo</th>
                    <th className="px-4 py-3 text-center">Azione</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleEntries.map((e) => {
                    const isUpdating = updatingId === e.id;
                    return (
                      <tr
                        key={e.id}
                        className={`border-b border-slate-100 last:border-0 transition-colors hover:bg-slate-50/60 ${e.is_paid ? "bg-emerald-50/20" : ""} ${e.is_waived ? "opacity-50" : ""}`}
                      >
                        <td className="px-4 py-3 text-slate-600 whitespace-nowrap">{fmtDate(e.date)}</td>
                        <td className="px-4 py-3">
                          <p className="font-semibold text-slate-800">{e.customer_name}</p>
                          <p className="text-[11px] text-slate-400 mt-0.5">
                            {KIND_LABELS[e.booking_service_kind ?? ""] ?? e.booking_service_kind} · {e.hotel_name} · {e.pax} pax
                          </p>
                          {e.is_paid && e.paid_at && (
                            <p className="text-[10px] text-emerald-600 mt-0.5">Pagato il {fmtDate(e.paid_at)}</p>
                          )}
                        </td>
                        {!selectedAgencyId && (
                          <td className="px-4 py-3">
                            <span className="text-[11px] rounded-full bg-indigo-100 px-2 py-0.5 text-indigo-600 font-semibold">{e.agency_name}</span>
                          </td>
                        )}
                        {/* Addebito */}
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          {!e.is_waived && (
                            <span className="font-semibold text-slate-700">{fmtEur(e.amount_cents)}</span>
                          )}
                          {e.is_waived && <span className="text-slate-400 line-through text-xs">{fmtEur(e.amount_cents)}</span>}
                        </td>
                        {/* Pagamento */}
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          {e.is_paid && (
                            <span className="font-semibold text-emerald-600">{fmtEur(e.amount_cents)}</span>
                          )}
                        </td>
                        {/* Saldo progressivo */}
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          <span className={`font-bold ${e.running_balance_cents > 0 ? "text-rose-600" : e.running_balance_cents < 0 ? "text-amber-600" : "text-emerald-600"}`}>
                            {fmtEur(e.running_balance_cents)}
                          </span>
                        </td>
                        {/* Azione */}
                        <td className="px-4 py-3 text-center">
                          {!e.is_waived && (
                            e.is_paid ? (
                              <button
                                type="button"
                                disabled={isUpdating}
                                onClick={() => void markPayment(e.id, "unpaid")}
                                className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 transition disabled:opacity-50"
                              >
                                {isUpdating ? "..." : "Annulla"}
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled={isUpdating}
                                onClick={() => void markPayment(e.id, "paid")}
                                className="rounded-lg bg-emerald-600 px-2 py-1 text-xs font-bold text-white hover:bg-emerald-700 transition disabled:opacity-50"
                              >
                                {isUpdating ? "..." : "✓ Pagato"}
                              </button>
                            )
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
