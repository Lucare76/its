import { describe, expect, it } from "vitest";
import {
  resolveOperationalConnection,
  type OperationalPickupRule,
  type OperationalConnectionInput,
} from "@/lib/operational-connection-resolver";
import type { FerryScheduleRow, ConnectionRecord } from "@/lib/travel-connection-resolver";

const DATE = "2026-08-27";
const HOTEL_COLELLA_ID = "hotel-colella-uuid";
const HOTEL_LA_VILLA_ID = "hotel-la-villa-uuid";

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

// Regola Suorato — hotel-specifica (Livello 1), NON di zona: cosi' non intercetta
// altri hotel Forio come LA VILLA (vedi sezione LA VILLA sotto).
const COLELLA_RULE = rule({ hotel_id: HOTEL_COLELLA_ID, zone: "forio" });
const COLELLA_SCHEDULE = [ferryRow({})];

describe("resolveOperationalConnection — SUORATO / HOTEL TERME COLELLA (regola hotel-specifica)", () => {
  const baseInput: OperationalConnectionInput = {
    direction: "from_ischia",
    bookingServiceKind: "transfer_train_hotel",
    transportTime: "14:00",
    date: DATE,
    hotelId: HOTEL_COLELLA_ID,
    zone: "forio",
    agencyName: "ALESTE VIAGGI",
    operationalRules: [COLELLA_RULE],
    ferrySchedules: COLELLA_SCHEDULE,
  };

  it("propone pickup 09:00 e Medmar 10:35 Ischia Porto -> Napoli Beverello, confidence ALTA", () => {
    const result = resolveOperationalConnection(baseInput);
    expect(result.pickupTime).toBe("09:00");
    expect(result.company).toBe("medmar");
    expect(result.ferryDepartureTime).toBe("10:35");
    expect(result.embarkPort).toBe("ischia_porto");
    expect(result.arrivalPort).toBe("napoli_beverello");
    expect(result.source).toBe("canonical_rule");
    expect(result.confidence).toBe("ALTA");
  });

  it("e' deterministico: chiamate ripetute danno sempre lo stesso risultato", () => {
    const a = resolveOperationalConnection(baseInput);
    const b = resolveOperationalConnection(baseInput);
    expect(a).toEqual(b);
  });

  it("se la corsa configurata non esiste in ferry_schedules per la data, mantiene la proposta con warning esplicito", () => {
    const result = resolveOperationalConnection({ ...baseInput, ferrySchedules: [] });
    expect(result.pickupTime).toBe("09:00");
    expect(result.ferryScheduleId).toBeNull();
    expect(result.confidence).toBe("BASSA");
    expect(result.warnings.some((w) => w.includes("CORSA CONFIGURATA NON DISPONIBILE"))).toBe(true);
  });
});

describe("resolveOperationalConnection — LA VILLA (stessa zona/agenzia/fascia di Colella, ma NON deve prendere la sua regola)", () => {
  it("senza hotelId Colella, la regola hotel-specifica non fa match: nessuna regola canonica -> fallback legacy, mai 09:00/10:35 di Colella", () => {
    const result = resolveOperationalConnection({
      direction: "from_ischia",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "13:20", // stessa fascia 13:20-16:50 di Colella
      date: DATE,
      hotelId: HOTEL_LA_VILLA_ID, // LODI BARBARA / CATULLO LUCIA — hotel diverso
      zone: "forio", // stessa zona di Colella
      agencyName: "ALESTE VIAGGI", // stessa agenzia
      operationalRules: [COLELLA_RULE],
      ferrySchedules: COLELLA_SCHEDULE,
    });
    expect(result.source).not.toBe("canonical_rule");
    expect(result.pickupTime).not.toBe("09:00");
  });
});

