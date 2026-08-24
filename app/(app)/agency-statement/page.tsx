"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type Agency = { id: string; name: string };

type ServiceRow = {
  id: string;
  customer_name: string;
  customer_first_name: string | null;
  customer_last_name: string | null;
  booking_service_kind: string | null;
  arrival_date: string | null;
  departure_date: string | null;
  pax: number;
  status: string;
  approval_status: string | null;
  agency_quoted_price_cents: number;
  agency_payment_status: string;
  agency_paid_at: string | null;
  hotel_name: string;
  agency_id: string | null;
  agency_name: string;
};

type DisputeRow = {
  id: string;
  agency_id: string;
  service_id: string;
  original_price_cents: number;
  proposed_price_cents: number;
  agency_note: string | null;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  agencies: { name: string } | { name: string }[] | null;
  services: { customer_name: string | null; customer_first_name: string | null; customer_last_name: string | null; date: string | null; booking_service_kind: string | null } | null;
};

function disputeAgencyName(row: DisputeRow) {
  return Array.isArray(row.agencies) ? row.agencies[0]?.name ?? "—" : row.agencies?.name ?? "—";
}

function disputeCustomerName(row: DisputeRow) {
  const s = row.services;
  if (!s) return "—";
  return [s.customer_first_name, s.customer_last_name].filter(Boolean).join(" ") || s.customer_name || "—";
}

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

function fmtEur(cents: number) {
  return `€${(cents / 100).toFixed(2).replace(".", ",")}`;
}

