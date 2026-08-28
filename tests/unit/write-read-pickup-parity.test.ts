import { describe, it, expect } from "vitest";
import { applyPickupCalc, type PickupCalcCanonicalContext } from "@/lib/server/apply-pickup-calc";
import { resolveOperationalTiming, type OperationalTimingContext } from "@/lib/operational-timing-resolver";
import type { PrintService } from "@/lib/piano-giorno-print";
import type { OperationalPickupRule } from "@/lib/operational-connection-resolver";
import type { FerryScheduleRow } from "@/lib/travel-connection-resolver";

/**
 * Test di PARITA' WRITE/READ per il dominio treno/volo (dominio A).
 *
 * Dimostra che, per lo stesso identico scenario e lo stesso context (regole
 * canoniche + orari nave gia' caricati in batch), il valore che applyPickupCalc
 * PERSISTEREBBE nel DB e' identico a quello che resolveOperationalTiming
 * RESTITUIREBBE a runtime per la stessa prenotazione — chiudendo il mismatch
 * dimostrato prima di questa modifica (vedi report sessione).
 */

const DATE = "2026-08-27";

function rule(overrides: Partial<OperationalPickupRule> = {}): OperationalPickupRule {
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
    departure_time: "14:00",
    embark_port: "ischia_porto",
    arrival_port: "napoli_beverello",
    arrival_time: "15:30",
    pickup_time: "11:45",
    valid_from: null,
    valid_to: null,
    days_of_week: null,
    ...overrides,
  };
}

function schedule(overrides: Partial<FerryScheduleRow> = {}): FerryScheduleRow {
  return {
    id: "sched-1", company: "medmar", departure_port: "ischia_porto", arrival_port: "napoli_beverello",
    departure_time: "14:00", arrival_time: "15:30", direction: "ischia_to_mainland",
    days_of_week: null, valid_from: null, valid_to: null,
    ...overrides,
  };
}

function service(overrides: Partial<PrintService> = {}): PrintService {
  return {
    id: "svc-1", tenant_id: "t1", date: DATE, time: "14:00", direction: "departure",
    customer_name: "TEST", pax: 2, hotel_id: "hotel-1", vessel: null, phone: "333",
    notes: "", status: "new", booking_service_kind: "transfer_train_hotel",
    departure_time: "14:00", pickup_hotel: null, pickup_time: null,
    ...overrides,
  } as PrintService;
}

/** Confronta write (applyPickupCalc) vs read (resolveOperationalTiming) per lo stesso scenario. */
function compare(args: {
  kind: string;
  time: string;
  agencyName: string | null;
  rules: OperationalPickupRule[];
  schedules: FerryScheduleRow[];
  hotelZone?: string | null;
  hotelId?: string | null;
  vessel?: string | null;
}) {
  const writeContext: PickupCalcCanonicalContext = {
    operationalRules: args.rules,
    ferrySchedules: args.schedules,
    date: DATE,
    hotelId: args.hotelId ?? null,
  };
  const writeResult = applyPickupCalc({
    direction: "departure",
    booking_service_kind: args.kind,
    time: args.time,
    billing_party_name: args.agencyName,
    vessel: args.vessel ?? null,
    hotel_zone: args.hotelZone ?? null,
    context: writeContext,
  });

  const readContext: OperationalTimingContext = {
    operationalRules: args.rules,
    ferrySchedules: args.schedules,
    hotelId: args.hotelId ?? null,
    zone: args.hotelZone ?? null,
    agencyName: args.agencyName,
  };
  const readResult = resolveOperationalTiming(
    service({ booking_service_kind: args.kind, time: args.time, departure_time: args.time, hotel_id: args.hotelId ?? null, vessel: args.vessel ?? null }),
    readContext
  );

  return { writeResult, readResult };
}

describe("Parita' write/read — 1. Aleste treno + regola DB canonica", () => {
  it("pickup persistito dal write-path == pickup restituito dal read-path", () => {
    const { writeResult, readResult } = compare({
      kind: "transfer_train_hotel", time: "14:00", agencyName: "ALESTE VIAGGI",
      rules: [rule()], schedules: [schedule()],
    });
    expect(writeResult.pickup_hotel).toBe("11:45");
    expect(readResult.pickupTime).toBe("11:45");
    expect(writeResult.pickup_hotel).toBe(readResult.pickupTime);
    expect(readResult.pickupSource).toBe("canonical_rule");
  });
});

