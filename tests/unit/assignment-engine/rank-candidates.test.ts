import { describe, expect, it } from "vitest";
import { rankCandidatesForService } from "@/lib/server/assignment-engine/rank-candidates";

describe("rankCandidatesForService", () => {
  it("Caso 3: includes a driver whose shift ends exactly at the service start time", () => {
    const candidates = rankCandidatesForService({
      service: { operational_time: "18:00", pax: 2 },
      drivers: [{ id: "d1", name: "Antonio", available: true, available_from: "08:00", available_to: "18:00" }],
      vehicles: [{ id: "v1", label: "Ducato", capacity: 4, available: true }],
      assignmentsCountByDriverId: new Map(),
    });

    expect(candidates.map((candidate) => candidate.driver_id)).toContain("d1");
  });

  it("Caso 4: excludes a driver whose shift ended before the service start time", () => {
    const candidates = rankCandidatesForService({
      service: { operational_time: "18:01", pax: 2 },
      drivers: [{ id: "d1", name: "Antonio", available: true, available_from: "08:00", available_to: "18:00" }],
      vehicles: [{ id: "v1", label: "Ducato", capacity: 4, available: true }],
      assignmentsCountByDriverId: new Map(),
    });

    expect(candidates).toHaveLength(0);
  });

  it("Caso 5: excludes a vehicle without enough capacity, never returning it as a candidate", () => {
    const candidates = rankCandidatesForService({
      service: { operational_time: "10:00", pax: 8 },
      drivers: [{ id: "d1", name: "Antonio", available: true, available_from: "08:00", available_to: "20:00" }],
      vehicles: [{ id: "v1", label: "Utilitaria", capacity: 4, available: true }],
      assignmentsCountByDriverId: new Map(),
    });

    expect(candidates).toHaveLength(0);
  });

  it("prefers a driver with fewer existing assignments (load balancing)", () => {
    const candidates = rankCandidatesForService({
      service: { operational_time: "10:00", pax: 2 },
      drivers: [
        { id: "busy", name: "Antonio", available: true, available_from: "08:00", available_to: "20:00" },
        { id: "free", name: "Giuseppe", available: true, available_from: "08:00", available_to: "20:00" },
      ],
      vehicles: [
        { id: "v1", label: "Ducato 1", capacity: 4, available: true },
        { id: "v2", label: "Ducato 2", capacity: 4, available: true },
      ],
      assignmentsCountByDriverId: new Map([["busy", 5]]),
    });

    expect(candidates[0].driver_id).toBe("free");
  });

  it("returns no candidates without an operational time", () => {
    const candidates = rankCandidatesForService({
      service: { operational_time: null, pax: 2 },
      drivers: [{ id: "d1", name: "Antonio", available: true }],
      vehicles: [{ id: "v1", label: "Ducato", capacity: 4, available: true }],
      assignmentsCountByDriverId: new Map(),
    });

    expect(candidates).toHaveLength(0);
  });
});
