import { describe, expect, it } from "vitest";
import { buildHybridVehicleBinding } from "@/lib/piano-hybrid-vehicle-binding";

const drivers = [
  { driver_key: "driver:a", driver_name: "A", max_vehicle_capacity: null },
  { driver_key: "driver:b", driver_name: "B", max_vehicle_capacity: null },
  { driver_key: "driver:c", driver_name: "C", max_vehicle_capacity: null },
];

const vehicles = [
  { id: "large-1", label: "Large 1", capacity: 25 },
  { id: "large-2", label: "Large 2", capacity: 25 },
  { id: "standard-1", label: "Standard 1", capacity: 8 },
  { id: "standard-2", label: "Standard 2", capacity: 8 },
];

describe("hybrid vehicle binding", () => {
  it("covers three non-overlapping 21 pax trips with two large vehicles", () => {
    const result = buildHybridVehicleBinding({
      drivers,
      vehicles,
      trips: [
        { group_id: "g1", driver_key: "driver:a", start_time: "09:00", pax: 21 },
        { group_id: "g2", driver_key: "driver:b", start_time: "11:00", pax: 21 },
        { group_id: "g3", driver_key: "driver:c", start_time: "13:00", pax: 21 },
      ],
    });

    expect(result.summary.conflicts_after).toBe(0);
    expect(result.summary.overbooking_after).toBe(0);
    expect(result.large_vehicle_usage).toHaveLength(3);
    expect(new Set(result.large_vehicle_usage.map((usage) => usage.vehicle_id)).size).toBeLessThanOrEqual(2);
  });

  it("does not cover three overlapping 21 pax trips with two large vehicles", () => {
    const result = buildHybridVehicleBinding({
      drivers,
      vehicles: vehicles.slice(0, 2),
      trips: [
        { group_id: "g1", driver_key: "driver:a", start_time: "09:00", pax: 21 },
        { group_id: "g2", driver_key: "driver:b", start_time: "09:10", pax: 21 },
        { group_id: "g3", driver_key: "driver:c", start_time: "09:20", pax: 21 },
      ],
    });

    expect(result.conflicts.some((conflict) => conflict.type === "large_vehicle_shared_timeline_conflict")).toBe(true);
  });

  it("blocks duplicated standard vehicles between different drivers", () => {
    const result = buildHybridVehicleBinding({
      drivers,
      vehicles: [{ id: "standard-1", label: "Standard 1", capacity: 8 }],
      trips: [
        { group_id: "g1", driver_key: "driver:a", start_time: "09:00", pax: 2 },
        { group_id: "g2", driver_key: "driver:b", start_time: "11:00", pax: 2 },
      ],
    });

    expect(result.conflicts[0]?.type).toBe("standard_vehicle_same_day_conflict");
  });

  it("marks large vehicle sharing as ok instead of blocker", () => {
    const result = buildHybridVehicleBinding({
      drivers: drivers.slice(0, 2),
      vehicles: [{ id: "large-1", label: "Large 1", capacity: 25 }],
      trips: [
        { group_id: "g1", driver_key: "driver:a", start_time: "09:00", pax: 21 },
        { group_id: "g2", driver_key: "driver:b", start_time: "11:00", pax: 21 },
      ],
    });

    expect(result.summary.conflicts_after).toBe(0);
    expect(result.summary.large_vehicle_shared_ok).toBe(1);
  });

  it("does not treat same-driver fixed standard vehicle reuse as a vehicle binding blocker", () => {
    const result = buildHybridVehicleBinding({
      drivers: [{ driver_key: "driver:a", driver_name: "A", max_vehicle_capacity: null }],
      vehicles: [{ id: "standard-1", label: "Standard 1", capacity: 8 }],
      trips: [
        { group_id: "g1", driver_key: "driver:a", start_time: "09:00", end_time: "09:30", pax: 2, current_vehicle_label: "Standard 1" },
        { group_id: "g2", driver_key: "driver:a", start_time: "09:10", end_time: "09:40", pax: 2, current_vehicle_label: "Standard 1" },
      ],
    });

    expect(result.summary.conflicts_after).toBe(0);
    expect(result.trips.map((trip) => trip.proposed_vehicle_label)).toEqual(["Standard 1", "Standard 1"]);
  });

  it("blocks a large vehicle when the driver is not eligible", () => {
    const result = buildHybridVehicleBinding({
      drivers: [{ driver_key: "driver:a", driver_name: "A", max_vehicle_capacity: 8 }],
      vehicles: [{ id: "large-1", label: "Large 1", capacity: 25 }],
      trips: [{ group_id: "g1", driver_key: "driver:a", start_time: "09:00", pax: 21 }],
    });

    expect(result.conflicts[0]?.type).toBe("driver_vehicle_eligibility_blocker");
  });

  it("blocks vehicles with insufficient capacity", () => {
    const result = buildHybridVehicleBinding({
      drivers: drivers.slice(0, 1),
      vehicles: [{ id: "small", label: "Small", capacity: 8 }],
      trips: [{ group_id: "g1", driver_key: "driver:a", start_time: "09:00", pax: 21 }],
    });

    expect(result.conflicts[0]?.type).toBe("vehicle_capacity_insufficient");
  });

  it("uses only supplied driver and vehicle data", () => {
    const result = buildHybridVehicleBinding({
      drivers: [{ driver_key: "custom", driver_name: "Custom", max_vehicle_capacity: null }],
      vehicles: [{ id: "custom-large", label: "Custom Large", capacity: 30 }],
      trips: [{ group_id: "custom-trip", driver_key: "custom", start_time: "09:00", pax: 21 }],
    });

    expect(result.trips[0]?.proposed_vehicle_label).toBe("Custom Large");
  });
});
