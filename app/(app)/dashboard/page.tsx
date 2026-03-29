"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ExportServicesButton } from "@/components/export-services-button";
import { KpiCard } from "@/components/kpi-card";
import { ServicesTable } from "@/components/services-table";
import { EmptyState, PageHeader, SidePanel } from "@/components/ui";
import { needsInboxReview } from "@/lib/inbox-review";
import { buildOperationalInstances } from "@/lib/operational-service-instances";
import { formatServiceSlot, getCustomerFullName, getOutboundTime } from "@/lib/service-display";
import { getServicePdfOperationalMeta } from "@/lib/service-pdf-metadata";
import { supabase } from "@/lib/supabase/client";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";
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

function BellIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4" aria-hidden="true">
      <path d="M8 2.5a2.5 2.5 0 0 0-2.5 2.5v1.1c0 .7-.2 1.4-.5 2L4 10.5h8l-1-2.4c-.3-.6-.5-1.3-.5-2V5A2.5 2.5 0 0 0 8 2.5Z" />
      <path d="M6.5 12a1.5 1.5 0 0 0 3 0" />
    </svg>
  );
}

const INITIAL_ALERT_NOW_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

export default function OperatorDashboardPage() {
  const { loading, liveConnected, tenantId, userId, errorMessage, data, refresh } = useTenantOperationalData({ includeInboundEmails: true });
  const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
  const [appliedGroupIds, setAppliedGroupIds] = useState<string[]>([]);
  const [skippedGroupIds, setSkippedGroupIds] = useState<string[]>([]);
  const [applyingGroupId, setApplyingGroupId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [alertNowMs, setAlertNowMs] = useState(INITIAL_ALERT_NOW_MS);
  const [pendingAccessRequestCount, setPendingAccessRequestCount] = useState(0);

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

  useEffect(() => {
    let active = true;
    const client = supabase;

    const loadPendingAccessRequests = async () => {
      if (!client) return;
      const { data: sessionData } = await client.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!active || !accessToken) return;

      const response = await fetch("/api/settings/users", {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });
      if (!active) return;
      if (!response.ok) {
        setPendingAccessRequestCount(0);
        return;
      }
      const body = (await response.json().catch(() => null)) as { pending_access_requests?: Array<unknown> } | null;
      if (!active) return;
      setPendingAccessRequestCount(body?.pending_access_requests?.length ?? 0);
    };

    void loadPendingAccessRequests();
    if (!client) {
      return () => {
        active = false;
      };
    }

    const channel = client
      .channel("dashboard-pending-access")
      .on("postgres_changes", { event: "*", schema: "public", table: "tenant_access_requests" }, () => {
        void loadPendingAccessRequests();
      });
    channel.subscribe();

    return () => {
      active = false;
      void client.removeChannel(channel);
    };
  }, []);

  if (loading) {
    return <div className="card p-4 text-sm text-slate-500">Caricamento dashboard...</div>;
  }
  if (errorMessage) {
    return (
      <div className="card space-y-2 p-4 text-sm text-muted">
        <p>{errorMessage}</p>
        {errorMessage.toLowerCase().includes("onboarding") ? (
          <Link href="/onboarding" className="btn-primary inline-flex px-3 py-1.5 text-xs">
            Vai a onboarding
          </Link>
        ) : null}
      </div>
    );
  }

  const todayIso = new Date(alertNowMs).toISOString().slice(0, 10);
  const todayInstances = buildOperationalInstances(data.services).filter((instance) => instance.date === todayIso);
  const next48hIso = new Date(alertNowMs + 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const todayServiceIds = new Set(todayInstances.map((instance) => instance.serviceId));
  const todayServices = data.services.filter((service) => todayServiceIds.has(service.id));
  const todayArrivals = todayInstances.filter((instance) => instance.direction === "arrival").length;
  const todayDepartures = todayInstances.filter((instance) => instance.direction === "departure").length;
  const todayPdfServices = todayServices.filter((service) => getServicePdfOperationalMeta(service, data.inboundEmails).isPdf);
  const todayPdfNeedsAttention = todayServices.filter((service) => getServicePdfOperationalMeta(service, data.inboundEmails).reviewRecommended);
  const inboxToReview = data.inboundEmails.filter((email) => needsInboxReview(email.parsed_json));
  const futureInstances = buildOperationalInstances(data.services).filter((instance) => instance.date > todayIso && instance.date <= next48hIso);
  const nextArrivals48h = futureInstances.filter((instance) => instance.direction === "arrival").slice(0, 6);
  const nextDepartures48h = futureInstances.filter((instance) => instance.direction === "departure").slice(0, 6);
  const nextArrivalsBus48h = futureInstances.filter(
    (instance) => instance.direction === "arrival" && (instance.service.service_type_code === "bus_line" || instance.service.booking_service_kind === "bus_city_hotel")
  ).length;
  const nextArrivalsOther48h = futureInstances.filter(
    (instance) => instance.direction === "arrival" && !(instance.service.service_type_code === "bus_line" || instance.service.booking_service_kind === "bus_city_hotel")
  ).length;
  const nextDeparturesBus48h = futureInstances.filter(
    (instance) => instance.direction === "departure" && (instance.service.service_type_code === "bus_line" || instance.service.booking_service_kind === "bus_city_hotel")
  ).length;
  const nextDeparturesOther48h = futureInstances.filter(
    (instance) => instance.direction === "departure" && !(instance.service.service_type_code === "bus_line" || instance.service.booking_service_kind === "bus_city_hotel")
  ).length;
  const hotelsById = new Map(data.hotels.map((hotel) => [hotel.id, hotel]));
  const assignmentsByServiceId = new Map(data.assignments.map((assignment) => [assignment.service_id, assignment]));

  const unassignedServices = todayServices.filter(
    (service) => service.status === "new" || (service.status as string) === "unassigned" || !assignmentsByServiceId.has(service.id)
  );

  const groupsMap = new Map<string, SuggestedGroup>();
  for (const service of unassignedServices) {
    const hotel = hotelsById.get(service.hotel_id);
    if (!hotel) continue;

    const windowLabel = floorToThirtyMinutes(getOutboundTime(service) ?? service.time);
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
  const undeliveredReminderAlerts = data.services.filter((service) => {
    if (service.reminder_status !== "sent" || !service.sent_at) return false;
    const sentAtMs = new Date(service.sent_at).getTime();
    if (!Number.isFinite(sentAtMs)) return false;
    return nowMs - sentAtMs > reminderAlertThresholdMs;
  });
  const pending = todayServices.filter((service) => service.status === "new").length;
  const activeDrivers = new Set(data.assignments.map((assignment) => assignment.driver_user_id).filter(Boolean)).size;
  const totalPax = todayServices.reduce((sum, service) => sum + service.pax, 0);
  const sortedDates = [...new Set(todayServices.map((service) => service.date))].sort();
  const defaultDateFrom = sortedDates[0] ?? todayIso;
  const defaultDateTo = sortedDates[sortedDates.length - 1] ?? defaultDateFrom;

  const applySuggestion = async (group: SuggestedGroup) => {
    if (!supabase || !tenantId || !userId || applyingGroupId || appliedGroupIds.includes(group.id) || skippedGroupIds.includes(group.id)) return;

    const serviceIds = group.services.map((service) => service.id);
    setApplyingGroupId(group.id);

    const { data: existingAssignments, error: readAssignmentsError } = await supabase
      .from("assignments")
      .select("id, service_id, driver_user_id")
      .eq("tenant_id", tenantId)
      .in("service_id", serviceIds);

    if (readAssignmentsError) {
      setApplyingGroupId(null);
      setToastMessage("Applicazione fallita: errore lettura assegnazioni");
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
        .eq("tenant_id", tenantId);
      if (updateError) {
        setApplyingGroupId(null);
        setToastMessage("Applicazione fallita: errore aggiornamento assegnazione");
        return;
      }
    }

    const inserts = serviceIds
      .filter((serviceId) => !existingByService.has(serviceId))
      .map((serviceId) => ({
        tenant_id: tenantId,
        service_id: serviceId,
        vehicle_label: group.suggestedVehicle,
        driver_user_id: null as string | null
      }));
    if (inserts.length > 0) {
      const { error: insertError } = await supabase.from("assignments").insert(inserts);
      if (insertError) {
        setApplyingGroupId(null);
        setToastMessage(`Applicazione fallita: ${insertError.message}`);
        return;
      }
    }

    const { error: serviceUpdateError } = await supabase.from("services").update({ status: "assigned" }).eq("tenant_id", tenantId).in("id", serviceIds).neq("status", "assigned");
    if (serviceUpdateError) {
      setApplyingGroupId(null);
      setToastMessage("Applicazione fallita: errore aggiornamento servizio");
      return;
    }

    const { data: existingAssignedEvents } = await supabase
      .from("status_events")
      .select("service_id")
      .eq("tenant_id", tenantId)
      .eq("status", "assigned")
      .in("service_id", serviceIds);
    const existingEventServiceIds = new Set((existingAssignedEvents ?? []).map((row) => row.service_id));
    const statusEventsToInsert = serviceIds
      .filter((serviceId) => !existingEventServiceIds.has(serviceId))
      .map((serviceId) => ({
        tenant_id: tenantId,
        service_id: serviceId,
        status: "assigned" as const,
        by_user_id: userId
      }));
    if (statusEventsToInsert.length > 0) {
      await supabase.from("status_events").insert(statusEventsToInsert);
    }

    await refresh();
    setAppliedGroupIds((prev) => (prev.includes(group.id) ? prev : [...prev, group.id]));
    setApplyingGroupId(null);
    setToastMessage(`Applicato a ${group.services.length} servizi`);
  };

  const skipSuggestion = (groupId: string) => {
    setSkippedGroupIds((prev) => (prev.includes(groupId) ? prev : [...prev, groupId]));
  };

  return (
    <section className="page-section">
      <PageHeader
        title="Dashboard Oggi"
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Cruscotto" }]}
        badge={<span className={liveConnected ? "live-dot" : "inline-flex items-center gap-2 rounded-full bg-surface-2 px-2.5 py-1 text-xs text-muted"}>{liveConnected ? "In tempo reale" : "Non in linea"}</span>}
        actions={
          <>
            {pendingAccessRequestCount > 0 ? (
              <Link href="/settings/users" className="inline-flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900 shadow-sm hover:bg-amber-100">
                <span className="relative inline-flex">
                  <BellIcon />
                  <span className="absolute -right-2 -top-2 inline-flex min-w-5 items-center justify-center rounded-full bg-rose-600 px-1 py-0.5 text-[10px] font-semibold text-white">
                    {pendingAccessRequestCount > 99 ? "99+" : pendingAccessRequestCount}
                  </span>
                </span>
                <span>Richieste agenzia</span>
              </Link>
            ) : null}
            <ExportServicesButton defaultDateFrom={defaultDateFrom} defaultDateTo={defaultDateTo} />
            <button type="button" onClick={() => setIsSuggestionsOpen(true)} className="btn-secondary">
              Supporto assegnazioni
            </button>
            <Link href="/services/new" className="btn-primary">
              Nuova prenotazione
            </Link>
            <Link href="/dispatch" className="btn-secondary">
              Assegnazioni
            </Link>
          </>
        }
      />
      {pendingAccessRequestCount > 0 ? (
        <article className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white text-amber-700 shadow-sm">
                <BellIcon />
              </span>
              <div>
                <p className="font-semibold">Richieste accesso agenzia da approvare: {pendingAccessRequestCount}</p>
                <p className="mt-1 text-amber-800">Apri la gestione utenti per approvare le nuove agenzie registrate.</p>
              </div>
            </div>
            <Link href="/settings/users" className="btn-secondary px-3 py-2 text-xs">
              Vai a Utenti
            </Link>
          </div>
        </article>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        <KpiCard label="Operativo oggi" value={String(todayInstances.length)} hint="Arrivi + partenze della giornata" />
        <KpiCard label="Senza assegnazione" value={String(pending)} hint="Dato informativo, non blocca il flusso" />
        <KpiCard label="Arrivi oggi" value={String(todayArrivals)} hint="Istanze operative arrivo" />
        <KpiCard label="Partenze oggi" value={String(todayDepartures)} hint="Istanze operative partenza" />
        <KpiCard label="Driver attivi" value={String(activeDrivers)} hint="Con almeno un servizio" />
        <KpiCard label="Pax oggi" value={String(totalPax)} hint="Totale passeggeri" />
        <KpiCard label="Booking PDF oggi" value={String(todayPdfServices.length)} hint="Import confermati da PDF" />
        <KpiCard label="PDF da verificare" value={String(todayPdfNeedsAttention.length)} hint="Quality low o review consigliata" />
        <KpiCard label="Non consegnato" value={String(undeliveredReminderAlerts.length)} hint={`Reminder > ${Number.isFinite(reminderAlertMinutes) ? reminderAlertMinutes : 30} min in stato sent`} />
        <Link href="/inbox" className="block">
          <KpiCard label="Inbox da revisionare" value={String(inboxToReview.length)} hint="Email nuove o in needs_review" />
        </Link>
        <Link href="/hotels" className="block">
          <KpiCard label="Hotel" value={String(data.hotels.length)} hint="Totale hotel tenant corrente" />
        </Link>
      </div>
      <p className="text-sm text-muted">
        Non assegnati oggi: <span className="font-semibold">{unassignedServices.length}</span> | Coperti dai suggerimenti:{" "}
        <span className="font-semibold">{coveredBySuggestions}</span>
      </p>
      <p className="text-sm text-muted">L&apos;operativo non dipende dall&apos;assegnazione: driver e mezzo sono una fase interna successiva.</p>
      {undeliveredReminderAlerts.length > 0 ? (
        <article className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-semibold">
            Reminder non consegnati oltre {Number.isFinite(reminderAlertMinutes) ? reminderAlertMinutes : 30} minuti: {undeliveredReminderAlerts.length}
          </p>
          <ul className="mt-1 space-y-1">
            {undeliveredReminderAlerts.slice(0, 5).map((service) => (
              <li key={service.id}>
                {formatServiceSlot(service)} | {getCustomerFullName(service)}
              </li>
            ))}
          </ul>
        </article>
      ) : null}
      {inboxToReview.length > 0 ? (
        <article className="rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          <p className="font-semibold">Inbox da processare: {inboxToReview.length}</p>
          <p className="mt-1 text-red-800">
            Apri{" "}
            <Link href="/inbox" className="underline">
              Posta in arrivo
            </Link>{" "}
            per revisionare email e confermare i draft servizio.
          </p>
        </article>
      ) : null}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <article className="card p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-text">Lotti operativi 48h</h2>
              <p className="text-sm text-muted">Suddivisione rapida tra linea bus e altri servizi per preparare gli export.</p>
            </div>
            <Link href="/ops-summary" className="btn-secondary px-3 py-1.5 text-xs">
              Export operativi
            </Link>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-border bg-surface/80 p-3">
              <p className="text-xs uppercase tracking-[0.12em] text-muted">Arrivi</p>
              <p className="mt-2 text-sm text-text">Linea bus: <span className="font-semibold">{nextArrivalsBus48h}</span></p>
              <p className="mt-1 text-sm text-text">Altri servizi: <span className="font-semibold">{nextArrivalsOther48h}</span></p>
            </div>
            <div className="rounded-xl border border-border bg-surface/80 p-3">
              <p className="text-xs uppercase tracking-[0.12em] text-muted">Partenze</p>
              <p className="mt-2 text-sm text-text">Linea bus: <span className="font-semibold">{nextDeparturesBus48h}</span></p>
              <p className="mt-1 text-sm text-text">Altri servizi: <span className="font-semibold">{nextDeparturesOther48h}</span></p>
            </div>
          </div>
        </article>

        <article className="card p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-text">Prossimi arrivi 48h</h2>
              <p className="text-sm text-muted">Servizi gia confermati che entreranno nell&apos;operativo a breve.</p>
            </div>
            <Link href="/ops-summary" className="btn-secondary px-3 py-1.5 text-xs">
              Apri riepiloghi
            </Link>
          </div>
          {nextArrivals48h.length === 0 ? (
            <EmptyState title="Nessun arrivo imminente" description="Nelle prossime 48 ore non ci sono arrivi confermati." compact />
          ) : (
            <div className="space-y-2">
              {nextArrivals48h.map((instance) => (
                <article key={instance.instanceId} className="rounded-xl border border-border bg-surface/80 px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-text">{getCustomerFullName(instance.service)}</p>
                    <span className="text-xs text-muted">
                      {formatServiceSlot({
                        arrival_date: instance.date,
                        outbound_time: instance.time
                      })}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted">{instance.service.meeting_point?.trim() || "Meeting point da verificare"}</p>
                </article>
              ))}
            </div>
          )}
        </article>

        <article className="card p-4">
          <div className="mb-3">
            <h2 className="text-base font-semibold text-text">Prossime partenze 48h</h2>
            <p className="text-sm text-muted">Controllo rapido dei rientri e delle uscite imminenti.</p>
          </div>
          {nextDepartures48h.length === 0 ? (
            <EmptyState title="Nessuna partenza imminente" description="Nelle prossime 48 ore non ci sono partenze confermate." compact />
          ) : (
            <div className="space-y-2">
              {nextDepartures48h.map((instance) => (
                <article key={instance.instanceId} className="rounded-xl border border-border bg-surface/80 px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-text">{getCustomerFullName(instance.service)}</p>
                    <span className="text-xs text-muted">
                      {formatServiceSlot({
                        arrival_date: instance.date,
                        outbound_time: instance.time
                      })}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted">{instance.service.meeting_point?.trim() || "Meeting point da verificare"}</p>
                </article>
              ))}
            </div>
          )}
        </article>
      </div>
      <ServicesTable services={todayServices} hotels={data.hotels} assignments={data.assignments} memberships={data.memberships} statusEvents={data.statusEvents} inboundEmails={data.inboundEmails} />
      <SidePanel open={isSuggestionsOpen} onClose={() => setIsSuggestionsOpen(false)} title="Supporto assegnazioni" subtitle="Suggerimenti interni opzionali: il servizio resta operativo anche senza assegnazione.">
        <div className="mt-4 space-y-3">
          {suggestedGroups.filter((group) => !appliedGroupIds.includes(group.id) && !skippedGroupIds.includes(group.id)).length === 0 ? (
            <EmptyState title="Nessun suggerimento disponibile." compact />
          ) : (
            suggestedGroups
              .filter((group) => !appliedGroupIds.includes(group.id) && !skippedGroupIds.includes(group.id))
              .map((group) => {
                const isApplied = appliedGroupIds.includes(group.id);
                const isSkipped = skippedGroupIds.includes(group.id);
                return (
                  <article key={group.id} className="card space-y-2 p-3 md:p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="line-clamp-2 font-medium">
                        {group.vessel} | {group.windowLabel} | {group.zone}
                      </p>
                      <p className="text-sm text-muted">
                        Totale pax: <span className="font-semibold">{group.totalPax}</span> | Veicolo: <span className="font-semibold">{group.suggestedVehicle}</span>
                      </p>
                    </div>
                    <ul className="space-y-1 text-sm text-slate-700">
                      {group.services.map((service) => {
                        const hotel = hotelsById.get(service.hotel_id);
                        return (
                          <li key={service.id} className="text-safe-wrap">
                            {getCustomerFullName(service)} | pax {service.pax} | {hotel?.name ?? "Hotel N/D"}
                          </li>
                        );
                      })}
                    </ul>
                    <div className="flex gap-2 pt-1">
                      <button type="button" onClick={() => void applySuggestion(group)} disabled={isApplied || isSkipped || applyingGroupId === group.id} className="btn-primary px-3 py-1.5 text-sm disabled:opacity-50">
                        {applyingGroupId === group.id ? "Applicazione..." : isApplied ? "Applicato" : "Applica suggerimento"}
                      </button>
                      <button type="button" onClick={() => skipSuggestion(group.id)} disabled={isApplied || isSkipped} className="btn-secondary px-3 py-1.5 text-sm disabled:opacity-50">
                        {isSkipped ? "Saltato" : "Salta"}
                      </button>
                    </div>
                  </article>
                );
              })
          )}
        </div>
      </SidePanel>
      {toastMessage ? <div className="fixed bottom-4 right-4 z-[60] rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">{toastMessage}</div> : null}
    </section>
  );
}
