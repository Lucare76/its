"use client";

import { useMemo } from "react";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { getServicePdfOperationalMeta } from "@/lib/service-pdf-metadata";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";

export default function NotificationsPage() {
  const { loading, errorMessage, data } = useTenantOperationalData({ includeInboundEmails: true });

  const assignmentsByServiceId = useMemo(() => new Map(data.assignments.map((item) => [item.service_id, item])), [data.assignments]);
  const alerts = useMemo(() => {
    const items: Array<{ id: string; title: string; detail: string; severity: "high" | "medium" | "low" }> = [];

    for (const service of data.services) {
      const pdfMeta = getServicePdfOperationalMeta(service, data.inboundEmails);
      if (pdfMeta.reviewRecommended) {
        items.push({
          id: `${service.id}-review`,
          title: "Review operativa consigliata",
          detail: `${service.customer_name} | ${pdfMeta.agencyName ?? "PDF"} | parser ${pdfMeta.parserKey ?? "n/d"}`,
          severity: "high"
        });
      }
      if (!assignmentsByServiceId.get(service.id)?.driver_user_id && service.status !== "completato" && service.status !== "cancelled") {
        items.push({
          id: `${service.id}-dispatch`,
          title: "Servizio da gestire internamente",
          detail: `${service.customer_name} | stato ${service.status} | nessun autista assegnato`,
          severity: "medium"
        });
      }
      if (!service.applied_pricing_rule_id && service.status !== "cancelled") {
        items.push({
          id: `${service.id}-pricing`,
          title: "Servizio senza regola tariffaria",
          detail: `${service.customer_name} | ${service.booking_service_kind ?? service.service_type_code ?? "servizio"}`,
          severity: "low"
        });
      }
      if (service.reminder_status === "failed") {
        items.push({
          id: `${service.id}-reminder`,
          title: "Reminder fallito",
          detail: `${service.customer_name} | promemoria non inviato correttamente`,
          severity: "high"
        });
      }
    }

    return items;
  }, [assignmentsByServiceId, data.inboundEmails, data.services]);

  const groups = {
    high: alerts.filter((item) => item.severity === "high"),
    medium: alerts.filter((item) => item.severity === "medium"),
    low: alerts.filter((item) => item.severity === "low")
  };

  return (
    <section className="page-section">
      <PageHeader
        title="Centro notifiche"
        subtitle="Servizi urgenti, review mancanti, reminder falliti e anomalie pricing."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Notifiche" }]}
      />

      {errorMessage ? <EmptyState title="Notifiche non disponibili" description={errorMessage} compact /> : null}

      <div className="grid gap-3 md:grid-cols-3">
        <SectionCard title="Alta priorita">
          <p className="text-3xl font-semibold text-rose-700">{groups.high.length}</p>
        </SectionCard>
        <SectionCard title="Media priorita">
          <p className="text-3xl font-semibold text-amber-700">{groups.medium.length}</p>
        </SectionCard>
        <SectionCard title="Bassa priorita">
          <p className="text-3xl font-semibold text-slate-900">{groups.low.length}</p>
        </SectionCard>
      </div>

      <SectionCard title="Lista notifiche" loading={loading} loadingLines={6}>
        {alerts.length === 0 ? (
          <p className="text-sm text-muted">Nessuna notifica operativa aperta.</p>
        ) : (
          <div className="space-y-2">
            {alerts.map((item) => (
              <article key={item.id} className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-text">{item.title}</p>
                  <span className={item.severity === "high" ? "rounded-full bg-rose-100 px-2 py-1 text-[11px] font-semibold uppercase text-rose-700" : item.severity === "medium" ? "rounded-full bg-amber-100 px-2 py-1 text-[11px] font-semibold uppercase text-amber-700" : "rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold uppercase text-slate-600"}>
                    {item.severity}
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted">{item.detail}</p>
              </article>
            ))}
          </div>
        )}
      </SectionCard>
    </section>
  );
}
