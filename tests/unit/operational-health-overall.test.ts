import { describe, expect, it } from "vitest";
import { combineOverallHealth } from "@/lib/server/operational-health/types";

describe("combineOverallHealth", () => {
  it("21. Job Health sano + Operational critical -> overall critical", () => {
    expect(combineOverallHealth("healthy", { info: 0, warning: 0, critical: 1 })).toBe("critical");
  });

  it("22. Job Health sano + Operational warning (nessun critical) -> overall attention", () => {
    expect(combineOverallHealth("healthy", { info: 0, warning: 1, critical: 0 })).toBe("attention");
  });

  it("23. nessuna anomaly in nessuna delle due dimensioni -> healthy", () => {
    expect(combineOverallHealth("healthy", { info: 0, warning: 0, critical: 0 })).toBe("healthy");
  });

  it("Job Health critical da solo (Operational sano) -> overall critical comunque", () => {
    expect(combineOverallHealth("critical", { info: 0, warning: 0, critical: 0 })).toBe("critical");
  });

  it("Job Health attention + Operational critical -> resta critical (non regressione a attention)", () => {
    expect(combineOverallHealth("attention", { info: 0, warning: 0, critical: 1 })).toBe("critical");
  });
});
