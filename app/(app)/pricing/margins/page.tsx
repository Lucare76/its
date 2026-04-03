"use client";

import { useEffect, useMemo, useState } from "react";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { KpiCard } from "@/components/kpi-card";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";

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
  alerts: {
    withoutPricing: number;
    lowMargin: number;
    negativeMargin: number;
    manualOverrides: number;
  };
  attentionRows: Array<{
    id: string;
    customer_name: string;
    billing_party_name: string | null;
    service_label: string;
    date: string;
    time: string;
    margin_cents: number;
    has_pricing_rule: boolean;
    manual_override: boolean;
  }>;
};

type SimulatorResult = {
  multiplier: number;
  internal_cost_cents: number;
  public_price_cents: number;
  agency_price_cents: number | null;
  final_price_cents: number;
  margin_cents: number;
  margin_pct: number;
};

function centsToEuro(value: number) {
  return (value / 100).toLocaleString("it-IT", { style: "currency", currency: "EUR" });
}

function parseEuroToCents(value: string) {
  const normalized = value.trim().replace(/\./g, "").replace(",", ".");
  if (!normalized) return 0;
  const number = Number(normalized);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

export default function PricingMarginsPage() {
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<MarginPayload | null>(null);
  const [simulatorLoading, setSimulatorLoading] = useState(false);
  const [simulatorError, setSimulatorError] = useState<string | null>(null);
  const [simulatorResult, setSimulatorResult] = useState<SimulatorResult | null>(null);
  const [simulatorForm, setSimulatorForm] = useState({
    pax: "2",
    rule_kind: "per_pax",
    internal_cost: "25,00",
    public_price: "40,00",
    agency_price: "35,00"
  });

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

  const runSimulation = async () => {
    if (!hasSupabaseEnv || !supabase) {
      setSimulatorError("Supabase non configurato.");
      return;
    }
    setSimulatorLoading(true);
    setSimulatorError(null);
    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !sessionData.session?.access_token) {
        setSimulatorError("Sessione non valida. Rifai login.");
        setSimulatorLoading(false);
        return;
      }
      const response = await fetch("/api/pricing/simulator", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionData.session.access_token}`
        },
        body: JSON.stringify({
          pax: Number(simulatorForm.pax),
          rule_kind: simulatorForm.rule_kind,
          internal_cost_cents: parseEuroToCents(simulatorForm.internal_cost),
          public_price_cents: parseEuroToCents(simulatorForm.public_price),
          agency_price_cents: simulatorForm.agency_price.trim() ? parseEuroToCents(simulatorForm.agency_price) : null
        })
      });
      const body = (await response.json().catch(() => null)) as { result?: SimulatorResult; error?: string } | null;
      if (!response.ok || !body?.result) {
        setSimulatorError(body?.error ?? "Simulazione non disponibile.");
        setSimulatorLoading(false);
        return;
      }
      setSimulatorResult(body.result);
    } catch {
      setSimulatorError("Errore rete durante la simulazione.");
    } finally {
      setSimulatorLoading(false);
    }
  };

  return (
    <section className="page-section">
      <PageHeader
        title="KPI Margini"
        subtitle="Cruscotto pricing con alert su servizi critici, top performance e simulatore rapido di margine."
        breadcrumbs={[{ label: "Tariffe", href: "/pricing" }, { label: "Margini" }]}
        actions={
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
        }
      />

      {error ? <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}

      <div className="grid gap-3 md:grid-cols-4">
        <KpiCard label="Servizi prezzati" value={String(data?.summary.totalServices ?? 0)} hint="Totale servizi con pricing applicato" />
        <KpiCard label="Ricavi" value={centsToEuro(data?.summary.totalRevenueCents ?? 0)} hint="Prezzo finale totale" />
        <KpiCard label="Costi" value={centsToEuro(data?.summary.totalCostCents ?? 0)} hint="Costo interno totale" />
        <KpiCard label="Margine" value={centsToEuro(data?.summary.totalMarginCents ?? 0)} hint={`Margine medio ${marginPct.toFixed(1)}%`} />
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <SectionCard title="Senza pricing rule" loading={loading}>
          <p className="text-3xl font-semibold text-text">{data?.alerts.withoutPricing ?? 0}</p>
          <p className="mt-1 text-sm text-muted">Servizi da lavorare manualmente</p>
        </SectionCard>
        <SectionCard title="Margine basso" loading={loading}>
          <p className="text-3xl font-semibold text-text">{data?.alerts.lowMargin ?? 0}</p>
          <p className="mt-1 text-sm text-muted">Margine positivo ma fino a 10 EUR</p>
        </SectionCard>
        <SectionCard title="Margine negativo" loading={loading}>
          <p className="text-3xl font-semibold text-text">{data?.alerts.negativeMargin ?? 0}</p>
          <p className="mt-1 text-sm text-muted">Servizi in perdita da correggere</p>
        </SectionCard>
        <SectionCard title="Override manuali" loading={loading}>
          <p className="text-3xl font-semibold text-text">{data?.alerts.manualOverrides ?? 0}</p>
          <p className="mt-1 text-sm text-muted">Servizi corretti manualmente</p>
        </SectionCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
        <SectionCard title="Top Agenzie per Margine" loading={loading} loadingLines={5}>
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
        </SectionCard>

        <SectionCard title="Top Tratte per Margine" loading={loading} loadingLines={5}>
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
        </SectionCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
        <SectionCard title="Servizi da attenzionare" subtitle="Pricing mancante, margine basso o perdita" loading={loading} loadingLines={6}>
          {(data?.attentionRows ?? []).length === 0 ? (
            <EmptyState title="Nessun alert attivo" description="Nel periodo selezionato non risultano servizi critici." compact />
          ) : (
            <div className="overflow-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left">
                    <th className="px-2 py-2">Data</th>
                    <th className="px-2 py-2">Cliente</th>
                    <th className="px-2 py-2">Agenzia</th>
                    <th className="px-2 py-2">Tipo</th>
                    <th className="px-2 py-2">Margine</th>
                    <th className="px-2 py-2">Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.attentionRows ?? []).map((row) => (
                    <tr key={row.id} className="border-b border-slate-100">
                      <td className="px-2 py-2">{row.date} {row.time}</td>
                      <td className="px-2 py-2">{row.customer_name}</td>
                      <td className="px-2 py-2">{row.billing_party_name ?? "N/D"}</td>
                      <td className="px-2 py-2">{row.service_label}</td>
                      <td className="px-2 py-2">{centsToEuro(row.margin_cents)}</td>
                      <td className="px-2 py-2">
                        <div className="flex flex-wrap gap-1">
                          {!row.has_pricing_rule ? <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] text-rose-700">senza rule</span> : null}
                          {row.margin_cents <= 1000 ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-700">margine basso</span> : null}
                          {row.manual_override ? <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] text-sky-700">override</span> : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        <SectionCard title="Simulatore margine" subtitle="Verifica al volo l'effetto di costo, prezzo e pax">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm">
              Pax
              <input className="input-saas mt-1" value={simulatorForm.pax} onChange={(event) => setSimulatorForm((current) => ({ ...current, pax: event.target.value }))} />
            </label>
            <label className="text-sm">
              Tipo regola
              <select className="input-saas mt-1" value={simulatorForm.rule_kind} onChange={(event) => setSimulatorForm((current) => ({ ...current, rule_kind: event.target.value }))}>
                <option value="per_pax">Per pax</option>
                <option value="fixed">Fissa</option>
              </select>
            </label>
            <label className="text-sm">
              Costo interno EUR
              <input className="input-saas mt-1" value={simulatorForm.internal_cost} onChange={(event) => setSimulatorForm((current) => ({ ...current, internal_cost: event.target.value }))} />
            </label>
            <label className="text-sm">
              Prezzo pubblico EUR
              <input className="input-saas mt-1" value={simulatorForm.public_price} onChange={(event) => setSimulatorForm((current) => ({ ...current, public_price: event.target.value }))} />
            </label>
            <label className="text-sm md:col-span-2">
              Prezzo agenzia EUR
              <input className="input-saas mt-1" value={simulatorForm.agency_price} onChange={(event) => setSimulatorForm((current) => ({ ...current, agency_price: event.target.value }))} placeholder="Lascia vuoto per usare il pubblico" />
            </label>
          </div>
          <div className="mt-3 flex gap-2">
            <button type="button" className="btn-primary" disabled={simulatorLoading} onClick={() => void runSimulation()}>
              {simulatorLoading ? "Simulo..." : "Simula"}
            </button>
          </div>
          {simulatorError ? <p className="mt-3 text-sm text-rose-700">{simulatorError}</p> : null}
          {simulatorResult ? (
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <article className="rounded-2xl border border-border bg-surface/80 p-3">
                <p className="text-xs uppercase tracking-[0.14em] text-muted">Costo totale</p>
                <p className="mt-2 text-2xl font-semibold text-text">{centsToEuro(simulatorResult.internal_cost_cents)}</p>
              </article>
              <article className="rounded-2xl border border-border bg-surface/80 p-3">
                <p className="text-xs uppercase tracking-[0.14em] text-muted">Prezzo finale</p>
                <p className="mt-2 text-2xl font-semibold text-text">{centsToEuro(simulatorResult.final_price_cents)}</p>
              </article>
              <article className="rounded-2xl border border-border bg-surface/80 p-3">
                <p className="text-xs uppercase tracking-[0.14em] text-muted">Margine</p>
                <p className="mt-2 text-2xl font-semibold text-text">{centsToEuro(simulatorResult.margin_cents)}</p>
              </article>
              <article className="rounded-2xl border border-border bg-surface/80 p-3">
                <p className="text-xs uppercase tracking-[0.14em] text-muted">Margine %</p>
                <p className="mt-2 text-2xl font-semibold text-text">{simulatorResult.margin_pct}%</p>
              </article>
            </div>
          ) : null}
        </SectionCard>
      </div>
    </section>
  );
}
