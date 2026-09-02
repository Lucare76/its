import { describe, expect, it } from "vitest";
import { buildOperationalInstances } from "@/lib/operational-service-instances";
import type { Service } from "@/lib/types";

function service(overrides: Partial<Service>): Service {
  return {
    id: "outbound",
    tenant_id: "tenant",
    date: "2026-08-23",
    time: "12:03",
    direction: "arrival",
    vessel: "ITALO 9907 / ITALO 9950",
    pax: 2,
    hotel_id: "hotel",
    customer_name: "TEST STAZIONE",
    phone: "333",
    notes: "",
    status: "new",
    arrival_date: "2026-08-23",
    arrival_time: "12:03",
    departure_date: "2026-08-30",
    departure_time: "14:20",
    ...overrides,
  } as Service;
}

describe("buildOperationalInstances", () => {
  it("non raddoppia le due tratte di una prenotazione A/R collegata", () => {
    const outbound = service({ id: "outbound", linked_service_id: "return", direction: "arrival" });
    const returning = service({ id: "return", linked_service_id: "outbound", direction: "departure", date: "2026-08-30", time: "14:20" });
    const instances = buildOperationalInstances([outbound, returning]);
    expect(instances.map((item) => item.instanceId)).toEqual(["outbound:arrival", "return:departure"]);
  });

  it("mantiene arrivo e partenza per una prenotazione legacy in un solo record", () => {
    const instances = buildOperationalInstances([service({ linked_service_id: null })]);
    expect(instances.map((item) => item.instanceId)).toEqual(["outbound:arrival", "outbound:departure"]);
  });

  describe("Obiettivo C/G: draft di gruppo visibile in Arrivi/Partenze", () => {
    it("service is_draft=true CON booking_group_id -> visibile (prenotazione reale di gruppo in attesa di operativizzazione)", () => {
      const groupDraft = service({ id: "svc-giacomoni", is_draft: true, status: "needs_review", booking_group_id: "bg-giacomoni", direction: "arrival", linked_service_id: null });
      const instances = buildOperationalInstances([groupDraft]);
      expect(instances.some((i) => i.serviceId === "svc-giacomoni")).toBe(true);
    });

    it("service is_draft=true SENZA booking_group_id -> resta nascosto (comportamento invariato)", () => {
      const genericDraft = service({ id: "svc-generic-draft", is_draft: true, status: "needs_review", booking_group_id: null, linked_service_id: null });
      const instances = buildOperationalInstances([genericDraft]);
      expect(instances.some((i) => i.serviceId === "svc-generic-draft")).toBe(false);
    });

    it("service di gruppo CANCELLATO resta nascosto anche con booking_group_id valorizzato", () => {
      const cancelled = service({ id: "svc-cancelled", is_draft: true, status: "cancelled", booking_group_id: "bg-giacomoni", linked_service_id: null });
      const instances = buildOperationalInstances([cancelled]);
      expect(instances.some((i) => i.serviceId === "svc-cancelled")).toBe(false);
    });
  });
});
