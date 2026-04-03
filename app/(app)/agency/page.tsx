"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type BookingRow = {
  id: string;
  status: string;
  customer_name: string;
  arrival_date: string | null;
  arrival_time: string | null;
  departure_date: string | null;
  departure_time: string | null;
  booking_service_kind: string | null;
  email_confirmation_status: string | null;
  hotel_name: string;
};

function formatDate(date: string | null, time: string | null) {
  if (!date) return "-";
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year.slice(2)}${time ? ` ${time.slice(0, 5)}` : ""}`;
}

export default function AgencyPage() {
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("Carichiamo il riepilogo delle tue richieste.");
  const [rows, setRows] = useState<BookingRow[]>([]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!hasSupabaseEnv || !supabase) {
        setMessage("Area agenzia disponibile solo con Supabase reale.");
        setLoading(false);
        return;
      }

      const session = await supabase.auth.getSession();
      if (!active) return;
      const token = session.data.session?.access_token;
      if (!token) {
        setMessage("Sessione non valida. Rifai login.");
        setLoading(false);
        return;
      }

      const response = await fetch("/api/agency/bookings?limit=250", {
        headers: { Authorization: `Bearer ${token}` }
      });
      const body = (await response.json().catch(() => null)) as { rows?: BookingRow[]; error?: string } | null;
      if (!active) return;
      if (!response.ok) {
        setMessage(body?.error ?? "Errore caricamento area agenzia.");
        setLoading(false);
        return;
      }

      setRows(body?.rows ?? []);
      setMessage("Area agenzia aggiornata.");
      setLoading(false);
    };

    void load();
    return () => {
      active = false;
    };
  }, []);

  const summary = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = rows.filter((row) => (row.arrival_date ?? row.departure_date ?? row.id) >= today);
    return {
      total: rows.length,
      upcoming: upcoming.length,
      waitingReview: rows.filter((row) => row.status === "needs_review").length,
      confirmationsPending: rows.filter((row) => row.email_confirmation_status === "pending" || row.email_confirmation_status === "failed").length,
      latest: upcoming.slice(0, 5)
    };
  }, [rows]);

  return (
    <section className="page-section">
      <PageHeader
        title="Area Agenzia"
        subtitle="Workspace agenzia per controllare richieste, prossimi servizi e conferme operative."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Area Agenzia" }]}
      />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SectionCard title="Prenotazioni totali" subtitle="Storico visibile in area agenzia" loading={loading}>
          <p className="text-3xl font-semibold text-text">{summary.total}</p>
        </SectionCard>
        <SectionCard title="Prossimi servizi" subtitle="Arrivi o partenze future" loading={loading}>
          <p className="text-3xl font-semibold text-text">{summary.upcoming}</p>
        </SectionCard>
        <SectionCard title="Da verificare" subtitle="Servizi ancora in review" loading={loading}>
          <p className="text-3xl font-semibold text-text">{summary.waitingReview}</p>
        </SectionCard>
        <SectionCard title="Conferme email" subtitle="Pending o fallite" loading={loading}>
          <p className="text-3xl font-semibold text-text">{summary.confirmationsPending}</p>
        </SectionCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <SectionCard title="Azioni rapide" subtitle="Le due cose principali che l'agenzia fa ogni giorno.">
          <div className="grid gap-3 md:grid-cols-2">
            <Link href="/agency/new-booking" className="rounded-2xl border border-primary bg-white p-4 shadow-sm">
              <p className="text-sm font-semibold text-text">Nuova prenotazione</p>
              <p className="mt-1 text-xs text-muted">Crea una nuova richiesta manuale con formula o transfer dedicato.</p>
            </Link>
            <Link href="/agency/bookings" className="rounded-2xl border border-border bg-surface/80 p-4">
              <p className="text-sm font-semibold text-text">Le mie prenotazioni</p>
              <p className="mt-1 text-xs text-muted">Apri lo storico con filtri, stati e dettaglio completo del servizio.</p>
            </Link>
          </div>
          <div className="mt-3 rounded-2xl border border-border bg-surface/80 p-4 text-sm text-muted">{message}</div>
        </SectionCard>

        <SectionCard title="Prossimi servizi agenzia" subtitle="Le prossime richieste in calendario viste lato agenzia." loading={loading} loadingLines={5}>
          {summary.latest.length === 0 ? (
            <EmptyState title="Nessun servizio in programma" description="Quando ci saranno arrivi o partenze future, li vedrai qui." compact />
          ) : (
            <div className="space-y-3">
              {summary.latest.map((row) => (
                <article key={row.id} className="rounded-2xl border border-border bg-surface/80 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-text">{row.customer_name}</p>
                      <p className="text-xs text-muted">{row.hotel_name}</p>
                    </div>
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] text-slate-700">
                      {row.status}
                    </span>
                  </div>
                  <div className="mt-2 grid gap-1 text-xs text-muted md:grid-cols-2">
                    <p>Arrivo: {formatDate(row.arrival_date, row.arrival_time)}</p>
                    <p>Partenza: {formatDate(row.departure_date, row.departure_time)}</p>
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
