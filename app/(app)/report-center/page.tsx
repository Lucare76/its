"use client";

import { useEffect, useMemo, useState } from "react";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import type { SummaryPreviewPayload } from "@/lib/server/operational-summary";

function formatDateTime(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export default function ReportCenterPage() {
  const [today, setToday] = useState(() => new Date().toISOString().slice(0, 10));
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [payload, setPayload] = useState<SummaryPreviewPayload | null>(null);
  const [typeFilter, setTypeFilter] = useState("all");
  const [jobFilter, setJobFilter] = useState("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      if (!hasSupabaseEnv || !supabase) {
        if (!active) return;
        setErrorMessage("Supabase non configurato.");
        setLoading(false);
        return;
      }
      const { data, error } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!active) return;
      if (error || !token) {
        setErrorMessage("Sessione non valida.");
        setLoading(false);
        return;
      }
      const response = await fetch(`/api/ops/summary-preview?today=${today}`, { headers: { Authorization: `Bearer ${token}` } });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; payload?: SummaryPreviewPayload } | null;
      if (!active) return;
      if (!response.ok || !body?.ok || !body.payload) {
        setPayload(null);
        setErrorMessage(body?.error ?? "Impossibile caricare il centro report.");
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

  const filteredRows = useMemo(() => {
    const rows = payload?.export_history ?? [];
    return rows.filter((row) => {
      const typeOk = typeFilter === "all" || row.service_type === typeFilter;
      const searchOk = !search.trim() || `${row.service_type} ${row.date_from} ${row.date_to}`.toLowerCase().includes(search.toLowerCase());
      return typeOk && searchOk;
    });
  }, [payload, search, typeFilter]);

  const grouped = useMemo(() => {
    const rows = filteredRows;
    return rows.reduce<Record<string, typeof rows>>((acc, row) => {
      const key = row.created_at.slice(0, 10);
      acc[key] = [...(acc[key] ?? []), row];
      return acc;
    }, {});
  }, [filteredRows]);

  const filteredJobs = useMemo(() => {
    return (payload?.report_jobs ?? []).filter((job) => {
      const typeOk = jobFilter === "all" || job.job_type === jobFilter || job.status === jobFilter;
      const searchOk =
        !search.trim() ||
        `${job.job_type} ${job.owner_name ?? ""} ${job.target_date} ${job.status}`.toLowerCase().includes(search.toLowerCase());
      return typeOk && searchOk;
    });
  }, [jobFilter, payload, search]);

  const reportTotals = useMemo(() => {
    const rows = payload?.export_history ?? [];
    const jobs = payload?.report_jobs ?? [];
    return {
      exportServices: rows.reduce((sum, row) => sum + row.exported_count, 0),
      plannedJobs: jobs.filter((job) => job.status === "planned").length,
      distinctTargets: new Set(rows.map((row) => `${row.date_from}:${row.date_to}`)).size
    };
  }, [payload]);

  return (
    <section className="page-section">
      <PageHeader
        title="Centro Report"
        subtitle="Storico unico dei file generati, con lettura per giorno, tipo export e volume servizi."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Centro Report" }]}
        actions={
          <label className="text-sm">
            Data base
            <input type="date" value={today} onChange={(event) => setToday(event.target.value)} className="input-saas mt-1 min-w-40" />
          </label>
        }
      />

      {errorMessage ? <EmptyState title="Centro report non disponibile" description={errorMessage} compact /> : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <SectionCard title="Export registrati" loading={loading}>
          <p className="text-3xl font-semibold text-text">{payload?.export_history?.length ?? 0}</p>
          <p className="mt-1 text-sm text-muted">Ultimi file tracciati nel tenant</p>
        </SectionCard>
        <SectionCard title="Lotti con servizi" loading={loading}>
          <p className="text-3xl font-semibold text-text">
            {(payload?.export_history ?? []).filter((row) => row.exported_count > 0).length}
          </p>
          <p className="mt-1 text-sm text-muted">Export che hanno prodotto un file non vuoto</p>
        </SectionCard>
        <SectionCard title="Volume servizi" loading={loading}>
          <p className="text-3xl font-semibold text-text">{reportTotals.exportServices}</p>
          <p className="mt-1 text-sm text-muted">Servizi passati dai report storici</p>
        </SectionCard>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <SectionCard title="Job pianificati" loading={loading}>
          <p className="text-3xl font-semibold text-text">{reportTotals.plannedJobs}</p>
          <p className="mt-1 text-sm text-muted">Job scheduler attualmente in stato planned</p>
        </SectionCard>
        <SectionCard title="Finestre distinte" loading={loading}>
          <p className="text-3xl font-semibold text-text">{reportTotals.distinctTargets}</p>
          <p className="mt-1 text-sm text-muted">Periodi diversi gia passati dal centro report</p>
        </SectionCard>
        <SectionCard title="Agenzie in coda" loading={loading}>
          <p className="text-3xl font-semibold text-text">{new Set((payload?.report_jobs ?? []).map((job) => job.owner_name ?? "N/D")).size}</p>
          <p className="mt-1 text-sm text-muted">Owner o agenzie presenti nella coda report</p>
        </SectionCard>
      </div>

      <SectionCard title="Filtri report" subtitle="Riduci lo storico per tipo e testo">
        <div className="grid gap-3 md:grid-cols-3">
          <label className="text-sm">
            Tipo export
            <select className="input-saas mt-1" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
              <option value="all">Tutti</option>
              {Array.from(new Set((payload?.export_history ?? []).map((row) => row.service_type))).map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Filtro job
            <select className="input-saas mt-1" value={jobFilter} onChange={(event) => setJobFilter(event.target.value)}>
              <option value="all">Tutti</option>
              {Array.from(new Set((payload?.report_jobs ?? []).flatMap((job) => [job.job_type, job.status]))).map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Cerca report o owner
            <input className="input-saas mt-1" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tipo o periodo" />
          </label>
        </div>
      </SectionCard>

      <SectionCard title="Timeline export" subtitle="Lettura per giorno e tipo file" loading={loading} loadingLines={6}>
        {Object.keys(grouped).length === 0 ? (
          <p className="text-sm text-muted">Nessun report registrato finora.</p>
        ) : (
          <div className="space-y-4">
            {Object.entries(grouped)
              .sort((a, b) => b[0].localeCompare(a[0]))
              .map(([day, rows]) => (
                <article key={day} className="rounded-2xl border border-border bg-surface/80 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-text">{day}</p>
                    <span className="rounded-full bg-white px-2.5 py-1 text-xs text-muted shadow-sm">
                      {rows.length} export - {rows.reduce((sum, row) => sum + row.exported_count, 0)} servizi
                    </span>
                  </div>
                  <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200">
                    <table className="min-w-full text-sm">
                      <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                        <tr>
                          <th className="px-3 py-2">Creato il</th>
                          <th className="px-3 py-2">Periodo</th>
                          <th className="px-3 py-2">Tipo</th>
                          <th className="px-3 py-2">Servizi</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => (
                          <tr key={row.id} className="border-t border-slate-100">
                            <td className="px-3 py-2">{formatDateTime(row.created_at)}</td>
                            <td className="px-3 py-2">{row.date_from} -&gt; {row.date_to}</td>
                            <td className="px-3 py-2">{row.service_type}</td>
                            <td className="px-3 py-2">{row.exported_count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </article>
              ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Job report pianificati" subtitle="Storico coda scheduler" loading={loading} loadingLines={4}>
        {filteredJobs.length === 0 ? (
          <p className="text-sm text-muted">Nessun job report registrato.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Creato il</th>
                  <th className="px-3 py-2">Job</th>
                  <th className="px-3 py-2">Target</th>
                  <th className="px-3 py-2">Owner</th>
                  <th className="px-3 py-2">Stato</th>
                </tr>
              </thead>
              <tbody>
                {filteredJobs.map((job) => (
                  <tr key={job.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">{formatDateTime(job.created_at)}</td>
                    <td className="px-3 py-2">{job.job_type}</td>
                    <td className="px-3 py-2">{job.target_date}</td>
                    <td className="px-3 py-2">{job.owner_name ?? "N/D"}</td>
                    <td className="px-3 py-2">{job.status}</td>
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
