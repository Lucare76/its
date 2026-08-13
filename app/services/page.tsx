"use client";

import Link from "next/link";
import { ServicesTable } from "@/components/services-table";
import { PageHeader } from "@/components/ui";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";

export default function ServicesPage() {
  const { data, errorMessage, liveConnected, loading, refresh } = useTenantOperationalData({ includeInboundEmails: true });

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 md:px-6 lg:px-8">
      <section className="page-section">
        <PageHeader
          title="Lista servizi"
          subtitle={liveConnected ? "Dati operativi aggiornati in tempo reale." : "Dati operativi caricati dal tenant corrente."}
          breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Lista servizi" }]}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Link href="/dashboard" className="btn-secondary px-3 py-1.5 text-xs">
                ← Cruscotto
              </Link>
              <button type="button" onClick={() => void refresh()} className="btn-secondary px-3 py-1.5 text-xs" disabled={loading}>
                Aggiorna
              </button>
              <Link href="/services/new" className="btn-primary px-3 py-1.5 text-xs">
                Nuova prenotazione
              </Link>
            </div>
          }
        />

        {errorMessage ? (
          <div className="card border-red-200 bg-red-50 p-4 text-sm text-red-700">{errorMessage}</div>
        ) : null}

        {loading ? (
          <div className="card p-4 text-sm text-slate-500">Caricamento servizi...</div>
        ) : (
          <ServicesTable
            services={data.services}
            hotels={data.hotels}
            assignments={data.assignments}
            memberships={data.memberships}
            statusEvents={data.statusEvents}
            inboundEmails={data.inboundEmails}
          />
        )}
      </section>
    </main>
  );
}
