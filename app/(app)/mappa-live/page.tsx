"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import type { GpsControlRoomEntry } from "@/lib/types";

const DynamicMap = dynamic(() => import("@/components/control-room-map").then((mod) => mod.ControlRoomMap), {
  ssr: false,
  loading: () => <div className="card p-4 text-sm text-slate-500">Caricamento control room...</div>
});

const DEFAULT_REFRESH_SECONDS = 60;

type ControlRoomPayload = {
  ok?: boolean;
  error?: string;
  entries?: GpsControlRoomEntry[];
  summary?: {
    total: number;
    moving: number;
    stopped: number;
    warning: number;
    offline: number;
    blocked: number;
  };
  fetched_at?: string;
};

function formatRelativeSeconds(seconds: number) {
  if (seconds < 60) return `${seconds}s fa`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min fa`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h fa`;
}

function formatTime(ts: string | null) {
  if (!ts) return "N/D";
  try {
    return new Date(ts).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return ts;
  }
}

function statusMeta(status: GpsControlRoomEntry["status_key"]) {
  if (status === "moving") return { badge: "bg-emerald-100 text-emerald-800 border-emerald-200", dot: "bg-emerald-500", label: "In movimento" };
  if (status === "stopped") return { badge: "bg-rose-100 text-rose-800 border-rose-200", dot: "bg-rose-500", label: "Fermo" };
  if (status === "warning") return { badge: "bg-amber-100 text-amber-900 border-amber-200", dot: "bg-amber-500", label: "Warning" };
  return { badge: "bg-slate-200 text-slate-700 border-slate-300", dot: "bg-slate-500", label: "Offline" };
}

function focusSignals(entry: GpsControlRoomEntry) {
  const signals: Array<{ label: string; tone: string }> = [];
  if (entry.blocked) {
    signals.push({ label: "Mezzo bloccato", tone: "border-rose-200 bg-rose-50 text-rose-700" });
  }
  if (entry.anomalies_count > 0) {
    signals.push({
      label: `${entry.anomalies_count} anomal${entry.anomalies_count === 1 ? "ia aperta" : "ie aperte"}`,
      tone: entry.anomaly_severity === "blocking" || entry.anomaly_severity === "high" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-amber-200 bg-amber-50 text-amber-800"
    });
  }
  if (!entry.active_service) {
    signals.push({ label: "Nessun servizio PMS attivo", tone: "border-slate-200 bg-slate-50 text-slate-600" });
  }
  if (entry.current_city) {
    signals.push({ label: entry.current_city, tone: "border-sky-200 bg-sky-50 text-sky-700" });
  }
  return signals.slice(0, 4);
}

function entryPriority(entry: GpsControlRoomEntry) {
  if (entry.blocked || entry.anomaly_severity === "blocking" || entry.anomaly_severity === "high") return 0;
  if (entry.status_key === "stopped" && entry.active_service) return 1;
  if (entry.status_key === "warning" && entry.active_service) return 2;
  if (entry.status_key === "offline" && entry.active_service) return 3;
  if (entry.status_key === "stopped") return 4;
  if (entry.anomalies_count > 0) return 5;
  if (entry.active_service) return 6;
  if (entry.status_key === "warning") return 7;
  if (entry.status_key === "offline") return 8;
  return 9;
}

function priorityBadge(entry: GpsControlRoomEntry) {
  if (entry.blocked || entry.anomaly_severity === "blocking" || entry.anomaly_severity === "high") {
    return { label: "Critico", tone: "border-rose-200 bg-rose-50 text-rose-700" };
  }
  if (entry.status_key === "stopped" && entry.active_service) {
    return { label: "Fermo con servizio", tone: "border-rose-200 bg-rose-50 text-rose-700" };
  }
  if (entry.status_key === "warning" && entry.active_service) {
    return { label: "Da verificare", tone: "border-amber-200 bg-amber-50 text-amber-800" };
  }
  if (entry.status_key === "offline" && entry.active_service) {
    return { label: "Offline con servizio", tone: "border-slate-300 bg-slate-100 text-slate-700" };
  }
  if (entry.anomalies_count > 0) {
    return { label: "Anomalia aperta", tone: "border-amber-200 bg-amber-50 text-amber-800" };
  }
  if (entry.active_service) {
    return { label: "Servizio attivo", tone: "border-sky-200 bg-sky-50 text-sky-700" };
  }
  return null;
}

