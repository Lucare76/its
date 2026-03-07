"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ExportServicesButton } from "@/components/export-services-button";
import { KpiCard } from "@/components/kpi-card";
import { ServicesTable } from "@/components/services-table";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { useDemoStore } from "@/lib/use-demo-store";
import type { Hotel, Service } from "@/lib/types";

interface SuggestedGroup {
  id: string;
  vessel: string;
  windowLabel: string;
  zone: Hotel["zone"];
  services: Service[];
  totalPax: number;
  suggestedVehicle: "VAN" | "CAR";
}

function floorToThirtyMinutes(time: string) {
  const [rawHour = "0", rawMinute = "0"] = time.split(":");
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  const flooredMinute = Number.isFinite(minute) ? Math.floor(minute / 30) * 30 : 0;
  return `${String(Number.isFinite(hour) ? hour : 0).padStart(2, "0")}:${String(flooredMinute).padStart(2, "0")}`;
}

export default function OperatorDashboardPage() {
  const { state, loading, upsertAssignment, markServiceAssigned, replaceTenantOperationalData } = useDemoStore();
  const [hotelsCount, setHotelsCount] = useState<string>("...");
  const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
  const [appliedGroupIds, setAppliedGroupIds] = useState<string[]>([]);
  const [skippedGroupIds, setSkippedGroupIds] = useState<string[]>([]);
  const [applyingGroupId, setApplyingGroupId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [liveConnected, setLiveConnected] = useState(false);
  const [alertNowMs, setAlertNowMs] = useState(0);

  useEffect(() => {
    let isActive = true;

    const loadHotelsCount = async () => {
      if (!hasSupabaseEnv || !supabase) {
        if (isActive) setHotelsCount(String(state.hotels.length));
        return;
      }

      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData.user) {
        if (isActive) setHotelsCount("N/D");
        return;
      }

      const { data: membership, error: membershipError } = await supabase
        .from("memberships")
        .select("tenant_id")
        .eq("user_id", userData.user.id)
        .maybeSingle();

      if (membershipError || !membership?.tenant_id) {
        if (isActive) setHotelsCount("N/D");
        return;
      }

      const { count, error: countError } = await supabase
        .from("hotels")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", membership.tenant_id);

      if (countError) {
        if (isActive) setHotelsCount("N/D");
        return;
      }

      if (isActive) setHotelsCount(String(count ?? 0));
    };

    void loadHotelsCount();
    return () => {
      isActive = false;
    };
  }, [state.hotels.length]);

  useEffect(() => {
    const client = supabase;
    if (!hasSupabaseEnv || !client) return;

    let isActive = true;
    let refreshTimeout: number | null = null;
    let fallbackInterval: number | null = null;

    const loadTenantData = async (tenantId: string) => {
      const [servicesResult, assignmentsResult, statusEventsResult, hotelsResult, membershipsResult] = await Promise.all([
        client.from("services").select("*").eq("tenant_id", tenantId),
        client.from("assignments").select("*").eq("tenant_id", tenantId),
        client.from("status_events").select("*").eq("tenant_id", tenantId),
        client.from("hotels").select("*").eq("tenant_id", tenantId),
        client.from("memberships").select("*").eq("tenant_id", tenantId)
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

      replaceTenantOperationalData(tenantId, {
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
        .select("tenant_id")
        .eq("user_id", userData.user.id)
        .maybeSingle();

      if (membershipError || !membership?.tenant_id || !isActive) return;

      const tenantId = membership.tenant_id;
      await loadTenantData(tenantId);

      const scheduleRefresh = () => {
        if (!isActive) return;
        if (refreshTimeout) window.clearTimeout(refreshTimeout);
        refreshTimeout = window.setTimeout(() => {
          void loadTenantData(tenantId);
        }, 400);
      };

      const channel = client
        .channel(`operator-live-${tenantId}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "services", filter: `tenant_id=eq.${tenantId}` }, scheduleRefresh)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "assignments", filter: `tenant_id=eq.${tenantId}` },
          scheduleRefresh
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "status_events", filter: `tenant_id=eq.${tenantId}` },
          scheduleRefresh
        );

      channel.subscribe((status) => {
        if (!isActive) return;
        setLiveConnected(status === "SUBSCRIBED");
      });

      fallbackInterval = window.setInterval(() => {
        void loadTenantData(tenantId);
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
  }, [replaceTenantOperationalData]);

  useEffect(() => {
    if (!toastMessage) return;
    const timeout = window.setTimeout(() => setToastMessage(null), 2200);
    return () => window.clearTimeout(timeout);
  }, [toastMessage]);

  useEffect(() => {
    const refreshNow = () => setAlertNowMs(Date.now());
    refreshNow();
    const interval = window.setInterval(refreshNow, 60000);
    return () => window.clearInterval(interval);
  }, []);

  if (loading) {
    return <div className="card p-4 text-sm text-slate-500">Caricamento dashboard...</div>;
  }

  const tenantId = state.memberships[0]?.tenant_id ?? state.services[0]?.tenant_id ?? null;
  const tenantServices = tenantId ? state.services.filter((service) => service.tenant_id === tenantId) : state.services;
  const todayServices = state.services.filter((service) => service.date === "2026-03-02");
  const tenantTodayServices = tenantId ? todayServices.filter((service) => service.tenant_id === tenantId) : todayServices;
  const tenantHotels = tenantId ? state.hotels.filter((hotel) => hotel.tenant_id === tenantId) : state.hotels;
  const tenantAssignments = tenantId
    ? state.assignments.filter((assignment) => assignment.tenant_id === tenantId)
    : state.assignments;
  const tenantMemberships = tenantId
    ? state.memberships.filter((membership) => membership.tenant_id === tenantId)
    : state.memberships;
  const tenantStatusEvents = tenantId
    ? state.statusEvents.filter((event) => event.tenant_id === tenantId)
    : state.statusEvents;
  const tenantInboundEmails = tenantId
    ? state.inboundEmails.filter((email) => email.tenant_id === tenantId)
    : state.inboundEmails;
  const hotelsById = new Map(tenantHotels.map((hotel) => [hotel.id, hotel]));
  const assignmentsByServiceId = new Map(tenantAssignments.map((assignment) => [assignment.service_id, assignment]));

  const unassignedServices = tenantTodayServices.filter(
    (service) => service.status === "new" || (service.status as string) === "unassigned" || !assignmentsByServiceId.has(service.id)
  );

  const groupsMap = new Map<string, SuggestedGroup>();
  for (const service of unassignedServices) {
    const hotel = hotelsById.get(service.hotel_id);
    if (!hotel) continue;

    const windowLabel = floorToThirtyMinutes(service.time);
    const key = `${service.date}|${service.vessel}|${windowLabel}|${hotel.zone}`;
    const existing = groupsMap.get(key);

    if (existing) {
      existing.services.push(service);
      existing.totalPax += service.pax;
      existing.suggestedVehicle = existing.totalPax >= 6 ? "VAN" : "CAR";
      continue;
    }

    groupsMap.set(key, {
      id: key,
      vessel: service.vessel,
      windowLabel,
      zone: hotel.zone,
      services: [service],
      totalPax: service.pax,
      suggestedVehicle: service.pax >= 6 ? "VAN" : "CAR"
    });
  }
  const suggestedGroups = Array.from(groupsMap.values()).sort((a, b) => {
    if (a.windowLabel !== b.windowLabel) return a.windowLabel.localeCompare(b.windowLabel);
    if (a.vessel !== b.vessel) return a.vessel.localeCompare(b.vessel);
    return a.zone.localeCompare(b.zone);
  });

  const coveredBySuggestions = new Set(suggestedGroups.flatMap((group) => group.services.map((service) => service.id))).size;
  const reminderAlertMinutes = Number(process.env.NEXT_PUBLIC_REMINDER_ALERT_MINUTES ?? "30");
  const reminderAlertThresholdMs = (Number.isFinite(reminderAlertMinutes) ? reminderAlertMinutes : 30) * 60 * 1000;
  const nowMs = alertNowMs;
  const undeliveredReminderAlerts = tenantServices.filter((service) => {
    if (service.reminder_status !== "sent" || !service.sent_at) return false;
    const sentAtMs = new Date(service.sent_at).getTime();
    if (!Number.isFinite(sentAtMs)) return false;
    return nowMs - sentAtMs > reminderAlertThresholdMs;
  });
  const pending = tenantTodayServices.filter((service) => service.status === "new").length;
  const activeDrivers = new Set(tenantAssignments.map((assignment) => assignment.driver_user_id).filter(Boolean)).size;
  const totalPax = tenantTodayServices.reduce((sum, service) => sum + service.pax, 0);
  const sortedDates = [...new Set(tenantTodayServices.map((service) => service.date))].sort();
  const defaultDateFrom = sortedDates[0] ?? "2026-03-02";
  const defaultDateTo = sortedDates[sortedDates.length - 1] ?? defaultDateFrom;

  const applySuggestion = async (group: SuggestedGroup) => {
    if (applyingGroupId || appliedGroupIds.includes(group.id) || skippedGroupIds.includes(group.id)) return;

    const serviceIds = group.services.map((service) => service.id);
    const fallbackByUserId = tenantMemberships.find((membership) => membership.role === "operator")?.user_id ?? "system";
    setApplyingGroupId(group.id);

    if (hasSupabaseEnv && supabase) {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData.user) {
        setApplyingGroupId(null);
        setToastMessage("Apply failed: user not authenticated");
        return;
      }

      const byUserId = userData.user.id;
      const { data: membership, error: membershipError } = await supabase
        .from("memberships")
        .select("tenant_id")
        .eq("user_id", byUserId)
        .maybeSingle();

      if (membershipError || !membership?.tenant_id) {
        setApplyingGroupId(null);
        setToastMessage("Apply failed: tenant not found");
        return;
      }

      const { data: existingAssignments, error: readAssignmentsError } = await supabase
        .from("assignments")
        .select("id, service_id, driver_user_id")
        .eq("tenant_id", membership.tenant_id)
        .in("service_id", serviceIds);

      if (readAssignmentsError) {
        setApplyingGroupId(null);
        setToastMessage("Apply failed: assignments read error");
        return;
      }

      const existingByService = new Map((existingAssignments ?? []).map((row) => [row.service_id, row]));

      for (const serviceId of serviceIds) {
        const existing = existingByService.get(serviceId);
        if (!existing) continue;
        const { error: updateError } = await supabase
          .from("assignments")
          .update({ vehicle_label: group.suggestedVehicle, driver_user_id: existing.driver_user_id })
          .eq("id", existing.id)
          .eq("tenant_id", membership.tenant_id);
        if (updateError) {
          setApplyingGroupId(null);
          setToastMessage("Apply failed: assignment update error");
          return;
        }
      }

      const inserts = serviceIds
        .filter((serviceId) => !existingByService.has(serviceId))
        .map((serviceId) => ({
          tenant_id: membership.tenant_id,
          service_id: serviceId,
          vehicle_label: group.suggestedVehicle,
          driver_user_id: null as string | null
        }));

      if (inserts.length > 0) {
        const { error: insertError } = await supabase.from("assignments").insert(inserts);
        if (insertError) {
          setApplyingGroupId(null);
          setToastMessage(`Apply failed: ${insertError.message}`);
          return;
        }
      }

      const { error: serviceUpdateError } = await supabase
        .from("services")
        .update({ status: "assigned" })
        .eq("tenant_id", membership.tenant_id)
        .in("id", serviceIds)
        .neq("status", "assigned");

      if (serviceUpdateError) {
        setApplyingGroupId(null);
        setToastMessage("Apply failed: service update error");
        return;
      }

      const { data: existingAssignedEvents, error: readEventsError } = await supabase
        .from("status_events")
        .select("service_id")
        .eq("tenant_id", membership.tenant_id)
        .eq("status", "assigned")
        .in("service_id", serviceIds);

      if (readEventsError) {
        setApplyingGroupId(null);
        setToastMessage("Apply failed: status events read error");
        return;
      }

      const existingEventServiceIds = new Set((existingAssignedEvents ?? []).map((row) => row.service_id));
      const statusEventsToInsert = serviceIds
        .filter((serviceId) => !existingEventServiceIds.has(serviceId))
        .map((serviceId) => ({
          tenant_id: membership.tenant_id,
          service_id: serviceId,
          status: "assigned" as const,
          by_user_id: byUserId
        }));

      if (statusEventsToInsert.length > 0) {
        const { error: insertEventsError } = await supabase.from("status_events").insert(statusEventsToInsert);
        if (insertEventsError) {
          setApplyingGroupId(null);
          setToastMessage("Apply failed: status events insert error");
          return;
        }
      }
    }

    for (const service of group.services) {
      const existing = assignmentsByServiceId.get(service.id);
      upsertAssignment(service.id, group.suggestedVehicle, existing?.driver_user_id ?? null);
      markServiceAssigned(service.id, fallbackByUserId);
    }

    setAppliedGroupIds((prev) => (prev.includes(group.id) ? prev : [...prev, group.id]));
    setApplyingGroupId(null);
    setToastMessage(`Applied to ${group.services.length} services`);
  };

  const skipSuggestion = (groupId: string) => {
    setSkippedGroupIds((prev) => (prev.includes(groupId) ? prev : [...prev, groupId]));
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Dashboard Oggi</h1>
          <span className={liveConnected ? "live-dot" : "inline-flex items-center gap-2 rounded-full bg-surface-2 px-2.5 py-1 text-xs text-muted"}>
            {liveConnected ? "Live" : "Offline"}
          </span>
        </div>
        <div className="flex gap-2">
          <ExportServicesButton defaultDateFrom={defaultDateFrom} defaultDateTo={defaultDateTo} />
          <button
            type="button"
            onClick={() => setIsSuggestionsOpen(true)}
            className="btn-secondary"
          >
            Suggested Dispatch
          </button>
          <Link href="/services/new" className="btn-primary">
            Nuova prenotazione
          </Link>
          <Link href="/dispatch" className="btn-secondary">
            Dispatch
          </Link>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-6">
        <KpiCard label="Servizi oggi" value={String(tenantTodayServices.length)} hint="Operativita giornaliera" />
        <KpiCard label="Da assegnare" value={String(pending)} hint="Servizi stato new" />
        <KpiCard label="Driver attivi" value={String(activeDrivers)} hint="Con almeno un servizio" />
        <KpiCard label="Pax oggi" value={String(totalPax)} hint="Totale passeggeri" />
        <KpiCard
          label="Non consegnato"
          value={String(undeliveredReminderAlerts.length)}
          hint={`Reminder > ${Number.isFinite(reminderAlertMinutes) ? reminderAlertMinutes : 30} min in stato sent`}
        />
        <Link href="/hotels" className="block">
          <KpiCard label="Hotels" value={hotelsCount} hint="Totale hotel tenant corrente" />
        </Link>
      </div>
      <p className="text-sm text-muted">
        Unassigned oggi: <span className="font-semibold">{unassignedServices.length}</span> | Coperti dai suggerimenti:{" "}
        <span className="font-semibold">{coveredBySuggestions}</span>
      </p>
      {undeliveredReminderAlerts.length > 0 ? (
        <article className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-semibold">
            Reminder non consegnati oltre {Number.isFinite(reminderAlertMinutes) ? reminderAlertMinutes : 30} minuti:{" "}
            {undeliveredReminderAlerts.length}
          </p>
          <ul className="mt-1 space-y-1">
            {undeliveredReminderAlerts.slice(0, 5).map((service) => (
              <li key={service.id}>
                {service.date} {service.time} | {service.customer_name}
              </li>
            ))}
          </ul>
        </article>
      ) : null}
      <ServicesTable
        services={tenantTodayServices}
        hotels={tenantHotels}
        assignments={tenantAssignments}
        memberships={tenantMemberships}
        statusEvents={tenantStatusEvents}
        inboundEmails={tenantInboundEmails}
      />
      {isSuggestionsOpen ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30">
          <aside className="h-full w-full max-w-2xl overflow-y-auto bg-white p-4 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <h2 className="text-lg font-semibold">Suggested Dispatch</h2>
                <p className="text-sm text-slate-500">Preview deterministico per i servizi di oggi non assegnati.</p>
              </div>
              <button
                type="button"
                onClick={() => setIsSuggestionsOpen(false)}
                className="btn-secondary px-3 py-1 text-sm"
              >
                Chiudi
              </button>
            </div>
            <div className="mt-4 space-y-3">
              {suggestedGroups.filter((group) => !appliedGroupIds.includes(group.id) && !skippedGroupIds.includes(group.id)).length ===
              0 ? (
                <p className="card p-3 text-sm text-slate-500">Nessun suggerimento disponibile.</p>
              ) : (
                suggestedGroups
                  .filter((group) => !appliedGroupIds.includes(group.id) && !skippedGroupIds.includes(group.id))
                  .map((group) => {
                  const isApplied = appliedGroupIds.includes(group.id);
                  const isSkipped = skippedGroupIds.includes(group.id);
                  return (
                    <article key={group.id} className="card space-y-2 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium">
                          {group.vessel} | {group.windowLabel} | {group.zone}
                        </p>
                        <p className="text-sm text-muted">
                          Totale pax: <span className="font-semibold">{group.totalPax}</span> | Veicolo:{" "}
                          <span className="font-semibold">{group.suggestedVehicle}</span>
                        </p>
                      </div>
                      <ul className="space-y-1 text-sm text-slate-700">
                        {group.services.map((service) => {
                          const hotel = hotelsById.get(service.hotel_id);
                          return (
                            <li key={service.id}>
                              {service.customer_name} | pax {service.pax} | {hotel?.name ?? "Hotel N/D"}
                            </li>
                          );
                        })}
                      </ul>
                      <div className="flex gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => void applySuggestion(group)}
                          disabled={isApplied || isSkipped || applyingGroupId === group.id}
                          className="btn-primary px-3 py-1.5 text-sm disabled:opacity-50"
                        >
                          {applyingGroupId === group.id ? "Applying..." : isApplied ? "Applied" : "Apply suggestion"}
                        </button>
                        <button
                          type="button"
                          onClick={() => skipSuggestion(group.id)}
                          disabled={isApplied || isSkipped}
                          className="btn-secondary px-3 py-1.5 text-sm disabled:opacity-50"
                        >
                          {isSkipped ? "Skipped" : "Skip"}
                        </button>
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          </aside>
        </div>
      ) : null}
      {toastMessage ? (
        <div className="fixed bottom-4 right-4 z-[60] rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">
          {toastMessage}
        </div>
      ) : null}
    </section>
  );
}
