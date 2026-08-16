"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import type { GpsControlRoomEntry } from "@/lib/types";

const DynamicMap = dynamic(() => import("@/components/control-room-map-shell").then((mod) => mod.ControlRoomMapShell), {
  ssr: false,
  loading: () => <div className="card p-4 text-sm text-slate-500">Caricamento control room...</div>
});

const DEFAULT_REFRESH_SECONDS = 60;
const PANORAMAX_VIEWER_BASE_URL = "https://api.panoramax.xyz/";
const PANORAMAX_SEARCH_URL = "https://api.panoramax.xyz/api/search";

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

type PanoramaxFeature = {
  id?: string;
  geometry?: {
    type?: string;
    coordinates?: [number, number];
  };
  assets?: {
    thumb?: { href?: string };
    sd?: { href?: string };
  };
  properties?: {
    datetime?: string;
    datetimetz?: string;
    "geovisio:producer"?: string;
  };
};

type PanoramaxResult =
  | { status: "idle" | "loading" }
  | { status: "found"; id: string; lat: number; lng: number; distanceMeters: number; thumbUrl: string | null; capturedAt: string | null; producer: string | null }
  | { status: "empty" }
  | { status: "error"; message: string };

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

function severityLabel(severity: "high" | "medium" | "low") {
  if (severity === "high") return "alta";
  if (severity === "medium") return "media";
  return "bassa";
}

function panoramaxPictureViewerUrl(entry: GpsControlRoomEntry, pictureId: string) {
  const params = new URLSearchParams({
    focus: "pic",
    map: `18/${entry.lat.toFixed(7)}/${entry.lng.toFixed(7)}`,
    pic: pictureId,
    background: "streets"
  });
  return `${PANORAMAX_VIEWER_BASE_URL}#${params.toString()}`;
}

