"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import {
  ROUTE_LABELS,
  TICKET_MODE_LABELS,
  formatEur,
  type MedmarRoute,
} from "@/lib/medmar-ar/types";
import type { MedmarArStats } from "@/app/api/medmar-ar/stats/route";
import type { InsightsResponse } from "@/app/api/medmar-ar/insights/route";

async function getToken() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function apiFetch<T>(path: string, token: string): Promise<T | null> {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const body = await res.json();
  return body.ok ? body : null;
}

function StampaInner() {
  const sp = useSearchParams();
  const today = new Date().toISOString().slice(0, 10);
  const firstOfYear = `${today.slice(0, 4)}-01-01`;
  const dateFrom = sp.get("date_from") ?? firstOfYear;
  const dateTo = sp.get("date_to") ?? today;

  const [stats, setStats] = useState<MedmarArStats | null>(null);
  const [insights, setInsights] = useState<InsightsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const load = async () => {
      const token = await getToken();
      if (!token) { setError("Sessione non valida."); setLoading(false); return; }

      const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
      const [statsRes, insightsRes] = await Promise.all([
        apiFetch<{ stats: MedmarArStats }>(`/api/medmar-ar/stats?${params}`, token),
        apiFetch<InsightsResponse>("/api/medmar-ar/insights", token),
      ]);

      if (!active) return;
      if (statsRes) setStats(statsRes.stats);
      if (insightsRes) setInsights(insightsRes);
      setLoading(false);

      // Auto-print dopo il rendering
      if (statsRes) setTimeout(() => window.print(), 500);
    };
    void load();
    return () => { active = false; };
  }, [dateFrom, dateTo]);

  if (loading) return (
    <div className="flex items-center justify-center min-h-screen">
      <p className="text-slate-400 text-sm">Preparazione report...</p>
    </div>
  );

  if (error) return (
    <div className="flex items-center justify-center min-h-screen">
      <p className="text-rose-600 text-sm">{error}</p>
    </div>
  );

  if (!stats) return null;

  const generatedAt = new Date().toLocaleDateString("it-IT", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="report-root">
      {/* Toolbar — nascosta in stampa */}
      <div className="print:hidden fixed top-0 left-0 right-0 z-10 bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between shadow-sm">
        <p className="text-sm font-semibold text-slate-700">Report Medmar A/R — {dateFrom} / {dateTo}</p>
        <div className="flex gap-2">
          <button
            onClick={() => window.print()}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-700"
          >
            🖨️ Stampa / Salva PDF
          </button>
          <button
            onClick={() => window.close()}
            className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            Chiudi
          </button>
        </div>
      </div>

      {/* Corpo report */}
      <div className="report-body print:mt-0 mt-16 max-w-4xl mx-auto px-8 py-8 space-y-10">

        {/* Intestazione */}
        <div className="border-b-2 border-indigo-600 pb-6">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-3xl font-extrabold text-slate-900">Report Medmar A/R</h1>
              <p className="mt-1 text-slate-500 text-sm">
                Periodo: {new Date(`${dateFrom}T00:00:00`).toLocaleDateString("it-IT", { day: "2-digit", month: "long", year: "numeric" })}
                {" — "}
                {new Date(`${dateTo}T00:00:00`).toLocaleDateString("it-IT", { day: "2-digit", month: "long", year: "numeric" })}
              </p>
              <p className="text-xs text-slate-400 mt-0.5">Generato il {generatedAt}</p>
            </div>
            <div className="text-right">
              <p className="text-4xl">🎫</p>
            </div>
          </div>
        </div>

        {/* KPI principali */}
        <section className="space-y-4">
          <h2 className="text-lg font-bold text-slate-900 border-l-4 border-indigo-600 pl-3">KPI Periodo</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[
              { label: "Biglietti emessi",  value: String(stats.kpi.total_tickets),        sub: `${stats.kpi.total_pax} pax` },
              { label: "Valore totale",     value: formatEur(stats.kpi.total_value_cents),  sub: "emesso" },
              { label: "Perdita netta",     value: formatEur(stats.kpi.net_loss_cents),     sub: `recuperato ${formatEur(stats.kpi.value_recovered_cents)}`, color: stats.kpi.net_loss_cents > 0 ? "text-rose-600" : "text-emerald-600" },
              { label: "Tratte totali",     value: String(stats.kpi.legs.total),            sub: `perse: ${stats.kpi.legs.lost} · riassegnate: ${stats.kpi.legs.reassigned}` },
            ].map((k) => (
              <div key={k.label} className="rounded-xl border border-slate-200 p-4">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{k.label}</p>
                <p className={`mt-1 text-xl font-extrabold ${k.color ?? "text-slate-900"}`}>{k.value}</p>
                {k.sub && <p className="text-xs text-slate-400 mt-0.5">{k.sub}</p>}
              </div>
            ))}
          </div>

          {/* Breakdown modalità */}
          <div className="rounded-xl border border-slate-200 p-4">
            <p className="text-xs font-semibold text-slate-500 uppercase mb-3">Breakdown per modalità</p>
            <div className="grid grid-cols-3 gap-4">
              {[
                { label: "A/R",         value: stats.kpi.by_mode.round_trip,      color: "bg-indigo-100 text-indigo-700" },
                { label: "Solo Andata", value: stats.kpi.by_mode.single_outbound, color: "bg-emerald-100 text-emerald-700" },
                { label: "Solo Ritorno",value: stats.kpi.by_mode.single_return,   color: "bg-sky-100 text-sky-700" },
              ].map((m) => (
                <div key={m.label} className="text-center">
                  <span className={`inline-block rounded-full px-3 py-1 text-sm font-bold ${m.color}`}>{m.value}</span>
                  <p className="text-xs text-slate-500 mt-1">{m.label}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Stato tratte */}
          <div className="rounded-xl border border-slate-200 p-4">
            <p className="text-xs font-semibold text-slate-500 uppercase mb-3">Stato tratte</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {[
                { label: "Utilizzate",     val: stats.kpi.legs.used,            color: "text-emerald-600" },
                { label: "Disponibili",    val: stats.kpi.legs.available,       color: "text-amber-600" },
                { label: "Riassegnate",    val: stats.kpi.legs.reassigned,      color: "text-blue-600" },
                { label: "Perse",          val: stats.kpi.legs.lost,            color: "text-rose-600" },
                { label: "N/A",            val: stats.kpi.legs.not_applicable,  color: "text-slate-400" },
              ].map((s) => (
                <div key={s.label} className="text-center">
                  <p className={`text-2xl font-extrabold ${s.color}`}>{s.val}</p>
                  <p className="text-xs text-slate-500">{s.label}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Trend mensile */}
        {stats.monthly_trend.length > 0 && (
          <section className="space-y-4">
            <h2 className="text-lg font-bold text-slate-900 border-l-4 border-indigo-600 pl-3">Trend Mensile</h2>
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-slate-50">
                  <th className="border border-slate-200 px-3 py-2 text-left font-semibold text-slate-600">Mese</th>
                  <th className="border border-slate-200 px-3 py-2 text-right font-semibold text-slate-600">Biglietti</th>
                  <th className="border border-slate-200 px-3 py-2 text-right font-semibold text-slate-600">Valore</th>
                  <th className="border border-slate-200 px-3 py-2 text-right font-semibold text-slate-600">Perso</th>
                  <th className="border border-slate-200 px-3 py-2 text-right font-semibold text-slate-600">Recuperato</th>
                </tr>
              </thead>
              <tbody>
                {stats.monthly_trend.map((m) => (
                  <tr key={m.month} className="hover:bg-slate-50">
                    <td className="border border-slate-200 px-3 py-2 font-medium">
                      {new Date(`${m.month}-01T00:00:00`).toLocaleDateString("it-IT", { month: "long", year: "numeric" })}
                    </td>
                    <td className="border border-slate-200 px-3 py-2 text-right">{m.tickets}</td>
                    <td className="border border-slate-200 px-3 py-2 text-right">{formatEur(m.value_cents)}</td>
                    <td className="border border-slate-200 px-3 py-2 text-right text-rose-600">{m.lost_cents > 0 ? formatEur(m.lost_cents) : "—"}</td>
                    <td className="border border-slate-200 px-3 py-2 text-right text-emerald-600">{m.recovered_cents > 0 ? formatEur(m.recovered_cents) : "—"}</td>
                  </tr>
                ))}
                <tr className="bg-slate-50 font-bold">
                  <td className="border border-slate-200 px-3 py-2">Totale</td>
                  <td className="border border-slate-200 px-3 py-2 text-right">{stats.monthly_trend.reduce((s, m) => s + m.tickets, 0)}</td>
                  <td className="border border-slate-200 px-3 py-2 text-right">{formatEur(stats.monthly_trend.reduce((s, m) => s + m.value_cents, 0))}</td>
                  <td className="border border-slate-200 px-3 py-2 text-right text-rose-600">{formatEur(stats.monthly_trend.reduce((s, m) => s + m.lost_cents, 0))}</td>
                  <td className="border border-slate-200 px-3 py-2 text-right text-emerald-600">{formatEur(stats.monthly_trend.reduce((s, m) => s + m.recovered_cents, 0))}</td>
                </tr>
              </tbody>
            </table>
          </section>
        )}

        {/* Per tratta */}
        {stats.by_route.length > 0 && (
          <section className="space-y-4">
            <h2 className="text-lg font-bold text-slate-900 border-l-4 border-indigo-600 pl-3">Analisi per Tratta</h2>
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-slate-50">
                  <th className="border border-slate-200 px-3 py-2 text-left font-semibold text-slate-600">Tratta</th>
                  <th className="border border-slate-200 px-3 py-2 text-right font-semibold text-slate-600">Biglietti</th>
                  <th className="border border-slate-200 px-3 py-2 text-right font-semibold text-slate-600">Valore</th>
                  <th className="border border-slate-200 px-3 py-2 text-right font-semibold text-slate-600">Perso</th>
                  <th className="border border-slate-200 px-3 py-2 text-right font-semibold text-slate-600">% Perso</th>
                </tr>
              </thead>
              <tbody>
                {stats.by_route.map((r) => {
                  const pct = r.value_cents > 0 ? Math.round((r.lost_cents / r.value_cents) * 100) : 0;
                  return (
                    <tr key={r.route} className="hover:bg-slate-50">
                      <td className="border border-slate-200 px-3 py-2">{ROUTE_LABELS[r.route as MedmarRoute] ?? r.route}</td>
                      <td className="border border-slate-200 px-3 py-2 text-right">{r.tickets}</td>
                      <td className="border border-slate-200 px-3 py-2 text-right">{formatEur(r.value_cents)}</td>
                      <td className="border border-slate-200 px-3 py-2 text-right text-rose-600">{r.lost_cents > 0 ? formatEur(r.lost_cents) : "—"}</td>
                      <td className={`border border-slate-200 px-3 py-2 text-right font-semibold ${pct > 15 ? "text-rose-600" : pct > 5 ? "text-amber-600" : "text-emerald-600"}`}>
                        {pct > 0 ? `${pct}%` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}

        {/* Per operatore */}
        {stats.by_operator.length > 0 && (
          <section className="space-y-4">
            <h2 className="text-lg font-bold text-slate-900 border-l-4 border-indigo-600 pl-3">Analisi per Operatore</h2>
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-slate-50">
                  <th className="border border-slate-200 px-3 py-2 text-left font-semibold text-slate-600">Operatore</th>
                  <th className="border border-slate-200 px-3 py-2 text-right font-semibold text-slate-600">Biglietti</th>
                  <th className="border border-slate-200 px-3 py-2 text-right font-semibold text-slate-600">A/R emessi</th>
                  <th className="border border-slate-200 px-3 py-2 text-right font-semibold text-slate-600">% A/R</th>
                  <th className="border border-slate-200 px-3 py-2 text-right font-semibold text-slate-600">Perdita generata</th>
                </tr>
              </thead>
              <tbody>
                {stats.by_operator.sort((a, b) => b.lost_cents - a.lost_cents).map((op) => {
                  const arPct = op.tickets > 0 ? Math.round((op.round_trip_count / op.tickets) * 100) : 0;
                  return (
                    <tr key={op.operator_id} className="hover:bg-slate-50">
                      <td className="border border-slate-200 px-3 py-2 font-medium">{op.operator_name}</td>
                      <td className="border border-slate-200 px-3 py-2 text-right">{op.tickets}</td>
                      <td className="border border-slate-200 px-3 py-2 text-right">{op.round_trip_count}</td>
                      <td className="border border-slate-200 px-3 py-2 text-right">{arPct}%</td>
                      <td className={`border border-slate-200 px-3 py-2 text-right font-semibold ${op.lost_cents > 0 ? "text-rose-600" : "text-slate-400"}`}>
                        {op.lost_cents > 0 ? formatEur(op.lost_cents) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}

        {/* Leve strategiche */}
        {insights && insights.insights.length > 0 && (
          <section className="space-y-4">
            <h2 className="text-lg font-bold text-slate-900 border-l-4 border-indigo-600 pl-3">Leve Strategiche</h2>
            <p className="text-sm text-slate-500">
              Risparmio/recupero potenziale stimato:{" "}
              <strong className="text-slate-800">{formatEur(insights.summary.total_potential_savings_cents)}</strong>
            </p>
            <div className="space-y-3">
              {insights.insights.map((ins) => (
                <div
                  key={ins.id}
                  className={`rounded-xl border p-4 ${
                    ins.priority === "high"
                      ? "border-rose-200 bg-rose-50"
                      : ins.priority === "medium"
                      ? "border-amber-200 bg-amber-50"
                      : "border-slate-200 bg-slate-50"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-bold text-slate-900 text-sm">{ins.title}</p>
                    <div className="shrink-0 text-right space-y-0.5">
                      <span className={`block rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        ins.priority === "high" ? "bg-rose-600 text-white" :
                        ins.priority === "medium" ? "bg-amber-500 text-white" :
                        "bg-slate-200 text-slate-600"
                      }`}>
                        {ins.priority === "high" ? "Alta priorità" : ins.priority === "medium" ? "Media" : "Bassa"}
                      </span>
                      {ins.impact_cents > 0 && (
                        <p className="text-xs font-semibold text-slate-600">Impact: {formatEur(ins.impact_cents)}</p>
                      )}
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-slate-600">{ins.description}</p>
                  <p className="mt-2 text-xs font-semibold text-slate-700">→ {ins.action}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Footer */}
        <footer className="border-t border-slate-200 pt-6 text-xs text-slate-400 text-center">
          Report generato automaticamente da ITS · Medmar A/R · {generatedAt}
        </footer>
      </div>

      <style jsx global>{`
        @media print {
          @page { margin: 1.5cm; size: A4; }
          body { font-size: 11px !important; }
          .report-body { max-width: 100% !important; padding: 0 !important; margin: 0 !important; }
          table { page-break-inside: auto; }
          tr { page-break-inside: avoid; }
          h2 { page-break-before: auto; page-break-after: avoid; }
          section { page-break-inside: avoid; }
        }
      `}</style>
    </div>
  );
}

export default function StampaPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-screen"><p className="text-slate-400 text-sm">Caricamento...</p></div>}>
      <StampaInner />
    </Suspense>
  );
}
