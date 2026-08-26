import { describe, expect, it } from "vitest";
import { suggestOperationalFix } from "@/lib/server/assignment-engine/suggest-fix";
import type { PlanItemDraft } from "@/lib/server/assignment-engine/classify-plan";

function movableItem(overrides: Partial<PlanItemDraft>): PlanItemDraft {
  return {
    service_id: "svc-moved",
    status: "auto_safe",
    proposed_driver_id: "driver-busy",
    proposed_driver_name: "Antonio",
    proposed_vehicle_id: null,
    proposed_vehicle_label: "Ducato",
    mission_group_key: null,
    score: 90,
    confidence: 95,
    reason: { summary: [], details: {} },
    alternatives: [],
    warnings: [],
    suggested_fix: null,
    locked: false,
    ...overrides,
  };
}

describe("suggestOperationalFix", () => {
  const drivers = [
    { id: "driver-busy", name: "Antonio", available: true, available_from: "08:00", available_to: "20:00" },
    { id: "driver-free", name: "Giuseppe", available: true, available_from: "08:00", available_to: "20:00" },
  ];
  const vehicles = [{ id: "v1", label: "Ducato", capacity: 4, available: true }];

  it("suggests moving a nearby service to free the blocked driver", () => {
    const planItems = [movableItem({})];
    const serviceInfoById = new Map([
      ["svc-blocked", { service_id: "svc-blocked", operational_time: "14:20", pax: 2 }],
      ["svc-moved", { service_id: "svc-moved", operational_time: "14:00", pax: 2 }],
    ]);

    const fix = suggestOperationalFix({
      blockedService: { service_id: "svc-blocked", operational_time: "14:20", pax: 2 },
      planItems,
      serviceInfoById,
      drivers,
      vehicles,
    });

    expect(fix).not.toBeNull();
    expect(fix?.actions[0].from_driver_id).toBe("driver-busy");
    expect(fix?.actions[0].to_driver_id).toBe("driver-free");
  });

  it("never proposes moving a manual or locked item", () => {
    const planItems = [movableItem({ status: "manual" }), movableItem({ service_id: "svc-locked", status: "locked", locked: true })];
    const serviceInfoById = new Map([
      ["svc-blocked", { service_id: "svc-blocked", operational_time: "14:20", pax: 2 }],
      ["svc-moved", { service_id: "svc-moved", operational_time: "14:00", pax: 2 }],
      ["svc-locked", { service_id: "svc-locked", operational_time: "14:00", pax: 2 }],
    ]);

    const fix = suggestOperationalFix({
      blockedService: { service_id: "svc-blocked", operational_time: "14:20", pax: 2 },
      planItems,
      serviceInfoById,
      drivers,
      vehicles,
    });

    expect(fix).toBeNull();
  });

  it("returns null when no alternative driver is available for the moved service", () => {
    const planItems = [movableItem({})];
    const serviceInfoById = new Map([
      ["svc-blocked", { service_id: "svc-blocked", operational_time: "14:20", pax: 2 }],
      ["svc-moved", { service_id: "svc-moved", operational_time: "14:00", pax: 2 }],
    ]);

    const fix = suggestOperationalFix({
      blockedService: { service_id: "svc-blocked", operational_time: "14:20", pax: 2 },
      planItems,
      serviceInfoById,
      drivers: [drivers[0]],
      vehicles,
    });

    expect(fix).toBeNull();
  });
});
