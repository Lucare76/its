import { describe, expect, it } from "vitest";
import { insuranceSuspensionStatus } from "@/lib/vehicle-compliance";

describe("insurance suspension", () => {
  it("tracks planned dates and early reactivation without treating the policy as suspended afterwards", () => {
    expect(insuranceSuspensionStatus("2026-10-31", "2026-11-01", "2026-11-20")).toBe("scheduled");
    expect(insuranceSuspensionStatus("2026-11-05", "2026-11-01", "2026-11-20")).toBe("suspended");
    expect(insuranceSuspensionStatus("2026-11-10", "2026-11-01", "2026-11-20", "2026-11-10")).toBe("reactivated");
    expect(insuranceSuspensionStatus("2026-11-21", "2026-11-01", "2026-11-20")).toBe("ended");
  });
});
