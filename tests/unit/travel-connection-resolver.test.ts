import { describe, expect, it } from "vitest";
import {
  resolveTravelConnection,
  resolveAgencyConnectionPolicy,
  recalculateConnection,
  connectionFromAutoResult,
  type FerryScheduleRow,
  type ConnectionRecord,
} from "@/lib/travel-connection-resolver";

const DATE = "2026-08-27"; // giovedi'

function row(overrides: Partial<FerryScheduleRow>): FerryScheduleRow {
  return {
    id: "id",
    company: "medmar",
    departure_port: "ischia_porto",
    arrival_port: "napoli_beverello",
    departure_time: "10:00",
    arrival_time: "11:30",
    direction: "ischia_to_mainland",
    days_of_week: null,
    valid_from: null,
    valid_to: null,
    ...overrides,
  };
}

describe("resolveAgencyConnectionPolicy", () => {
  it("Sosandra ammette traghetto e aliscafo", () => {
    const p = resolveAgencyConnectionPolicy("SOSANDRA TOUR BY ROSSELLA VIAGGI S.r.L.");
    expect(p.agencyKey).toBe("sosandra");
    expect(p.source).toBe("known");
    expect(p.allowedFerryTypes).toEqual(["traghetto", "aliscafo"]);
  });

  it("Aleste ammette solo traghetto", () => {
    const p = resolveAgencyConnectionPolicy("ALESTE VIAGGI");
    expect(p.agencyKey).toBe("aleste");
    expect(p.source).toBe("known");
    expect(p.allowedFerryTypes).toEqual(["traghetto"]);
  });

  it("agenzia non mappata -> policy default conservativa, mai aliscafo", () => {
    const p = resolveAgencyConnectionPolicy("Sun & sea");
    expect(p.source).toBe("default");
    expect(p.allowedFerryTypes).toEqual(["traghetto"]);
  });

  it("agenzia null -> policy default conservativa", () => {
    const p = resolveAgencyConnectionPolicy(null);
    expect(p.source).toBe("default");
    expect(p.allowedFerryTypes).toEqual(["traghetto"]);
  });
});

describe("resolveTravelConnection — SUORATO (Aleste, dati reali)", () => {
  const schedules: FerryScheduleRow[] = [
    row({ id: "medmar-1035", company: "medmar", departure_port: "ischia_porto", arrival_port: "napoli_beverello", departure_time: "10:35", arrival_time: "12:05" }),
    row({ id: "alilauro-1145", company: "alilauro", departure_port: "ischia_porto", arrival_port: "napoli_beverello", departure_time: "11:45", arrival_time: "12:30" }),
  ];

  it("Alilauro 11:45 viene esclusa dalla policy Aleste (no aliscafo), proposta il traghetto Medmar 10:35", () => {
    const result = resolveTravelConnection({
      direction: "departure",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "14:00",
      date: DATE,
      ferrySchedules: schedules,
      agencyName: "ALESTE VIAGGI",
      knownPickupTime: "09:00",
    });
    expect(result.proposedPickupTime).toBe("09:00");
    expect(result.proposedCompany).toBe("medmar");
    expect(result.proposedFerryType).toBe("traghetto");
    expect(result.proposedFerryDepartureTime).toBe("10:35");
    expect(result.excludedByPolicy.some((e) => e.company === "alilauro" && e.reason === "policy")).toBe(true);
    expect(result.confidence).toBe("ALTA");
  });

  it("funziona per qualunque prenotazione Aleste equivalente, non solo per il nome SUORATO (nessun if hardcoded sul cliente)", () => {
    const result = resolveTravelConnection({
      direction: "departure",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "14:00",
      date: DATE,
      ferrySchedules: schedules,
      agencyName: "aleste viaggi", // agenzia diversa nel casing, stessa policy
      knownPickupTime: "09:00",
    });
    expect(result.proposedCompany).toBe("medmar");
  });

  it("tra due Medmar entrambi validi (Pozzuoli vs Napoli Beverello), preferisce Napoli Beverello — porto canonico per Medmar (fonte calc-pickup-time.ts), non la corsa con margine assoluto maggiore", () => {
    const bothMedmar: FerryScheduleRow[] = [
      row({ id: "medmar-1010-pozzuoli", company: "medmar", departure_port: "casamicciola", arrival_port: "pozzuoli", departure_time: "10:10", arrival_time: "11:15" }), // margine maggiore, ma porto non canonico
      row({ id: "medmar-1035-napoli", company: "medmar", departure_port: "ischia_porto", arrival_port: "napoli_beverello", departure_time: "10:35", arrival_time: "12:05" }),
    ];
    const result = resolveTravelConnection({
      direction: "departure",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "14:00",
      date: DATE,
      ferrySchedules: bothMedmar,
      agencyName: "ALESTE VIAGGI",
      knownPickupTime: "09:00",
    });
    expect(result.proposedFerryScheduleId).toBe("medmar-1035-napoli");
    expect(result.proposedArrivalPort).toBe("napoli_beverello");
    expect(result.reason).toMatch(/porto continentale canonico/i);
  });

  it("se nessun candidato nel porto canonico è valido, ricade sugli altri porti della stessa compagnia (fallback, non NESSUNA)", () => {
    const onlyPozzuoli: FerryScheduleRow[] = [
      row({ id: "medmar-pozzuoli", company: "medmar", departure_port: "casamicciola", arrival_port: "pozzuoli", departure_time: "10:10", arrival_time: "11:15" }),
    ];
    const result = resolveTravelConnection({
      direction: "departure",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "14:00",
      date: DATE,
      ferrySchedules: onlyPozzuoli,
      agencyName: "ALESTE VIAGGI",
      knownPickupTime: "09:00",
    });
    expect(result.proposedFerryScheduleId).toBe("medmar-pozzuoli");
    expect(result.confidence).not.toBe("NESSUNA");
  });
});

