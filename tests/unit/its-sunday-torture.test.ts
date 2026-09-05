import { describe, expect, it } from "vitest";
import { evaluateItsSundayTorture, type ItsSundayTortureSnapshot } from "@/lib/server/its-sunday-torture";

const TENANT = "tenant-its";
const DATE = "2026-09-13";

function service(id: string, pax: number, direction: "arrival" | "departure" = "arrival") {
  return { id, tenant_id: TENANT, date: DATE, pax, direction, status: "new", is_test_data: true };
}

function baseSnapshot(overrides: Partial<ItsSundayTortureSnapshot> = {}): ItsSundayTortureSnapshot {
  return {
    tenantId: TENANT,
    date: DATE,
    expectedMinServices: 2,
    services: [service("s1", 30, "arrival"), service("s2", 24, "departure")],
    assignments: [],
    busAllocations: [],
    busUnits: [{ id: "bus1", tenant_id: TENANT, label: "Bus 1", capacity: 54 }],
    ...overrides,
  };
}

describe("evaluateItsSundayTorture", () => {
  it("PASS: giornata valida senza violazioni dure", () => {
    const report = evaluateItsSundayTorture(baseSnapshot());
    expect(report.passed).toBe(true);
    expect(report.hardFailures).toEqual([]);
    expect(report.stats.services).toBe(2);
    expect(report.stats.pax).toBe(54);
  });

  it("FAIL: rifiuta uno stress test troppo piccolo", () => {
    const report = evaluateItsSundayTorture(baseSnapshot({ expectedMinServices: 400 }));
    expect(report.passed).toBe(false);
    expect(report.hardFailures.some((issue) => issue.code === "INSUFFICIENT_LOAD")).toBe(true);
  });

  it("FAIL: intercetta tenant/date/test scope leak sui servizi", () => {
    const report = evaluateItsSundayTorture(baseSnapshot({
      services: [service("s1", 30), { ...service("s2", 24), tenant_id: "other" }],
    }));
    expect(report.hardFailures.some((issue) => issue.code === "SERVICE_SCOPE_LEAK")).toBe(true);
  });

  it("FAIL: intercetta pax servizio non valido", () => {
    const report = evaluateItsSundayTorture(baseSnapshot({ services: [service("s1", 0), service("s2", 24)] }));
    expect(report.hardFailures.some((issue) => issue.code === "INVALID_SERVICE_PAX")).toBe(true);
  });

  it("FAIL: intercetta assignment orfano e tenant leak", () => {
    const report = evaluateItsSundayTorture(baseSnapshot({
      assignments: [{ id: "a1", tenant_id: "other", service_id: "missing", driver_user_id: "d1" }],
    }));
    expect(report.hardFailures.some((issue) => issue.code === "ASSIGNMENT_TENANT_LEAK")).toBe(true);
    expect(report.hardFailures.some((issue) => issue.code === "ORPHAN_ASSIGNMENT")).toBe(true);
  });

  it("FAIL: un servizio non può avere più record assignment", () => {
    const report = evaluateItsSundayTorture(baseSnapshot({
      assignments: [
        { id: "a1", tenant_id: TENANT, service_id: "s1", driver_user_id: "d1" },
        { id: "a2", tenant_id: TENANT, service_id: "s1", driver_user_id: "d2" },
      ],
    }));
    expect(report.hardFailures.some((issue) => issue.code === "MULTIPLE_ASSIGNMENTS_PER_SERVICE")).toBe(true);
  });

  it("FAIL: intercetta allocazione bus orfana o bus inesistente", () => {
    const report = evaluateItsSundayTorture(baseSnapshot({
      busAllocations: [
        { tenant_id: TENANT, service_id: "missing", bus_unit_id: "bus1", pax_assigned: 3 },
        { tenant_id: TENANT, service_id: "s1", bus_unit_id: "missing-bus", pax_assigned: 3 },
      ],
    }));
    expect(report.hardFailures.some((issue) => issue.code === "ORPHAN_BUS_ALLOCATION")).toBe(true);
    expect(report.hardFailures.some((issue) => issue.code === "UNKNOWN_BUS_UNIT")).toBe(true);
  });

  it("FAIL: pax allocati sul servizio non possono superare i pax del servizio", () => {
    const report = evaluateItsSundayTorture(baseSnapshot({
      busAllocations: [{ tenant_id: TENANT, service_id: "s1", bus_unit_id: "bus1", pax_assigned: 31 }],
    }));
    expect(report.hardFailures.some((issue) => issue.code === "SERVICE_OVERALLOCATED_PAX")).toBe(true);
  });

  it("WARNING: allocazione parziale non è automaticamente una violazione dura", () => {
    const report = evaluateItsSundayTorture(baseSnapshot({
      busAllocations: [{ tenant_id: TENANT, service_id: "s1", bus_unit_id: "bus1", pax_assigned: 20 }],
    }));
    expect(report.passed).toBe(true);
    expect(report.warnings.some((issue) => issue.code === "SERVICE_PARTIALLY_ALLOCATED_PAX")).toBe(true);
  });

  it("FAIL: capienza bus è verificata per direzione, coerente con migration 0274", () => {
    const report = evaluateItsSundayTorture(baseSnapshot({
      services: [service("s1", 30, "arrival"), service("s2", 30, "arrival")],
      busAllocations: [
        { tenant_id: TENANT, service_id: "s1", bus_unit_id: "bus1", pax_assigned: 30 },
        { tenant_id: TENANT, service_id: "s2", bus_unit_id: "bus1", pax_assigned: 30 },
      ],
    }));
    expect(report.hardFailures.some((issue) => issue.code === "BUS_OVER_CAPACITY")).toBe(true);
  });

  it("PASS: 54 arrival + 54 departure sullo stesso bus sono due pool separati", () => {
    const report = evaluateItsSundayTorture(baseSnapshot({
      services: [service("s1", 54, "arrival"), service("s2", 54, "departure")],
      busAllocations: [
        { tenant_id: TENANT, service_id: "s1", bus_unit_id: "bus1", pax_assigned: 54 },
        { tenant_id: TENANT, service_id: "s2", bus_unit_id: "bus1", pax_assigned: 54 },
      ],
    }));
    expect(report.passed).toBe(true);
    expect(report.hardFailures.some((issue) => issue.code === "BUS_OVER_CAPACITY")).toBe(false);
  });
});
