"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Cell, Legend,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type SummaryRow = {
  vehicle_id: string;
  label: string;
  plate?: string | null;
  license_number?: string | null;
  km_snapshot?: number | null;
  maintenance_cost: number;
  fuel_cost: number;
  total_cost: number;
  logged_km: number;
  fuel_liters: number;
  fuel_interval_km: number;
};

type TimelineRow = {
  vehicle_id: string;
  label: string;
  plate?: string | null;
  period: string;
  maintenance_cost: number;
  fuel_cost: number;
  total_cost: number;
  logged_km: number;
  fuel_liters: number;
  fuel_interval_km: number;
};

type Payload = {
  ok: true;
  period: "monthly" | "yearly";
  year: string;
  summary: SummaryRow[];
  timeline: TimelineRow[];
  totals: { maintenance_cost: number; fuel_cost: number; total_cost: number; logged_km: number; fuel_liters: number; fuel_interval_km: number };
};

async function accessToken() {
  if (!hasSupabaseEnv || !supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

function fmt(n: number) {
  return `EUR ${n.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatKmPerLiter(km: number, liters: number) {
  if (km <= 0 || liters <= 0) return "-";
  return `${(km / liters).toFixed(2)} km/L`;
}

function formatLitersPer100Km(km: number, liters: number) {
  if (km <= 0 || liters <= 0) return "-";
  return `${((liters / km) * 100).toFixed(1)} L/100 km`;
}

function safeNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const MONTH_LABELS = ["Gen", "Feb", "Mar", "Apr", "Mag", "Giu", "Lug", "Ago", "Set", "Ott", "Nov", "Dic"];

export default function FleetReportsPage() {
  const [period, setPeriod] = useState<"monthly" | "yearly">("monthly");
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chartType, setChartType] = useState<"vehicles" | "timeline">("vehicles");

  const load = useCallback(async () => {
    const token = await accessToken();
    if (!token) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    const res = await fetch(`/api/ops/fleet-cost-reports?period=${period}&year=${year}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json().catch(() => null) as Payload | { error?: string } | null;
    if (!res.ok || !json || !("ok" in json)) {
      setError((json as { error?: string } | null)?.error ?? "Errore caricamento report.");
      setLoading(false);
      return;
    }
    setPayload(json);
    setLoading(false);
  }, [period, year]);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  // Chart: top 8 veicoli per costo
  const vehicleChartData = useMemo(() => {
    return (payload?.summary ?? [])
      .sort((a, b) => b.total_cost - a.total_cost)
      .slice(0, 8)
      .map((row) => ({
        name: row.label.length > 10 ? `${row.label.slice(0, 10)}...` : row.label,
        Carburante: Number(row.fuel_cost.toFixed(2)),
        Manutenzione: Number(row.maintenance_cost.toFixed(2)),
      }));
  }, [payload]);

  // Chart: timeline aggregato (tutti i veicoli per periodo)
  const timelineChartData = useMemo(() => {
    if (!payload?.timeline.length) return [];
    const map = new Map<string, { fuel: number; maint: number }>();
    for (const row of payload.timeline) {
      const existing = map.get(row.period) ?? { fuel: 0, maint: 0 };
      existing.fuel += row.fuel_cost;
      existing.maint += row.maintenance_cost;
      map.set(row.period, existing);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, { fuel, maint }]) => {
        const label = period.length === 7
          ? `${MONTH_LABELS[parseInt(period.slice(5, 7)) - 1]} ${period.slice(2, 4)}`
          : period;
        return { name: label, Carburante: +fuel.toFixed(2), Manutenzione: +maint.toFixed(2) };
      });
  }, [payload]);

  const totals = payload?.totals;
  const totalsLoggedKm = safeNumber(totals?.logged_km);
  const totalsFuelLiters = safeNumber(totals?.fuel_liters);
  const totalsFuelIntervalKm = safeNumber(totals?.fuel_interval_km);
  const costPerKm = totals && totalsLoggedKm > 0
    ? totals.total_cost / totalsLoggedKm
    : null;
  const avgKmPerLiter = totals && totalsFuelIntervalKm > 0 && totalsFuelLiters > 0
    ? totalsFuelIntervalKm / totalsFuelLiters
    : null;
  const avgLitersPer100Km = totals && totalsFuelIntervalKm > 0 && totalsFuelLiters > 0
    ? (totalsFuelLiters / totalsFuelIntervalKm) * 100
    : null;

  const maxCost = useMemo(() =>
    Math.max(...(payload?.summary ?? []).map((r) => r.total_cost), 1),
    [payload]);

  return (
    <section className="page-section">
      <PageHeader
        title="Report veicoli"
        subtitle="Costi carburante, manutenzione e km registrati per mezzo."
        breadcrumbs={[
          { label: "Operazioni", href: "/dashboard" },
          { label: "Flotta", href: "/fleet-ops" },
          { label: "Report veicoli" },
        ]}
        actions={(
          <div className="flex flex-wrap gap-2">
            <select
              className="input-saas h-10 min-w-[130px]"
              value={period}
              onChange={(e) => setPeriod(e.target.value as "monthly" | "yearly")}
            >
              <option value="monthly">Mensile</option>
              <option value="yearly">Annuale</option>
            </select>
            <input
              className="input-saas h-10 w-24"
              value={year}
              onChange={(e) => setYear(e.target.value)}
            />
            <button type="button" onClick={() => void load()} className="btn-primary h-10 px-4 text-sm">
              Aggiorna
            </button>
          </div>
        )}
      />

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* KPI bar */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-6">
        {[
          { label: "Totale costi", value: totals ? fmt(totals.total_cost) : "-", sub: "carburante + manutenzione", color: "text-slate-900" },
          { label: "Carburante", value: totals ? fmt(totals.fuel_cost) : "-", sub: totals ? `${((totals.fuel_cost / Math.max(totals.total_cost, 1)) * 100).toFixed(0)}% del totale` : "-", color: "text-amber-700" },
          { label: "Manutenzione", value: totals ? fmt(totals.maintenance_cost) : "-", sub: totals ? `${((totals.maintenance_cost / Math.max(totals.total_cost, 1)) * 100).toFixed(0)}% del totale` : "-", color: "text-orange-700" },
          { label: "Costo/km", value: costPerKm != null ? `EUR ${costPerKm.toFixed(3)}` : "-", sub: totals ? `su ${totalsLoggedKm.toLocaleString("it-IT")} km` : "dati insufficienti", color: "text-teal-700" },
          { label: "Consumo medio", value: avgKmPerLiter != null ? `${avgKmPerLiter.toFixed(2)} km/L` : "-", sub: totals ? `calcolato su ${totalsFuelLiters.toFixed(1)} L` : "dati insufficienti", color: "text-sky-700" },
          { label: "Consumo per 100 km", value: avgLitersPer100Km != null ? `${avgLitersPer100Km.toFixed(1)} L/100 km` : "-", sub: totals ? `su ${totalsFuelIntervalKm.toLocaleString("it-IT")} km da rifornimenti` : "dati insufficienti", color: "text-violet-700" },
        ].map((kpi) => (
          <div key={kpi.label} className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{kpi.label}</p>
            <p className={`mt-1 text-2xl font-bold ${kpi.color}`}>
              {loading ? <span className="text-slate-300">...</span> : kpi.value}
            </p>
            <p className="mt-1 text-xs text-slate-500">{kpi.sub}</p>
          </div>
        ))}
      </div>

      {/* Charts + ranking */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,0.7fr)]">
        <SectionCard
          title="Costi per mezzo"
          subtitle={payload ? `${payload.year} - ${payload.period === "monthly" ? "mensile" : "annuale"}` : "Caricamento"}
          actions={(
            <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
              {(["vehicles", "timeline"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setChartType(t)}
                  className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${chartType === t ? "bg-white shadow text-slate-900" : "text-slate-500 hover:text-slate-700"}`}
                >
                  {t === "vehicles" ? "Per mezzo" : "Andamento"}
                </button>
              ))}
            </div>
          )}
        >
          {loading || !payload ? (
            <div className="flex h-72 items-center justify-center text-sm text-slate-400">Caricamento...</div>
          ) : (
            <div className="mt-2 h-72 min-w-0">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart
                  data={chartType === "vehicles" ? vehicleChartData : timelineChartData}
                  margin={{ top: 4, right: 4, left: 4, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="name" stroke="#94a3b8" fontSize={11} tick={{ fill: "#64748b" }} />
                  <YAxis stroke="#94a3b8" fontSize={11} tick={{ fill: "#64748b" }} tickFormatter={(v: number) => `EUR ${v}`} width={65} />
                  <Tooltip
                    contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 12 }}
                    formatter={(value: unknown) => fmt(Number(value))}
                  />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="Carburante" stackId="a" fill="#f59e0b" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="Manutenzione" stackId="a" fill="#0f172a" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </SectionCard>

        <SectionCard title="Classifica costi" subtitle="Top veicoli per spesa totale">
          {loading || !payload ? (
            <div className="space-y-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-14 animate-pulse rounded-xl bg-slate-100" />
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {payload.summary.slice(0, 7).map((row, i) => {
                const pct = (row.total_cost / maxCost) * 100;
                return (
                  <div key={row.vehicle_id}>
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="flex items-center gap-1.5 font-medium text-slate-700 truncate">
                        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[10px] font-bold text-slate-600">
                          {i + 1}
                        </span>
                        {row.label}
                      </span>
                      <span className="shrink-0 font-semibold text-slate-900">{fmt(row.total_cost)}</span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-slate-800 transition-all duration-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </SectionCard>
      </div>

      {/* Detail table */}
      <SectionCard title="Dettaglio completo" subtitle="Tutti i mezzi con costi e percorrenza">
        {loading || !payload ? (
          <p className="text-sm text-slate-400">Caricamento...</p>
        ) : payload.summary.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-400">Nessun dato nel periodo selezionato</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  <th className="pb-3 pr-4">Mezzo</th>
                  <th className="hidden pb-3 pr-4 sm:table-cell">Targa</th>
                  <th className="pb-3 pr-4 text-right">Carburante</th>
                  <th className="pb-3 pr-4 text-right">Manutenzione</th>
                  <th className="pb-3 pr-4 text-right font-bold text-slate-600">Totale</th>
                  <th className="hidden pb-3 pr-4 text-right md:table-cell">Km</th>
                  <th className="hidden pb-3 pr-4 text-right lg:table-cell">Consumo medio</th>
                  <th className="hidden pb-3 pr-4 text-right lg:table-cell">Consumo/100 km</th>
                  <th className="hidden pb-3 text-right md:table-cell">EUR /km</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {payload.summary.map((row) => {
                  const rowFuelIntervalKm = safeNumber(row.fuel_interval_km);
                  const rowFuelLiters = safeNumber(row.fuel_liters);
                  // Usa fuel_interval_km come fallback se non ci sono km_logs manuali
                  const effectiveKm = row.logged_km > 0 ? row.logged_km : rowFuelIntervalKm;
                  const kmFromFuel = row.logged_km === 0 && rowFuelIntervalKm > 0;
                  const cpk = effectiveKm > 0 ? row.total_cost / effectiveKm : null;
                  const averageKmPerLiter = rowFuelIntervalKm > 0 && rowFuelLiters > 0 ? rowFuelIntervalKm / rowFuelLiters : null;
                  const averageLitersPer100Km = rowFuelIntervalKm > 0 && rowFuelLiters > 0 ? (rowFuelLiters / rowFuelIntervalKm) * 100 : null;
                  const isTop = row.total_cost === maxCost;
                  return (
                    <tr key={row.vehicle_id} className={isTop ? "bg-amber-50/60" : "hover:bg-slate-50"}>
                      <td className="py-2.5 pr-4 font-semibold text-slate-800">
                        {row.label}
                        {isTop && <span className="ml-2 inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">TOP</span>}
                      </td>
                      <td className="hidden py-2.5 pr-4 font-mono text-xs text-slate-500 sm:table-cell">{row.plate ?? "-"}</td>
                      <td className="py-2.5 pr-4 text-right text-amber-700">{fmt(row.fuel_cost)}</td>
                      <td className="py-2.5 pr-4 text-right text-orange-700">{fmt(row.maintenance_cost)}</td>
                      <td className="py-2.5 pr-4 text-right font-bold text-slate-900">{fmt(row.total_cost)}</td>
                      <td className="hidden py-2.5 pr-4 text-right text-slate-600 md:table-cell" title={kmFromFuel ? "Km stimati da rifornimenti (nessun log km manuale)" : undefined}>
                        {effectiveKm > 0 ? effectiveKm.toLocaleString("it-IT") : "0"}
                        {kmFromFuel && <span className="ml-1 text-[10px] text-slate-400">~</span>}
                      </td>
                      <td className="hidden py-2.5 pr-4 text-right text-sky-700 lg:table-cell">
                        {averageKmPerLiter != null ? formatKmPerLiter(rowFuelIntervalKm, rowFuelLiters) : "-"}
                      </td>
                      <td className="hidden py-2.5 pr-4 text-right text-violet-700 lg:table-cell">
                        {averageLitersPer100Km != null ? formatLitersPer100Km(rowFuelIntervalKm, rowFuelLiters) : "-"}
                      </td>
                      <td className="hidden py-2.5 text-right text-teal-700 md:table-cell">
                        {cpk != null ? `EUR ${cpk.toFixed(3)}` : "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-200 bg-slate-50">
                  <td className="py-2.5 pr-4 text-xs font-bold uppercase text-slate-500">Totale</td>
                  <td className="hidden py-2.5 sm:table-cell" />
                  <td className="py-2.5 pr-4 text-right font-semibold text-amber-700">{fmt(totals?.fuel_cost ?? 0)}</td>
                  <td className="py-2.5 pr-4 text-right font-semibold text-orange-700">{fmt(totals?.maintenance_cost ?? 0)}</td>
                  <td className="py-2.5 pr-4 text-right text-base font-bold text-slate-900">{fmt(totals?.total_cost ?? 0)}</td>
                  <td className="hidden py-2.5 pr-4 text-right font-semibold text-slate-600 md:table-cell">{totals?.logged_km.toLocaleString("it-IT") ?? "-"}</td>
                  <td className="hidden py-2.5 pr-4 text-right font-semibold text-sky-700 lg:table-cell">
                    {totals ? formatKmPerLiter(totalsFuelIntervalKm, totalsFuelLiters) : "-"}
                  </td>
                  <td className="hidden py-2.5 pr-4 text-right font-semibold text-violet-700 lg:table-cell">
                    {totals ? formatLitersPer100Km(totalsFuelIntervalKm, totalsFuelLiters) : "-"}
                  </td>
                  <td className="hidden py-2.5 text-right font-semibold text-teal-700 md:table-cell">
                    {costPerKm != null ? `EUR ${costPerKm.toFixed(3)}` : "-"}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </SectionCard>
    </section>
  );
}