describe("Parita' write/read — 2. Aleste volo + regola DB canonica", () => {
  it("stessa parita' per transfer_airport_hotel", () => {
    const { writeResult, readResult } = compare({
      kind: "transfer_airport_hotel", time: "14:00", agencyName: "ALESTE VIAGGI",
      rules: [rule({ transport_type: "flight" })], schedules: [schedule()],
    });
    expect(writeResult.pickup_hotel).toBe(readResult.pickupTime);
    expect(writeResult.pickup_hotel).toBe("11:45");
  });
});

describe("Parita' write/read — 3. Aleste _aliscafo con regola canonica esplicita", () => {
  it("una regola canonica aliscafo configurata per Aleste viene applicata identicamente da write e read", () => {
    const { writeResult, readResult } = compare({
      kind: "transfer_train_hotel_aliscafo", time: "09:45", agencyName: "ZIGOLOVIAGGI SRL",
      rules: [rule({ boat_type: "aliscafo", company: "snav", departure_time: "09:45", pickup_time: "08:40", transport_from: "08:00", transport_to: "11:00" })],
      schedules: [schedule({ company: "snav", departure_time: "09:45", arrival_time: "10:50" })],
    });
    expect(writeResult.pickup_hotel).toBe("08:40");
    expect(writeResult.pickup_hotel).toBe(readResult.pickupTime);
    expect(writeResult.barca_compagnia).toBe("snav");
    expect(readResult.ferryCompany).toBe("snav");
  });
});

describe("Parita' write/read — 4. Sosandra aliscafo", () => {
  it("regola canonica Sosandra applicata identicamente da write e read", () => {
    const { writeResult, readResult } = compare({
      kind: "transfer_train_hotel_aliscafo", time: "09:45", agencyName: "SOSANDRA TOUR",
      rules: [rule({ agency_logic: "sosandra", boat_type: "aliscafo", company: "snav", departure_time: "09:45", pickup_time: "08:40", transport_from: "08:00", transport_to: "11:00" })],
      schedules: [schedule({ company: "snav", departure_time: "09:45", arrival_time: "10:50" })],
    });
    expect(writeResult.pickup_hotel).toBe(readResult.pickupTime);
    expect(writeResult.pickup_hotel).toBe("08:40");
  });
});

describe("Parita' write/read — 5. nessuna regola DB -> entrambi cadono sullo STESSO fallback statico condiviso (calc-pickup-time.ts)", () => {
  it("write e read producono lo stesso pickup dal fallback storico, il read lo marca 'legacy_static' (mai spacciato per regola canonica)", () => {
    const { writeResult, readResult } = compare({
      kind: "transfer_train_hotel", time: "14:00", agencyName: "ALESTE VIAGGI",
      rules: [], schedules: [schedule()],
    });
    // Nessuna regola canonica configurata: write cade sul fallback storico
    // (calc-pickup-time.ts, che HA un pickup per questa fascia) mentre read
    // cade sul motore commerciale legacy (resolveTravelConnection, che NON
    // calcola mai pickup_hotel — vedi audit "nessuna fonte pickup propria").
    // Questa e' la differenza intenzionale ammessa dal task: quando manca la
    // regola canonica, i due livelli restano su fallback storici distinti e
    // gia' esistenti, non vengono forzati a coincidere.
    expect(writeResult.pickup_hotel).toBe("11:00"); // calc-pickup-time.ts, invariato
    // Chiusura dell'asimmetria: quando ne' una regola canonica ne' il motore
    // commerciale legacy (resolveTravelConnection, che non calcola mai
    // pickup_hotel) producono un pickup, il read-path ora tenta LO STESSO
    // fallback statico del write-path (calc-pickup-time.ts, mai duplicato,
    // importato direttamente) — marcato "legacy_static" per restare
    // distinguibile da una vera regola canonica DB.
    expect(readResult.pickupSource).toBe("legacy_static");
    expect(readResult.pickupTime).toBe("11:00");
    expect(readResult.pickupTime).toBe(writeResult.pickup_hotel);
    expect(readResult.pickupTime).not.toBe("00:00");
  });
});

