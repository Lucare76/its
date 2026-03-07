"use client";

import { useEffect, useMemo, useState } from "react";
import { KpiCard } from "@/components/kpi-card";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type CountItem = {
  label: string;
  count: number;
};

type DriverWeeklyLoadItem = {
  driver_user_id: string;
  driver_name: string;
  total_assigned: number;
  by_day: {
    lun: number;
    mar: number;
    mer: number;
    gio: number;
    ven: number;
    sab: number;
    dom: number;
  };
};

type PunctualityRow = {
  service_id: string;
  date: string;
  time: string;
  customer_name: string;
  vessel: string;
  zone: string;
  hotel_name: string;
  scheduled_at: string;
  actual_at: string | null;
  delay_minutes: number | null;
  punctuality: "on_time" | "delayed" | "missing";
};

type AnalyticsPayload = {
  dateFrom: string;
  dateTo: string;
  punctualityThresholdMinutes: number;
  kpi: {
    totalServices: number;
    onTime: number;
    delayed: number;
    missing: number;
    evaluated: number;
    punctualityRate: number;
  };
  servicesByVessel: CountItem[];
  servicesByZone: CountItem[];
  driverWeeklyLoad: DriverWeeklyLoadItem[];
  punctualityTable: PunctualityRow[];
  weeklyWindow: {
    from: string;
    to: string;
  };
};

function formatDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function defaultRange() {
  const today = new Date();
  return {
    from: formatDate(addDays(today, -29)),
    to: formatDate(today)
  };
}

function SimpleBars({ items }: { items: CountItem[] }) {
  const max = items[0]?.count ?? 1;

  return (
    <div className="space-y-2">
      {items.slice(0, 8).map((item) => {
        const width = Math.max(8, Math.round((item.count / max) * 100));
        return (
          <div key={item.label} className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-text">{item.label}</span>
              <span className="text-muted">{item.count}</span>
            </div>
            <div className="h-2 rounded-full bg-slate-200">
              <div className="h-full rounded-full bg-blue-500" style={{ width: `${width}%` }} />
            </div>
          </div>
        );
      })}
      {items.length === 0 ? <p className="text-xs text-muted">Nessun dato nel periodo.</p> : null}
    </div>
  );
}

