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

// Regola hotel-specifica (Livello 1) usata per testare la gerarchia
// hotel > zona > generale del matcher canonico. NON rappresenta più "hotel
// Colella determina il porto Napoli/Pozzuoli" — quell'ipotesi non era la
// regola reale di Mario (vedi lib/travel-connection-resolver.ts, sezione
// preferenza porto). Qui hotel_id resta un asse di specificità legittimo
// dello schema (es. un pickup_time confermato per un hotel specifico), del
// tutto indipendente dalla scelta Napoli/Pozzuoli.
const HOTEL_SPECIFIC_RULE = rule({ hotel_id: HOTEL_COLELLA_ID, zone: "forio" });
const HOTEL_SPECIFIC_SCHEDULE = [ferryRow({})];

describe("resolveOperationalConnection — regola hotel-specifica in DB (Livello 1 del matcher, non usata per scegliere il porto)", () => {
  const baseInput: OperationalConnectionInput = {
    direction: "from_ischia",
    bookingServiceKind: "transfer_train_hotel",
    transportTime: "14:00",
    date: DATE,
    hotelId: HOTEL_COLELLA_ID,
    zone: "forio",
    agencyName: "ALESTE VIAGGI",
    operationalRules: [HOTEL_SPECIFIC_RULE],
    ferrySchedules: HOTEL_SPECIFIC_SCHEDULE,
  };

  it("propone pickup 09:00 e Medmar 10:35 Ischia Porto -> Napoli Beverello, confidence ALTA (dato dalla regola DB configurata per quell'hotel, non da una logica hotel->porto)", () => {
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

describe("resolveOperationalConnection — LA VILLA (stessa zona/agenzia/fascia dell'hotel con regola dedicata, ma NON deve prendere la sua regola)", () => {
  it("senza hotelId dedicato, la regola hotel-specifica non fa match: nessuna regola canonica -> fallback legacy, mai 09:00/10:35 dell'altro hotel", () => {
    const result = resolveOperationalConnection({
      direction: "from_ischia",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "13:20", // stessa fascia 13:20-16:50 della regola dedicata
      date: DATE,
      hotelId: HOTEL_LA_VILLA_ID, // hotel diverso, nessuna regola propria
      zone: "forio", // stessa zona
      agencyName: "ALESTE VIAGGI", // stessa agenzia
      operationalRules: [HOTEL_SPECIFIC_RULE],
      ferrySchedules: HOTEL_SPECIFIC_SCHEDULE,
    });
    expect(result.source).not.toBe("canonical_rule");
    expect(result.pickupTime).not.toBe("09:00");
  });
});

describe("resolveOperationalConnection — SENZA regola canonica, la preferenza Napoli/Pozzuoli si applica via fallback legacy (regola reale di Mario, non hotel-based)", () => {
  it("nessuna regola DB configurata: il fallback legacy sceglie Napoli Beverello anche se Pozzuoli avrebbe margine maggiore, indipendentemente dall'hotel", () => {
    const bothMedmar: FerryScheduleRow[] = [
      ferryRow({ id: "medmar-pozzuoli", company: "medmar", departure_port: "casamicciola", arrival_port: "pozzuoli", departure_time: "10:10", arrival_time: "11:15" }),
      ferryRow({ id: "medmar-napoli", company: "medmar", departure_port: "ischia_porto", arrival_port: "napoli_beverello", departure_time: "10:35", arrival_time: "12:05" }),
    ];
    const result = resolveOperationalConnection({
      direction: "from_ischia",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "14:00",
      date: DATE,
      hotelId: "qualunque-hotel-senza-regola-dedicata",
      zone: "forio",
      agencyName: "ALESTE VIAGGI",
      operationalRules: [], // nessuna regola canonica configurata
      ferrySchedules: bothMedmar,
    });
    expect(result.source).toBe("legacy_fallback");
    expect(result.company).toBe("medmar");
    expect(result.ferryDepartureTime).toBe("10:35");
    expect(result.arrivalPort).toBe("napoli_beverello");
  });

  it("Pozzuoli come fallback (nessuna corsa Napoli) richiede pax <= 8, propagato dall'input", () => {
    const onlyPozzuoli: FerryScheduleRow[] = [
      ferryRow({ id: "medmar-pozzuoli", company: "medmar", departure_port: "casamicciola", arrival_port: "pozzuoli", departure_time: "10:10", arrival_time: "11:15" }),
    ];
    const withPax4 = resolveOperationalConnection({
      direction: "from_ischia",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "14:00",
      date: DATE,
      zone: "forio",
      agencyName: "ALESTE VIAGGI",
      operationalRules: [],
      ferrySchedules: onlyPozzuoli,
      pax: 4,
    });
    expect(withPax4.company).toBe("medmar");
    expect(withPax4.arrivalPort).toBe("pozzuoli");

    const withPax9 = resolveOperationalConnection({
      direction: "from_ischia",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "14:00",
      date: DATE,
      zone: "forio",
      agencyName: "ALESTE VIAGGI",
      operationalRules: [],
      ferrySchedules: onlyPozzuoli,
      pax: 9,
    });
    expect(withPax9.confidence).toBe("NESSUNA");
    expect(withPax9.company).toBeNull();
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
      operationalRules: [generalRule, zoneRule, HOTEL_SPECIFIC_RULE],
      ferrySchedules: HOTEL_SPECIFIC_SCHEDULE,
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
      operationalRules: [generalRule, zoneRule, HOTEL_SPECIFIC_RULE],
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
      operationalRules: [generalRule, zoneRule, HOTEL_SPECIFIC_RULE],
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
      operationalRules: [HOTEL_SPECIFIC_RULE],
      ferrySchedules: HOTEL_SPECIFIC_SCHEDULE,
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
      transportTime: "13:00",
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

describe("resolveOperationalConnection — Sosandra: aliscafo solo su richiesta esplicita (mai automatico per agenzia)", () => {
  it("una regola canonica aliscafo per Sosandra NON viene applicata senza richiesta esplicita (kind generico): cade sul fallback legacy", () => {
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
      bookingServiceKind: "transfer_train_hotel", // nessun suffisso _aliscafo
      transportTime: "14:00",
      date: DATE,
      zone: "ischia",
      agencyName: "SOSANDRA TOUR",
      operationalRules: [sosandraRule],
      ferrySchedules: [ferryRow({ id: "alil-1", company: "alilauro", departure_time: "11:45", arrival_time: "12:30" })],
    });
    expect(result.source).not.toBe("canonical_rule");
  });

  it("CON richiesta esplicita (kind '_aliscafo'), la regola canonica aliscafo per Sosandra viene proposta", () => {
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
      bookingServiceKind: "transfer_train_hotel_aliscafo",
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

describe("resolveOperationalConnection — NIKOLAENKO (arrivo in volo, regola confermata: solo Medmar da Napoli)", () => {
  it("senza regola canonica configurata per 'Sun & sea', propone via motore legacy la prima Medmar da Napoli raggiungibile, confidence mai ALTA (margine stimato, nessun buffer confermato per questa tratta)", () => {
    const result = resolveOperationalConnection({
      direction: "to_ischia",
      bookingServiceKind: "transfer_airport_hotel",
      transportTime: "12:30",
      date: DATE,
      agencyName: "Sun & sea",
      operationalRules: [],
      ferrySchedules: [
        ferryRow({ id: "medmar-pozzuoli", company: "medmar", departure_port: "pozzuoli", arrival_port: "ischia_porto", departure_time: "13:30", arrival_time: "14:35", direction: "mainland_to_ischia" }),
        ferryRow({ id: "snav-napoli", company: "snav", departure_port: "napoli_beverello", arrival_port: "casamicciola", departure_time: "13:50", arrival_time: "14:55", direction: "mainland_to_ischia" }),
        ferryRow({ id: "medmar-napoli-1420", company: "medmar", departure_port: "napoli_beverello", arrival_port: "ischia_porto", departure_time: "14:20", arrival_time: "15:50", direction: "mainland_to_ischia" }),
      ],
    });
    expect(result.source).toBe("legacy_fallback");
    expect(result.company).toBe("medmar");
    expect(result.embarkPort).toBe("napoli_beverello");
    expect(result.ferryDepartureTime).toBe("14:20");
    expect(result.confidence).not.toBe("ALTA");
  });

  it("nessuna Medmar/Napoli raggiungibile -> confidence NESSUNA, nessun fallback Pozzuoli inventato", () => {
    const result = resolveOperationalConnection({
      direction: "to_ischia",
      bookingServiceKind: "transfer_airport_hotel",
      transportTime: "12:30",
      date: DATE,
      agencyName: "Sun & sea",
      operationalRules: [],
      ferrySchedules: [
        ferryRow({ id: "medmar-pozzuoli", company: "medmar", departure_port: "pozzuoli", arrival_port: "ischia_porto", departure_time: "13:30", arrival_time: "14:35", direction: "mainland_to_ischia" }),
        ferryRow({ id: "snav-napoli", company: "snav", departure_port: "napoli_beverello", arrival_port: "casamicciola", departure_time: "13:50", arrival_time: "14:55", direction: "mainland_to_ischia" }),
      ],
    });
    expect(["BASSA", "NESSUNA"]).toContain(result.confidence);
    expect(result.company).not.toBe("snav");
  });
});

describe("resolveOperationalConnection — gap voluti tra fasce consecutive from_ischia (fix 2026-09-03)", () => {
  const windows = [
    rule({ hotel_id: null, zone: "forio", transport_from: "12:15", transport_to: "13:30", departure_time: "13:00", pickup_time: "11:30" }),
    rule({ hotel_id: null, zone: "forio", transport_from: "13:35", transport_to: "13:55", departure_time: "14:20", pickup_time: "12:45" }),
    rule({ hotel_id: null, zone: "forio", transport_from: "14:00", transport_to: "14:15", departure_time: "14:45", pickup_time: "13:10" }),
  ];
  const base = {
    direction: "from_ischia" as const,
    bookingServiceKind: "transfer_train_hotel",
    date: DATE,
    zone: "forio",
    agencyName: "ALESTE VIAGGI",
    operationalRules: windows,
    ferrySchedules: [],
  };

  it("gap: 13:32 (tra 13:30 e 13:35) usa la fascia successiva 13:35-13:55", () => {
    const result = resolveOperationalConnection({ ...base, transportTime: "13:32" });
    expect(result.source).toBe("canonical_rule");
    expect(result.pickupTime).toBe("12:45");
    expect(result.ferryDepartureTime).toBe("14:20");
  });

  it("gap: 13:58 (equivalente al caso GALLINA) usa la fascia successiva 14:00-14:15", () => {
    const result = resolveOperationalConnection({ ...base, transportTime: "13:58" });
    expect(result.source).toBe("canonical_rule");
    expect(result.pickupTime).toBe("13:10");
    expect(result.ferryDepartureTime).toBe("14:45");
  });

  it("il gap non salta verso una zona incompatibile: una regola di un'altra zona nel gap non viene mai proposta", () => {
    const rulesWithForeignZone = [
      windows[0]!,
      rule({ hotel_id: null, zone: "lacco", transport_from: "13:35", transport_to: "13:55", pickup_time: "99:99" }),
      windows[2]!,
    ];
    const result = resolveOperationalConnection({ ...base, operationalRules: rulesWithForeignZone, transportTime: "13:32" });
    // Nessuna fascia 'forio' valida dopo 13:32 se non quella successiva (14:00-14:15): il gap salta la zona 'lacco', non la 'forio'.
    expect(result.pickupTime).toBe("13:10");
  });

  it("il gap non salta verso un hotel_id incompatibile: una regola hotel-specifica di un altro hotel nel gap resta a livello 1, non contamina il livello 2 (zona) usato per questo hotel", () => {
    const rulesWithForeignHotel = [
      windows[0]!,
      rule({ hotel_id: HOTEL_LA_VILLA_ID, zone: "forio", transport_from: "13:35", transport_to: "13:55", pickup_time: "99:99" }),
      windows[2]!,
    ];
    const result = resolveOperationalConnection({
      ...base,
      hotelId: HOTEL_COLELLA_ID, // hotel diverso da HOTEL_LA_VILLA_ID: nessuna regola di livello 1 per questo hotel
      operationalRules: rulesWithForeignHotel,
      transportTime: "13:32",
    });
    // Il gap deve risolversi sul livello 2 (zona 'forio', windows[2]), mai sulla regola hotel-specifica di un altro hotel.
    expect(result.pickupTime).toBe("13:10");
  });

  it("prima della prima fascia e dopo l'ultima: comportamento invariato (fallback legacy, nessuna invenzione)", () => {
    const before = resolveOperationalConnection({ ...base, transportTime: "10:00" });
    expect(before.source).toBe("legacy_fallback");
    const after = resolveOperationalConnection({ ...base, transportTime: "16:00" });
    expect(after.source).toBe("legacy_fallback");
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

// ---------------------------------------------------------------------------
// Regole DIRETTE (SNAV/MEDMAR, nessun treno/volo di collegamento) —
// transport_type='direct'. Match esatto su departure_time, nessuna finestra
// transport_from/transport_to, nessun fallback ambiguo su fascia oraria.
// ---------------------------------------------------------------------------
function directRule(overrides: Partial<OperationalPickupRule>): OperationalPickupRule {
  return {
    agency_logic: "aleste",
    transport_type: "direct",
    direction: "from_ischia",
    boat_type: "aliscafo",
    hotel_id: null,
    zone: "forio",
    transport_from: null,
    transport_to: null,
    company: "snav",
    departure_time: "07:10",
    embark_port: "casamicciola",
    arrival_port: "napoli_beverello",
    arrival_time: "08:05",
    pickup_time: "06:20",
    valid_from: null,
    valid_to: null,
    days_of_week: null,
    ...overrides,
  };
}

const SNAV_DIRECT_SCHEDULE = [
  ferryRow({
    id: "snav-0710",
    company: "snav",
    departure_port: "casamicciola",
    arrival_port: "napoli_beverello",
    departure_time: "07:10",
    arrival_time: "08:05",
    direction: "ischia_to_mainland",
  }),
];

describe("resolveOperationalConnection — SNAV diretto", () => {
  it("formula_snav: match esatto su departure_time, pickup dalla regola", () => {
    const result = resolveOperationalConnection({
      direction: "from_ischia",
      bookingServiceKind: "formula_snav",
      transportTime: "07:10",
      date: DATE,
      zone: "forio",
      agencyName: "ALESTE VIAGGI",
      operationalRules: [directRule({})],
      ferrySchedules: SNAV_DIRECT_SCHEDULE,
    });
    expect(result.source).toBe("canonical_rule");
    expect(result.company).toBe("snav");
    expect(result.pickupTime).toBe("06:20");
    expect(result.embarkPort).toBe("casamicciola");
    expect(result.arrivalPort).toBe("napoli_beverello");
    expect(result.confidence).toBe("ALTA");
  });

  it("transfer_port_hotel con vessel 'SNAV 07:10' riconosce lo stesso carrier diretto", () => {
    const result = resolveOperationalConnection({
      direction: "from_ischia",
      bookingServiceKind: "transfer_port_hotel",
      vessel: "SNAV 07:10",
      transportTime: "07:10",
      date: DATE,
      zone: "forio",
      agencyName: "ALESTE VIAGGI",
      operationalRules: [directRule({})],
      ferrySchedules: SNAV_DIRECT_SCHEDULE,
    });
    expect(result.source).toBe("canonical_rule");
    expect(result.company).toBe("snav");
  });
});

describe("resolveOperationalConnection — MEDMAR Napoli diretto", () => {
  const medmarNapoli = directRule({
    company: "medmar",
    boat_type: "traghetto",
    departure_time: "06:25",
    embark_port: "ischia_porto",
    arrival_port: "napoli_beverello",
    pickup_time: "05:30",
  });
  const schedule = [
    ferryRow({ id: "medmar-napoli-0625", company: "medmar", departure_port: "ischia_porto", arrival_port: "napoli_beverello", departure_time: "06:25", arrival_time: "07:40", direction: "ischia_to_mainland" }),
  ];

  it("formula_medmar_napoli: match su departure_time 06:25, porto Napoli", () => {
    const result = resolveOperationalConnection({
      direction: "from_ischia",
      bookingServiceKind: "formula_medmar_napoli",
      transportTime: "06:25",
      date: DATE,
      zone: "forio",
      agencyName: "ALESTE VIAGGI",
      operationalRules: [medmarNapoli],
      ferrySchedules: schedule,
    });
    expect(result.source).toBe("canonical_rule");
    expect(result.company).toBe("medmar");
    expect(result.arrivalPort).toBe("napoli_beverello");
    expect(result.pickupTime).toBe("05:30");
  });
});

describe("resolveOperationalConnection — MEDMAR Pozzuoli diretto", () => {
  const medmarPozzuoli = directRule({
    company: "medmar",
    boat_type: "traghetto",
    departure_time: "06:20",
    embark_port: "casamicciola",
    arrival_port: "pozzuoli",
    pickup_time: "05:30",
  });
  const schedule = [
    ferryRow({ id: "medmar-pozzuoli-0620", company: "medmar", departure_port: "casamicciola", arrival_port: "pozzuoli", departure_time: "06:20", arrival_time: "07:20", direction: "ischia_to_mainland" }),
  ];

  it("formula_medmar_pozzuoli: match su departure_time 06:20, porto Pozzuoli — distinto da Napoli anche a parità di company", () => {
    const result = resolveOperationalConnection({
      direction: "from_ischia",
      bookingServiceKind: "formula_medmar_pozzuoli",
      transportTime: "06:20",
      date: DATE,
      zone: "forio",
      agencyName: "ALESTE VIAGGI",
      operationalRules: [medmarPozzuoli],
      ferrySchedules: schedule,
    });
    expect(result.source).toBe("canonical_rule");
    expect(result.arrivalPort).toBe("pozzuoli");
  });

  it("stessa company ma regola Napoli in lista: il match resta quello giusto quando gli orari nave non coincidono (caso reale)", () => {
    const napoli = directRule({ company: "medmar", departure_time: "06:25", arrival_port: "napoli_beverello" });
    const result = resolveOperationalConnection({
      direction: "from_ischia",
      bookingServiceKind: "formula_medmar_pozzuoli",
      transportTime: "06:20",
      date: DATE,
      zone: "forio",
      agencyName: "ALESTE VIAGGI",
      operationalRules: [napoli, medmarPozzuoli],
      ferrySchedules: schedule,
    });
    expect(result.arrivalPort).toBe("pozzuoli");
  });
});

describe("resolveOperationalConnection — regole dirette: mismatch e nessun fallback ambiguo", () => {
  it("mismatch departure_time: nessuna regola nella finestra più vicina, fallback legacy esplicito (mai un match approssimato)", () => {
    const result = resolveOperationalConnection({
      direction: "from_ischia",
      bookingServiceKind: "formula_snav",
      transportTime: "07:15", // 5 minuti dopo l'unica regola configurata (07:10): NON deve matchare
      date: DATE,
      zone: "forio",
      agencyName: "ALESTE VIAGGI",
      operationalRules: [directRule({})],
      ferrySchedules: SNAV_DIRECT_SCHEDULE,
    });
    expect(result.source).toBe("legacy_fallback");
  });

  it("mismatch zone: nessuna regola generale, nessun match hotel/zona -> fallback legacy", () => {
    const result = resolveOperationalConnection({
      direction: "from_ischia",
      bookingServiceKind: "formula_snav",
      transportTime: "07:10",
      date: DATE,
      zone: "barano", // la regola configurata è solo per 'forio'
      agencyName: "ALESTE VIAGGI",
      operationalRules: [directRule({})], // solo zone:'forio', nessuna generale
      ferrySchedules: SNAV_DIRECT_SCHEDULE,
    });
    expect(result.source).toBe("legacy_fallback");
  });

  it("agency_logic: regola sosandra non fa match per un'agenzia aleste, anche a parità di tutto il resto", () => {
    const result = resolveOperationalConnection({
      direction: "from_ischia",
      bookingServiceKind: "formula_snav",
      transportTime: "07:10",
      date: DATE,
      zone: "forio",
      agencyName: "ALESTE VIAGGI", // -> agency_logic 'aleste'
      operationalRules: [directRule({ agency_logic: "sosandra" })],
      ferrySchedules: SNAV_DIRECT_SCHEDULE,
    });
    expect(result.source).toBe("legacy_fallback");
  });

  it("regola generale (zone=null) fa da jolly quando non c'è una regola di zona specifica", () => {
    const result = resolveOperationalConnection({
      direction: "from_ischia",
      bookingServiceKind: "formula_snav",
      transportTime: "07:10",
      date: DATE,
      zone: "barano",
      agencyName: "ALESTE VIAGGI",
      operationalRules: [directRule({ zone: null, pickup_time: "06:15" })],
      ferrySchedules: SNAV_DIRECT_SCHEDULE,
    });
    expect(result.source).toBe("canonical_rule");
    expect(result.pickupTime).toBe("06:15");
  });
});

describe("resolveOperationalConnection — regole dirette non interferiscono con treno/volo (regressione)", () => {
  it("kind treno con regole train+direct in lista: matcha solo la regola train, mai quella direct", () => {
    const trainRule = rule({ transport_type: "train", transport_from: "07:00", transport_to: "09:00", departure_time: "12:00", pickup_time: "05:00" });
    const result = resolveOperationalConnection({
      direction: "from_ischia",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "08:00",
      date: DATE,
      zone: null,
      agencyName: "ALESTE VIAGGI",
      operationalRules: [trainRule, directRule({})],
      ferrySchedules: [ferryRow({ company: "medmar", departure_port: "ischia_porto", arrival_port: "napoli_beverello", departure_time: "12:00", direction: "ischia_to_mainland" })],
    });
    expect(result.source).toBe("canonical_rule");
    expect(result.pickupTime).toBe("05:00");
    expect(result.company).toBe("medmar");
  });

  it("kind diretto (formula_snav) con regole train+direct in lista: matcha solo la regola direct", () => {
    const trainRule = rule({ transport_type: "train", transport_from: "07:00", transport_to: "09:00", departure_time: "12:00", pickup_time: "05:00" });
    const result = resolveOperationalConnection({
      direction: "from_ischia",
      bookingServiceKind: "formula_snav",
      transportTime: "07:10",
      date: DATE,
      zone: "forio",
      agencyName: "ALESTE VIAGGI",
      operationalRules: [trainRule, directRule({})],
      ferrySchedules: SNAV_DIRECT_SCHEDULE,
    });
    expect(result.source).toBe("canonical_rule");
    expect(result.company).toBe("snav");
    expect(result.pickupTime).toBe("06:20");
  });

  it("direction='to_ischia' non attiva mai il branch diretto anche con kind formula_snav (contratto: direct esiste solo in from_ischia)", () => {
    const result = resolveOperationalConnection({
      direction: "to_ischia",
      bookingServiceKind: "formula_snav",
      transportTime: "07:10",
      date: DATE,
      agencyName: "ALESTE VIAGGI",
      operationalRules: [directRule({})],
      ferrySchedules: SNAV_DIRECT_SCHEDULE,
    });
    expect(result.source).toBe("legacy_fallback");
    expect(result.confidence).toBe("NESSUNA");
  });
});
