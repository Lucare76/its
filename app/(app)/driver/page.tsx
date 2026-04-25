"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { ServiceStatus } from "@/lib/types";
import { supabase } from "@/lib/supabase/client";
import { usePwa } from "@/components/driver/PwaInit";
import { DriverSign } from "@/components/driver/DriverSign";
import { getFerryArrivalAtIschia } from "@/lib/snav-medmar-lookup";

/* ------------------------------------------------------------------ offline queue */

const OFFLINE_QUEUE_KEY = "it-driver-status-queue-v1";

type QueuedStatusAction = {
  serviceId: string;
  status: ServiceStatus;
  queuedAt: string;
};

function readQueue(): QueuedStatusAction[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(OFFLINE_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as QueuedStatusAction[];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function writeQueue(queue: QueuedStatusAction[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
}

/* ------------------------------------------------------------------ types */

type DriverService = {
  id: string; tenant_id: string; date: string; time: string;
  service_type: string; direction: string; vessel: string; pax: number;
  hotel_id: string | null; customer_name: string; phone: string | null;
  phone_e164: string | null; notes: string | null; status: ServiceStatus;
  meeting_point: string | null; pickup_time: string | null;
  linked_service_id: string | null;
  booking_service_kind: string | null;
};
type DriverAssignment = { id: string; service_id: string; driver_user_id: string; vehicle_label: string };
type DriverHotel = { id: string; name: string; zone: string | null; lat: number | null; lng: number | null };
type DriverStatusEvent = { id: string; service_id: string; status: string; at: string };

type DriverData = {
  services: DriverService[];
  assignments: DriverAssignment[];
  hotels: DriverHotel[];
  status_events: DriverStatusEvent[];
};

/* ------------------------------------------------------------------ helpers */

function formatDateLabel(dateIso: string) {
  const [year, month, day] = dateIso.split("-");
  const months = ["gen","feb","mar","apr","mag","giu","lug","ago","set","ott","nov","dic"];
  return day && month && year ? `${day} ${months[Number(month) - 1]}` : dateIso;
}

function statusColor(status: ServiceStatus) {
  switch (status) {
    case "completato": return "bg-emerald-100 text-emerald-800";
    case "partito":    return "bg-blue-100 text-blue-800";
    case "arrivato":   return "bg-indigo-100 text-indigo-800";
    case "problema":   return "bg-rose-100 text-rose-800";
    case "cancelled":  return "bg-slate-100 text-slate-500";
    default:           return "bg-amber-100 text-amber-800";
  }
}

async function getToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/* ------------------------------------------------------------------ disposizione helpers */

function parseH24Rate(notes: string | null): { day: number; night: number } | null {
  if (!notes) return null;
  const m = notes.match(/\[tariffa_h24:(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\]/);
  if (!m || !m[1] || !m[2]) return null;
  return { day: parseFloat(m[1]), night: parseFloat(m[2]) };
}

function calcDispoCost(startAt: string, endAtOrNull: string | null, rate: { day: number; night: number }, nowMs = Date.now()): { hours: number; cost: number } {
  const start = new Date(startAt).getTime();
  const end = endAtOrNull ? new Date(endAtOrNull).getTime() : nowMs;
  if (end <= start) return { hours: 0, cost: 0 };
  const SLOT = 15 * 60 * 1000;
  let cost = 0;
  let t = start;
  while (t < end) {
    const slotEnd = Math.min(t + SLOT, end);
    const hour = new Date((t + slotEnd) / 2).getHours();
    cost += (hour < 7 || hour >= 22 ? rate.night : rate.day) * ((slotEnd - t) / 3600000);
    t += SLOT;
  }
  return { hours: (end - start) / 3600000, cost };
}

/* ------------------------------------------------------------------ geo helpers */

const ZONE_ORDER: Record<string, number> = {
  porto: 0, ponte: 1, barano: 2, "serrara fontana": 3,
  forio: 4, "lacco ameno": 5, casamicciola: 6,
};
function zoneRank(zone: string | null): number {
  return ZONE_ORDER[zone?.toLowerCase().trim() ?? ""] ?? 99;
}
const PORT_COORDS: Record<string, [number, number]> = {
  casamicciola: [40.7497, 13.9044],
  default: [40.7448, 13.9470],
};
function distFromArrivalPort(lat: number | null, lng: number | null, meetingPoint: string): number {
  if (lat == null || lng == null) return 9999;
  const [pLat, pLng] = meetingPoint.toLowerCase().includes("casamicciola")
    ? PORT_COORDS.casamicciola!
    : PORT_COORDS.default!;
  return Math.sqrt(Math.pow(lat - pLat, 2) + Math.pow(lng - pLng, 2));
}
function routeZoneRank(zone: string, meetingPoint: string): number {
  const z = (zone ?? "").toLowerCase();
  const mp = (meetingPoint ?? "").toLowerCase();
  if (mp.includes("casamicciola")) {
    if (z.includes("casamicciola")) return 0;
    if (z.includes("lacco"))        return 1;
    if (z.includes("forio"))        return 2;
    if (z.includes("serrara"))      return 3;
    return 9;
  }
  // Ischia Porto default: prima vicino al porto, poi a scalare
  if (z.includes("ischia") || z.includes("porto")) return 0;
  if (z.includes("barano"))    return 1;
  if (z.includes("serrara"))   return 2;
  if (z.includes("casamicciola")) return 3;
  if (z.includes("lacco"))     return 4;
  if (z.includes("forio"))     return 5;
  return 9;
}

/* ------------------------------------------------------------------ group type */

type ServiceGroup = {
  key: string;
  label: string;
  direction: "arrival" | "departure";
  totalPax: number;
  entries: { service: DriverService; assignment: DriverAssignment }[];
};

type Tab = "oggi" | "prossimi" | "storico";

/* ================================================================ INNER PAGE */

function DriverPageInner() {
  const { pushState, installPromptAvailable, triggerInstall, subscribePush, unsubscribePush } = usePwa();

  const [tenantId, setTenantId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [driverName, setDriverName] = useState("");
  const [data, setData] = useState<DriverData>({ services: [], assignments: [], hotels: [], status_events: [] });
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [focusServiceId, setFocusServiceId] = useState<string | null>(null);
  const [pendingQueueCount, setPendingQueueCount] = useState(() => readQueue().length);
  const [savingStatus, setSavingStatus] = useState<ServiceStatus | null>(null);
  const [message, setMessage] = useState("");
  const [driverNote, setDriverNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [isOnline, setIsOnline] = useState(() => typeof navigator === "undefined" ? true : navigator.onLine);
  const [tab, setTab] = useState<Tab>("oggi");
  const [showSign, setShowSign] = useState(false);
  const [showInstallHelp, setShowInstallHelp] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [groupEntryOrder, setGroupEntryOrder] = useState<Record<string, string[]>>({});
  const channelRef = useRef<ReturnType<NonNullable<typeof supabase>["channel"]> | null>(null);
  const trackChannelRef = useRef<ReturnType<NonNullable<typeof supabase>["channel"]> | null>(null);
  const geoWatchRef = useRef<number | null>(null);

  /* ---- carica dati driver */
  const refresh = useCallback(async () => {
    const token = await getToken();
    if (!token) { setErrorMessage("Sessione non valida."); setLoading(false); return; }
    const res = await fetch("/api/ops/driver-data", {
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}` }
    });
    const body = await res.json() as {
      ok?: boolean; error?: string;
      tenant_id?: string; user_id?: string;
      services?: DriverService[]; assignments?: DriverAssignment[];
      hotels?: DriverHotel[]; status_events?: DriverStatusEvent[];
    };
    if (!body.ok) { setErrorMessage(body.error ?? "Errore caricamento."); setLoading(false); return; }
    setTenantId(body.tenant_id ?? null);
    setUserId(body.user_id ?? null);
    setData({
      services: body.services ?? [],
      assignments: body.assignments ?? [],
      hotels: body.hotels ?? [],
      status_events: body.status_events ?? [],
    });
    setErrorMessage(null);
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  /* ---- nome driver */
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getUser().then(({ data: authData }) => {
      const meta = authData?.user?.user_metadata as Record<string, unknown> | undefined;
      const name = (meta?.full_name ?? meta?.name ?? "") as string;
      if (name) setDriverName(name);
    });
  }, []);

  /* ---- realtime */
  useEffect(() => {
    if (!supabase || !tenantId || !userId) return;
    let timeout: number | null = null;
    const scheduleRefresh = () => {
      if (timeout) window.clearTimeout(timeout);
      timeout = window.setTimeout(() => void refresh(), 500);
    };
    const ch = supabase
      .channel(`driver-live-${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "assignments", filter: `tenant_id=eq.${tenantId}` }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "services", filter: `tenant_id=eq.${tenantId}` }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "status_events", filter: `tenant_id=eq.${tenantId}` }, scheduleRefresh)
      .subscribe();
    channelRef.current = ch;
    return () => {
      if (timeout) window.clearTimeout(timeout);
      if (supabase) void supabase.removeChannel(ch);
    };
  }, [tenantId, userId, refresh]);

  /* ---- online/offline */
  useEffect(() => {
    const onOnline = () => {
      setIsOnline(true);
      if (tenantId) void flushQueue(tenantId);
    };
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => { window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  useEffect(() => {
    if (!message) return;
    const t = window.setTimeout(() => setMessage(""), 2500);
    return () => window.clearTimeout(t);
  }, [message]);


  /* ---- persist status */
  const persistStatus = useCallback(async (serviceId: string, status: ServiceStatus, tid = tenantId): Promise<boolean> => {
    if (!supabase || !tid || !isOnline || !userId) return false;
    const { error } = await supabase.from("services").update({ status }).eq("id", serviceId).eq("tenant_id", tid);
    if (error) return false;
    await supabase.from("status_events").insert({ tenant_id: tid, service_id: serviceId, status, by_user_id: userId });
    await refresh();
    return true;
  }, [isOnline, refresh, tenantId, userId]);

  const flushQueue = useCallback(async (tid: string) => {
    if (!isOnline) return;
    const queue = readQueue();
    if (!queue.length) return;
    const remaining: QueuedStatusAction[] = [];
    for (const item of queue) {
      const ok = await persistStatus(item.serviceId, item.status, tid);
      if (!ok) remaining.push(item);
    }
    writeQueue(remaining);
    setPendingQueueCount(remaining.length);
    if (!remaining.length) setMessage("Azioni offline sincronizzate.");
  }, [isOnline, persistStatus]);

  const enqueueStatus = (serviceId: string, status: ServiceStatus) => {
    const queue = readQueue();
    queue.push({ serviceId, status, queuedAt: new Date().toISOString() });
    writeQueue(queue);
    setPendingQueueCount(queue.length);
  };

  /* ---- dati derivati */
  const mine = useMemo(() => {
    if (!userId) return [];
    return data.assignments
      .filter((a) => a.driver_user_id === userId)
      .map((a) => {
        const service = data.services.find((s) => s.id === a.service_id);
        return service ? { service, assignment: a } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.service.date !== b.service.date
        ? a.service.date.localeCompare(b.service.date)
        : a.service.time.localeCompare(b.service.time));
  }, [data, userId]);

  const todayIso = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; })();
  const todayServices    = useMemo(() => mine.filter((x) => x.service.date === todayIso), [mine, todayIso]);
  const nextServices     = useMemo(() => mine.filter((x) => x.service.date > todayIso), [mine, todayIso]);
  const completedServices = useMemo(() =>
    [...mine].filter((x) => x.service.status === "completato" || x.service.status === "cancelled")
      .sort((a, b) => b.service.date.localeCompare(a.service.date)).slice(0, 20),
    [mine]);
  const totalPax = useMemo(() =>
    mine.filter((x) => x.service.status === "completato").reduce((s, x) => s + x.service.pax, 0),
    [mine]);

  const defaultFocusId =
    mine.find((x) => x.service.status !== "completato" && x.service.status !== "cancelled")?.service.id ??
    mine.find((x) => x.service.date >= todayIso)?.service.id ??
    null;
  const effectiveFocusId = focusServiceId && mine.some((x) => x.service.id === focusServiceId) ? focusServiceId : defaultFocusId;
  const focused = mine.find((x) => x.service.id === effectiveFocusId) ?? null;
  const focusedHotel = focused ? data.hotels.find((h) => h.id === focused.service.hotel_id) : null;
  const navigationUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${focusedHotel?.lat ?? 40.74},${focusedHotel?.lng ?? 13.9}`)}&travelmode=driving`;
  const customerPhone = focused?.service.phone_e164?.trim() || focused?.service.phone?.trim() || "";
  const focusedEvents = focused
    ? [...data.status_events].filter((e) => e.service_id === focused.service.id)
        .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5)
    : [];

  const isDisposizione = focused?.service.booking_service_kind === "private_island";
  const h24Rate = isDisposizione ? parseH24Rate(focused?.service.notes ?? null) : null;
  const allFocusedEvents = focused
    ? [...data.status_events].filter((e) => e.service_id === focused.service.id).sort((a, b) => a.at.localeCompare(b.at))
    : [];
  const dispoStartEvent = isDisposizione ? (allFocusedEvents.find((e) => e.status === "partito") ?? null) : null;
  const dispoEndEvent = isDisposizione ? (allFocusedEvents.find((e) => e.status === "completato") ?? null) : null;
  const dispoCost = isDisposizione && dispoStartEvent && h24Rate
    ? calcDispoCost(dispoStartEvent.at, dispoEndEvent?.at ?? null, h24Rate, now)
    : null;
  const appOrigin = typeof window !== "undefined" ? window.location.origin : "https://ischiatransferservice.it";

  /* ---- grouping helpers per tab */
  const buildGroups = useCallback((entries: typeof mine): ServiceGroup[] => {
    const arrivals = entries.filter((e) => e.service.direction !== "departure");
    const departures = entries.filter((e) => e.service.direction === "departure");
    const makeGroups = (list: typeof mine, keyFn: (e: typeof mine[0]) => string, labelFn: (e: typeof mine[0]) => string, direction: "arrival" | "departure") => {
      const map = new Map<string, ServiceGroup>();
      for (const entry of list) {
        const k = keyFn(entry);
        if (!map.has(k)) map.set(k, { key: k, label: labelFn(entry), direction, totalPax: 0, entries: [] });
        const g = map.get(k)!;
        g.totalPax += entry.service.pax;
        g.entries.push(entry);
      }
      if (direction === "arrival") {
        for (const g of map.values()) {
          const mp = g.entries[0]?.service.meeting_point ?? "";
          g.entries.sort((a, b) => {
            const ah = data.hotels.find((h) => h.id === a.service.hotel_id);
            const bh = data.hotels.find((h) => h.id === b.service.hotel_id);
            const rankDiff = routeZoneRank(ah?.zone ?? "", mp) - routeZoneRank(bh?.zone ?? "", mp);
            if (rankDiff !== 0) return rankDiff;
            return distFromArrivalPort(ah?.lat ?? null, ah?.lng ?? null, mp)
                 - distFromArrivalPort(bh?.lat ?? null, bh?.lng ?? null, mp);
          });
        }
      }
      return [...map.values()];
    };
    const ferryLabel = (kind: string | null, depTime: string | null) => {
      const company = (kind ?? "").includes("snav") ? "SNAV" : (kind ?? "").includes("medmar") ? "Medmar" : null;
      return company ?? null;
    };
    const arrGroups = makeGroups(
      arrivals,
      (e) => `${e.service.date}_${e.service.vessel || "N/D"}_${e.service.time.slice(0, 5)}`,
      (e) => {
        const company = ferryLabel(e.service.booking_service_kind, e.service.time);
        const depTime = e.service.time?.slice(0, 5) ?? "";
        if (company && depTime) return `${company} ${depTime}`;
        const vesselLabel = e.service.vessel ?? "N/D";
        return depTime ? `${vesselLabel} · ${depTime}` : vesselLabel;
      },
      "arrival"
    );
    const depGroups = makeGroups(
      departures,
      (e) => `${e.service.date}_${e.service.hotel_id ?? "none"}_${e.service.time}`,
      (e) => {
        const hotelName = data.hotels.find((h) => h.id === e.service.hotel_id)?.name ?? "N/D";
        const company = ferryLabel(e.service.booking_service_kind, e.service.time);
        const t = e.service.time?.slice(0, 5) ?? "";
        return `${company && t ? `${company} ${t} · ` : ""}${hotelName}`;
      },
      "departure"
    );
    return [...arrGroups, ...depGroups].sort((a, b) => {
      const af = a.entries[0]?.service;
      const bf = b.entries[0]?.service;
      if (!af || !bf) return 0;
      if (af.date !== bf.date) return af.date.localeCompare(bf.date);
      const at = a.direction === "arrival"
        ? (getFerryArrivalAtIschia(af.time, af.booking_service_kind) ?? af.time ?? "")
        : (af.pickup_time ?? af.time ?? "");
      const bt = b.direction === "arrival"
        ? (getFerryArrivalAtIschia(bf.time, bf.booking_service_kind) ?? bf.time ?? "")
        : (bf.pickup_time ?? bf.time ?? "");
      return at.localeCompare(bt);
    });
  }, [data.hotels]);

  const getGroupEntries = useCallback((group: ServiceGroup, tabKey: string) => {
    const customIds = groupEntryOrder[`${tabKey}|${group.key}`];
    if (!customIds) return group.entries;
    return customIds.map((id) => group.entries.find((e) => e.service.id === id)).filter((e): e is NonNullable<typeof e> => e != null);
  }, [groupEntryOrder]);

  const moveGroupEntry = useCallback((group: ServiceGroup, tabKey: string, serviceId: string, dir: -1 | 1) => {
    const key = `${tabKey}|${group.key}`;
    setGroupEntryOrder((prev) => {
      const ids = prev[key] ?? group.entries.map((e) => e.service.id);
      const idx = ids.indexOf(serviceId);
      if (idx === -1) return prev;
      const ni = idx + dir;
      if (ni < 0 || ni >= ids.length) return prev;
      const next = [...ids];
      [next[idx], next[ni]] = [next[ni], next[idx]];
      return { ...prev, [key]: next };
    });
  }, []);

  const handleStatusAction = async (status: ServiceStatus) => {
    if (!focused) return;
    setSavingStatus(status);
    const ok = await persistStatus(focused.service.id, status);
    if (!ok) { enqueueStatus(focused.service.id, status); setMessage("Salvato offline — sincronizzo appena online."); }
    else setMessage(`Stato: ${status.toUpperCase()}`);
    setSavingStatus(null);
  };

  const handleDriverNote = async () => {
    if (!focused || !supabase || !tenantId || !driverNote.trim()) return;
    setSavingNote(true);
    const nextNotes = `${focused.service.notes ?? ""} [driver_note:${driverNote.trim()}]`.trim();
    const { error } = await supabase.from("services").update({ notes: nextNotes }).eq("id", focused.service.id).eq("tenant_id", tenantId);
    if (!error) { setDriverNote(""); await refresh(); setMessage("Nota salvata."); }
    setSavingNote(false);
  };

  const isIos = useMemo(() => {
    if (typeof navigator === "undefined") return false;
    return /iphone|ipad|ipod/.test(navigator.userAgent.toLowerCase());
  }, []);
  const isStandalone = useMemo(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(display-mode: standalone)").matches || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  }, []);

  const isExclusive = focused
    ? (focused.service.booking_service_kind?.includes("exclusive") ?? false) ||
      (focused.service.pax <= 6 && !!focused.service.customer_name)
    : false;

  const handleInstallApp = () => {
    if (installPromptAvailable) {
      triggerInstall();
      return;
    }
    setShowInstallHelp(true);
  };

  /* ---- live clock per disposizione in corso */
  const focusedIsDisposizione = focused?.service.booking_service_kind === "private_island";
  const focusedIsRunning = focused?.service.status === "partito";
  useEffect(() => {
    if (!focusedIsDisposizione || !focusedIsRunning) return;
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, [focusedIsDisposizione, focusedIsRunning]);

  /* ---- GPS broadcasting per disposizione avviata */
  useEffect(() => {
    if (!supabase || !focusedIsDisposizione || !focusedIsRunning || !focused) {
      if (geoWatchRef.current != null && typeof navigator !== "undefined") {
        navigator.geolocation.clearWatch(geoWatchRef.current);
        geoWatchRef.current = null;
      }
      if (trackChannelRef.current) {
        void supabase?.removeChannel(trackChannelRef.current);
        trackChannelRef.current = null;
      }
      return;
    }
    const serviceId = focused.service.id;
    const ch = supabase.channel(`driver-track-${serviceId}`, {
      config: { presence: { key: userId ?? "driver" } }
    });
    trackChannelRef.current = ch;
    void ch.subscribe(async (status) => {
      if (status !== "SUBSCRIBED" || typeof navigator === "undefined" || !("geolocation" in navigator)) return;
      geoWatchRef.current = navigator.geolocation.watchPosition(
        async (pos) => { await ch.track({ lat: pos.coords.latitude, lng: pos.coords.longitude, ts: Date.now() }); },
        undefined,
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
      );
    });
    return () => {
      if (geoWatchRef.current != null && typeof navigator !== "undefined") {
        navigator.geolocation.clearWatch(geoWatchRef.current);
        geoWatchRef.current = null;
      }
      void supabase?.removeChannel(ch);
      trackChannelRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedIsDisposizione, focusedIsRunning, focused?.service.id, userId]);

  if (loading) return <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">Caricamento...</div>;
  if (errorMessage) return <div className="p-4 text-sm text-rose-600">{errorMessage}</div>;

  return (
    <div className="mx-auto max-w-lg space-y-4 px-2 pb-10 pt-4">

      {/* Cartello digitale — overlay fullscreen */}
      {showSign && focused && (
        <DriverSign
          customerName={focused.service.customer_name}
          hotelName={focusedHotel?.name ?? focused.service.meeting_point ?? null}
          isExclusive={isExclusive}
          onClose={() => setShowSign(false)}
        />
      )}

      {showInstallHelp && !isStandalone && (
        <div className="fixed inset-0 z-50 flex items-end bg-slate-950/60 px-3 pb-4" onClick={() => setShowInstallHelp(false)}>
          <div className="w-full rounded-3xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <p className="text-lg font-black text-slate-900">Installa app autista</p>
                <p className="mt-0.5 text-sm text-slate-500">
                  {isIos ? "Segui questi passaggi su Safari" : "Segui questi passaggi su Chrome"}
                </p>
              </div>
              <button type="button" onClick={() => setShowInstallHelp(false)}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-200 text-slate-500 text-xl font-bold">
                ×
              </button>
            </div>

            {isIos ? (
              <ol className="space-y-3">
                {[
                  { icon: "1️⃣", text: "Apri questa pagina in Safari (non Chrome, non altri browser)" },
                  { icon: "2️⃣", text: <>Tocca il tasto <span className="inline-block rounded bg-slate-100 px-1.5 py-0.5 font-bold text-slate-800">Condividi</span> <span className="text-base">⎋</span> nella barra in basso al centro</> },
                  { icon: "3️⃣", text: <>Scorri l&apos;elenco e tocca <span className="font-bold text-slate-900">Aggiungi a schermata Home</span></> },
                  { icon: "4️⃣", text: <>Tocca <span className="font-bold text-slate-900">Aggiungi</span> in alto a destra</> },
                ].map((step, i) => (
                  <li key={i} className="flex items-start gap-3 rounded-2xl bg-slate-50 px-3 py-2.5 text-sm text-slate-700">
                    <span className="text-lg leading-none mt-0.5">{step.icon}</span>
                    <span className="leading-5">{step.text}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="space-y-3">
                <div className="rounded-2xl bg-blue-50 border border-blue-100 px-3 py-2.5">
                  <p className="text-xs font-bold text-blue-700 uppercase tracking-wide mb-1">Modo più veloce</p>
                  <p className="text-sm text-slate-700">Guarda nella <span className="font-bold text-slate-900">barra degli indirizzi</span> di Chrome: se vedi una piccola icona <span className="font-mono font-bold">⊕</span> o un telefono con il simbolo +, toccala direttamente.</p>
                </div>
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide px-1">Oppure dal menu</p>
                <ol className="space-y-2">
                  {[
                    { icon: "1️⃣", text: "Assicurati di usare Chrome" },
                    { icon: "2️⃣", text: <>Tocca i <span className="inline-block rounded bg-slate-100 px-1.5 py-0.5 font-bold text-slate-800">tre puntini ⋮</span> in alto a destra</> },
                    { icon: "3️⃣", text: <>Cerca <span className="font-bold text-slate-900">Installa app</span> oppure <span className="font-bold text-slate-900">Aggiungi a schermata Home</span> — se non lo vedi scorri verso il basso nel menu</> },
                    { icon: "4️⃣", text: <>Tocca <span className="font-bold text-slate-900">Installa</span> o <span className="font-bold text-slate-900">Aggiungi</span> nella finestra che appare</> },
                  ].map((step, i) => (
                    <li key={i} className="flex items-start gap-3 rounded-2xl bg-slate-50 px-3 py-2.5 text-sm text-slate-700">
                      <span className="text-lg leading-none mt-0.5">{step.icon}</span>
                      <span className="leading-5">{step.text}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            <button type="button" onClick={() => setShowInstallHelp(false)}
              className="mt-4 w-full rounded-2xl bg-slate-900 py-3 text-sm font-bold text-white active:scale-95 transition">
              Capito
            </button>
          </div>
        </div>
      )}

      {/* Header profilo */}
      <div className="rounded-2xl bg-slate-900 px-5 py-4 text-white">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Autista</p>
            <p className="mt-0.5 text-lg font-bold">{driverName || "Driver"}</p>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${isOnline ? "bg-emerald-500" : "bg-rose-500"}`}>
            {isOnline ? "● Online" : "● Offline"}
          </span>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3">
          {[
            { label: "Oggi", value: todayServices.length },
            { label: "Prossimi", value: nextServices.length },
            { label: "Pax completati", value: totalPax },
          ].map((s) => (
            <div key={s.label} className="rounded-xl bg-white/10 px-3 py-2 text-center">
              <p className="text-xl font-bold">{s.value}</p>
              <p className="text-[10px] text-slate-400">{s.label}</p>
            </div>
          ))}
        </div>
        {pendingQueueCount > 0 && (
          <p className="mt-3 rounded-xl bg-amber-500/20 px-3 py-1.5 text-xs font-semibold text-amber-300">
            ⚠ {pendingQueueCount} azioni in attesa di sincronizzazione
          </p>
        )}

        {/* Bottoni PWA */}
        <div className="mt-3 flex flex-wrap gap-2">
          {!isStandalone && (
            <button onClick={handleInstallApp}
              className="rounded-xl bg-white px-3 py-1.5 text-xs font-bold text-slate-900 hover:bg-slate-100 active:scale-95 transition">
              Installa app
            </button>
          )}
          {pushState === "unsubscribed" && (
            <button onClick={() => void subscribePush()}
              className="rounded-xl bg-blue-500/80 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 active:scale-95 transition">
              🔔 Attiva notifiche
            </button>
          )}
          {pushState === "subscribed" && (
            <button onClick={() => void unsubscribePush()}
              className="rounded-xl bg-white/10 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-white/15 active:scale-95 transition">
              🔕 Disattiva notifiche
            </button>
          )}
          {pushState === "blocked" && (
            <span className="rounded-xl bg-rose-500/20 px-3 py-1.5 text-xs font-semibold text-rose-300">
              ⚠ Notifiche bloccate dal browser
            </span>
          )}
        </div>

      </div>

      {/* Servizio in focus */}
      {focused ? (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className={`px-5 py-2 text-xs font-bold uppercase tracking-wider ${statusColor(focused.service.status)}`}>
            {focused.service.status}
          </div>
          <div className="p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-2xl font-bold text-slate-900">{focused.service.customer_name}</p>
                <p className="text-sm text-slate-500 mt-0.5">{formatDateLabel(focused.service.date)} · {focused.service.time} · {focused.service.pax} pax</p>
                {focused.service.pickup_time && (
                  <p className="text-xs font-semibold text-amber-700 mt-0.5">⏱ Prelevamento: {focused.service.pickup_time}</p>
                )}
                <p className="text-xs text-slate-400 mt-0.5">{focused.service.vessel}</p>
              </div>
              <div className="flex flex-col gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setShowSign(true)}
                  className="rounded-xl bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 active:scale-95 transition">
                  🪧 Cartello
                </button>
                <Link href={`/driver/${focused.service.id}`} className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 text-center">
                  Dettagli
                </Link>
              </div>
            </div>
            <div className="rounded-xl bg-slate-50 px-4 py-3 space-y-1">
              <p className="font-semibold text-slate-800">{focusedHotel?.name ?? focused.service.meeting_point ?? "Destinazione N/D"}</p>
              <p className="text-sm text-slate-500">{focusedHotel?.zone ?? ""}</p>
              {focused.assignment.vehicle_label && (
                <p className="text-xs font-mono text-slate-400">{focused.assignment.vehicle_label}</p>
              )}
            </div>
            {focused.service.notes && !isDisposizione && (
              <div className="rounded-xl bg-amber-50 border border-amber-100 px-4 py-3 text-sm text-amber-800">
                {focused.service.notes.replace(/\[tariffa_h24:[^\]]*\]/g, "").trim()}
              </div>
            )}
            {/* Disposizione H24 badge + calcolo costo */}
            {isDisposizione && (
              <div className="rounded-xl bg-indigo-50 border border-indigo-200 px-4 py-3 space-y-2">
                <span className="inline-block rounded-full bg-indigo-600 px-3 py-1 text-xs font-bold text-white uppercase tracking-wide">Disposizione H24</span>
                {h24Rate && (
                  <p className="text-xs text-indigo-600">Tariffa: €{h24Rate.day}/h diurna · €{h24Rate.night}/h notturna</p>
                )}
                {dispoStartEvent && (
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-indigo-700 font-medium">Inizio:</span>
                      <span className="font-semibold text-indigo-900">{new Date(dispoStartEvent.at).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}</span>
                    </div>
                    {dispoEndEvent && (
                      <div className="flex justify-between">
                        <span className="text-indigo-700 font-medium">Fine:</span>
                        <span className="font-semibold text-indigo-900">{new Date(dispoEndEvent.at).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}</span>
                      </div>
                    )}
                    {dispoCost && (
                      <div className="mt-1 rounded-lg bg-indigo-100 px-3 py-2 flex items-center justify-between">
                        <span className="text-sm font-semibold text-indigo-700">{dispoCost.hours.toFixed(2).replace(".", ",")} ore</span>
                        <span className="text-base font-bold text-indigo-900">€ {dispoCost.cost.toFixed(2).replace(".", ",")}</span>
                      </div>
                    )}
                    {!dispoEndEvent && dispoCost && (
                      <p className="text-[10px] text-indigo-400 text-center">in corso — aggiornato ogni minuto</p>
                    )}
                  </div>
                )}
                {focused.service.notes && (() => {
                  const vis = focused.service.notes.replace(/\[tariffa_h24:[^\]]*\]/g, "").trim();
                  return vis ? <p className="text-xs text-indigo-700 border-t border-indigo-200 pt-2">{vis}</p> : null;
                })()}
              </div>
            )}
            {isDisposizione ? (
              <div className="space-y-2">
                <button type="button" disabled={savingStatus !== null} onClick={() => void handleStatusAction("partito")}
                  className="w-full rounded-2xl py-4 text-sm font-bold uppercase tracking-wide border-2 border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition active:scale-95 disabled:opacity-50">
                  {savingStatus === "partito" ? "..." : "▶ Inizio disposizione"}
                </button>
                <button type="button" disabled={savingStatus !== null} onClick={() => void handleStatusAction("completato")}
                  className="w-full rounded-2xl py-4 text-sm font-bold uppercase tracking-wide border-2 border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition active:scale-95 disabled:opacity-50">
                  {savingStatus === "completato" ? "..." : "⏹ Fine disposizione"}
                </button>
                <button type="button" disabled={savingStatus !== null} onClick={() => void handleStatusAction("problema")}
                  className="w-full rounded-2xl py-3 text-sm font-bold uppercase tracking-wide border-2 border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 transition active:scale-95 disabled:opacity-50">
                  {savingStatus === "problema" ? "..." : "Problema"}
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {(["partito", "arrivato", "completato", "problema"] as ServiceStatus[]).map((s) => (
                  <button key={s} type="button" disabled={savingStatus !== null} onClick={() => void handleStatusAction(s)}
                    className={`rounded-2xl py-4 text-sm font-bold uppercase tracking-wide transition active:scale-95 disabled:opacity-50 ${
                      s === "problema" ? "border-2 border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
                      : s === "completato" ? "border-2 border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                      : "border-2 border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"
                    }`}>
                    {savingStatus === s ? "..." : s}
                  </button>
                ))}
              </div>
            )}
            <div className="flex gap-3">
              {customerPhone && (
                <a href={`tel:${customerPhone}`} className="flex-1 rounded-2xl border-2 border-slate-200 py-3 text-center text-sm font-semibold text-slate-700 hover:bg-slate-50">
                  📞 Chiama
                </a>
              )}
              {isDisposizione && customerPhone && (
                <a href={`https://wa.me/${customerPhone.replace(/\D/g, "")}?text=${encodeURIComponent(`Il Suo autista è in arrivo. Può seguire la posizione in tempo reale: ${appOrigin}/track/${focused.service.id}`)}`}
                  target="_blank" rel="noreferrer"
                  className="flex-1 rounded-2xl border-2 border-green-200 bg-green-50 py-3 text-center text-sm font-semibold text-green-700 hover:bg-green-100">
                  📍 WhatsApp
                </a>
              )}
              <a href={navigationUrl} target="_blank" rel="noreferrer" className="flex-1 rounded-2xl border-2 border-slate-200 py-3 text-center text-sm font-semibold text-slate-700 hover:bg-slate-50">
                🗺 Naviga
              </a>
            </div>
            <div>
              <textarea className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-300"
                rows={2} value={driverNote} onChange={(e) => setDriverNote(e.target.value)}
                placeholder="Nota rapida (bagagli, ritardo, variazioni...)" />
              <button type="button" disabled={savingNote || !driverNote.trim()} onClick={() => void handleDriverNote()}
                className="mt-2 w-full rounded-xl bg-slate-800 py-3 text-sm font-semibold text-white disabled:opacity-40 hover:bg-slate-700">
                {savingNote ? "Salvataggio..." : "Salva nota"}
              </button>
            </div>
            {focusedEvents.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Storico stati</p>
                <div className="space-y-1.5">
                  {focusedEvents.map((e) => (
                    <div key={e.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${statusColor(e.status as ServiceStatus)}`}>{e.status}</span>
                      <span className="text-xs text-slate-400">{new Date(e.at).toLocaleString("it-IT")}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
          Nessun servizio assegnato.
        </div>
      )}

      {/* Tab lista servizi */}
      <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
        <div className="flex border-b border-slate-100">
          {([
            { key: "oggi" as Tab,     label: `Oggi (${todayServices.length})` },
            { key: "prossimi" as Tab, label: `Prossimi (${nextServices.length})` },
            { key: "storico" as Tab,  label: `Storico (${completedServices.length})` },
          ]).map((t) => (
            <button key={t.key} type="button" onClick={() => setTab(t.key)}
              className={`flex-1 py-3 text-xs font-semibold transition ${tab === t.key ? "border-b-2 border-blue-500 text-blue-700" : "text-slate-500 hover:text-slate-700"}`}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="divide-y divide-slate-50">
          {tab === "oggi" && (
            todayServices.length === 0
              ? <p className="p-4 text-center text-sm text-slate-400">Nessun servizio oggi.</p>
              : buildGroups(todayServices).map((group) => (
                  <div key={group.key}>
                    <button type="button"
                      onClick={() => setExpandedGroup(expandedGroup === `oggi-${group.key}` ? null : `oggi-${group.key}`)}
                      className="w-full px-4 py-3 text-left flex items-center justify-between hover:bg-slate-50 transition">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          {(() => {
                            const svc = group.entries[0]?.service;
                            const isNavetta = svc?.booking_service_kind === "shuttle_hotel" || svc?.service_type === "navetta";
                            return <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${isNavetta ? "bg-violet-100 text-violet-700" : group.direction === "arrival" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                              {isNavetta ? "⇄ Navetta" : group.direction === "arrival" ? "↓ Arrivo" : "↑ Partenza"}
                            </span>;
                          })()}
                          <p className="font-semibold text-slate-800 text-sm truncate">{group.label}</p>
                          {(() => {
                            const first = group.entries[0]?.service;
                            if (!first) return null;
                            const t = group.direction === "arrival"
                              ? (getFerryArrivalAtIschia(first.time, first.booking_service_kind) ?? first.time?.slice(0,5))
                              : (first.pickup_time?.slice(0,5) ?? first.time?.slice(0,5));
                            return t ? <span className="shrink-0 text-sm font-bold text-slate-900">{t}</span> : null;
                          })()}
                        </div>
                        <p className="text-xs text-slate-400 mt-0.5 truncate">
                          {group.entries.map((e) => `${e.service.pax} ${e.service.customer_name}`).join(" · ")}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-700">{group.totalPax} pax</span>
                        <span className="text-slate-400 text-sm">{expandedGroup === `oggi-${group.key}` ? "▲" : "▼"}</span>
                      </div>
                    </button>
                    {expandedGroup === `oggi-${group.key}` && (
                      <div className="bg-slate-50 border-t border-slate-100 divide-y divide-slate-100">
                        {getGroupEntries(group, "oggi").map((entry) => {
                          const hotel = data.hotels.find((h) => h.id === entry.service.hotel_id);
                          const phone = entry.service.phone_e164?.trim() || entry.service.phone?.trim() || "";
                          return (
                            <div key={entry.service.id} className="flex items-center gap-2 px-4 py-2.5">
                              <button type="button"
                                onClick={() => { setFocusServiceId(entry.service.id); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                                className="flex-1 text-left">
                                <div className="flex items-center justify-between">
                                  <p className="text-sm font-semibold text-slate-700">{entry.service.customer_name}</p>
                                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${statusColor(entry.service.status)}`}>{entry.service.status}</span>
                                </div>
                                {entry.service.direction === "departure" ? (
                                  <>
                                    <p className="text-xs text-slate-400 mt-0.5">{hotel?.name ?? "N/D"} · {entry.service.pax} pax</p>
                                    {entry.service.vessel ? <p className="text-xs font-medium text-amber-700 mt-0.5">🚢 {entry.service.vessel}{entry.service.pickup_time ? ` · prelievo ${entry.service.pickup_time}` : ""}</p> : null}
                                  </>
                                ) : (
                                  <p className="text-xs text-slate-400 mt-0.5">{hotel?.name ?? "N/D"} · {entry.service.pax} pax · {entry.service.time}</p>
                                )}
                              </button>
                              {phone && (
                                <a href={`tel:${phone}`} onClick={(e) => e.stopPropagation()}
                                  className="shrink-0 rounded-xl bg-blue-50 px-2.5 py-1.5 text-xs font-semibold text-blue-600">
                                  📞
                                </a>
                              )}
                              {group.direction === "arrival" && (
                                <div className="flex flex-col shrink-0">
                                  <button type="button" onClick={(e) => { e.stopPropagation(); moveGroupEntry(group, "oggi", entry.service.id, -1); }}
                                    className="h-5 w-6 flex items-center justify-center rounded text-slate-400 hover:text-slate-700 hover:bg-slate-200 text-xs">↑</button>
                                  <button type="button" onClick={(e) => { e.stopPropagation(); moveGroupEntry(group, "oggi", entry.service.id, 1); }}
                                    className="h-5 w-6 flex items-center justify-center rounded text-slate-400 hover:text-slate-700 hover:bg-slate-200 text-xs">↓</button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))
          )}
          {tab === "prossimi" && (
            nextServices.length === 0
              ? <p className="p-4 text-center text-sm text-slate-400">Nessun servizio futuro.</p>
              : buildGroups(nextServices).map((group) => (
                  <div key={group.key}>
                    <button type="button"
                      onClick={() => setExpandedGroup(expandedGroup === `prossimi-${group.key}` ? null : `prossimi-${group.key}`)}
                      className="w-full px-4 py-3 text-left flex items-center justify-between hover:bg-slate-50 transition">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          {(() => {
                            const svc = group.entries[0]?.service;
                            const isNavetta = svc?.booking_service_kind === "shuttle_hotel" || svc?.service_type === "navetta";
                            return <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${isNavetta ? "bg-violet-100 text-violet-700" : group.direction === "arrival" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                              {isNavetta ? "⇄ Navetta" : group.direction === "arrival" ? "↓ Arrivo" : "↑ Partenza"}
                            </span>;
                          })()}
                          <p className="font-semibold text-slate-800 text-sm truncate">{group.label}</p>
                          {(() => {
                            const first = group.entries[0]?.service;
                            if (!first) return null;
                            const t = group.direction === "arrival"
                              ? (getFerryArrivalAtIschia(first.time, first.booking_service_kind) ?? first.time?.slice(0,5))
                              : (first.pickup_time?.slice(0,5) ?? first.time?.slice(0,5));
                            return t ? <span className="shrink-0 text-sm font-bold text-slate-900">{t}</span> : null;
                          })()}
                        </div>
                        <p className="text-xs text-slate-400 mt-0.5 truncate">
                          {group.entries.map((e) => `${e.service.pax} ${e.service.customer_name}`).join(" · ")}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-700">{group.totalPax} pax</span>
                        <span className="text-slate-400 text-sm">{expandedGroup === `prossimi-${group.key}` ? "▲" : "▼"}</span>
                      </div>
                    </button>
                    {expandedGroup === `prossimi-${group.key}` && (
                      <div className="bg-slate-50 border-t border-slate-100 divide-y divide-slate-100">
                        {getGroupEntries(group, "prossimi").map((entry) => {
                          const hotel = data.hotels.find((h) => h.id === entry.service.hotel_id);
                          const phone = entry.service.phone_e164?.trim() || entry.service.phone?.trim() || "";
                          return (
                            <div key={entry.service.id} className="flex items-center gap-2 px-4 py-2.5">
                              <button type="button"
                                onClick={() => { setFocusServiceId(entry.service.id); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                                className="flex-1 text-left">
                                <div className="flex items-center justify-between">
                                  <p className="text-sm font-semibold text-slate-700">{entry.service.customer_name}</p>
                                  <span className="text-xs text-slate-500">
                                    {formatDateLabel(entry.service.date)}{" "}
                                    {entry.service.direction !== "departure"
                                      ? (getFerryArrivalAtIschia(entry.service.time, entry.service.booking_service_kind) ?? entry.service.time?.slice(0,5))
                                      : entry.service.time?.slice(0,5)}
                                  </span>
                                </div>
                                {entry.service.direction === "departure" ? (
                                  <>
                                    <p className="text-xs text-slate-400 mt-0.5">{hotel?.name ?? "N/D"} · {entry.service.pax} pax</p>
                                    {entry.service.vessel ? <p className="text-xs font-medium text-amber-700 mt-0.5">🚢 {entry.service.vessel}{entry.service.pickup_time ? ` · prelievo ${entry.service.pickup_time}` : ""}</p> : null}
                                  </>
                                ) : (
                                  <>
                                    <p className="text-xs text-slate-400 mt-0.5">{hotel?.name ?? "N/D"} · {entry.service.pax} pax</p>
                                    {(() => {
                                      const arrIschia = getFerryArrivalAtIschia(entry.service.time, entry.service.booking_service_kind);
                                      return (
                                        <>
                                          <p className="text-sm font-bold text-emerald-700 mt-0.5">
                                            ⚓ {entry.service.meeting_point ?? "Porto N/D"}{arrIschia ? ` · arr. ${arrIschia}` : ""}
                                          </p>
                                          {arrIschia && <p className="text-xs text-slate-400">partenza continente {entry.service.time?.slice(0,5)}</p>}
                                        </>
                                      );
                                    })()}
                                  </>
                                )}
                              </button>
                              {phone && (
                                <a href={`tel:${phone}`} onClick={(e) => e.stopPropagation()}
                                  className="shrink-0 rounded-xl bg-blue-50 px-2.5 py-1.5 text-xs font-semibold text-blue-600">
                                  📞
                                </a>
                              )}
                              {group.direction === "arrival" && (
                                <div className="flex flex-col shrink-0">
                                  <button type="button" onClick={(e) => { e.stopPropagation(); moveGroupEntry(group, "prossimi", entry.service.id, -1); }}
                                    className="h-5 w-6 flex items-center justify-center rounded text-slate-400 hover:text-slate-700 hover:bg-slate-200 text-xs">↑</button>
                                  <button type="button" onClick={(e) => { e.stopPropagation(); moveGroupEntry(group, "prossimi", entry.service.id, 1); }}
                                    className="h-5 w-6 flex items-center justify-center rounded text-slate-400 hover:text-slate-700 hover:bg-slate-200 text-xs">↓</button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))
          )}
          {tab === "storico" && (
            completedServices.length === 0
              ? <p className="p-4 text-center text-sm text-slate-400">Nessuna corsa completata.</p>
              : completedServices.map((entry) => {
                  const hotel = data.hotels.find((h) => h.id === entry.service.hotel_id);
                  return (
                    <div key={entry.service.id} className="px-4 py-3">
                      <div className="flex items-center justify-between">
                        <p className="font-semibold text-slate-700">{entry.service.customer_name}</p>
                        <span className="text-xs text-slate-400">{formatDateLabel(entry.service.date)}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${statusColor(entry.service.status)}`}>{entry.service.status}</span>
                        <span className="text-xs text-slate-400">{hotel?.name ?? "N/D"} · {entry.service.pax} pax</span>
                      </div>
                    </div>
                  );
                })
          )}
        </div>
      </div>

      {/* Toast */}
      {message && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-xl z-50">
          {message}
        </div>
      )}
    </div>
  );
}

/* ================================================================ EXPORT */

export default function DriverPage() {
  return <DriverPageInner />;
}
