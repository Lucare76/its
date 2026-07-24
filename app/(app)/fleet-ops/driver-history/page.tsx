"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DateInput, PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type DriverOption = {
  id: string;
  full_name: string;
  phone?: string | null;
};

type HistoryRow = {
  id: string;
  service_date: string;
  created_at: string;
  change_type: string;
  change_label: string;
  from_driver_name: string | null;
  to_driver_name: string | null;
  from_vehicle_label: string | null;
  to_vehicle_label: string | null;
  operator_name: string;
  service: {
    id: string;
    time: string | null;
    customer_name: string | null;
    pax: number | null;
    direction: string | null;
    vessel: string | null;
    zone: string | null;
  } | null;
  pattern_key: string | null;
  macro_category: string | null;
  time_slot: string | null;
};

type DriverSummary = {
  driver_profile_id: string;
  driver_name: string;
  total: number;
  swaps_in: number;
  swaps_out: number;
  vehicle_changes: number;
  last_change_at: string | null;
};

type LearnedPattern = {
  driver_profile_id: string;
  driver_name: string;
  pattern_key: string;
  total_count: number;
  correction_count: number;
  correction_rate: number;
  last_updated_at: string;
};

type Payload = {
  ok: true;
  range: { start: string; end: string };
  drivers: DriverOption[];
  filters: { change_types: Array<{ value: string; label: string }> };
  totals: {
    rows: number;
    driver_swaps: number;
    vehicle_bindings: number;
    auto_assign_accepted: number;
    resolution_suggestions: number;
    drivers_touched: number;
  };
  by_driver: DriverSummary[];
  patterns: LearnedPattern[];
  rows: HistoryRow[];
};