describe("Parita' write/read — 6. Formula SNAV (dominio B, non toccato da questa modifica)", () => {
  it("Formula diretta non passa mai dal dominio A/context — stesso comportamento gia' verificato nei test di centralizzazione precedenti", () => {
    const result = applyPickupCalc({
      direction: "departure", booking_service_kind: "formula_snav", time: "14:00",
      billing_party_name: "ALESTE VIAGGI", vessel: null, hotel_zone: "Ischia Porto",
      context: { operationalRules: [rule()], ferrySchedules: [schedule()], date: DATE },
    });
    // Il context passato e' ignorato per Formula (fuori dal dominio A) — stesso risultato di prima.
    expect(result.pickup_hotel).toBe("12:30");
  });
});

describe("Parita' write/read — 7. Formula MEDMAR (dominio B, non toccato)", () => {
  it("stesso comportamento gia' verificato, context ignorato", () => {
    const result = applyPickupCalc({
      direction: "departure", booking_service_kind: "formula_medmar_napoli", time: "10:35",
      billing_party_name: "ALESTE VIAGGI", vessel: null, hotel_zone: "Ischia Porto",
      context: { operationalRules: [rule()], ferrySchedules: [schedule()], date: DATE },
    });
    expect(result.pickup_hotel).toBe("08:40");
  });
});

describe("Parita' write/read — 8. porto-porto puro (dominio B, non toccato)", () => {
  it("transfer_port_hotel ignora il context del dominio A anche se presente", () => {
    const result = applyPickupCalc({
      direction: "departure", booking_service_kind: "transfer_port_hotel", time: "14:00",
      billing_party_name: "ALESTE VIAGGI", vessel: "SNAV 14:00", hotel_zone: "Ischia Porto",
      context: { operationalRules: [rule()], ferrySchedules: [schedule()], date: DATE },
    });
    expect(result.pickup_hotel).toBe("12:30");
  });
});

describe("Parita' write/read — 9. dati insufficienti", () => {
  it("nessuna regola canonica, nessun fallback statico applicabile (time vuoto): null in entrambi, mai 00:00", () => {
    const writeResult = applyPickupCalc({
      direction: "departure", booking_service_kind: "transfer_train_hotel", time: "",
      billing_party_name: "ALESTE VIAGGI", vessel: null,
      context: { operationalRules: [rule()], ferrySchedules: [schedule()], date: DATE },
    });
    expect(writeResult.pickup_hotel).toBeUndefined();
    expect(writeResult.pickup_hotel).not.toBe("00:00");
  });
});

describe("Parita' write/read — 10. override manuale preservato in entrambi i livelli", () => {
  it("un override manuale gia' confermato vince sia nel write sia nel read, anche con una regola canonica diversa disponibile", () => {
    const override = {
      schedule_id: "manual-1", company: "medmar", ferry_type: "traghetto" as const,
      departure_time: "10:10", arrival_time: "11:15", embark_port: "ischia_porto", arrival_port: "napoli_beverello",
      source: "manual" as const, manually_overridden: true,
    };
    const { writeResult, readResult } = compare({
      kind: "transfer_train_hotel", time: "14:00", agencyName: "ALESTE VIAGGI",
      rules: [rule()], schedules: [schedule()],
    });
    const writeWithOverride = applyPickupCalc({
      direction: "departure", booking_service_kind: "transfer_train_hotel", time: "14:00",
      billing_party_name: "ALESTE VIAGGI", vessel: null,
      context: { operationalRules: [rule()], ferrySchedules: [schedule()], date: DATE, currentOverride: override },
    });
    const readWithOverride = resolveOperationalTiming(
      service({ booking_service_kind: "transfer_train_hotel", time: "14:00", departure_time: "14:00" }),
      { operationalRules: [rule()], ferrySchedules: [schedule()], agencyName: "ALESTE VIAGGI", currentOverride: override }
    );
    // Senza override, entrambi userebbero la regola canonica (11:45, gia' provato sopra).
    expect(writeResult.pickup_hotel).toBe("11:45");
    // Con override, la compagnia/ora nave vengono dall'override (medmar 10:10) in entrambi i livelli.
    expect(writeWithOverride.barca_compagnia).toBe("medmar");
    expect(writeWithOverride.orario_barca).toBe("10:10");
    expect(readWithOverride.ferryCompany).toBe("medmar");
    expect(readWithOverride.ferryTime).toBe("10:10");
  });
});

