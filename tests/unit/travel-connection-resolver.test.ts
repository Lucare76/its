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
  it("Sosandra senza richiesta esplicita ammette solo traghetto (l'aliscafo non e' piu' automatico per agenzia)", () => {
    const p = resolveAgencyConnectionPolicy("SOSANDRA TOUR BY ROSSELLA VIAGGI S.r.L.");
    expect(p.agencyKey).toBe("sosandra");
    expect(p.source).toBe("known");
    expect(p.allowedFerryTypes).toEqual(["traghetto"]);
  });

  it("Sosandra CON richiesta esplicita ammette anche l'aliscafo", () => {
    const p = resolveAgencyConnectionPolicy("SOSANDRA TOUR BY ROSSELLA VIAGGI S.r.L.", true);
    expect(p.allowedFerryTypes).toEqual(["traghetto", "aliscafo"]);
  });

  it("Aleste ammette solo traghetto senza richiesta esplicita", () => {
    const p = resolveAgencyConnectionPolicy("ALESTE VIAGGI");
    expect(p.agencyKey).toBe("aleste");
    expect(p.source).toBe("known");
    expect(p.allowedFerryTypes).toEqual(["traghetto"]);
  });

  it("Aleste CON richiesta esplicita ammette anche l'aliscafo (stesso meccanismo di Sosandra, nessun privilegio di agenzia)", () => {
    const p = resolveAgencyConnectionPolicy("ALESTE VIAGGI", true);
    expect(p.allowedFerryTypes).toEqual(["traghetto", "aliscafo"]);
  });

  it("agenzia non mappata -> policy default conservativa, mai aliscafo anche con richiesta esplicita", () => {
    const p = resolveAgencyConnectionPolicy("Sun & sea", true);
    expect(p.source).toBe("default");
    expect(p.allowedFerryTypes).toEqual(["traghetto"]);
  });

  it("agenzia null -> policy default conservativa", () => {
    const p = resolveAgencyConnectionPolicy(null);
    expect(p.source).toBe("default");
    expect(p.allowedFerryTypes).toEqual(["traghetto"]);
  });
});

describe("resolveTravelConnection — SUORATO (Aleste, dati reali, regola Napoli confermata da Mario — non dipende dall'hotel)", () => {
  const schedules: FerryScheduleRow[] = [
    row({ id: "medmar-1035", company: "medmar", departure_port: "ischia_porto", arrival_port: "napoli_beverello", departure_time: "10:35", arrival_time: "12:05" }),
    row({ id: "alilauro-1145", company: "alilauro", departure_port: "ischia_porto", arrival_port: "napoli_beverello", departure_time: "11:45", arrival_time: "12:30" }),
  ];

  it("Alilauro 11:45 viene esclusa dalla policy Aleste (no aliscafo), proposta il traghetto Medmar 10:35 (treno 14:00, buffer confermato 90min)", () => {
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

  it("tra due Medmar entrambi validi (Pozzuoli vs Napoli Beverello), preferisce SEMPRE Napoli Beverello — regola operativa confermata (divieto bus a Pozzuoli), non un criterio di margine/hotel", () => {
    const bothMedmar: FerryScheduleRow[] = [
      row({ id: "medmar-1010-pozzuoli", company: "medmar", departure_port: "casamicciola", arrival_port: "pozzuoli", departure_time: "10:10", arrival_time: "11:15" }), // margine maggiore, ma porto non preferito
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
      // NB: nessun pax passato — la preferenza Napoli non richiede pax, solo il fallback Pozzuoli lo richiede.
    });
    expect(result.proposedFerryScheduleId).toBe("medmar-1035-napoli");
    expect(result.proposedArrivalPort).toBe("napoli_beverello");
    expect(result.reason).toMatch(/Napoli Beverello/i);
  });

  it("se nessuna corsa Napoli è valida, Pozzuoli è ammessa come fallback SOLO con pax <= 8", () => {
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
      pax: 4,
    });
    expect(result.proposedFerryScheduleId).toBe("medmar-pozzuoli");
    expect(result.confidence).not.toBe("NESSUNA");
  });

  it("Pozzuoli ammessa al limite esatto pax=8", () => {
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
      pax: 8,
    });
    expect(result.proposedFerryScheduleId).toBe("medmar-pozzuoli");
  });

  it("Pozzuoli ESCLUSA con pax=9 (> 8): nessuna soluzione automatica, mai un'invenzione", () => {
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
      pax: 9,
    });
    expect(result.confidence).toBe("NESSUNA");
    expect(result.proposedCompany).toBeNull();
    expect(result.reason).toMatch(/pax/i);
  });

  it("Pozzuoli ESCLUSA con pax=20 (gruppo grande): nessuna soluzione automatica", () => {
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
      pax: 20,
    });
    expect(result.confidence).toBe("NESSUNA");
  });

  it("Pozzuoli ESCLUSA se pax non noti (null/assente): mai un fallback silenzioso senza dato reale", () => {
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
    expect(result.confidence).toBe("NESSUNA");
  });
});

