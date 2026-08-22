import { describe, expect, it } from "vitest";
import { aggregateOperationalHealth, type OperationalHealthAreaResult, type OperationalHealthSignal } from "@/lib/server/operational-health/types";

const NOW = "2026-08-22T10:00:00.000Z";

function signal(overrides: Partial<OperationalHealthSignal>): OperationalHealthSignal {
  return {
    key: "test:signal",
    area: "operations",
    severity: "warning",
    title: "Test",
    message: "Test message",
    detectedAt: NOW,
    ...overrides,
  };
}

function area(overrides: Partial<OperationalHealthAreaResult>): OperationalHealthAreaResult {
  return { area: "operations", available: true, signals: [], ...overrides };
}

describe("aggregateOperationalHealth", () => {
  it("23. nessuna anomaly -> summary tutta a zero, nessun segnale", () => {
    const report = aggregateOperationalHealth(
      [area({ area: "backup" }), area({ area: "medmar" }), area({ area: "email" }), area({ area: "operations" })],
      NOW
    );
    expect(report.summary).toEqual({ info: 0, warning: 0, critical: 0 });
    expect(report.signals).toEqual([]);
  });

  it("conta correttamente per severita' su piu' aree", () => {
    const report = aggregateOperationalHealth(
      [
        area({ area: "backup", signals: [signal({ key: "b1", area: "backup", severity: "critical" })] }),
        area({ area: "operations", signals: [signal({ key: "o1", area: "operations", severity: "warning" })] }),
        area({ area: "email", signals: [signal({ key: "e1", area: "email", severity: "info" })] }),
      ],
      NOW
    );
    expect(report.summary).toEqual({ info: 1, warning: 1, critical: 1 });
  });

  it("ordina i segnali critical -> warning -> info", () => {
    const report = aggregateOperationalHealth(
      [
        area({
          area: "operations",
          signals: [
            signal({ key: "w1", severity: "warning" }),
            signal({ key: "c1", severity: "critical" }),
            signal({ key: "i1", severity: "info" }),
          ],
        }),
      ],
      NOW
    );
    expect(report.signals.map((s) => s.key)).toEqual(["c1", "w1", "i1"]);
  });

  it("24. un'area non disponibile (available:false) non rimuove i segnali delle altre", () => {
    const report = aggregateOperationalHealth(
      [
        area({ area: "medmar", available: false, error: "Salute delivery Medmar temporaneamente non disponibile." }),
        area({ area: "operations", signals: [signal({ key: "o1", area: "operations", severity: "critical" })] }),
      ],
      NOW
    );
    expect(report.areas.find((a) => a.area === "medmar")!.available).toBe(false);
    expect(report.summary.critical).toBe(1);
    expect(report.signals).toHaveLength(1);
  });
});
