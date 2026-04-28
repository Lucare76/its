"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
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
};

type Payload = {
  ok: true;
  period: "monthly" | "yearly";
  year: string;
  summary: SummaryRow[];
  timeline: TimelineRow[];
  totals: { maintenance_cost: number; fuel_cost: number; total_cost: number; logged_km: number };
};

async function accessToken() {
  if (!hasSupabaseEnv || !supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export default function FleetReportsPage() {
  const [period, setPeriod] = useState<"monthly" | "yearly">("monthly");
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const token = await accessToken();
    if (!token) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const res = await fetch(`/api/ops/fleet-cost-reports?period=${period}&year=${year}`, { headers: { Authorization: `Bearer ${token}` } });
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
    const timeout = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const chartData = useMemo(() => {
    const topRows = (payload?.summary ?? []).slice(0, 8);
    return topRows.map((row) => ({
      name: row.label.length > 12 ? `${row.label.slice(0, 12)}…` : row.label,
      costi: Number(row.total_cost.toFixed(2)),
      km: row.logged_km,
    }));
  }, [payload]);

  return (
    <section className="page-section">
      <PageHeader
        title="Report veicoli"
        subtitle="Quadro mensile o annuale su costi carburante, costi manutenzione e km registrati per mezzo."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Flotta", href: "/fleet-ops" }, { label: "Report veicoli" }]}
        actions={(
          <div className="flex flex-wrap gap-2">
            <select className="input-saas h-10 min-w-[140px]" value={period} onChange={(event) => setPeriod(event.target.value as "monthly" | "yearly")}>
              <option value="monthly">Mensile</option>
              <option value="yearly">Annuale</option>
            </select>
            <input className="input-saas h-10 w-28" value={year} onChange={(event) => setYear(event.target.value)} />
            <button type="button" onClick={() => void load()} className="btn-primary h-10 px-4 text-sm">Aggiorna</button>
          </div>
        )}
      />

      {error ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div> : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <SectionCard title="Sintesi economica" subtitle={payload ? `${payload.year} · ${payload.period === "monthly" ? "vista mensile" : "vista annuale"}` : "Caricamento"}>
          {loading || !payload ? (
            <p className="text-sm text-slate-400">Caricamento...</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">Carburante</p>
                  <p className="mt-1 text-2xl font-bold text-slate-900">€{payload.totals.fuel_cost.toFixed(2)}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">Manutenzione</p>
                  <p className="mt-1 text-2xl font-bold text-slate-900">€{payload.totals.maintenance_cost.toFixed(2)}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">Km registrati</p>
                  <p className="mt-1 text-2xl font-bold text-slate-900">{payload.totals.logged_km.toLocaleString("it-IT")}</p>
                </div>
              </div>

              <div className="mt-5 h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="name" stroke="#64748b" fontSize={11} />
                    <YAxis yAxisId="left" stroke="#64748b" fontSize={11} />
                    <YAxis yAxisId="right" orientation="right" stroke="#0f766e" fontSize={11} />
                    <Tooltip />
                    <Bar yAxisId="left" dataKey="costi" fill="#0f172a" radius={[6, 6, 0, 0]} />
                    <Bar yAxisId="right" dataKey="km" fill="#0f766e" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </SectionCard>

        <SectionCard title="Lettura rapida" subtitle="Veicoli con peso economico maggiore nel periodo selezionato.">
          {loading || !payload ? (
            <p className="text-sm text-slate-400">Caricamento...</p>
          ) : (
            <div className="space-y-3">
              {payload.summary.slice(0, 6).map((row) => (
                <div key={row.vehicle_id} className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{row.label}</p>
                      <p className="mt-1 text-xs text-slate-500">{row.plate ?? "Targa n/d"}{row.license_number ? ` · Licenza ${row.license_number}` : ""}</p>
                    </div>
                    <p className="text-sm font-bold text-slate-900">€{row.total_cost.toFixed(2)}</p>
                  </div>
                  <div className="mt-3 grid gap-2 sm:grid-cols-3">
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-slate-400">Fuel</p>
                      <p className="text-sm font-semibold text-slate-700">€{row.fuel_cost.toFixed(2)}</p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-slate-400">Manut.</p>
                      <p className="text-sm font-semibold text-slate-700">€{row.maintenance_cost.toFixed(2)}</p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-slate-400">Km</p>
                      <p className="text-sm font-semibold text-slate-700">{row.logged_km.toLocaleString("it-IT")}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard title="Dettaglio per mezzo" subtitle="Classifica completa costi e percorrenza.">
        {loading || !payload ? (
          <p className="text-sm text-slate-400">Caricamento...</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-3 py-2.5">Mezzo</th>
                  <th className="px-3 py-2.5">Targa</th>
                  <th className="px-3 py-2.5">Licenza</th>
                  <th className="px-3 py-2.5 text-right">Fuel</th>
                  <th className="px-3 py-2.5 text-right">Manutenzione</th>
                  <th className="px-3 py-2.5 text-right">Totale</th>
                  <th className="px-3 py-2.5 text-right">Km registrati</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {payload.summary.map((row) => (
                  <tr key={row.vehicle_id}>
                    <td className="px-3 py-2.5 font-medium text-slate-800">{row.label}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-600">{row.plate ?? "—"}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-500">{row.license_number ?? "—"}</td>
                    <td className="px-3 py-2.5 text-right text-slate-700">€{row.fuel_cost.toFixed(2)}</td>
                    <td className="px-3 py-2.5 text-right text-slate-700">€{row.maintenance_cost.toFixed(2)}</td>
                    <td className="px-3 py-2.5 text-right font-semibold text-slate-900">€{row.total_cost.toFixed(2)}</td>
                    <td className="px-3 py-2.5 text-right text-slate-700">{row.logged_km.toLocaleString("it-IT")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </section>
  );
}
