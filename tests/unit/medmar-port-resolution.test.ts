import { describe, it, expect } from "vitest";
import { resolveMainlandPort, resolveIslandPort, resolveIslandPortFromSchedules, resolveLegRouteCode } from "@/lib/server/medmar-booking/port-resolution";
import type { FerryScheduleRow } from "@/lib/ferry-schedule-options";

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
  it("A. MEDMAR + PORTO DI NAPOLI PORTA DI MASSA -> mainland napoli; isola SOLO dalla corsa canonica, nessun fallback fisso", () => {
    const mp = "PORTO DI NAPOLI PORTA DI MASSA";
    expect(resolveMainlandPort("transfer_port_hotel", mp)).toEqual({ status: "resolved", port: "napoli" });
    expect(resolveIslandPort("transfer_port_hotel", mp)).toEqual({ status: "unknown", reason: "missing_island_port" });
    expect(resolveLegRouteCode({ bookingServiceKind: "transfer_port_hotel", direction: "arrival", meetingPoint: mp })).toEqual({
      status: "unknown", reason: "missing_island_port",
    });
    expect(resolveLegRouteCode({
      bookingServiceKind: "transfer_port_hotel", direction: "arrival", meetingPoint: mp,
      scheduleIslandPort: { status: "resolved", port: "ischia" },
    })).toEqual({ status: "resolved", routeCode: "napoli_ischia", mainlandPort: "napoli", islandPort: "ischia" });
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

describe("port-resolution — resolveIslandPortFromSchedules (ferry_schedules canonico)", () => {
  function row(departure_port: string, arrival_port: string, time: string, direction: FerryScheduleRow["direction"], overrides: Partial<FerryScheduleRow> = {}): FerryScheduleRow {
    return { company: "medmar", departure_port, arrival_port, departure_time: `${time}:00`, direction, days_of_week: null, valid_from: null, valid_to: null, ...overrides };
  }
  // Righe Medmar Pozzuoli del seed supabase/migrations/0089_ferry_schedules.sql.
  const SCHEDULES: FerryScheduleRow[] = [
    row("napoli_beverello", "ischia_porto", "08:40", "mainland_to_ischia"),
    row("napoli_beverello", "ischia_porto", "14:20", "mainland_to_ischia"),
    row("napoli_beverello", "ischia_porto", "19:00", "mainland_to_ischia"),
    row("pozzuoli", "ischia_porto", "09:40", "mainland_to_ischia"),
    row("pozzuoli", "casamicciola", "08:15", "mainland_to_ischia"),
    row("ischia_porto", "pozzuoli", "11:10", "ischia_to_mainland"),
    row("casamicciola", "pozzuoli", "10:10", "ischia_to_mainland"),
    row("ischia_porto", "napoli_beverello", "10:35", "ischia_to_mainland"),
    row("pozzuoli", "ischia_porto", "06:25", "mainland_to_ischia", { days_of_week: [1, 2, 3, 4, 5] }),
    row("pozzuoli", "casamicciola", "09:40", "mainland_to_ischia", { company: "snav" }),
  ];
  const lookup = (direction: "arrival" | "departure", departureTime: string | null, date = "2026-04-04", schedules: FerryScheduleRow[] | null = SCHEDULES) =>
    resolveIslandPortFromSchedules(schedules, { mainlandPort: "pozzuoli", direction, departureTime, date });

  it("Napoli: andata 08:40 / 14:20 / 19:00 -> ischia, ritorno 10:35 -> ischia; orario Pozzuoli non vale per Napoli", () => {
    const napoli = (direction: "arrival" | "departure", departureTime: string) =>
      resolveIslandPortFromSchedules(SCHEDULES, { mainlandPort: "napoli", direction, departureTime, date: "2026-10-08" });
    for (const t of ["08:40", "14:20", "19:00"]) expect(napoli("arrival", t)).toEqual({ status: "resolved", port: "ischia" });
    expect(napoli("departure", "10:35")).toEqual({ status: "resolved", port: "ischia" });
    expect(napoli("arrival", "09:40")).toEqual({ status: "unknown", reason: "no_schedule_match" });
    expect(napoli("departure", "11:10")).toEqual({ status: "unknown", reason: "no_schedule_match" });
  });

  it("andata Pozzuoli: 09:40 -> ischia, 08:15 -> casamicciola (le righe non Medmar sono ignorate)", () => {
    expect(lookup("arrival", "09:40")).toEqual({ status: "resolved", port: "ischia" });
    expect(lookup("arrival", "08:15")).toEqual({ status: "resolved", port: "casamicciola" });
  });

  it("ritorno verso Pozzuoli: 11:10 -> ischia, 10:10 -> casamicciola; la corsa per Napoli non conta", () => {
    expect(lookup("departure", "11:10")).toEqual({ status: "resolved", port: "ischia" });
    expect(lookup("departure", "10:10")).toEqual({ status: "resolved", port: "casamicciola" });
    expect(lookup("departure", "10:35")).toEqual({ status: "unknown", reason: "no_schedule_match" });
  });

  it("nessuna corsa più vicina: orario non presente o direzione sbagliata -> no_schedule_match", () => {
    expect(lookup("arrival", "09:45")).toEqual({ status: "unknown", reason: "no_schedule_match" });
    expect(lookup("departure", "09:40")).toEqual({ status: "unknown", reason: "no_schedule_match" });
  });

  it("days_of_week / validità: corsa feriale di domenica -> no_schedule_match", () => {
    expect(lookup("arrival", "06:25", "2026-04-06")).toEqual({ status: "resolved", port: "ischia" });
    expect(lookup("arrival", "06:25", "2026-04-05")).toEqual({ status: "unknown", reason: "no_schedule_match" });
    const seasonal = [row("pozzuoli", "ischia_porto", "09:40", "mainland_to_ischia", { valid_from: "2026-05-01", valid_to: "2026-09-15" })];
    expect(lookup("arrival", "09:40", "2026-04-04", seasonal)).toEqual({ status: "unknown", reason: "no_schedule_match" });
  });

  it("stesso orario con porti isolani diversi -> ambiguous_schedule_match", () => {
    const ambiguous = [...SCHEDULES, row("pozzuoli", "casamicciola", "09:40", "mainland_to_ischia")];
    expect(lookup("arrival", "09:40", "2026-04-04", ambiguous)).toEqual({ status: "unknown", reason: "ambiguous_schedule_match" });
  });

  it("tabella non disponibile, orario mancante o porto non mappato -> unknown", () => {
    expect(lookup("arrival", "09:40", "2026-04-04", null)).toEqual({ status: "unknown", reason: "schedules_unavailable" });
    expect(lookup("arrival", null)).toEqual({ status: "unknown", reason: "missing_ferry_time" });
    expect(lookup("arrival", "09:40", "2026-04-04", [row("pozzuoli", "forio", "09:40", "mainland_to_ischia")])).toEqual({ status: "unknown", reason: "unmapped_schedule_port" });
  });

  it("resolveLegRouteCode: transfer_port_hotel Pozzuoli usa il porto dalla tabella; senza esito resta missing_island_port", () => {
    const base = { bookingServiceKind: "transfer_port_hotel", direction: "arrival", meetingPoint: "PORTO DI POZZUOLI" };
    expect(resolveLegRouteCode({ ...base, scheduleIslandPort: { status: "resolved", port: "casamicciola" } })).toEqual({
      status: "resolved", routeCode: "pozzuoli_casamicciola", mainlandPort: "pozzuoli", islandPort: "casamicciola",
    });
    expect(resolveLegRouteCode({ ...base, scheduleIslandPort: { status: "unknown", reason: "no_schedule_match" } })).toEqual({ status: "unknown", reason: "missing_island_port" });
    expect(resolveLegRouteCode(base)).toEqual({ status: "unknown", reason: "missing_island_port" });
  });

  it("transfer_port_hotel Napoli segue l'esito della tabella; formula_medmar_* e SNAV lo ignorano", () => {
    const casamicciola = { status: "resolved", port: "casamicciola" } as const;
    expect(resolveIslandPort("transfer_port_hotel", "PORTO DI NAPOLI PORTA DI MASSA", { status: "resolved", port: "ischia" })).toEqual({ status: "resolved", port: "ischia" });
    expect(resolveIslandPort("transfer_port_hotel", "PORTO DI NAPOLI PORTA DI MASSA", { status: "unknown", reason: "no_schedule_match" })).toEqual({ status: "unknown", reason: "missing_island_port" });
    expect(resolveIslandPort("formula_medmar_napoli", null, casamicciola)).toEqual({ status: "resolved", port: "ischia" });
    expect(resolveIslandPort("formula_medmar_pozzuoli", "Ischia Porto", casamicciola)).toEqual({ status: "resolved", port: "ischia" });
    expect(resolveIslandPort("formula_snav", "Casamicciola", casamicciola)).toEqual({ status: "unknown", reason: "unmapped_booking_service_kind" });
  });
});