describe("resolveOperationalConnection — gerarchia HOTEL > ZONA > GENERALE", () => {
  const zoneRule = rule({ hotel_id: null, zone: "forio", pickup_time: "08:30", departure_time: "10:10", arrival_port: "pozzuoli", embark_port: "casamicciola" });
  const generalRule = rule({ hotel_id: null, zone: null, pickup_time: "07:00", departure_time: "08:10", arrival_port: "pozzuoli", embark_port: "ischia_porto" });

  it("con hotel_id noto e regola hotel-specifica presente, vince la regola hotel anche se esiste anche una regola di zona", () => {
    const result = resolveOperationalConnection({
      direction: "from_ischia",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "14:00",
      date: DATE,
      hotelId: HOTEL_COLELLA_ID,
      zone: "forio",
      agencyName: "ALESTE VIAGGI",
      operationalRules: [generalRule, zoneRule, COLELLA_RULE],
      ferrySchedules: COLELLA_SCHEDULE,
    });
    expect(result.pickupTime).toBe("09:00");
    expect(result.ferryDepartureTime).toBe("10:35");
  });

  it("senza hotel_id (o hotel non mappato), vince la regola di zona sul jolly generale", () => {
    const result = resolveOperationalConnection({
      direction: "from_ischia",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "14:00",
      date: DATE,
      hotelId: "hotel-senza-regola-dedicata",
      zone: "forio",
      agencyName: "ALESTE VIAGGI",
      operationalRules: [generalRule, zoneRule, COLELLA_RULE],
      ferrySchedules: [ferryRow({ departure_time: "10:10", arrival_port: "pozzuoli", departure_port: "casamicciola" })],
    });
    expect(result.pickupTime).toBe("08:30");
    expect(result.ferryDepartureTime).toBe("10:10");
  });

  it("senza hotel_id e senza zona riconosciuta/matchata, vince la regola generale (jolly)", () => {
    const result = resolveOperationalConnection({
      direction: "from_ischia",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "14:00",
      date: DATE,
      hotelId: "hotel-senza-regola-dedicata",
      zone: "barano", // nessuna regola per questa zona
      agencyName: "ALESTE VIAGGI",
      operationalRules: [generalRule, zoneRule, COLELLA_RULE],
      ferrySchedules: [ferryRow({ departure_time: "08:10", arrival_port: "pozzuoli", departure_port: "ischia_porto" })],
    });
    expect(result.pickupTime).toBe("07:00");
    expect(result.ferryDepartureTime).toBe("08:10");
  });
});

describe("resolveOperationalConnection — zone non riconosciute (UNKNOWN_HOTEL_ZONE)", () => {
  it("zona non canonica (es. Serrara Fontana) NON cade silenziosamente su 'ischia': warning esplicito, nessun match sulle regole di zona", () => {
    const zoneRule = rule({ hotel_id: null, zone: "ischia", pickup_time: "07:20" });
    const generalRule = rule({ hotel_id: null, zone: null, pickup_time: "06:00", departure_time: "07:00" });
    const result = resolveOperationalConnection({
      direction: "from_ischia",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "14:00",
      date: DATE,
      hotelId: "hotel-serrara-fontana",
      zone: "ischia", // valore derivato per fallback muto legacy — MA dichiarato non affidabile
      zoneRecognized: false,
      agencyName: "ALESTE VIAGGI",
      operationalRules: [zoneRule, generalRule],
      ferrySchedules: [],
    });
    expect(result.warnings.some((w) => w.includes("UNKNOWN_HOTEL_ZONE"))).toBe(true);
    // non deve aver preso la regola di zona "ischia" (che sarebbe un fallback silenzioso mascherato)
    expect(result.pickupTime).not.toBe("07:20");
    expect(result.pickupTime).toBe("06:00"); // solo il jolly generale resta candidato
  });
});

describe("resolveOperationalConnection — BIRAGO (override manuale preservato, nessuna generalizzazione)", () => {
  it("l'override manuale SNAV 09:45 resta il valore applicato anche se esiste una regola canonica diversa", () => {
    const manualOverride: ConnectionRecord = {
      schedule_id: "snav-0945",
      company: "snav",
      ferry_type: "aliscafo",
      departure_time: "09:45",
      arrival_time: "10:50",
      embark_port: "casamicciola",
      arrival_port: "napoli_beverello",
      source: "manual",
      manually_overridden: true,
    };
    const result = resolveOperationalConnection({
      direction: "from_ischia",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "12:10",
      date: DATE,
      zone: "ischia",
      agencyName: null,
      operationalRules: [COLELLA_RULE],
      ferrySchedules: COLELLA_SCHEDULE,
      currentOverride: manualOverride,
    });
    expect(result.source).toBe("manual_override");
    expect(result.company).toBe("snav");
    expect(result.ferryDepartureTime).toBe("09:45");
    expect(result.newProposal).toBeDefined();
  });

  it("senza override, l'eccezione SNAV di Birago NON si generalizza automaticamente a tutti gli Aleste", () => {
    const result = resolveOperationalConnection({
      direction: "from_ischia",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "12:10",
      date: DATE,
      zone: "ischia",
      agencyName: "ALESTE VIAGGI",
      operationalRules: [],
      ferrySchedules: [
        ferryRow({ id: "medmar-x", departure_time: "10:10", arrival_time: "11:15" }),
        ferryRow({ id: "snav-x", company: "snav", departure_time: "09:45", arrival_time: "10:50" }),
      ],
    });
    expect(result.source).toBe("legacy_fallback");
    expect(result.company).toBe("medmar");
  });
});