describe("resolveTravelConnection — buffer confermati (Mario, audit 2026-08-28)", () => {
  it("PARTENZA + treno: nave -> treno richiede almeno 90min (nave che arriva a 89min dal treno viene esclusa)", () => {
    const schedules: FerryScheduleRow[] = [
      row({ id: "troppo-tardi", departure_time: "10:00", arrival_time: "12:32" }), // 88min prima delle 14:00
      row({ id: "in-tempo", departure_time: "09:30", arrival_time: "12:30" }), // esattamente 90min prima
    ];
    const result = resolveTravelConnection({
      direction: "departure",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "14:00",
      date: DATE,
      ferrySchedules: schedules,
      agencyName: "ALESTE VIAGGI",
      knownPickupTime: "07:00",
    });
    expect(result.proposedFerryScheduleId).toBe("in-tempo");
  });

  it("PARTENZA + volo: nave -> volo richiede almeno 160min", () => {
    const schedules: FerryScheduleRow[] = [
      row({ id: "troppo-tardi", departure_time: "10:00", arrival_time: "11:31" }), // 159min prima delle 14:10
      row({ id: "in-tempo", departure_time: "09:00", arrival_time: "11:30" }), // esattamente 160min prima
    ];
    const result = resolveTravelConnection({
      direction: "departure",
      bookingServiceKind: "transfer_airport_hotel",
      transportTime: "14:10",
      date: DATE,
      ferrySchedules: schedules,
      agencyName: "ALESTE VIAGGI",
      knownPickupTime: "06:00",
    });
    expect(result.proposedFerryScheduleId).toBe("in-tempo");
  });

  it("ARRIVO + treno: treno -> nave richiede almeno 70min (nave che parte 69min dopo l'arrivo del treno viene esclusa)", () => {
    const schedules: FerryScheduleRow[] = [
      row({ id: "troppo-presto", direction: "mainland_to_ischia", departure_time: "11:39", arrival_time: "12:30" }), // 69min dopo le 10:30
      row({ id: "in-tempo", direction: "mainland_to_ischia", departure_time: "11:40", arrival_time: "12:35" }), // esattamente 70min dopo
    ];
    const result = resolveTravelConnection({
      direction: "arrival",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "10:30",
      date: DATE,
      ferrySchedules: schedules,
      agencyName: "ALESTE VIAGGI",
    });
    expect(result.proposedFerryScheduleId).toBe("in-tempo");
  });
});

