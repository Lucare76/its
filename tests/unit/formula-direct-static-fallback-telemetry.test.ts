import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { applyPickupCalc } from "@/lib/server/apply-pickup-calc";
import { recalculateDirectFormulaPickupForEdit } from "@/lib/server/recalculate-formula-pickup";

/**
 * STEP C — telemetria del fallback statico Formula direct (formula_snav,
 * formula_medmar_napoli, formula_medmar_pozzuoli). Un evento strutturato
 * "formula_direct_static_fallback" deve comparire SOLO quando:
 *  - il chiamante ha passato un `context` DB (ferry_pickup_rules caricate);
 *  - resolveOperationalConnection NON produce una regola canonica;
 *  - il kind e' realmente Formula direct (mai train/flight, mai
 *    transfer_port_hotel).
 * Il risultato funzionale di applyPickupCalc (pickup_hotel/pickup_alert) deve
 * restare IDENTICO a prima di Step C in ogni scenario.
 */

type DirectRuleOverrides = Partial<{
  id: string;
  agency_logic: "aleste" | "sosandra";
  company: "snav" | "medmar";
  hotel_id: string | null;
  zone: string | null;
  departure_time: string;
  pickup_time: string | null;
  embark_port: string | null;
  arrival_port: string;
  valid_from: string | null;
  valid_to: string | null;
  days_of_week: number[] | null;
}>;

function directRule(overrides: DirectRuleOverrides = {}) {
  return {
    id: overrides.id ?? "rule-1",
    agency_logic: overrides.agency_logic ?? "aleste",
    transport_type: "direct",
    direction: "from_ischia",
    boat_type: "aliscafo",
    hotel_id: overrides.hotel_id ?? null,
    zone: overrides.zone ?? "ischia",
    transport_from: null,
    transport_to: null,
    company: overrides.company ?? "snav",
    departure_time: overrides.departure_time ?? "07:10",
    embark_port: overrides.embark_port ?? "casamicciola",
    arrival_port: overrides.arrival_port ?? "napoli_beverello",
    arrival_time: null,
    pickup_time: overrides.pickup_time === undefined ? "06:30" : overrides.pickup_time,
    valid_from: overrides.valid_from ?? null,
    valid_to: overrides.valid_to ?? null,
    days_of_week: overrides.days_of_week ?? null,
  };
}

/** Estrae solo i console.warn che sono l'evento strutturato Step C (JSON valido con quel `event`). */
function fallbackTelemetryCalls(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls
    .map((args) => {
      try {
        return JSON.parse(String(args[0]));
      } catch {
        return null;
      }
    })
    .filter((parsed): parsed is Record<string, unknown> => parsed?.event === "formula_direct_static_fallback");
}

