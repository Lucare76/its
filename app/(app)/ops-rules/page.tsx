"use client";

import { useEffect, useState } from "react";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import type { SummaryPreviewPayload } from "@/lib/server/operational-summary";

const LOCAL_RULES_KEY = "it-ops-rules-v1";

const rules = [
  { id: "arrivals_48h", label: "Arrivi +48h", detail: "Prepara il riepilogo arrivi 48 ore prima, separato per prenotante." },
  { id: "departures_48h", label: "Partenze +48h", detail: "Prepara il riepilogo partenze 48 ore prima, separato per prenotante." },
  { id: "bus_monday", label: "Bus del lunedi", detail: "Ogni lunedi il sistema raggruppa per agenzia le linee bus di arrivo e partenza della domenica successiva." },
  { id: "statement_agency", label: "Estratti conto", detail: "Le agenzie abilitate vanno in report economico per periodo, con preview prima dell'invio." },
  { id: "exports_split", label: "Split export cliente", detail: "Gli Excel vengono separati in `linea bus` e `altri servizi`, sia per arrivi sia per partenze." }
];

export default function OpsRulesPage() {
  const [today, setToday] = useState(() => new Date().toISOString().slice(0, 10));
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [payload, setPayload] = useState<SummaryPreviewPayload | null>(null);
  const [rulesDraft, setRulesDraft] = useState(() => {
    const fallback = {
      arrivalsHours: "48",
      departuresHours: "48",
      mondayBusEnabled: true,
      mondayBusScope: "domenica successiva per agenzia",
      statementAgencies: "Aleste Viaggi\nSosandra Tour By Rossella Viaggi\nZigolo Viaggi"
    };
    if (typeof window === "undefined") return fallback;
    const saved = window.localStorage.getItem(LOCAL_RULES_KEY);
    if (!saved) return fallback;
    try {
      return JSON.parse(saved) as typeof fallback;
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      const response = await fetch(`/api/ops/summary-preview?today=${today}`, { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; payload?: SummaryPreviewPayload } | null;
      if (!active) return;
      if (!response.ok || !body?.ok || !body.payload) {
        setPayload(null);
        setErrorMessage(body?.error ?? "Impossibile caricare le regole operative.");
        setLoading(false);
        return;
      }
      setPayload(body.payload);
      setErrorMessage(null);
      setLoading(false);
    };
    void load();
    return () => {
      active = false;
    };
  }, [today]);

  return (
    <section className="page-section">
      <PageHeader
        title="Regole Operative"
        subtitle="Motore leggibile delle regole che governano riepiloghi, split export e lotti settimanali."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Regole Operative" }]}
        actions={
          <label className="text-sm">
            Data base
            <input type="date" value={today} onChange={(event) => setToday(event.target.value)} className="input-saas mt-1 min-w-40" />
          </label>
        }
      />

      {errorMessage ? <EmptyState title="Regole operative non disponibili" description={errorMessage} compact /> : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rules.map((rule) => (
          <SectionCard key={rule.id} title={rule.label}>
            <p className="text-sm text-text">{rule.detail}</p>
          </SectionCard>
        ))}
      </div>

      <SectionCard title="Configurazione workspace" subtitle="Regole operative modificabili lato admin, pronte per futura persistenza server" loading={loading} loadingLines={4}>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-sm">
            Ore prima arrivi
            <input className="input-saas mt-1" value={rulesDraft.arrivalsHours} onChange={(event) => setRulesDraft((prev) => ({ ...prev, arrivalsHours: event.target.value }))} />
          </label>
          <label className="text-sm">
            Ore prima partenze
            <input className="input-saas mt-1" value={rulesDraft.departuresHours} onChange={(event) => setRulesDraft((prev) => ({ ...prev, departuresHours: event.target.value }))} />
          </label>
          <label className="text-sm md:col-span-2">
            Scope bus del lunedi
            <input className="input-saas mt-1" value={rulesDraft.mondayBusScope} onChange={(event) => setRulesDraft((prev) => ({ ...prev, mondayBusScope: event.target.value }))} />
          </label>
          <label className="text-sm md:col-span-2">
            Agenzie estratto conto
            <textarea
              className="input-saas mt-1 min-h-[110px]"
              value={rulesDraft.statementAgencies}
              onChange={(event) => setRulesDraft((prev) => ({ ...prev, statementAgencies: event.target.value }))}
            />
          </label>
          <label className="flex items-center gap-2 text-sm md:col-span-2">
            <input
              type="checkbox"
              checked={rulesDraft.mondayBusEnabled}
              onChange={(event) => setRulesDraft((prev) => ({ ...prev, mondayBusEnabled: event.target.checked }))}
            />
            Abilita job bus del lunedi
          </label>
          <div className="md:col-span-2">
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                if (typeof window === "undefined") return;
                window.localStorage.setItem(LOCAL_RULES_KEY, JSON.stringify(rulesDraft));
              }}
            >
              Salva configurazione locale
            </button>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Preview live delle regole" subtitle="Conferma che il motore sta producendo dati reali" loading={loading} loadingLines={4}>
        {payload ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <article className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Arrivi +48h</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">{Object.values(payload.arrivals_48h).flat().length}</p>
            </article>
            <article className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Partenze +48h</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">{Object.values(payload.departures_48h).flat().length}</p>
            </article>
            <article className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Bus lunedi</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">{Object.values(payload.bus_monday).flat().length}</p>
              <p className="mt-1 text-xs text-slate-500">Target domenica {payload.target_bus_monday_date}</p>
            </article>
            <article className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Estratti conto</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">{Object.values(payload.statement_candidates).flat().length}</p>
            </article>
          </div>
        ) : null}
      </SectionCard>
    </section>
  );
}