export default function AnalyticsPage() {
  const range = useMemo(() => defaultRange(), []);
  const [dateFrom, setDateFrom] = useState(range.from);
  const [dateTo, setDateTo] = useState(range.to);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AnalyticsPayload | null>(null);

  const loadAnalytics = async () => {
    if (!hasSupabaseEnv || !supabase) {
      setError("Supabase non configurato.");
      return;
    }

    if (!dateFrom || !dateTo || dateFrom > dateTo) {
      setError("Intervallo date non valido.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !sessionData.session?.access_token) {
        setError("Sessione non valida. Esegui di nuovo il login.");
        setLoading(false);
        return;
      }

      const response = await fetch(`/api/analytics/summary?dateFrom=${dateFrom}&dateTo=${dateTo}`, {
        headers: {
          Authorization: `Bearer ${sessionData.session.access_token}`
        }
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Errore caricamento analytics.");
        setLoading(false);
        return;
      }

      const payload = (await response.json()) as AnalyticsPayload;
      setData(payload);
    } catch {
      setError("Errore rete durante il caricamento analytics.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAnalytics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const exportExcel = async () => {
    if (!hasSupabaseEnv || !supabase) {
      setError("Supabase non configurato.");
      return;
    }
    if (!dateFrom || !dateTo || dateFrom > dateTo) {
      setError("Intervallo date non valido.");
      return;
    }

    setExporting(true);
    setError(null);

    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !sessionData.session?.access_token) {
        setError("Sessione non valida. Esegui di nuovo il login.");
        setExporting(false);
        return;
      }

      const response = await fetch("/api/exports/analytics.xlsx", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionData.session.access_token}`
        },
        body: JSON.stringify({
          dateFrom,
          dateTo
        })
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Export analytics fallito.");
        setExporting(false);
        return;
      }

      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition");
      const match = disposition?.match(/filename=\"?([^"]+)\"?/i);
      const filename = match?.[1] ?? `analytics_report_${dateFrom}_${dateTo}.xlsx`;

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("Errore rete durante export analytics.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="space-y-4">
      <header className="card space-y-3 p-4">
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted">
            Data da
            <input type="date" className="input-saas mt-1 w-full min-w-[150px]" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
          </label>
          <label className="text-xs text-muted">
            Data a
            <input type="date" className="input-saas mt-1 w-full min-w-[150px]" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
          </label>
          <button type="button" onClick={() => void loadAnalytics()} disabled={loading} className="btn-primary h-[42px] px-4 text-sm disabled:opacity-50">
            {loading ? "Caricamento..." : "Aggiorna"}
          </button>
          <button type="button" onClick={() => void exportExcel()} disabled={exporting} className="btn-secondary h-[42px] px-4 text-sm disabled:opacity-50">
            {exporting ? "Export..." : "Export Excel"}
          </button>
        </div>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </header>

      {!data ? (
        <div className="card p-4 text-sm text-muted">Nessun dato analytics disponibile.</div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Servizi periodo" value={String(data.kpi.totalServices)} hint={`${data.dateFrom} - ${data.dateTo}`} />
            <KpiCard label="On time" value={String(data.kpi.onTime)} hint={`Soglia ${data.punctualityThresholdMinutes} min`} />
            <KpiCard label="In ritardo" value={String(data.kpi.delayed)} hint="Ritardo oltre soglia" />
            <article className="card p-4">
              <p className="text-xs uppercase tracking-[0.16em] text-muted">Puntualita</p>
              <p className="mt-2 text-5xl font-bold tracking-[-0.02em] text-text">{data.kpi.punctualityRate}%</p>
              <p className="mt-2 text-xs text-muted">
                Valutati: {data.kpi.evaluated} | Missing: {data.kpi.missing}
              </p>
            </article>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <article className="card space-y-3 p-4">
              <h3 className="text-sm font-semibold">Servizi per nave</h3>
              <SimpleBars items={data.servicesByVessel} />
            </article>
            <article className="card space-y-3 p-4">
              <h3 className="text-sm font-semibold">Servizi per zona</h3>
              <SimpleBars items={data.servicesByZone} />
            </article>
          </div>

          <article className="card space-y-3 p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Carico driver settimanale</h3>
              <p className="text-xs text-muted">
                Settimana: {data.weeklyWindow.from} - {data.weeklyWindow.to}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-xs">
                <thead className="text-muted">
                  <tr>
                    <th className="px-2 py-2">Driver</th>
                    <th className="px-2 py-2">Totale</th>
                    <th className="px-2 py-2">Lun</th>
                    <th className="px-2 py-2">Mar</th>
                    <th className="px-2 py-2">Mer</th>
                    <th className="px-2 py-2">Gio</th>
                    <th className="px-2 py-2">Ven</th>
                    <th className="px-2 py-2">Sab</th>
                    <th className="px-2 py-2">Dom</th>
                  </tr>
                </thead>
                <tbody>
                  {data.driverWeeklyLoad.map((item) => (
                    <tr key={item.driver_user_id} className="border-t border-border/70">
                      <td className="px-2 py-2 font-medium">{item.driver_name}</td>
                      <td className="px-2 py-2">{item.total_assigned}</td>
                      <td className="px-2 py-2">{item.by_day.lun}</td>
                      <td className="px-2 py-2">{item.by_day.mar}</td>
                      <td className="px-2 py-2">{item.by_day.mer}</td>
                      <td className="px-2 py-2">{item.by_day.gio}</td>
                      <td className="px-2 py-2">{item.by_day.ven}</td>
                      <td className="px-2 py-2">{item.by_day.sab}</td>
                      <td className="px-2 py-2">{item.by_day.dom}</td>
                    </tr>
                  ))}
                  {data.driverWeeklyLoad.length === 0 ? (
                    <tr>
                      <td className="px-2 py-3 text-muted" colSpan={9}>
                        Nessuna assegnazione driver nella settimana.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </article>

          <article className="card space-y-3 p-4">
            <h3 className="text-sm font-semibold">Tabella puntualita servizi</h3>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-xs">
                <thead className="text-muted">
                  <tr>
                    <th className="px-2 py-2">Data/Ora</th>
                    <th className="px-2 py-2">Cliente</th>
                    <th className="px-2 py-2">Nave</th>
                    <th className="px-2 py-2">Zona</th>
                    <th className="px-2 py-2">Effettivo</th>
                    <th className="px-2 py-2">Delta min</th>
                    <th className="px-2 py-2">Esito</th>
                  </tr>
                </thead>
                <tbody>
                  {data.punctualityTable.slice(0, 120).map((row) => (
                    <tr key={row.service_id} className="border-t border-border/70">
                      <td className="px-2 py-2">
                        {row.date} {row.time}
                      </td>
                      <td className="px-2 py-2">{row.customer_name}</td>
                      <td className="px-2 py-2">{row.vessel}</td>
                      <td className="px-2 py-2">{row.zone}</td>
                      <td className="px-2 py-2">{row.actual_at ? new Date(row.actual_at).toLocaleString() : "-"}</td>
                      <td className="px-2 py-2">{row.delay_minutes ?? "-"}</td>
                      <td className="px-2 py-2">
                        <span
                          className={`status-badge ${
                            row.punctuality === "on_time"
                              ? "status-badge-completato"
                              : row.punctuality === "delayed"
                                ? "status-badge-cancelled"
                                : "status-badge-assigned"
                          }`}
                        >
                          {row.punctuality}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {data.punctualityTable.length === 0 ? (
                    <tr>
                      <td className="px-2 py-3 text-muted" colSpan={7}>
                        Nessun servizio nel periodo selezionato.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </article>
        </>
      )}
    </section>
  );
}
