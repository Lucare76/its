"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { OperationsSuggestions } from "@/components/operations-suggestions";
import { EmptyState, SidePanel } from "@/components/ui";
import { buildOperationalInstances } from "@/lib/operational-service-instances";
import { formatDisplayUppercase, formatServiceSlot, getCustomerFullName, getOutboundTime } from "@/lib/service-display";
import { supabase } from "@/lib/supabase/client";
import { useDashboardData } from "@/lib/supabase/use-dashboard-data";
import type { Service } from "@/lib/types";

interface SuggestedGroup {
  id: string;
  vessel: string;
  windowLabel: string;
  zone: string;
  services: Service[];
  totalPax: number;
  suggestedVehicle: "VAN" | "CAR";
}

function BellIcon() {
  return <span aria-hidden="true">●</span>;
}

function floorToThirtyMinutes(time: string) {
  const [rawHour = "0", rawMinute = "0"] = time.split(":");
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  const flooredMinute = Number.isFinite(minute) ? Math.floor(minute / 30) * 30 : 0;
  return `${String(Number.isFinite(hour) ? hour : 0).padStart(2, "0")}:${String(flooredMinute).padStart(2, "0")}`;
}

const INITIAL_ALERT_NOW_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

export default function OperatorDashboardPage() {
  const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
  const [appliedGroupIds, setAppliedGroupIds] = useState<string[]>([]);
  const [skippedGroupIds, setSkippedGroupIds] = useState<string[]>([]);
  const [applyingGroupId, setApplyingGroupId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [alertNowMs, setAlertNowMs] = useState(INITIAL_ALERT_NOW_MS);
  const [pendingAccessRequestCount, setPendingAccessRequestCount] = useState(0);
  const [pendingAgencyReviewCount, setPendingAgencyReviewCount] = useState(0);
  const [activeBusGps, setActiveBusGps] = useState<number | null>(null);
  const [dayOffset, setDayOffset] = useState<0 | 1>(0);
  const [serviceView, setServiceView] = useState<"transfers" | "shuttles">("transfers");
  const [operationsQuery, setOperationsQuery] = useState("");
  const [directionFilter, setDirectionFilter] = useState<"all" | "arrival" | "departure">("all");
  const [timeBandFilter, setTimeBandFilter] = useState<"all" | "morning" | "afternoon" | "evening">("all");
  const [operationsPage, setOperationsPage] = useState(1);

  // Sprint Performance 14B: same formulas as before (untouched), just now
  // also doubling as the /api/ops/dashboard-data request window instead of
  // only being in-memory filter boundaries over a full-history fetch.
  const todayIso = new Date(alertNowMs + dayOffset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const next48hIso = new Date(alertNowMs + 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { loading, liveConnected, errorMessage, data, refresh } = useDashboardData({ today: todayIso, next48h: next48hIso });

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session?.access_token) return;
      fetch("/api/gps/control-room", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store"
      })
        .then((r) => r.json().catch(() => null))
        .then((body: { summary?: { moving?: number } } | null) => {
          if (body?.summary?.moving !== undefined) setActiveBusGps(body.summary.moving);
        })
        .catch(() => undefined);
    });
  }, []);

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

    const loadPendingAgencyReviews = async () => {
      if (!client) return;
      const { data: sessionData } = await client.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!active || !token) return;
      const res = await fetch("/api/admin/agency-reviews?status=modified", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!active || !res.ok) return;
      const body = (await res.json().catch(() => null)) as { sessions?: unknown[] } | null;
      if (active) setPendingAgencyReviewCount(body?.sessions?.length ?? 0);
    };

    void loadPendingAccessRequests();
    void loadPendingAgencyReviews();
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

  const isShuttleService = (service: Service) => service.booking_service_kind === "navetta" || service.booking_service_kind === "shuttle_hotel" || service.vessel?.trim().toLocaleLowerCase("it") === "navetta";
  const allTodayInstances = buildOperationalInstances(data.windowServices).filter((instance) => instance.date === todayIso);
  const todayInstances = allTodayInstances.filter((instance) => serviceView === "shuttles" ? isShuttleService(instance.service) : !isShuttleService(instance.service));
  const shuttleInstancesCount = allTodayInstances.filter((instance) => isShuttleService(instance.service)).length;
  const todayServiceIds = new Set(todayInstances.map((instance) => instance.serviceId));
  const todayServices = data.windowServices.filter((service) => todayServiceIds.has(service.id));
  const todayArrivals = todayInstances.filter((instance) => instance.direction === "arrival").length;
  const todayDepartures = todayInstances.filter((instance) => instance.direction === "departure").length;
  // Sprint Performance 14B: today's PDF-review-recommended count and the two
  // inbox review counts are now computed server-side (see
  // lib/server/dashboard-data.ts), reusing the exact same pure helpers
  // (getServicePdfOperationalMeta, isInboxPdfReviewOpen/isInboxPdfTestNoise,
  // needsInboxReview) instead of scanning the full tenant history/mailbox in
  // the browser. todayPdfNeedsAttentionCount mirrors the legacy
  // todayPdfNeedsAttention array (never rendered — kept for parity/future
  // use, now with the corrected isPdf semantics).
  const inboxPdfNeedsReviewCount = data.inboxPdfNeedsReviewCount;
  const inboxToReviewCount = data.inboxToReviewCount;
  const futureInstances = buildOperationalInstances(data.windowServices).filter((instance) => instance.date > todayIso && instance.date <= next48hIso && (serviceView === "shuttles" ? isShuttleService(instance.service) : !isShuttleService(instance.service)));
  const nextArrivals48h = futureInstances.filter((instance) => instance.direction === "arrival").slice(0, 6);
  const nextDepartures48h = futureInstances.filter((instance) => instance.direction === "departure").slice(0, 6);
  const isBusLine = (instance: (typeof futureInstances)[number]) => instance.service.service_type_code === "bus_line" || instance.service.booking_service_kind === "bus_city_hotel";
  const nextArrivalsBus48h = futureInstances.filter((instance) => instance.direction === "arrival" && isBusLine(instance)).length;
  const nextArrivalsOther48h = futureInstances.filter((instance) => instance.direction === "arrival" && !isBusLine(instance)).length;
  const nextDeparturesBus48h = futureInstances.filter((instance) => instance.direction === "departure" && isBusLine(instance)).length;
  const nextDeparturesOther48h = futureInstances.filter((instance) => instance.direction === "departure" && !isBusLine(instance)).length;
  const hotelsById = new Map(data.hotels.map((hotel) => [hotel.id, hotel]));
  const assignmentsByServiceId = new Map(data.assignments.map((assignment) => [assignment.service_id, assignment]));
  const operationalRows = (() => {
    const query = operationsQuery.trim().toLocaleLowerCase("it");
    return todayInstances.filter((instance) => {
      if (directionFilter !== "all" && instance.direction !== directionFilter) return false;
      const hour = Number(instance.time.slice(0, 2));
      const band = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
      if (timeBandFilter !== "all" && band !== timeBandFilter) return false;
      if (!query) return true;
      const hotel = hotelsById.get(instance.service.hotel_id)?.name ?? "";
      return [getCustomerFullName(instance.service), hotel, instance.service.vessel, instance.service.transport_code]
        .some((value) => String(value ?? "").toLocaleLowerCase("it").includes(query));
    });
  })();
  const operationsPerPage = 50;
  const operationsPages = Math.max(1, Math.ceil(operationalRows.length / operationsPerPage));
  const safeOperationsPage = Math.min(operationsPage, operationsPages);
  const pagedOperationalRows = operationalRows.slice((safeOperationsPage - 1) * operationsPerPage, safeOperationsPage * operationsPerPage);
  const timeBandCounts = todayInstances.reduce((counts, instance) => {
    const hour = Number(instance.time.slice(0, 2));
    const band = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
    counts[band] += 1;
    return counts;
  }, { morning: 0, afternoon: 0, evening: 0 });

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
  // Sprint Performance 14B: undelivered-reminder count/sample now come from
  // lib/server/dashboard-data.ts (SQL-pushed predicate + isUndeliveredReminder
  // from lib/service-reminder.ts as a defensive re-check on the sample),
  // instead of scanning every service ever created in the browser.
  // reminderAlertMinutes is kept client-side purely for the banner's display
  // text — same env var the server reads for the actual filtering.
  const reminderAlertMinutes = Number(process.env.NEXT_PUBLIC_REMINDER_ALERT_MINUTES ?? "30");
  const undeliveredReminderCount = data.undeliveredReminderCount;
  const undeliveredReminderSample = data.undeliveredReminderSample;
  const pending = todayServices.filter((service) => service.status === "new").length;
  const totalPax = todayServices.reduce((sum, service) => sum + service.pax, 0);

  const applySuggestion = async (group: SuggestedGroup) => {
    if (!supabase || applyingGroupId || appliedGroupIds.includes(group.id) || skippedGroupIds.includes(group.id)) return;

    setApplyingGroupId(group.id);

    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) {
      setApplyingGroupId(null);
      setToastMessage("Sessione scaduta. Rifai login.");
      return;
    }

    for (const service of group.services) {
      const res = await fetch("/api/ops/assign-service", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          service_id: service.id,
          vehicle_label: group.suggestedVehicle,
          driver_user_id: null,
          action: "assign",
        }),
      });
      const json = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!json?.ok) {
        setApplyingGroupId(null);
        setToastMessage(json?.error ?? "Applicazione fallita.");
        return;
      }
    }

    await refresh();
    setAppliedGroupIds((prev) => (prev.includes(group.id) ? prev : [...prev, group.id]));
    setApplyingGroupId(null);
    setToastMessage(`Applicato a ${group.services.length} servizi`);
  };

  const skipSuggestion = (groupId: string) => {
    setSkippedGroupIds((prev) => (prev.includes(groupId) ? prev : [...prev, groupId]));
  };

  const todayLabel = new Date(alertNowMs).toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" });

  return (
    <section className="mx-auto max-w-[1500px] space-y-4 pb-8">

      {/* ── Hero strip ─────────────────────────────────────────────────────── */}
      <div className="relative px-1 py-1 text-slate-950">
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight">Cruscotto</h1>
            <p className="mt-1 text-sm font-medium capitalize text-slate-500">{todayLabel}</p>
            <div className="mt-1 flex items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${liveConnected ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${liveConnected ? "bg-emerald-400 animate-pulse" : "bg-white/30"}`} />
                {liveConnected ? "In tempo reale" : "Non in linea"}
              </span>
            </div>
          </div>
          <div className="flex w-full flex-wrap items-center gap-3 lg:w-auto lg:justify-end">
            <div className="flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
              <button type="button" onClick={() => { setDayOffset(0); setOperationsPage(1); }} className={`rounded-lg px-5 py-2 text-sm font-semibold ${dayOffset === 0 ? "bg-indigo-600 text-white" : "text-slate-600"}`}>Oggi</button>
              <button type="button" onClick={() => { setDayOffset(1); setOperationsPage(1); }} className={`rounded-lg px-5 py-2 text-sm font-semibold ${dayOffset === 1 ? "bg-indigo-600 text-white" : "text-slate-600"}`}>Domani</button>
            </div>
            <Link href="/services/new"
              className="btn-primary w-full px-6 py-3 text-center text-sm font-bold shadow-lg shadow-indigo-200 sm:w-auto">
              + Nuova prenotazione
            </Link>
          </div>
        </div>
      </div>

      {/* ── Alert banner agenzie ─────────────────────────────────────────── */}
      {false && pendingAgencyReviewCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-900 shadow-sm">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-red-500 shadow-sm text-base">✏️</span>
            <div>
              <p className="font-semibold">Modifiche agenzie in attesa: {pendingAgencyReviewCount}</p>
              <p className="text-xs text-red-700 mt-0.5">Le agenzie hanno segnalato modifiche ai riepiloghi.</p>
            </div>
          </div>
          <Link href="/inbox/agency-reviews" className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 transition">Vai alle revisioni →</Link>
        </div>
      )}
      {false && pendingAccessRequestCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900 shadow-sm">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-amber-600 shadow-sm"><BellIcon /></span>
            <div>
              <p className="font-semibold">Richieste accesso agenzia: {pendingAccessRequestCount}</p>
              <p className="text-xs text-amber-700 mt-0.5">Apri la gestione utenti per approvare.</p>
            </div>
          </div>
          <Link href="/settings/users" className="rounded-lg border border-amber-200 bg-white px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-50 transition">Vai a Utenti →</Link>
        </div>
      )}

      {/* ── KPI grid ────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[
          { icon: "⚡", label: "Operativo oggi", value: todayInstances.length, color: "#4338ca", bg: "#eef2ff", href: "/arrivals" },
          { icon: "✈️", label: "Arrivi oggi",     value: todayArrivals,         color: "#0369a1", bg: "#e0f2fe", href: "/arrivals" },
          { icon: "🚀", label: "Partenze oggi",   value: todayDepartures,       color: "#7c3aed", bg: "#f5f3ff", href: "/departures" },
          { icon: "👥", label: "Passeggeri",      value: totalPax,              color: "#0f766e", bg: "#f0fdfa", href: "/arrivals" },
          { icon: "⚠️", label: "Anomalie", value: pending + inboxPdfNeedsReviewCount + inboxToReviewCount, color: pending + inboxPdfNeedsReviewCount + inboxToReviewCount > 0 ? "#dc2626" : "#64748b", bg: "#fef2f2", href: "/dispatch" },
        ].map(({ icon, label, value, color, bg, href }) => {
          const inner = (
            <div className={`flex min-h-[106px] items-center gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:shadow-md ${href ? "cursor-pointer hover:border-indigo-200" : ""}`}>
              <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl text-2xl" style={{ backgroundColor: bg, color }}>{icon}</span>
              <div><p className="text-sm font-medium text-slate-500">{label}</p><span className="text-3xl font-extrabold tracking-tight text-slate-950">{value}</span></div>
            </div>
          );
          return href ? <Link key={label} href={href} className="block">{inner}</Link> : <div key={label}>{inner}</div>;
        })}
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="pms-panel overflow-hidden p-4 md:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-extrabold text-slate-950">Operatività di oggi</h2>
              <p className="text-xs text-slate-500">Elenco operativo scalabile fino a 400 servizi e oltre.</p>
            </div>
            <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-700">{operationalRows.length} servizi</span>
          </div>
          <div className="mt-4 flex flex-col gap-2 lg:flex-row">
            <input value={operationsQuery} onChange={(event) => { setOperationsQuery(event.target.value); setOperationsPage(1); }} className="input-saas min-w-0 flex-1" placeholder="Cerca cliente, hotel, corsa…" />
            <div className="flex flex-wrap gap-2">
              {([['all', `Tutti ${todayInstances.length}`], ['arrival', `Arrivi ${todayArrivals}`], ['departure', `Partenze ${todayDepartures}`]] as const).map(([value, label]) => (
                <button key={value} type="button" onClick={() => { setDirectionFilter(value); setOperationsPage(1); }} className={directionFilter === value ? "btn-primary px-3 py-2 text-xs" : "btn-secondary px-3 py-2 text-xs"}>{label}</button>
              ))}
              <button type="button" onClick={() => { setServiceView((view) => view === "transfers" ? "shuttles" : "transfers"); setOperationsPage(1); }} className={serviceView === "shuttles" ? "btn-primary px-3 py-2 text-xs" : "btn-secondary px-3 py-2 text-xs"}>{serviceView === "shuttles" ? "Mostra transfer" : `Navette ${shuttleInstancesCount}`}</button>
              <span className="btn-secondary cursor-default px-3 py-2 text-xs">50 per pagina</span>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {([['all', 'Tutta la giornata', todayInstances.length], ['morning', 'Mattina', timeBandCounts.morning], ['afternoon', 'Pomeriggio', timeBandCounts.afternoon], ['evening', 'Sera', timeBandCounts.evening]] as const).map(([value, label, count]) => (
              <button key={value} type="button" onClick={() => { setTimeBandFilter(value); setOperationsPage(1); }} className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${timeBandFilter === value ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-500"}`}>{label} <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5">{count}</span></button>
            ))}
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-xs">
              <thead className="border-b border-slate-200 text-[10px] font-bold uppercase tracking-wide text-slate-400"><tr><th className="px-3 py-2">Orario</th><th className="px-3 py-2">Cliente</th><th className="px-3 py-2">Hotel</th><th className="px-3 py-2">Trasporto</th><th className="px-3 py-2">Pax</th><th className="px-3 py-2">Autista / Veicolo</th><th className="px-3 py-2">Stato</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {pagedOperationalRows.map((instance) => {
                  const assignment = assignmentsByServiceId.get(instance.serviceId);
                  const unassigned = !assignment;
                  return <tr key={instance.instanceId} className={unassigned ? "bg-amber-50/60" : "hover:bg-slate-50"}>
                    <td className="px-3 py-2.5 font-extrabold text-indigo-700">{instance.time}</td><td className="px-3 py-2.5 font-bold text-slate-800">{getCustomerFullName(instance.service)}</td><td className="px-3 py-2.5 text-slate-600">{hotelsById.get(instance.service.hotel_id)?.name ?? "—"}</td><td className="px-3 py-2.5 text-slate-600">{instance.service.vessel || instance.service.transport_code || "—"}</td><td className="px-3 py-2.5 font-semibold">{instance.service.pax}</td><td className="px-3 py-2.5 text-slate-600">{assignment ? `${assignment.driver_profile_id ? "Autista assegnato" : "Autista da confermare"} / ${assignment.vehicle_label || "Mezzo N/D"}` : "Non assegnato"}</td><td className="px-3 py-2.5"><span className={`rounded-full px-2 py-1 text-[10px] font-bold ${unassigned ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>{unassigned ? "In attesa" : instance.service.status}</span></td>
                  </tr>;
                })}
              </tbody>
            </table>
            {pagedOperationalRows.length === 0 ? <p className="py-8 text-center text-sm text-slate-500">Nessun servizio nel filtro selezionato.</p> : null}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
            <p>Visualizzati {operationalRows.length === 0 ? 0 : (safeOperationsPage - 1) * operationsPerPage + 1}–{Math.min(safeOperationsPage * operationsPerPage, operationalRows.length)} di {operationalRows.length}</p>
            <div className="flex gap-1"><button type="button" disabled={safeOperationsPage <= 1} onClick={() => setOperationsPage((page) => Math.max(1, page - 1))} className="btn-secondary px-3 py-1.5 disabled:opacity-40">‹</button><span className="btn-primary cursor-default px-3 py-1.5">{safeOperationsPage}</span><span className="btn-secondary cursor-default px-3 py-1.5">di {operationsPages}</span><button type="button" disabled={safeOperationsPage >= operationsPages} onClick={() => setOperationsPage((page) => Math.min(operationsPages, page + 1))} className="btn-secondary px-3 py-1.5 disabled:opacity-40">›</button></div>
          </div>
        </section>

        <aside className="pms-panel p-5">
          <h2 className="text-lg font-extrabold text-slate-950">Avvisi e attività</h2>
          <div className="mt-3 divide-y divide-slate-100">
            {[["Prenotazioni da verificare", inboxToReviewCount, "bg-rose-100 text-rose-700"], ["Servizi senza autista", unassignedServices.length, "bg-amber-100 text-amber-700"], ["Revisioni agenzie", pendingAgencyReviewCount, "bg-indigo-100 text-indigo-700"], ["Bus attivi GPS", activeBusGps ?? 0, "bg-violet-100 text-violet-700"]].map(([label, value, tone]) => <div key={String(label)} className="flex items-center justify-between gap-3 py-3 text-sm"><span className="font-medium text-slate-700">{label}</span><span className={`min-w-8 rounded-lg px-2 py-1 text-center text-xs font-extrabold ${tone}`}>{value}</span></div>)}
          </div>
          <Link href="/dispatch" className="btn-secondary mt-5 w-full">Vedi tutte le attività</Link>
        </aside>
      </div>

      {/* ── Avvisi operativi ─────────────────────────────────────────────── */}
      {undeliveredReminderCount > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900">
          <p className="font-semibold mb-1">⏱ Reminder non consegnati oltre {Number.isFinite(reminderAlertMinutes) ? reminderAlertMinutes : 30} min: {undeliveredReminderCount}</p>
          <ul className="space-y-0.5 text-xs text-amber-800">
            {undeliveredReminderSample.slice(0, 5).map((service) => (
              <li key={service.id}>• {formatServiceSlot(service)} — {getCustomerFullName(service)}</li>
            ))}
          </ul>
        </div>
      )}
      {inboxToReviewCount > 0 && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-900">
          <p className="font-semibold">📧 Inbox da processare: {inboxToReviewCount}</p>
          <p className="mt-1 text-xs text-red-700">
            Apri <Link href="/inbox" className="underline font-semibold">Posta in arrivo</Link> per revisionare e confermare i draft.
          </p>
        </div>
      )}

      <OperationsSuggestions refreshIntervalMs={30_000} />

      {/* ── Sezione 48h + liste ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">

        {/* Lotti 48h */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100" style={{ background: "linear-gradient(90deg,#f0f9ff,#f5f3ff)" }}>
            <div>
              <h2 className="text-sm font-bold text-slate-800">📦 Lotti operativi 48h</h2>
              <p className="text-xs text-slate-500 mt-0.5">Bus linea vs altri servizi</p>
            </div>
            <Link href="/ops-summary" className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition">Export →</Link>
          </div>
          <div className="grid grid-cols-2 gap-px bg-slate-100">
            <div className="bg-white px-5 py-4">
              <p className="text-[10px] font-bold uppercase tracking-widest text-blue-500 mb-2">Arrivi</p>
              <div className="flex items-baseline gap-1"><span className="text-2xl font-extrabold text-slate-800">{nextArrivalsBus48h}</span><span className="text-xs text-slate-400">bus linea</span></div>
              <div className="flex items-baseline gap-1 mt-1"><span className="text-2xl font-extrabold text-slate-800">{nextArrivalsOther48h}</span><span className="text-xs text-slate-400">altri</span></div>
            </div>
            <div className="bg-white px-5 py-4">
              <p className="text-[10px] font-bold uppercase tracking-widest text-purple-500 mb-2">Partenze</p>
              <div className="flex items-baseline gap-1"><span className="text-2xl font-extrabold text-slate-800">{nextDeparturesBus48h}</span><span className="text-xs text-slate-400">bus linea</span></div>
              <div className="flex items-baseline gap-1 mt-1"><span className="text-2xl font-extrabold text-slate-800">{nextDeparturesOther48h}</span><span className="text-xs text-slate-400">altri</span></div>
            </div>
          </div>
          <div className="px-5 py-3 bg-slate-50 border-t border-slate-100 text-xs text-slate-400">
            Non assegnati: <span className="font-semibold text-slate-600">{unassignedServices.length}</span> · Coperti: <span className="font-semibold text-slate-600">{coveredBySuggestions}</span>
          </div>
        </div>

        {/* Prossimi arrivi */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100" style={{ background: "linear-gradient(90deg,#eff6ff,#f0f9ff)" }}>
            <div>
              <h2 className="text-sm font-bold text-slate-800">✈️ Prossimi arrivi 48h</h2>
              <p className="text-xs text-slate-500 mt-0.5">Servizi in ingresso a breve</p>
            </div>
            <Link href="/ops-summary" className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition">Tutti →</Link>
          </div>
          <div className="px-4 py-3 space-y-2 max-h-72 overflow-y-auto">
            {nextArrivals48h.length === 0 ? (
              <p className="text-xs text-slate-400 py-4 text-center">Nessun arrivo nelle prossime 48 ore</p>
            ) : nextArrivals48h.map((instance) => (
              <div key={instance.instanceId} className="flex items-start gap-3 rounded-xl border border-blue-100 bg-blue-50/60 px-3 py-2.5">
                <div className="mt-0.5 h-2 w-2 flex-shrink-0 rounded-full bg-blue-400 mt-1.5" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-800 truncate">{getCustomerFullName(instance.service)}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{formatDisplayUppercase(instance.service.meeting_point, "MEETING POINT N/D")}</p>
                </div>
                <span className="text-xs font-semibold text-blue-600 whitespace-nowrap">{formatServiceSlot({ arrival_date: instance.date, outbound_time: instance.time })}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Prossime partenze */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100" style={{ background: "linear-gradient(90deg,#faf5ff,#f5f3ff)" }}>
            <div>
              <h2 className="text-sm font-bold text-slate-800">🚀 Prossime partenze 48h</h2>
              <p className="text-xs text-slate-500 mt-0.5">Rientri e uscite imminenti</p>
            </div>
          </div>
          <div className="px-4 py-3 space-y-2 max-h-72 overflow-y-auto">
            {nextDepartures48h.length === 0 ? (
              <p className="text-xs text-slate-400 py-4 text-center">Nessuna partenza nelle prossime 48 ore</p>
            ) : nextDepartures48h.map((instance) => (
              <div key={instance.instanceId} className="flex items-start gap-3 rounded-xl border border-violet-100 bg-violet-50/60 px-3 py-2.5">
                <div className="mt-0.5 h-2 w-2 flex-shrink-0 rounded-full bg-violet-400 mt-1.5" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-800 truncate">{getCustomerFullName(instance.service)}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{formatDisplayUppercase(instance.service.meeting_point, "MEETING POINT N/D")}</p>
                </div>
                <span className="text-xs font-semibold text-violet-600 whitespace-nowrap">{formatServiceSlot({ arrival_date: instance.date, outbound_time: instance.time })}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

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
                    <div className="flex flex-wrap gap-2 pt-1">
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
