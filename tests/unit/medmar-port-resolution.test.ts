import { describe, it, expect } from "vitest";
import { resolveMainlandPort, resolveIslandPort, resolveLegRouteCode } from "@/lib/server/medmar-booking/port-resolution";

describe("port-resolution — resolveMainlandPort", () => {
  it("formula_medmar_napoli -> napoli", () => {
    expect(resolveMainlandPort("formula_medmar_napoli")).toEqual({ status: "resolved", port: "napoli" });
  });
  it("formula_medmar_pozzuoli -> pozzuoli", () => {
    expect(resolveMainlandPort("formula_medmar_pozzuoli")).toEqual({ status: "resolved", port: "pozzuoli" });
  });
  it("null -> unknown (missing_booking_service_kind)", () => {
    expect(resolveMainlandPort(null)).toEqual({ status: "unknown", reason: "missing_booking_service_kind" });
  });
  it("kind non mappato (es. formula_snav, formula_medmar_unknown) -> unknown", () => {
    expect(resolveMainlandPort("formula_snav")).toEqual({ status: "unknown", reason: "unmapped_booking_service_kind" });
    expect(resolveMainlandPort("formula_medmar_unknown")).toEqual({ status: "unknown", reason: "unmapped_booking_service_kind" });
  });
});

describe("port-resolution — resolveIslandPort", () => {
  it("Napoli -> sempre ischia, indipendentemente dal meeting_point (Napoli<->Casamicciola non è una tratta verificata)", () => {
    expect(resolveIslandPort("formula_medmar_napoli", null)).toEqual({ status: "resolved", port: "ischia" });
    expect(resolveIslandPort("formula_medmar_napoli", "Casamicciola - Piazza Marina")).toEqual({ status: "resolved", port: "ischia" });
  });

  it("Pozzuoli + meeting_point senza 'casamicciola' -> ischia", () => {
    expect(resolveIslandPort("formula_medmar_pozzuoli", "Ischia Porto")).toEqual({ status: "resolved", port: "ischia" });
  });

  it("Pozzuoli + meeting_point con 'casamicciola' (case-insensitive) -> casamicciola", () => {
    expect(resolveIslandPort("formula_medmar_pozzuoli", "Casamicciola - Corso Garibaldi")).toEqual({ status: "resolved", port: "casamicciola" });
    expect(resolveIslandPort("formula_medmar_pozzuoli", "CASAMICCIOLA")).toEqual({ status: "resolved", port: "casamicciola" });
    expect(resolveIslandPort("formula_medmar_pozzuoli", "  casamicciola  ")).toEqual({ status: "resolved", port: "casamicciola" });
  });

  it("Pozzuoli + meeting_point mancante/vuoto -> unknown, MAI un default su ischia", () => {
    expect(resolveIslandPort("formula_medmar_pozzuoli", null)).toEqual({ status: "unknown", reason: "missing_meeting_point" });
    expect(resolveIslandPort("formula_medmar_pozzuoli", "")).toEqual({ status: "unknown", reason: "missing_meeting_point" });
    expect(resolveIslandPort("formula_medmar_pozzuoli", "   ")).toEqual({ status: "unknown", reason: "missing_meeting_point" });
  });

  it("booking_service_kind mancante o non mappato -> unknown", () => {
    expect(resolveIslandPort(null, "Casamicciola")).toEqual({ status: "unknown", reason: "missing_booking_service_kind" });
    expect(resolveIslandPort("formula_snav", "Casamicciola")).toEqual({ status: "unknown", reason: "unmapped_booking_service_kind" });
  });
});

