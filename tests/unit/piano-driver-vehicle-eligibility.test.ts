import { describe, expect, it } from "vitest";
import { canDriverUseVehicle } from "@/lib/piano-driver-vehicle-eligibility";
import { proposeVehicleDailyRealignment } from "@/lib/piano-vehicle-binding-proposal";
import { planAutoAssignPreview } from "@/lib/piano-auto-assign-planner";

const baseService = {
  service_id: "service-1",
  customer_name: "Customer",
  macro_category: "ARRIVO" as const,
  operational_time: "09:00",
  pickup_label: "Porto",
  pickup_zone: "Ischia",
  destination_label: "Hotel",
  destination_zone: "Ischia",
  pax: 20,
  assignable: true,
  needs_review: false,
  is_locked: false,
  already_assigned: false,
  confidence_score: 95,
  warnings: [] as string[],
  reasons: [] as string[],
  port_arrival: null,
  port_departure: null,
};

describe("driver vehicle eligibility", () => {
  it("allows an unlimited driver to use 8, 14 and 25 seat vehicles", () => {
    for (const capacity of [8, 14, 25]) {
      expect(canDriverUseVehicle({ max_vehicle_capacity: null }, { capacity }).allowed).toBe(true);
    }
  });

  it("allows max 8 only on 8 seat vehicles", () => {
    expect(canDriverUseVehicle({ max_vehicle_capacity: 8 }, { capacity: 8 }).allowed).toBe(true);
    expect(canDriverUseVehicle({ max_vehicle_capacity: 8 }, { capacity: 14 }).allowed).toBe(false);
    expect(canDriverUseVehicle({ max_vehicle_capacity: 8 }, { capacity: 25 }).severity).toBe("blocker");
  });

  it("allows max 16 on 14 seat vehicles but not 25", () => {
    expect(canDriverUseVehicle({ max_vehicle_capacity: 16 }, { capacity: 14 }).allowed).toBe(true);
    expect(canDriverUseVehicle({ max_vehicle_capacity: 16 }, { capacity: 25 }).allowed).toBe(false);
  });

  it("warns for unknown vehicle capacity by default", () => {
    const result = canDriverUseVehicle({ max_vehicle_capacity: 8 }, { capacity: null });
    expect(result.allowed).toBe(true);
    expect(result.severity).toBe("warning");
  });

  it("planner does not propose a vehicle the driver cannot use", () => {
    const result = planAutoAssignPreview({
      services: [baseService],
      availability_confirmed: true,
      drivers: [{ id: "driver-1", name: "Driver", max_vehicle_capacity: 8 }],
      vehicles: [{ id: "bus-25", label: "Bus 25", capacity: 25 }],
    });

    expect(result.proposed_groups).toHaveLength(0);
    expect(result.conflicts[0]?.conflict_type).toBe("driver_vehicle_eligibility");
    expect(result.conflicts[0]?.reason).toContain("abilitazione autista");
  });

  it("binding proposal skips a shared high-capacity vehicle when driver is not eligible", () => {
    const result = proposeVehicleDailyRealignment({
      drivers: [{ driver_key: "driver-1", driver_name: "Driver", current_vehicle_labels: [], max_pax: 20, max_vehicle_capacity: 8 }],
      vehicles: [{ id: "bus-25", label: "Bus 25", capacity: 25 }],
    });

    expect(result.proposal[0]?.to_vehicle_label).toBeNull();
    expect(result.drivers_without_vehicle_after).toEqual(["Driver"]);
  });

  it("uses only supplied mock driver and vehicle data", () => {
    expect(canDriverUseVehicle({ max_vehicle_capacity: 3 }, { label: "Mock only", capacity: 4 }).allowed).toBe(false);
  });
});
