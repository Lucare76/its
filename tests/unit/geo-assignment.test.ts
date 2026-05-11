import { describe, expect, it } from "vitest";
import { validateGeographicCompatibility } from "@/lib/server/geo-assignment";

describe("geo assignment compatibility", () => {
  it("blocca il bug originale: Casamicciola e Ischia Porto allo stesso orario", () => {
    const result = validateGeographicCompatibility(
      { startTime: "09:30", endZone: "Casamicciola" },
      { startTime: "09:30", startZone: "Ischia Porto" }
    );

    expect(result.severity).toBe("block");
    expect(result.compatible).toBe(false);
  });

  it("accetta stessa macro-area con margine sufficiente", () => {
    const result = validateGeographicCompatibility(
      { startTime: "09:30", endZone: "Ischia Porto" },
      { startTime: "09:45", startZone: "Ischia Porto" }
    );

    expect(result.severity).toBe("ok");
    expect(result.compatible).toBe(true);
  });

  it("accetta macro-aree diverse con tempo sufficiente", () => {
    const result = validateGeographicCompatibility(
      { startTime: "09:00", endZone: "Casamicciola" },
      { startTime: "10:00", startZone: "Ischia Porto" }
    );

    expect(result.severity).toBe("ok");
    expect(result.compatible).toBe(true);
  });

  it("segnala warning per margine borderline", () => {
    const result = validateGeographicCompatibility(
      { startTime: "09:00", endZone: "Casamicciola" },
      { startTime: "09:22", startZone: "Ischia Porto" }
    );

    expect(result.requiredMinutes).toBe(20);
    expect(result.availableMinutes).toBe(22);
    expect(result.severity).toBe("warning");
    expect(result.compatible).toBe(true);
  });

  it("gestisce zona mancante senza crash", () => {
    const result = validateGeographicCompatibility(
      { startTime: "09:00", endZone: null },
      { startTime: "09:20", startZone: "Ischia Porto" }
    );

    expect(result.severity).toBe("warning");
    expect(result.compatible).toBe(true);
  });
});