function monthLabel(iso: string | null) {
  if (!iso) return "Senza data";
  const [y, m] = iso.split("-");
  const label = new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("it-IT", { month: "long", year: "numeric" });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export default function AgencyStatementPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [rows, setRows] = useState<ServiceRow[]>([]);
  const [selectedAgencyId, setSelectedAgencyId] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [filterPaid, setFilterPaid] = useState<"all" | "unpaid" | "paid">("all");

  // Contestazioni prezzo in attesa (agenzia -> ITS)
  const [disputes, setDisputes] = useState<DisputeRow[]>([]);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [disputeError, setDisputeError] = useState<string | null>(null);

  const loadDisputes = useCallback(async (tk: string) => {
    const res = await fetch("/api/ops/agency-invoice-disputes?status=pending", { headers: { Authorization: `Bearer ${tk}` } });
    const body = await res.json().catch(() => null) as { disputes?: DisputeRow[]; error?: string } | null;
    if (!res.ok || !body) { setDisputeError(body?.error ?? "Errore caricamento segnalazioni."); return; }
    setDisputes(body.disputes ?? []);
  }, []);

  const loadData = useCallback(async (tk: string, agencyId: string | null) => {
    const url = agencyId ? `/api/agency/statement?agency_id=${agencyId}` : "/api/agency/statement";
    const res = await fetch(url, { headers: { Authorization: `Bearer ${tk}` } });
    const body = await res.json().catch(() => null) as { rows?: ServiceRow[]; agencies?: Agency[] } | null;
    if (!res.ok || !body) { setError("Errore caricamento estratto conto."); return; }
    setAgencies(body.agencies ?? []);
    setRows(body.rows ?? []);
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
      await loadDisputes(tk);
      setLoading(false);
    };
    void boot();
    return () => { active = false; };
  }, [loadData, loadDisputes]);

  const resolveDispute = async (disputeId: string, action: "approve" | "reject") => {
    if (!token) return;
    setResolvingId(disputeId);
    setDisputeError(null);
    const res = await fetch(`/api/ops/agency-invoice-disputes/${disputeId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action }),
    });
    const body = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    setResolvingId(null);
    if (!res.ok || !body?.ok) { setDisputeError(body?.error ?? "Operazione non riuscita."); return; }
    setDisputes((prev) => prev.filter((d) => d.id !== disputeId));
    if (action === "approve") await loadData(token, selectedAgencyId);
  };

  // Ricalcola per-agenzia quando cambia selezione
  useEffect(() => {
    if (!token) return;
    const timeoutId = window.setTimeout(() => {
      void loadData(token, selectedAgencyId);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [selectedAgencyId, token, loadData]);

  // Totali per ogni agenzia (per sidebar)
  const agencyTotals = useMemo(() => {
    const map = new Map<string, { name: string; toPay: number; paid: number; total: number; count: number }>();
    for (const r of rows) {
      const id = r.agency_id ?? "__none__";
      if (!map.has(id)) map.set(id, { name: r.agency_name, toPay: 0, paid: 0, total: 0, count: 0 });
      const entry = map.get(id)!;
      entry.total += r.agency_quoted_price_cents;
      entry.count += 1;
      if (r.agency_payment_status === "paid") {
        entry.paid += r.agency_quoted_price_cents;
      } else if (r.agency_payment_status !== "waived") {
        entry.toPay += r.agency_quoted_price_cents;
      }
    }
    return [...map.entries()].sort(([, a], [, b]) => b.toPay - a.toPay);
  }, [rows]);

  // Righe filtrate per l'agenzia selezionata
  const visibleRows = useMemo(() => {
    let filtered = selectedAgencyId
      ? rows.filter((r) => r.agency_id === selectedAgencyId)
      : rows;
    if (filterPaid === "unpaid") filtered = filtered.filter((r) => r.agency_payment_status !== "paid" && r.agency_payment_status !== "waived");
    if (filterPaid === "paid") filtered = filtered.filter((r) => r.agency_payment_status === "paid");
    return filtered;
  }, [rows, selectedAgencyId, filterPaid]);

  // Raggruppa per mese
  const groupedByMonth = useMemo(() => {
    const map = new Map<string, ServiceRow[]>();
    for (const r of visibleRows) {
      const key = r.arrival_date?.slice(0, 7) ?? "senza-data";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return [...map.entries()].sort(([a], [b]) => b.localeCompare(a));
  }, [visibleRows]);

  // Totali righe visibili
  const totals = useMemo(() => {
    const toPay = visibleRows.filter((r) => r.agency_payment_status !== "paid" && r.agency_payment_status !== "waived")
      .reduce((s, r) => s + r.agency_quoted_price_cents, 0);
    const paid = visibleRows.filter((r) => r.agency_payment_status === "paid")
      .reduce((s, r) => s + r.agency_quoted_price_cents, 0);
    const total = visibleRows.reduce((s, r) => s + r.agency_quoted_price_cents, 0);
    return { toPay, paid, total };
  }, [visibleRows]);

  const markPayment = async (serviceId: string, status: "paid" | "unpaid") => {
    if (!token) return;
    setUpdatingId(serviceId);
    await fetch(`/api/agency/statement/${serviceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ payment_status: status })
    });
    setRows((prev) =>
      prev.map((r) => r.id === serviceId
        ? { ...r, agency_payment_status: status, agency_paid_at: status === "paid" ? new Date().toISOString().slice(0, 10) : null }
        : r
      )
    );
    setUpdatingId(null);
  };

  // Segna pagati tutti i Da pagare dell'agenzia selezionata
  const markAllPaid = async () => {
    if (!token) return;
    const unpaid = visibleRows.filter((r) => r.agency_payment_status === "unpaid");
    for (const r of unpaid) {
      await markPayment(r.id, "paid");
    }
  };

  if (loading) return <div className="p-6 text-sm text-slate-500">Caricamento...</div>;
  if (error) return <div className="p-6 text-sm text-rose-600">{error}</div>;

  const selectedAgency = selectedAgencyId
    ? agencies.find((a) => a.id === selectedAgencyId)
    : null;

  return (
    <section className="mx-auto max-w-6xl page-section">
      <div className="section-head">
        <div>
          <h1 className="section-title">Estratto conto agenzie</h1>
          <p className="section-subtitle">Monitora i saldi per agenzia, segna i pagamenti ricevuti e tieni il conto aggiornato.</p>
        </div>
      </div>

      {disputes.length > 0 && (
        <div className="card border-amber-200 bg-amber-50/60 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-amber-900">Contestazioni prezzo in attesa ({disputes.length})</h2>
          </div>
          {disputeError && <p className="text-xs font-semibold text-rose-600">{disputeError}</p>}
          <div className="space-y-2">
            {disputes.map((d) => (
              <div key={d.id} className="rounded-xl border border-amber-200 bg-white p-3 flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-800">{disputeAgencyName(d)} — {disputeCustomerName(d)}</p>
                  <p className="text-xs text-slate-500">
                    {d.services?.date ? fmtDate(d.services.date) : "—"} · {KIND_LABELS[d.services?.booking_service_kind ?? ""] ?? d.services?.booking_service_kind ?? "—"}
                  </p>
                  <p className="text-sm mt-1">
                    <span className="text-slate-400 line-through">{fmtEur(d.original_price_cents)}</span>
                    {" → "}
                    <span className="font-bold text-amber-700">{fmtEur(d.proposed_price_cents)}</span>
                  </p>
                  {d.agency_note && <p className="text-xs text-slate-500 mt-1 italic">&quot;{d.agency_note}&quot;</p>}
                </div>
                <div className="flex gap-2 shrink-0">
                  <button type="button" onClick={() => void resolveDispute(d.id, "approve")} disabled={resolvingId === d.id}
                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-60">
                    {resolvingId === d.id ? "..." : "Approva"}
                  </button>
                  <button type="button" onClick={() => void resolveDispute(d.id, "reject")} disabled={resolvingId === d.id}
                    className="rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-bold text-rose-700 hover:bg-rose-50 disabled:opacity-60">
                    Rifiuta
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">

        {/* Sidebar agenzie */}
        <div className="space-y-2">
          {/* Voce "Tutte" */}
          <button
            type="button"
            onClick={() => setSelectedAgencyId(null)}
            className={`w-full rounded-2xl border p-3 text-left transition-colors ${!selectedAgencyId ? "border-indigo-300 bg-indigo-50" : "border-slate-200 bg-white hover:bg-slate-50"}`}
          >
            <p className="text-xs font-bold text-slate-700">Tutte le agenzie</p>
            <p className="text-xs text-slate-400 mt-0.5">Vista consolidata</p>
          </button>

          {agencyTotals.map(([agencyId, data]) => {
            const isSelected = selectedAgencyId === agencyId;
            const hasPending = data.toPay > 0;
            return (
              <button
                key={agencyId}
                type="button"
                onClick={() => setSelectedAgencyId(agencyId === "__none__" ? null : agencyId)}
                className={`w-full rounded-2xl border p-3 text-left transition-colors ${isSelected ? "border-indigo-300 bg-indigo-50" : hasPending ? "border-rose-100 bg-rose-50/50 hover:bg-rose-50" : "border-slate-200 bg-white hover:bg-slate-50"}`}
              >
                <p className="text-xs font-bold text-slate-800 truncate">{data.name}</p>
                <div className="mt-1 flex items-center justify-between gap-2">
                  {data.toPay > 0 ? (
                    <span className="text-xs font-semibold text-rose-600">{fmtEur(data.toPay)} da pagare</span>
                  ) : (
                    <span className="text-xs text-emerald-600 font-semibold">✓ In pari</span>
                  )}
                  {data.paid > 0 && (
                    <span className="text-[10px] text-slate-400">{fmtEur(data.paid)} pagato</span>
                  )}
                </div>
              </button>
            );
          })}

          {agencyTotals.length === 0 && (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-center text-xs text-slate-400">
              Nessuna prenotazione con prezzo dichiarato.
            </div>
          )}
        </div>

        {/* Pannello principale */}
        <div className="space-y-4">

          {/* Totali */}
          <div className="grid grid-cols-3 gap-3">
            <div className="card p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-rose-600">Da pagare</p>
              <p className="text-2xl font-bold text-rose-700 mt-1">{fmtEur(totals.toPay)}</p>
            </div>
            <div className="card p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-600">Pagato</p>
              <p className="text-2xl font-bold text-emerald-700 mt-1">{fmtEur(totals.paid)}</p>
            </div>
            <div className="card p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Totale</p>
              <p className="text-2xl font-bold text-slate-700 mt-1">{fmtEur(totals.total)}</p>
            </div>
          </div>

          {/* Filtri + azioni batch */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex rounded-xl border border-slate-200 overflow-hidden text-xs font-semibold">
              {(["all", "unpaid", "paid"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilterPaid(f)}
                  className={`px-3 py-2 transition-colors ${filterPaid === f ? "bg-slate-800 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
                >
                  {f === "all" ? "Tutti" : f === "unpaid" ? "Da pagare" : "Pagati"}
                </button>
              ))}
            </div>

            {selectedAgencyId && totals.toPay > 0 && (
              <button
                type="button"
                onClick={() => void markAllPaid()}
                className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-700 transition"
              >
                ✓ Segna tutti pagati ({fmtEur(totals.toPay)})
              </button>
            )}

            <p className="text-xs text-slate-400 ml-auto">
              {visibleRows.length} servi{visibleRows.length === 1 ? "zio" : "zi"}
              {selectedAgency ? ` · ${selectedAgency.name}` : ""}
            </p>
          </div>

          {/* Lista per mese */}
          {visibleRows.length === 0 ? (
            <div className="card p-8 text-center text-sm text-slate-400">
              {filterPaid === "unpaid" ? "Nessun importo da pagare." : filterPaid === "paid" ? "Nessun pagamento registrato." : "Nessun servizio con prezzo dichiarato."}
            </div>
          ) : (
            <div className="card overflow-hidden">
              {groupedByMonth.map(([monthKey, monthRows]) => {
                const monthTotal = monthRows.reduce((s, r) => s + r.agency_quoted_price_cents, 0);
                const monthPaid = monthRows.filter((r) => r.agency_payment_status === "paid").reduce((s, r) => s + r.agency_quoted_price_cents, 0);
                return (
                  <div key={monthKey}>
                    {/* Header mese */}
                    <div className="flex items-center justify-between px-5 py-2.5 bg-slate-50 border-b border-slate-100 sticky top-0">
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-bold uppercase tracking-widest text-slate-600">
                          {monthLabel(monthRows[0]?.arrival_date ?? null)}
                        </span>
                        <span className="text-[10px] rounded-full bg-slate-200 px-2 py-0.5 text-slate-600">{monthRows.length}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs">
                        {monthPaid > 0 && <span className="text-emerald-600 font-semibold">{fmtEur(monthPaid)} pagato</span>}
                        <span className="font-bold text-slate-700">{fmtEur(monthTotal)} totale</span>
                      </div>
                    </div>

                    {/* Righe */}
                    {monthRows.map((row) => {
                      const isPaid = row.agency_payment_status === "paid";
                      const isWaived = row.agency_payment_status === "waived";
                      const isUpdating = updatingId === row.id;
                      const name = row.customer_first_name && row.customer_last_name
                        ? `${row.customer_first_name} ${row.customer_last_name}`
                        : row.customer_name;

                      return (
                        <div
                          key={row.id}
                          className={`flex items-center gap-4 px-5 py-3 border-b border-slate-100 last:border-0 transition-colors ${isPaid ? "bg-emerald-50/30" : ""}`}
                        >
                          {/* Info servizio */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-semibold text-slate-800">{name}</span>
                              {!selectedAgencyId && (
                                <span className="text-[10px] rounded-full bg-indigo-100 px-2 py-0.5 text-indigo-600 font-semibold">{row.agency_name}</span>
                              )}
                              {row.approval_status === "confirmed" && (
                                <span className="text-[10px] rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-700 font-semibold">✅ Conf.</span>
                              )}
                              {row.approval_status === "pending_operator" && (
                                <span className="text-[10px] rounded-full bg-amber-100 px-2 py-0.5 text-amber-700 font-semibold">⏳ Attesa</span>
                              )}
                            </div>
                            <p className="text-xs text-slate-500 mt-0.5">
                              {KIND_LABELS[row.booking_service_kind ?? ""] ?? row.booking_service_kind} · {row.hotel_name} · {fmtDate(row.arrival_date)} · {row.pax} pax
                            </p>
                            {isPaid && row.agency_paid_at && (
                              <p className="text-[10px] text-emerald-600 mt-0.5">Pagato il {fmtDate(row.agency_paid_at)}</p>
                            )}
                          </div>

                          {/* Prezzo */}
                          <div className="text-right shrink-0">
                            <p className={`text-sm font-bold ${isPaid ? "text-emerald-600" : isWaived ? "text-slate-400 line-through" : "text-slate-800"}`}>
                              {fmtEur(row.agency_quoted_price_cents)}
                            </p>
                          </div>

                          {/* Azione pagamento */}
                          <div className="shrink-0">
                            {isPaid ? (
                              <button
                                type="button"
                                disabled={isUpdating}
                                onClick={() => void markPayment(row.id, "unpaid")}
                                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100 transition disabled:opacity-50"
                              >
                                {isUpdating ? "..." : "Annulla"}
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled={isUpdating}
                                onClick={() => void markPayment(row.id, "paid")}
                                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 transition disabled:opacity-50"
                              >
                                {isUpdating ? "..." : "✓ Pagato"}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