describe("Step C — telemetria fallback statico Formula direct", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // A. Formula MEDMAR con direct DB match -> telemetry 0
  it("A. formula_medmar_napoli con direct rule DB trovata: nessuna telemetria di fallback, pickup dalla regola DB", () => {
    const directRules = [directRule({
      company: "medmar", zone: "ischia", departure_time: "17:00", pickup_time: "15:30",
      embark_port: "ischia_porto", arrival_port: "napoli_beverello",
    })];
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "formula_medmar_napoli",
      time: "17:00",
      billing_party_name: "Aleste Turismo",
      hotel_zone: "ischia",
      context: { operationalRules: directRules as never, ferrySchedules: [], date: "2026-08-27", hotelId: "hotel-1" },
    });
    expect(result.pickup_hotel).toBe("15:30");
    expect(fallbackTelemetryCalls(warnSpy)).toHaveLength(0);
  });

  // B. Formula SNAV con direct DB match -> telemetry 0
  it("B. formula_snav con direct rule DB trovata: nessuna telemetria di fallback, pickup dalla regola DB", () => {
    const directRules = [directRule({ company: "snav", zone: "ischia", departure_time: "07:10", pickup_time: "06:20" })];
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "formula_snav",
      time: "07:10",
      billing_party_name: "Aleste Turismo",
      hotel_zone: "ischia",
      context: { operationalRules: directRules as never, ferrySchedules: [], date: "2026-08-27", hotelId: "hotel-1" },
    });
    expect(result.pickup_hotel).toBe("06:20");
    expect(fallbackTelemetryCalls(warnSpy)).toHaveLength(0);
  });

  // C. Formula MEDMAR DB no-match + static fallback -> telemetry 1
  it("C. formula_medmar_napoli senza direct rule DB: fallback statico invariato (15:30) + 1 telemetria reason=no_match", () => {
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "formula_medmar_napoli",
      time: "17:00",
      billing_party_name: "Aleste Turismo",
      hotel_zone: "ischia",
      context: { operationalRules: [], ferrySchedules: [], date: "2026-08-27", hotelId: "hotel-1" },
    });
    expect(result.pickup_hotel).toBe("15:30");
    const events = fallbackTelemetryCalls(warnSpy);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "formula_direct_static_fallback",
      booking_service_kind: "formula_medmar_napoli",
      direction: "departure",
      date: "2026-08-27",
      time: "17:00",
      hotel_id: "hotel-1",
      zone: "ischia",
      reason: "no_match",
    });
  });

  // D. Formula SNAV DB no-match + static fallback -> telemetry 1
  it("D. formula_snav senza direct rule DB: fallback statico invariato (06:30) + 1 telemetria reason=no_match", () => {
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "formula_snav",
      time: "07:10",
      billing_party_name: "Aleste Turismo",
      hotel_zone: "ischia",
      context: { operationalRules: [], ferrySchedules: [], date: "2026-08-27", hotelId: "hotel-1" },
    });
    expect(result.pickup_hotel).toBe("06:30");
    const events = fallbackTelemetryCalls(warnSpy);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "formula_direct_static_fallback", booking_service_kind: "formula_snav", reason: "no_match" });
  });

  // D-bis. rulesLoadError=true -> reason=db_error, pickup invariato (stesso fallback statico)
  it("D-bis. rulesLoadError=true (query fallita) produce reason=db_error, ma il pickup resta lo stesso fallback statico", () => {
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "formula_snav",
      time: "07:10",
      billing_party_name: "Aleste Turismo",
      hotel_zone: "ischia",
      context: { operationalRules: [], ferrySchedules: [], date: "2026-08-27", hotelId: "hotel-1", rulesLoadError: true },
    });
    expect(result.pickup_hotel).toBe("06:30");
    const events = fallbackTelemetryCalls(warnSpy);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: "db_error" });
  });

  // E. train/flight -> telemetry 0
  it("E. transfer_train_hotel non produce mai la telemetria Formula, con o senza direct rule presenti", () => {
    applyPickupCalc({
      direction: "departure",
      booking_service_kind: "transfer_train_hotel",
      time: "14:00",
      billing_party_name: "Aleste Turismo",
      vessel: "TRENO",
    });
    expect(fallbackTelemetryCalls(warnSpy)).toHaveLength(0);
  });

  // F. transfer_port_hotel -> telemetry 0
  it("F. transfer_port_hotel senza direct rule DB non produce la telemetria Formula (resta sul warning legacy)", () => {
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "transfer_port_hotel",
      time: "17:00",
      billing_party_name: "Aleste Turismo",
      vessel: "MEDMAR",
      hotel_zone: "ischia",
      context: { operationalRules: [], ferrySchedules: [], date: "2026-08-27", hotelId: "hotel-1" },
    });
    // Comportamento di calcolo invariato: stesso fallback statico di sempre.
    expect(result.pickup_hotel).toBe("15:30");
    expect(fallbackTelemetryCalls(warnSpy)).toHaveLength(0);
    // Il warning legacy (non strutturato Step C) continua a essere emesso.
    expect(warnSpy).toHaveBeenCalled();
  });

  // G. nessun dato PII nell'evento
  it("G. l'evento di telemetria non contiene mai customer_name/phone/email/notes", () => {
    applyPickupCalc({
      direction: "departure",
      booking_service_kind: "formula_medmar_napoli",
      time: "17:00",
      billing_party_name: "Aleste Turismo",
      hotel_zone: "ischia",
      context: { operationalRules: [], ferrySchedules: [], date: "2026-08-27", hotelId: "hotel-1" },
    });
    const events = fallbackTelemetryCalls(warnSpy);
    expect(events).toHaveLength(1);
    const keys = Object.keys(events[0]!);
    for (const forbidden of ["customer_name", "phone", "email", "notes", "customer_phone", "customer_email"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  // H. stesso punto centralizzato copre CREATE (applyPickupCalc diretto, come new-booking)
  // e EDIT (recalculateDirectFormulaPickupForEdit, Step B) senza logging duplicato negli endpoint.
  it("H. CREATE (applyPickupCalc) e EDIT (recalculateDirectFormulaPickupForEdit) emettono lo STESSO evento centralizzato", async () => {
    // CREATE: chiamata diretta come farebbe new-booking/route.ts.
    applyPickupCalc({
      direction: "departure",
      booking_service_kind: "formula_medmar_napoli",
      time: "17:00",
      billing_party_name: "Aleste Turismo",
      hotel_zone: "ischia",
      context: { operationalRules: [], ferrySchedules: [], date: "2026-08-27", hotelId: "hotel-1" },
    });
    const createEvents = fallbackTelemetryCalls(warnSpy);
    expect(createEvents).toHaveLength(1);

    warnSpy.mockClear();

    // EDIT: passa dall'helper Step B, che a sua volta chiama applyPickupCalc
    // — nessuna logica di telemetria duplicata nell'helper stesso.
    const fakeAdmin = {
      from(table: string) {
        if (table === "ferry_pickup_rules") {
          return { select: () => ({ then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r) }) };
        }
        if (table === "ferry_schedules") {
          return { select: () => ({ then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r) }) };
        }
        if (table === "hotels") {
          const b: Record<string, unknown> = {};
          b.select = () => b;
          b.eq = () => b;
          b.maybeSingle = async () => ({ data: { id: "hotel-1", name: "Hotel Test", zone: "ischia" }, error: null });
          return b;
        }
        throw new Error(`unexpected table ${table}`);
      },
    } as never;

    const editResult = await recalculateDirectFormulaPickupForEdit(
      fakeAdmin,
      {
        booking_service_kind: "formula_medmar_napoli", direction: "departure",
        hotel_id: "hotel-1", billing_party_name: "Aleste Turismo",
        orario_barca: "17:00", departure_date: "2026-08-27", departure_time: "17:00", date: "2026-08-27",
      },
      {
        booking_service_kind: "formula_medmar_napoli", direction: "departure",
        hotel_id: "hotel-2", billing_party_name: "Aleste Turismo",
        orario_barca: "17:00", departure_date: "2026-08-27", departure_time: "17:00", date: "2026-08-27",
      }
    );
    expect(editResult?.pickup_hotel).toBe("15:30");
    const editEvents = fallbackTelemetryCalls(warnSpy);
    expect(editEvents).toHaveLength(1);
    expect(editEvents[0]).toMatchObject({ event: "formula_direct_static_fallback", booking_service_kind: "formula_medmar_napoli" });
  });
});
