"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ExportServicesButton } from "@/components/export-services-button";
import { OperationsSuggestions } from "@/components/operations-suggestions";
import { EmptyState, SidePanel } from "@/components/ui";
import { needsInboxReview } from "@/lib/inbox-review";
import { buildOperationalInstances } from "@/lib/operational-service-instances";
import { isInboxPdfReviewOpen, isInboxPdfTestNoise } from "@/lib/pdf/parser";
import { formatDisplayUppercase, formatServiceSlot, getCustomerFullName, getOutboundTime } from "@/lib/service-display";
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
  const [pendingAgencyReviewCount, setPendingAgencyReviewCount] = useState(0);
  const [activeBusGps, setActiveBusGps] = useState<number | null>(null);

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

  const todayIso = new Date(alertNowMs).toISOString().slice(0, 10);
  const todayInstances = buildOperationalInstances(data.services).filter((instance) => instance.date === todayIso);
  const next48hIso = new Date(alertNowMs + 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const todayServiceIds = new Set(todayInstances.map((instance) => instance.serviceId));
  const todayServices = data.services.filter((service) => todayServiceIds.has(service.id));
  const todayArrivals = todayInstances.filter((instance) => instance.direction === "arrival").length;
  const todayDepartures = todayInstances.filter((instance) => instance.direction === "departure").length;
  const todayPdfNeedsAttention = todayServices.filter((service) => getServicePdfOperationalMeta(service, data.inboundEmails).reviewRecommended);
  const inboxPdfNeedsReview = data.inboundEmails.filter((email) => {
    const parsedJson = (email.parsed_json ?? null) as Record<string, unknown> | null;
    return !isInboxPdfTestNoise({ subject: email.subject, parsedJson }) && isInboxPdfReviewOpen(parsedJson);
  });
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
  const totalPax = todayServices
    .filter((service) => (service.booking_service_kind as string | null) !== "navetta" && service.booking_service_kind !== "shuttle_hotel" && service.vessel?.toLowerCase().trim() !== "navetta")
    .reduce((sum, service) => sum + service.pax, 0);
  const sortedDates = [...new Set(todayServices.map((service) => service.date))].sort();
  const defaultDateFrom = sortedDates[0] ?? todayIso;
  const defaultDateTo = sortedDates[sortedDates.length - 1] ?? defaultDateFrom;

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
    <section className="page-section">

      {/* ── Hero strip ─────────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-3xl px-4 py-5 text-white sm:px-6 sm:py-6 lg:px-8 lg:py-7" style={{ background: "linear-gradient(135deg,#1e3a8a 0%,#4338ca 50%,#7c3aed 100%)" }}>
        <div className="absolute -top-16 -right-16 h-56 w-56 rounded-full bg-white/5" />
        <div className="absolute -bottom-10 -left-10 h-40 w-40 rounded-full bg-white/5" />
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-white/60 capitalize">{todayLabel}</p>
            <h1 className="mt-1 text-2xl font-extrabold tracking-tight">Cruscotto operativo</h1>
            <div className="mt-2 flex items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${liveConnected ? "bg-emerald-500/20 text-emerald-200" : "bg-white/10 text-white/50"}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${liveConnected ? "bg-emerald-400 animate-pulse" : "bg-white/30"}`} />
                {liveConnected ? "In tempo reale" : "Non in linea"}
              </span>
            </div>
          </div>
          <div className="flex w-full flex-wrap gap-3 lg:w-auto lg:justify-end">
            <ExportServicesButton defaultDateFrom={defaultDateFrom} defaultDateTo={defaultDateTo} className="w-full sm:w-auto" />
            <button type="button" onClick={() => setIsSuggestionsOpen(true)}
              className="w-full rounded-xl border border-white/25 bg-white/10 px-4 py-2 text-sm font-semibold text-white backdrop-blur transition hover:bg-white/20 sm:w-auto">
              Supporto assegnazioni
            </button>
            <Link href="/services/new"
              className="w-full rounded-xl bg-white px-4 py-2 text-center text-sm font-bold text-indigo-700 shadow transition hover:bg-white/90 sm:w-auto">
              + Nuova prenotazione
            </Link>
            <Link href="/dispatch"
              className="w-full rounded-xl border border-white/25 bg-white/10 px-4 py-2 text-center text-sm font-semibold text-white backdrop-blur transition hover:bg-white/20 sm:w-auto">
              Assegnazioni
            </Link>
          </div>
        </div>
      </div>

      {/* ── Alert banner agenzie ─────────────────────────────────────────── */}
      {pendingAgencyReviewCount > 0 && (
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
      {pendingAccessRequestCount > 0 && (
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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-6">
        {[
          { icon: "⚡", label: "Operativo oggi", value: todayInstances.length, color: "#4338ca", bg: "#eef2ff", href: "/arrivals" },
          { icon: "✈️", label: "Arrivi oggi",     value: todayArrivals,         color: "#0369a1", bg: "#e0f2fe", href: "/arrivals" },
          { icon: "🚀", label: "Partenze oggi",   value: todayDepartures,       color: "#7c3aed", bg: "#f5f3ff", href: "/departures" },
          { icon: "👥", label: "Passeggeri",      value: totalPax,              color: "#0f766e", bg: "#f0fdfa", href: "/arrivals" },
          { icon: "🚌", label: "Bus attivi GPS",   value: activeBusGps ?? "—",   color: activeBusGps !== null ? "#b45309" : "#94a3b8", bg: "#fffbeb", href: "/mappa-live" },
          { icon: "⚠️", label: "Non assegnati",   value: pending,               color: pending > 0 ? "#dc2626" : "#64748b", bg: pending > 0 ? "#fef2f2" : "#f8fafc", href: "/dispatch" },
          { icon: "📄", label: "PDF Inbox da revisionare", value: inboxPdfNeedsReview.length, color: inboxPdfNeedsReview.length > 0 ? "#d97706" : "#64748b", bg: inboxPdfNeedsReview.length > 0 ? "#fffbeb" : "#f8fafc", href: "/inbox" },
          { icon: "📧", label: "Inbox",           value: inboxToReview.length,  color: inboxToReview.length > 0 ? "#dc2626" : "#64748b", bg: inboxToReview.length > 0 ? "#fef2f2" : "#f8fafc", href: "/inbox" },
        ].map(({ icon, label, value, color, bg, href }) => {
          const inner = (
            <div className={`flex flex-col gap-3 rounded-2xl border border-slate-100 p-4 shadow-sm transition hover:shadow-md ${href ? "cursor-pointer hover:border-slate-300" : ""}`} style={{ backgroundColor: bg }}>
              <div className="flex items-center justify-between">
                <span className="text-2xl">{icon}</span>
                <span className="text-3xl font-extrabold tracking-tight" style={{ color }}>{value}</span>
              </div>
              <p className="text-xs font-semibold text-slate-500 leading-tight">{label}</p>
            </div>
          );
          return href ? <Link key={label} href={href} className="block">{inner}</Link> : <div key={label}>{inner}</div>;
        })}
      </div>

      {/* ── Avvisi operativi ─────────────────────────────────────────────── */}
      {undeliveredReminderAlerts.length > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900">
          <p className="font-semibold mb-1">⏱ Reminder non consegnati oltre {Number.isFinite(reminderAlertMinutes) ? reminderAlertMinutes : 30} min: {undeliveredReminderAlerts.length}</p>
          <ul className="space-y-0.5 text-xs text-amber-800">
            {undeliveredReminderAlerts.slice(0, 5).map((service) => (
              <li key={service.id}>• {formatServiceSlot(service)} — {getCustomerFullName(service)}</li>
            ))}
          </ul>
        </div>
      )}
      {inboxToReview.length > 0 && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-900">
          <p className="font-semibold">📧 Inbox da processare: {inboxToReview.length}</p>
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
