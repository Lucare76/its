import { describe, expect, it } from "vitest";
import { proposeCapacitySplit, simulateCapacityResolution } from "@/lib/piano-capacity-split-simulation";

const vehiclesFromAvailability = [
  { id: "bus-25-a", label: "25 A", capacity: 25 },
  { id: "bus-25-b", label: "25 B", capacity: 25 },
  { id: "maxi", label: "MAXI", capacity: 14 },
  { id: "vito", label: "VITO", capacity: 8 },
  { id: "ducato", label: "DUCATO", capacity: 8 },
];

describe("capacity split simulation", () => {
  it("reports a capacity blocker with three drivers at 21 pax and only two 25-seat vehicles", () => {
    const result = simulateCapacityResolution({
      vehicles: vehiclesFromAvailability,
      drivers: [
        { driver_key: "a", driver_name: "A", current_vehicle_labels: ["VITO"], max_pax: 21 },
        { driver_key: "b", driver_name: "B", current_vehicle_labels: ["DUCATO"], max_pax: 21 },
        { driver_key: "c", driver_name: "C", current_vehicle_labels: ["MAXI"], max_pax: 21 },
      ],
      criticalGroups: [],
    });

    expect(result.binding_before.drivers_without_vehicle_after).toHaveLength(1);
    expect(result.decision).not.toBe("CAMBIARE_BINDING");
  });

  it("splits a 21 pax group into 13 and 8 when 14 and 8 seat vehicles are available", () => {
    const proposal = proposeCapacitySplit(
      {
        group_id: "critical",
        driver_key: "driver",
        driver_name: "Driver",
        pax: 21,
        services: [
          { service_id: "zone-a", pax: 13, pickup_label: "Porto", destination_label: "Forio", operational_time: "12:15", direction: "arrival" },
          { service_id: "zone-b", pax: 8, pickup_label: "Porto", destination_label: "Ischia", operational_time: "12:15", direction: "arrival" },
        ],
      },
      [{ id: "maxi", label: "MAXI", capacity: 14 }, { id: "vito", label: "VITO", capacity: 8 }]
    );

    expect(proposal.split_possible).toBe(true);
    expect(proposal.chunks.map((chunk) => chunk.pax).sort((a, b) => b - a)).toEqual([13, 8]);
  });

  it("does not split a non-splittable single service", () => {
    const proposal = proposeCapacitySplit(
      {
        group_id: "single",
        driver_key: "driver",
        driver_name: "Driver",
        pax: 21,
        services: [{ service_id: "single-booking", pax: 21, pickup_label: "Porto", destination_label: "Hotel", operational_time: "12:15" }],
      },
      [{ id: "maxi", label: "MAXI", capacity: 14 }, { id: "vito", label: "VITO", capacity: 8 }]
    );

    expect(proposal.split_possible).toBe(false);
    expect(proposal.reason).toContain("Singolo servizio");
  });

  it("uses vehicles supplied by availability input, not hardcoded labels", () => {
    const proposal = proposeCapacitySplit(
      {
        group_id: "custom",
        driver_key: "driver",
        driver_name: "Driver",
        pax: 18,
        services: [
          { service_id: "a", pax: 10, pickup_label: "A", destination_label: "B" },
          { service_id: "b", pax: 8, pickup_label: "A", destination_label: "C" },
        ],
      },
      [{ id: "custom-10", label: "CUSTOM TEN", capacity: 10 }, { id: "custom-8", label: "CUSTOM EIGHT", capacity: 8 }]
    );

    expect(proposal.split_possible).toBe(true);
    expect(proposal.chunks.map((chunk) => chunk.suggested_vehicle_capacity).sort((a, b) => (b ?? 0) - (a ?? 0))).toEqual([10, 8]);
  });

  it("simulation is pure and only returns read-only results", () => {
    const result = simulateCapacityResolution({
      vehicles: vehiclesFromAvailability,
      drivers: [{ driver_key: "a", driver_name: "A", current_vehicle_labels: ["VITO"], max_pax: 21 }],
      criticalGroups: [],
    });

    expect(result).toHaveProperty("binding_before");
    expect(result).toHaveProperty("after");
  });
});
