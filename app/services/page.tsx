"use client";

import { useState } from "react";
import Link from "next/link";
import { ServicesTable } from "@/components/services-table";
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
    <main className="min-h-screen bg-[#f5f8fc] px-4 py-5 md:px-6 lg:px-8">
      <section className="mx-auto w-full max-w-[1760px] space-y-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.24em] text-blue-500">Operazioni</p>
            <h1 className="mt-1 text-3xl font-black tracking-tight text-slate-950 md:text-4xl">Lista servizi</h1>
            <p className="mt-1 text-sm font-medium text-slate-500">
              {liveConnected ? "Dati operativi aggiornati in tempo reale." : "Dati operativi caricati dal tenant corrente."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/dashboard" className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 shadow-sm transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700">
              ← Cruscotto
            </Link>
            <button type="button" onClick={handleRefresh} className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 shadow-sm transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-50" disabled={loading}>
              Aggiorna
            </button>
            <Link href="/services/new" className="rounded-2xl bg-gradient-to-r from-blue-600 to-violet-600 px-5 py-3 text-sm font-black text-white shadow-[0_16px_34px_rgba(79,70,229,0.32)] transition hover:-translate-y-0.5">
              + Nuova prenotazione
            </Link>
          </div>
        </div>

        {errorMessage ? (
          <div className="rounded-3xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">{errorMessage}</div>
        ) : null}

        {loading ? (
          <div className="rounded-3xl border border-slate-200 bg-white p-5 text-sm font-semibold text-slate-500 shadow-sm">Caricamento servizi...</div>
        ) : (
          <ServicesTable hotels={data.hotels} memberships={data.memberships} refreshToken={refreshToken} />
        )}
      </section>
    </main>
  );
}