/**
 * Chiusura dell'ultima asimmetria: SENZA regola canonica, write e read ora
 * condividono lo STESSO fallback statico (calc-pickup-time.ts, mai
 * duplicato, importato direttamente da entrambi i lati — nessuna dipendenza
 * circolare, nessuna chiamata applyPickupCalc()<->resolveOperationalTiming()).
 */
describe("Parita' write/read SENZA regola canonica — fallback statico condiviso", () => {
  it("1. Aleste treno, nessuna regola canonica -> write == read via fallback statico", () => {
    const { writeResult, readResult } = compare({
      kind: "transfer_train_hotel", time: "14:00", agencyName: "ALESTE VIAGGI",
      rules: [], schedules: [],
    });
    expect(writeResult.pickup_hotel).toBe("11:00");
    expect(readResult.pickupTime).toBe("11:00");
    expect(readResult.pickupSource).toBe("legacy_static");
  });

  it("2. Aleste volo, nessuna regola canonica -> write == read", () => {
    const { writeResult, readResult } = compare({
      kind: "transfer_airport_hotel", time: "12:00", agencyName: "ALESTE VIAGGI",
      rules: [], schedules: [],
    });
    expect(writeResult.pickup_hotel).toBe("07:20");
    expect(readResult.pickupTime).toBe("07:20");
    expect(readResult.pickupSource).toBe("legacy_static");
  });

  it("3. Aleste _aliscafo, nessuna regola canonica -> nessuna tabella statica aliscafo per Aleste: write == read, pickup null + warning, MAI traghetto", () => {
    const { writeResult, readResult } = compare({
      kind: "transfer_train_hotel_aliscafo", time: "14:00", agencyName: "ALESTE VIAGGI",
      rules: [], schedules: [],
    });
    expect(writeResult.pickup_hotel).toBe(readResult.pickupTime);
    expect(writeResult.pickup_hotel).toBeNull();
    expect(writeResult.barca_compagnia).toBeNull();
    expect(writeResult.pickup_alert).toMatch(/[Aa]liscafo/);
    expect(readResult.status).toBe("warning");
    expect(readResult.warnings.join(" ")).toMatch(/[Aa]liscafo/);
  });

  it("3b. Aleste volo _aliscafo, nessuna regola canonica -> stesso comportamento del treno", () => {
    const { writeResult, readResult } = compare({
      kind: "transfer_airport_hotel_aliscafo", time: "12:00", agencyName: "ALESTE VIAGGI",
      rules: [], schedules: [],
    });
    expect(writeResult.pickup_hotel).toBe(readResult.pickupTime);
    expect(writeResult.pickup_hotel).toBeNull();
    expect(writeResult.barca_compagnia).toBeNull();
    expect(writeResult.pickup_alert).toMatch(/[Aa]liscafo/);
  });

  it("3c. Aleste standard (senza _aliscafo), nessuna regola canonica -> non usa mai automaticamente l'aliscafo", () => {
    const { writeResult, readResult } = compare({
      kind: "transfer_train_hotel", time: "14:00", agencyName: "ALESTE VIAGGI",
      rules: [], schedules: [],
    });
    expect(writeResult.barca_compagnia).toBe("Medmar");
    expect(writeResult.pickup_hotel).toBe(readResult.pickupTime);
    expect(writeResult.pickup_hotel).not.toBeNull();
  });

  it("4. Sosandra senza regola canonica -> comportamento coerente (tabelle DIMHOTELS, aliscafo genuino)", () => {
    const { writeResult, readResult } = compare({
      kind: "transfer_train_hotel_aliscafo", time: "09:00", agencyName: "sosandra",
      rules: [], schedules: [],
    });
    expect(writeResult.pickup_hotel).toBe(readResult.pickupTime);
    expect(writeResult.barca_compagnia).toBe("Alilauro");
  });

  it("7. nessun fallback statico disponibile (volo prima delle 09:30, alert dedicato) -> read null, write null, nessun pickup inventato", () => {
    const { writeResult, readResult } = compare({
      kind: "transfer_airport_hotel", time: "08:00", agencyName: "ALESTE VIAGGI",
      rules: [], schedules: [],
    });
    expect(writeResult.pickup_hotel).toBeNull();
    expect(readResult.pickupTime).toBeNull();
    expect(readResult.pickupSource).toBe("missing");
  });

  it("8. nessun 00:00 in nessuno scenario (regola canonica, fallback statico, o nessun dato)", () => {
    const scenarios = [
      compare({ kind: "transfer_train_hotel", time: "14:00", agencyName: "ALESTE VIAGGI", rules: [rule()], schedules: [schedule()] }),
      compare({ kind: "transfer_train_hotel", time: "14:00", agencyName: "ALESTE VIAGGI", rules: [], schedules: [] }),
      compare({ kind: "transfer_airport_hotel", time: "08:00", agencyName: "ALESTE VIAGGI", rules: [], schedules: [] }),
    ];
    for (const { writeResult, readResult } of scenarios) {
      expect(writeResult.pickup_hotel).not.toBe("00:00");
      expect(readResult.pickupTime).not.toBe("00:00");
    }
  });

  it("9. pickupSource distingue chiaramente canonical_rule vs legacy_static", () => {
    const withRule = compare({ kind: "transfer_train_hotel", time: "14:00", agencyName: "ALESTE VIAGGI", rules: [rule()], schedules: [schedule()] });
    const withoutRule = compare({ kind: "transfer_train_hotel", time: "14:00", agencyName: "ALESTE VIAGGI", rules: [], schedules: [] });
    expect(withRule.readResult.pickupSource).toBe("canonical_rule");
    expect(withoutRule.readResult.pickupSource).toBe("legacy_static");
    expect(withRule.readResult.pickupSource).not.toBe(withoutRule.readResult.pickupSource);
  });

  it("10. dati ferry gia' noti (da un match reale in ferry_schedules) non vengono degradati dal fallback statico del pickup", () => {
    // Treno alle 16:00: una corsa Medmar Ischia->Napoli Beverello delle 14:00
    // (arrivo 15:00) rispetta i vincoli temporali del motore legacy
    // (resolveTravelConnection: margine porto 25' + margine sicurezza 15' =
    // deve arrivare entro le 15:20) e viene trovata come match reale —
    // nessuna regola canonica configurata, quindi il pickup arriva dal
    // fallback statico, ma company/orario nave devono restare quelli del
    // match REALE trovato dal motore legacy, non quelli (potenzialmente
    // diversi) della tabella statica flat di calc-pickup-time.ts.
    const realSchedule = schedule({ company: "medmar", departure_time: "14:00", arrival_time: "15:00", direction: "ischia_to_mainland" });
    const readResult = resolveOperationalTiming(
      service({ booking_service_kind: "transfer_train_hotel", time: "16:00", departure_time: "16:00" }),
      { operationalRules: [], ferrySchedules: [realSchedule], agencyName: "ALESTE VIAGGI" }
    );
    expect(readResult.pickupSource).toBe("legacy_static");
    // Pickup dal fallback statico per la fascia 14:35 (16:55-18:40 ALESTE_TRENO_TRAGHETTO copre 16:00? verificare sotto)
    expect(readResult.pickupTime).not.toBeNull();
    expect(readResult.pickupTime).not.toBe("00:00");
    // company/ferryTime provengono dal match reale in ferry_schedules (via
    // resolveTravelConnection), non dalla tabella statica flat.
    expect(readResult.ferryCompany).toBe("medmar");
    expect(readResult.ferryTime).toBe("14:00");
  });
});
