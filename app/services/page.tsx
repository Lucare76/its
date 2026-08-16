"use client";

import { useState } from "react";
import Link from "next/link";
import { ServicesTable } from "@/components/services-table";
import { PageHeader } from "@/components/ui";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export default function ServicesPage() {
  const [refreshToken, setRefreshToken] = useState(0);
  // Sprint Performance 14A: this page only needs the bounded reference
  // datasets (hotels, memberships) up front — the services list itself is
  // fetched paginated/server-filtered by ServicesTable via /api/services/list.
  // `serviceScope` here intentionally excludes "services" from `datasets`, so
  // the tenant-data route never runs fetchAllServices() for this page.
  const { data, errorMessage, liveConnected, loading, refresh } = useTenantOperationalData({
    datasets: { hotels: true, memberships: true },
    serviceScope: { mode: "date", date: todayIso() }
  });

  const handleRefresh = () => {
    void refresh();
    setRefreshToken((value) => value + 1);
  };

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
              <button type="button" onClick={handleRefresh} className="btn-secondary px-3 py-1.5 text-xs" disabled={loading}>
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
          <ServicesTable hotels={data.hotels} memberships={data.memberships} refreshToken={refreshToken} />
        )}
      </section>
    </main>
  );
}