async function accessToken() {
  if (!hasSupabaseEnv || !supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

function dateDaysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  return new Date(`${value}T00:00:00`).toLocaleDateString("it-IT");
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  return new Date(value).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
}

function directionLabel(value: string | null | undefined) {
  if (value === "arrival") return "Arrivo";
  if (value === "departure") return "Partenza";
  return value ?? "-";
}

function pct(value: number) {
  return `${Math.round(value * 100)}%`;
}

export default function DriverAssignmentHistoryPage() {
  const [start, setStart] = useState(dateDaysAgo(30));
  const [end, setEnd] = useState(todayIso());
  const [driverId, setDriverId] = useState("");
  const [changeType, setChangeType] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const token = await accessToken();
    if (!token) {
      setLoading(false);
      setError("Sessione non valida.");
      return;
    }
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ start, end });
    if (driverId) params.set("driver_id", driverId);
    if (changeType) params.set("change_type", changeType);

    const response = await fetch(`/api/ops/driver-assignment-history?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const body = (await response.json().catch(() => null)) as Payload | { ok?: false; error?: string } | null;
    if (!response.ok || !body || body.ok !== true) {
      setError((body as { error?: string } | null)?.error ?? "Errore caricamento storico assegnazioni.");
      setLoading(false);
      return;
    }
    setPayload(body);
    setLoading(false);
  }, [changeType, driverId, end, start]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const visibleRows = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    if (!needle) return payload?.rows ?? [];
    return (payload?.rows ?? []).filter((row) => [
      row.change_label,
      row.from_driver_name,
      row.to_driver_name,
      row.from_vehicle_label,
      row.to_vehicle_label,
      row.operator_name,
      row.service?.customer_name,
      row.service?.vessel,
      row.service?.zone,
      row.pattern_key,
    ].some((value) => (value ?? "").toLowerCase().includes(needle)));
  }, [payload?.rows, searchQuery]);

  const selectedDriverName = payload?.drivers.find((driver) => driver.id === driverId)?.full_name ?? null;

  return (
    <section className="page-section">
      <PageHeader
        title="Storico assegnazioni autisti"
        subtitle="Consultazione read-only di cambi autista, cambi mezzo, auto-assign accettati e pattern appresi."
        breadcrumbs={[
          { label: "Operazioni", href: "/dashboard" },
          { label: "Flotta", href: "/fleet-ops" },
          { label: "Storico assegnazioni" },
        ]}
        actions={(
          <button type="button" onClick={() => void load()} className="btn-primary h-10 px-4 text-sm">
            Aggiorna
          </button>
        )}
      />

      {error ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      ) : null}

      <SectionCard title="Filtri" subtitle={selectedDriverName ? `Vista filtrata su ${selectedDriverName}` : "Ultimi 30 giorni per impostazione predefinita"}>
        <div className="grid gap-3 md:grid-cols-5">
          <label className="text-xs font-semibold text-slate-500">
            Da
            <DateInput className="input-saas mt-1 w-full" value={start} onChange={setStart} />
          </label>
          <label className="text-xs font-semibold text-slate-500">
            A
            <DateInput className="input-saas mt-1 w-full" value={end} onChange={setEnd} />
          </label>
          <label className="text-xs font-semibold text-slate-500">
            Autista
            <select className="input-saas mt-1 w-full" value={driverId} onChange={(event) => setDriverId(event.target.value)}>
              <option value="">Tutti</option>
              {payload?.drivers.map((driver) => (
                <option key={driver.id} value={driver.id}>{driver.full_name}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-500">
            Tipo evento
            <select className="input-saas mt-1 w-full" value={changeType} onChange={(event) => setChangeType(event.target.value)}>
              <option value="">Tutti</option>
              {payload?.filters.change_types.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-500">
            Cerca
            <input className="input-saas mt-1 w-full" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Autista, mezzo, cliente" />
          </label>
        </div>
      </SectionCard>

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        {[
          { label: "Eventi", value: payload?.totals.rows ?? 0, note: `${visibleRows.length} visibili` },
          { label: "Cambi autista", value: payload?.totals.driver_swaps ?? 0, note: "driver_swap" },
          { label: "Cambi mezzo", value: payload?.totals.vehicle_bindings ?? 0, note: "vehicle_binding" },
          { label: "Auto-assign ok", value: payload?.totals.auto_assign_accepted ?? 0, note: "accettati" },
          { label: "Risoluzioni", value: payload?.totals.resolution_suggestions ?? 0, note: "conflitti" },
          { label: "Autisti coinvolti", value: payload?.totals.drivers_touched ?? 0, note: "nel periodo" },
        ].map((item) => (
          <div key={item.label} className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{item.label}</p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{loading ? "..." : item.value}</p>
            <p className="mt-1 text-xs text-slate-500">{item.note}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]">
        <SectionCard title="Riepilogo per autista" subtitle="Chi ha avuto piu cambi o assegnazioni nel periodo">
          {loading ? (
            <p className="text-sm text-slate-400">Caricamento...</p>
          ) : !payload?.by_driver.length ? (
            <p className="py-8 text-center text-sm text-slate-400">Nessun dato autista nel periodo.</p>
          ) : (
            <div className="space-y-2">
              {payload.by_driver.slice(0, 10).map((row) => (
                <div key={row.driver_profile_id} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{row.driver_name}</p>
                      <p className="mt-1 text-xs text-slate-500">Ultimo cambio: {formatDateTime(row.last_change_at)}</p>
                    </div>
                    <span className="rounded-full bg-slate-900 px-3 py-1 text-xs font-bold text-white">{row.total}</span>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                    <span className="rounded-lg bg-emerald-50 px-2 py-1 text-emerald-700">In: {row.swaps_in}</span>
                    <span className="rounded-lg bg-amber-50 px-2 py-1 text-amber-700">Out: {row.swaps_out}</span>
                    <span className="rounded-lg bg-sky-50 px-2 py-1 text-sky-700">Mezzi: {row.vehicle_changes}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Pattern appresi" subtitle="Statistiche tracciate, non usate per assegnare automaticamente">
          {loading ? (
            <p className="text-sm text-slate-400">Caricamento...</p>
          ) : !payload?.patterns.length ? (
            <p className="py-8 text-center text-sm text-slate-400">Nessun pattern disponibile per i filtri correnti.</p>
          ) : (
            <div className="space-y-2">
              {payload.patterns.slice(0, 8).map((pattern) => (
                <div key={`${pattern.driver_profile_id}-${pattern.pattern_key}`} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-800">{pattern.driver_name}</p>
                      <p className="mt-1 break-all font-mono text-[11px] text-slate-500">{pattern.pattern_key}</p>
                    </div>
                    <span className="rounded-full bg-white px-2 py-1 text-xs font-bold text-slate-700">{pattern.total_count}</span>
                  </div>
                  <p className="mt-2 text-xs text-slate-500">Correzioni: {pattern.correction_count} - tasso {pct(pattern.correction_rate)}</p>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard title="Cronologia eventi" subtitle="Dettaglio read-only degli eventi registrati">
        {loading ? (
          <p className="text-sm text-slate-400">Caricamento...</p>
        ) : visibleRows.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-400">Nessun evento per i filtri correnti.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  <th className="pb-3 pr-4">Data servizio</th>
                  <th className="pb-3 pr-4">Evento</th>
                  <th className="pb-3 pr-4">Autista</th>
                  <th className="pb-3 pr-4">Mezzo</th>
                  <th className="pb-3 pr-4">Servizio</th>
                  <th className="pb-3 pr-4">Operatore</th>
                  <th className="pb-3">Registrato</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibleRows.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50">
                    <td className="py-3 pr-4 font-semibold text-slate-800">{formatDate(row.service_date)}</td>
                    <td className="py-3 pr-4">
                      <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-700">{row.change_label}</span>
                      {row.macro_category ? <p className="mt-1 text-xs text-slate-400">{row.macro_category}{row.time_slot ? ` - ${row.time_slot}` : ""}</p> : null}
                    </td>
                    <td className="py-3 pr-4 text-slate-700">
                      <p>{row.from_driver_name ?? "-"} -&gt; <strong>{row.to_driver_name ?? "-"}</strong></p>
                    </td>
                    <td className="py-3 pr-4 text-slate-700">
                      <p>{row.from_vehicle_label ?? "-"} -&gt; <strong>{row.to_vehicle_label ?? "-"}</strong></p>
                    </td>
                    <td className="py-3 pr-4 text-slate-600">
                      {row.service ? (
                        <>
                          <p className="font-medium text-slate-800">{row.service.customer_name ?? "Cliente non indicato"}</p>
                          <p className="text-xs text-slate-500">
                            {row.service.time ?? "--:--"} - {directionLabel(row.service.direction)} - {row.service.pax ?? 0} pax
                            {row.service.vessel ? ` - ${row.service.vessel}` : ""}
                          </p>
                        </>
                      ) : "-"}
                    </td>
                    <td className="py-3 pr-4 text-slate-600">{row.operator_name}</td>
                    <td className="py-3 text-xs text-slate-500">{formatDateTime(row.created_at)}</td>
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
