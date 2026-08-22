import { describe, expect, it } from "vitest";
import {
  evaluateImminentUnassignedServices,
  requiresOperationalAssignment,
  OPERATIONS_CRITICAL_WINDOW_MINUTES,
  OPERATIONS_WARNING_WINDOW_MINUTES,
  type OperationsHealthServiceRow,
  type OperationsHealthHotelRow,
} from "@/lib/server/operational-health/operations-health";

// 2026-08-22 e' CEST (Europe/Rome = UTC+2): le 10:00 UTC sono le 12:00 locali.
const NOW_SUMMER = new Date("2026-08-22T10:00:00.000Z");

const HOTEL: OperationsHealthHotelRow = { id: "hotel-1", name: "Hotel Test", zone: "Ischia Porto" };
const HOTELS = new Map([[HOTEL.id, HOTEL]]);

/**
 * Servizio "sicuramente assegnabile" per resolveAssignableService: ARRIVO
 * con meeting_point porto isola valido + hotel destinazione risolvibile +
 * pax valido -> assignable=true, needs_review=false (nessuna delle reason
 * di addMissingBaseReasons/applyOperationalHardConstraints scatta). Verificato
 * a mano riga per riga contro lib/piano-assignable-service.ts prima di
 * scrivere questo fixture.
 */
function assignableService(overrides: Partial<OperationsHealthServiceRow> = {}): OperationsHealthServiceRow {
  return {
    id: "svc-1",
    date: "2026-08-22",
    time: "12:00",
    status: "new",
    is_draft: false,
    direction: "arrival",
    practice_number: "ITS-2026-123",
    hotel_id: "hotel-1",
    pax: 2,
    meeting_point: "Ischia Porto",
    ...overrides,
  };
}

/**
 * Servizio con dati insufficienti per una macro categoria determinabile
 * (nessuna direction valida, nessun booking_service_kind di navetta/
 * escursione) -> resolveAssignableService lo classifica DA_VERIFICARE,
 * che genera SEMPRE la review_reason "Macro categoria non determinata" ->
 * assignable=false. Stesso bucket "needs_review" del Piano del Giorno
 * reale (piano-unassigned-services-diagnostics.ts) — include anche i
 * casi "continent dispatch" (isContinentDispatch richiede proprio
 * macro_category === "DA_VERIFICARE").
 */
function undeterminedService(overrides: Partial<OperationsHealthServiceRow> = {}): OperationsHealthServiceRow {
  return {
    id: "svc-undetermined",
    date: "2026-08-22",
    time: "12:30",
    status: "new",
    is_draft: false,
    direction: null,
    practice_number: "ITS-2026-999",
    hotel_id: null,
    pax: 2,
    ...overrides,
  };
}

describe("requiresOperationalAssignment", () => {
  it("servizio con macro categoria/pickup/destinazione risolvibili -> true (richiede assegnazione)", () => {
    expect(requiresOperationalAssignment(assignableService(), HOTEL)).toBe(true);
  });

  it("servizio con dati insufficienti (macro categoria non determinata) -> false (non determinabile con certezza)", () => {
    expect(requiresOperationalAssignment(undeterminedService(), null)).toBe(false);
  });
});

