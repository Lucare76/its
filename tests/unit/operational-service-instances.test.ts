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
});
