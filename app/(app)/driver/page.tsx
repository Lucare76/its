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

type Tab = "oggi" | "prossimi" | "storico";

export default function DriverPage() {
  const { loading, tenantId, userId, role, errorMessage, data, refresh } = useTenantOperationalData();
  const [focusServiceId, setFocusServiceId] = useState<string | null>(null);
  const [pendingQueueCount, setPendingQueueCount] = useState(() => readQueue().length);
  const [savingStatus, setSavingStatus] = useState<ServiceStatus | null>(null);
  const [message, setMessage] = useState("");
  const [driverNote, setDriverNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [isOnline, setIsOnline] = useState(() => typeof navigator === "undefined" ? true : navigator.onLine);
  const [tab, setTab] = useState<Tab>("oggi");

  const driverUserId = role === "driver" ? userId : null;

  const persistStatus = useCallback(
    async (serviceId: string, status: ServiceStatus, currentTenantId: string | null = tenantId) => {
      if (!supabase || !currentTenantId || !isOnline || !userId) return false;
      const { error: serviceError } = await supabase.from("services").update({ status }).eq("id", serviceId).eq("tenant_id", currentTenantId);
      if (serviceError) return false;
      await supabase.from("status_events").insert({ tenant_id: currentTenantId, service_id: serviceId, status, by_user_id: userId });
      await refresh();
      return true;
    },
    [isOnline, refresh, tenantId, userId]
  );

  const flushQueue = useCallback(async (currentTenantId: string) => {
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
  }, [isOnline, persistStatus]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onOnline = () => { setIsOnline(true); if (tenantId) void flushQueue(tenantId); };
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => { window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline); };
  }, [tenantId, flushQueue]);

  useEffect(() => {
    if (!message) return;
    const t = window.setTimeout(() => setMessage(""), 2500);
    return () => window.clearTimeout(t);
  }, [message]);

  const mine = useMemo(() => {
    if (!driverUserId) return [];
    return data.assignments
      .filter((a) => a.driver_user_id === driverUserId)
      .map((a) => {
        const service = data.services.find((s) => s.id === a.service_id);
        return service ? { service, assignment: a } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.service.date !== b.service.date ? a.service.date.localeCompare(b.service.date) : a.service.time.localeCompare(b.service.time));
  }, [data, driverUserId]);

  const todayIso = new Date().toISOString().slice(0, 10);
  const todayServices    = useMemo(() => mine.filter((x) => x.service.date === todayIso), [mine, todayIso]);
  const nextServices     = useMemo(() => mine.filter((x) => x.service.date > todayIso), [mine, todayIso]);
  const completedServices = useMemo(() => [...mine].filter((x) => x.service.status === "completato" || x.service.status === "cancelled").sort((a, b) => b.service.date.localeCompare(a.service.date)).slice(0, 20), [mine]);
  const totalPax         = useMemo(() => mine.filter((x) => x.service.status === "completato").reduce((s, x) => s + x.service.pax, 0), [mine]);

  const defaultFocusId = mine.find((x) => x.service.status !== "completato" && x.service.status !== "cancelled")?.service.id ?? mine[0]?.service.id ?? null;
  const effectiveFocusId = focusServiceId && mine.some((x) => x.service.id === focusServiceId) ? focusServiceId : defaultFocusId;
  const focused = mine.find((x) => x.service.id === effectiveFocusId) ?? null;
  const focusedHotel = focused ? data.hotels.find((h) => h.id === focused.service.hotel_id) : null;
  const navigationUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${focusedHotel?.lat ?? 40.74},${focusedHotel?.lng ?? 13.9}`)}&travelmode=driving`;
  const customerPhone = focused?.service.phone_e164?.trim() || focused?.service.phone?.trim() || "";
  const focusedEvents = focused ? [...data.statusEvents].filter((e) => e.service_id === focused.service.id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5) : [];

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
      setMessage("Azione salvata offline — sarà sincronizzata appena online.");
    } else {
      setMessage(`Stato: ${status.toUpperCase()}`);
    }
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

  if (loading) return <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">Caricamento...</div>;
  if (errorMessage) return <div className="p-4 text-sm text-rose-600">{errorMessage}</div>;
  if (!driverUserId) return <div className="p-4 text-sm text-slate-500">Utente driver non disponibile.</div>;

  return (
    <div className="mx-auto max-w-lg space-y-4 px-2 pb-10">

      {/* Header profilo */}
      <div className="rounded-2xl bg-slate-900 px-5 py-4 text-white">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Autista</p>
            <p className="mt-0.5 text-lg font-bold">{data.assignments.find((a) => a.driver_user_id === driverUserId)?.driver_name ?? "Driver"}</p>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${isOnline ? "bg-emerald-500 text-white" : "bg-rose-500 text-white"}`}>
            {isOnline ? "● Online" : "● Offline"}
          </span>
        </div>
        {/* Stats rapide */}
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
      </div>

      {/* Servizio in focus */}
      {focused ? (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          {/* Status bar */}
          <div className={`px-5 py-2 text-xs font-bold uppercase tracking-wider ${statusColor(focused.service.status)}`}>
            {focused.service.status}
          </div>
          <div className="p-5 space-y-4">
            {/* Cliente + orario */}
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-2xl font-bold text-slate-900">{focused.service.customer_name}</p>
                <p className="text-sm text-slate-500 mt-0.5">{formatDateLabel(focused.service.date)} · {focused.service.time} · {focused.service.pax} pax</p>
                <p className="text-xs text-slate-400 mt-0.5">{focused.service.vessel}</p>
              </div>
              <Link href={`/driver/${focused.service.id}`} className="shrink-0 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">
                Dettagli
              </Link>
            </div>

            {/* Hotel + mezzo */}
            <div className="rounded-xl bg-slate-50 px-4 py-3 space-y-1">
              <p className="font-semibold text-slate-800">{focusedHotel?.name ?? focused.service.meeting_point ?? "Destinazione N/D"}</p>
              <p className="text-sm text-slate-500">{focusedHotel?.zone ?? ""}</p>
              {focused.assignment.vehicle_label && (
                <p className="text-xs font-mono text-slate-400">{focused.assignment.vehicle_label}</p>
              )}
            </div>

            {/* Note */}
            {focused.service.notes && (
              <div className="rounded-xl bg-amber-50 border border-amber-100 px-4 py-3 text-sm text-amber-800">
                {focused.service.notes}
              </div>
            )}

            {/* Pulsanti stato — grandi per mobile */}
            <div className="grid grid-cols-2 gap-3">
              {(["partito", "arrivato", "completato", "problema"] as ServiceStatus[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={savingStatus !== null}
                  onClick={() => void handleStatusAction(s)}
                  className={`rounded-2xl py-4 text-sm font-bold uppercase tracking-wide transition active:scale-95 disabled:opacity-50 ${
                    s === "problema"
                      ? "border-2 border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
                      : s === "completato"
                      ? "border-2 border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                      : "border-2 border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"
                  }`}
                >
                  {savingStatus === s ? "..." : s}
                </button>
              ))}
            </div>

            {/* Azioni rapide */}
            <div className="flex gap-3">
              {customerPhone && (
                <a href={`tel:${customerPhone}`} className="flex-1 rounded-2xl border-2 border-slate-200 py-3 text-center text-sm font-semibold text-slate-700 hover:bg-slate-50">
                  📞 Chiama
                </a>
              )}
              <a href={navigationUrl} target="_blank" rel="noreferrer" className="flex-1 rounded-2xl border-2 border-slate-200 py-3 text-center text-sm font-semibold text-slate-700 hover:bg-slate-50">
                🗺 Naviga
              </a>
            </div>

            {/* Nota autista */}
            <div>
              <textarea
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-300"
                rows={2}
                value={driverNote}
                onChange={(e) => setDriverNote(e.target.value)}
                placeholder="Nota rapida (bagagli, ritardo, variazioni...)"
              />
              <button
                type="button"
                disabled={savingNote || !driverNote.trim()}
                onClick={() => void handleDriverNote()}
                className="mt-2 w-full rounded-xl bg-slate-800 py-3 text-sm font-semibold text-white disabled:opacity-40 hover:bg-slate-700"
              >
                {savingNote ? "Salvataggio..." : "Salva nota"}
              </button>
            </div>

            {/* Storico eventi servizio */}
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
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`flex-1 py-3 text-xs font-semibold transition ${tab === t.key ? "border-b-2 border-blue-500 text-blue-700" : "text-slate-500 hover:text-slate-700"}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="divide-y divide-slate-50">
          {tab === "oggi" && (
            todayServices.length === 0
              ? <p className="p-4 text-center text-sm text-slate-400">Nessun servizio oggi.</p>
              : todayServices.map((entry) => {
                  const hotel = data.hotels.find((h) => h.id === entry.service.hotel_id);
                  return (
                    <button key={entry.service.id} type="button" onClick={() => { setFocusServiceId(entry.service.id); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                      className={`w-full px-4 py-3 text-left transition hover:bg-slate-50 ${focused?.service.id === entry.service.id ? "bg-blue-50/60" : ""}`}>
                      <div className="flex items-center justify-between">
                        <p className="font-semibold text-slate-800">{entry.service.customer_name}</p>
                        <span className="text-xs text-slate-500">{entry.service.time}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${statusColor(entry.service.status)}`}>{entry.service.status}</span>
                        <span className="text-xs text-slate-400">{hotel?.name ?? "N/D"} · {entry.service.pax} pax</span>
                      </div>
                    </button>
                  );
                })
          )}

          {tab === "prossimi" && (
            nextServices.length === 0
              ? <p className="p-4 text-center text-sm text-slate-400">Nessun servizio futuro.</p>
              : nextServices.map((entry) => {
                  const hotel = data.hotels.find((h) => h.id === entry.service.hotel_id);
                  return (
                    <button key={entry.service.id} type="button" onClick={() => { setFocusServiceId(entry.service.id); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                      className="w-full px-4 py-3 text-left transition hover:bg-slate-50">
                      <div className="flex items-center justify-between">
                        <p className="font-semibold text-slate-800">{entry.service.customer_name}</p>
                        <span className="text-xs font-semibold text-slate-600">{formatDateLabel(entry.service.date)} {entry.service.time}</span>
                      </div>
                      <p className="mt-1 text-xs text-slate-400">{hotel?.name ?? "N/D"} · {entry.service.pax} pax · {entry.service.vessel}</p>
                    </button>
                  );
                })
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
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-xl">
          {message}
        </div>
      )}
    </div>
  );
}
