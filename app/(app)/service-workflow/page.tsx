"use client";

import { useMemo } from "react";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";
import type { ServiceStatus } from "@/lib/types";

const statusLabels: Array<{ status: ServiceStatus; label: string; detail: string }> = [
  { status: "needs_review", label: "Da verificare", detail: "Servizi che richiedono ancora controllo operatore." },
  { status: "new", label: "Pronti operativi", detail: "Servizi confermati e pronti per entrare nell'operativo." },
  { status: "assigned", label: "Presi in carico", detail: "Servizi con scheda interna o assegnazione parziale." },
  { status: "partito", label: "In corso", detail: "Servizi avviati e attivi in giornata." },
  { status: "arrivato", label: "Arrivati", detail: "Servizi conclusi lato arrivo ma non ancora chiusi." },
  { status: "completato", label: "Chiusi", detail: "Servizi chiusi amministrativamente." },
  { status: "problema", label: "Con problema", detail: "Servizi che richiedono intervento operativo." },
  { status: "cancelled", label: "Annullati", detail: "Servizi annullati e fuori dal lotto operativo." }
];

function formatDateLabel(dateIso: string) {
  const [year, month, day] = dateIso.split("-");
  return day && month && year ? `${day}/${month}/${year.slice(2)}` : dateIso;
}

export default function ServiceWorkflowPage() {
  const { data, loading, errorMessage, liveConnected } = useTenantOperationalData();

  const workflow = useMemo(() => {
    const counts = new Map<ServiceStatus, number>();
    for (const item of statusLabels) counts.set(item.status, 0);

    let withoutPricing = 0;
    let remindersFailed = 0;
    let internalOnly = 0;
    let futureOperational = 0;

    for (const service of data.services) {
      counts.set(service.status, (counts.get(service.status) ?? 0) + 1);
      if (!service.applied_pricing_rule_id) withoutPricing += 1;
      if (service.reminder_status === "failed") remindersFailed += 1;
      if (!service.notes.includes("[dispatch:handled-internally]")) internalOnly += 1;
      if (service.status === "new" || service.status === "assigned") futureOperational += 1;
    }

    const latest = [...data.services]
      .sort((left, right) => {
        const leftDate = `${left.date}T${left.time || "00:00"}`;
        const rightDate = `${right.date}T${right.time || "00:00"}`;
        return rightDate.localeCompare(leftDate);
      })
      .slice(0, 12);

    return {
      counts,
      withoutPricing,
      remindersFailed,
      internalOnly,
      futureOperational,
      latest
    };
  }, [data.services]);

  return (
    <section className="page-section">
      <PageHeader
        title="Workflow Servizi"
        subtitle="Vista unica dello stato operativo dei servizi, per capire cosa e fermo, cosa e pronto e cosa va chiuso."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Workflow Servizi" }]}
      />

      {errorMessage ? <EmptyState title="Workflow non disponibile" description={errorMessage} compact /> : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SectionCard title="Servizi totali" subtitle={liveConnected ? "Realtime attivo" : "Realtime non connesso"} loading={loading}>
          <p className="text-3xl font-semibold text-text">{data.services.length}</p>
          <p className="mt-1 text-sm text-muted">{workflow.futureOperational} nel flusso operativo aperto</p>
        </SectionCard>
        <SectionCard title="Senza regola tariffaria" subtitle="Da completare lato pricing" loading={loading}>
          <p className="text-3xl font-semibold text-text">{workflow.withoutPricing}</p>
          <p className="mt-1 text-sm text-muted">Servizi ancora senza pricing rule applicata</p>
        </SectionCard>
        <SectionCard title="Reminder falliti" subtitle="Richiedono controllo" loading={loading}>
          <p className="text-3xl font-semibold text-text">{workflow.remindersFailed}</p>
          <p className="mt-1 text-sm text-muted">Servizi con reminder o notifiche da ripetere</p>
        </SectionCard>
        <SectionCard title="Gestione interna" subtitle="Perimetro Ischia Transfer" loading={loading}>
          <p className="text-3xl font-semibold text-text">{workflow.internalOnly}</p>
          <p className="mt-1 text-sm text-muted">Servizi ancora da lavorare internamente</p>
        </SectionCard>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <SectionCard title="Funnel stati servizio" subtitle="Lettura rapida del flusso end-to-end" loading={loading} loadingLines={6}>
          <div className="space-y-3">
            {statusLabels.map((item) => (
              <article key={item.status} className="rounded-2xl border border-border bg-surface/80 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-text">{item.label}</p>
                    <p className="text-xs text-muted">{item.detail}</p>
                  </div>
                  <span className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-text shadow-sm">
                    {workflow.counts.get(item.status) ?? 0}
                  </span>
                </div>
              </article>
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Ultimi servizi nel workflow" subtitle="Controllo veloce su servizi recenti" loading={loading} loadingLines={6}>
          {workflow.latest.length === 0 ? (
            <p className="text-sm text-muted">Nessun servizio da mostrare.</p>
          ) : (
            <div className="space-y-3">
              {workflow.latest.map((service) => (
                <article key={service.id} className="rounded-2xl border border-border bg-surface/80 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-text">{service.customer_name}</p>
                      <p className="text-xs text-muted">
                        {formatDateLabel(service.date)} {service.time} · {service.billing_party_name ?? "Privato"}
                      </p>
                    </div>
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] text-slate-700">
                      {service.status}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted">
                    <span>{service.service_type_code ?? service.booking_service_kind ?? "N/D"}</span>
                    <span>{service.pax} pax</span>
                    <span>{service.customer_email ?? "senza email"}</span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </SectionCard>
      </div>
    </section>
  );
}
