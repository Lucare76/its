"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { KpiCard } from "@/components/kpi-card";
import { DataTable, EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

/* ─── Tipi ─────────────────────────────────────────────── */
type CountItem    = { label: string; count: number };
type DailyTrend   = { date: string; services: number; pax: number; revenue_cents: number };
type AgencyRank   = { agency_id: string; agency_name: string; services: number; pax: number; revenue_cents: number };
type DriverLoad   = { driver_user_id: string; driver_name: string; total_assigned: number; by_day: Record<string, number> };
type PunctRow     = { service_id: string; date: string; time: string; customer_name: string; vessel: string; zone: string; actual_at: string | null; delay_minutes: number | null; punctuality: "on_time" | "delayed" | "missing" };

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
const COLORS = ["#1e3a5f","#0e7490","#166534","#854d0e","#7c3aed","#be123c","#0369a1","#065f46"];

function fmt(cents: number) {
  return (cents / 100).toLocaleString("it-IT", { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + " €";
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

/* ─── Pagina ─────────────────────────────────────────────── */
export default function AnalyticsPage() {
  const range = useMemo(() => defaultRange(), []);
  const [dateFrom, setDateFrom] = useState(range.from);
  const [dateTo, setDateTo]     = useState(range.to);
  const [loading, setLoading]   = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [data, setData]         = useState<Payload | null>(null);

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

  return (
    <section className="page-section">
      <PageHeader
        title="Analytics"
        subtitle="KPI operativi, finanziari e di qualità nel periodo selezionato."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Analytics" }]}
      />

      {/* Toolbar */}
      <header className="toolbar">
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted">
            Dal
            <input type="date" className="input-saas mt-1 w-full min-w-[150px]" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </label>
          <label className="text-xs text-muted">
            Al
            <input type="date" className="input-saas mt-1 w-full min-w-[150px]" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </label>
          <button type="button" onClick={() => void loadAnalytics()} disabled={loading} className="btn-primary h-[42px] px-4 text-sm disabled:opacity-50">
            {loading ? "Caricamento…" : "Aggiorna"}
          </button>
          <button type="button" onClick={() => void exportExcel()} disabled={exporting} className="btn-secondary h-[42px] px-4 text-sm disabled:opacity-50">
            {exporting ? "Esportazione…" : "Esporta Excel"}
          </button>
        </div>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </header>

      {!data && !loading ? <EmptyState title="Nessun dato disponibile." compact /> : null}

      {data ? (
        <>
          {/* ── KPI OPERATIVI ─── */}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Servizi periodo"  value={String(data.kpi.totalServices)} hint={`${data.dateFrom} → ${data.dateTo}`} loading={loading} />
            <KpiCard label="PAX totali"       value={String(data.kpi.totalPax)}       hint="Passeggeri nel periodo" loading={loading} />
            <KpiCard label="Puntualità"       value={`${data.kpi.punctualityRate}%`}  hint={`Soglia ${data.punctualityThresholdMinutes} min`} loading={loading} />
            <KpiCard label="On time"          value={String(data.kpi.onTime)}          hint={`Ritardo: ${data.kpi.delayed} | Mancanti: ${data.kpi.missing}`} loading={loading} />
          </div>

          {/* ── KPI FINANZIARI ── */}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <article className="card p-4">
              <p className="text-xs uppercase tracking-widest text-muted">Revenue totale</p>
              <p className="mt-2 text-3xl font-bold text-text">{fmt(data.kpi.totalRevenueCents)}</p>
              <p className="mt-1 text-xs text-muted">Periodo selezionato</p>
            </article>
            <article className="card p-4">
              <p className="text-xs uppercase tracking-widest text-muted">Margine totale</p>
              <p className="mt-2 text-3xl font-bold text-emerald-600">{fmt(data.kpi.totalMarginCents)}</p>
              <p className="mt-1 text-xs text-muted">
                {data.kpi.totalRevenueCents > 0
                  ? `${Math.round((data.kpi.totalMarginCents / data.kpi.totalRevenueCents) * 100)}% sul fatturato`
                  : "Nessun fatturato"}
              </p>
            </article>
            <article className="card p-4">
              <p className="text-xs uppercase tracking-widest text-muted">ARPU (avg per servizio)</p>
              <p className="mt-2 text-3xl font-bold text-text">{fmt(data.kpi.avgRevenueCents)}</p>
              <p className="mt-1 text-xs text-muted">Ricavo medio per corsa</p>
            </article>
            <article className="card p-4">
              <p className="text-xs uppercase tracking-widest text-muted">Qualità servizio</p>
              <div className="mt-2 flex gap-4">
                <div>
                  <p className="text-2xl font-bold text-rose-500">{data.kpi.problemaRate}%</p>
                  <p className="text-xs text-muted">Problemi</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-slate-400">{data.kpi.cancellationRate}%</p>
                  <p className="text-xs text-muted">Cancellati</p>
                </div>
              </div>
            </article>
          </div>

          {/* ── TREND GIORNALIERO ── */}
          <SectionCard title="Trend servizi e revenue (giornaliero)">
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
          <SectionCard title="Tabella puntualità servizi" className="space-y-0">
            <DataTable minWidthClassName="min-w-full" loading={loading} loadingRows={6}>
              <thead className="text-muted">
                <tr>
                  {["Data/Ora","Cliente","Nave","Zona","Effettivo","Δ min","Esito"].map((h) => (
                    <th key={h} className="px-2 py-2 text-left text-xs font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.punctualityTable.slice(0, 120).map((row) => (
                  <tr key={row.service_id} className="border-t border-border/70">
                    <td className="px-2 py-2 text-sm">{row.date} {row.time}</td>
                    <td className="px-2 py-2 text-sm">{row.customer_name}</td>
                    <td className="px-2 py-2 text-sm">{row.vessel}</td>
                    <td className="px-2 py-2 text-sm">{row.zone}</td>
                    <td className="px-2 py-2 text-sm">{row.actual_at ? new Date(row.actual_at).toLocaleString("it-IT") : "–"}</td>
                    <td className="px-2 py-2 text-sm">{row.delay_minutes ?? "–"}</td>
                    <td className="px-2 py-2">
                      <span className={`status-badge ${
                        row.punctuality === "on_time" ? "status-badge-completato"
                        : row.punctuality === "delayed" ? "status-badge-cancelled"
                        : "status-badge-assigned"
                      }`}>
                        {row.punctuality === "on_time" ? "Puntuale" : row.punctuality === "delayed" ? "Ritardo" : "Mancante"}
                      </span>
                    </td>
                  </tr>
                ))}
                {data.punctualityTable.length === 0 && (
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