describe("evaluateImminentUnassignedServices", () => {
  it("1./13. servizio sicuramente assegnabile entro 60 min senza assegnazione -> critical", () => {
    const svc = assignableService({ id: "svc-42", time: "12:42" }); // 42 minuti, esempio spec
    const signals = evaluateImminentUnassignedServices([svc], [], HOTELS, NOW_SUMMER);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.severity).toBe("critical");
    expect(signals[0]!.message).toContain("42 minuti");
  });

  it("2./14. servizio sicuramente assegnabile tra 60 e 180 min -> warning", () => {
    const svc = assignableService({ id: "svc-90", time: "13:30" }); // 90 minuti
    const signals = evaluateImminentUnassignedServices([svc], [], HOTELS, NOW_SUMMER);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.severity).toBe("warning");
  });

  it("servizio oltre la finestra (>180 min) -> nessun alert", () => {
    const svc = assignableService({ id: "svc-200", time: "15:30" }); // 210 minuti
    expect(evaluateImminentUnassignedServices([svc], [], HOTELS, NOW_SUMMER)).toEqual([]);
  });

  it("servizio gia' partito (nel passato) -> nessun alert", () => {
    const svc = assignableService({ id: "svc-past", time: "11:00" }); // -60 minuti
    expect(evaluateImminentUnassignedServices([svc], [], HOTELS, NOW_SUMMER)).toEqual([]);
  });

  it("3. servizio assegnabile ma gia' assegnato (assignment con driver_user_id) -> nessun alert", () => {
    const svc = assignableService({ id: "svc-assigned", time: "12:30" });
    const signals = evaluateImminentUnassignedServices(
      [svc],
      [{ service_id: "svc-assigned", driver_user_id: "driver-1" }],
      HOTELS,
      NOW_SUMMER
    );
    expect(signals).toEqual([]);
  });

  it("4. cancelled -> nessun alert", () => {
    const svc = assignableService({ id: "svc-cancelled", time: "12:30", status: "cancelled" });
    expect(evaluateImminentUnassignedServices([svc], [], HOTELS, NOW_SUMMER)).toEqual([]);
  });

  it("servizio in pending_cancellation -> nessun alert", () => {
    const svc = assignableService({ id: "svc-pending-cancel", time: "12:30", status: "pending_cancellation" });
    expect(evaluateImminentUnassignedServices([svc], [], HOTELS, NOW_SUMMER)).toEqual([]);
  });

  it("5. completato -> nessun alert", () => {
    const svc = assignableService({ id: "svc-done", time: "12:30", status: "completato" });
    expect(evaluateImminentUnassignedServices([svc], [], HOTELS, NOW_SUMMER)).toEqual([]);
  });

  it("6. draft -> nessun alert", () => {
    const svc = assignableService({ id: "svc-draft", time: "12:30", is_draft: true });
    expect(evaluateImminentUnassignedServices([svc], [], HOTELS, NOW_SUMMER)).toEqual([]);
  });

  it("7./9. servizio che NON richiede assegnazione con certezza (dati insufficienti, DA_VERIFICARE) -> nessun alert (comportamento conservativo, non un falso critical)", () => {
    const svc = undeterminedService({ id: "svc-undetermined-imminent", time: "12:30" }); // 30 minuti, sarebbe critical se valutato
    expect(evaluateImminentUnassignedServices([svc], [], HOTELS, NOW_SUMMER)).toEqual([]);
  });

  it("8. is_draft=false NON implica automaticamente requiresAssignment=true", () => {
    const svc = undeterminedService({ id: "svc-not-draft-undetermined", time: "12:30", is_draft: false });
    expect(svc.is_draft).toBe(false);
    expect(evaluateImminentUnassignedServices([svc], [], HOTELS, NOW_SUMMER)).toEqual([]);
  });

  it("20. timezone Europe/Rome: stessa distanza in minuti in CET (inverno, UTC+1) e CEST (estate, UTC+2)", () => {
    const nowWinter = new Date("2026-01-15T10:00:00.000Z"); // 11:00 locale CET
    const svc = assignableService({ id: "svc-winter", date: "2026-01-15", time: "11:42" }); // 42 minuti locali
    const signals = evaluateImminentUnassignedServices([svc], [], HOTELS, nowWinter);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.severity).toBe("critical");
    expect(signals[0]!.metadata?.minutes_until).toBe(42);
  });

  it("soglie esposte corrispondono alla spec (60 / 180 minuti, invariate da questo fix)", () => {
    expect(OPERATIONS_CRITICAL_WINDOW_MINUTES).toBe(60);
    expect(OPERATIONS_WARNING_WINDOW_MINUTES).toBe(180);
  });
});
