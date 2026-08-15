"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { supabase } from "@/lib/supabase/client";
import { createDedupedAsync, startTenantDataLifecycle } from "@/lib/supabase/tenant-data-lifecycle";
import { buildTenantDataRequest, type TenantOperationalDataOptions } from "@/lib/supabase/tenant-data-request";
import type { Assignment, BusLotConfig, Hotel, InboundEmail, Membership, Service, StatusEvent, UserRole } from "@/lib/types";

export type { TenantOperationalDataOptions } from "@/lib/supabase/tenant-data-request";

export type TenantOperationalData = {
  services: Service[];
  assignments: Assignment[];
  busLotConfigs: BusLotConfig[];
  statusEvents: StatusEvent[];
  hotels: Hotel[];
  memberships: Membership[];
  inboundEmails: InboundEmail[];
};

const EMPTY_DATA: TenantOperationalData = {
  services: [],
  assignments: [],
  busLotConfigs: [],
  statusEvents: [],
  hotels: [],
  memberships: [],
  inboundEmails: []
};

export function useTenantOperationalData(options?: TenantOperationalDataOptions) {
  // Sprint Performance 13: `options` is typically a fresh object literal every
  // render (call-sites write `useTenantOperationalData({ serviceScope: {...} })`
  // inline). buildTenantDataRequest() is pure/cheap so it's safe to call every
  // render — what matters is that everything below keys off the DERIVED
  // primitive `requestKey`/`queryString`, not the `options` object identity,
  // so an options literal that resolves to the *same* scope never triggers a
  // spurious refetch (that was the Sprint 10 double-fetch bug, in a new guise).
  const { searchParams, requestKey } = buildTenantDataRequest(options);
  const queryString = searchParams.toString();
  const subscribesInboundEmails = options?.includeInboundEmails === true || options?.datasets?.inboundEmails === true;

  const [loading, setLoading] = useState(true);
  const [liveConnected, setLiveConnected] = useState(false);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [role, setRole] = useState<UserRole | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [data, setData] = useState<TenantOperationalData>(EMPTY_DATA);

  // Sprint Performance 13 — FASE 26/27: when the scope changes rapidly (e.g.
  // user flips Arrivals from Aug 15 to Aug 16 before the first request lands),
  // the OLD in-flight request must never be allowed to overwrite state with
  // stale-scope data once it finally resolves. This ref always holds the
  // requestKey of the scope the UI *currently* wants; each in-flight
  // runRefresh call compares against it before touching state and silently
  // discards itself if it's been superseded. Synced via effect (not written
  // during render) — by the time any awaited fetch actually resolves (real
  // network latency), this render's effects have long since flushed, so the
  // ref is always current before it's ever read.
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
      setUserId(null);
      setRole(null);
      setData(EMPTY_DATA);
      setErrorMessage("Supabase non configurato o non disponibile.");
      setLoading(false);
      return false;
    }
    if (!session.userId) {
      setTenantId(null);
      setUserId(null);
      setRole(null);
      setData(EMPTY_DATA);
      setErrorMessage("Sessione non valida o scaduta. Effettua di nuovo il login.");
      setLoading(false);
      return false;
    }
    if (!accessToken) {
      setTenantId(null);
      setUserId(session.userId);
      setRole(session.role);
      setData(EMPTY_DATA);
      setErrorMessage("Sessione non valida o scaduta. Effettua di nuovo il login.");
      setLoading(false);
      return false;
    }
    if (!session.tenantId) {
      setTenantId(null);
      setUserId(session.userId);
      setRole(session.role);
      setData(EMPTY_DATA);
      setErrorMessage("Tenant non configurato per questo utente. Completa onboarding.");
      setLoading(false);
      return false;
    }

    setTenantId(session.tenantId);
    setUserId(session.userId);
    setRole(session.role);

    const response = await fetch(`/api/ops/tenant-data?${queryString}`, {
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

    if (isStale()) return false;

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
  }, [requestKey, queryString]);

  // Concurrent triggers with the SAME scope (fallback tick, realtime debounce,
  // tab-regain refresh, manual refresh() calls) share a single in-flight
  // execution. Scope changes recreate runRefresh (new requestKey/queryString),
  // which recreates this deduped wrapper too — so a new scope always gets its
  // own fresh promise instead of being folded into an old scope's in-flight
  // request (see FASE 26/27: same-key dedupe only, never cross-scope).
  // runRefresh closes over latestRequestKeyRef but only reads it inside its
  // async body (after await), never synchronously during this render;
  // createDedupedAsync only stores the function reference here, it doesn't
  // invoke it — so this is not an actual render-time ref read.
  // eslint-disable-next-line react-hooks/refs
  const refresh = useMemo(() => createDedupedAsync(runRefresh), [runRefresh]);

  // Bootstrap + scope-change reload: fires once on mount, and again whenever
  // `refresh` changes identity — which happens exactly when requestKey changes
  // (new date/range/ids/datasets). This intentionally does NOT depend on
  // tenantId directly (that was the Sprint 10 double-fetch root cause).
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Realtime subscription + fallback polling. Depends on tenantId (rebuilds
  // the channel on a genuine tenant change) and requestKey (rebuilds it when
  // the scope changes, so the channel name stays unique per scope and the
  // inbound_emails subscription reflects whether this scope actually wants
  // that dataset). It never triggers a refresh on setup — only in response to
  // realtime events, fallback ticks, or tab-visibility regains — and each such
  // trigger calls the CURRENT scope's `refresh`, so it can never fall back to
  // the legacy/full-history default (FASE 25).
  useEffect(() => {
    if (!tenantId || !supabase) return;
    const client = supabase;

    const stopLifecycle = startTenantDataLifecycle({
      refresh,
      subscribeRealtime: (onEvent, onStatus) => {
        const channel = client
          .channel(`tenant-live-${tenantId}-${encodeURIComponent(requestKey)}`)
          .on("postgres_changes", { event: "*", schema: "public", table: "services", filter: `tenant_id=eq.${tenantId}` }, onEvent)
          .on("postgres_changes", { event: "*", schema: "public", table: "assignments", filter: `tenant_id=eq.${tenantId}` }, onEvent)
          .on("postgres_changes", { event: "*", schema: "public", table: "status_events", filter: `tenant_id=eq.${tenantId}` }, onEvent)
          .on("postgres_changes", { event: "*", schema: "public", table: "hotels", filter: `tenant_id=eq.${tenantId}` }, onEvent)
          .on("postgres_changes", { event: "*", schema: "public", table: "memberships", filter: `tenant_id=eq.${tenantId}` }, onEvent);

        if (subscribesInboundEmails) {
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
  }, [tenantId, requestKey, subscribesInboundEmails, refresh]);

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
