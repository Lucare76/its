import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildGprPeterDriverSwapPreviewReference,
  validateGprPeterDriverSwapPreviewForApply,
  type GprPeterDriverSwapPreview,
} from "@/lib/server/piano-driver-swap-preview";

function preview(overrides: Partial<GprPeterDriverSwapPreview> = {}): GprPeterDriverSwapPreview {
  return {
    ok: true,
    date: "2026-05-07",
    trip_group_id: "71443ef7-f506-464d-b11d-f9eae8c2858a",
    preview_reference: "ref",
    already_applied: false,
    current: {
      driver_profile_id: "riccardo-profile",
      driver_user_id: null,
      driver_name: "RICCARDO",
      vehicle_label: "25 BIANCO",
      vehicle_capacity: 25,
      updated_at: "2026-05-20T10:00:00Z",
    },
    proposed: {
      driver_profile_id: "mario-profile",
      driver_user_id: null,
      driver_name: "MARIO",
      max_vehicle_capacity: null,
      vehicle_id: "vehicle-25-bianco",
      vehicle_label: "25 BIANCO",
      vehicle_capacity: 25,
    },
    trip: {
      start_time: "15:00",
      end_time: "15:30",
      pax: 21,
      service_ids: ["svc-gpr"],
      customer_names: ["GPR PETER"],
    },
    checks: {
      mario_available: true,
      mario_can_drive_25: true,
      vehicle_available: true,
      vehicle_capacity_ok: true,
      mario_overlap_count: 0,
      vehicle_overlap_count: 0,
      overbooking: 0,
      driver_vehicle_eligibility_blocker: false,
      conflicts_before: 1,
      conflicts_after: 0,
    },
    warnings: ["Buffer prima 0 min.", "Buffer dopo 10 min."],
    blockers: [],
    before_json: {},
    after_json: {},
    payload_json: {},
    ...overrides,
  };
}

describe("GPR PETER driver swap apply guard", () => {
  it("keeps the apply route scoped away from services and real auto-assign", () => {
    const source = readFileSync(join(process.cwd(), "app/api/ops/piano-giorno/apply-driver-swap/route.ts"), "utf8");

    expect(source).toContain("buildGprPeterDriverSwapPreview");
    expect(source).toContain("preview_reference");
    expect(source).toContain('.from("trip_groups")');
    expect(source).toContain('.from("assignments")');
    expect(source).not.toContain('.from("services").update');
    expect(source).not.toContain('.from("services")\n      .update');
    expect(source).not.toContain("services.status");
    expect(source).not.toContain("auto-assign");
  });

  it("blocks stale or unsafe previews but keeps 0/10 minute buffer as warning only", () => {
    expect(validateGprPeterDriverSwapPreviewForApply(preview()).ok).toBe(true);

    const blocked = validateGprPeterDriverSwapPreviewForApply(preview({
      checks: { ...preview().checks, mario_overlap_count: 1, conflicts_after: 1 },
    }));

    expect(blocked.ok).toBe(false);
    expect(blocked.blockers.join(" ")).toContain("overlap");
  });

  it("uses a stable server-side reference", () => {
    const left = buildGprPeterDriverSwapPreviewReference({ b: 2, a: { d: 4, c: 3 } });
    const right = buildGprPeterDriverSwapPreviewReference({ a: { c: 3, d: 4 }, b: 2 });

    expect(left).toBe(right);
    expect(left).toHaveLength(64);
  });
});
