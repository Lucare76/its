"use client";

import { useEffect, useMemo, useState } from "react";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import type { SummaryPreviewPayload } from "@/lib/server/operational-summary";
import { STATEMENT_AGENCY_NAMES } from "@/lib/server/statement-agencies";

function addDays(dateIso: string, days: number) {
  const date = new Date(`${dateIso}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function nextMonday(dateIso: string) {
  const date = new Date(`${dateIso}T12:00:00`);
  const day = date.getDay();
  const delta = day === 1 ? 0 : (8 - day) % 7;
  date.setDate(date.getDate() + delta);
  return date.toISOString().slice(0, 10);
}

function formatDateLabel(dateIso: string) {
  const [year, month, day] = dateIso.split("-");
  return day && month && year ? `${day}/${month}/${year.slice(2)}` : dateIso;
}

export default function SchedulerPage() {
  const [today, setToday] = useState(() => new Date().toISOString().slice(0, 10));
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [payload, setPayload] = useState<SummaryPreviewPayload | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      const response = await fetch(`/api/ops/summary-preview?today=${today}`, { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; payload?: SummaryPreviewPayload } | null;
      if (!active) return;
      if (!response.ok || !body?.ok || !body.payload) {
        setPayload(null);
        setErrorMessage(body?.error ?? "Impossibile caricare lo scheduler.");
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

  const schedule = useMemo(() => {
    return {
      target48h: addDays(today, 2),
      mondayBus: nextMonday(today),
      statementStart: `${today.slice(0, 8)}01`,
      statementAgencies: STATEMENT_AGENCY_NAMES
    };
  }, [today]);

  return (
    <section className="page-section">
      <PageHeader
        title="Scheduler Operativo"
        subtitle="Vista dei job automatici, delle finestre di esecuzione e dei lotti che il sistema deve preparare."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Scheduler" }]}
        actions={
          <label className="text-sm">
            Data base
            <input type="date" value={today} onChange={(event) => setToday(event.target.value)} className="input-saas mt-1 min-w-40" />
          </label>
        }
      />

      {errorMessage ? <EmptyState title="Scheduler non disponibile" description={errorMessage} compact /> : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SectionCard title="Job arrivi +48h" subtitle="Scheduler operativo" loading={loading}>
          <p className="text-2xl font-semibold text-text">{formatDateLabel(schedule.target48h)}</p>
          <p className="mt-1 text-sm text-muted">{Object.values(payload?.arrivals_48h ?? {}).flat().length} servizi nel lotto</p>
        </SectionCard>
        <SectionCard title="Job partenze +48h" subtitle="Scheduler operativo" loading={loading}>
          <p className="text-2xl font-semibold text-text">{formatDateLabel(schedule.target48h)}</p>
          <p className="mt-1 text-sm text-muted">{Object.values(payload?.departures_48h ?? {}).flat().length} servizi nel lotto</p>
        </SectionCard>
        <SectionCard title="Job bus lunedi" subtitle="Eccezione settimanale" loading={loading}>
          <p className="text-2xl font-semibold text-text">{payload ? formatDateLabel(payload.target_bus_monday_date) : formatDateLabel(schedule.mondayBus)}</p>
          <p className="mt-1 text-sm text-muted">{Object.values(payload?.bus_monday ?? {}).flat().length} servizi bus in preparazione per agenzia</p>
        </SectionCard>
        <SectionCard title="Job estratti conto" subtitle="Per agenzie abilitate" loading={loading}>
          <p className="text-2xl font-semibold text-text">{schedule.statementAgencies.length}</p>
          <p className="mt-1 text-sm text-muted">Agenzie abilitate al report economico</p>
        </SectionCard>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.05fr_0.95fr]">
        <SectionCard title="Piano job automatici" subtitle="Sequenza di esecuzione suggerita" loading={loading} loadingLines={5}>
          <div className="space-y-3">
            {[
              { label: "Arrivi 48h", when: formatDateLabel(schedule.target48h), detail: "Prepara il lotto arrivi separato per prenotante." },
              { label: "Partenze 48h", when: formatDateLabel(schedule.target48h), detail: "Prepara il lotto partenze separato per prenotante." },
              { label: "Bus del lunedi", when: payload ? formatDateLabel(payload.target_bus_monday_date) : formatDateLabel(schedule.mondayBus), detail: "Raggruppa per agenzia i bus di arrivo e partenza della domenica successiva." },
              { label: "Estratti conto", when: `Dal ${formatDateLabel(schedule.statementStart)}`, detail: "Genera preview economica per le agenzie abilitate." }
            ].map((item) => (
              <article key={item.label} className="rounded-2xl border border-border bg-surface/80 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-text">{item.label}</p>
                    <p className="text-xs text-muted">{item.detail}</p>
                  </div>
                  <span className="rounded-full bg-white px-2.5 py-1 text-xs text-text shadow-sm">{item.when}</span>
                </div>
              </article>
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Agenzie estratto conto" subtitle="Configurazione attiva" loading={loading} loadingLines={5}>
          <div className="space-y-3">
            {schedule.statementAgencies.map((agency) => {
              const lines = payload?.statement_candidates?.[agency] ?? [];
              const totalCents = lines.reduce((sum, line) => sum + (line.total_amount_cents ?? 0), 0);
              return (
                <article key={agency} className="rounded-2xl border border-border bg-surface/80 p-3">
                  <p className="text-sm font-semibold text-text">{agency}</p>
                  <p className="mt-1 text-xs text-muted">
                    {lines.length} servizi · EUR {(totalCents / 100).toFixed(2)}
                  </p>
                </article>
              );
            })}
          </div>
        </SectionCard>
      </div>
    </section>
  );
}
