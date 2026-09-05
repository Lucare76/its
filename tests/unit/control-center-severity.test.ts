import { describe, it, expect } from "vitest";
import {
  hasAgencyApprovalNearOrPastExpiry,
  severityFromAgencyApprovals,
  severityFromAssignableUnassigned,
  severityFromCancellationsPending,
  severityFromDayDiagnostics,
  severityFromFailedImports,
  severityFromGroupDiagnostics,
  severityFromWhatsAppFailed,
  summarizeTotals,
} from "@/lib/control-center-severity";

describe("control-center-severity — mapping INFO/WARNING/CRITICAL", () => {
  describe("severityFromDayDiagnostics", () => {
    it("nessun issue nella categoria → ok, count 0", () => {
      const result = severityFromDayDiagnostics([{ severity: "error", category: "bus" }], ["pickup"]);
      expect(result).toEqual({ level: "ok", count: 0 });
    });

    it("almeno un issue 'error' nella categoria → critical", () => {
      const result = severityFromDayDiagnostics(
        [{ severity: "warning", category: "pickup" }, { severity: "error", category: "pickup" }],
        ["pickup"]
      );
      expect(result.level).toBe("critical");
      expect(result.count).toBe(2);
    });

    it("solo 'warning' (nessun error) → warning", () => {
      const result = severityFromDayDiagnostics([{ severity: "warning", category: "duplicate" }], ["duplicate"]);
      expect(result).toEqual({ level: "warning", count: 1 });
    });

    it("solo issue 'info' → resta ok e non conta nel numero (Mario non vede arancione per una nota)", () => {
      const result = severityFromDayDiagnostics([{ severity: "info", category: "import" }], ["import"]);
      expect(result).toEqual({ level: "ok", count: 0 });
    });
  });

  describe("severityFromAssignableUnassigned — V1: mai critical", () => {
    it("count 0 → ok", () => {
      expect(severityFromAssignableUnassigned(0)).toEqual({ level: "ok", count: 0 });
    });
    it("count > 0 → warning, MAI critical in V1", () => {
      expect(severityFromAssignableUnassigned(5)).toEqual({ level: "warning", count: 5 });
      expect(severityFromAssignableUnassigned(500)).toEqual({ level: "warning", count: 500 });
    });
  });

  describe("severityFromGroupDiagnostics", () => {
    const emptyVehicleDiagnostics = { warnings: [], invalid_driver_vehicle_assignments: [], vehicle_binding: { driver_vehicle_eligibility_blockers: 0 } };

    it("nessun conflitto/warning → ok", () => {
      expect(severityFromGroupDiagnostics({ total_conflicts: 0, total_warnings: 0 }, emptyVehicleDiagnostics)).toEqual({ level: "ok", count: 0 });
    });

    it("total_conflicts > 0 → critical", () => {
      const result = severityFromGroupDiagnostics({ total_conflicts: 2, total_warnings: 0 }, emptyVehicleDiagnostics);
      expect(result.level).toBe("critical");
      expect(result.count).toBe(2);
    });

    it("eligibility blocker o invalid_driver_vehicle_assignments → critical anche con total_conflicts=0", () => {
      const result = severityFromGroupDiagnostics(
        { total_conflicts: 0, total_warnings: 0 },
        { warnings: [], invalid_driver_vehicle_assignments: [{}], vehicle_binding: { driver_vehicle_eligibility_blockers: 1 } }
      );
      expect(result.level).toBe("critical");
      expect(result.count).toBe(2);
    });

    it("solo warning nativi → warning", () => {
      const result = severityFromGroupDiagnostics({ total_conflicts: 0, total_warnings: 3 }, emptyVehicleDiagnostics);
      expect(result).toEqual({ level: "warning", count: 3 });
    });
  });

  describe("severityFromFailedImports", () => {
    it("0 falliti → ok", () => expect(severityFromFailedImports(0)).toEqual({ level: "ok", count: 0 }));
    it("falliti > 0 → warning (mai critical)", () => expect(severityFromFailedImports(4)).toEqual({ level: "warning", count: 4 }));
  });

  describe("severityFromAgencyApprovals", () => {
    it("0 pendenti → ok", () => expect(severityFromAgencyApprovals(0, false)).toEqual({ level: "ok", count: 0 }));
    it("pendenti senza urgenza → warning", () => expect(severityFromAgencyApprovals(2, false)).toEqual({ level: "warning", count: 2 }));
    it("pendenti con token vicino/oltre scadenza → critical", () => expect(severityFromAgencyApprovals(2, true)).toEqual({ level: "critical", count: 2 }));
  });

  describe("hasAgencyApprovalNearOrPastExpiry", () => {
    const now = new Date("2026-09-05T12:00:00Z");

    it("nessun token → false", () => {
      expect(hasAgencyApprovalNearOrPastExpiry([{ token_expires_at: null }], now)).toBe(false);
    });

    it("token già scaduto → true", () => {
      expect(hasAgencyApprovalNearOrPastExpiry([{ token_expires_at: "2026-09-05T10:00:00Z" }], now)).toBe(true);
    });

    it("token entro la finestra critica (6h) → true", () => {
      expect(hasAgencyApprovalNearOrPastExpiry([{ token_expires_at: "2026-09-05T15:00:00Z" }], now)).toBe(true);
    });

    it("token ben oltre la finestra critica → false", () => {
      expect(hasAgencyApprovalNearOrPastExpiry([{ token_expires_at: "2026-09-07T12:00:00Z" }], now)).toBe(false);
    });
  });

  describe("severityFromCancellationsPending — V1: nessuna escalation temporale", () => {
    it("0 → ok", () => expect(severityFromCancellationsPending(0)).toEqual({ level: "ok", count: 0 }));
    it("> 0 → warning sempre", () => expect(severityFromCancellationsPending(9)).toEqual({ level: "warning", count: 9 }));
  });

  describe("severityFromWhatsAppFailed", () => {
    it("0 → ok", () => expect(severityFromWhatsAppFailed(0)).toEqual({ level: "ok", count: 0 }));
    it("> 0 → critical sempre", () => expect(severityFromWhatsAppFailed(1)).toEqual({ level: "critical", count: 1 }));
  });

  describe("summarizeTotals", () => {
    it("stato tutto-verde → 0 critici, 0 attenzioni", () => {
      const cards = [{ level: "ok" as const, count: 0 }, { level: "ok" as const, count: 0 }];
      expect(summarizeTotals(cards)).toEqual({ critical: 0, warning: 0 });
    });

    it("stato con anomalie → somma i count solo delle card non-ok, per livello", () => {
      const cards = [
        { level: "critical" as const, count: 1 },
        { level: "warning" as const, count: 2 },
        { level: "warning" as const, count: 3 },
        { level: "ok" as const, count: 0 },
      ];
      expect(summarizeTotals(cards)).toEqual({ critical: 1, warning: 5 });
    });
  });
});