function smartAlerts(entry: GpsControlRoomEntry) {
  const alerts: Array<{ severity: "high" | "medium" | "low"; title: string; detail: string }> = [];
  if (entry.blocked) {
    alerts.push({
      severity: "high",
      title: "Mezzo bloccato",
      detail: entry.blocked_reason ?? "Verifica il fermo mezzo prima di assegnare nuovi servizi."
    });
  }
  if (entry.status_key === "offline" && entry.active_service) {
    alerts.push({
      severity: "high",
      title: "Offline con servizio attivo",
      detail: `${entry.active_service.time} • ${entry.active_service.customer_name}`
    });
  }
  if (entry.status_key === "stopped" && entry.active_service) {
    alerts.push({
      severity: "high",
      title: "Fermo con servizio attivo",
      detail: `${entry.active_service.time} • ${entry.active_service.customer_name}`
    });
  }
  if (entry.status_key === "warning" && entry.active_service) {
    alerts.push({
      severity: "medium",
      title: "Velocita bassa su servizio attivo",
      detail: `${entry.speed_kmh !== null ? `${Math.round(entry.speed_kmh)} km/h` : "velocita N/D"} • ${entry.active_service.customer_name}`
    });
  }
  if (entry.anomalies_count > 0) {
    alerts.push({
      severity: entry.anomaly_severity === "high" || entry.anomaly_severity === "blocking" ? "high" : "medium",
      title: `Anomali${entry.anomalies_count === 1 ? "a aperta" : "e aperte"}`,
      detail: `${entry.anomalies_count} segnalazion${entry.anomalies_count === 1 ? "e" : "i"} sul mezzo`
    });
  }
  if (!entry.active_service && entry.status_key === "moving") {
    alerts.push({
      severity: "low",
      title: "Mezzo in movimento senza servizio",
      detail: "Controlla se e un trasferimento non ancora collegato al PMS."
    });
  }
  return alerts;
}

function alertTone(severity: "high" | "medium" | "low") {
  if (severity === "high") return "border-rose-200 bg-rose-50 text-rose-800";
  if (severity === "medium") return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-sky-200 bg-sky-50 text-sky-800";
}