describe("resolveTravelConnection — BIRAGO (proposta automatica vs override)", () => {
  const schedules: FerryScheduleRow[] = [
    row({ id: "medmar-1010", company: "medmar", departure_port: "casamicciola", arrival_port: "pozzuoli", departure_time: "10:10", arrival_time: "11:15" }),
    row({ id: "snav-0945", company: "snav", departure_port: "casamicciola", arrival_port: "napoli_beverello", departure_time: "09:45", arrival_time: "10:50" }),
  ];

  it("proposta automatica standard (agenzia sconosciuta -> policy default, no aliscafo): traghetto, non SNAV", () => {
    const result = resolveTravelConnection({
      direction: "departure",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "12:10",
      date: DATE,
      ferrySchedules: schedules,
      agencyName: null,
      knownPickupTime: "09:00",
    });
    expect(result.proposedCompany).toBe("medmar");
    expect(result.excludedByPolicy.some((e) => e.company === "snav")).toBe(true);
    expect(result.policy.source).toBe("default");
  });

  it("override manuale SNAV 09:45 confermato: preservato e non sovrascritto da un ricalcolo automatico", () => {
    const auto = resolveTravelConnection({
      direction: "departure",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "12:10",
      date: DATE,
      ferrySchedules: schedules,
      agencyName: null,
      knownPickupTime: "09:00",
    });
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

    const { applied, newProposal, overriddenPreserved } = recalculateConnection(manualOverride, auto);
    expect(overriddenPreserved).toBe(true);
    expect(applied).toEqual(manualOverride); // l'override resta il valore applicato/persistito
    expect(newProposal.company).toBe("medmar"); // la nuova proposta e' mostrata ma non sostituisce l'override
  });

  it("senza override, il ricalcolo applica direttamente la nuova proposta automatica", () => {
    const auto = resolveTravelConnection({
      direction: "departure",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "12:10",
      date: DATE,
      ferrySchedules: schedules,
      agencyName: null,
      knownPickupTime: "09:00",
    });
    const { applied, overriddenPreserved } = recalculateConnection(null, auto);
    expect(overriddenPreserved).toBe(false);
    expect(applied?.company).toBe("medmar");
  });

  it("connectionFromAutoResult produce un ConnectionRecord source=auto, manually_overridden=false", () => {
    const auto = resolveTravelConnection({
      direction: "departure",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "12:10",
      date: DATE,
      ferrySchedules: schedules,
      agencyName: null,
      knownPickupTime: "09:00",
    });
    const record = connectionFromAutoResult(auto);
    expect(record.source).toBe("auto");
    expect(record.manually_overridden).toBe(false);
  });
});

describe("resolveTravelConnection — Sosandra ammette aliscafo secondo policy", () => {
  it("con policy Sosandra, una corsa aliscafo valida può essere proposta automaticamente", () => {
    const schedules: FerryScheduleRow[] = [
      row({ id: "alilauro-1145", company: "alilauro", departure_port: "ischia_porto", arrival_port: "napoli_beverello", departure_time: "11:45", arrival_time: "12:30" }),
    ];
    const result = resolveTravelConnection({
      direction: "departure",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "14:00",
      date: DATE,
      ferrySchedules: schedules,
      agencyName: "SOSANDRA TOUR",
      knownPickupTime: "09:00",
    });
    expect(result.proposedCompany).toBe("alilauro");
    expect(result.proposedFerryType).toBe("aliscafo");
    expect(result.excludedByPolicy).toHaveLength(0);
  });
});

