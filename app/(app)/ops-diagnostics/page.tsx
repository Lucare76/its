"use client";

import { useEffect, useMemo, useState } from "react";
import { DateInput, EmptyState, PageHeader, SectionCard, StatCard } from "@/components/ui";
import type { DayDiagnosticIssue, DayDiagnosticSeverity } from "@/lib/server/operational-day-diagnostics";

type DiagnosticsResponse = {
  ok: boolean;
  date: string;
  totalServices: number;
  okServices: number;
  warningServices: number;
  errorServices: number;
  issues: DayDiagnosticIssue[];
  error?: string;
};

const SEVERITY_LABEL: Record<DayDiagnosticSeverity, string> = {
  error: "Errore",
  warning: "Warning",
  info: "Info",
};

const SEVERITY_BADGE: Record<DayDiagnosticSeverity, string> = {
  error: "border-red-200 bg-red-50 text-red-700",
  warning: "border-amber-200 bg-amber-50 text-amber-700",
  info: "border-slate-200 bg-slate-50 text-slate-600",
};

export default function OpsDiagnosticsPage() {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [severityFilter, setSeverityFilter] = useState<"all" | DayDiagnosticSeverity>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [data, setData] = useState<DiagnosticsResponse | null>(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    const load = async () => {
      setLoading(true);
      setErrorMessage(null);
      try {
        const response = await fetch(`/api/ops/diagnostics?date=${date}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const json = (await response.json()) as DiagnosticsResponse;
        if (!active) return;
        if (!response.ok || !json.ok) {
          setData(null);
          setErrorMessage(json.error ?? "Impossibile caricare la diagnostica giornata.");
          return;
        }
        setData(json);
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        setData(null);
        setErrorMessage(error instanceof Error ? error.message : "Impossibile caricare la diagnostica giornata.");
      } finally {
        if (active) setLoading(false);
      }
    };

    void load();
    return () => {
      active = false;
      controller.abort();
    };
  }, [date]);

  const categories = useMemo(() => {
    if (!data) return [];
    return Array.from(new Set(data.issues.map((issue) => issue.category))).sort();
  }, [data]);

  const filteredIssues = useMemo(() => {
    if (!data) return [];
    return data.issues.filter((issue) => {
      if (severityFilter !== "all" && issue.severity !== severityFilter) return false;
      if (categoryFilter !== "all" && issue.category !== categoryFilter) return false;
      return true;
    });
  }, [data, severityFilter, categoryFilter]);

  return (
    <section className="page-section">
      <PageHeader
        title="Diagnostica Giornata"
        subtitle="Controllo read-only sopra i dati esistenti: pickup, nave, hotel, bus, cancellazioni, duplicati, collegamenti A/R. Nessuna correzione automatica."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Diagnostica Giornata" }]}
        actions={
          <label className="text-sm">
            Data
            <DateInput value={date} onChange={(iso) => setDate(iso)} className="input-saas mt-1 w-full min-w-40" />
          </label>
        }
      />

      {errorMessage ? <EmptyState title="Diagnostica non disponibile" description={errorMessage} compact /> : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Servizi" value={String(data?.totalServices ?? 0)} hint={date} loading={loading} />
        <StatCard label="OK" value={String(data?.okServices ?? 0)} hint="nessuna anomalia" loading={loading} />
        <StatCard label="Warning" value={String(data?.warningServices ?? 0)} hint="da verificare" loading={loading} />
        <StatCard label="Errori" value={String(data?.errorServices ?? 0)} hint="richiedono intervento" loading={loading} />
      </div>

      <SectionCard
        title="Anomalie rilevate"
        subtitle={`${filteredIssues.length} di ${data?.issues.length ?? 0} issue`}
        loading={loading}
        loadingLines={6}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="input-saas"
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value as "all" | DayDiagnosticSeverity)}
            >
              <option value="all">Tutti</option>
              <option value="error">Solo errori</option>
              <option value="warning">Solo warning</option>
              <option value="info">Solo info</option>
            </select>
            <select className="input-saas" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
              <option value="all">Tutte le categorie</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </div>
        }
      >
        {filteredIssues.length === 0 ? (
          <p className="text-sm text-muted">Nessuna anomalia per i filtri selezionati.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Severity</th>
                  <th className="px-3 py-2">Categoria</th>
                  <th className="px-3 py-2">Problema</th>
                  <th className="px-3 py-2">Dettaglio</th>
                  <th className="px-3 py-2">Azione</th>
                </tr>
              </thead>
              <tbody>
                {filteredIssues.map((issue, index) => (
                  <tr key={`${issue.serviceId ?? "day"}-${issue.code}-${index}`} className="border-t border-slate-100 align-top">
                    <td className="px-3 py-2">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${SEVERITY_BADGE[issue.severity]}`}>
                        {SEVERITY_LABEL[issue.severity]}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs uppercase tracking-wide text-slate-500">{issue.category}</td>
                    <td className="px-3 py-2">
                      <p className="font-medium text-text">{issue.title}</p>
                      <p className="mt-0.5 text-xs text-muted">{issue.message}</p>
                      {issue.details && issue.details.length > 0 ? (
                        <p className="mt-0.5 text-xs text-slate-400">Correlati: {issue.details.length}</p>
                      ) : null}
                      <p className="mt-0.5 text-[11px] text-slate-400">codice: {issue.code}</p>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted">{issue.source ?? "—"}</td>
                    <td className="px-3 py-2">
                      {issue.serviceId ? (
                        <a href={`/services/${issue.serviceId}/edit`} className="text-sm font-medium text-blue-600 hover:underline">
                          Apri servizio
                        </a>
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </td>
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
