import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildVehicleBindingPreviewReference,
  validateVehicleBindingPreviewForApply,
  type VehicleBindingPreviewPayload,
} from "@/lib/server/piano-vehicle-binding-preview";

function preview(overrides: Partial<VehicleBindingPreviewPayload> = {}): VehicleBindingPreviewPayload {
  return {
    ok: true,
    date: "2026-05-07",
    preview_reference: "ref",
    config: { largeGroupPaxThreshold: 21, minBufferMinutes: 20 },
    current_binding: [],
    proposed_binding: [],
    changes: [],
    large_trips: [],
    large_vehicle_usage: [],
    standard_vehicle_bindings: [],
    conflicts: [],
    summary: {
      conflicts_before: 2,
      conflicts_after: 0,
      overbooking_after: 0,
      large_vehicle_shared_ok: 1,
      large_vehicle_shared_conflicts: 0,
      standard_vehicle_conflicts: 0,
      driver_vehicle_eligibility_blockers: 0,
      driver_availability_blockers: 0,
      eligibility_blockers: 0,
      changes_needed: 0,
      services_involved: 0,
    },
    warnings: [],
    info: [],
    audit: { available_drivers: [], available_vehicles: [], eligibility_matrix: [] },
    snapshot: { group_ids: [], service_ids: [] },
    ...overrides,
  };
}

describe("vehicle binding apply guard", () => {
  it("keeps the apply route scoped to trip_groups and server-side recalculation", () => {
    const source = readFileSync(join(process.cwd(), "app/api/ops/piano-giorno/apply-vehicle-binding/route.ts"), "utf8");

    expect(source).toContain("buildVehicleBindingPreview");
    expect(source).toContain("preview_reference");
    expect(source).toContain('.from("trip_groups")');
    expect(source).not.toContain('.from("services").update');
    expect(source).not.toContain('.from("services")\n        .update');
    expect(source).not.toContain('.from("assignments").update');
    expect(source).not.toContain('.from("assignments")\n        .update');
    expect(source).not.toContain("services.status");
    expect(source).not.toContain("auto-assign");
  });

  it("records the controlled operator decision with the hybrid binding action", () => {
    const source = readFileSync(join(process.cwd(), "app/api/ops/piano-giorno/apply-vehicle-binding/route.ts"), "utf8");

    expect(source).toContain("HYBRID_BINDING_DECISION_TYPE");
    expect(source).toContain("HYBRID_BINDING_ACTION");
    expect(source).toContain("insertOperatorDecision");
    expect(source).toContain("duplicate");
  });

  it("uses trip_group updated_at as an apply-time stale guard", () => {
    const source = readFileSync(join(process.cwd(), "app/api/ops/piano-giorno/apply-vehicle-binding/route.ts"), "utf8");

    expect(source).toContain("current_group_updated_at");
    expect(source).toContain('.eq("updated_at", change.current_group_updated_at)');
    expect(source).toContain("Preview stale");
  });

  it("keeps manual trip mutations guarded by eligibility, capacity and vehicle timeline validation", () => {
    const source = readFileSync(join(process.cwd(), "app/api/ops/piano-giorno/trips/route.ts"), "utf8");

    for (const action of ["create_trip", "update_trip", "move_services"]) {
      expect(source).toContain(`body.action === "${action}"`);
    }
    expect(source).toContain("validateDriverVehicleEligibilityPayload");
    expect(source).toContain("validateVehicleTimelinePayload");
    expect(source).toContain("Overbooking bloccante");
    expect(source).toContain("canShareLargeVehicle");
    expect(source).toContain("Mezzo capiente condiviso non disponibile con buffer sufficiente.");
    expect(source).toContain("assegnato a un altro autista per questa giornata.");
  });

  it("allows a clean hybrid preview with large vehicle sharing on timeline", () => {
    const result = validateVehicleBindingPreviewForApply(preview({
      large_vehicle_usage: [{
        vehicle_id: "v-25",
        vehicle_label: "Large",
        driver_key: "driver-a",
        driver_name: "Driver A",
        group_id: "g-1",
        start_time: "09:30",
        end_time: "10:00",
        pax: 21,
        buffer_from_previous: null,
        status: "large_vehicle_dedicated_ok",
      }, {
        vehicle_id: "v-25",
        vehicle_label: "Large",
        driver_key: "driver-b",
        driver_name: "Driver B",
        group_id: "g-2",
        start_time: "12:15",
        end_time: "12:45",
        pax: 21,
        buffer_from_previous: 135,
        status: "large_vehicle_shared_timeline_ok",
      }],
    }));

    expect(result.ok).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("blocks stale-unsafe previews with remaining overbooking", () => {
    const result = validateVehicleBindingPreviewForApply(preview({
      summary: {
        ...preview().summary,
        overbooking_after: 1,
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.blockers.join(" ")).toContain("overbooking");
  });

  it("blocks a driver vehicle eligibility blocker", () => {
    const result = validateVehicleBindingPreviewForApply(preview({
      summary: {
        ...preview().summary,
        eligibility_blockers: 1,
        driver_vehicle_eligibility_blockers: 1,
      },
      conflicts: [{
        type: "driver_vehicle_eligibility_blocker",
        severity: "blocker",
        group_id: "g-1",
        driver_name: "Driver",
        vehicle_label: "Large",
        message: "Autista non abilitato a guidare questo mezzo.",
      }],
    }));

    expect(result.ok).toBe(false);
    expect(result.blockers.join(" ")).toContain("abilitati");
  });

  it("blocks standard vehicle sharing between drivers", () => {
    const result = validateVehicleBindingPreviewForApply(preview({
      summary: {
        ...preview().summary,
        conflicts_after: 1,
        standard_vehicle_conflicts: 1,
      },
      conflicts: [{
        type: "standard_vehicle_same_day_conflict",
        severity: "blocker",
        group_id: "g-1",
        driver_name: "Driver A",
        vehicle_label: "Standard",
        message: "Mezzo standard gia vincolato a un altro autista nella giornata.",
      }],
    }));

    expect(result.ok).toBe(false);
    expect(result.blockers.join(" ")).toContain("standard");
  });

  it("uses a stable server-side preview reference for stale detection", () => {
    const left = buildVehicleBindingPreviewReference({ b: 2, a: { d: 4, c: 3 } });
    const right = buildVehicleBindingPreviewReference({ a: { c: 3, d: 4 }, b: 2 });

    expect(left).toBe(right);
    expect(left).toHaveLength(64);
  });
});
