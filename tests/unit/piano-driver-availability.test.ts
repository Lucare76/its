import { describe, expect, it } from "vitest";
import { canDriverCoverInterval } from "@/lib/piano-driver-availability";
import { buildHybridVehicleBinding } from "@/lib/piano-hybrid-vehicle-binding";
import { planAutoAssignPreview } from "@/lib/piano-auto-assign-planner";

describe("driver interval availability", () => {
  it("blocks a driver whose availability starts after the trip", () => {
    const result = canDriverCoverInterval(
      { available: true, available_from: "16:00", available_to: "23:00" },
      { start_time: "14:50", end_time: "15:20" },
      { missingAvailability: "blocker" }
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("fascia oraria");
  });

  it("allows a driver available for the whole trip interval", () => {
    const result = canDriverCoverInterval(
      { available: true, available_from: "14:00", available_to: "18:00" },
      { start_time: "14:50", end_time: "15:20" },
      { missingAvailability: "blocker" }
    );

    expect(result.allowed).toBe(true);
  });

  it("blocks a driver when a pause overlaps the trip", () => {
    const result = canDriverCoverInterval(
      {
        available: true,
        available_from: "14:00",
        available_to: "18:00",
        blocks: [{ from: "14:45", to: "15:15", reason: "Pausa" }],
      },
      { start_time: "14:50", end_time: "15:20" },
      { missingAvailability: "blocker" }
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("Pausa");
  });

  it("hybrid planner does not propose a vehicle for a driver outside availability", () => {
    const result = buildHybridVehicleBinding({
      drivers: [{
        driver_key: "driver:leo",
        driver_name: "LEO",
        max_vehicle_capacity: null,
        availability: { available: true, available_from: "16:00", available_to: "23:00" },
      }],
      vehicles: [{ id: "van", label: "Van", capacity: 8 }],
      trips: [{ group_id: "cam-335", driver_key: "driver:leo", start_time: "14:50", end_time: "15:20", pax: 1 }],
    });

    expect(result.trips[0]?.proposed_vehicle_label).toBeNull();
    expect(result.conflicts[0]?.type).toBe("driver_availability_blocker");
  });

  it("auto-assign preview does not propose a driver outside availability", () => {
    const result = planAutoAssignPreview({
      availability_confirmed: true,
      drivers: [{ id: "leo", name: "LEO", available: true, available_from: "16:00", available_to: "23:00" }],
      vehicles: [{ id: "van", label: "Van", capacity: 8, available: true }],
      locked_assignments: [],
      services: [{
        service_id: "cam-335",
        customer_name: "CAM 335",
        macro_category: "PARTENZA",
        operational_time: "14:50",
        pickup_label: "CAM",
        pickup_zone: "Ischia Porto",
        destination_label: "Porto",
        destination_zone: "Ischia Porto",
        pax: 1,
        assignable: true,
        needs_review: false,
        is_locked: false,
        already_assigned: false,
        confidence_score: 100,
      }],
    });

    expect(result.proposed_groups).toHaveLength(0);
    expect(result.conflicts[0]?.conflict_type).toBe("driver_availability");
  });
});
