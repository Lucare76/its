"use client";

import { useEffect, useMemo, useState } from "react";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";
import type { SummaryPreviewPayload } from "@/lib/server/operational-summary";

export default function AuditPage() {
  const { loading, errorMessage, data } = useTenantOperationalData();
  const [summaryPayload, setSummaryPayload] = useState<SummaryPreviewPayload | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!hasSupabaseEnv || !supabase) return;
      const { data, error } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (error || !token) return;
      const response = await fetch("/api/ops/summary-preview", { headers: { Authorization: `Bearer ${token}` } });
      const body = (await response.json().catch(() => null)) as { payload?: SummaryPreviewPayload } | null;
      if (!active) return;
      setSummaryPayload(body?.payload ?? null);
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  const recentStatusEvents = useMemo(
    () => [...data.statusEvents].sort((left, right) => right.at.localeCompare(left.at)).slice(0, 20),
    [data.statusEvents]
  );

  return (
    <section className="page-section">
      <PageHeader
        title="Audit"
        subtitle="Storico sintetico di export e cambi stato per tenere traccia delle azioni operative."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Audit" }]}
      />

      {errorMessage ? <EmptyState title="Audit non disponibile" description={errorMessage} compact /> : null}

      <div className="grid gap-3 md:grid-cols-3">
        <SectionCard title="Status events">
          <p className="text-3xl font-semibold text-text">{data.statusEvents.length}</p>
        </SectionCard>
        <SectionCard title="Export registrati">
          <p className="text-3xl font-semibold text-text">{summaryPayload?.export_history?.length ?? 0}</p>
        </SectionCard>
        <SectionCard title="Servizi nel tenant">
          <p className="text-3xl font-semibold text-text">{data.services.length}</p>
        </SectionCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <SectionCard title="Ultimi export" loading={loading} loadingLines={4}>
          {(summaryPayload?.export_history ?? []).length === 0 ? (
            <p className="text-sm text-muted">Nessun export registrato.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200">
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
                  {(summaryPayload?.export_history ?? []).map((item) => (
                    <tr key={item.id} className="border-t border-slate-100">
                      <td className="px-3 py-2">{new Date(item.created_at).toLocaleString("it-IT")}</td>
                      <td className="px-3 py-2">{`${item.date_from} -> ${item.date_to}`}</td>
                      <td className="px-3 py-2">{item.service_type}</td>
                      <td className="px-3 py-2">{item.exported_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        <SectionCard title="Ultimi cambi stato" loading={loading} loadingLines={4}>
          {recentStatusEvents.length === 0 ? (
            <p className="text-sm text-muted">Nessun cambio stato disponibile.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Data</th>
                    <th className="px-3 py-2">Servizio</th>
                    <th className="px-3 py-2">Stato</th>
                    <th className="px-3 py-2">Utente</th>
                  </tr>
                </thead>
                <tbody>
                  {recentStatusEvents.map((item) => (
                    <tr key={item.id} className="border-t border-slate-100">
                      <td className="px-3 py-2">{new Date(item.at).toLocaleString("it-IT")}</td>
                      <td className="px-3 py-2">{item.service_id.slice(0, 8)}...</td>
                      <td className="px-3 py-2">{item.status}</td>
                      <td className="px-3 py-2">{item.by_user_id ?? "system"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </div>
    </section>
  );
}
