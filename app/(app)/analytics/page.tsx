"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { DataTable, DateInput, EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

/* ─── Tipi ─────────────────────────────────────────────── */
type CountItem    = { label: string; count: number };
type DailyTrend   = { date: string; services: number; pax: number; revenue_cents: number };
type AgencyRank   = { agency_id: string; agency_name: string; services: number; pax: number; revenue_cents: number };
type DriverLoad   = { driver_user_id: string; driver_name: string; total_assigned: number; by_day: Record<string, number> };
type PunctRow     = { service_id: string; date: string; time: string; customer_name: string; vessel: string; zone: string; hotel_name?: string | null; actual_at: string | null; delay_minutes: number | null; punctuality: "on_time" | "delayed" | "missing" };
type PunctualityFilter = "all" | PunctRow["punctuality"];

type Payload = {
  dateFrom: string; dateTo: string; punctualityThresholdMinutes: number;
  kpi: {
    totalServices: number; onTime: number; delayed: number; missing: number;
    evaluated: number; punctualityRate: number;
    totalRevenueCents: number; totalMarginCents: number; avgRevenueCents: number;
    totalPax: number; cancellationRate: number; problemaRate: number;
  };
  servicesByVessel: CountItem[]; servicesByZone: CountItem[];
  dailyTrend: DailyTrend[]; agencyRank: AgencyRank[];
  driverWeeklyLoad: DriverLoad[];
  punctualityTable: PunctRow[];
  weeklyWindow: { from: string; to: string };
};

/* ─── Helpers ───────────────────────────────────────────── */
const COLORS = ["#0f766e","#2563eb","#16a34a","#ca8a04","#7c3aed","#e11d48","#0891b2","#475569"];

function fmt(cents: number) {
  return (cents / 100).toLocaleString("it-IT", { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + " €";
}
function fmtInt(value: number) {
  return value.toLocaleString("it-IT");
}
function fmtDate(iso: string) {
  const [,m,d] = iso.split("-");
  return `${d}/${m}`;
}
function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function isoDate(d: Date) { return d.toISOString().slice(0, 10); }
function defaultRange() {
  const today = new Date();
  return { from: isoDate(addDays(today, -29)), to: isoDate(today) };
}

/* ─── Tooltip custom ─────────────────────────────────────── */
function RevenueTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number; name: string }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-lg text-xs">
      <p className="font-semibold text-slate-700 mb-1">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="text-slate-500">
          {p.name === "revenue_cents" ? `Revenue: ${fmt(p.value)}` : `${p.name}: ${p.value}`}
        </p>
      ))}
    </div>
  );
}

function qualityTone(value: number) {
  if (value >= 90) return "text-emerald-700 bg-emerald-50 border-emerald-200";
  if (value >= 70) return "text-amber-700 bg-amber-50 border-amber-200";
  return "text-rose-700 bg-rose-50 border-rose-200";
}

function punctualityBadge(value: PunctRow["punctuality"]) {
  if (value === "on_time") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (value === "delayed") return "border-rose-200 bg-rose-50 text-rose-700";
  return "border-blue-200 bg-blue-50 text-blue-700";
}

function MetricTile({
  label,
  value,
  detail,
  tone = "slate",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "slate" | "emerald" | "blue" | "amber" | "rose";
}) {
  const tones = {
    slate: "border-slate-200 bg-white text-slate-900",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-900",
    blue: "border-blue-200 bg-blue-50 text-blue-900",
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    rose: "border-rose-200 bg-rose-50 text-rose-900",
  };

  return (
    <div className={`rounded-lg border px-4 py-3 ${tones[tone]}`}>
      <p className="text-[11px] font-bold uppercase tracking-[0.14em] opacity-70">{label}</p>
      <p className="mt-2 text-2xl font-black leading-none">{value}</p>
      <p className="mt-2 text-xs opacity-70">{detail}</p>
    </div>
  );
}

