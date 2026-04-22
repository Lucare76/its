"use client";

import { useEffect, useState } from "react";
import { PageHeader, SectionCard, StatCard } from "@/components/ui";
import { supabase } from "@/lib/supabase/client";
import Link from "next/link";

type DriverKpi = {
  driver_user_id: string;
  full_name: string;
  total: number;
  completed: number;
  pax: number;
  arrivals: number;
  departures: number;
};

type Period = "7" | "30" | "all";

const PERIOD_LABELS: Record<Period, string> = {
  "7": "7 giorni",
  "30": "30 giorni",
  all: "Tutto",
};

export default function DriverKpiPage() {
  const [period, setPeriod] = useState<Period>("30");
  const [kpi, setKpi] = useState<DriverKpi[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!supabase) return;
      setLoading(true);
      setError(null);
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        if (!token) { setError("Sessione scaduta."); return; }
        const res = await fetch(`/api/ops/driver-kpi?days=${period}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = await res.json().catch(() => null) as { ok?: boolean; kpi?: DriverKpi[]; error?: string } | null;
        if (!active) return;
        if (!res.ok || !body?.ok) {
          setError(body?.error && body.error !== "Bad Request" ? body.error : "KPI autisti non disponibili per il periodo selezionato.");
          return;
        }
        setKpi(body.kpi ?? []);
      } catch {
        if (active) setError("Errore di rete.");
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [period]);

  const totalServices  = kpi.reduce((s, d) => s + d.total, 0);
  const totalCompleted = kpi.reduce((s, d) => s + d.completed, 0);
  const totalPax       = kpi.reduce((s, d) => s + d.pax, 0);

  return (
    <section className="page-section">
      <PageHeader
        title="KPI Autisti"
        subtitle="Performance degli autisti per il periodo selezionato."
        breadcrumbs={[
          { label: "Flotta e mezzi", href: "/fleet-ops" },
          { label: "KPI Autisti" },
        ]}
        actions={
          <div className="flex items-center gap-2">
            {(["7", "30", "all"] as Period[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                className={`rounded-xl border px-3 py-2 text-xs font-semibold transition ${
                  period === p
                    ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {PERIOD_LABELS[p]}
              </button>
            ))}
            <Link
              href="/fleet-ops"
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition"
            >
              ← Flotta
            </Link>
          </div>
        }
      />

      <div className="grid gap-3 lg:grid-cols-3">
        <StatCard
          label="Servizi assegnati"
          value={String(totalServices)}
          hint={`Ultimi ${period === "all" ? "tutti i periodi" : PERIOD_LABELS[period]}`}
          loading={loading}
        />
        <StatCard
          label="Completati"
          value={String(totalCompleted)}
          hint={`${totalServices ? Math.round((totalCompleted / totalServices) * 100) : 0}% del totale assegnato`}
          loading={loading}
        />
        <StatCard
          label="Pax totali"
          value={String(totalPax)}
          hint="Passeggeri trasportati nel periodo"
          loading={loading}
        />
      </div>

      <SectionCard title="Performance per autista" subtitle={`Periodo: ${PERIOD_LABELS[period]}`} loading={loading}>
        {error && (
          <div className="mb-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
        )}
        {!loading && kpi.length === 0 ? (
          <p className="text-sm text-muted">Nessun dato disponibile per il periodo selezionato.</p>
        ) : (
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            {/* Header */}
            <div className="grid grid-cols-[minmax(160px,2fr)_72px_90px_72px_72px_72px] items-center gap-3 border-b border-slate-100 bg-slate-50/90 px-4 py-2.5 text-[11px] uppercase tracking-wide text-slate-500">
              <div>Autista</div>
              <div className="text-right">Servizi</div>
              <div className="text-right">Completati</div>
              <div className="text-right">Pax</div>
              <div className="text-right">Arrivi</div>
              <div className="text-right">Partenze</div>
            </div>
            <div className="divide-y divide-slate-100">
              {kpi.map((d) => {
                const pct = d.total ? Math.round((d.completed / d.total) * 100) : 0;
                return (
                  <div
                    key={d.driver_user_id}
                    className="grid grid-cols-[minmax(160px,2fr)_72px_90px_72px_72px_72px] items-center gap-3 px-4 py-3 transition hover:bg-slate-50/60"
                  >
                    <div>
                      <p className="text-sm font-semibold text-slate-800">{d.full_name}</p>
                    </div>
                    <div className="text-right">
                      <span className="text-sm font-bold text-slate-800">{d.total}</span>
                    </div>
                    <div className="text-right">
                      <span className={`text-sm font-bold ${pct >= 80 ? "text-emerald-600" : pct >= 50 ? "text-amber-600" : "text-rose-600"}`}>
                        {d.completed}
                      </span>
                      <span className="ml-1 text-[10px] text-slate-400">{pct}%</span>
                    </div>
                    <div className="text-right">
                      <span className="text-sm font-semibold text-slate-700">{d.pax}</span>
                    </div>
                    <div className="text-right">
                      <span className="inline-flex items-center rounded-full border border-blue-100 bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700">
                        ↓ {d.arrivals}
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="inline-flex items-center rounded-full border border-violet-100 bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700">
                        ↑ {d.departures}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </SectionCard>
    </section>
  );
}