describe("resolveOperationalConnection — Sosandra ammette aliscafo automaticamente", () => {
  it("una regola canonica aliscafo per Sosandra viene proposta senza bisogno di override", () => {
    const sosandraRule = rule({
      agency_logic: "sosandra",
      boat_type: "aliscafo",
      hotel_id: null,
      zone: null,
      company: "alilauro",
      departure_time: "11:45",
      arrival_port: "napoli_beverello",
      pickup_time: "09:00",
    });
    const result = resolveOperationalConnection({
      direction: "from_ischia",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "14:00",
      date: DATE,
      zone: "ischia",
      agencyName: "SOSANDRA TOUR",
      operationalRules: [sosandraRule],
      ferrySchedules: [ferryRow({ id: "alil-1", company: "alilauro", departure_time: "11:45", arrival_time: "12:30" })],
    });
    expect(result.company).toBe("alilauro");
    expect(result.ferryType).toBe("aliscafo");
    expect(result.source).toBe("canonical_rule");
  });
});

describe("resolveOperationalConnection — ARRIVI (backward compatibility, immutati)", () => {
  it("regola to_ischia esistente continua a funzionare identica dopo l'aggiunta di hotel_id/zone (entrambi null = jolly)", () => {
    const arrivalRule: OperationalPickupRule = {
      agency_logic: "aleste",
      transport_type: "flight",
      direction: "to_ischia",
      boat_type: "traghetto",
      hotel_id: null,
      zone: null,
      transport_from: "07:00",
      transport_to: "08:00",
      company: "medmar",
      departure_time: "08:40",
      embark_port: null,
      arrival_port: "ischia_porto",
      arrival_time: "10:00",
      pickup_time: null,
      valid_from: null,
      valid_to: null,
      days_of_week: null,
    };
    const result = resolveOperationalConnection({
      direction: "to_ischia",
      bookingServiceKind: "transfer_airport_hotel",
      transportTime: "07:30",
      date: DATE,
      agencyName: "ALESTE VIAGGI",
      operationalRules: [arrivalRule],
      ferrySchedules: [ferryRow({ company: "medmar", departure_port: "pozzuoli", arrival_port: "ischia_porto", departure_time: "08:40", arrival_time: "10:00", direction: "mainland_to_ischia" })],
    });
    expect(result.company).toBe("medmar");
    expect(result.ferryDepartureTime).toBe("08:40");
    expect(result.source).toBe("canonical_rule");
    expect(result.confidence).toBe("ALTA");
  });
});

describe("resolveOperationalConnection — NIKOLAENKO (arrivo, confidence non definitiva)", () => {
  it("senza regola canonica configurata per 'Sun & sea', propone via motore legacy con confidence BASSA e warning esplicito", () => {
    const result = resolveOperationalConnection({
      direction: "to_ischia",
      bookingServiceKind: "transfer_airport_hotel",
      transportTime: "12:30",
      date: DATE,
      agencyName: "Sun & sea",
      operationalRules: [],
      ferrySchedules: [
        ferryRow({ id: "medmar-arr", departure_port: "pozzuoli", arrival_port: "ischia_porto", departure_time: "13:30", arrival_time: "14:35", direction: "mainland_to_ischia" }),
        ferryRow({ id: "snav-arr", company: "snav", departure_port: "napoli_beverello", arrival_port: "casamicciola", departure_time: "13:50", arrival_time: "14:55", direction: "mainland_to_ischia" }),
      ],
    });
    expect(result.source).toBe("legacy_fallback");
    expect(["BASSA", "NESSUNA"]).toContain(result.confidence);
    expect(result.confidence).not.toBe("ALTA");
  });
});

describe("resolveOperationalConnection — kind non treno/aereo", () => {
  it("nessun collegamento calcolato, confidence NESSUNA", () => {
    const result = resolveOperationalConnection({
      direction: "from_ischia",
      bookingServiceKind: "excursion",
      transportTime: "10:00",
      date: DATE,
      agencyName: "ALESTE VIAGGI",
      operationalRules: [],
      ferrySchedules: [],
    });
    expect(result.confidence).toBe("NESSUNA");
    expect(result.company).toBeNull();
  });
});
