"use client";

import { useEffect, useState, useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { DateInput, PageHeader } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type KPI = {
  totalServices: number;
  totalRevenueCents: number;
  totalPax: number;
  punctualityRate: number;
  cancellationRate: number;
};

type MonthlyRow = {
  month: string;
  lyMonth: string;
  curServices: number;
  lyServices: number;
  curRevenueCents: number;
  lyRevenueCents: number;
  curPax: number;
  lyPax: number;
};

type AgencyYoY = {
  agency_id: string;
  agency_name: string;
  curServices: number;
  lyServices: number;
  curRevenueCents: number;
  lyRevenueCents: number;
  delta: number;
};

type Payload = {
  dateFrom: string;
  dateTo: string;
  lyFrom: string;
  lyTo: string;
  current: { kpi: KPI };
  lastYear: { kpi: KPI };
  kpiDelta: {
    services: number;
    revenue: number;
    pax: number;
    punctuality: number;
    cancellation: number;
  };
  monthlyComparison: MonthlyRow[];
  agencyYoY: AgencyYoY[];
};

function fmtEur(cents: number) {
  return (cents / 100).toLocaleString("it-IT", { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + " €";
}

function fmtPct(v: number, suffix = "%") {
  return `${v > 0 ? "+" : ""}${v}${suffix}`;
}

function monthLabel(iso: string) {
  const [y, m] = iso.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("it-IT", { month: "short", year: "2-digit" });
}

function deltaColor(v: number, lowerIsBetter = false) {
  if (v === 0) return "text-slate-500";
  const good = lowerIsBetter ? v < 0 : v > 0;
  return good ? "text-emerald-600" : "text-rose-600";
}

function deltaIcon(v: number, lowerIsBetter = false) {
  if (v === 0) return "→";
  const up = v > 0;
  return (up && !lowerIsBetter) || (!up && lowerIsBetter) ? "↑" : "↓";
}

function ytdRange() {
  const today = new Date();
  const from = new Date(today.getFullYear(), 0, 1);
  const toIso = (d: Date) => d.toISOString().slice(0, 10);
  return { dateFrom: toIso(from), dateTo: toIso(today) };
}

export default function AnalyticsYoYPage() {
  const defaults = useMemo(() => ytdRange(), []);
  const [dateFrom, setDateFrom] = useState(defaults.dateFrom);
  const [dateTo, setDateTo] = useState(defaults.dateTo);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Payload | null>(null);

  const load = async (from: string, to: string) => {
    if (!hasSupabaseEnv || !supabase) { setError("Supabase non configurato."); return; }
    if (!from || !to || from > to) { setError("Intervallo date non valido."); return; }
    setLoading(true); setError(null);
    try {
      const { data: s } = await supabase.auth.getSession();
      if (!s.session?.access_token) { setError("Sessione non valida."); return; }
      const res = await fetch(`/api/analytics/yoy?dateFrom=${from}&dateTo=${to}`, {
        headers: { Authorization: `Bearer ${s.session.access_token}` },
      });
      if (!res.ok) {
        setError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Errore caricamento.");
        return;
      }
      setData((await res.json()) as Payload);
    } catch { setError("Errore rete."); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(defaults.dateFrom, defaults.dateTo); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const chartData = useMemo(() =>
    (data?.monthlyComparison ?? []).map((r) => ({
      name: monthLabel(r.month),
      "Anno corrente": r.curServices,
      "Anno precedente": r.lyServices,
    })),
    [data]
  );

  const chartRevenueData = useMemo(() =>
    (data?.monthlyComparison ?? []).map((r) => ({
      name: monthLabel(r.month),
      "Anno corrente": Math.round(r.curRevenueCents / 100),
      "Anno precedente": Math.round(r.lyRevenueCents / 100),
    })),
    [data]
  );

  return (
    <section className="page-section">
      <PageHeader
        title="Confronto anno su anno"
        subtitle="Confronta KPI, servizi e revenue del periodo selezionato con lo stesso periodo dell'anno precedente."
        breadcrumbs={[{ label: "Analytics", href: "/analytics" }, { label: "Anno su anno" }]}
      />

      {/* Selettore periodo */}
      <div className="flex flex-wrap items-end gap-3 mb-6">
        <label className="text-xs font-medium text-slate-600">
          Da
          <DateInput value={dateFrom} onChange={(iso) => setDateFrom(iso)} className="mt-1 input-saas w-36" />
        </label>
        <label className="text-xs font-medium text-slate-600">
          A
          <DateInput value={dateTo} onChange={(iso) => setDateTo(iso)} className="mt-1 input-saas w-36" />
        </label>
        <button
          type="button"
          disabled={loading}
          onClick={() => void load(dateFrom, dateTo)}
          className="rounded-xl bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {loading ? "Caricamento..." : "Aggiorna"}
        </button>
        {data && (
          <p className="text-xs text-slate-400">
            Confronto con {data.lyFrom} → {data.lyTo}
          </p>
        )}
      </div>

      {error && <p className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</p>}

      {!data && !loading && (
        <div className="card p-8 text-center text-sm text-slate-400">Seleziona un periodo e clicca Aggiorna.</div>
      )}

      {data && (
        <div className="space-y-6">

          {/* KPI tiles */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {[
              {
                label: "Servizi",
                cur: data.current.kpi.totalServices.toLocaleString("it-IT"),
                ly: data.lastYear.kpi.totalServices.toLocaleString("it-IT"),
                delta: data.kpiDelta.services,
                lowerIsBetter: false,
                suffix: "%",
              },
              {
                label: "Revenue",
                cur: fmtEur(data.current.kpi.totalRevenueCents),
                ly: fmtEur(data.lastYear.kpi.totalRevenueCents),
                delta: data.kpiDelta.revenue,
                lowerIsBetter: false,
                suffix: "%",
              },
              {
                label: "Pax",
                cur: data.current.kpi.totalPax.toLocaleString("it-IT"),
                ly: data.lastYear.kpi.totalPax.toLocaleString("it-IT"),
                delta: data.kpiDelta.pax,
                lowerIsBetter: false,
                suffix: "%",
              },
              {
                label: "Puntualità",
                cur: `${data.current.kpi.punctualityRate}%`,
                ly: `${data.lastYear.kpi.punctualityRate}%`,
                delta: data.kpiDelta.punctuality,
                lowerIsBetter: false,
                suffix: " pp",
              },
              {
                label: "Cancellazioni",
                cur: `${data.current.kpi.cancellationRate}%`,
                ly: `${data.lastYear.kpi.cancellationRate}%`,
                delta: data.kpiDelta.cancellation,
                lowerIsBetter: true,
                suffix: " pp",
              },
            ].map((kpi) => (
              <div key={kpi.label} className="card p-4 space-y-1">
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-400">{kpi.label}</p>
                <p className="text-xl font-black text-slate-900">{kpi.cur}</p>
                <p className="text-xs text-slate-400">{kpi.ly} anno prec.</p>
                <p className={`text-xs font-bold ${deltaColor(kpi.delta, kpi.lowerIsBetter)}`}>
                  {deltaIcon(kpi.delta, kpi.lowerIsBetter)} {fmtPct(kpi.delta, kpi.suffix)}
                </p>
              </div>
            ))}
          </div>

          {/* Grafici mensili */}
          {chartData.length > 0 && (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="card p-4">
                <p className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-3">Servizi per mese</p>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={chartData} margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
                    <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} width={30} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="Anno corrente" fill="#2563eb" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="Anno precedente" fill="#cbd5e1" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="card p-4">
                <p className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-3">Revenue per mese (€)</p>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={chartRevenueData} margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
                    <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} width={48} />
                    <Tooltip formatter={(v) => typeof v === "number" ? `${v.toLocaleString("it-IT")} €` : v} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="Anno corrente" fill="#0f766e" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="Anno precedente" fill="#cbd5e1" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Confronto agenzie */}
          {data.agencyYoY.length > 0 && (
            <div className="card overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 bg-slate-50">
                <p className="text-xs font-bold uppercase tracking-widest text-slate-500">Confronto agenzie</p>
              </div>
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-[11px] font-bold uppercase tracking-widest text-slate-400">
                    <th className="px-4 py-2.5 text-left">Agenzia</th>
                    <th className="px-4 py-2.5 text-right">Servizi (cur)</th>
                    <th className="px-4 py-2.5 text-right">Servizi (prec)</th>
                    <th className="px-4 py-2.5 text-right">Revenue (cur)</th>
                    <th className="px-4 py-2.5 text-right">Revenue (prec)</th>
                    <th className="px-4 py-2.5 text-right">Δ Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {data.agencyYoY.map((a) => (
                    <tr key={a.agency_id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60 transition-colors">
                      <td className="px-4 py-3 font-semibold text-slate-800">{a.agency_name}</td>
                      <td className="px-4 py-3 text-right text-slate-600">{a.curServices}</td>
                      <td className="px-4 py-3 text-right text-slate-400">{a.lyServices}</td>
                      <td className="px-4 py-3 text-right font-semibold text-slate-800">{fmtEur(a.curRevenueCents)}</td>
                      <td className="px-4 py-3 text-right text-slate-400">{fmtEur(a.lyRevenueCents)}</td>
                      <td className={`px-4 py-3 text-right font-bold ${deltaColor(a.delta)}`}>
                        {deltaIcon(a.delta)} {fmtPct(a.delta)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

        </div>
      )}
    </section>
  );
}
