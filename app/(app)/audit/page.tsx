"use client";

import { useEffect, useMemo, useState } from "react";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type AuditSummary = {
  ops_audits: number;
  pricing_audits: number;
  export_audits: number;
  report_jobs: number;
  status_events: number;
};

type TimelineRow = {
  id: string;
  at: string;
  category: "ops_audit" | "pricing_audit" | "export_audit" | "report_job" | "status_event";
  title: string;
  detail: string;
  actor: string;
  meta: Record<string, unknown>;
};

type AuditPayload = {
  summary: AuditSummary;
  timeline: TimelineRow[];
};

function labelForCategory(category: TimelineRow["category"]) {
  if (category === "ops_audit") return "Audit operativo";
  if (category === "pricing_audit") return "Pricing";
  if (category === "export_audit") return "Export";
  if (category === "report_job") return "Job report";
  return "Cambio stato";
}

export default function AuditPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<AuditPayload | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<"all" | TimelineRow["category"]>("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!hasSupabaseEnv || !supabase) {
        setError("Supabase non configurato.");
        setLoading(false);
        return;
      }
      const session = await supabase.auth.getSession();
      if (!active) return;
      const token = session.data.session?.access_token;
      if (session.error || !token) {
        setError("Sessione non valida.");
        setLoading(false);
        return;
      }
      const response = await fetch("/api/audit/feed?limit=120", {
        headers: { Authorization: `Bearer ${token}` }
      });
      const body = (await response.json().catch(() => null)) as { summary?: AuditSummary; timeline?: TimelineRow[]; error?: string } | null;
      if (!active) return;
      if (!response.ok) {
        setError(body?.error ?? "Audit non disponibile.");
        setLoading(false);
        return;
      }
      setPayload({
        summary: body?.summary ?? { ops_audits: 0, pricing_audits: 0, export_audits: 0, report_jobs: 0, status_events: 0 },
        timeline: body?.timeline ?? []
      });
      setLoading(false);
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  const filteredTimeline = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return (payload?.timeline ?? []).filter((item) => {
      const matchesCategory = categoryFilter === "all" ? true : item.category === categoryFilter;
      const matchesQuery = !normalizedQuery
        ? true
        : [item.title, item.detail, item.actor, JSON.stringify(item.meta ?? {})].join(" ").toLowerCase().includes(normalizedQuery);
      return matchesCategory && matchesQuery;
    });
  }, [categoryFilter, payload?.timeline, query]);

  return (
    <section className="page-section">
      <PageHeader
        title="Audit"
        subtitle="Feed unica delle azioni operative: eventi applicativi, pricing, export, job scheduler e cambi stato."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Audit" }]}
      />

      {error ? <EmptyState title="Audit non disponibile" description={error} compact /> : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <SectionCard title="Audit operativo" loading={loading}>
          <p className="text-3xl font-semibold text-text">{payload?.summary.ops_audits ?? 0}</p>
        </SectionCard>
        <SectionCard title="Pricing audit" loading={loading}>
          <p className="text-3xl font-semibold text-text">{payload?.summary.pricing_audits ?? 0}</p>
        </SectionCard>
        <SectionCard title="Export" loading={loading}>
          <p className="text-3xl font-semibold text-text">{payload?.summary.export_audits ?? 0}</p>
        </SectionCard>
        <SectionCard title="Job report" loading={loading}>
          <p className="text-3xl font-semibold text-text">{payload?.summary.report_jobs ?? 0}</p>
        </SectionCard>
        <SectionCard title="Cambi stato" loading={loading}>
          <p className="text-3xl font-semibold text-text">{payload?.summary.status_events ?? 0}</p>
        </SectionCard>
      </div>

      <SectionCard title="Filtri audit" subtitle="Cerca per categoria, attore, servizio o dettaglio evento.">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-sm">
            Categoria
            <select className="input-saas mt-1" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value as "all" | TimelineRow["category"])}>
              <option value="all">Tutte</option>
              <option value="ops_audit">Audit operativo</option>
              <option value="pricing_audit">Pricing</option>
              <option value="export_audit">Export</option>
              <option value="report_job">Job report</option>
              <option value="status_event">Cambi stato</option>
            </select>
          </label>
          <label className="text-sm">
            Cerca
            <input className="input-saas mt-1" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="evento, attore, servizio, meta" />
          </label>
        </div>
      </SectionCard>

      <SectionCard title="Timeline audit unificata" subtitle="Tutte le azioni in ordine cronologico, con attore e dettaglio.">
        {filteredTimeline.length === 0 ? (
          <EmptyState title="Nessun evento audit" description="Non ci sono eventi che corrispondono al filtro attuale." compact />
        ) : (
          <div className="space-y-3">
            {filteredTimeline.map((item) => (
              <article key={item.id} className="rounded-2xl border border-border bg-surface/80 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-text">{item.title}</p>
                    <p className="text-xs text-muted">{item.detail}</p>
                  </div>
                  <span className="rounded-full bg-white px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] text-slate-700 shadow-sm">
                    {labelForCategory(item.category)}
                  </span>
                </div>
                <div className="mt-3 grid gap-1 text-xs text-muted md:grid-cols-2">
                  <p>Attore: {item.actor}</p>
                  <p>Quando: {new Date(item.at).toLocaleString("it-IT")}</p>
                </div>
                {Object.keys(item.meta ?? {}).length > 0 ? (
                  <pre className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-700">
                    {JSON.stringify(item.meta, null, 2)}
                  </pre>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </SectionCard>
    </section>
  );
}
