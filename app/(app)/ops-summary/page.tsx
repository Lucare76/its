"use client";

import { useEffect, useMemo, useState } from "react";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import type { SummaryPreviewPayload } from "@/lib/server/operational-summary";

type SummaryLine = SummaryPreviewPayload["arrivals_48h"][string][number];

function formatIsoDate(dateIso: string) {
  const [year, month, day] = dateIso.split("-");
  return day && month && year ? `${day}/${month}/${year.slice(2)}` : dateIso;
}

function sortLines(lines: SummaryLine[]) {
  return [...lines].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.time.localeCompare(b.time);
  });
}

function buildOwnerReport(owner: string, lines: SummaryLine[]) {
  const header = `${owner} - ${lines.length} servizi / ${lines.reduce((sum, line) => sum + line.pax, 0)} pax`;
  const rows = sortLines(lines).map((line) => {
    const direction = line.direction === "arrival" ? "Arrivo" : "Partenza";
    const destination = line.hotel_or_destination ?? "N/D";
    return `${line.date} ${line.time} | ${direction} | ${line.customer_name} | ${destination} | ${line.pax} pax`;
  });
  return [header, ...rows].join("\n");
}

function SummaryGroupList({
  groups,
  emptyLabel,
  reportTitle
}: {
  groups: Record<string, SummaryLine[]>;
  emptyLabel: string;
  reportTitle: string;
}) {
  const entries = Object.entries(groups);
  if (entries.length === 0) {
    return <p className="text-sm text-muted">{emptyLabel}</p>;
  }

  return (
    <div className="space-y-4">
      {entries
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([owner, lines]) => (
          <div key={owner} className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
              <p className="text-sm font-semibold text-text">{owner}</p>
              <span className="rounded-full bg-white px-2.5 py-1 text-xs text-muted">
                {lines.length} servizi - {lines.reduce((sum, line) => sum + line.pax, 0)} pax
              </span>
            </div>
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Data</th>
                    <th className="px-3 py-2">Ora</th>
                    <th className="px-3 py-2">Cliente</th>
                    <th className="px-3 py-2">Direzione</th>
                    <th className="px-3 py-2">Destinazione</th>
                    <th className="px-3 py-2">Pax</th>
                    <th className="px-3 py-2">Tipo</th>
                  </tr>
                </thead>
                <tbody>
                  {sortLines(lines).map((line) => (
                    <tr key={`${owner}-${line.service_id}-${line.direction}-${line.date}-${line.time}`} className="border-t border-slate-100">
                      <td className="px-3 py-2">{formatIsoDate(line.date)}</td>
                      <td className="px-3 py-2 font-medium">{line.time}</td>
                      <td className="px-3 py-2">{line.customer_name}</td>
                      <td className="px-3 py-2">{line.direction === "arrival" ? "Arrivo" : "Partenza"}</td>
                      <td className="px-3 py-2">{line.hotel_or_destination ?? "N/D"}</td>
                      <td className="px-3 py-2">{line.pax}</td>
                      <td className="px-3 py-2">{line.service_type_code ?? line.booking_kind ?? "N/D"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted">{reportTitle}</p>
              <textarea readOnly className="input-saas min-h-36 w-full font-mono text-xs" value={buildOwnerReport(owner, lines)} />
            </div>
          </div>
        ))}
    </div>
  );
}

export default function OpsSummaryPage() {
  const [today, setToday] = useState(() => new Date().toISOString().slice(0, 10));
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [payload, setPayload] = useState<SummaryPreviewPayload | null>(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    const load = async () => {
      setLoading(true);
      setErrorMessage(null);
      try {
        const response = await fetch(`/api/ops/summary-preview?today=${today}`, {
          signal: controller.signal,
          cache: "no-store"
        });
        const json = (await response.json()) as { ok?: boolean; error?: string; payload?: SummaryPreviewPayload };
        if (!active) return;
        if (!response.ok || !json.ok || !json.payload) {
          setPayload(null);
          setErrorMessage(json.error ?? "Impossibile caricare il riepilogo operativo.");
          return;
        }
        setPayload(json.payload);
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        setPayload(null);
        setErrorMessage(error instanceof Error ? error.message : "Impossibile caricare il riepilogo operativo.");
      } finally {
        if (active) setLoading(false);
      }
    };

    void load();
    return () => {
      active = false;
      controller.abort();
    };
  }, [today]);

  const stats = useMemo(() => {
    if (!payload) return null;
    const arrivals = Object.values(payload.arrivals_48h).flat();
    const departures = Object.values(payload.departures_48h).flat();
    const bus = Object.values(payload.bus_monday).flat();
    const statements = Object.values(payload.statement_candidates).flat();
    return {
      arrivals,
      departures,
      bus,
      statements
    };
  }, [payload]);

  return (
    <section className="page-section">
      <PageHeader
        title="Riepiloghi Operativi"
        subtitle="Preview dei riepiloghi automatici per arrivi, partenze, servizi bus del lunedi ed estratti conto."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Riepiloghi" }]}
        actions={
          <label className="text-sm">
            Data base
            <input type="date" value={today} onChange={(event) => setToday(event.target.value)} className="input-saas mt-1 w-full min-w-40" />
          </label>
        }
      />

      {errorMessage ? <EmptyState title="Riepilogo non disponibile" description={errorMessage} compact /> : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SectionCard title="Arrivi +48h" subtitle={payload ? formatIsoDate(payload.target_date_48h) : "Caricamento..."} loading={loading}>
          <p className="text-3xl font-semibold text-text">{stats?.arrivals.length ?? 0}</p>
          <p className="mt-1 text-sm text-muted">{stats?.arrivals.reduce((sum, line) => sum + line.pax, 0) ?? 0} pax previsti</p>
        </SectionCard>
        <SectionCard title="Partenze +48h" subtitle={payload ? formatIsoDate(payload.target_date_48h) : "Caricamento..."} loading={loading}>
          <p className="text-3xl font-semibold text-text">{stats?.departures.length ?? 0}</p>
          <p className="mt-1 text-sm text-muted">{stats?.departures.reduce((sum, line) => sum + line.pax, 0) ?? 0} pax previsti</p>
        </SectionCard>
        <SectionCard title="Bus del lunedi" subtitle="Solo se la data base cade di lunedi" loading={loading}>
          <p className="text-3xl font-semibold text-text">{stats?.bus.length ?? 0}</p>
          <p className="mt-1 text-sm text-muted">{stats?.bus.reduce((sum, line) => sum + line.pax, 0) ?? 0} pax in elenco</p>
        </SectionCard>
        <SectionCard title="Estratti conto" subtitle="Agenzie abilitate a report economico" loading={loading}>
          <p className="text-3xl font-semibold text-text">{stats?.statements.length ?? 0}</p>
          <p className="mt-1 text-sm text-muted">Servizi candidati al report</p>
        </SectionCard>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SectionCard title="Arrivi 48 ore prima" subtitle={payload ? `Data target: ${formatIsoDate(payload.target_date_48h)}` : undefined} loading={loading} loadingLines={6}>
          <SummaryGroupList groups={payload?.arrivals_48h ?? {}} emptyLabel="Nessun arrivo aggregato per la finestra +48h." reportTitle="Preview testo arrivi" />
        </SectionCard>
        <SectionCard title="Partenze 48 ore prima" subtitle={payload ? `Data target: ${formatIsoDate(payload.target_date_48h)}` : undefined} loading={loading} loadingLines={6}>
          <SummaryGroupList groups={payload?.departures_48h ?? {}} emptyLabel="Nessuna partenza aggregata per la finestra +48h." reportTitle="Preview testo partenze" />
        </SectionCard>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SectionCard title="Servizi bus del lunedi" subtitle="Preview del lotto settimanale bus" loading={loading} loadingLines={5}>
          <SummaryGroupList groups={payload?.bus_monday ?? {}} emptyLabel="Nessun servizio bus in invio settimanale per questa data base." reportTitle="Preview testo bus" />
        </SectionCard>
        <SectionCard title="Estratti conto agenzie" subtitle="Solo preview dati, nessun invio live" loading={loading} loadingLines={5}>
          <SummaryGroupList groups={payload?.statement_candidates ?? {}} emptyLabel="Nessun estratto conto candidato per la data corrente." reportTitle="Preview testo estratto conto" />
        </SectionCard>
      </div>
    </section>
  );
}