function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number) {
  const earthRadius = 6371000;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * earthRadius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function panoramaxSearchUrl(entry: GpsControlRoomEntry) {
  const radiusDegrees = 0.012;
  const params = new URLSearchParams({
    bbox: [
      (entry.lng - radiusDegrees).toFixed(6),
      (entry.lat - radiusDegrees).toFixed(6),
      (entry.lng + radiusDegrees).toFixed(6),
      (entry.lat + radiusDegrees).toFixed(6)
    ].join(","),
    limit: "30"
  });
  return `${PANORAMAX_SEARCH_URL}?${params.toString()}`;
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
  const [streetViewOpen, setStreetViewOpen] = useState(false);
  const [streetViewResult, setStreetViewResult] = useState<PanoramaxResult>({ status: "idle" });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [driverByVehicleId, setDriverByVehicleId] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    async function loadDriverAssociations() {
      const token = await accessToken();
      if (!token) return;
      const today = new Date().toISOString().slice(0, 10);
      try {
        const res = await fetch(`/api/ops/disponibilita?date=${today}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as {
          ok?: boolean;
          drivers?: Array<{ id: string; full_name: string }>;
          driver_availability?: Array<{ driver_profile_id: string; vehicle_1_id: string | null; vehicle_2_id: string | null }>;
        };
        if (!body.ok || cancelled) return;
        const driverById = new Map((body.drivers ?? []).map((d) => [d.id, d.full_name]));
        const map = new Map<string, string>();
        for (const avail of body.driver_availability ?? []) {
          const name = driverById.get(avail.driver_profile_id);
          if (!name) continue;
          if (avail.vehicle_1_id) map.set(avail.vehicle_1_id, name);
          if (avail.vehicle_2_id) map.set(avail.vehicle_2_id, name);
        }
        setDriverByVehicleId(map);
      } catch {
        // silently ignore — GPS view works without driver associations
      }
    }
    void loadDriverAssociations();
    return () => { cancelled = true; };
  }, []);

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

  const annotatedEntries = useMemo(
    () =>
      driverByVehicleId.size === 0
        ? entries
        : entries.map((entry) => {
            if (!entry.pms_vehicle_id) return entry;
            const dailyDriverName = driverByVehicleId.get(entry.pms_vehicle_id);
            if (!dailyDriverName || dailyDriverName === entry.driver_name) return entry;
            return { ...entry, driver_name: dailyDriverName };
          }),
    [entries, driverByVehicleId]
  );

  const lineOptions = useMemo(
    () => Array.from(new Set(annotatedEntries.map((entry) => entry.line_name).filter(Boolean) as string[])).sort(),
    [annotatedEntries]
  );

  const filteredEntries = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return annotatedEntries
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
  }, [annotatedEntries, lineFilter, search, statusFilter]);

  const selected = useMemo(
    () => filteredEntries.find((entry) => entry.radius_vehicle_id === selectedId) ?? filteredEntries[0] ?? null,
    [filteredEntries, selectedId]
  );
  const selectedStreetViewKey = selected
    ? `${selected.radius_vehicle_id}:${selected.lat.toFixed(6)}:${selected.lng.toFixed(6)}`
    : null;
  const streetViewUrl = selected && streetViewResult.status === "found" ? panoramaxPictureViewerUrl(selected, streetViewResult.id) : null;

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
  // Il countdown provoca gia un render ogni secondo: usiamo il tempo corrente per mostrare l'eta del dato GPS.
  // eslint-disable-next-line react-hooks/purity
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
  const criticalEntries = useMemo(
    () => filteredEntries.filter((entry) => entryPriority(entry) <= 3),
    [filteredEntries]
  );
  const activeServiceEntries = useMemo(
    () => filteredEntries.filter((entry) => Boolean(entry.active_service)),
    [filteredEntries]
  );
  const filtersActive = lineFilter !== "all" || statusFilter !== "all" || search.trim().length > 0;
  const firstCriticalEntry = criticalEntries[0] ?? null;

  const handleManualRefresh = () => {
    setCountdown(refreshSeconds);
    // eslint-disable-next-line react-hooks/rules-of-hooks
    void fetchControlRoom(false);
  };

  const handleResetFilters = () => {
    setLineFilter("all");
    setStatusFilter("all");
    setSearch("");
  };

  const handleFocusCritical = () => {
    setStatusFilter("all");
    if (firstCriticalEntry) {
      setSelectedId(firstCriticalEntry.radius_vehicle_id);
    }
  };

  useEffect(() => {
    setStreetViewOpen(false);
    setStreetViewResult({ status: "idle" });
  }, [selectedStreetViewKey]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;

    async function loadPanoramaxPicture(entry: GpsControlRoomEntry) {
      setStreetViewResult({ status: "loading" });
      try {
        const response = await fetch(panoramaxSearchUrl(entry), { cache: "no-store" });
        if (!response.ok) {
          throw new Error("Ricerca Panoramax non disponibile.");
        }
        const body = (await response.json()) as { features?: PanoramaxFeature[] };
        const candidates = (body.features ?? [])
          .map((feature) => {
            const coordinates = feature.geometry?.coordinates;
            if (!feature.id || !coordinates) return null;
            const [lng, lat] = coordinates;
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
            return {
              id: feature.id,
              lat,
              lng,
              distanceMeters: distanceMeters(entry.lat, entry.lng, lat, lng),
              thumbUrl: feature.assets?.thumb?.href ?? feature.assets?.sd?.href ?? null,
              capturedAt: feature.properties?.datetimetz ?? feature.properties?.datetime ?? null,
              producer: feature.properties?.["geovisio:producer"] ?? null
            };
          })
          .filter((item): item is Exclude<typeof item, null> => item !== null)
          .sort((left, right) => left.distanceMeters - right.distanceMeters);

        if (cancelled) return;
        const nearest = candidates[0];
        setStreetViewResult(nearest ? { status: "found", ...nearest } : { status: "empty" });
      } catch (loadError) {
        if (cancelled) return;
        setStreetViewResult({
          status: "error",
          message: loadError instanceof Error ? loadError.message : "Vista strada non disponibile."
        });
      }
    }

    void loadPanoramaxPicture(selected);

    return () => {
      cancelled = true;
    };
  }, [selectedStreetViewKey, selected]);

  const vehicleListSection = (
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
  );

  return (
    <section className="space-y-5">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-600 to-violet-600 text-2xl text-white shadow-[0_14px_34px_rgba(79,70,229,0.28)]">◎</span>
            <div>
              <h1 className="text-4xl font-extrabold tracking-tight text-slate-950">Control Room</h1>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-500">
                {new Intl.DateTimeFormat("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date())}
                <span>·</span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-700"><span className="h-2 w-2 rounded-full bg-emerald-500" />Live GPS</span>
                <span>refresh tra {countdown}s</span>
              </p>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <select value={refreshSeconds} onChange={(event) => setRefreshSeconds(Number(event.target.value))} className="h-12 rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm">
            <option value={20}>Refresh 20 sec</option><option value={30}>Refresh 30 sec</option><option value={60}>Refresh 60 sec</option>
          </select>
          <button type="button" onClick={handleManualRefresh} disabled={refreshing} className="h-12 rounded-xl border border-slate-200 bg-white px-5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-60">⟳ {refreshing ? "Aggiorno..." : "Aggiorna GPS"}</button>
          <Link href="/services/new" className="flex h-12 items-center rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-6 text-sm font-bold text-white shadow-[0_16px_36px_rgba(79,70,229,0.34)] transition hover:-translate-y-0.5">+ Nuovo servizio</Link>
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {[
          ["▣", "Servizi attivi", activeServiceEntries.length, "bg-blue-50 text-blue-700"],
          ["↘", "In movimento", visibleSummary.moving, "bg-emerald-50 text-emerald-700"],
          ["⌕", "Da verificare", visibleSummary.warning, "bg-amber-50 text-amber-700"],
          ["●", "Fermi", visibleSummary.stopped, "bg-rose-50 text-rose-700"],
          ["⚠", "Emergenze", criticalEntries.length, "bg-red-50 text-red-700"]
        ].map(([icon, label, value, tone]) => (
          <button key={String(label)} type="button" onClick={() => { if (label === "In movimento") setStatusFilter("moving"); if (label === "Da verificare") setStatusFilter("warning"); if (label === "Fermi") setStatusFilter("stopped"); if (label === "Emergenze") handleFocusCritical(); }} className="group flex min-h-[104px] items-center gap-4 rounded-2xl border border-slate-200 bg-white px-5 text-left shadow-[0_14px_36px_rgba(15,23,42,0.07)] transition hover:-translate-y-0.5 hover:border-blue-200">
            <span className={`flex h-14 w-14 items-center justify-center rounded-2xl text-3xl ${tone}`}>{icon}</span>
            <span><span className="block text-sm font-semibold text-slate-500">{label}</span><strong className="mt-1 block text-4xl leading-none text-slate-950">{value}</strong></span>
          </button>
        ))}
      </div>

      {error ? <div className="rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm font-semibold text-rose-700">{error}</div> : null}
      {loading ? <div className="card p-6 text-sm text-slate-500">Caricamento control room GPS...</div> : <>
      <div className="grid min-h-[650px] items-start gap-4 2xl:grid-cols-[300px_minmax(720px,1fr)_330px]">
        <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
          <div className="border-b border-slate-100 p-4">
            <div className="flex items-center justify-between gap-3"><div><p className="text-[11px] font-bold uppercase tracking-[0.2em] text-blue-500">Flotta attiva</p><h2 className="mt-1 text-2xl font-extrabold text-slate-950">{filteredEntries.length} mezzi</h2></div>{filtersActive ? <button type="button" onClick={handleResetFilters} className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50">Reset</button> : null}</div>
            <input value={search} onChange={(event) => setSearch(event.target.value)} className="mt-4 h-11 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm outline-none transition focus:border-blue-400 focus:bg-white focus:ring-4 focus:ring-blue-100" placeholder="Cerca mezzo, autista, cliente..." />
            <div className="mt-3 grid grid-cols-2 gap-2"><select value={lineFilter} onChange={(event) => setLineFilter(event.target.value)} className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700"><option value="all">Tutte le linee</option>{lineOptions.map((line) => <option key={line} value={line}>{line}</option>)}</select><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700"><option value="all">Tutti gli stati</option><option value="moving">In movimento</option><option value="stopped">Fermi</option><option value="warning">Warning</option><option value="offline">Offline</option></select></div>
          </div>
          <div className="max-h-[520px] space-y-2 overflow-y-auto p-3">
            {filteredEntries.length ? filteredEntries.map((entry) => { const meta = statusMeta(entry.status_key); const priority = priorityBadge(entry); const active = selected?.radius_vehicle_id === entry.radius_vehicle_id; return (
              <button key={entry.radius_vehicle_id} type="button" onClick={() => setSelectedId(entry.radius_vehicle_id)} className={`w-full rounded-2xl border p-3 text-left transition ${active ? "border-blue-500 bg-gradient-to-br from-blue-600 to-violet-600 text-white shadow-[0_16px_36px_rgba(79,70,229,0.28)]" : "border-slate-200 bg-white hover:border-blue-200 hover:bg-blue-50/40"}`}>
                <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className={`truncate text-base font-extrabold ${active ? "text-white" : "text-slate-950"}`}>{entry.pms_label ?? entry.label}</p><p className={`mt-1 truncate text-xs ${active ? "text-blue-100" : "text-slate-500"}`}>{entry.driver_name ?? "Autista non assegnato"} · {entry.line_name ?? "Linea non assegnata"}</p></div><span className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[11px] font-bold ${active ? "bg-white/15 text-white" : meta.badge}`}><span className={`h-2 w-2 rounded-full ${active ? "bg-white" : meta.dot}`} />{meta.label}</span></div>
                <div className={`mt-3 grid grid-cols-3 gap-2 text-xs ${active ? "text-blue-100" : "text-slate-500"}`}><span><strong className={`block text-sm ${active ? "text-white" : "text-slate-950"}`}>{entry.speed_kmh !== null ? `${Math.round(entry.speed_kmh)} km/h` : "--"}</strong>velocità</span><span><strong className={`block text-sm ${active ? "text-white" : "text-slate-950"}`}>{formatRelativeSeconds(entry.last_update_seconds)}</strong>GPS</span><span><strong className={`block truncate text-sm ${active ? "text-white" : "text-slate-950"}`}>{entry.active_service?.time ?? "—"}</strong>servizio</span></div>
                {priority ? <span className={`mt-3 inline-flex rounded-full border px-2.5 py-1 text-[11px] font-bold ${active ? "border-white/20 bg-white/10 text-white" : priority.tone}`}>{priority.label}</span> : null}
              </button>
            ); }) : <p className="rounded-2xl border border-dashed border-slate-200 p-5 text-sm text-slate-500">Nessun mezzo corrisponde ai filtri impostati.</p>}
          </div>
        </section>

        <section className="relative min-w-0 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
          <div className="absolute left-5 right-5 top-5 z-[600] flex flex-wrap items-center justify-between gap-3"><div className="rounded-2xl border border-white/70 bg-white/90 px-4 py-3 shadow-lg backdrop-blur"><p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">Mappa operativa</p><p className="mt-1 text-sm font-bold text-slate-950">{selected ? (selected.pms_label ?? selected.label) : "Nessun mezzo selezionato"}</p></div><div className="flex gap-2"><button type="button" onClick={handleResetFilters} className="rounded-xl bg-blue-600 px-3 py-2 text-xs font-bold text-white shadow-lg">Tutti</button><button type="button" onClick={() => setStatusFilter("moving")} className="rounded-xl border border-white/70 bg-white/95 px-3 py-2 text-xs font-bold text-slate-700 shadow-lg">Movimento</button><button type="button" onClick={() => setStatusFilter("warning")} className="rounded-xl border border-white/70 bg-white/95 px-3 py-2 text-xs font-bold text-slate-700 shadow-lg">Warning</button></div></div>
          <div className="h-[650px]"><DynamicMap entries={filteredEntries} selectedId={selected?.radius_vehicle_id ?? null} onSelect={setSelectedId} /></div>
        </section>

        <aside className="space-y-4">
          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)]"><p className="text-[11px] font-bold uppercase tracking-[0.2em] text-blue-500">Servizio selezionato</p>{selected ? <><div className="mt-3 flex items-start justify-between gap-3"><div><h2 className="text-2xl font-extrabold text-slate-950">{selected.pms_label ?? selected.label}</h2><p className="mt-1 text-sm text-slate-500">{selected.driver_name ?? "Autista non assegnato"}</p></div><span className={`rounded-xl border px-3 py-1.5 text-xs font-bold ${statusMeta(selected.status_key).badge}`}>{statusMeta(selected.status_key).label}</span></div><div className="mt-5 space-y-4 border-y border-slate-100 py-5 text-sm"><div className="grid grid-cols-[34px_1fr] gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-blue-700">⌖</span><div><p className="font-bold text-slate-950">Posizione</p><p className="mt-0.5 text-slate-500">{selected.current_address ?? selected.current_city ?? "Posizione non disponibile"}</p></div></div><div className="grid grid-cols-[34px_1fr] gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-50 text-violet-700">▣</span><div><p className="font-bold text-slate-950">{selected.active_service?.customer_name ?? "Nessun servizio PMS attivo"}</p><p className="mt-0.5 text-slate-500">{selected.active_service ? `${selected.active_service.time} · ${selected.active_service.hotel_name ?? "Destinazione non disponibile"}` : "Il mezzo non risulta collegato a una corsa attiva."}</p></div></div><div className="grid grid-cols-[34px_1fr] gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">◷</span><div><p className="font-bold text-slate-950">Ultimo GPS</p><p className="mt-0.5 text-slate-500">{formatRelativeSeconds(selected.last_update_seconds)} · {selected.speed_kmh !== null ? `${Math.round(selected.speed_kmh)} km/h` : "velocità N/D"}</p></div></div></div><div className="mt-4 grid grid-cols-2 gap-2"><button type="button" onClick={() => setSelectedId(selected.radius_vehicle_id)} className="rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-3 py-3 text-sm font-bold text-white shadow-lg">Segui</button><Link href="/fleet-ops" className="rounded-xl border border-slate-200 px-3 py-3 text-center text-sm font-bold text-slate-700 hover:bg-slate-50">Mezzo</Link><Link href="/dispatch" className="rounded-xl border border-slate-200 px-3 py-3 text-center text-sm font-bold text-slate-700 hover:bg-slate-50">Cambio</Link><button type="button" onClick={() => setStreetViewOpen(true)} className="rounded-xl border border-slate-200 px-3 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50">Vista strada</button></div></> : <p className="mt-4 text-sm text-slate-500">Nessun mezzo disponibile.</p>}</section>
          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)]"><h2 className="text-xl font-extrabold text-slate-950">Avvisi operativi</h2><div className="mt-4 divide-y divide-slate-100">{topAlerts.length ? topAlerts.map((alert) => <button key={`${alert.vehicleId}-${alert.title}`} type="button" onClick={() => setSelectedId(alert.vehicleId)} className="grid w-full grid-cols-[38px_1fr_auto] items-center gap-3 py-3 text-left"><span className={`flex h-10 w-10 items-center justify-center rounded-xl ${alert.severity === "high" ? "bg-rose-50 text-rose-600" : alert.severity === "medium" ? "bg-amber-50 text-amber-600" : "bg-blue-50 text-blue-600"}`}>!</span><span><strong className="block text-sm text-slate-900">{alert.title}</strong><span className="text-xs text-slate-500">{alert.vehicleLabel} · priorità {severityLabel(alert.severity)}</span></span><span className="text-slate-400">›</span></button>) : <p className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">Nessuna criticità rilevata.</p>}</div></section>
          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)]"><h2 className="text-xl font-extrabold text-slate-950">Azioni rapide</h2><div className="mt-4 grid grid-cols-2 gap-3"><Link href="/arrivals" className="rounded-2xl border border-slate-200 px-3 py-4 text-center text-sm font-bold text-slate-700 hover:bg-slate-50">Arrivi</Link><Link href="/departures" className="rounded-2xl border border-slate-200 px-3 py-4 text-center text-sm font-bold text-slate-700 hover:bg-slate-50">Partenze</Link><Link href="/piano-giorno" className="rounded-2xl border border-slate-200 px-3 py-4 text-center text-sm font-bold text-slate-700 hover:bg-slate-50">Piano</Link><Link href="/disponibilita" className="rounded-2xl border border-slate-200 px-3 py-4 text-center text-sm font-bold text-slate-700 hover:bg-slate-50">Disponibilità</Link></div></section>
        </aside>
      </div>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)]"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-[11px] font-bold uppercase tracking-[0.2em] text-blue-500">Timeline live</p><h2 className="mt-1 text-2xl font-extrabold text-slate-950">Prossime 2 ore</h2></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">{activeServiceEntries.length} servizi collegati</span></div><div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-5">{activeServiceEntries.slice(0, 5).map((entry, index) => { const tones = ["border-blue-200 bg-blue-50 text-blue-800", "border-violet-200 bg-violet-50 text-violet-800", "border-emerald-200 bg-emerald-50 text-emerald-800", "border-orange-200 bg-orange-50 text-orange-800", "border-rose-200 bg-rose-50 text-rose-800"]; return <button key={`timeline-${entry.radius_vehicle_id}`} type="button" onClick={() => setSelectedId(entry.radius_vehicle_id)} className={`rounded-2xl border px-4 py-3 text-left transition hover:-translate-y-0.5 ${tones[index % tones.length]}`}><strong className="block text-sm">{entry.active_service?.time ?? "--:--"} · {entry.active_service?.customer_name ?? entry.pms_label ?? entry.label}</strong><span className="mt-1 block truncate text-xs opacity-75">{entry.active_service?.hotel_name ?? entry.current_city ?? "Destinazione non disponibile"}</span></button>; })}</div></section>
      </>}
      <div className="hidden">
      <PageHeader
        title="Mappa Operativa"
        subtitle="Control room live per monitorare flotta, anomalie e stato mezzi senza cambiare schermata."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Mappa Operativa" }]}
        badge={
          <span className="inline-flex items-center gap-2 rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-xs font-semibold text-teal-700">
            <span className="h-2.5 w-2.5 rounded-full bg-teal-500" />
            {visibleSummary.total} mezzi visibili
          </span>
        }
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

      <section className="rounded-[24px] border border-slate-200 bg-[linear-gradient(135deg,#f8fbff_0%,#eefaf8_100%)] px-4 py-4 shadow-[0_14px_36px_rgba(15,23,42,0.07)]">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">Focus adesso</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold tracking-[-0.02em] text-slate-950">
                {criticalEntries.length > 0
                  ? `${criticalEntries.length} mezzi richiedono attenzione`
                  : "Flotta stabile e sotto controllo"}
              </h2>
              <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600">
                {activeServiceEntries.length} servizi attivi
              </span>
              <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600">
                refresh {countdown}s
              </span>
            </div>
            <p className="mt-1 text-sm text-slate-600">
              Usa i KPI come filtri rapidi e porta in alto solo i mezzi che meritano attenzione.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleFocusCritical}
              className="rounded-full bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              {firstCriticalEntry ? `Apri ${firstCriticalEntry.pms_label ?? firstCriticalEntry.label}` : "Apri mezzo prioritario"}
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter("offline")}
              className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
            >
              Solo offline
            </button>
            {filtersActive ? (
              <button
                type="button"
                onClick={handleResetFilters}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Reset filtri
              </button>
            ) : null}
          </div>
        </div>
      </section>

      <div className="grid gap-3 md:grid-cols-5">
        <button
          type="button"
          onClick={() => setStatusFilter((current) => (current === "moving" ? "all" : "moving"))}
          className={`min-h-[112px] rounded-[18px] border p-3 text-left shadow-[0_16px_40px_rgba(15,23,42,0.08)] transition hover:-translate-y-0.5 ${
            statusFilter === "moving"
              ? "border-emerald-300 bg-[linear-gradient(180deg,#ecfdf5_0%,#ffffff_100%)]"
              : "border-slate-200 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)]"
          }`}
        >
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Bus attivi</p>
          <p className="mt-1.5 text-[1.45rem] leading-none font-semibold text-slate-950">{visibleSummary.moving}</p>
          <p className="mt-1 text-[12px] text-slate-500">Movimento reale</p>
        </button>
        <button
          type="button"
          onClick={() => setStatusFilter((current) => (current === "warning" ? "all" : "warning"))}
          className={`min-h-[112px] rounded-[18px] border p-3 text-left shadow-[0_16px_40px_rgba(15,23,42,0.08)] transition hover:-translate-y-0.5 ${
            statusFilter === "warning"
              ? "border-amber-300 bg-[linear-gradient(180deg,#fffbeb_0%,#ffffff_100%)]"
              : "border-slate-200 bg-[linear-gradient(180deg,#ffffff_0%,#fff7ed_100%)]"
          }`}
        >
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Warning</p>
          <p className="mt-1.5 text-[1.45rem] leading-none font-semibold text-amber-700">{visibleSummary.warning}</p>
          <p className="mt-1 text-[12px] text-slate-500">Lenti o da verificare</p>
        </button>
        <button
          type="button"
          onClick={() => setStatusFilter((current) => (current === "stopped" ? "all" : "stopped"))}
          className={`min-h-[112px] rounded-[18px] border p-3 text-left shadow-[0_16px_40px_rgba(15,23,42,0.08)] transition hover:-translate-y-0.5 ${
            statusFilter === "stopped"
              ? "border-rose-300 bg-[linear-gradient(180deg,#fff1f2_0%,#ffffff_100%)]"
              : "border-slate-200 bg-[linear-gradient(180deg,#ffffff_0%,#fff1f2_100%)]"
          }`}
        >
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Bus fermi</p>
          <p className="mt-1.5 text-[1.45rem] leading-none font-semibold text-rose-700">{visibleSummary.stopped}</p>
          <p className="mt-1 text-[12px] text-slate-500">Stop oltre soglia</p>
        </button>
        <button
          type="button"
          onClick={() => setStatusFilter((current) => (current === "offline" ? "all" : "offline"))}
          className={`min-h-[112px] rounded-[18px] border p-3 text-left shadow-[0_16px_40px_rgba(15,23,42,0.08)] transition hover:-translate-y-0.5 ${
            statusFilter === "offline"
              ? "border-rose-300 bg-[linear-gradient(180deg,#fff1f2_0%,#ffffff_100%)]"
              : "border-rose-200 bg-[linear-gradient(180deg,#ffffff_0%,#fff1f2_100%)]"
          }`}
        >
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
        </button>
        <article className="rounded-[18px] border border-slate-200 bg-[linear-gradient(180deg,#ffffff_0%,#eef2ff_100%)] p-3 min-h-[112px] shadow-[0_16px_40px_rgba(15,23,42,0.08)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Sistema</p>
              <p className="mt-1.5 text-[1.3rem] leading-none font-semibold text-slate-950">{summary ? "Operativo" : "In attesa"}</p>
              <p className="mt-1 text-[12px] text-slate-500">
                Ultimo aggiornamento: {fetchedAgoSeconds !== null ? `${formatRelativeSeconds(fetchedAgoSeconds)} • prossimo tra ${countdown}s` : "N/D"}
              </p>
            </div>
            {filtersActive ? (
              <button
                type="button"
                onClick={handleResetFilters}
                className="rounded-full border border-slate-200 bg-white/90 px-2.5 py-1 text-[11px] font-semibold text-slate-700 transition hover:bg-white"
              >
                Reset
              </button>
            ) : null}
          </div>
        </article>
      </div>

      {error ? <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div> : null}

      {loading ? (
        <div className="card p-6 text-sm text-slate-500">Caricamento control room GPS...</div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(320px,0.9fr)]">
          <div className="space-y-4">
            {false && <DynamicMap entries={filteredEntries} selectedId={selected?.radius_vehicle_id ?? null} onSelect={setSelectedId} />}
            {vehicleListSection}
          </div>

          <div className="space-y-4">
            <SectionCard
              title="Alert intelligenti"
              subtitle={topAlerts.length > 0 ? "Priorita operative da verificare adesso" : "Nessuna criticita rilevata nei mezzi visibili"}
              actions={
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-600">
                    {criticalEntries.length} priorita
                  </span>
                  {firstCriticalEntry ? (
                    <button
                      type="button"
                      onClick={() => setSelectedId(firstCriticalEntry.radius_vehicle_id)}
                      className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold text-slate-700 transition hover:bg-slate-50"
                    >
                      Apri primo critico
                    </button>
                  ) : null}
                </div>
              }
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
                        {severityLabel(alert.severity)}
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
              bodyClassName="space-y-2.5 p-4"
            >
              {selected ? (
                <article className="rounded-[26px] border border-slate-200 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-3.5 shadow-[0_16px_40px_rgba(15,23,42,0.08)]">
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

                  <div className="mt-3 grid grid-cols-3 gap-2">
                    <div className="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">Velocita</p>
                      <p className="mt-1 text-lg font-semibold text-slate-950">{selected.speed_kmh !== null ? `${Math.round(selected.speed_kmh)} km/h` : "--"}</p>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">Update</p>
                      <p className="mt-1 text-lg font-semibold text-slate-950">{formatRelativeSeconds(selected.last_update_seconds)}</p>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">Servizio</p>
                      <p className="mt-1 truncate text-sm font-semibold text-slate-950">{selected.active_service?.time ?? "Nessuno"}</p>
                    </div>
                  </div>

                  <div className="mt-2.5 flex flex-wrap gap-2">
                    {focusSignals(selected).map((signal) => (
                      <span key={`${selected.radius_vehicle_id}-${signal.label}`} className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-medium ${signal.tone}`}>
                        {signal.label}
                      </span>
                    ))}
                  </div>

                  {selected.active_service ? (
                    <div className="mt-3 rounded-[22px] border border-sky-200 bg-[linear-gradient(180deg,rgba(240,249,255,0.92)_0%,rgba(255,255,255,0.98)_100%)] p-3.5 shadow-[0_12px_28px_rgba(14,165,233,0.08)]">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-sky-700">Servizio attivo PMS</p>
                      <p className="mt-1.5 text-sm font-semibold text-slate-950">{selected.active_service.customer_name}</p>
                      <p className="mt-1 text-xs text-slate-600">{selected.active_service.date} • {selected.active_service.time} • {selected.active_service.hotel_name ?? "Destinazione non disponibile"}</p>
                      <p className="mt-1 text-xs text-slate-600">Stato servizio: {selected.active_service.status} • Linea: {selected.active_service.line_name ?? "N/D"}</p>
                    </div>
                  ) : (
                    <div className="mt-3 rounded-[22px] border border-slate-200 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-3.5 text-xs text-slate-600 shadow-[0_12px_28px_rgba(15,23,42,0.05)]">
                      Ultima posizione nota: {selected.current_address?.trim()
                        ? selected.current_city
                          ? `${selected.current_address} • ${selected.current_city}`
                          : selected.current_address
                        : selected.current_city
                          ? selected.current_city
                          : `${selected.lat.toFixed(5)}, ${selected.lng.toFixed(5)}`}
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link href="/bus-network" className="btn-secondary px-3 py-1.5 text-xs">Apri Rete Bus</Link>
                    <Link href="/fleet-ops" className="btn-secondary px-3 py-1.5 text-xs">Apri dettaglio mezzo</Link>
                    {streetViewUrl && streetViewResult.status === "found" ? (
                      <>
                        <button type="button" onClick={() => setStreetViewOpen((value) => !value)} className="btn-secondary px-3 py-1.5 text-xs">
                          {streetViewOpen ? "Chiudi vista strada" : "Vista strada"}
                        </button>
                        <a href={streetViewUrl} target="_blank" rel="noreferrer" className="btn-secondary px-3 py-1.5 text-xs">
                          Apri Panoramax
                        </a>
                      </>
                    ) : null}
                  </div>
                </article>
              ) : (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">Nessun mezzo disponibile con i filtri attivi.</div>
              )}
            </SectionCard>

            {selected && streetViewOpen && streetViewResult.status === "found" && streetViewUrl ? (
              <SectionCard
                title="Vista strada"
                subtitle="Foto pubblica Panoramax piu vicina alla posizione del mezzo."
                className="overflow-hidden rounded-[28px] border border-slate-200 shadow-[0_18px_50px_rgba(15,23,42,0.08)]"
                bodyClassName="space-y-3 p-4"
              >
                <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
                  <iframe
                    title={`Vista strada ${selected.pms_label ?? selected.label}`}
                    src={streetViewUrl}
                    className="h-[420px] w-full"
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                  />
                </div>
                <div className="grid gap-3 rounded-lg border border-slate-200 bg-white p-3 sm:grid-cols-[96px_minmax(0,1fr)]">
                  {streetViewResult.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={streetViewResult.thumbUrl} alt="" className="h-20 w-24 rounded-lg object-cover" />
                  ) : (
                    <div className="h-20 w-24 rounded-lg bg-slate-100" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-950">Foto Panoramax piu vicina</p>
                    <p className="mt-1 text-xs text-slate-600">
                      Distanza dal mezzo: {Math.round(streetViewResult.distanceMeters)} m
                      {streetViewResult.capturedAt ? ` - Scatto: ${formatTime(streetViewResult.capturedAt)}` : ""}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      Mezzo: {selected.lat.toFixed(5)}, {selected.lng.toFixed(5)} - Foto: {streetViewResult.lat.toFixed(5)}, {streetViewResult.lng.toFixed(5)}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <a href={streetViewUrl} target="_blank" rel="noreferrer" className="btn-secondary px-3 py-1.5 text-xs">
                        Apri a schermo intero
                      </a>
                    </div>
                  </div>
                </div>
              </SectionCard>
            ) : null}

          </div>
        </div>
      )}
      </div>
    </section>
  );
}