describe("port-resolution — resolveLegRouteCode: le 6 tratte verificate sono tutte raggiungibili", () => {
  it("Ischia -> Napoli (partenza da Ischia lato Napoli)", () => {
    const r = resolveLegRouteCode({ bookingServiceKind: "formula_medmar_napoli", direction: "departure", meetingPoint: null });
    expect(r).toEqual({ status: "resolved", routeCode: "ischia_napoli", mainlandPort: "napoli", islandPort: "ischia" });
  });
  it("Napoli -> Ischia (arrivo lato Napoli)", () => {
    const r = resolveLegRouteCode({ bookingServiceKind: "formula_medmar_napoli", direction: "arrival", meetingPoint: null });
    expect(r).toEqual({ status: "resolved", routeCode: "napoli_ischia", mainlandPort: "napoli", islandPort: "ischia" });
  });
  it("Ischia -> Pozzuoli (partenza lato Pozzuoli, meeting_point non-Casamicciola)", () => {
    const r = resolveLegRouteCode({ bookingServiceKind: "formula_medmar_pozzuoli", direction: "departure", meetingPoint: "Ischia Porto" });
    expect(r).toEqual({ status: "resolved", routeCode: "ischia_pozzuoli", mainlandPort: "pozzuoli", islandPort: "ischia" });
  });
  it("Pozzuoli -> Ischia (arrivo lato Pozzuoli, meeting_point non-Casamicciola)", () => {
    const r = resolveLegRouteCode({ bookingServiceKind: "formula_medmar_pozzuoli", direction: "arrival", meetingPoint: "Ischia Porto" });
    expect(r).toEqual({ status: "resolved", routeCode: "pozzuoli_ischia", mainlandPort: "pozzuoli", islandPort: "ischia" });
  });
  it("Casamicciola -> Pozzuoli (partenza lato Pozzuoli, meeting_point Casamicciola)", () => {
    const r = resolveLegRouteCode({ bookingServiceKind: "formula_medmar_pozzuoli", direction: "departure", meetingPoint: "Casamicciola" });
    expect(r).toEqual({ status: "resolved", routeCode: "casamicciola_pozzuoli", mainlandPort: "pozzuoli", islandPort: "casamicciola" });
  });
  it("Pozzuoli -> Casamicciola (arrivo lato Pozzuoli, meeting_point Casamicciola)", () => {
    const r = resolveLegRouteCode({ bookingServiceKind: "formula_medmar_pozzuoli", direction: "arrival", meetingPoint: "Casamicciola" });
    expect(r).toEqual({ status: "resolved", routeCode: "pozzuoli_casamicciola", mainlandPort: "pozzuoli", islandPort: "casamicciola" });
  });
});

describe("port-resolution — resolveLegRouteCode: casi unknown / edge case A/R", () => {
  it("direction mancante o non valida -> unknown", () => {
    expect(resolveLegRouteCode({ bookingServiceKind: "formula_medmar_napoli", direction: null, meetingPoint: null })).toEqual({
      status: "unknown", reason: "missing_or_invalid_direction",
    });
    expect(resolveLegRouteCode({ bookingServiceKind: "formula_medmar_napoli", direction: "sideways", meetingPoint: null })).toEqual({
      status: "unknown", reason: "missing_or_invalid_direction",
    });
  });

  it("booking_service_kind mancante -> unknown", () => {
    expect(resolveLegRouteCode({ bookingServiceKind: null, direction: "arrival", meetingPoint: null })).toEqual({
      status: "unknown", reason: "missing_booking_service_kind",
    });
  });

  it("booking_service_kind non mappato -> unknown", () => {
    expect(resolveLegRouteCode({ bookingServiceKind: "formula_medmar_unknown", direction: "arrival", meetingPoint: null })).toEqual({
      status: "unknown", reason: "unmapped_booking_service_kind",
    });
  });

  it("servizio Pozzuoli senza meeting_point -> unknown (missing_meeting_point), MAI un fallback su Ischia", () => {
    const r = resolveLegRouteCode({ bookingServiceKind: "formula_medmar_pozzuoli", direction: "arrival", meetingPoint: null });
    expect(r).toEqual({ status: "unknown", reason: "missing_meeting_point" });
  });

  it("andata e ritorno risolti in modo indipendente: due chiamate separate non si influenzano a vicenda", () => {
    const outward = resolveLegRouteCode({ bookingServiceKind: "formula_medmar_napoli", direction: "arrival", meetingPoint: null });
    const ret = resolveLegRouteCode({ bookingServiceKind: "formula_medmar_pozzuoli", direction: "departure", meetingPoint: "Casamicciola" });
    expect(outward).toEqual({ status: "resolved", routeCode: "napoli_ischia", mainlandPort: "napoli", islandPort: "ischia" });
    expect(ret).toEqual({ status: "resolved", routeCode: "casamicciola_pozzuoli", mainlandPort: "pozzuoli", islandPort: "casamicciola" });
  });

  it("sensitivity: nessun input con esito unknown produce mai un routeCode (in particolare mai uno contenente 'ischia' per default)", () => {
    const unknownInputs = [
      { bookingServiceKind: null, direction: "arrival", meetingPoint: null },
      { bookingServiceKind: "formula_medmar_pozzuoli", direction: "arrival", meetingPoint: null },
      { bookingServiceKind: "formula_medmar_pozzuoli", direction: "arrival", meetingPoint: "" },
      { bookingServiceKind: "formula_medmar_unknown", direction: "departure", meetingPoint: null },
      { bookingServiceKind: "formula_medmar_napoli", direction: null, meetingPoint: null },
    ];
    for (const input of unknownInputs) {
      const r = resolveLegRouteCode(input);
      expect(r.status).toBe("unknown");
      expect("routeCode" in r).toBe(false);
    }
  });
});

