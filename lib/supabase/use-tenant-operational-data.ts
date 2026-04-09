"use client";

import { useCallback, useEffect, useState } from "react";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { supabase } from "@/lib/supabase/client";
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

  const refresh = useCallback(async () => {
    const session = await getClientSessionContext();
    const authSession = supabase ? await supabase.auth.getSession() : null;
    const accessToken = authSession?.data.session?.access_token ?? null;
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

  useEffect(() => {
    let active = true;
    let refreshTimeout: number | null = null;
    let fallbackInterval: number | null = null;
    let activeChannel: ReturnType<NonNullable<typeof supabase>["channel"]> | null = null;

    const init = async () => {
      const ok = await refresh();
      if (!active || !ok || !supabase || !tenantId) return;

      const scheduleRefresh = () => {
        if (!active) return;
        if (refreshTimeout) window.clearTimeout(refreshTimeout);
        refreshTimeout = window.setTimeout(() => {
          void refresh();
        }, 400);
      };

      const channel = supabase
        .channel(`tenant-live-${tenantId}-${includeInboundEmails ? "inbound" : "base"}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "services", filter: `tenant_id=eq.${tenantId}` }, scheduleRefresh)
        .on("postgres_changes", { event: "*", schema: "public", table: "assignments", filter: `tenant_id=eq.${tenantId}` }, scheduleRefresh)
        .on("postgres_changes", { event: "*", schema: "public", table: "status_events", filter: `tenant_id=eq.${tenantId}` }, scheduleRefresh)
        .on("postgres_changes", { event: "*", schema: "public", table: "hotels", filter: `tenant_id=eq.${tenantId}` }, scheduleRefresh)
        .on("postgres_changes", { event: "*", schema: "public", table: "memberships", filter: `tenant_id=eq.${tenantId}` }, scheduleRefresh);

      if (includeInboundEmails) {
        channel.on(
          "postgres_changes",
          { event: "*", schema: "public", table: "inbound_emails", filter: `tenant_id=eq.${tenantId}` },
          scheduleRefresh
        );
      }

      channel.subscribe((status) => {
        if (!active) return;
        setLiveConnected(status === "SUBSCRIBED");
      });
      activeChannel = channel;

      fallbackInterval = window.setInterval(() => {
        void refresh();
      }, 20000);
    };

    void init();
    return () => {
      active = false;
      setLiveConnected(false);
      if (refreshTimeout) window.clearTimeout(refreshTimeout);
      if (fallbackInterval) window.clearInterval(fallbackInterval);
      if (activeChannel && supabase) {
        void supabase.removeChannel(activeChannel);
      }
    };
  }, [includeInboundEmails, refresh, tenantId]);

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
