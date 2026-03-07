"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { useDemoStore } from "@/lib/use-demo-store";
import type { ServiceStatus } from "@/lib/types";

const demoDriverUserId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4";
const OFFLINE_QUEUE_KEY = "it-driver-status-queue-v1";

type QueuedStatusAction = {
  serviceId: string;
  status: ServiceStatus;
  queuedAt: string;
};

function statusBadgeClass(status: ServiceStatus) {
  return `status-badge status-badge-${status}`;
}

function readQueue(): QueuedStatusAction[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(OFFLINE_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as QueuedStatusAction[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedStatusAction[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
}

export default function DriverPage() {
  const { state, loading, replaceTenantOperationalData, setServiceStatus } = useDemoStore();
  const [driverUserId, setDriverUserId] = useState(demoDriverUserId);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [focusServiceId, setFocusServiceId] = useState<string | null>(null);
  const [liveConnected, setLiveConnected] = useState(false);
  const [pendingQueueCount, setPendingQueueCount] = useState(() => readQueue().length);
  const [savingStatus, setSavingStatus] = useState<ServiceStatus | null>(null);
  const [message, setMessage] = useState("");
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));

  const persistStatus = useCallback(
    async (serviceId: string, status: ServiceStatus, currentTenantId: string | null = tenantId) => {
      if (!hasSupabaseEnv || !supabase || !currentTenantId || !isOnline) return false;

      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData.user) return false;

      const { error: serviceError } = await supabase
        .from("services")
        .update({ status })
        .eq("id", serviceId)
        .eq("tenant_id", currentTenantId);
      if (serviceError) return false;

      const { error: eventError } = await supabase.from("status_events").insert({
        tenant_id: currentTenantId,
        service_id: serviceId,
        status,
        by_user_id: userData.user.id
      });

      return !eventError;
    },
    [isOnline, tenantId]
  );

  const flushQueue = useCallback(
    async (currentTenantId: string) => {
      if (!hasSupabaseEnv || !supabase || !currentTenantId || !isOnline) return;
      const queue = readQueue();
      if (queue.length === 0) return;

      const remaining: QueuedStatusAction[] = [];
      for (const item of queue) {
        const ok = await persistStatus(item.serviceId, item.status, currentTenantId);
        if (!ok) remaining.push(item);
      }
      writeQueue(remaining);
      setPendingQueueCount(remaining.length);
      if (remaining.length === 0) setMessage("Azioni offline sincronizzate.");
    },
    [isOnline, persistStatus]
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onOnline = () => {
      setIsOnline(true);
      if (tenantId) {
        void flushQueue(tenantId);
      }
    };
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [tenantId, flushQueue]);

  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(""), 2200);
    return () => window.clearTimeout(timeout);
  }, [message]);

  useEffect(() => {
    const client = supabase;
    if (!hasSupabaseEnv || !client) return;

    let isActive = true;
    let refreshTimeout: number | null = null;
    let fallbackInterval: number | null = null;

    const loadTenantData = async (currentTenantId: string) => {
      const [servicesResult, assignmentsResult, statusEventsResult, hotelsResult, membershipsResult] = await Promise.all([
        client.from("services").select("*").eq("tenant_id", currentTenantId),
        client.from("assignments").select("*").eq("tenant_id", currentTenantId),
        client.from("status_events").select("*").eq("tenant_id", currentTenantId),
        client.from("hotels").select("*").eq("tenant_id", currentTenantId),
        client.from("memberships").select("*").eq("tenant_id", currentTenantId)
      ]);

      if (
        servicesResult.error ||
        assignmentsResult.error ||
        statusEventsResult.error ||
        hotelsResult.error ||
        membershipsResult.error
      ) {
        return;
      }

      if (!isActive) return;

      replaceTenantOperationalData(currentTenantId, {
        services: servicesResult.data ?? [],
        assignments: assignmentsResult.data ?? [],
        statusEvents: statusEventsResult.data ?? [],
        hotels: hotelsResult.data ?? [],
        memberships: membershipsResult.data ?? []
      });
    };

    const initRealtime = async () => {
      const { data: userData, error: userError } = await client.auth.getUser();
      if (userError || !userData.user || !isActive) return;

      const { data: membership, error: membershipError } = await client
        .from("memberships")
        .select("tenant_id, role")
        .eq("user_id", userData.user.id)
        .maybeSingle();

      if (membershipError || !membership?.tenant_id || !isActive) return;

      setTenantId(membership.tenant_id);
      if (membership.role === "driver") {
        setDriverUserId(userData.user.id);
      }

      await loadTenantData(membership.tenant_id);
      if (typeof navigator !== "undefined" && navigator.onLine) {
        void flushQueue(membership.tenant_id);
      }

      const scheduleRefresh = () => {
        if (!isActive) return;
        if (refreshTimeout) window.clearTimeout(refreshTimeout);
        refreshTimeout = window.setTimeout(() => {
          void loadTenantData(membership.tenant_id);
        }, 400);
      };

      const channel = client
        .channel(`driver-live-${membership.tenant_id}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "services", filter: `tenant_id=eq.${membership.tenant_id}` }, scheduleRefresh)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "assignments", filter: `tenant_id=eq.${membership.tenant_id}` },
          scheduleRefresh
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "status_events", filter: `tenant_id=eq.${membership.tenant_id}` },
          scheduleRefresh
        );

      channel.subscribe((status) => {
        if (!isActive) return;
        setLiveConnected(status === "SUBSCRIBED");
      });

      fallbackInterval = window.setInterval(() => {
        void loadTenantData(membership.tenant_id);
      }, 20000);

      return channel;
    };

    let activeChannel: ReturnType<typeof client.channel> | null = null;
    void initRealtime().then((channel) => {
      if (!channel || !isActive) return;
      activeChannel = channel;
    });

    return () => {
      isActive = false;
      setLiveConnected(false);
      if (refreshTimeout) window.clearTimeout(refreshTimeout);
      if (fallbackInterval) window.clearInterval(fallbackInterval);
      if (activeChannel) {
        void client.removeChannel(activeChannel);
      }
    };
  }, [replaceTenantOperationalData, flushQueue]);

  const mine = useMemo(() => {
    return state.assignments
      .filter((assignment) => assignment.driver_user_id === driverUserId)
      .map((assignment) => {
        const service = state.services.find((item) => item.id === assignment.service_id);
        return service ? { service, assignment } : null;
      })
      .filter((item) => item !== null)
      .sort((a, b) => {
        if (a.service.date !== b.service.date) return a.service.date.localeCompare(b.service.date);
        return a.service.time.localeCompare(b.service.time);
      });
  }, [driverUserId, state.assignments, state.services]);

  const defaultFocusServiceId =
    mine.find((item) => item.service.status !== "completato" && item.service.status !== "cancelled")?.service.id ??
    mine[0]?.service.id ??
    null;
  const effectiveFocusServiceId =
    focusServiceId && mine.some((item) => item.service.id === focusServiceId) ? focusServiceId : defaultFocusServiceId;
  const focused = mine.find((item) => item.service.id === effectiveFocusServiceId) ?? null;
  const focusedHotel = focused ? state.hotels.find((item) => item.id === focused.service.hotel_id) : null;
  const destination = `${focusedHotel?.lat ?? 40.74},${focusedHotel?.lng ?? 13.9}`;
  const navigationUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=driving`;
  const customerPhone = focused?.service.phone_e164?.trim() || focused?.service.phone?.trim() || "";
  const callHref = customerPhone ? `tel:${customerPhone}` : "";

  const enqueueStatus = (serviceId: string, status: ServiceStatus) => {
    const queue = readQueue();
    queue.push({ serviceId, status, queuedAt: new Date().toISOString() });
    writeQueue(queue);
    setPendingQueueCount(queue.length);
  };

  const handleStatusAction = async (status: ServiceStatus) => {
    if (!focused) return;
    setSavingStatus(status);

    setServiceStatus(focused.service.id, status, driverUserId);
    const persisted = await persistStatus(focused.service.id, status);
    if (!persisted) {
      enqueueStatus(focused.service.id, status);
      setMessage("Azione salvata offline. Sara sincronizzata appena online.");
    } else {
      setMessage(`Stato aggiornato: ${status}`);
    }
    setSavingStatus(null);
  };

  if (loading) return <div className="card p-4 text-sm text-muted">Caricamento servizi driver...</div>;

  return (
    <section className="mx-auto max-w-xl space-y-4 pb-8">
      <header className="card space-y-2 p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">My services today</h1>
          <span className={liveConnected ? "live-dot" : "status-badge status-badge-cancelled"}>
            {liveConnected ? "Live" : "Offline"}
          </span>
        </div>
        <p className="text-xs text-muted">
          Connessione: {isOnline ? "online" : "offline"} | Azioni in coda: {pendingQueueCount}
        </p>
      </header>

      {!focused ? (
        <div className="card p-4 text-sm text-muted">Nessun servizio assegnato.</div>
      ) : (
        <article className="card space-y-4 p-5">
          <div className="flex items-center justify-between">
            <span className={`${statusBadgeClass(focused.service.status)} uppercase`}>{focused.service.status}</span>
            <p className="text-sm font-medium text-muted">{focused.service.time}</p>
          </div>
          <div>
            <p className="text-2xl font-bold">{focused.service.customer_name}</p>
            <p className="mt-1 text-sm text-muted">
              {focused.service.date} | {focused.service.vessel}
            </p>
          </div>
          <div className="rounded-xl border border-border bg-surface-2 p-3 text-sm">
            <p className="font-medium">{focusedHotel?.name ?? "Hotel N/D"}</p>
            <p className="text-muted">{focusedHotel?.zone ?? "Zona N/D"}</p>
            <p className="text-muted">{focused.assignment.vehicle_label}</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => void handleStatusAction("partito")}
              disabled={savingStatus !== null}
              className="btn-primary py-3 text-xs font-semibold disabled:opacity-50"
            >
              {savingStatus === "partito" ? "..." : "Partito"}
            </button>
            <button
              type="button"
              onClick={() => void handleStatusAction("arrivato")}
              disabled={savingStatus !== null}
              className="btn-primary py-3 text-xs font-semibold disabled:opacity-50"
            >
              {savingStatus === "arrivato" ? "..." : "Arrivato"}
            </button>
            <button
              type="button"
              onClick={() => void handleStatusAction("completato")}
              disabled={savingStatus !== null}
              className="btn-primary py-3 text-xs font-semibold disabled:opacity-50"
            >
              {savingStatus === "completato" ? "..." : "Completato"}
            </button>
            <button
              type="button"
              onClick={() => void handleStatusAction("problema")}
              disabled={savingStatus !== null}
              className="btn-primary py-3 text-xs font-semibold disabled:opacity-50"
            >
              {savingStatus === "problema" ? "..." : "Problema"}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {callHref ? (
              <a href={callHref} className="btn-secondary">
                Chiama cliente
              </a>
            ) : null}
            <a href={navigationUrl} target="_blank" rel="noreferrer" className="btn-secondary">
              Apri navigazione
            </a>
            <Link href={`/driver/${focused.service.id}`} className="btn-secondary">
              Dettagli
            </Link>
          </div>
        </article>
      )}

      {mine.length > 1 ? (
        <section className="space-y-2">
          <h2 className="px-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">Other assigned services</h2>
          <div className="space-y-2">
            {mine.map((entry) => {
              const hotel = state.hotels.find((item) => item.id === entry.service.hotel_id);
              return (
                <button
                  key={entry.service.id}
                  type="button"
                  onClick={() => setFocusServiceId(entry.service.id)}
                  className={`card w-full rounded-2xl p-4 text-left ${focused?.service.id === entry.service.id ? "border-blue-300 bg-blue-50/40" : ""}`}
                >
                  <div className="flex items-center justify-between">
                    <p className="font-semibold">{entry.service.customer_name}</p>
                    <span className="text-xs text-muted">{entry.service.time}</span>
                  </div>
                  <p className="mt-1 text-xs uppercase text-muted">{entry.service.status}</p>
                  <p className="text-xs text-muted">{hotel?.name ?? "Hotel N/D"}</p>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {message ? <div className="fixed bottom-4 right-4 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white">{message}</div> : null}
    </section>
  );
}
