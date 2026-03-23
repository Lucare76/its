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

  const grouped = useMemo(() => {
    const rows = payload?.export_history ?? [];
    return rows.reduce<Record<string, typeof rows>>((acc, row) => {
      const key = row.created_at.slice(0, 10);
      acc[key] = [...(acc[key] ?? []), row];
      return acc;
    }, {});
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
          <p className="text-3xl font-semibold text-text">
            {(payload?.export_history ?? []).reduce((sum, row) => sum + row.exported_count, 0)}
          </p>
          <p className="mt-1 text-sm text-muted">Servizi passati dai report storici</p>
        </SectionCard>
      </div>

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
                      {rows.length} export · {rows.reduce((sum, row) => sum + row.exported_count, 0)} servizi
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
                            <td className="px-3 py-2">{row.date_from} → {row.date_to}</td>
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
    </section>
  );
}