async function accessToken() {
  if (!hasSupabaseEnv || !supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export default function MappaLivePage() {
  const [entries, setEntries] = useState<GpsControlRoomEntry[]>([]);
  const [summary, setSummary] = useState<ControlRoomPayload["summary"] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lineFilter, setLineFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | GpsControlRoomEntry["status_key"]>("all");
  const [search, setSearch] = useState("");
  const [refreshSeconds, setRefreshSeconds] = useState(DEFAULT_REFRESH_SECONDS);
  const [countdown, setCountdown] = useState(DEFAULT_REFRESH_SECONDS);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchControlRoom = useEffectEvent(async (initial = false) => {
    const token = await accessToken();
    if (!token) {
      setError("Sessione non valida.");
      setLoading(false);
      setRefreshing(false);
      return;
    }

    if (initial) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }

    try {
      const response = await fetch("/api/gps/control-room", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store"
      });
      const body = (await response.json().catch(() => null)) as ControlRoomPayload | null;
      if (!response.ok || !body?.ok) {
        setError(body?.error ?? "Errore recupero control room.");
        setEntries([]);
        setSummary(null);
        return;
      }
      const nextEntries = body.entries ?? [];
      setEntries(nextEntries);
      setSummary(body.summary ?? null);
      setFetchedAt(body.fetched_at ?? new Date().toISOString());
      setSelectedId((current) => current ?? nextEntries[0]?.radius_vehicle_id ?? null);
      setError(null);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Errore di rete.");
      setEntries([]);
      setSummary(null);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  });

  const restartPolling = useEffectEvent(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);

    setCountdown(refreshSeconds);
    timerRef.current = setInterval(() => {
      void fetchControlRoom(false);
      setCountdown(refreshSeconds);
    }, refreshSeconds * 1000);

    countdownRef.current = setInterval(() => {
      setCountdown((current) => Math.max(0, current - 1));
    }, 1000);
  });

  useEffect(() => {
    void fetchControlRoom(true).then(() => restartPolling());
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [refreshSeconds]);

  const lineOptions = useMemo(
    () => Array.from(new Set(entries.map((entry) => entry.line_name).filter(Boolean) as string[])).sort(),
    [entries]
  );

  const filteredEntries = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return entries
      .filter((entry) => {
        const byLine = lineFilter === "all" || entry.line_name === lineFilter;
        const byStatus = statusFilter === "all" || entry.status_key === statusFilter;
        const haystack = [entry.pms_label, entry.label, entry.line_name, entry.driver_name, entry.plate, entry.active_service?.customer_name]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        const bySearch = needle.length === 0 || haystack.includes(needle);
        return byLine && byStatus && bySearch;
      })
      .sort((left, right) => {
        const byPriority = entryPriority(left) - entryPriority(right);
        if (byPriority !== 0) return byPriority;
        const byActiveService = Number(Boolean(right.active_service)) - Number(Boolean(left.active_service));
        if (byActiveService !== 0) return byActiveService;
        return left.last_update_seconds - right.last_update_seconds;
      });
  }, [entries, lineFilter, search, statusFilter]);

  const selected = useMemo(
    () => filteredEntries.find((entry) => entry.radius_vehicle_id === selectedId) ?? filteredEntries[0] ?? null,
    [filteredEntries, selectedId]
  );

  const visibleSummary = useMemo(
    () =>
      filteredEntries.reduce(
        (acc, entry) => {
          acc.total += 1;
          if (entry.status_key === "moving") acc.moving += 1;
          if (entry.status_key === "stopped") acc.stopped += 1;
          if (entry.status_key === "warning") acc.warning += 1;
          if (entry.status_key === "offline") {
            acc.offline += 1;
            if (entry.active_service) acc.offlineOperational += 1;
            else acc.offlineIdle += 1;
          }
          return acc;
        },
        { total: 0, moving: 0, stopped: 0, warning: 0, offline: 0, offlineOperational: 0, offlineIdle: 0 }
      ),
    [filteredEntries]
  );
  const fetchedAgoSeconds = fetchedAt ? Math.max(0, Math.floor((Date.now() - new Date(fetchedAt).getTime()) / 1000)) : null;
  const topAlerts = useMemo(
    () =>
      filteredEntries
        .flatMap((entry) =>
          smartAlerts(entry).map((alert) => ({
            ...alert,
            vehicleId: entry.radius_vehicle_id,
            vehicleLabel: entry.pms_label ?? entry.label
          }))
        )
        .sort((left, right) => {
          const rank = { high: 0, medium: 1, low: 2 };
          return rank[left.severity] - rank[right.severity];
        })
        .slice(0, 3),
    [filteredEntries]
  );
  const offlineOperationalEntries = useMemo(
    () =>
      filteredEntries
        .filter((entry) => entry.status_key === "offline" && entry.active_service)
        .sort((left, right) => left.last_update_seconds - right.last_update_seconds),
    [filteredEntries]
  );

  const handleManualRefresh = () => {
    setCountdown(refreshSeconds);
    void fetchControlRoom(false);
  };

  return (
    <section className="space-y-4">
      <PageHeader
        title="Mappa Operativa"
        subtitle="Control room live per monitorare flotta, anomalie e stato mezzi senza cambiare schermata."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Mappa Operativa" }]}
        actions={
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-[170px_170px_220px_170px_auto]">
            <label className="text-sm text-slate-600">
              Linea
              <select value={lineFilter} onChange={(event) => setLineFilter(event.target.value)} className="input-saas mt-1">
                <option value="all">Tutte</option>
                {lineOptions.map((line) => (
                  <option key={line} value={line}>
                    {line}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-slate-600">
              Stato
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "all" | GpsControlRoomEntry["status_key"])} className="input-saas mt-1">
                <option value="all">Tutti</option>
                <option value="moving">In movimento</option>
                <option value="stopped">Fermi</option>
                <option value="warning">Warning</option>
                <option value="offline">Offline</option>
              </select>
            </label>
            <label className="text-sm text-slate-600">
              Cerca bus
              <input value={search} onChange={(event) => setSearch(event.target.value)} className="input-saas mt-1" placeholder="Bus, autista, cliente..." />
            </label>
            <label className="text-sm text-slate-600">
              Refresh
              <select value={refreshSeconds} onChange={(event) => setRefreshSeconds(Number(event.target.value))} className="input-saas mt-1">
                <option value={20}>20 secondi</option>
                <option value={30}>30 secondi</option>
                <option value={60}>60 secondi</option>
              </select>
            </label>
            <div className="flex items-end">
              <button type="button" onClick={handleManualRefresh} className="btn-primary w-full px-4 py-2 text-sm xl:w-auto" disabled={refreshing}>
                {refreshing ? "Aggiorno..." : "Aggiorna ora"}
              </button>
            </div>
          </div>
        }
      />

      <div className="grid gap-3 md:grid-cols-5">
        <article className="rounded-[18px] border border-slate-200 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-3 min-h-[112px] shadow-[0_16px_40px_rgba(15,23,42,0.08)]">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Bus attivi</p>
          <p className="mt-1.5 text-[1.45rem] leading-none font-semibold text-slate-950">{visibleSummary.moving}</p>
          <p className="mt-1 text-[12px] text-slate-500">Movimento reale</p>
        </article>
        <article className="rounded-[18px] border border-slate-200 bg-[linear-gradient(180deg,#ffffff_0%,#fff7ed_100%)] p-3 min-h-[112px] shadow-[0_16px_40px_rgba(15,23,42,0.08)]">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Warning</p>
          <p className="mt-1.5 text-[1.45rem] leading-none font-semibold text-amber-700">{visibleSummary.warning}</p>
          <p className="mt-1 text-[12px] text-slate-500">Lenti o da verificare</p>
        </article>
        <article className="rounded-[18px] border border-slate-200 bg-[linear-gradient(180deg,#ffffff_0%,#fff1f2_100%)] p-3 min-h-[112px] shadow-[0_16px_40px_rgba(15,23,42,0.08)]">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Bus fermi</p>
          <p className="mt-1.5 text-[1.45rem] leading-none font-semibold text-rose-700">{visibleSummary.stopped}</p>
          <p className="mt-1 text-[12px] text-slate-500">Stop oltre soglia</p>
        </article>
        <article className="rounded-[18px] border border-rose-200 bg-[linear-gradient(180deg,#ffffff_0%,#fff1f2_100%)] p-3 min-h-[112px] shadow-[0_16px_40px_rgba(15,23,42,0.08)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Offline operativi</p>
              <p className="mt-1.5 text-[1.45rem] leading-none font-semibold text-rose-700">{visibleSummary.offlineOperational}</p>
              <p className="mt-1 text-[12px] text-slate-500">Mezzi offline con servizio attivo</p>
            </div>
            {visibleSummary.offline > 0 ? (
              <span className="inline-flex rounded-full border border-slate-200 bg-white/90 px-1.5 py-0.5 text-[9px] font-semibold text-slate-600">
                Tot {visibleSummary.offline}
              </span>
            ) : null}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            <div className="rounded-lg border border-rose-100 bg-white/80 px-2 py-1">
              <p className="text-[8px] font-semibold uppercase tracking-[0.12em] text-slate-400">Da gestire</p>
              <p className="mt-0.5 text-[14px] font-semibold text-rose-700">{visibleSummary.offlineOperational}</p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white/80 px-2 py-1">
              <p className="text-[8px] font-semibold uppercase tracking-[0.12em] text-slate-400">Fuori servizio</p>
              <p className="mt-0.5 text-[14px] font-semibold text-slate-700">{visibleSummary.offlineIdle}</p>
            </div>
          </div>
        </article>
        <article className="rounded-[18px] border border-slate-200 bg-[linear-gradient(180deg,#ffffff_0%,#eef2ff_100%)] p-3 min-h-[112px] shadow-[0_16px_40px_rgba(15,23,42,0.08)]">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Sistema</p>
          <p className="mt-1.5 text-[1.3rem] leading-none font-semibold text-slate-950">{summary ? "Operativo" : "In attesa"}</p>
          <p className="mt-1 text-[12px] text-slate-500">
            Ultimo aggiornamento: {fetchedAgoSeconds !== null ? `${formatRelativeSeconds(fetchedAgoSeconds)} • prossimo tra ${countdown}s` : "N/D"}
          </p>
        </article>
      </div>

      {error ? <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div> : null}

      {loading ? (
        <div className="card p-6 text-sm text-slate-500">Caricamento control room GPS...</div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(320px,0.9fr)]">
          <DynamicMap entries={filteredEntries} selectedId={selected?.radius_vehicle_id ?? null} onSelect={setSelectedId} />

          <div className="space-y-4">
            <SectionCard
              title="Alert intelligenti"
              subtitle={topAlerts.length > 0 ? "Priorita operative da verificare adesso" : "Nessuna criticita rilevata nei mezzi visibili"}
              className="overflow-hidden rounded-[28px] border border-slate-200 shadow-[0_18px_50px_rgba(15,23,42,0.08)]"
              bodyClassName="space-y-2 p-4"
            >
              {offlineOperationalEntries.length > 0 ? (
                <div className="rounded-[22px] border border-rose-200 bg-[linear-gradient(180deg,#fff1f2_0%,#ffffff_100%)] p-4 shadow-[0_12px_28px_rgba(244,63,94,0.14)]">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-rose-600">Priorita massima</p>
                      <p className="mt-1 text-base font-semibold text-slate-950">
                        {offlineOperationalEntries.length} mezz{offlineOperationalEntries.length === 1 ? "o offline con servizio attivo" : "i offline con servizio attivo"}
                      </p>
                      <p className="mt-1 text-xs text-slate-600">Controlla subito GPS, stato corsa e contatto autista.</p>
                    </div>
                    <span className="inline-flex rounded-full border border-rose-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-rose-700">
                      Offline live
                    </span>
                  </div>

                  <div className="mt-3 space-y-2">
                    {offlineOperationalEntries.slice(0, 3).map((entry) => (
                      <button
                        key={`offline-operational-${entry.radius_vehicle_id}`}
                        type="button"
                        onClick={() => setSelectedId(entry.radius_vehicle_id)}
                        className="flex w-full items-center justify-between gap-3 rounded-2xl border border-rose-100 bg-white/90 px-3 py-2 text-left transition hover:shadow-sm"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-slate-950">{entry.pms_label ?? entry.label}</p>
                          <p className="mt-0.5 truncate text-xs text-slate-600">
                            {entry.active_service?.time ?? "N/D"} • {entry.active_service?.customer_name ?? "Servizio attivo"}
                          </p>
                        </div>
                        <span className="shrink-0 rounded-full bg-rose-50 px-2 py-1 text-[11px] font-semibold text-rose-700">
                          {formatRelativeSeconds(entry.last_update_seconds)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {topAlerts.length === 0 ? (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                  Tutti i mezzi visibili sono in una situazione operativa regolare.
                </div>
              ) : (
                topAlerts.map((alert) => (
                  <button
                    key={`${alert.vehicleId}-${alert.title}`}
                    type="button"
                    onClick={() => setSelectedId(alert.vehicleId)}
                    className={`w-full rounded-2xl border px-4 py-3 text-left transition hover:shadow-sm ${alertTone(alert.severity)}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold">{alert.title}</p>
                        <p className="mt-1 truncate text-xs opacity-80">{alert.vehicleLabel}</p>
                        <p className="mt-1 text-xs opacity-90">{alert.detail}</p>
                      </div>
                      <span className="rounded-full border border-current/20 px-2 py-0.5 text-[10px] font-semibold uppercase">
                        {alert.severity}
                      </span>
                    </div>
                  </button>
                ))
              )}
            </SectionCard>

            <SectionCard
              title="Stato operativo"
              subtitle={selected ? "Focus sul mezzo selezionato" : `Mezzi visibili: ${filteredEntries.length} / ${entries.length}`}
              className="overflow-hidden rounded-[28px] border border-slate-200 shadow-[0_18px_50px_rgba(15,23,42,0.08)]"
              bodyClassName="space-y-3 p-4"
            >
              {selected ? (
                <article className="rounded-[26px] border border-slate-200 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-4 shadow-[0_16px_40px_rgba(15,23,42,0.08)]">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-lg font-semibold tracking-[-0.02em] text-slate-950">{selected.pms_label ?? selected.label}</p>
                      <p className="mt-1 text-xs text-slate-500">{selected.line_name ?? "Linea non assegnata"} • {selected.driver_name ?? "Autista non assegnato"}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        {selected.current_address ?? "Indirizzo non disponibile"}{selected.current_city ? ` • ${selected.current_city}` : ""}
                      </p>
                    </div>
                    <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${statusMeta(selected.status_key).badge}`}>
                      <span className={`inline-block h-2.5 w-2.5 rounded-full ${statusMeta(selected.status_key).dot}`} />
                      {selected.status_label}
                    </span>
                  </div>

                  <div className="mt-4 grid grid-cols-3 gap-2">
                    <div className="rounded-2xl border border-slate-200 bg-white px-3 py-3 shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">Velocita</p>
                      <p className="mt-1 text-lg font-semibold text-slate-950">{selected.speed_kmh !== null ? `${Math.round(selected.speed_kmh)} km/h` : "--"}</p>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-white px-3 py-3 shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">Update</p>
                      <p className="mt-1 text-lg font-semibold text-slate-950">{formatRelativeSeconds(selected.last_update_seconds)}</p>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-white px-3 py-3 shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">Servizio</p>
                      <p className="mt-1 truncate text-sm font-semibold text-slate-950">{selected.active_service?.time ?? "Nessuno"}</p>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {focusSignals(selected).map((signal) => (
                      <span key={`${selected.radius_vehicle_id}-${signal.label}`} className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-medium ${signal.tone}`}>
                        {signal.label}
                      </span>
                    ))}
                  </div>

                  {selected.active_service ? (
                    <div className="mt-4 rounded-[22px] border border-sky-200 bg-[linear-gradient(180deg,rgba(240,249,255,0.92)_0%,rgba(255,255,255,0.98)_100%)] p-4 shadow-[0_12px_28px_rgba(14,165,233,0.08)]">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-sky-700">Servizio attivo PMS</p>
                      <p className="mt-1.5 text-sm font-semibold text-slate-950">{selected.active_service.customer_name}</p>
                      <p className="mt-1 text-xs text-slate-600">{selected.active_service.date} • {selected.active_service.time} • {selected.active_service.hotel_name ?? "Destinazione non disponibile"}</p>
                      <p className="mt-1 text-xs text-slate-600">Stato servizio: {selected.active_service.status} • Linea: {selected.active_service.line_name ?? "N/D"}</p>
                    </div>
                  ) : (
                    <div className="mt-4 rounded-[22px] border border-slate-200 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-4 text-xs text-slate-600 shadow-[0_12px_28px_rgba(15,23,42,0.05)]">
                      Ultima posizione nota: {selected.lat.toFixed(5)}, {selected.lng.toFixed(5)}
                    </div>
                  )}

                  <div className="mt-4 flex flex-wrap gap-2">
                    <Link href="/bus-network" className="btn-secondary px-3 py-1.5 text-xs">Apri Rete Bus</Link>
                    <Link href="/fleet-ops" className="btn-secondary px-3 py-1.5 text-xs">Apri dettaglio mezzo</Link>
                  </div>
                </article>
              ) : (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">Nessun mezzo disponibile con i filtri attivi.</div>
              )}
            </SectionCard>

            <SectionCard
              title="Lista mezzi"
              subtitle="Ordinata per priorita operativa: i mezzi piu critici salgono in alto"
              className="overflow-hidden rounded-[28px] border border-slate-200 shadow-[0_18px_50px_rgba(15,23,42,0.08)]"
              bodyClassName="max-h-[560px] space-y-2 overflow-y-auto p-4"
            >
              {filteredEntries.length === 0 ? (
                <p className="text-sm text-slate-500">Nessun bus corrisponde ai filtri impostati.</p>
              ) : (
                filteredEntries.map((entry) => {
                  const meta = statusMeta(entry.status_key);
                  const priority = priorityBadge(entry);
                  const selectedRow = selected?.radius_vehicle_id === entry.radius_vehicle_id;
                  return (
                    <button
                      key={entry.radius_vehicle_id}
                      type="button"
                      onClick={() => setSelectedId(entry.radius_vehicle_id)}
                      className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                        selectedRow ? "border-slate-900 bg-slate-900 text-white shadow-[0_14px_36px_rgba(15,23,42,0.2)]" : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={selectedRow ? "text-white" : "text-slate-900"}>{entry.status_icon}</span>
                            <p className={`truncate text-sm font-semibold ${selectedRow ? "text-white" : "text-slate-900"}`}>{entry.pms_label ?? entry.label}</p>
                          </div>
                          <p className={`mt-1 truncate text-xs ${selectedRow ? "text-slate-300" : "text-slate-500"}`}>{entry.line_name ?? "Linea non assegnata"} • {entry.driver_name ?? "Autista non assegnato"}</p>
                          <p className={`mt-1 truncate text-[11px] ${selectedRow ? "text-slate-400" : "text-slate-400"}`}>
                            {entry.current_address ?? "Indirizzo non disponibile"}{entry.current_city ? ` • ${entry.current_city}` : ""}
                          </p>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${selectedRow ? "border-white/20 bg-white/10 text-white" : meta.badge}`}>
                            <span className={`inline-block h-2 w-2 rounded-full ${selectedRow ? "bg-white" : meta.dot}`} />
                            {meta.label}
                          </span>
                          {priority ? (
                            <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${selectedRow ? "border-white/15 bg-white/10 text-slate-100" : priority.tone}`}>
                              {priority.label}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <div className={`mt-3 grid grid-cols-3 gap-2 text-xs ${selectedRow ? "text-slate-200" : "text-slate-500"}`}>
                        <div>
                          <p className="uppercase tracking-[0.08em]">Velocita</p>
                          <p className={`mt-1 text-sm font-semibold ${selectedRow ? "text-white" : "text-slate-900"}`}>{entry.speed_kmh !== null ? `${Math.round(entry.speed_kmh)} km/h` : "--"}</p>
                        </div>
                        <div>
                          <p className="uppercase tracking-[0.08em]">Update</p>
                          <p className={`mt-1 text-sm font-semibold ${selectedRow ? "text-white" : "text-slate-900"}`}>{formatRelativeSeconds(entry.last_update_seconds)}</p>
                        </div>
                        <div>
                          <p className="uppercase tracking-[0.08em]">Servizio</p>
                          <p className={`mt-1 truncate text-sm font-semibold ${selectedRow ? "text-white" : "text-slate-900"}`}>{entry.active_service?.time ?? "Nessuno"}</p>
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </SectionCard>
          </div>
        </div>
      )}
    </section>
  );
}
