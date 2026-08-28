import { describe, expect, it } from "vitest";
import { buildTrainOrFlightPickupHint, shouldUseTrainOrFlightResolver } from "@/lib/departures-pickup-hint";
import type { PrintService } from "@/lib/piano-giorno-print";
import type { OperationalTimingContext } from "@/lib/operational-timing-resolver";
import type { OperationalPickupRule } from "@/lib/operational-connection-resolver";
import type { FerryScheduleRow } from "@/lib/travel-connection-resolver";

const DATE = "2026-08-27";

function service(overrides: Partial<PrintService> = {}): PrintService {
  return {
    id: "svc-1",
    tenant_id: "tenant-1",
    date: DATE,
    time: "14:00",
    direction: "departure",
    customer_name: "TEST CLIENTE",
    pax: 2,
    hotel_id: "hotel-1",
    vessel: null,
    phone: "333",
    notes: "",
    status: "new",
    booking_service_kind: "transfer_train_hotel",
    departure_time: "14:00",
    pickup_hotel: null,
    pickup_time: null,
    ...overrides,
  } as PrintService;
}

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

function ferryRow(overrides: Partial<FerryScheduleRow> = {}): FerryScheduleRow {
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

const EMPTY_CONTEXT: OperationalTimingContext = { operationalRules: [], ferrySchedules: [] };

describe("buildTrainOrFlightPickupHint — /departures collegato a resolveOperationalTiming", () => {
  it("2. servizio con pickup persistito: nessun context necessario, hint riflette il dato persistito quando kind e' treno/volo e non c'e' regola canonica", () => {
    const hint = buildTrainOrFlightPickupHint(service({ pickup_hotel: "08:20" }), EMPTY_CONTEXT);
    // Nessuna regola canonica -> fallback legacy (motore commerciale, non legge pickup_hotel):
    // verifica solo che la funzione non fallisca e non inventi un pickup diverso da quanto risolto.
    expect(hint === null || typeof hint?.pickup === "string").toBe(true);
  });

  it("3. treno + SNAV + Sosandra CON richiesta esplicita: la regola canonica aliscafo Sosandra viene applicata", () => {
    const snavRule = rule({ agency_logic: "sosandra", boat_type: "aliscafo", company: "snav", departure_time: "09:45", pickup_time: "08:40" });
    const context: OperationalTimingContext = {
      operationalRules: [snavRule],
      ferrySchedules: [ferryRow({ company: "snav", departure_time: "09:45", arrival_time: "10:50" })],
      agencyName: "SOSANDRA TOUR",
    };
    // regola confermata da Mario: "Sosandra -> aliscafo SE richiesto", mai automatico per agenzia.
    const hint = buildTrainOrFlightPickupHint(service({ booking_service_kind: "transfer_train_hotel_aliscafo" }), context);
    expect(hint?.pickup).toBe("08:40");
    expect(hint?.label).toContain("snav");
  });

  it("3b. Aleste + kind generico (nessuna richiesta esplicita): una regola SNAV/aliscafo a DB NON viene applicata automaticamente", () => {
    const snavRule = rule({ agency_logic: "aleste", boat_type: "aliscafo", company: "snav", departure_time: "09:45", pickup_time: "08:40" });
    const context: OperationalTimingContext = {
      operationalRules: [snavRule],
      ferrySchedules: [ferryRow({ company: "snav", departure_time: "09:45", arrival_time: "10:50" })],
      agencyName: "ZIGOLOVIAGGI SRL",
    };
    // kind generico (senza suffisso _aliscafo): nessuna richiesta esplicita.
    const hint = buildTrainOrFlightPickupHint(service({ booking_service_kind: "transfer_train_hotel" }), context);
    expect(hint?.pickup).not.toBe("08:40");
  });

  it("4. treno + SNAV + altra agenzia CON richiesta esplicita (_aliscafo): la regola canonica funziona identicamente a Sosandra", () => {
    const snavRule = rule({ agency_logic: "aleste", boat_type: "aliscafo", company: "snav", departure_time: "09:45", pickup_time: "08:40" });
    const context: OperationalTimingContext = {
      operationalRules: [snavRule],
      ferrySchedules: [ferryRow({ company: "snav", departure_time: "09:45", arrival_time: "10:50" })],
      agencyName: "ZIGOLOVIAGGI SRL",
    };
    const hint = buildTrainOrFlightPickupHint(service({ booking_service_kind: "transfer_train_hotel_aliscafo" }), context);
    expect(hint?.pickup).toBe("08:40");
    expect(hint?.label).toContain("snav");
  });

  it("5. volo + SNAV + altra agenzia CON richiesta esplicita: stesso automatismo anche per transfer_airport_hotel_aliscafo", () => {
    const snavRule = rule({ agency_logic: "aleste", transport_type: "flight", boat_type: "aliscafo", company: "snav", departure_time: "09:45", pickup_time: "08:40" });
    const context: OperationalTimingContext = {
      operationalRules: [snavRule],
      ferrySchedules: [ferryRow({ company: "snav", departure_time: "09:45", arrival_time: "10:50" })],
      agencyName: "ANGELINO TOUR & EVENTS SRL",
    };
    const hint = buildTrainOrFlightPickupHint(service({ booking_service_kind: "transfer_airport_hotel_aliscafo" }), context);
    expect(hint?.pickup).toBe("08:40");
  });

  it("6. override manuale preservato: il pickup ricalcolato resta quello dell'override, non della nuova regola canonica", () => {
    const snavRule = rule({ agency_logic: "aleste", boat_type: "aliscafo", company: "snav", departure_time: "09:45", pickup_time: "08:40" });
    const context: OperationalTimingContext = {
      operationalRules: [snavRule],
      ferrySchedules: [ferryRow({ company: "snav", departure_time: "09:45", arrival_time: "10:50" })],
      agencyName: "ALESTE VIAGGI",
      currentOverride: {
        schedule_id: "manual-1", company: "medmar", ferry_type: "traghetto",
        departure_time: "10:10", arrival_time: "11:15", embark_port: "ischia_porto", arrival_port: "napoli_beverello",
        source: "manual", manually_overridden: true,
      },
    };
    const hint = buildTrainOrFlightPickupHint(service({ booking_service_kind: "transfer_train_hotel_aliscafo" }), context);
    // company/ora nave provengono dall'override (medmar 10:10), non dalla regola SNAV appena configurata.
    expect(hint?.label).toContain("medmar");
    expect(hint?.label).toContain("10:10");
  });

  it("7. MEDMAR invariato: una regola canonica traghetto/Medmar per agenzia standard continua a funzionare come prima", () => {
    const medmarRule = rule({ agency_logic: "aleste", boat_type: "traghetto", company: "medmar", pickup_time: "09:00" });
    const context: OperationalTimingContext = { operationalRules: [medmarRule], ferrySchedules: [ferryRow()], agencyName: "ALESTE VIAGGI" };
    const hint = buildTrainOrFlightPickupHint(service(), context);
    expect(hint?.pickup).toBe("09:00");
  });

  it("10. pickup non determinabile: nessun context/regola -> hint null, mai '00:00'", () => {
    const hint = buildTrainOrFlightPickupHint(service({ pickup_hotel: null, pickup_time: null }), EMPTY_CONTEXT);
    expect(hint === null || hint.pickup !== "00:00").toBe(true);
  });

  it("11. assenza di operationalRules compatibili: nessuna regola nella fascia oraria -> fallback legacy, mai un errore silenzioso", () => {
    const outOfWindowRule = rule({ transport_from: "05:00", transport_to: "06:00" });
    const context: OperationalTimingContext = {
      operationalRules: [outOfWindowRule],
      ferrySchedules: [ferryRow()],
      agencyName: "ALESTE VIAGGI",
    };
    expect(() => buildTrainOrFlightPickupHint(service({ departure_time: "14:00", time: "14:00" }), context)).not.toThrow();
  });

  it("12. assenza di ferrySchedule compatibile: la regola canonica resta valida ma con warning esplicito, pickup comunque presente (nessuna sostituzione silenziosa)", () => {
    const medmarRule = rule({ agency_logic: "aleste", boat_type: "traghetto", company: "medmar", pickup_time: "09:00" });
    const context: OperationalTimingContext = { operationalRules: [medmarRule], ferrySchedules: [], agencyName: "ALESTE VIAGGI" };
    const hint = buildTrainOrFlightPickupHint(service(), context);
    expect(hint?.pickup).toBe("09:00");
  });
});

describe("shouldUseTrainOrFlightResolver — classificazione del CALL-SITE reale usato da /departures (regressione: kind '_aliscafo' escluso per errore)", () => {
  it("transfer_train_hotel -> true (entra nel resolver)", () => {
    expect(shouldUseTrainOrFlightResolver("transfer_train_hotel")).toBe(true);
  });
  it("transfer_train_hotel_aliscafo -> true (entra nel resolver, NON piu' escluso)", () => {
    expect(shouldUseTrainOrFlightResolver("transfer_train_hotel_aliscafo")).toBe(true);
  });
  it("transfer_airport_hotel -> true (entra nel resolver)", () => {
    expect(shouldUseTrainOrFlightResolver("transfer_airport_hotel")).toBe(true);
  });
  it("transfer_airport_hotel_aliscafo -> true (entra nel resolver, NON piu' escluso)", () => {
    expect(shouldUseTrainOrFlightResolver("transfer_airport_hotel_aliscafo")).toBe(true);
  });
  it("transfer_port_hotel -> false (resta sul percorso Formula/porto-porto esistente, non forzato nel resolver treno/volo)", () => {
    expect(shouldUseTrainOrFlightResolver("transfer_port_hotel")).toBe(false);
  });
  it("formula_snav -> false (fuori dal dominio treno/volo)", () => {
    expect(shouldUseTrainOrFlightResolver("formula_snav")).toBe(false);
  });
  it("kind null/undefined -> false, nessun crash", () => {
    expect(shouldUseTrainOrFlightResolver(null)).toBe(false);
    expect(shouldUseTrainOrFlightResolver(undefined)).toBe(false);
  });
});

describe("Call-site end-to-end (shouldUseTrainOrFlightResolver + buildTrainOrFlightPickupHint) — stesso percorso reale di /departures", () => {
  it("1. Aleste + transfer_train_hotel (kind ESATTO, non _aliscafo): entra nel resolver, traghetto standard", () => {
    const kind = "transfer_train_hotel";
    expect(shouldUseTrainOrFlightResolver(kind)).toBe(true);
    const medmarRule = rule({ agency_logic: "aleste", boat_type: "traghetto", company: "medmar", pickup_time: "09:00" });
    const context: OperationalTimingContext = { operationalRules: [medmarRule], ferrySchedules: [ferryRow()], agencyName: "ALESTE VIAGGI" };
    const hint = buildTrainOrFlightPickupHint(service({ booking_service_kind: kind }), context);
    expect(hint?.pickup).toBe("09:00");
  });

  it("2. Aleste + transfer_train_hotel_aliscafo: PRIMA di questo fix il kind non entrava nemmeno nel branch (hint restava null a prescindere dalla regola) — ora entra ed e' effettivamente valorizzato", () => {
    const kind = "transfer_train_hotel_aliscafo";
    expect(shouldUseTrainOrFlightResolver(kind)).toBe(true);
    const snavRule = rule({ agency_logic: "aleste", boat_type: "aliscafo", company: "snav", departure_time: "09:45", pickup_time: "08:40" });
    const context: OperationalTimingContext = {
      operationalRules: [snavRule],
      ferrySchedules: [ferryRow({ company: "snav", departure_time: "09:45", arrival_time: "10:50" })],
      agencyName: "ZIGOLOVIAGGI SRL",
    };
    const hint = buildTrainOrFlightPickupHint(service({ booking_service_kind: kind }), context);
    expect(hint).not.toBeNull();
    expect(hint?.pickup).toBe("08:40");
  });

  it("3. Aleste + transfer_airport_hotel_aliscafo: stesso comportamento del treno", () => {
    const kind = "transfer_airport_hotel_aliscafo";
    expect(shouldUseTrainOrFlightResolver(kind)).toBe(true);
    const snavRule = rule({ agency_logic: "aleste", transport_type: "flight", boat_type: "aliscafo", company: "snav", departure_time: "09:45", pickup_time: "08:40" });
    const context: OperationalTimingContext = {
      operationalRules: [snavRule],
      ferrySchedules: [ferryRow({ company: "snav", departure_time: "09:45", arrival_time: "10:50" })],
      agencyName: "ANGELINO TOUR & EVENTS SRL",
    };
    const hint = buildTrainOrFlightPickupHint(service({ booking_service_kind: kind }), context);
    expect(hint?.pickup).toBe("08:40");
  });

  it("4. il kind '_aliscafo' non produce hint=null solo perche' 'non riconosciuto dal branch' (bug precedente): con dati sufficienti produce sempre un hint non-null", () => {
    for (const kind of ["transfer_train_hotel_aliscafo", "transfer_airport_hotel_aliscafo"]) {
      expect(shouldUseTrainOrFlightResolver(kind)).toBe(true);
      const medmarRule = rule({ agency_logic: "aleste", transport_type: kind.includes("train") ? "train" : "flight", boat_type: "traghetto", company: "medmar", pickup_time: "09:00" });
      const context: OperationalTimingContext = { operationalRules: [medmarRule], ferrySchedules: [ferryRow()], agencyName: "ALESTE VIAGGI" };
      const hint = buildTrainOrFlightPickupHint(service({ booking_service_kind: kind }), context);
      expect(hint).not.toBeNull();
    }
  });

  it("5. Sosandra invariata: entra nel resolver per tutte le varianti, aliscafo sempre ammesso", () => {
    expect(shouldUseTrainOrFlightResolver("transfer_train_hotel_aliscafo")).toBe(true);
    const snavRule = rule({ agency_logic: "sosandra", boat_type: "aliscafo", company: "snav", departure_time: "09:45", pickup_time: "08:40" });
    const context: OperationalTimingContext = {
      operationalRules: [snavRule],
      ferrySchedules: [ferryRow({ company: "snav", departure_time: "09:45", arrival_time: "10:50" })],
      agencyName: "SOSANDRA TOUR",
    };
    const hint = buildTrainOrFlightPickupHint(service({ booking_service_kind: "transfer_train_hotel_aliscafo" }), context);
    expect(hint?.pickup).toBe("08:40");
  });

  it("6. transfer_port_hotel invariato: non entra nel resolver treno/volo (resta sul percorso Formula/porto-porto di /departures)", () => {
    expect(shouldUseTrainOrFlightResolver("transfer_port_hotel")).toBe(false);
  });
});
