"use client";

import dynamic from "next/dynamic";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import type { GpsLiveEntry } from "@/lib/types";

const DynamicMap = dynamic(
  () => import("@/components/live-bus-map").then((mod) => mod.LiveBusMap),
  { ssr: false, loading: () => <div className="card p-4 text-sm text-slate-500">Caricamento mappa...</div> }
);

const DEFAULT_INTERVAL_S = 30;

async function accessToken(): Promise<string | null> {
  if (!hasSupabaseEnv || !supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return ts;
  }
}

function secondsAgo(ts: string): number {
  return Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
}

export default function MappaLivePage() {
  const [entries, setEntries] = useState<GpsLiveEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [intervalS, setIntervalS] = useState(DEFAULT_INTERVAL_S);
  const [lineFilter, setLineFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "online" | "offline">("all");
  const [countdown, setCountdown] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLive = useEffectEvent(async () => {
    const token = await accessToken();
    if (!token) {
      setError("Sessione non valida.");
      setLoading(false);
      return;
    }
    try {
      const res = await fetch("/api/gps/live", {
        headers: { Authorization: `Bearer ${token}` }
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        entries?: GpsLiveEntry[];
        fetched_at?: string;
      };
      if (!res.ok || !json.ok) {
        setError(json.error ?? "Errore recupero posizioni GPS.");
        setLoading(false);
        return;
      }
      setEntries(json.entries ?? []);
      setFetchedAt(json.fetched_at ?? new Date().toISOString());
      setError(null);
    } catch {
      setError("Errore di rete. Verifica la connessione.");
    }
    setLoading(false);
  });

  const startPolling = useEffectEvent(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);

    setCountdown(intervalS);
    timerRef.current = setInterval(() => {
      void fetchLive();
      setCountdown(intervalS);
    }, intervalS * 1000);

    countdownRef.current = setInterval(() => {
      setCountdown((c) => Math.max(0, c - 1));
    }, 1000);
  });

  useEffect(() => {
    void fetchLive().then(() => startPolling());
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [intervalS, refreshKey]);

  const lines = useMemo(
    () => [...new Set(entries.map((e) => e.line_name).filter(Boolean) as string[])].sort(),
    [entries]
  );

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      const byLine = lineFilter === "all" || e.line_name === lineFilter;
      const byStatus =
        statusFilter === "all" ||
        (statusFilter === "online" && e.online) ||
        (statusFilter === "offline" && !e.online);
      return byLine && byStatus;
    });
  }, [entries, lineFilter, statusFilter]);

  const selected = useMemo(
    () => filtered.find((e) => e.radius_vehicle_id === selectedId) ?? null,
    [filtered, selectedId]
  );

  const handleSelect = (id: string) => setSelectedId(id);

  const handleRefresh = () => {
    setLoading(true);
    setRefreshKey((k) => k + 1);
  };

  return (
    <section className="page-section">
      <PageHeader
        title="Mappa Live Bus"
        subtitle="Tracking GPS in tempo reale dei mezzi."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Mappa Live" }]}
      />

      {/* Barra controlli */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={lineFilter}
          onChange={(e) => setLineFilter(e.target.value)}
          className="input-saas"
        >
          <option value="all">Linea: tutte</option>
          {lines.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as "all" | "online" | "offline")}
          className="input-saas"
        >
          <option value="all">Stato: tutti</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
        </select>

        <select
          value={String(intervalS)}
          onChange={(e) => {
            setIntervalS(Number(e.target.value));
          }}
          className="input-saas"
        >
          <option value="15">Aggiorna ogni 15s</option>
          <option value="30">Aggiorna ogni 30s</option>
          <option value="60">Aggiorna ogni 60s</option>
        </select>

        <button
          type="button"
          onClick={handleRefresh}
          className="btn-secondary px-3 py-1.5 text-sm"
        >
          Aggiorna ora
        </button>

        <div className="ml-auto flex items-center gap-2 text-xs text-slate-500">
          {fetchedAt ? (
            <>
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
              Agg. {formatTime(fetchedAt)} &mdash; prossimo tra {countdown}s
            </>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
          {error.includes("RADIUS_REFRESH_TOKEN") ? (
            <p className="mt-1 text-xs">
              Configura la variabile env <code>RADIUS_REFRESH_TOKEN</code> per attivare il tracking GPS.
            </p>
          ) : null}
        </div>
      ) : null}

      {loading && !fetchedAt ? (
        <div className="card p-6 text-sm text-slate-500">Caricamento posizioni GPS...</div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
          <DynamicMap
            entries={filtered}
            selectedId={selectedId}
            onSelect={handleSelect}
          />

          {/* Pannello laterale */}
          <div className="flex flex-col gap-3">
            {/* KPI */}
            <div className="grid grid-cols-3 gap-2">
              <SectionCard title="Totale">
                <p className="text-2xl font-semibold text-text">{filtered.length}</p>
              </SectionCard>
              <SectionCard title="Online">
                <p className="text-2xl font-semibold text-emerald-700">
                  {filtered.filter((e) => e.online).length}
                </p>
              </SectionCard>
              <SectionCard title="Offline">
                <p className="text-2xl font-semibold text-slate-500">
                  {filtered.filter((e) => !e.online).length}
                </p>
              </SectionCard>
            </div>

            {/* Dettaglio veicolo selezionato */}
            {selected ? (
              <SectionCard title="Dettaglio mezzo">
                <div className="space-y-1 text-sm">
                  <p className="font-semibold">{selected.pms_label ?? selected.label}</p>
                  {selected.pms_vehicle_id ? (
                    <p className="text-xs text-slate-500">ID PMS: {selected.pms_vehicle_id.slice(0, 8)}…</p>
                  ) : (
                    <p className="text-xs text-amber-600">Non collegato a nessun mezzo PMS</p>
                  )}
                  {selected.line_name ? <p>Linea: {selected.line_name}</p> : null}
                  {selected.driver_name ? <p>Autista: {selected.driver_name}</p> : null}
                  <p>
                    Posizione: {selected.lat.toFixed(5)}, {selected.lng.toFixed(5)}
                  </p>
                  {selected.speed_kmh !== null ? <p>Velocità: {selected.speed_kmh} km/h</p> : null}
                  {selected.heading !== null ? <p>Direzione: {selected.heading}°</p> : null}
                  <p>
                    Stato:{" "}
                    <span className={selected.online ? "text-emerald-700 font-medium" : "text-slate-500"}>
                      {selected.online ? "Online" : "Offline"}
                    </span>
                  </p>
                  <p className="text-xs text-slate-400">
                    Ultimo aggiornamento GPS: {formatTime(selected.timestamp)} ({secondsAgo(selected.timestamp)}s fa)
                  </p>
                  {selected.pms_vehicle_id ? (
                    <a
                      href="/fleet-ops"
                      className="mt-2 inline-block text-xs text-blue-600 underline"
                    >
                      Apri in Flotta Ops
                    </a>
                  ) : null}
                </div>
              </SectionCard>
            ) : null}

            {/* Lista bus */}
            <SectionCard title={`Bus (${filtered.length})`} className="max-h-64 overflow-y-auto" bodyClassName="space-y-1.5 p-3">
              {filtered.length === 0 ? (
                <p className="text-sm text-slate-500">
                  {entries.length === 0
                    ? "Nessun dato GPS disponibile."
                    : "Nessun mezzo corrisponde ai filtri."}
                </p>
              ) : (
                filtered.map((e) => (
                  <button
                    key={e.radius_vehicle_id}
                    type="button"
                    onClick={() => setSelectedId(e.radius_vehicle_id)}
                    className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                      selectedId === e.radius_vehicle_id
                        ? "border-blue-300 bg-blue-50"
                        : "border-slate-200 bg-white hover:border-slate-300"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium truncate">{e.pms_label ?? e.label}</span>
                      <span
                        className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${
                          e.online ? "bg-emerald-400" : "bg-slate-300"
                        }`}
                      />
                    </div>
                    {e.line_name ? (
                      <p className="text-xs text-slate-500 truncate">{e.line_name}</p>
                    ) : null}
                    {e.driver_name ? (
                      <p className="text-xs text-slate-400 truncate">{e.driver_name}</p>
                    ) : null}
                    <p className="text-xs text-slate-400">
                      Agg. {formatTime(e.timestamp)}
                    </p>
                  </button>
                ))
              )}
            </SectionCard>
          </div>
        </div>
      )}
    </section>
  );
}
