"use client";

import { useEffect, useState, useCallback } from "react";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  LineChart, Line, ResponsiveContainer, PieChart, Pie, Cell,
} from "recharts";

// ---------------------------------------------------------------------------
// Tipi
// ---------------------------------------------------------------------------
type MonthRow  = { month: string; label: string; services: number; revenueCents: number; costCents: number; marginCents: number };
type AgencyRow = { agencyId: string; name: string; services: number; revenueCents: number; costCents: number; marginCents: number };
type KindRow   = { kind: string; services: number; revenueCents: number; marginCents: number };
type Ytd       = { services: number; revenueCents: number; costCents: number; marginCents: number };

type MarginData = {
  year: number;
  availableYears: number[];
  ytd: Ytd;
  byMonth: MonthRow[];
  byAgency: AgencyRow[];
  byKind: KindRow[];
  totalRows: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function eur(cents: number) {
  return (cents / 100).toLocaleString("it-IT", { style: "currency", currency: "EUR" });
}
function pct(margin: number, revenue: number) {
  if (!revenue) return "—";
  return ((margin / revenue) * 100).toFixed(1) + "%";
}
function kindLabel(key: string) {
  const MAP: Record<string, string> = {
    transfer_port_hotel: "Transfer Porto",
    transfer_airport_hotel: "Transfer Aeroporto",
    transfer_airport_hotel_exclusive: "Aeroporto Esclusivo",
    transfer_train_hotel: "Transfer Stazione",
    transfer_train_hotel_exclusive: "Stazione Esclusivo",
    bus_city_hotel: "Bus da città",
    excursion: "Escursione",
    formula_snav: "Formula SNAV",
    formula_medmar_napoli: "Formula MEDMAR Napoli",
    formula_medmar_pozzuoli: "Formula MEDMAR Pozzuoli",
  };
  if (key in MAP) return MAP[key];
  if (key.startsWith("excursion_")) return key.replace("excursion_", "").replace(/_/g, " ");
  return key.replace(/_/g, " ");
}

const CHART_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#f97316", "#84cc16"];

// ---------------------------------------------------------------------------
// KPI Card
// ---------------------------------------------------------------------------
function KpiBox({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: "green" | "red" | "blue" }) {
  const colorClass = highlight === "green" ? "text-emerald-700" : highlight === "red" ? "text-rose-700" : highlight === "blue" ? "text-sky-700" : "text-slate-900";
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-2 text-2xl font-bold ${colorClass}`}>{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-slate-400">{sub}</p> : null}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Pagina
// ---------------------------------------------------------------------------
export default function AgencyMarginsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [data, setData]       = useState<MarginData | null>(null);
  const [year, setYear]       = useState(new Date().getFullYear());
  const [token, setToken]     = useState<string | null>(null);

  const load = useCallback(async (tk: string, yr: number) => {
    setLoading(true);
    const res = await fetch(`/api/agency/margins?year=${yr}`, { headers: { Authorization: `Bearer ${tk}` } });
    const body = await res.json().catch(() => null) as MarginData | { error: string } | null;
    if (!res.ok || !body || "error" in body) {
      setError((body as { error: string } | null)?.error ?? "Errore caricamento margini.");
      setLoading(false);
      return;
    }
    setData(body);
    setLoading(false);
  }, []);

  useEffect(() => {
    let active = true;
    const boot = async () => {
      const session = await getClientSessionContext();
      if (!active) return;
      if (!hasSupabaseEnv || !supabase) { setError("Supabase non configurato."); setLoading(false); return; }
      if (session.role !== "admin") { setError("Sezione riservata agli amministratori."); setLoading(false); return; }
      const { data: sd } = await supabase.auth.getSession();
      const tk = sd.session?.access_token ?? null;
      if (!tk) { setError("Sessione non valida."); setLoading(false); return; }
      setToken(tk);
      await load(tk, year);
    };
    void boot();
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeYear = (yr: number) => {
    setYear(yr);
    if (token) void load(token, yr);
  };

  // ---------------------------------------------------------------------------
  // Dati grafici
  // ---------------------------------------------------------------------------
  const monthChartData = (data?.byMonth ?? []).map((m) => ({
    name: m.label,
    Ricavi: +(m.revenueCents / 100).toFixed(2),
    Costi:  +(m.costCents  / 100).toFixed(2),
    Margine: +(m.marginCents / 100).toFixed(2),
  }));

  const agencyPieData = (data?.byAgency ?? [])
    .filter((a) => a.revenueCents > 0)
    .slice(0, 8)
    .map((a) => ({ name: a.name, value: +(a.revenueCents / 100).toFixed(2) }));

  const kindChartData = (data?.byKind ?? [])
    .slice(0, 8)
    .map((k) => ({
      name: kindLabel(k.kind),
      Ricavi:  +(k.revenueCents / 100).toFixed(2),
      Margine: +(k.marginCents  / 100).toFixed(2),
    }));

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  if (error) return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-rose-700">{error}</div>
    </div>
  );

  const ytd = data?.ytd;
  const marginPctYtd = ytd ? pct(ytd.marginCents, ytd.revenueCents) : "—";
  const availableYears = data?.availableYears ?? [year];

  return (
    <section className="mx-auto max-w-6xl space-y-6 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Margini</h1>
          <p className="mt-0.5 text-sm text-slate-500">Sezione riservata — solo admin. Ricavi, costi e margini per anno.</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs font-semibold text-slate-500">Anno</label>
          <select
            className="input-saas"
            value={year}
            onChange={(e) => changeYear(Number(e.target.value))}
          >
            {availableYears.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          {loading ? <span className="text-xs text-slate-400">Caricamento...</span> : null}
        </div>
      </div>

      {/* KPI YTD */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiBox label="Servizi fatturati" value={String(ytd?.services ?? 0)} sub={`Anno ${year}`} highlight="blue" />
        <KpiBox label="Ricavi totali" value={eur(ytd?.revenueCents ?? 0)} sub="Prezzo agenzia" />
        <KpiBox label="Costi totali" value={eur(ytd?.costCents ?? 0)} sub="Costo operatore" />
        <KpiBox
          label="Margine YTD"
          value={eur(ytd?.marginCents ?? 0)}
          sub={`${marginPctYtd} sul fatturato`}
          highlight={(ytd?.marginCents ?? 0) >= 0 ? "green" : "red"}
        />
      </div>

      {/* Grafico andamento mensile */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="mb-4 text-sm font-semibold text-slate-700">Andamento mensile {year}</h2>
        {monthChartData.some((m) => m.Ricavi > 0) ? (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={monthChartData} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `€${v}`} />
              <Tooltip formatter={(value) => [`€${Number(value).toLocaleString("it-IT")}`, ""]} />
              <Legend />
              <Bar dataKey="Ricavi"  fill="#3b82f6" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Costi"   fill="#f59e0b" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Margine" fill="#10b981" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-40 items-center justify-center text-sm text-slate-400">
            Nessun dato per il {year}. I dati appariranno quando ci saranno prenotazioni con listino configurato.
          </div>
        )}
      </div>

      {/* Grafico linea margine */}
      {monthChartData.some((m) => m.Margine !== 0) ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <h2 className="mb-4 text-sm font-semibold text-slate-700">Curva margine mensile</h2>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={monthChartData} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `€${v}`} />
              <Tooltip formatter={(value) => [`€${Number(value).toLocaleString("it-IT")}`, ""]} />
              <Line type="monotone" dataKey="Margine" stroke="#10b981" strokeWidth={2} dot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : null}

      {/* Per agenzia + Pie */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Margine per agenzia</h2>
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs font-semibold text-slate-500">
                  <th className="pb-2 pr-3">Agenzia</th>
                  <th className="pb-2 pr-3 text-right">Servizi</th>
                  <th className="pb-2 pr-3 text-right">Ricavi</th>
                  <th className="pb-2 pr-3 text-right">Costi</th>
                  <th className="pb-2 text-right">Margine</th>
                </tr>
              </thead>
              <tbody>
                {(data?.byAgency ?? []).length === 0 ? (
                  <tr><td colSpan={5} className="py-6 text-center text-slate-400 text-xs">Nessun dato disponibile.</td></tr>
                ) : (data?.byAgency ?? []).map((a) => (
                  <tr key={a.agencyId} className="border-b border-slate-50">
                    <td className="py-2 pr-3 font-medium">{a.name}</td>
                    <td className="py-2 pr-3 text-right text-slate-500">{a.services}</td>
                    <td className="py-2 pr-3 text-right">{eur(a.revenueCents)}</td>
                    <td className="py-2 pr-3 text-right text-slate-500">{a.costCents > 0 ? eur(a.costCents) : "—"}</td>
                    <td className={`py-2 text-right font-semibold ${a.marginCents >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                      {a.costCents > 0 ? eur(a.marginCents) : "—"}
                      {a.costCents > 0 ? <span className="ml-1 text-xs font-normal text-slate-400">({pct(a.marginCents, a.revenueCents)})</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Pie ricavi per agenzia */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Distribuzione ricavi per agenzia</h2>
          {agencyPieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={agencyPieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label={({ name, percent }) => `${name ?? ""} ${((Number(percent) || 0) * 100).toFixed(0)}%`} labelLine={false}>
                  {agencyPieData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(value) => [`€${Number(value).toLocaleString("it-IT")}`, ""]} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-40 items-center justify-center text-sm text-slate-400">Nessun dato.</div>
          )}
        </div>
      </div>

      {/* Per tipo servizio */}
      {kindChartData.length > 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <h2 className="mb-4 text-sm font-semibold text-slate-700">Ricavi e margine per tipo servizio</h2>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={kindChartData} layout="vertical" margin={{ top: 4, right: 24, left: 120, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v: number) => `€${v}`} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={115} />
              <Tooltip formatter={(value) => [`€${Number(value).toLocaleString("it-IT")}`, ""]} />
              <Legend />
              <Bar dataKey="Ricavi"  fill="#3b82f6" radius={[0, 4, 4, 0]} />
              <Bar dataKey="Margine" fill="#10b981" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : null}

      <p className="text-xs text-slate-400">
        I margini vengono calcolati solo per i servizi con listino configurato (prezzo agenzia + costo operatore). Servizi senza costo operatore mostrano &quot;—&quot; nella colonna margine.
      </p>
    </section>
  );
}
