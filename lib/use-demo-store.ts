"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { demoTenantId, initialDemoState } from "@/lib/demo-data";
import type { Assignment, DemoState, Hotel, InboundEmail, Membership, Service, ServiceStatus, StatusEvent } from "@/lib/types";

const STORAGE_KEY = "ischia-transfer-demo-state-v1";

function loadState(): DemoState {
  if (typeof window === "undefined") return initialDemoState;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return initialDemoState;
  try {
    const parsed = JSON.parse(raw) as DemoState;
    return parsed;
  } catch {
    return initialDemoState;
  }
}

export function useDemoStore() {
  const [state, setState] = useState<DemoState>(initialDemoState);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(loadState());
    setLoading(false);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || loading) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state, loading]);

  const assignedByService = useMemo(() => {
    return new Map(state.assignments.map((assignment) => [assignment.service_id, assignment]));
  }, [state.assignments]);

  const setServiceStatus = (serviceId: string, status: ServiceStatus, byUserId: string) => {
    setState((prev) => {
      const services = prev.services.map((service) => (service.id === serviceId ? { ...service, status } : service));
      const event: StatusEvent = {
        id: crypto.randomUUID(),
        service_id: serviceId,
        status,
        at: new Date().toISOString(),
        by_user_id: byUserId,
        tenant_id: demoTenantId
      };
      return { ...prev, services, statusEvents: [event, ...prev.statusEvents] };
    });
  };

  const assignDriver = (serviceId: string, driverUserId: string, vehicleLabel: string) => {
    setState((prev) => {
      const existing = prev.assignments.find((item) => item.service_id === serviceId);
      const nextAssignment: Assignment = existing
        ? { ...existing, driver_user_id: driverUserId, vehicle_label: vehicleLabel }
        : {
            id: crypto.randomUUID(),
            service_id: serviceId,
            driver_user_id: driverUserId,
            vehicle_label: vehicleLabel,
            tenant_id: demoTenantId,
            created_at: new Date().toISOString()
          };
      const assignments = existing
        ? prev.assignments.map((item) => (item.service_id === serviceId ? nextAssignment : item))
        : [nextAssignment, ...prev.assignments];
      const services: Service[] = prev.services.map((service) =>
        service.id === serviceId && service.status === "new" ? { ...service, status: "assigned" as const } : service
      );
      return { ...prev, assignments, services };
    });
  };

  const upsertAssignment = (serviceId: string, vehicleLabel: string, driverUserId: string | null) => {
    setState((prev) => {
      const service = prev.services.find((item) => item.id === serviceId);
      if (!service) return prev;

      const existing = prev.assignments.find((item) => item.service_id === serviceId);
      const nextAssignment: Assignment = existing
        ? {
            ...existing,
            vehicle_label: vehicleLabel,
            driver_user_id: existing.driver_user_id ?? driverUserId
          }
        : {
            id: crypto.randomUUID(),
            service_id: serviceId,
            driver_user_id: driverUserId,
            vehicle_label: vehicleLabel,
            tenant_id: service.tenant_id,
            created_at: new Date().toISOString()
          };

      const assignments = existing
        ? prev.assignments.map((item) => (item.service_id === serviceId ? nextAssignment : item))
        : [nextAssignment, ...prev.assignments];

      return { ...prev, assignments };
    });
  };

  const markServiceAssigned = (serviceId: string, byUserId: string) => {
    setState((prev) => {
      const service = prev.services.find((item) => item.id === serviceId);
      if (!service) return prev;

      const nextServices = prev.services.map((item) =>
        item.id === serviceId && item.status !== "assigned" ? { ...item, status: "assigned" as const } : item
      );

      const hasAssignedEvent = prev.statusEvents.some(
        (event) => event.service_id === serviceId && event.status === "assigned" && event.by_user_id === byUserId
      );

      if (hasAssignedEvent) {
        return { ...prev, services: nextServices };
      }

      const event: StatusEvent = {
        id: crypto.randomUUID(),
        service_id: serviceId,
        status: "assigned",
        at: new Date().toISOString(),
        by_user_id: byUserId,
        tenant_id: service.tenant_id
      };

      return { ...prev, services: nextServices, statusEvents: [event, ...prev.statusEvents] };
    });
  };

  const replaceTenantOperationalData = useCallback((
    tenantId: string,
    payload: {
      services: Service[];
      assignments: Assignment[];
      statusEvents: StatusEvent[];
      hotels?: Hotel[];
      memberships?: Membership[];
    }
  ) => {
    setState((prev) => {
      const nextServices = [
        ...prev.services.filter((item) => item.tenant_id !== tenantId),
        ...payload.services
      ];
      const nextAssignments = [
        ...prev.assignments.filter((item) => item.tenant_id !== tenantId),
        ...payload.assignments
      ];
      const nextStatusEvents = [
        ...prev.statusEvents.filter((item) => item.tenant_id !== tenantId),
        ...payload.statusEvents
      ];
      const nextHotels = payload.hotels
        ? [...prev.hotels.filter((item) => item.tenant_id !== tenantId), ...payload.hotels]
        : prev.hotels;
      const nextMemberships = payload.memberships
        ? [...prev.memberships.filter((item) => item.tenant_id !== tenantId), ...payload.memberships]
        : prev.memberships;

      return {
        ...prev,
        services: nextServices,
        assignments: nextAssignments,
        statusEvents: nextStatusEvents,
        hotels: nextHotels,
        memberships: nextMemberships
      };
    });
  }, []);

  const createService = (input: Omit<Service, "id" | "tenant_id">) => {
    setState((prev) => {
      const next: Service = {
        id: crypto.randomUUID(),
        tenant_id: demoTenantId,
        ...input
      };
      return { ...prev, services: [next, ...prev.services] };
    });
  };

  const addInboundEmail = (email: Omit<InboundEmail, "id" | "created_at">) => {
    setState((prev) => {
      const next: InboundEmail = {
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        ...email
      };
      return { ...prev, inboundEmails: [next, ...prev.inboundEmails] };
    });
  };

  const updateServiceSchedule = (serviceId: string, date: string, time: string) => {
    setState((prev) => {
      const services = prev.services.map((service) =>
        service.id === serviceId
          ? {
              ...service,
              date,
              time
            }
          : service
      );
      return { ...prev, services };
    });
  };

  return {
    state,
    loading,
    assignedByService,
    setServiceStatus,
    assignDriver,
    upsertAssignment,
    markServiceAssigned,
    replaceTenantOperationalData,
    createService,
    addInboundEmail,
    updateServiceSchedule
  };
}
