import { describe, expect, it } from "vitest";
import { resolveOperationalTiming, type OperationalTimingContext } from "@/lib/operational-timing-resolver";
import { buildDeparturePrintRow } from "@/lib/piano-giorno-print";
import type { PrintService } from "@/lib/piano-giorno-print";
import type { OperationalPickupRule } from "@/lib/operational-connection-resolver";
import type { FerryScheduleRow } from "@/lib/travel-connection-resolver";

const DATE = "2026-08-27";

function service(overrides: Partial<PrintService> = {}): PrintService {
  return {
    id: "svc-1",
    tenant_id: "tenant-1",
    date: DATE,
    time: "17:00",
    direction: "departure",
    customer_name: "ROSSI MARIO",
    customer_first_name: null,
    customer_last_name: null,
    pax: 2,
    hotel_id: "hotel-1",
    vessel: "MEDMAR Napoli 17:00",
    phone: "333111222",
    notes: "",
    status: "new",
    service_type: "transfer",
    booking_service_kind: "formula_medmar_napoli",
    service_type_code: null,
    pickup_hotel: "14:20",
    pickup_time: null,
    arrival_time: "15:50",
    departure_time: "17:00",
    orario_barca: "16:00",
    barca_compagnia: "Ischia Porto",
    porto_bruno: null,
    meeting_point: "Ischia Porto",
    ferry_details: {},
    ...overrides,
  };
}

function ferryRow(overrides: Partial<FerryScheduleRow>): FerryScheduleRow {
  return {
    id: "sched-1",
    company: "medmar",
    departure_port: "ischia_porto",
    arrival_port: "napoli_beverello",
    departure_time: "10:35",
    arrival_time: "12:05",
    direction: "ischia_to_mainland",
    days_of_week: null,
    valid_from: null,
    valid_to: null,
    ...overrides,
  };
}

function rule(overrides: Partial<OperationalPickupRule>): OperationalPickupRule {
  return {
    agency_logic: "aleste",
    transport_type: "train",
    direction: "from_ischia",
    boat_type: "traghetto",
    hotel_id: null,
    zone: null,
    transport_from: "13:20",
    transport_to: "16:50",
    company: "medmar",
    departure_time: "10:35",
    embark_port: "ischia_porto",
    arrival_port: "napoli_beverello",
    arrival_time: "12:05",
    pickup_time: "09:00",
    valid_from: null,
    valid_to: null,
    days_of_week: null,
    ...overrides,
  };
}

describe("resolveOperationalTiming — 1. pickup_hotel valido", () => {
  it("usa pickup_hotel persistito, status ok, ruleSource dichiara la fonte", () => {
    const result = resolveOperationalTiming(service({ pickup_hotel: "08:55" }));
    expect(result.pickupTime).toBe("08:55");
    expect(result.pickupSource).toBe("pickup_hotel");
    expect(result.status).toBe("ok");
    expect(result.ruleSource).toContain("pickup_hotel");
  });
});