describe("resolveTravelConnection — BIRAGO (proposta automatica vs override)", () => {
  const schedules: FerryScheduleRow[] = [
    row({ id: "medmar-1010", company: "medmar", departure_port: "casamicciola", arrival_port: "napoli_beverello", departure_time: "10:10", arrival_time: "10:15" }),
    row({ id: "snav-0945", company: "snav", departure_port: "casamicciola", arrival_port: "napoli_beverello", departure_time: "09:45", arrival_time: "09:50" }),
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
      arrival_time: "09:50",
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

describe("resolveTravelConnection — Sosandra: aliscafo solo su richiesta esplicita, mai automatico", () => {
  it("senza richiesta esplicita (kind generico), una corsa aliscafo valida NON viene proposta: cade su Medmar/traghetto o NESSUNA", () => {
    const schedules: FerryScheduleRow[] = [
      row({ id: "alilauro-1145", company: "alilauro", departure_port: "ischia_porto", arrival_port: "napoli_beverello", departure_time: "11:45", arrival_time: "12:30" }),
    ];
    const result = resolveTravelConnection({
      direction: "departure",
      bookingServiceKind: "transfer_train_hotel", // nessun suffisso _aliscafo
      transportTime: "14:00",
      date: DATE,
      ferrySchedules: schedules,
      agencyName: "SOSANDRA TOUR",
      knownPickupTime: "09:00",
    });
    expect(result.proposedCompany).not.toBe("alilauro");
    expect(result.excludedByPolicy.some((e) => e.company === "alilauro" && e.reason === "policy")).toBe(true);
  });

  it("CON richiesta esplicita (kind '_aliscafo'), la corsa aliscafo valida può essere proposta automaticamente", () => {
    const schedules: FerryScheduleRow[] = [
      row({ id: "alilauro-1145", company: "alilauro", departure_port: "ischia_porto", arrival_port: "napoli_beverello", departure_time: "11:45", arrival_time: "12:30" }),
    ];
    const result = resolveTravelConnection({
      direction: "departure",
      bookingServiceKind: "transfer_train_hotel_aliscafo",
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

describe("resolveTravelConnection — preferenza SNAV ±30min DISATTIVATA di default (non confermata da Mario)", () => {
  it("con policy che ammette l'aliscafo (richiesta esplicita), una SNAV entro ±30min dalla corsa migliore (più tardiva compatibile) NON viene più preferita automaticamente", () => {
    const schedules: FerryScheduleRow[] = [
      row({ id: "medmar-x", company: "medmar", departure_time: "09:30", arrival_time: "11:15" }), // più tardiva compatibile = corretta
      row({ id: "snav-x", company: "snav", departure_time: "09:00", arrival_time: "11:00" }), // 15min prima, entro la finestra ±30min
    ];
    const result = resolveTravelConnection({
      direction: "departure",
      bookingServiceKind: "transfer_train_hotel_aliscafo",
      transportTime: "14:00",
      date: DATE,
      ferrySchedules: schedules,
      agencyName: "SOSANDRA TOUR",
      knownPickupTime: "07:00",
      pax: 4,
    });
    expect(result.proposedCompany).toBe("medmar");
    expect(result.reason).not.toMatch(/preferita/i);
  });
});

describe("resolveTravelConnection — arrivo in volo (regola confermata: solo Medmar da Napoli, nessun buffer fisso, nessun fallback Pozzuoli)", () => {
  it("NIKOLAENKO: LH334 arrivo 12:30 -> prima Medmar da Napoli realmente raggiungibile (14:20), non Pozzuoli né altra compagnia", () => {
    const schedules: FerryScheduleRow[] = [
      row({ id: "medmar-pozzuoli-1300", direction: "mainland_to_ischia", company: "medmar", departure_port: "pozzuoli", arrival_port: "ischia_porto", departure_time: "13:00", arrival_time: "14:05" }), // porto sbagliato: MAI scelta automaticamente
      row({ id: "snav-napoli-1350", direction: "mainland_to_ischia", company: "snav", departure_port: "napoli_beverello", arrival_port: "casamicciola", departure_time: "13:50", arrival_time: "14:55" }), // compagnia sbagliata
      row({ id: "medmar-napoli-1300", direction: "mainland_to_ischia", company: "medmar", departure_port: "napoli_beverello", arrival_port: "ischia_porto", departure_time: "13:00", arrival_time: "14:05" }), // non ancora raggiungibile (troppo presto)
      row({ id: "medmar-napoli-1420", direction: "mainland_to_ischia", company: "medmar", departure_port: "napoli_beverello", arrival_port: "ischia_porto", departure_time: "14:20", arrival_time: "15:50" }),
    ];
    const result = resolveTravelConnection({
      direction: "arrival",
      bookingServiceKind: "transfer_airport_hotel",
      transportTime: "12:30",
      date: DATE,
      ferrySchedules: schedules,
      agencyName: "Sun & sea",
    });
    expect(result.proposedFerryScheduleId).toBe("medmar-napoli-1420");
    expect(result.proposedCompany).toBe("medmar");
    expect(result.proposedEmbarkPort).toBe("napoli_beverello");
    expect(result.confidence).not.toBe("ALTA"); // margine stimato, mai un buffer confermato per questa tratta
  });

  it("se non esiste nessuna Medmar/Napoli raggiungibile, segnala COLLEGAMENTO DA CONFERMARE invece di inventare una soluzione (mai fallback su Pozzuoli/altra compagnia)", () => {
    const schedules: FerryScheduleRow[] = [
      row({ id: "medmar-pozzuoli", direction: "mainland_to_ischia", company: "medmar", departure_port: "pozzuoli", arrival_port: "ischia_porto", departure_time: "13:30", arrival_time: "14:35" }),
      row({ id: "snav-napoli", direction: "mainland_to_ischia", company: "snav", departure_port: "napoli_beverello", arrival_port: "casamicciola", departure_time: "13:50", arrival_time: "14:55" }),
    ];
    const result = resolveTravelConnection({
      direction: "arrival",
      bookingServiceKind: "transfer_airport_hotel",
      transportTime: "12:30",
      date: DATE,
      ferrySchedules: schedules,
      agencyName: "Sun & sea",
    });
    expect(result.confidence).toBe("NESSUNA");
    expect(result.reason).toMatch(/COLLEGAMENTO DA CONFERMARE/);
    expect(result.proposedCompany).toBeNull();
  });
});

describe("resolveTravelConnection — confidence", () => {
  it("policy default (agenzia non nota) -> confidence mai superiore a BASSA", () => {
    const result = resolveTravelConnection({
      direction: "departure",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "13:00",
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
      transportTime: "15:00",
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