describe("resolveTravelConnection — preferenza SNAV solo tra corse già ammesse", () => {
  it("SNAV entro +-30min ma esclusa dalla policy -> non viene proposta comunque", () => {
    const schedules: FerryScheduleRow[] = [
      row({ id: "medmar-1010", company: "medmar", departure_time: "10:10", arrival_time: "11:15" }),
      row({ id: "snav-0945", company: "snav", departure_time: "09:45", arrival_time: "10:50" }), // entro 30min da 10:10, ma policy Aleste la esclude
    ];
    const result = resolveTravelConnection({
      direction: "departure",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "12:10",
      date: DATE,
      ferrySchedules: schedules,
      agencyName: "ALESTE VIAGGI",
      knownPickupTime: "09:00",
    });
    expect(result.proposedCompany).toBe("medmar");
    expect(result.excludedByPolicy.some((e) => e.company === "snav")).toBe(true);
  });

  it("con policy che ammette l'aliscafo, SNAV entro +-30min viene comunque preferita", () => {
    const schedules: FerryScheduleRow[] = [
      row({ id: "medmar-1010", company: "medmar", departure_time: "10:10", arrival_time: "11:15" }),
      row({ id: "snav-0945", company: "snav", departure_time: "09:45", arrival_time: "10:50" }),
    ];
    const result = resolveTravelConnection({
      direction: "departure",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "12:10",
      date: DATE,
      ferrySchedules: schedules,
      agencyName: "SOSANDRA TOUR",
      knownPickupTime: "09:00",
    });
    expect(result.proposedCompany).toBe("snav");
  });
});

describe("resolveTravelConnection — NIKOLAENKO arrival (policy prima della scelta nave)", () => {
  it("agenzia sconosciuta ('Sun & sea') -> policy default, propone traghetto Medmar", () => {
    const schedules: FerryScheduleRow[] = [
      row({ id: "medmar-1330", company: "medmar", departure_port: "pozzuoli", arrival_port: "ischia_porto", departure_time: "13:30", arrival_time: "14:35", direction: "mainland_to_ischia" }),
      row({ id: "snav-1220", company: "snav", departure_port: "napoli_beverello", arrival_port: "casamicciola", departure_time: "13:50", arrival_time: "14:55", direction: "mainland_to_ischia" }),
    ];
    const result = resolveTravelConnection({
      direction: "arrival",
      bookingServiceKind: "transfer_airport_hotel",
      transportTime: "12:30",
      date: DATE,
      ferrySchedules: schedules,
      agencyName: "Sun & sea",
    });
    expect(result.proposedCompany).toBe("medmar");
    expect(result.policy.source).toBe("default");
    expect(result.excludedByPolicy.some((e) => e.company === "snav")).toBe(true);
  });
});

describe("resolveTravelConnection — confidence", () => {
  it("policy default (agenzia non nota) -> confidence mai superiore a BASSA", () => {
    const result = resolveTravelConnection({
      direction: "departure",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "12:10",
      date: DATE,
      ferrySchedules: [row({ id: "x", departure_time: "10:10", arrival_time: "11:15" })],
      agencyName: undefined,
      knownPickupTime: "09:00",
    });
    expect(result.confidence).toBe("BASSA");
  });

  it("policy nota + dati reali + nessun gap margine -> confidence ALTA", () => {
    const result = resolveTravelConnection({
      direction: "departure",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "14:00",
      date: DATE,
      ferrySchedules: [row({ id: "x", departure_port: "ischia_porto", arrival_port: "napoli_beverello", departure_time: "10:35", arrival_time: "12:05" })],
      agencyName: "ALESTE VIAGGI",
      knownPickupTime: "09:00",
    });
    expect(result.confidence).toBe("ALTA");
  });

  it("nessuna corsa valida -> confidence NESSUNA", () => {
    const result = resolveTravelConnection({
      direction: "departure",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "07:00",
      date: DATE,
      ferrySchedules: [],
      agencyName: "ALESTE VIAGGI",
      knownPickupTime: "05:00",
    });
    expect(result.confidence).toBe("NESSUNA");
  });
});

describe("resolveTravelConnection — fail-safe generali", () => {
  it("booking_service_kind non treno/aereo -> nessun collegamento calcolato", () => {
    const result = resolveTravelConnection({
      direction: "departure",
      bookingServiceKind: "formula_medmar_napoli",
      transportTime: "17:00",
      date: DATE,
      ferrySchedules: [row({})],
      agencyName: "ALESTE VIAGGI",
    });
    expect(result.confidence).toBe("NESSUNA");
    expect(result.proposedCompany).toBeNull();
  });

  it("corsa attiva solo in giorni specifici viene esclusa se il giorno non corrisponde", () => {
    const schedules: FerryScheduleRow[] = [
      row({ id: "medmar-weekend", company: "medmar", departure_time: "10:30", arrival_time: "11:35", days_of_week: [5, 6, 0] }), // ven/sab/dom, 27/08/2026 e' giovedi'
      row({ id: "medmar-0810", company: "medmar", departure_time: "08:10", arrival_time: "09:15" }),
    ];
    const result = resolveTravelConnection({
      direction: "departure",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "12:10",
      date: DATE,
      ferrySchedules: schedules,
      agencyName: "ALESTE VIAGGI",
      knownPickupTime: "07:00",
    });
    expect(result.proposedFerryDepartureTime).toBe("08:10");
  });
});