describe("port-resolution — pratiche importate transfer_port_hotel (meeting_point = porto terraferma di partenza)", () => {
  it("A. MEDMAR + PORTO DI NAPOLI PORTA DI MASSA -> mainland napoli, isola ischia, tratta napoli_ischia", () => {
    const mp = "PORTO DI NAPOLI PORTA DI MASSA";
    expect(resolveMainlandPort("transfer_port_hotel", mp)).toEqual({ status: "resolved", port: "napoli" });
    expect(resolveIslandPort("transfer_port_hotel", mp)).toEqual({ status: "resolved", port: "ischia" });
    expect(resolveLegRouteCode({ bookingServiceKind: "transfer_port_hotel", direction: "arrival", meetingPoint: mp })).toEqual({
      status: "resolved", routeCode: "napoli_ischia", mainlandPort: "napoli", islandPort: "ischia",
    });
    expect(resolveMainlandPort("transfer_port_hotel", "Napoli - Calata Porta di Massa")).toEqual({ status: "resolved", port: "napoli" });
  });

  it("B. MEDMAR + POZZUOLI -> mainland pozzuoli; porto isolano non ricavabile -> nessuna tratta", () => {
    expect(resolveMainlandPort("transfer_port_hotel", "PORTO DI POZZUOLI")).toEqual({ status: "resolved", port: "pozzuoli" });
    expect(resolveIslandPort("transfer_port_hotel", "PORTO DI POZZUOLI")).toEqual({ status: "unknown", reason: "missing_island_port" });
    expect(resolveLegRouteCode({ bookingServiceKind: "transfer_port_hotel", direction: "arrival", meetingPoint: "PORTO DI POZZUOLI" })).toEqual({
      status: "unknown", reason: "missing_island_port",
    });
  });

  it("D. formula_medmar_napoli invariato (meeting_point ignorato)", () => {
    expect(resolveMainlandPort("formula_medmar_napoli", "PORTO DI POZZUOLI")).toEqual({ status: "resolved", port: "napoli" });
    expect(resolveIslandPort("formula_medmar_napoli", "PORTO DI POZZUOLI")).toEqual({ status: "resolved", port: "ischia" });
  });

  it("E. formula_medmar_pozzuoli invariato (meeting_point = punto sull'isola)", () => {
    expect(resolveMainlandPort("formula_medmar_pozzuoli", "PORTO DI NAPOLI PORTA DI MASSA")).toEqual({ status: "resolved", port: "pozzuoli" });
    expect(resolveIslandPort("formula_medmar_pozzuoli", "Casamicciola")).toEqual({ status: "resolved", port: "casamicciola" });
    expect(resolveIslandPort("formula_medmar_pozzuoli", "Ischia Porto")).toEqual({ status: "resolved", port: "ischia" });
  });

  it("F. porto ambiguo o assente -> unknown, nessun fallback", () => {
    for (const mp of ["Napoli Beverello", "Napoli", "Ischia Porto", "Casamicciola", "Porta di Massa / Pozzuoli"]) {
      expect(resolveMainlandPort("transfer_port_hotel", mp)).toEqual({ status: "unknown", reason: "unmapped_meeting_point" });
      expect(resolveLegRouteCode({ bookingServiceKind: "transfer_port_hotel", direction: "arrival", meetingPoint: mp }).status).toBe("unknown");
    }
    expect(resolveMainlandPort("transfer_port_hotel", null)).toEqual({ status: "unknown", reason: "missing_meeting_point" });
    expect(resolveMainlandPort("transfer_port_hotel", "   ")).toEqual({ status: "unknown", reason: "missing_meeting_point" });
  });
});
