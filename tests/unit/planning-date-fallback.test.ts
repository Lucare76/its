import { describe, expect, it } from "vitest";
import {
  computePlanningRangeScope,
  resolveNearestDateResult,
  shouldRequestNearestDate
} from "@/lib/planning-date-fallback";

describe("shouldRequestNearestDate", () => {
  it("test 1: selectedDate has services in the loaded range -> no extra lookup", () => {
    const result = shouldRequestNearestDate({
      loading: false,
      selectedDate: "2026-08-15",
      availableDates: ["2026-08-14", "2026-08-15", "2026-08-16"],
      lastAttemptedDate: null
    });
    expect(result).toBe(false);
  });

  it("test 2/3: selectedDate has zero services in range -> lookup is requested", () => {
    const result = shouldRequestNearestDate({
      loading: false,
      selectedDate: "2026-08-15",
      availableDates: ["2026-08-01", "2026-08-02"],
      lastAttemptedDate: null
    });
    expect(result).toBe(true);
  });

  it("does not request while the current scoped load is still in flight", () => {
    const result = shouldRequestNearestDate({
      loading: true,
      selectedDate: "2026-08-15",
      availableDates: [],
      lastAttemptedDate: null
    });
    expect(result).toBe(false);
  });

  it("does not re-request for a date it already attempted (avoids loops/spam)", () => {
    const result = shouldRequestNearestDate({
      loading: false,
      selectedDate: "2026-08-15",
      availableDates: [],
      lastAttemptedDate: "2026-08-15"
    });
    expect(result).toBe(false);
  });

  it("does request again once selectedDate changes to a new empty date", () => {
    const result = shouldRequestNearestDate({
      loading: false,
      selectedDate: "2026-08-16",
      availableDates: [],
      lastAttemptedDate: "2026-08-15"
    });
    expect(result).toBe(true);
  });
});

describe("resolveNearestDateResult", () => {
  it("jumps to the found date when it differs from the current selection", () => {
    expect(resolveNearestDateResult("2026-05-01", "2026-08-15")).toBe("2026-05-01");
  });

  it("test 3: finds a date far outside the 21-day window (no distance limit)", () => {
    expect(resolveNearestDateResult("2025-01-10", "2026-08-15")).toBe("2025-01-10");
  });

  it("stays on the current date when nothing was found anywhere", () => {
    expect(resolveNearestDateResult(null, "2026-08-15")).toBe("2026-08-15");
  });

  it("is a no-op when the found date equals the current selection", () => {
    expect(resolveNearestDateResult("2026-08-15", "2026-08-15")).toBe("2026-08-15");
  });
});

describe("computePlanningRangeScope", () => {
  it("test 5: always produces a range scope, including right after a fallback jump", () => {
    const scope = computePlanningRangeScope("2025-01-10");
    expect(scope.mode).toBe("range");
    expect(scope.from).toBe("2025-01-03");
    expect(scope.to).toBe("2025-01-24");
  });

  it("recenters the range around whatever date it's given", () => {
    const scope = computePlanningRangeScope("2026-08-15");
    expect(scope.from).toBe("2026-08-08");
    expect(scope.to).toBe("2026-08-29");
  });
});
