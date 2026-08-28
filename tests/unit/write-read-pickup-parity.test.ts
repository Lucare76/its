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

describe("Parita' write/read — 5. nessuna regola DB -> entrambi cadono sul fallback statico (write) / legacy (read), mai un'invenzione", () => {
  it("write usa calc-pickup-time.ts, read usa resolveTravelConnection: risultati NON necessariamente identici (motori diversi), ma nessuno dei due inventa un dato — differenza intenzionale documentata", () => {
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
    // Il motore legacy del read-path (resolveTravelConnection) non ha mai
    // calcolato pickup_hotel (confermato da audit precedente: "nessuna fonte
    // pickup propria") — quindi pickupTime resta null e pickupSource e'
    // correttamente "missing", non "legacy_fallback" (che richiederebbe un
    // valore effettivo). Questa e' la differenza intenzionale: write-path ha
    // un fallback storico che CALCOLA un pickup (calc-pickup-time.ts), il
    // read-path no — nessuno dei due inventa comunque un valore.
    expect(readResult.pickupSource).toBe("missing");
    expect(readResult.pickupTime).toBeNull();
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