describe("resolveOperationalTiming — 2/3. pickup mancante: mai 00:00, sempre null + warning", () => {
  it("pickup_hotel e pickup_time entrambi assenti -> pickupTime null, status warning, mai '00:00'", () => {
    const result = resolveOperationalTiming(service({ pickup_hotel: null, pickup_time: null }));
    expect(result.pickupTime).toBeNull();
    expect(result.pickupTime).not.toBe("00:00");
    expect(result.pickupSource).toBe("missing");
    expect(result.status).toBe("warning");
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("resolveOperationalTiming — 4. partenza con volo (context con regola canonica)", () => {
  it("delega a resolveOperationalConnection: pickup dalla regola canonica, mai da service.time", () => {
    const flightRule = rule({ transport_type: "flight", transport_from: "11:00", transport_to: "13:00", pickup_time: "09:30" });
    const context: OperationalTimingContext = {
      operationalRules: [flightRule],
      ferrySchedules: [ferryRow({})],
      agencyName: "ALESTE VIAGGI",
    };
    const svc = service({ booking_service_kind: "transfer_airport_hotel", departure_time: "12:00", time: "12:00", pickup_hotel: null });
    const result = resolveOperationalTiming(svc, context);
    expect(result.pickupTime).toBe("09:30");
    expect(result.pickupSource).toBe("canonical_rule");
    expect(result.connectionType).toBe("flight");
    expect(result.pickupTime).not.toBe(svc.time);
  });
});

describe("resolveOperationalTiming — 5. partenza con treno (context con regola canonica, caso SUORATO)", () => {
  it("delega a resolveOperationalConnection: pickup 09:00, Medmar 10:35, confidence riflessa nello status", () => {
    const hotelId = "hotel-colella-uuid";
    const colellaRule = rule({ hotel_id: hotelId, zone: "forio" });
    const context: OperationalTimingContext = {
      operationalRules: [colellaRule],
      ferrySchedules: [ferryRow({})],
      hotelId,
      zone: "forio",
      agencyName: "ALESTE VIAGGI",
    };
    const svc = service({ id: "suorato", booking_service_kind: "transfer_train_hotel", departure_time: "14:00", time: "14:00", pickup_hotel: null });
    const result = resolveOperationalTiming(svc, context);
    expect(result.pickupTime).toBe("09:00");
    expect(result.ferryCompany).toBe("medmar");
    expect(result.ferryTime).toBe("10:35");
    expect(result.connectionType).toBe("train");
    expect(result.status).toBe("ok");
  });
});

describe("resolveOperationalTiming — 6. servizio ferry diretto (Formula, nessun context)", () => {
  it("legge compagnia/ora nave dai dati persistiti (vessel/orario_barca), mai da resolveOperationalConnection (fuori scope treno/volo)", () => {
    const svc = service({ booking_service_kind: "formula_snav", vessel: "SNAV 17:40", orario_barca: "17:40", pickup_hotel: "16:45" });
    const result = resolveOperationalTiming(svc);
    expect(result.pickupTime).toBe("16:45");
    expect(result.ferryCompany).toBe("SNAV");
    expect(result.ferryTime).toBe("17:40");
    expect(result.connectionType).toBe("ferry");
  });
});

describe("resolveOperationalTiming — 7. SNAV Sosandra", () => {
  it("agenzia Sosandra: la regola canonica aliscafo viene proposta senza bisogno di override", () => {
    const snavRule = rule({ agency_logic: "sosandra", boat_type: "aliscafo", company: "snav", departure_time: "09:45", pickup_time: "08:40" });
    const context: OperationalTimingContext = {
      operationalRules: [snavRule],
      ferrySchedules: [ferryRow({ company: "snav", departure_time: "09:45", arrival_time: "10:50" })],
      agencyName: "SOSANDRA TOUR BY ROSSELLA VIAGGI S.r.L.",
    };
    const svc = service({ booking_service_kind: "transfer_train_hotel", departure_time: "14:00", time: "14:00", pickup_hotel: null });
    const result = resolveOperationalTiming(svc, context);
    expect(result.pickupTime).toBe("08:40");
    expect(result.ferryCompany).toBe("snav");
    expect(result.pickupSource).toBe("canonical_rule");
  });
});

describe("resolveOperationalTiming — 8. altra agenzia (non Sosandra): le regole canoniche non sono un privilegio esclusivo Sosandra", () => {
  it("una regola canonica 'aleste' (traghetto, es. Medmar) viene applicata esattamente come per Sosandra: canonical_rule non e' un percorso riservato", () => {
    const alesteRule = rule({ agency_logic: "aleste", boat_type: "traghetto", company: "medmar", pickup_time: "08:40" });
    const context: OperationalTimingContext = {
      operationalRules: [alesteRule],
      ferrySchedules: [ferryRow({})],
      agencyName: "ZIGOLOVIAGGI SRL",
    };
    const svc = service({ booking_service_kind: "transfer_train_hotel", departure_time: "14:00", time: "14:00", pickup_hotel: null });
    const result = resolveOperationalTiming(svc, context);
    expect(result.pickupTime).toBe("08:40");
    expect(result.pickupSource).toBe("canonical_rule");
  });

  it("1. Aleste + kind generico (nessuna richiesta esplicita aliscafo): una regola SNAV/aliscafo esiste a DB ma NON viene applicata, l'aliscafo non e' automatico", () => {
    const snavRuleAleste = rule({ agency_logic: "aleste", boat_type: "aliscafo", company: "snav", departure_time: "09:45", pickup_time: "08:40" });
    const context: OperationalTimingContext = {
      operationalRules: [snavRuleAleste],
      ferrySchedules: [ferryRow({ company: "snav", departure_time: "09:45", arrival_time: "10:50" })],
      agencyName: "ZIGOLOVIAGGI SRL",
    };
    // kind GENERICO (senza suffisso _aliscafo) = nessuna richiesta esplicita: comportamento di default Aleste (traghetto).
    const svc = service({ booking_service_kind: "transfer_train_hotel", departure_time: "14:00", time: "14:00", pickup_hotel: null });
    const result = resolveOperationalTiming(svc, context);
    expect(result.pickupSource).not.toBe("canonical_rule");
    expect(result.ferryCompany).not.toBe("snav");
  });

  it("2. Aleste + richiesta esplicita SNAV/aliscafo (booking_service_kind '_aliscafo'): la regola canonica configurata viene applicata", () => {
    const snavRuleAleste = rule({ agency_logic: "aleste", boat_type: "aliscafo", company: "snav", departure_time: "09:45", pickup_time: "08:40" });
    const context: OperationalTimingContext = {
      operationalRules: [snavRuleAleste],
      ferrySchedules: [ferryRow({ company: "snav", departure_time: "09:45", arrival_time: "10:50" })],
      agencyName: "ZIGOLOVIAGGI SRL",
    };
    // kind con suffisso _aliscafo = richiesta esplicita al momento della prenotazione (form agenzia/operatore).
    const svc = service({ booking_service_kind: "transfer_train_hotel_aliscafo", departure_time: "14:00", time: "14:00", pickup_hotel: null });
    const result = resolveOperationalTiming(svc, context);
    expect(result.pickupSource).toBe("canonical_rule");
    expect(result.ferryCompany).toBe("snav");
    expect(result.pickupTime).toBe("08:40");
    expect(result.status).toBe("ok");
  });

  it("2b. richiesta esplicita ma NESSUNA regola canonica configurata: cade nel fallback legacy, mai un'invenzione", () => {
    const context: OperationalTimingContext = {
      operationalRules: [], // nessuna regola per questa fascia/agenzia
      ferrySchedules: [ferryRow({ id: "medmar-x", company: "medmar", departure_time: "10:10", arrival_time: "11:15" })],
      agencyName: "ZIGOLOVIAGGI SRL",
    };
    const svc = service({ booking_service_kind: "transfer_train_hotel_aliscafo", departure_time: "14:00", time: "14:00", pickup_hotel: null });
    const result = resolveOperationalTiming(svc, context);
    expect(result.pickupSource).not.toBe("canonical_rule");
  });

  it("SENZA una regola canonica configurata, il fallback legacy resta Sosandra-only per l'aliscafo (dato commerciale reale, non un gate arbitrario): un'agenzia diversa senza regola cade su Medmar/traghetto, mai SNAV inventato", () => {
    const context: OperationalTimingContext = {
      operationalRules: [], // nessuna regola canonica configurata per questa agenzia/fascia
      ferrySchedules: [
        ferryRow({ id: "medmar-x", company: "medmar", departure_time: "10:10", arrival_time: "11:15" }),
        ferryRow({ id: "snav-x", company: "snav", departure_time: "09:45", arrival_time: "10:50" }),
      ],
      agencyName: "ALESTE VIAGGI",
    };
    const svc = service({ booking_service_kind: "transfer_train_hotel", departure_time: "12:10", time: "12:10", pickup_hotel: null });
    const result = resolveOperationalTiming(svc, context);
    expect(result.pickupSource).not.toBe("canonical_rule");
    expect(result.ferryCompany).not.toBe("snav");
  });
});

describe("resolveOperationalTiming — 9. porto-porto puro (Formula diretta, pickup_hotel legittimamente assente)", () => {
  it("non e' trattato come errore: connectionType 'ferry', status warning esplicito (non 'error'), nessun pickup inventato", () => {
    const svc = service({ booking_service_kind: "formula_medmar_napoli", pickup_hotel: null, pickup_time: null });
    const result = resolveOperationalTiming(svc);
    expect(result.connectionType).toBe("ferry");
    expect(result.pickupTime).toBeNull();
    expect(result.status).toBe("warning");
  });
});

describe("resolveOperationalTiming — 10. dati insufficienti", () => {
  it("nessun pickup, nessuna compagnia, nessun context: tutto null, warning esplicito, nessun dato inventato", () => {
    const svc = service({
      booking_service_kind: null,
      pickup_hotel: null,
      pickup_time: null,
      vessel: null,
      orario_barca: null,
      barca_compagnia: null,
      meeting_point: null,
      porto_bruno: null,
    });
    const result = resolveOperationalTiming(svc);
    expect(result.pickupTime).toBeNull();
    expect(result.ferryCompany).toBeNull();
    expect(result.ferryTime).toBeNull();
    expect(result.status).toBe("warning");
  });
});

describe("resolveOperationalTiming — 11. regola ferry non trovata (context presente ma nessun match)", () => {
  it("nessuna regola canonica applicabile alla fascia oraria -> fallback statico condiviso (legacy_static) quando calcolabile, mai un errore silenzioso", () => {
    const ruleOutsideWindow = rule({ transport_from: "06:00", transport_to: "08:00" });
    const context: OperationalTimingContext = {
      operationalRules: [ruleOutsideWindow],
      ferrySchedules: [ferryRow({})],
      agencyName: "Sun & sea",
    };
    const svc = service({ booking_service_kind: "transfer_train_hotel", departure_time: "18:00", time: "18:00", pickup_hotel: null });
    const result = resolveOperationalTiming(svc, context);
    expect(result.pickupSource).not.toBe("canonical_rule");
    // 18:00 rientra nella fascia statica ALESTE_TRENO_TRAGHETTO (16:55-18:40):
    // il fallback statico condiviso produce un pickup reale -> "legacy_static",
    // mai spacciato per una regola canonica DB.
    expect(["legacy_fallback", "legacy_static", "missing"]).toContain(result.pickupSource);
    expect(result.status).toBe("warning");
  });
});

describe("resolveOperationalTiming — 12. coerenza con il comportamento attuale della stampa /departures", () => {
  it("per lo stesso servizio, pickupTime/ferryCompany/ferryTime coincidono con quelli gia' prodotti da buildDeparturePrintRow (nessuna regressione)", () => {
    const svc = service({ booking_service_kind: "formula_medmar_napoli", vessel: "MEDMAR Napoli 17:00", orario_barca: "16:00", pickup_hotel: "14:20" });
    const printRow = buildDeparturePrintRow(svc, { agency: "-", driver: "-", vehicle: "-", notes: "-" });
    const timing = resolveOperationalTiming(svc);
    expect(timing.pickupTime).toBe(printRow.pickup);
    expect(timing.ferryTime).toBe(printRow.ferryOrTransportTime);
  });
});
