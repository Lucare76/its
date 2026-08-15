"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { supabase } from "@/lib/supabase/client";
import { createDedupedAsync, startTenantDataLifecycle } from "@/lib/supabase/tenant-data-lifecycle";
import type { Assignment, BusLotConfig, Hotel, InboundEmail, Membership, Service, StatusEvent, UserRole } from "@/lib/types";

type Options = {
  includeInboundEmails?: boolean;
};

export type TenantOperationalData = {
  services: Service[];
  assignments: Assignment[];
  busLotConfigs: BusLotConfig[];
  statusEvents: StatusEvent[];
  hotels: Hotel[];
  memberships: Membership[];
  inboundEmails: InboundEmail[];
};

export function useTenantOperationalData(options?: Options) {
  const includeInboundEmails = options?.includeInboundEmails === true;
  const [loading, setLoading] = useState(true);
  const [liveConnected, setLiveConnected] = useState(false);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [role, setRole] = useState<UserRole | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [data, setData] = useState<TenantOperationalData>({
      services: [],
      assignments: [],
      busLotConfigs: [],
      statusEvents: [],
    hotels: [],
    memberships: [],
    inboundEmails: []
  });

  const runRefresh = useCallback(async () => {
    const session = await getClientSessionContext();
    // Sprint Performance 12: the session context already carries the access
    // token it resolved (or found cached). Calling supabase.auth.getSession()
    // again here was a pure duplicate of work getClientSessionContext() just
    // did.
    const accessToken = session.accessToken;
    if (!supabase) {
      setTenantId(null);
      setUserId(null);
      setRole(null);
      setData({
        services: [],
        assignments: [],
        busLotConfigs: [],
        statusEvents: [],
        hotels: [],
        memberships: [],
        inboundEmails: []
      });
      setErrorMessage("Supabase non configurato o non disponibile.");
      setLoading(false);
      return false;
    }
    if (!session.userId) {
      setTenantId(null);
      setUserId(null);
      setRole(null);
      setData({
        services: [],
        assignments: [],
        busLotConfigs: [],
        statusEvents: [],
        hotels: [],
        memberships: [],
        inboundEmails: []
      });
      setErrorMessage("Sessione non valida o scaduta. Effettua di nuovo il login.");
      setLoading(false);
      return false;
    }
    if (!accessToken) {
      setTenantId(null);
      setUserId(session.userId);
      setRole(session.role);
      setData({
        services: [],
        assignments: [],
        busLotConfigs: [],
        statusEvents: [],
        hotels: [],
        memberships: [],
        inboundEmails: []
      });
      setErrorMessage("Sessione non valida o scaduta. Effettua di nuovo il login.");
      setLoading(false);
      return false;
    }
    if (!session.tenantId) {
      setTenantId(null);
      setUserId(session.userId);
      setRole(session.role);
      setData({
        services: [],
        assignments: [],
        busLotConfigs: [],
        statusEvents: [],
        hotels: [],
        memberships: [],
        inboundEmails: []
      });
      setErrorMessage("Tenant non configurato per questo utente. Completa onboarding.");
      setLoading(false);
      return false;
    }

    setTenantId(session.tenantId);
    setUserId(session.userId);
    setRole(session.role);

    const response = await fetch(`/api/ops/tenant-data?include_inbound_emails=${includeInboundEmails ? "true" : "false"}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const payload = (await response.json().catch(() => null)) as
      | {
          ok?: boolean;
          error?: string;
          services?: Service[];
          assignments?: Assignment[];
          bus_lot_configs?: BusLotConfig[];
          status_events?: StatusEvent[];
          hotels?: Hotel[];
          memberships?: Membership[];
          inbound_emails?: InboundEmail[];
        }
      | null;

    if (!response.ok || !payload?.ok) {
      setErrorMessage(payload?.error ?? "Errore caricamento dati tenant.");
      setLoading(false);
      return false;
    }

    setData({
      services: payload.services ?? [],
      assignments: payload.assignments ?? [],
      busLotConfigs: payload.bus_lot_configs ?? [],
      statusEvents: payload.status_events ?? [],
      hotels: payload.hotels ?? [],
      memberships: payload.memberships ?? [],
      inboundEmails: payload.inbound_emails ?? []
    });
    setErrorMessage(null);
    setLoading(false);
    return true;
  }, [includeInboundEmails]);

  // Concurrent triggers (fallback tick, realtime debounce, tab-regain refresh,
  // manual refresh() calls from consumers) share a single in-flight execution
  // instead of firing parallel duplicate requests.
  const refresh = useMemo(() => createDedupedAsync(runRefresh), [runRefresh]);

  // Bootstrap: exactly one refresh on mount. This effect intentionally does
  // NOT depend on tenantId — depending on it was the root cause of the
  // double-fetch bug (the effect restarted the instant tenantId resolved from
  // null, firing a second refresh before the first had even finished).
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Realtime subscription + fallback polling. This effect depends on the
  // resolved tenantId so a *genuine* tenant change later (not the initial
  // null -> resolved transition, which no longer touches this effect's own
  // refresh call) rebuilds the channel with the correct filter. It never
  // triggers a refresh on setup — only in response to realtime events,
  // fallback ticks, or tab-visibility regains — so it adds zero extra
  // fetches at mount time.
  useEffect(() => {
    if (!tenantId || !supabase) return;
    const client = supabase;

    const stopLifecycle = startTenantDataLifecycle({
      refresh,
      subscribeRealtime: (onEvent, onStatus) => {
        const channel = client
          .channel(`tenant-live-${tenantId}-${includeInboundEmails ? "inbound" : "base"}`)
          .on("postgres_changes", { event: "*", schema: "public", table: "services", filter: `tenant_id=eq.${tenantId}` }, onEvent)
          .on("postgres_changes", { event: "*", schema: "public", table: "assignments", filter: `tenant_id=eq.${tenantId}` }, onEvent)
          .on("postgres_changes", { event: "*", schema: "public", table: "status_events", filter: `tenant_id=eq.${tenantId}` }, onEvent)
          .on("postgres_changes", { event: "*", schema: "public", table: "hotels", filter: `tenant_id=eq.${tenantId}` }, onEvent)
          .on("postgres_changes", { event: "*", schema: "public", table: "memberships", filter: `tenant_id=eq.${tenantId}` }, onEvent);

        if (includeInboundEmails) {
          channel.on(
            "postgres_changes",
            { event: "*", schema: "public", table: "inbound_emails", filter: `tenant_id=eq.${tenantId}` },
            onEvent
          );
        }

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
  }, [tenantId, includeInboundEmails, refresh]);

  return {
    loading,
    liveConnected,
    tenantId,
    userId,
    role,
    errorMessage,
    data,
    refresh
  };
}
