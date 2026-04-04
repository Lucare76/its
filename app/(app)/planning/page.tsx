"use client";

import { useEffect, useMemo, useState } from "react";
import type { DragEvent } from "react";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { buildOperationalInstances, type OperationalInstance } from "@/lib/operational-service-instances";
import { formatIsoDateShort } from "@/lib/service-display";
import { supabase } from "@/lib/supabase/client";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";
import type { Service, ServiceType } from "@/lib/types";

function normalizeTime(raw: string) {
  return raw.slice(0, 5);
}

function floorToThirtyMinutes(raw: string) {
  const [hourRaw = "0", minuteRaw = "0"] = normalizeTime(raw).split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const flooredMinute = Math.floor((Number.isFinite(minute) ? minute : 0) / 30) * 30;
  return `${String(Number.isFinite(hour) ? hour : 0).padStart(2, "0")}:${String(flooredMinute).padStart(2, "0")}`;
}

function buildSlots() {
  const slots: string[] = [];
  for (let hour = 6; hour <= 22; hour += 1) {
    slots.push(`${String(hour).padStart(2, "0")}:00`);
    slots.push(`${String(hour).padStart(2, "0")}:30`);
  }
  return slots;
}

function startOfWeek(dateIso: string) {
  const date = new Date(`${dateIso}T12:00:00`);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDaysToIso(dateIso: string, days: number) {
  const date = new Date(`${dateIso}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function instanceBadge(direction: OperationalInstance["direction"]) {
  return direction === "arrival" ? "Arrivo" : "Partenza";
}

function lineLabel(instance: OperationalInstance) {
  const service = instance.service;
  const destination = service.meeting_point?.trim() || service.customer_name;
  return `${instance.time} · ${instanceBadge(instance.direction)} · ${destination}`;
}

export default function PlanningPage() {
  const { loading, liveConnected, tenantId, errorMessage, data, refresh } = useTenantOperationalData();
  const [viewMode, setViewMode] = useState<"day" | "week">("day");
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [driverFilter, setDriverFilter] = useState<string>("all");
  const [serviceTypeFilter, setServiceTypeFilter] = useState<ServiceType | "all">("all");
  const [draggingServiceId, setDraggingServiceId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const slots = useMemo(() => buildSlots(), []);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), 2200);
    return () => window.clearTimeout(timer);
  }, [message]);

  const assignmentsByServiceId = useMemo(() => new Map(data.assignments.map((assignment) => [assignment.service_id, assignment])), [data.assignments]);
  const driverNameById = useMemo(
    () => new Map(data.memberships.filter((item) => item.role === "driver").map((item) => [item.user_id, item.full_name])),
    [data.memberships]
  );

  const operationalInstances = useMemo(() => buildOperationalInstances(data.services), [data.services]);

  const filteredServices = useMemo(() => {
    return data.services
      .filter((service) => {
        const assignment = assignmentsByServiceId.get(service.id);
        const byDriver = driverFilter === "all" || assignment?.driver_user_id === driverFilter;
        const byServiceType = serviceTypeFilter === "all" || (service.service_type ?? "transfer") === serviceTypeFilter;
        return byDriver && byServiceType;
      })
      .sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return normalizeTime(a.time).localeCompare(normalizeTime(b.time));
      });
  }, [assignmentsByServiceId, data.services, driverFilter, serviceTypeFilter]);

  const filteredInstances = useMemo(() => {
    const allowedIds = new Set(filteredServices.map((service) => service.id));
    return operationalInstances.filter((instance) => allowedIds.has(instance.serviceId));
  }, [filteredServices, operationalInstances]);

  const availableDates = useMemo(() => [...new Set(filteredInstances.map((instance) => instance.date))].sort(), [filteredInstances]);
  const effectiveSelectedDate = availableDates.includes(selectedDate) ? selectedDate : availableDates[0] ?? selectedDate;

  const dayInstances = useMemo(() => filteredInstances.filter((instance) => instance.date === effectiveSelectedDate), [effectiveSelectedDate, filteredInstances]);
  const dayArrivals = useMemo(() => dayInstances.filter((instance) => instance.direction === "arrival"), [dayInstances]);
  const dayDepartures = useMemo(() => dayInstances.filter((instance) => instance.direction === "departure"), [dayInstances]);
  const futureCutoffDate = useMemo(() => addDaysToIso(effectiveSelectedDate, 7), [effectiveSelectedDate]);
  const nextInstances = useMemo(
    () =>
      filteredInstances
        .filter((instance) => instance.date > effectiveSelectedDate && instance.date <= futureCutoffDate)
        .slice(0, 10),
    [effectiveSelectedDate, filteredInstances, futureCutoffDate]
  );

  const weekStart = useMemo(() => startOfWeek(effectiveSelectedDate), [effectiveSelectedDate]);
  const weekDates = useMemo(() => Array.from({ length: 7 }, (_, index) => toIsoDate(addDays(weekStart, index))), [weekStart]);

  const servicesByDayAndSlot = useMemo(() => {
    const map = new Map<string, OperationalInstance[]>();
    for (const instance of filteredInstances) {
      const slot = floorToThirtyMinutes(instance.time);
      const key = `${instance.date}|${slot}`;
      const existing = map.get(key) ?? [];
      existing.push(instance);
      map.set(key, existing);
    }
    return map;
  }, [filteredInstances]);

  const applyDrop = async (instanceId: string, nextDate: string, nextTime: string) => {
    const instance = operationalInstances.find((item) => item.instanceId === instanceId);
    if (!instance || !tenantId || !supabase) return;
    const service = instance.service;
    const currentTime = floorToThirtyMinutes(instance.time);
    if (instance.date === nextDate && currentTime === nextTime) return;

    const nextTimestamp = `${nextTime}:00`;
    const updates =
      instance.direction === "departure"
        ? {
            departure_date: nextDate,
            departure_time: nextTimestamp,
            return_time: nextTimestamp
          }
        : {
            date: nextDate,
            time: nextTimestamp,
            arrival_date: nextDate,
            arrival_time: nextTimestamp,
            outbound_time: nextTimestamp
          };

    const { error } = await supabase
      .from("services")
      .update(updates)
      .eq("id", service.id)
      .eq("tenant_id", tenantId);

    if (error) {
      setMessage(`Spostamento fallito: ${error.message}`);
      return;
    }

    setMessage(`${instance.direction === "arrival" ? "Arrivo" : "Partenza"} spostato a ${nextDate} ${nextTime}`);
    await refresh();
  };

  const onDragStart = (instanceId: string, event: DragEvent<HTMLElement>) => {
    setDraggingServiceId(instanceId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", instanceId);
  };

  const onDropSlot = async (date: string, time: string, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const serviceId = event.dataTransfer.getData("text/plain") || draggingServiceId;
    setDraggingServiceId(null);
    if (!serviceId) return;
    await applyDrop(serviceId, date, time);
  };

  if (loading) return <div className="card p-4 text-sm text-muted">Caricamento pianificazione...</div>;
  if (errorMessage) return <div className="card p-4 text-sm text-muted">{errorMessage}</div>;

  const drivers = data.memberships.filter((member) => member.role === "driver");

  return (
    <section className="page-section">
      <PageHeader
        title="Pianificazione"
        subtitle="Vista operativa per arrivi, partenze e servizi futuri. L'assegnazione resta opzionale."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Pianificazione" }]}
        badge={<span className={liveConnected ? "live-dot" : "status-badge status-badge-cancelled"}>{liveConnected ? "In tempo reale" : "Non in linea"}</span>}
        actions={
          <>
            <button type="button" onClick={() => setViewMode("day")} className={viewMode === "day" ? "btn-primary" : "btn-secondary"}>
              Vista giorno
            </button>
            <button type="button" onClick={() => setViewMode("week")} className={viewMode === "week" ? "btn-primary" : "btn-secondary"}>
              Vista settimana
            </button>
          </>
        }
      />

      <div className="filters-grid md:grid-cols-4">
        <label className="text-sm">
          Data
          <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} className="input-saas mt-1 w-full" />
        </label>
        <label className="text-sm">
          Autista
          <select value={driverFilter} onChange={(event) => setDriverFilter(event.target.value)} className="input-saas mt-1 w-full">
            <option value="all">tutti</option>
            {drivers.map((driver) => (
              <option key={driver.user_id} value={driver.user_id}>
                {driver.full_name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Tipo servizio
          <select value={serviceTypeFilter} onChange={(event) => setServiceTypeFilter(event.target.value as ServiceType | "all")} className="input-saas mt-1 w-full">
            <option value="all">tutti</option>
            <option value="transfer">transfer</option>
            <option value="bus_tour">bus_tour</option>
          </select>
        </label>
        <div className="flex items-end text-xs text-muted">Trascina una card e rilasciala in un altro slot per cambiare l&apos;orario del servizio.</div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <SectionCard title="Arrivi del giorno" subtitle={formatIsoDateShort(effectiveSelectedDate)}>
          <p className="text-3xl font-semibold text-text">{dayArrivals.length}</p>
          <p className="mt-1 text-sm text-muted">{dayArrivals.reduce((sum, item) => sum + item.service.pax, 0)} pax in ingresso</p>
        </SectionCard>
        <SectionCard title="Partenze del giorno" subtitle={formatIsoDateShort(effectiveSelectedDate)}>
          <p className="text-3xl font-semibold text-text">{dayDepartures.length}</p>
          <p className="mt-1 text-sm text-muted">{dayDepartures.reduce((sum, item) => sum + item.service.pax, 0)} pax in uscita</p>
        </SectionCard>
        <SectionCard title="Futuri da gestire" subtitle={`Finestra fino al ${formatIsoDateShort(futureCutoffDate)}`}>
          <p className="text-3xl font-semibold text-text">{nextInstances.length}</p>
          <p className="mt-1 text-sm text-muted">Prime istanze operative dei prossimi 7 giorni</p>
        </SectionCard>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <SectionCard title="Arrivi del giorno" subtitle="Controllo rapido prima della griglia oraria">
          {dayArrivals.length === 0 ? (
            <EmptyState title="Nessun arrivo" description="Con i filtri attuali non ci sono arrivi per questa giornata." compact />
          ) : (
            <div className="space-y-2">
              {dayArrivals.slice(0, 8).map((instance) => (
                <article key={instance.instanceId} className="rounded-xl border border-border bg-surface/80 px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-text">{instance.service.customer_name}</p>
                    <span className="text-xs text-muted">{instance.time}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted">{instance.service.meeting_point?.trim() || "Meeting point da verificare"}</p>
                </article>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Partenze del giorno" subtitle="Servizi in uscita dalla stessa giornata">
          {dayDepartures.length === 0 ? (
            <EmptyState title="Nessuna partenza" description="Con i filtri attuali non ci sono partenze per questa giornata." compact />
          ) : (
            <div className="space-y-2">
              {dayDepartures.slice(0, 8).map((instance) => (
                <article key={instance.instanceId} className="rounded-xl border border-border bg-surface/80 px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-text">{instance.service.customer_name}</p>
                    <span className="text-xs text-muted">{instance.time}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted">{instance.service.meeting_point?.trim() || "Meeting point da verificare"}</p>
                </article>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Servizi futuri da gestire" subtitle="Preview rapida dei prossimi 7 giorni">
          {nextInstances.length === 0 ? (
            <EmptyState title="Nessun servizio futuro" description="La finestra prossimi 7 giorni non ha istanze operative con i filtri attuali." compact />
          ) : (
            <div className="space-y-2">
              {nextInstances.map((instance) => (
                <article key={instance.instanceId} className="rounded-xl border border-border bg-surface/80 px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-text">{instance.service.customer_name}</p>
                    <span className="text-xs text-muted">{formatIsoDateShort(instance.date)}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted">{lineLabel(instance)}</p>
                </article>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      {viewMode === "day" ? (
        <div className="card overflow-x-auto p-2 md:p-3">
          <div className="grid min-w-[760px] grid-cols-[80px_1fr]">
            {slots.map((slot) => {
              const dayKey = `${effectiveSelectedDate}|${slot}`;
              const servicesAtSlot = servicesByDayAndSlot.get(dayKey) ?? [];
              return (
                <div key={`${dayKey}-day`} className="contents">
                  <div className="border-t border-border px-2 py-3 text-xs text-muted">{slot}</div>
                  <div className="min-h-14 border-t border-border px-2 py-2 hover:bg-blue-50/50" onDragOver={(event) => event.preventDefault()} onDrop={(event) => void onDropSlot(effectiveSelectedDate, slot, event)}>
                    <div className="flex flex-wrap gap-2">
                      {servicesAtSlot.map((instance) => {
                        const service = instance.service;
                        const assignment = assignmentsByServiceId.get(service.id);
                        const driver = assignment?.driver_user_id ? driverNameById.get(assignment.driver_user_id) : "Non assegnato";
                        return (
                          <article
                            key={instance.instanceId}
                            draggable
                            onDragStart={(event) => onDragStart(instance.instanceId, event)}
                            className="cursor-grab rounded-xl border border-blue-200 bg-white px-3 py-2 text-xs shadow-sm"
                          >
                            <p className="line-clamp-2 text-safe-wrap font-semibold">{service.customer_name}</p>
                            <p className="line-clamp-1 text-muted">
                              {normalizeTime(instance.time)} | {instance.direction === "arrival" ? "ARRIVO" : "PARTENZA"} | {(service.service_type ?? "transfer").toUpperCase()}
                            </p>
                            <p className="line-clamp-1 text-muted">{driver}</p>
                          </article>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {dayInstances.length === 0 ? <p className="p-3 text-sm text-muted">Nessuna istanza operativa per il giorno e i filtri selezionati.</p> : null}
        </div>
      ) : (
        <div className="card overflow-x-auto p-2 md:p-3">
          <div className="grid min-w-[1120px] grid-cols-[80px_repeat(7,minmax(150px,1fr))]">
            <div />
            {weekDates.map((date) => (
              <div key={date} className="border-b border-border px-2 py-2 text-xs font-semibold text-text">
                {date}
              </div>
            ))}
            {slots.map((slot) => (
              <div key={slot} className="contents">
                <div className="border-t border-border px-2 py-3 text-xs text-muted">{slot}</div>
                {weekDates.map((date) => {
                  const key = `${date}|${slot}`;
                  const servicesAtSlot = servicesByDayAndSlot.get(key) ?? [];
                  return (
                    <div key={key} className="min-h-14 border-t border-border px-1.5 py-2 hover:bg-blue-50/40" onDragOver={(event) => event.preventDefault()} onDrop={(event) => void onDropSlot(date, slot, event)}>
                      <div className="space-y-1">
                        {servicesAtSlot.map((instance) => (
                          <article
                            key={instance.instanceId}
                            draggable
                            onDragStart={(event) => onDragStart(instance.instanceId, event)}
                            className="cursor-grab rounded-lg border border-blue-200 bg-white px-2 py-1.5 text-[11px] shadow-sm"
                          >
                            <p className="truncate font-semibold">{instance.service.customer_name}</p>
                            <p className="truncate text-muted">
                              {instance.direction === "arrival" ? "ARRIVO" : "PARTENZA"} | {(instance.service.service_type ?? "transfer").toUpperCase()}
                            </p>
                          </article>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {message ? <div className="fixed bottom-4 right-4 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white">{message}</div> : null}
    </section>
  );
}
