"use client";

import { useEffect, useMemo, useState } from "react";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { KpiCard } from "@/components/kpi-card";

type MarginPayload = {
  periodDays: number;
  fromIso: string;
  summary: {
    totalServices: number;
    totalRevenueCents: number;
    totalCostCents: number;
    totalMarginCents: number;
  };
  byAgency: Array<{ label: string; services: number; revenueCents: number; marginCents: number }>;
  byRoute: Array<{ label: string; services: number; revenueCents: number; marginCents: number }>;
};

function centsToEuro(value: number) {
  return (value / 100).toLocaleString("it-IT", { style: "currency", currency: "EUR" });
}

export default function PricingMarginsPage() {
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<MarginPayload | null>(null);

  const marginPct = useMemo(() => {
    if (!data?.summary.totalRevenueCents) return 0;
    return (data.summary.totalMarginCents / data.summary.totalRevenueCents) * 100;
  }, [data]);

  const loadMargins = async (nextDays = days) => {
    if (!hasSupabaseEnv || !supabase) {
      setError("Supabase non configurato.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !sessionData.session?.access_token) {
        setError("Sessione non valida. Rifai login.");
        setLoading(false);
        return;
      }
      const response = await fetch(`/api/pricing/margins?days=${nextDays}`, {
        headers: { Authorization: `Bearer ${sessionData.session.access_token}` }
      });
      const body = (await response.json().catch(() => null)) as MarginPayload | { error?: string } | null;
      if (!response.ok) {
        setError((body as { error?: string } | null)?.error ?? "Errore caricamento KPI margini.");
        setLoading(false);
        return;
      }
      setData(body as MarginPayload);
    } catch {
      setError("Errore rete durante caricamento KPI margini.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadMargins();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">KPI Margini</h1>
        <div className="flex items-center gap-2">
          <label className="text-sm text-slate-600">Periodo</label>
          <select
            value={days}
            onChange={(event) => {
              const next = Number(event.target.value);
              setDays(next);
              void loadMargins(next);
            }}
            className="input-saas"
          >
            <option value={7}>7 giorni</option>
            <option value={30}>30 giorni</option>
            <option value={90}>90 giorni</option>
            <option value={180}>180 giorni</option>
          </select>
        </div>
      </div>

      {error ? <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}

      <div className="grid gap-3 md:grid-cols-4">
        <KpiCard label="Servizi prezzati" value={String(data?.summary.totalServices ?? 0)} hint="Totale servizi con pricing applicato" />
        <KpiCard label="Ricavi" value={centsToEuro(data?.summary.totalRevenueCents ?? 0)} hint="Prezzo finale totale" />
        <KpiCard label="Costi" value={centsToEuro(data?.summary.totalCostCents ?? 0)} hint="Costo interno totale" />
        <KpiCard label="Margine" value={centsToEuro(data?.summary.totalMarginCents ?? 0)} hint={`Margine medio ${marginPct.toFixed(1)}%`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="mb-2 text-base font-semibold">Top Agenzie per Margine</h2>
          {loading ? (
            <p className="text-sm text-slate-500">Caricamento...</p>
          ) : (
            <div className="overflow-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left">
                    <th className="px-2 py-2">Agenzia</th>
                    <th className="px-2 py-2">Servizi</th>
                    <th className="px-2 py-2">Ricavi</th>
                    <th className="px-2 py-2">Margine</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.byAgency ?? []).map((row) => (
                    <tr key={row.label} className="border-b border-slate-100">
                      <td className="px-2 py-2">{row.label}</td>
                      <td className="px-2 py-2">{row.services}</td>
                      <td className="px-2 py-2">{centsToEuro(row.revenueCents)}</td>
                      <td className="px-2 py-2">{centsToEuro(row.marginCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card p-4">
          <h2 className="mb-2 text-base font-semibold">Top Tratte per Margine</h2>
          {loading ? (
            <p className="text-sm text-slate-500">Caricamento...</p>
          ) : (
            <div className="overflow-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left">
                    <th className="px-2 py-2">Tratta</th>
                    <th className="px-2 py-2">Servizi</th>
                    <th className="px-2 py-2">Ricavi</th>
                    <th className="px-2 py-2">Margine</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.byRoute ?? []).map((row) => (
                    <tr key={row.label} className="border-b border-slate-100">
                      <td className="px-2 py-2">{row.label}</td>
                      <td className="px-2 py-2">{row.services}</td>
                      <td className="px-2 py-2">{centsToEuro(row.revenueCents)}</td>
                      <td className="px-2 py-2">{centsToEuro(row.marginCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}


