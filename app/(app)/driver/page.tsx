"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { ServiceStatus } from "@/lib/types";
import { supabase } from "@/lib/supabase/client";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";

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

function formatDateLabel(dateIso: string) {
  const [year, month, day] = dateIso.split("-");
  return day && month && year ? `${day}/${month}/${year.slice(2)}` : dateIso;
}

export default function DriverPage() {
  const { loading, tenantId, userId, role, errorMessage, data, refresh } = useTenantOperationalData();
  const [focusServiceId, setFocusServiceId] = useState<string | null>(null);
  const [pendingQueueCount, setPendingQueueCount] = useState(() => readQueue().length);
  const [savingStatus, setSavingStatus] = useState<ServiceStatus | null>(null);
  const [message, setMessage] = useState("");
  const [driverNote, setDriverNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [showQueue, setShowQueue] = useState(false);

  const driverUserId = role === "driver" ? userId : null;

  const persistStatus = useCallback(
    async (serviceId: string, status: ServiceStatus, currentTenantId: string | null = tenantId) => {
      if (!supabase || !currentTenantId || !isOnline || !userId) return false;

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
        by_user_id: userId
      });

      if (eventError) return false;
      await refresh();
      return true;
    },
    [isOnline, refresh, tenantId, userId]
  );

  const flushQueue = useCallback(
    async (currentTenantId: string) => {
      if (!supabase || !currentTenantId || !isOnline) return;
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

  const mine = useMemo(() => {
    if (!driverUserId) return [];
    return data.assignments
      .filter((assignment) => assignment.driver_user_id === driverUserId)
      .map((assignment) => {
        const service = data.services.find((item) => item.id === assignment.service_id);
        return service ? { service, assignment } : null;
      })
      .filter((item): item is { service: (typeof data.services)[number]; assignment: (typeof data.assignments)[number] } => item !== null)
      .sort((a, b) => {
        if (a.service.date !== b.service.date) return a.service.date.localeCompare(b.service.date);
        return a.service.time.localeCompare(b.service.time);
      });
  }, [data, driverUserId]);

  const todayIso = new Date().toISOString().slice(0, 10);
  const todayServices = useMemo(() => mine.filter((item) => item.service.date === todayIso), [mine, todayIso]);
  const nextServices = useMemo(() => mine.filter((item) => item.service.date > todayIso).slice(0, 8), [mine, todayIso]);
  const problemServices = useMemo(() => mine.filter((item) => item.service.status === "problema"), [mine]);
  const queuePreview = showQueue ? readQueue() : [];

  const defaultFocusServiceId =
    mine.find((item) => item.service.status !== "completato" && item.service.status !== "cancelled")?.service.id ??
    mine[0]?.service.id ??
    null;
  const effectiveFocusServiceId =
    focusServiceId && mine.some((item) => item.service.id === focusServiceId) ? focusServiceId : defaultFocusServiceId;
  const focused = mine.find((item) => item.service.id === effectiveFocusServiceId) ?? null;
  const focusedHotel = focused ? data.hotels.find((item) => item.id === focused.service.hotel_id) : null;
  const destination = `${focusedHotel?.lat ?? 40.74},${focusedHotel?.lng ?? 13.9}`;
  const navigationUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=driving`;
  const customerPhone = focused?.service.phone_e164?.trim() || focused?.service.phone?.trim() || "";
  const callHref = customerPhone ? `tel:${customerPhone}` : "";
  const focusedEvents = focused
    ? [...data.statusEvents]
        .filter((item) => item.service_id === focused.service.id)
        .sort((left, right) => right.at.localeCompare(left.at))
        .slice(0, 4)
    : [];

  const enqueueStatus = (serviceId: string, status: ServiceStatus) => {
    const queue = readQueue();
    queue.push({ serviceId, status, queuedAt: new Date().toISOString() });
    writeQueue(queue);
    setPendingQueueCount(queue.length);
  };

  const handleStatusAction = async (status: ServiceStatus) => {
    if (!focused) return;
    setSavingStatus(status);

    const persisted = await persistStatus(focused.service.id, status);
    if (!persisted) {
      enqueueStatus(focused.service.id, status);
      setMessage("Azione salvata offline. Sara sincronizzata appena online.");
    } else {
      setMessage(`Stato aggiornato: ${status}`);
    }
    setSavingStatus(null);
  };

  const handleDriverNote = async () => {
    if (!focused || !supabase || !tenantId || !driverNote.trim()) return;
    setSavingNote(true);
    const nextNotes = `${focused.service.notes ?? ""} [driver_note:${driverNote.trim()}]`.trim();
    const { error } = await supabase
      .from("services")
      .update({ notes: nextNotes })
      .eq("id", focused.service.id)
      .eq("tenant_id", tenantId);
    if (error) {
      setSavingNote(false);
      setMessage(error.message);
      return;
    }
    setDriverNote("");
    await refresh();
    setSavingNote(false);
    setMessage("Nota autista salvata.");
  };

  if (loading) return <div className="card p-4 text-sm text-muted">Caricamento servizi driver...</div>;
  if (errorMessage) return <div className="card p-4 text-sm text-muted">{errorMessage}</div>;
  if (!driverUserId) return <div className="card p-4 text-sm text-muted">Utente driver non disponibile.</div>;

  return (
    <section className="mx-auto max-w-xl space-y-4 pb-8">
      <header className="card space-y-2 p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">I miei servizi di oggi</h1>
          <span className={isOnline ? "live-dot" : "status-badge status-badge-cancelled"}>{isOnline ? "Online" : "Offline"}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>Azioni in coda: {pendingQueueCount}</span>
          <button type="button" className="underline underline-offset-2" onClick={() => setShowQueue((current) => !current)}>
            {showQueue ? "Nascondi coda offline" : "Mostra coda offline"}
          </button>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3">
        <article className="card p-4">
          <p className="text-xs uppercase tracking-[0.12em] text-muted">Servizi oggi</p>
          <p className="mt-2 text-2xl font-semibold">{todayServices.length}</p>
        </article>
        <article className="card p-4">
          <p className="text-xs uppercase tracking-[0.12em] text-muted">Prossimi servizi</p>
          <p className="mt-2 text-2xl font-semibold">{nextServices.length}</p>
        </article>
        <article className="card p-4">
          <p className="text-xs uppercase tracking-[0.12em] text-muted">Problemi aperti</p>
          <p className="mt-2 text-2xl font-semibold">{problemServices.length}</p>
        </article>
        <article className="card p-4">
          <p className="text-xs uppercase tracking-[0.12em] text-muted">Servizio in focus</p>
          <p className="mt-2 text-sm font-semibold">{focused?.service.customer_name ?? "Nessuno"}</p>
        </article>
      </div>

      {showQueue ? (
        <section className="card space-y-2 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Coda offline</h2>
            <span className="text-xs text-muted">{queuePreview.length} azioni</span>
          </div>
          {queuePreview.length === 0 ? (
            <p className="text-sm text-muted">Nessuna azione in attesa di sincronizzazione.</p>
          ) : (
            <div className="space-y-2">
              {queuePreview.map((item, index) => (
                <div key={`${item.serviceId}-${item.queuedAt}-${index}`} className="rounded-xl border border-border bg-surface-2 p-3 text-xs text-muted">
                  <p className="font-medium text-slate-800">Servizio {item.serviceId.slice(0, 8)}...</p>
                  <p>Stato: {item.status}</p>
                  <p>In coda dal: {new Date(item.queuedAt).toLocaleString("it-IT")}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}

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
          <div className="rounded-xl border border-border bg-surface-2 p-3 text-sm">
            <p className="font-medium">Note operative</p>
            <p className="mt-1 text-muted whitespace-pre-wrap">{focused.service.notes || "Nessuna nota"}</p>
          </div>
          <div className="rounded-xl border border-border bg-surface-2 p-3 text-sm">
            <p className="font-medium">Storico rapido</p>
            {focusedEvents.length === 0 ? (
              <p className="mt-1 text-muted">Nessun evento stato registrato.</p>
            ) : (
              <div className="mt-2 space-y-2">
                {focusedEvents.map((event) => (
                  <div key={event.id} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                    <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-700">{event.status}</p>
                    <p className="text-xs text-muted">{new Date(event.at).toLocaleString("it-IT")}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => void handleStatusAction("partito")} disabled={savingStatus !== null} className="btn-primary py-3 text-xs font-semibold disabled:opacity-50">
              {savingStatus === "partito" ? "..." : "Partito"}
            </button>
            <button type="button" onClick={() => void handleStatusAction("arrivato")} disabled={savingStatus !== null} className="btn-primary py-3 text-xs font-semibold disabled:opacity-50">
              {savingStatus === "arrivato" ? "..." : "Arrivato"}
            </button>
            <button type="button" onClick={() => void handleStatusAction("completato")} disabled={savingStatus !== null} className="btn-primary py-3 text-xs font-semibold disabled:opacity-50">
              {savingStatus === "completato" ? "..." : "Completato"}
            </button>
            <button type="button" onClick={() => void handleStatusAction("problema")} disabled={savingStatus !== null} className="btn-primary py-3 text-xs font-semibold disabled:opacity-50">
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
          <div className="rounded-xl border border-border bg-surface-2 p-3">
            <label className="text-sm font-medium">
              Nota autista
              <textarea
                className="input-saas mt-2 min-h-[90px]"
                value={driverNote}
                onChange={(event) => setDriverNote(event.target.value)}
                placeholder="Appunti rapidi su cliente, ritardo, bagagli, variazioni"
              />
            </label>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="btn-secondary" disabled={savingNote || !driverNote.trim()} onClick={() => void handleDriverNote()}>
                {savingNote ? "Salvataggio..." : "Salva nota"}
              </button>
              <button type="button" className="btn-secondary" disabled={savingStatus !== null} onClick={() => void handleStatusAction("problema")}>
                Segnala problema
              </button>
            </div>
          </div>
        </article>
      )}

      {todayServices.length > 0 ? (
        <section className="space-y-2">
          <h2 className="px-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">Servizi di oggi</h2>
          <div className="space-y-2">
            {todayServices.map((entry) => {
              const hotel = data.hotels.find((item) => item.id === entry.service.hotel_id);
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

      {nextServices.length > 0 ? (
        <section className="space-y-2">
          <h2 className="px-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">Prossimi servizi assegnati</h2>
          <div className="space-y-2">
            {nextServices.map((entry) => {
              const hotel = data.hotels.find((item) => item.id === entry.service.hotel_id);
              return (
                <button
                  key={entry.service.id}
                  type="button"
                  onClick={() => setFocusServiceId(entry.service.id)}
                  className={`card w-full rounded-2xl p-4 text-left ${focused?.service.id === entry.service.id ? "border-blue-300 bg-blue-50/40" : ""}`}
                >
                  <div className="flex items-center justify-between">
                    <p className="font-semibold">{entry.service.customer_name}</p>
                    <span className="text-xs text-muted">
                      {formatDateLabel(entry.service.date)} {entry.service.time}
                    </span>
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
