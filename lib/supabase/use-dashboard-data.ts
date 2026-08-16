"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildDashboardDataRequest } from "@/lib/dashboard-data-request";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { supabase } from "@/lib/supabase/client";
import { createDedupedAsync, startTenantDataLifecycle } from "@/lib/supabase/tenant-data-lifecycle";
import type { DashboardAssignment, DashboardHotel, DashboardReminderSampleService } from "@/lib/server/dashboard-data";
import type { Service } from "@/lib/types";

// Sprint Performance 14B. Dashboard-specific replacement for
// useTenantOperationalData()'s legacy (full-tenant-history) mode. Reuses the
// exact same dedupe/realtime/fallback-polling primitives
// (createDedupedAsync, startTenantDataLifecycle) so refresh semantics stay
// proven and consistent with the rest of the app — only the fetch target and
// payload shape are dashboard-specific.

export type DashboardOperationalData = {
  windowServices: Service[];
  hotels: DashboardHotel[];
  assignments: DashboardAssignment[];
  todayPdfNeedsAttentionCount: number;
  inboxPdfNeedsReviewCount: number;
  inboxToReviewCount: number;
  undeliveredReminderCount: number;
  undeliveredReminderSample: DashboardReminderSampleService[];
};

const EMPTY_DATA: DashboardOperationalData = {
  windowServices: [],
  hotels: [],
  assignments: [],
  todayPdfNeedsAttentionCount: 0,
  inboxPdfNeedsReviewCount: 0,
  inboxToReviewCount: 0,
  undeliveredReminderCount: 0,
  undeliveredReminderSample: []
};

export type UseDashboardDataOptions = {
  /** dayOffset-aware "today" (YYYY-MM-DD). */
  today: string;
  /** Fixed "now + 48h" (YYYY-MM-DD), independent of dayOffset. */
  next48h: string;
};

export function useDashboardData(options: UseDashboardDataOptions) {
  const { searchParams, requestKey } = buildDashboardDataRequest(options);
  const queryString = searchParams.toString();

  const [loading, setLoading] = useState(true);
  const [liveConnected, setLiveConnected] = useState(false);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [data, setData] = useState<DashboardOperationalData>(EMPTY_DATA);

  // Same stale-response guard as use-tenant-operational-data.ts (Sprint
  // Performance 13 FASE 26/27): an in-flight request for an old today/next48h
  // window must never overwrite state once a newer window has been requested.
  const latestRequestKeyRef = useRef(requestKey);
  useEffect(() => {
    latestRequestKeyRef.current = requestKey;
  }, [requestKey]);

  const runRefresh = useCallback(async () => {
    const thisRequestKey = requestKey;
    const isStale = () => latestRequestKeyRef.current !== thisRequestKey;

    const session = await getClientSessionContext();
    if (isStale()) return false;

    const accessToken = session.accessToken;
    if (!supabase) {
      setTenantId(null);
      setData(EMPTY_DATA);
      setErrorMessage("Supabase non configurato o non disponibile.");
      setLoading(false);
      return false;
    }
    if (!session.userId || !accessToken) {
      setTenantId(null);
      setData(EMPTY_DATA);
      setErrorMessage("Sessione non valida o scaduta. Effettua di nuovo il login.");
      setLoading(false);
      return false;
    }
    if (!session.tenantId) {
      setTenantId(null);
      setData(EMPTY_DATA);
      setErrorMessage("Tenant non configurato per questo utente. Completa onboarding.");
      setLoading(false);
      return false;
    }

    setTenantId(session.tenantId);

    const response = await fetch(`/api/ops/dashboard-data?${queryString}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const payload = (await response.json().catch(() => null)) as
      | {
          ok?: boolean;
          error?: string;
          window_services?: Service[];
          hotels?: DashboardHotel[];
          assignments?: DashboardAssignment[];
          today_pdf_needs_attention_count?: number;
          inbox_pdf_needs_review_count?: number;
          inbox_to_review_count?: number;
          undelivered_reminder_count?: number;
          undelivered_reminder_sample?: DashboardReminderSampleService[];
        }
      | null;

    if (isStale()) return false;

    if (!response.ok || !payload?.ok) {
      setErrorMessage(payload?.error ?? "Errore caricamento dati dashboard.");
      setLoading(false);
      return false;
    }

    setData({
      windowServices: payload.window_services ?? [],
      hotels: payload.hotels ?? [],
      assignments: payload.assignments ?? [],
      todayPdfNeedsAttentionCount: payload.today_pdf_needs_attention_count ?? 0,
      inboxPdfNeedsReviewCount: payload.inbox_pdf_needs_review_count ?? 0,
      inboxToReviewCount: payload.inbox_to_review_count ?? 0,
      undeliveredReminderCount: payload.undelivered_reminder_count ?? 0,
      undeliveredReminderSample: payload.undelivered_reminder_sample ?? []
    });
    setErrorMessage(null);
    setLoading(false);
    return true;
  }, [requestKey, queryString]);

  // eslint-disable-next-line react-hooks/refs
  const refresh = useMemo(() => createDedupedAsync(runRefresh), [runRefresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Realtime subscription + fallback polling, scoped to the tables the
  // Dashboard's KPIs actually depend on (services, assignments, hotels,
  // inbound_emails) — status_events and memberships are dropped: the legacy
  // hook subscribed to them too, but dashboard/page.tsx never read either
  // dataset, so no freshness is lost by not subscribing.
  useEffect(() => {
    if (!tenantId || !supabase) return;
    const client = supabase;

    const stopLifecycle = startTenantDataLifecycle({
      refresh,
      subscribeRealtime: (onEvent, onStatus) => {
        const channel = client
          .channel(`dashboard-data-${tenantId}-${encodeURIComponent(requestKey)}`)
          .on("postgres_changes", { event: "*", schema: "public", table: "services", filter: `tenant_id=eq.${tenantId}` }, onEvent)
          .on("postgres_changes", { event: "*", schema: "public", table: "assignments", filter: `tenant_id=eq.${tenantId}` }, onEvent)
          .on("postgres_changes", { event: "*", schema: "public", table: "hotels", filter: `tenant_id=eq.${tenantId}` }, onEvent)
          .on("postgres_changes", { event: "*", schema: "public", table: "inbound_emails", filter: `tenant_id=eq.${tenantId}` }, onEvent);
        channel.subscribe(onStatus);
        return () => {
          void client.removeChannel(channel);
        };
      },
      getVisibilityState: () => document.visibilityState,
      addVisibilityListener: (handler) => {
        document.addEventListener("visibilitychange", handler);
        return () => document.removeEventListener("visibilitychange", handler);
      },
      setTimeoutFn: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeoutFn: (handle) => window.clearTimeout(handle as number),
      setIntervalFn: (fn, ms) => window.setInterval(fn, ms),
      clearIntervalFn: (handle) => window.clearInterval(handle as number),
      onLiveConnectedChange: setLiveConnected
    });

    return () => {
      stopLifecycle();
    };
  }, [tenantId, requestKey, refresh]);

  return { loading, liveConnected, tenantId, errorMessage, data, refresh };
}
