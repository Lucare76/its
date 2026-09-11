import { describe, it, expect } from "vitest";
import {
  buildControlCenterDayStatus,
  cardLevelToAlertSeverity,
  filterVisibleAlerts,
  hasAgencyApprovalNearOrPastExpiry,
  severityFromAgencyApprovals,
  severityFromAssignableUnassigned,
  severityFromCancellationsPending,
  severityFromDayDiagnostics,
  severityFromFailedImports,
  severityFromGroupDiagnostics,
  severityFromIncompleteBookingGroups,
  severityFromNeedsReview,
  severityFromWhatsAppFailed,
  sortAlertsBySeverity,
  summarizeTotals,
  type ControlCenterAlert,
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

  describe("severityFromNeedsReview — sempre warning se > 0", () => {
    it("0 → ok", () => expect(severityFromNeedsReview(0)).toEqual({ level: "ok", count: 0 }));
    it("> 0 → warning", () => expect(severityFromNeedsReview(4)).toEqual({ level: "warning", count: 4 }));
  });

  describe("severityFromIncompleteBookingGroups — sempre warning se > 0", () => {
    it("0 → ok", () => expect(severityFromIncompleteBookingGroups(0)).toEqual({ level: "ok", count: 0 }));
    it("> 0 → warning", () => expect(severityFromIncompleteBookingGroups(2)).toEqual({ level: "warning", count: 2 }));
  });

  describe("cardLevelToAlertSeverity", () => {
    it("ok -> info, warning -> warning, critical -> critical", () => {
      expect(cardLevelToAlertSeverity("ok")).toBe("info");
      expect(cardLevelToAlertSeverity("warning")).toBe("warning");
      expect(cardLevelToAlertSeverity("critical")).toBe("critical");
    });
  });

  function alert(severity: ControlCenterAlert["severity"], count: number, code = severity): ControlCenterAlert {
    return { code, severity, count, title: code, description: "", action_label: "Apri", action_href: "/x" };
  }

  describe("sortAlertsBySeverity — critical > warning > info, tiebreak stabile sull'ordine originale", () => {
    it("riordina critical, warning, info nell'ordine richiesto", () => {
      const input = [alert("info", 0, "a"), alert("critical", 1, "b"), alert("warning", 2, "c")];
      expect(sortAlertsBySeverity(input).map((a) => a.code)).toEqual(["b", "c", "a"]);
    });

    it("a parità di severità mantiene l'ordine originale (tiebreak stabile)", () => {
      const input = [alert("warning", 1, "first"), alert("warning", 2, "second"), alert("critical", 1, "third")];
      expect(sortAlertsBySeverity(input).map((a) => a.code)).toEqual(["third", "first", "second"]);
    });

    it("non muta l'array in input", () => {
      const input = [alert("warning", 1, "a"), alert("critical", 1, "b")];
      const copy = [...input];
      sortAlertsBySeverity(input);
      expect(input).toEqual(copy);
    });
  });

  describe("filterVisibleAlerts — count=0 (info) nascosti di default", () => {
    it("showAll=false: nasconde le card 'info', mostra critical e warning", () => {
      const input = [alert("info", 0, "ok-card"), alert("warning", 1, "w"), alert("critical", 1, "c")];
      expect(filterVisibleAlerts(input, false).map((a) => a.code)).toEqual(["w", "c"]);
    });

    it("showAll=true: mostra anche le card 'info'", () => {
      const input = [alert("info", 0, "ok-card"), alert("warning", 1, "w")];
      expect(filterVisibleAlerts(input, true).map((a) => a.code)).toEqual(["ok-card", "w"]);
    });

    it("nessun alert -> lista vuota in entrambe le modalità", () => {
      expect(filterVisibleAlerts([], false)).toEqual([]);
      expect(filterVisibleAlerts([], true)).toEqual([]);
    });
  });

  describe("buildControlCenterDayStatus — frase umana per la fascia Stato Giornata", () => {
    it("giornata completamente verde -> 'Giornata sotto controllo'", () => {
      const status = buildControlCenterDayStatus([alert("info", 0)]);
      expect(status).toEqual({ level: "ok", headline: "Giornata sotto controllo", subline: "Nessun problema operativo rilevante" });
    });

    it("un singolo critical -> '1 problema urgente' (singolare corretto)", () => {
      const status = buildControlCenterDayStatus([alert("critical", 1)]);
      expect(status.level).toBe("critical");
      expect(status.headline).toBe("1 problema urgente");
      expect(status.subline).toBeUndefined();
    });

    it("più critical -> plurale 'N problemi urgenti'", () => {
      const status = buildControlCenterDayStatus([alert("critical", 3)]);
      expect(status.headline).toBe("3 problemi urgenti");
    });

    it("solo warning (nessun critical) -> 'N cose da verificare'", () => {
      const status = buildControlCenterDayStatus([alert("warning", 3)]);
      expect(status).toEqual({ level: "warning", headline: "3 cose da verificare" });
    });

    it("un solo warning -> singolare 'cosa da verificare'", () => {
      const status = buildControlCenterDayStatus([alert("warning", 1)]);
      expect(status.headline).toBe("1 cosa da verificare");
    });

    it("critical + warning insieme -> il critical vince come frase principale, i warning residui in subline", () => {
      const status = buildControlCenterDayStatus([alert("critical", 2, "a"), alert("warning", 5, "b")]);
      expect(status.level).toBe("critical");
      expect(status.headline).toBe("2 problemi urgenti");
      expect(status.subline).toBe("+ 5 da verificare");
    });

    it("somma i count di più alert della stessa severità", () => {
      const status = buildControlCenterDayStatus([alert("critical", 1, "a"), alert("critical", 2, "b")]);
      expect(status.headline).toBe("3 problemi urgenti");
    });
  });
});
