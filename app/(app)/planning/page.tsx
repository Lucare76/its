"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { DragEvent } from "react";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import type { Service, ServiceType } from "@/lib/types";
import { useDemoStore } from "@/lib/use-demo-store";

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

export default function PlanningPage() {
  const { state, loading, replaceTenantOperationalData, updateServiceSchedule } = useDemoStore();
  const [viewMode, setViewMode] = useState<"day" | "week">("day");
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [driverFilter, setDriverFilter] = useState<string>("all");
  const [serviceTypeFilter, setServiceTypeFilter] = useState<ServiceType | "all">("all");
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [liveConnected, setLiveConnected] = useState(false);
  const [draggingServiceId, setDraggingServiceId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const slots = useMemo(() => buildSlots(), []);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), 2200);
    return () => window.clearTimeout(timer);
  }, [message]);

  const loadTenantData = useCallback(
    async (currentTenantId: string) => {
      if (!supabase) return;
      const [servicesResult, assignmentsResult, statusEventsResult, hotelsResult, membershipsResult] = await Promise.all([
        supabase.from("services").select("*").eq("tenant_id", currentTenantId),
        supabase.from("assignments").select("*").eq("tenant_id", currentTenantId),
        supabase.from("status_events").select("*").eq("tenant_id", currentTenantId),
        supabase.from("hotels").select("*").eq("tenant_id", currentTenantId),
        supabase.from("memberships").select("*").eq("tenant_id", currentTenantId)
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

      replaceTenantOperationalData(currentTenantId, {
        services: servicesResult.data ?? [],
        assignments: assignmentsResult.data ?? [],
        statusEvents: statusEventsResult.data ?? [],
        hotels: hotelsResult.data ?? [],
        memberships: membershipsResult.data ?? []
      });
    },
    [replaceTenantOperationalData]
  );

  useEffect(() => {
    const client = supabase;
    if (!hasSupabaseEnv || !client) return;

    let isActive = true;
    let refreshTimeout: number | null = null;
    let fallbackInterval: number | null = null;
    let activeChannel: ReturnType<typeof client.channel> | null = null;

    const initRealtime = async () => {
      const { data: userData, error: userError } = await client.auth.getUser();
      if (userError || !userData.user || !isActive) return;

      const { data: membership, error: membershipError } = await client
        .from("memberships")
        .select("tenant_id")
        .eq("user_id", userData.user.id)
        .maybeSingle();

      if (membershipError || !membership?.tenant_id || !isActive) return;

      setTenantId(membership.tenant_id);
      await loadTenantData(membership.tenant_id);

      const scheduleRefresh = () => {
        if (!isActive) return;
        if (refreshTimeout) window.clearTimeout(refreshTimeout);
        refreshTimeout = window.setTimeout(() => {
          void loadTenantData(membership.tenant_id);
        }, 400);
      };

      activeChannel = client
        .channel(`planning-live-${membership.tenant_id}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "services", filter: `tenant_id=eq.${membership.tenant_id}` }, scheduleRefresh)
        .on("postgres_changes", { event: "*", schema: "public", table: "assignments", filter: `tenant_id=eq.${membership.tenant_id}` }, scheduleRefresh)
        .subscribe((status) => {
          if (!isActive) return;
          setLiveConnected(status === "SUBSCRIBED");
        });

      fallbackInterval = window.setInterval(() => {
        void loadTenantData(membership.tenant_id);
      }, 20000);
    };

    void initRealtime();

    return () => {
      isActive = false;
      setLiveConnected(false);
      if (refreshTimeout) window.clearTimeout(refreshTimeout);
      if (fallbackInterval) window.clearInterval(fallbackInterval);
      if (activeChannel) {
        void client.removeChannel(activeChannel);
      }
    };
  }, [loadTenantData]);

  const fallbackTenantId = state.memberships[0]?.tenant_id ?? state.services[0]?.tenant_id ?? null;
  const currentTenantId = tenantId ?? fallbackTenantId;

  const tenantServices = useMemo(() => {
    return currentTenantId ? state.services.filter((service) => service.tenant_id === currentTenantId) : state.services;
  }, [currentTenantId, state.services]);

  const tenantAssignments = useMemo(() => {
    return currentTenantId ? state.assignments.filter((assignment) => assignment.tenant_id === currentTenantId) : state.assignments;
  }, [currentTenantId, state.assignments]);

  const tenantMemberships = useMemo(() => {
    return currentTenantId ? state.memberships.filter((membership) => membership.tenant_id === currentTenantId) : state.memberships;
  }, [currentTenantId, state.memberships]);

  const assignmentsByServiceId = useMemo(
    () => new Map(tenantAssignments.map((assignment) => [assignment.service_id, assignment])),
    [tenantAssignments]
  );

  const driverNameById = useMemo(
    () => new Map(tenantMemberships.filter((item) => item.role === "driver").map((item) => [item.user_id, item.full_name])),
    [tenantMemberships]
  );

  const filteredServices = useMemo(() => {
    return tenantServices
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
  }, [assignmentsByServiceId, driverFilter, serviceTypeFilter, tenantServices]);

  const availableDates = useMemo(() => [...new Set(tenantServices.map((service) => service.date))].sort(), [tenantServices]);
  const effectiveSelectedDate = availableDates.includes(selectedDate) ? selectedDate : availableDates[0] ?? selectedDate;

  const dayServices = useMemo(
    () => filteredServices.filter((service) => service.date === effectiveSelectedDate),
    [effectiveSelectedDate, filteredServices]
  );

  const weekStart = useMemo(() => startOfWeek(effectiveSelectedDate), [effectiveSelectedDate]);
  const weekDates = useMemo(() => Array.from({ length: 7 }, (_, index) => toIsoDate(addDays(weekStart, index))), [weekStart]);

  const servicesByDayAndSlot = useMemo(() => {
    const map = new Map<string, Service[]>();
    for (const service of filteredServices) {
      const slot = floorToThirtyMinutes(service.time);
      const key = `${service.date}|${slot}`;
      const existing = map.get(key) ?? [];
      existing.push(service);
      map.set(key, existing);
    }
    return map;
  }, [filteredServices]);

  const applyDrop = async (serviceId: string, nextDate: string, nextTime: string) => {
    const service = tenantServices.find((item) => item.id === serviceId);
    if (!service) return;
    const currentTime = floorToThirtyMinutes(service.time);
    if (service.date === nextDate && currentTime === nextTime) return;

    updateServiceSchedule(serviceId, nextDate, nextTime);
    setMessage(`Moved to ${nextDate} ${nextTime}`);

    if (!hasSupabaseEnv || !supabase || !tenantId) return;

    const { error } = await supabase
      .from("services")
      .update({ date: nextDate, time: `${nextTime}:00` })
      .eq("id", serviceId)
      .eq("tenant_id", tenantId);

    if (error) {
      setMessage(`Move failed: ${error.message}`);
      await loadTenantData(tenantId);
      return;
    }

    await loadTenantData(tenantId);
  };

  const onDragStart = (serviceId: string, event: DragEvent<HTMLElement>) => {
    setDraggingServiceId(serviceId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", serviceId);
  };

  const onDropSlot = async (date: string, time: string, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const serviceId = event.dataTransfer.getData("text/plain") || draggingServiceId;
    setDraggingServiceId(null);
    if (!serviceId) return;
    await applyDrop(serviceId, date, time);
  };

  if (loading) return <div className="card p-4 text-sm text-muted">Caricamento planning...</div>;

  const drivers = tenantMemberships.filter((member) => member.role === "driver");

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Planning</h1>
          <span className={liveConnected ? "live-dot" : "status-badge status-badge-cancelled"}>
            {liveConnected ? "Live" : "Offline"}
          </span>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setViewMode("day")}
            className={viewMode === "day" ? "btn-primary" : "btn-secondary"}
          >
            Day view
          </button>
          <button
            type="button"
            onClick={() => setViewMode("week")}
            className={viewMode === "week" ? "btn-primary" : "btn-secondary"}
          >
            Week view
          </button>
        </div>
      </div>

      <div className="card grid gap-3 p-3 md:grid-cols-4">
        <label className="text-sm">
          Date
          <input
            type="date"
            value={selectedDate}
            onChange={(event) => setSelectedDate(event.target.value)}
            className="input-saas mt-1 w-full"
          />
        </label>
        <label className="text-sm">
          Driver
          <select value={driverFilter} onChange={(event) => setDriverFilter(event.target.value)} className="input-saas mt-1 w-full">
            <option value="all">all</option>
            {drivers.map((driver) => (
              <option key={driver.user_id} value={driver.user_id}>
                {driver.full_name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Service type
          <select
            value={serviceTypeFilter}
            onChange={(event) => setServiceTypeFilter(event.target.value as ServiceType | "all")}
            className="input-saas mt-1 w-full"
          >
            <option value="all">all</option>
            <option value="transfer">transfer</option>
            <option value="bus_tour">bus_tour</option>
          </select>
        </label>
        <div className="flex items-end text-xs text-muted">
          Drag a card and drop it on another slot to change service time.
        </div>
      </div>

      {viewMode === "day" ? (
        <div className="card overflow-x-auto p-2">
          <div className="grid min-w-[760px] grid-cols-[80px_1fr]">
            {slots.map((slot) => {
              const key = `${selectedDate}|${slot}`;
              const dayKey = `${effectiveSelectedDate}|${slot}`;
              const servicesAtSlot = servicesByDayAndSlot.get(dayKey) ?? [];
              return (
                <div key={key} className="contents">
                  <div className="border-t border-border px-2 py-3 text-xs text-muted">{slot}</div>
                  <div
                    className="min-h-14 border-t border-border px-2 py-2 hover:bg-blue-50/50"
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => void onDropSlot(effectiveSelectedDate, slot, event)}
                  >
                    <div className="flex flex-wrap gap-2">
                      {servicesAtSlot.map((service) => {
                        const assignment = assignmentsByServiceId.get(service.id);
                        const driver = assignment?.driver_user_id ? driverNameById.get(assignment.driver_user_id) : "Unassigned";
                        return (
                          <article
                            key={service.id}
                            draggable
                            onDragStart={(event) => onDragStart(service.id, event)}
                            className="cursor-grab rounded-xl border border-blue-200 bg-white px-3 py-2 text-xs shadow-sm"
                          >
                            <p className="font-semibold">{service.customer_name}</p>
                            <p className="text-muted">
                              {normalizeTime(service.time)} | {(service.service_type ?? "transfer").toUpperCase()}
                            </p>
                            <p className="text-muted">{driver}</p>
                          </article>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {dayServices.length === 0 ? <p className="p-3 text-sm text-muted">No services for selected day and filters.</p> : null}
        </div>
      ) : (
        <div className="card overflow-x-auto p-2">
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
                    <div
                      key={key}
                      className="min-h-14 border-t border-border px-1.5 py-2 hover:bg-blue-50/40"
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => void onDropSlot(date, slot, event)}
                    >
                      <div className="space-y-1">
                        {servicesAtSlot.map((service) => (
                          <article
                            key={service.id}
                            draggable
                            onDragStart={(event) => onDragStart(service.id, event)}
                            className="cursor-grab rounded-lg border border-blue-200 bg-white px-2 py-1.5 text-[11px] shadow-sm"
                          >
                            <p className="truncate font-semibold">{service.customer_name}</p>
                            <p className="truncate text-muted">{(service.service_type ?? "transfer").toUpperCase()}</p>
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