/* ─── Pagina ─────────────────────────────────────────────── */
export default function AnalyticsPage() {
  const range = useMemo(() => defaultRange(), []);
  const [dateFrom, setDateFrom] = useState(range.from);
  const [dateTo, setDateTo]     = useState(range.to);
  const [loading, setLoading]   = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [data, setData]         = useState<Payload | null>(null);
  const [punctualityFilter, setPunctualityFilter] = useState<PunctualityFilter>("all");

  const loadAnalytics = async () => {
    if (!hasSupabaseEnv || !supabase) { setError("Supabase non configurato."); return; }
    if (!dateFrom || !dateTo || dateFrom > dateTo) { setError("Intervallo date non valido."); return; }
    setLoading(true); setError(null);
    try {
      const { data: s } = await supabase.auth.getSession();
      if (!s.session?.access_token) { setError("Sessione non valida."); return; }
      const res = await fetch(`/api/analytics/summary?dateFrom=${dateFrom}&dateTo=${dateTo}`, {
        headers: { Authorization: `Bearer ${s.session.access_token}` },
      });
      if (!res.ok) { setError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Errore caricamento."); return; }
      setData((await res.json()) as Payload);
    } catch { setError("Errore rete."); }
    finally { setLoading(false); }
  };

  const exportExcel = async () => {
    if (!hasSupabaseEnv || !supabase) return;
    setExporting(true);
    try {
      const { data: s } = await supabase.auth.getSession();
      if (!s.session?.access_token) return;
      const res = await fetch("/api/exports/analytics.xlsx", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.session.access_token}` },
        body: JSON.stringify({ dateFrom, dateTo }),
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const match = res.headers.get("content-disposition")?.match(/filename="?([^"]+)"?/i);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = match?.[1] ?? `analytics_${dateFrom}_${dateTo}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } finally { setExporting(false); }
  };

  useEffect(() => { void loadAnalytics(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const trendData = useMemo(() =>
    (data?.dailyTrend ?? []).map((d) => ({ ...d, label: fmtDate(d.date) })),
    [data]
  );
  const insights = useMemo(() => {
    if (!data) return null;
    const busiestDay = [...data.dailyTrend].sort((a, b) => b.services - a.services)[0] ?? null;
    const bestAgency = data.agencyRank[0] ?? null;
    const busiestDriver = data.driverWeeklyLoad[0] ?? null;
    const missingShare = data.kpi.totalServices > 0 ? Math.round((data.kpi.missing / data.kpi.totalServices) * 100) : 0;
    const marginPct = data.kpi.totalRevenueCents > 0 ? Math.round((data.kpi.totalMarginCents / data.kpi.totalRevenueCents) * 100) : 0;
    const issueRate = Math.max(data.kpi.problemaRate, data.kpi.cancellationRate);
    return { busiestDay, bestAgency, busiestDriver, missingShare, marginPct, issueRate };
  }, [data]);
  const filteredPunctuality = useMemo(() => {
    const rows = data?.punctualityTable ?? [];
    return punctualityFilter === "all" ? rows : rows.filter((row) => row.punctuality === punctualityFilter);
  }, [data, punctualityFilter]);

  return (
    <section className="page-section">
      <PageHeader
        title="Analytics"
        subtitle="KPI operativi, finanziari e di qualità nel periodo selezionato."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Analytics" }]}
      />

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:p-5">
        <div className="grid gap-4 xl:grid-cols-[1fr_auto]">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400">Cruscotto periodo</p>
            <h2 className="mt-1 text-xl font-bold text-slate-950">
              {data ? `${data.dateFrom} - ${data.dateTo}` : "Seleziona periodo"}
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              {error ? error : data ? `${fmtInt(data.kpi.totalServices)} servizi, ${fmtInt(data.kpi.totalPax)} pax, ${fmt(data.kpi.totalRevenueCents)} di revenue.` : "Carica il periodo per vedere operativita, revenue e puntualita."}
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs font-medium text-slate-500">
              Dal
              <DateInput className="input-saas mt-1 w-40" value={dateFrom} onChange={(iso) => setDateFrom(iso)} />
            </label>
            <label className="text-xs font-medium text-slate-500">
              Al
              <DateInput className="input-saas mt-1 w-40" value={dateTo} onChange={(iso) => setDateTo(iso)} />
            </label>
            <button type="button" onClick={() => void loadAnalytics()} disabled={loading} className="btn-primary h-10 px-4 text-sm disabled:opacity-50">
              {loading ? "Caricamento..." : "Aggiorna"}
            </button>
            <button type="button" onClick={() => void exportExcel()} disabled={exporting || !data} className="btn-secondary h-10 px-4 text-sm disabled:opacity-50">
              {exporting ? "Esportazione..." : "Excel"}
            </button>
          </div>
        </div>
      </section>

      {!data && !loading ? <EmptyState title="Nessun dato disponibile." compact /> : null}

      {data ? (
        <>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(340px,0.85fr)]">
            <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold text-slate-950">Quadro operativo</h2>
                  <p className="text-sm text-slate-500">Volumi, revenue e qualita del periodo.</p>
                </div>
                <span className={`rounded-full border px-3 py-1 text-xs font-bold ${qualityTone(data.kpi.punctualityRate)}`}>
                  Puntualita {data.kpi.punctualityRate}%
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <MetricTile label="Servizi" value={fmtInt(data.kpi.totalServices)} detail={`${fmtInt(data.kpi.totalPax)} pax`} tone="blue" />
                <MetricTile label="Revenue" value={fmt(data.kpi.totalRevenueCents)} detail={`Media ${fmt(data.kpi.avgRevenueCents)}`} tone="slate" />
                <MetricTile label="Margine" value={fmt(data.kpi.totalMarginCents)} detail={`${insights?.marginPct ?? 0}% sul fatturato`} tone="emerald" />
                <MetricTile label="Alert" value={`${data.kpi.missing}`} detail={`${insights?.missingShare ?? 0}% senza evento`} tone={data.kpi.missing > 0 ? "rose" : "slate"} />
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-3">
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
                  <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">Giorno piu carico</p>
                  <p className="mt-2 text-xl font-black text-slate-950">{insights?.busiestDay ? fmtDate(insights.busiestDay.date) : "-"}</p>
                  <p className="mt-1 text-xs text-slate-500">{insights?.busiestDay ? `${insights.busiestDay.services} servizi · ${insights.busiestDay.pax} pax` : "Nessun dato"}</p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
                  <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">Prima agenzia</p>
                  <p className="mt-2 line-clamp-2 min-h-10 break-words text-base font-black leading-5 text-slate-950" title={insights?.bestAgency?.agency_name ?? ""}>
                    {insights?.bestAgency?.agency_name ?? "-"}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">{insights?.bestAgency ? `${fmt(insights.bestAgency.revenue_cents)} · ${insights.bestAgency.services} servizi` : "Nessun dato"}</p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
                  <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">Qualita</p>
                  <p className="mt-2 text-xl font-black text-slate-950">{insights?.issueRate ?? 0}%</p>
                  <p className="mt-1 text-xs text-slate-500">Problemi {data.kpi.problemaRate}% · cancellati {data.kpi.cancellationRate}%</p>
                </div>
              </div>
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-4">
                <h2 className="text-base font-bold text-slate-950">Driver settimana</h2>
                <p className="text-sm text-slate-500">{data.weeklyWindow.from} - {data.weeklyWindow.to}</p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">Autista piu carico</p>
                <p className="mt-2 truncate text-2xl font-black text-slate-950">{insights?.busiestDriver?.driver_name ?? "-"}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {insights?.busiestDriver ? `${insights.busiestDriver.total_assigned} assegnazioni` : "Nessuna assegnazione"}
                </p>
              </div>
              <div className="mt-3 grid grid-cols-7 gap-1">
                {(["lun","mar","mer","gio","ven","sab","dom"] as const).map((day) => {
                  const value = insights?.busiestDriver?.by_day[day] ?? 0;
                  return (
                    <div key={day} className="rounded-lg border border-slate-200 bg-white px-1 py-2 text-center">
                      <p className="text-[10px] font-bold uppercase text-slate-400">{day}</p>
                      <p className="mt-1 text-sm font-black text-slate-900">{value}</p>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>

          {/* ── TREND GIORNALIERO ── */}
          <SectionCard title="Trend giornaliero" subtitle="Servizi, pax e revenue nel periodo.">
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={trendData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="gradRev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#1e3a5f" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#1e3a5f" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradSvc" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#0e7490" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#0e7490" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis yAxisId="svc" orientation="left"  tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={28} />
                <YAxis yAxisId="rev" orientation="right" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={20} hide />
                <Tooltip content={<RevenueTooltip />} />
                <Area yAxisId="svc" type="monotone" dataKey="services"      stroke="#0e7490" strokeWidth={2} fill="url(#gradSvc)" name="Servizi" dot={false} />
                <Area yAxisId="rev" type="monotone" dataKey="revenue_cents" stroke="#1e3a5f" strokeWidth={2} fill="url(#gradRev)" name="revenue_cents" dot={false} />
                <Legend formatter={(v) => v === "revenue_cents" ? "Revenue" : "Servizi"} iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              </AreaChart>
            </ResponsiveContainer>
          </SectionCard>

          {/* ── DISTRIBUZIONE + AGENZIE ── */}
          <div className="grid gap-4 lg:grid-cols-3">

            {/* Per nave */}
            <SectionCard title="Servizi per nave">
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={data.servicesByVessel.slice(0, 8)} dataKey="count" nameKey="label" cx="50%" cy="50%" outerRadius={80} innerRadius={40} paddingAngle={2}>
                    {data.servicesByVessel.slice(0, 8).map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v) => [`${v} servizi`]} />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            </SectionCard>

            {/* Per zona */}
            <SectionCard title="Servizi per zona">
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data.servicesByZone.slice(0, 7)} layout="vertical" margin={{ left: 4, right: 16 }}>
                  <XAxis type="number" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={80} />
                  <Tooltip formatter={(v) => [`${v} servizi`]} />
                  <Bar dataKey="count" radius={[0, 6, 6, 0]}>
                    {data.servicesByZone.slice(0, 7).map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </SectionCard>

            {/* Top agenzie revenue */}
            <SectionCard title="Top agenzie per revenue">
              {data.agencyRank.length === 0 ? (
                <p className="text-xs text-muted">Nessuna agenzia nel periodo.</p>
              ) : (
                <div className="space-y-3">
                  {data.agencyRank.slice(0, 6).map((ag, i) => {
                    const max = data.agencyRank[0]?.revenue_cents ?? 1;
                    const pct = Math.max(6, Math.round((ag.revenue_cents / max) * 100));
                    return (
                      <div key={ag.agency_id} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium text-text truncate max-w-[140px]">{ag.agency_name}</span>
                          <span className="text-muted shrink-0 ml-2">{fmt(ag.revenue_cents)}</span>
                        </div>
                        <div className="h-2 rounded-full bg-slate-100">
                          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: COLORS[i % COLORS.length] }} />
                        </div>
                        <p className="text-[10px] text-muted">{ag.services} servizi · {ag.pax} pax</p>
                      </div>
                    );
                  })}
                </div>
              )}
            </SectionCard>
          </div>

          {/* ── CARICO DRIVER ── */}
          <SectionCard
            title="Carico driver settimanale"
            subtitle={`Settimana: ${data.weeklyWindow.from} → ${data.weeklyWindow.to}`}
            className="space-y-0"
          >
            <DataTable minWidthClassName="min-w-full" loading={loading} loadingRows={5}>
              <thead className="text-muted">
                <tr>
                  {["Autista","Tot","Lun","Mar","Mer","Gio","Ven","Sab","Dom"].map((h) => (
                    <th key={h} className="px-2 py-2 text-left text-xs font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.driverWeeklyLoad.map((d) => (
                  <tr key={d.driver_user_id} className="border-t border-border/70">
                    <td className="px-2 py-2 font-medium text-sm">{d.driver_name}</td>
                    <td className="px-2 py-2 font-bold text-sm">{d.total_assigned}</td>
                    {(["lun","mar","mer","gio","ven","sab","dom"] as const).map((day) => (
                      <td key={day} className="px-2 py-2 text-sm text-center">
                        {d.by_day[day] > 0 ? (
                          <span className="inline-block w-6 h-6 rounded-full bg-slate-900 text-white text-xs leading-6 text-center">{d.by_day[day]}</span>
                        ) : (
                          <span className="text-slate-300">–</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
                {data.driverWeeklyLoad.length === 0 && (
                  <tr><td colSpan={9} className="px-2 py-3 text-muted text-sm">Nessuna assegnazione nella settimana.</td></tr>
                )}
              </tbody>
            </DataTable>
          </SectionCard>

          {/* ── PUNTUALITÀ ── */}
          <SectionCard
            title="Puntualità servizi"
            subtitle={`${filteredPunctuality.length} righe visibili su ${data.punctualityTable.length}`}
            className="space-y-0"
            actions={
              <div className="flex flex-wrap gap-1">
                {[
                  { key: "all", label: "Tutti" },
                  { key: "missing", label: "Mancanti" },
                  { key: "delayed", label: "Ritardi" },
                  { key: "on_time", label: "Puntuali" },
                ].map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setPunctualityFilter(item.key as PunctualityFilter)}
                    className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${punctualityFilter === item.key ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-400"}`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            }
          >
            <DataTable minWidthClassName="min-w-full" loading={loading} loadingRows={6}>
              <thead className="text-muted">
                <tr>
                  {["Data/Ora","Cliente","Nave","Hotel / zona","Effettivo","Delta","Esito"].map((h) => (
                    <th key={h} className="px-2 py-2 text-left text-xs font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredPunctuality.slice(0, 120).map((row) => (
                  <tr key={row.service_id} className="border-t border-border/70 hover:bg-slate-50">
                    <td className="px-2 py-2 text-sm whitespace-nowrap">{fmtDate(row.date)} {row.time}</td>
                    <td className="px-2 py-2 text-sm">
                      <span className="block max-w-[180px] truncate font-medium text-slate-800">{row.customer_name}</span>
                    </td>
                    <td className="px-2 py-2 text-sm max-w-[160px] truncate">{row.vessel}</td>
                    <td className="px-2 py-2 text-sm">
                      <span className="block max-w-[180px] truncate text-slate-800">{row.hotel_name ?? "N/D"}</span>
                      <span className="block text-xs text-slate-400">{row.zone}</span>
                    </td>
                    <td className="px-2 py-2 text-sm whitespace-nowrap">{row.actual_at ? new Date(row.actual_at).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" }) : "-"}</td>
                    <td className="px-2 py-2 text-sm">{row.delay_minutes != null ? `${row.delay_minutes} min` : "-"}</td>
                    <td className="px-2 py-2">
                      <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-bold ${punctualityBadge(row.punctuality)}`}>
                        {row.punctuality === "on_time" ? "Puntuale" : row.punctuality === "delayed" ? "Ritardo" : "Mancante"}
                      </span>
                    </td>
                  </tr>
                ))}
                {filteredPunctuality.length === 0 && (
                  <tr><td colSpan={7} className="px-2 py-3 text-muted text-sm">Nessun servizio nel periodo.</td></tr>
                )}
              </tbody>
            </DataTable>
          </SectionCard>
        </>
      ) : null}
    </section>
  );
}
