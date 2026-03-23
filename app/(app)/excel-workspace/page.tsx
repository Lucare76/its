"use client";

import { useEffect, useState } from "react";
import { OpsArrivalsExportButtons } from "@/components/ops-arrivals-export-buttons";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import type { SummaryPreviewPayload } from "@/lib/server/operational-summary";

export default function ExcelWorkspacePage() {
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
        setErrorMessage(body?.error ?? "Impossibile caricare il workspace Excel.");
        setPayload(null);
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
        title="Excel Workspace"
        subtitle="Centro unico per export operativi, storico file e uso cliente."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Excel Workspace" }]}
        actions={
          <label className="text-sm">
            Data base
            <input type="date" value={today} onChange={(event) => setToday(event.target.value)} className="input-saas mt-1 min-w-40" />
          </label>
        }
      />

      {errorMessage ? <EmptyState title="Workspace Excel non disponibile" description={errorMessage} compact /> : null}

      <div className="grid gap-3 md:grid-cols-3">
        <SectionCard title="Obiettivo 1">
          <p className="text-sm text-text">Separare `linea bus` da `altri servizi` per arrivi e partenze.</p>
        </SectionCard>
        <SectionCard title="Obiettivo 2">
          <p className="text-sm text-text">Produrre un foglio `Operativo cliente` leggibile e pronto da condividere.</p>
        </SectionCard>
        <SectionCard title="Obiettivo 3">
          <p className="text-sm text-text">Tenere traccia di cosa e quando viene esportato nel tenant.</p>
        </SectionCard>
      </div>

      {payload ? <OpsArrivalsExportButtons targetDate={payload.target_date_48h} /> : null}

      <SectionCard title="Storico file" subtitle="Ultimi export registrati" loading={loading} loadingLines={4}>
        {(payload?.export_history ?? []).length === 0 ? (
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
                {(payload?.export_history ?? []).map((item) => (
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
    </section>
  );
}
