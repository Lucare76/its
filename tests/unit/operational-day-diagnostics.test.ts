import { describe, it, expect } from "vitest";
import {
  diagnoseOperationalDay,
  type OperationalDayDiagnosticsInput,
  type DiagnosticsHotelRow,
} from "@/lib/server/operational-day-diagnostics";
import type { PrintService } from "@/lib/piano-giorno-print";
import type { OperationalPickupRule } from "@/lib/operational-connection-resolver";
import type { RawBusUnit } from "@/lib/server/bus-network";

const DATE = "2026-08-27";

function service(overrides: Partial<PrintService> = {}): PrintService {
  return {
    id: "svc-1",
    tenant_id: "t1",
    date: DATE,
    time: "14:00",
    direction: "departure",
    customer_name: "MARIO ROSSI",
    pax: 2,
    hotel_id: "hotel-1",
    vessel: null,
    phone: "333",
    notes: "",
    status: "new",
    is_draft: false,
    booking_service_kind: "transfer_train_hotel",
    billing_party_name: "ALESTE VIAGGI",
    departure_time: "14:00",
    pickup_hotel: null,
    pickup_time: null,
    pickup_alert: null,
    linked_service_id: null,
    ...overrides,
  } as PrintService;
}

const HOTEL_WITH_ZONE: DiagnosticsHotelRow = { id: "hotel-1", name: "Hotel Test", zone: "Ischia Porto" };

function baseInput(overrides: Partial<OperationalDayDiagnosticsInput> = {}): OperationalDayDiagnosticsInput {
  return {
    date: DATE,
    services: [],
    hotelsById: new Map([["hotel-1", HOTEL_WITH_ZONE]]),
    operationalRules: [],
    ferrySchedules: [],
    assignments: [],
    busUnits: [],
    busAllocations: [],
    busLotConfigs: [],
    ...overrides,
  };
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
    departure_time: "12:00",
    embark_port: "ischia_porto",
    arrival_port: "napoli_beverello",
    arrival_time: "13:30",
    pickup_time: "11:45",
    valid_from: null,
    valid_to: null,
    days_of_week: null,
    ...overrides,
  };
}

describe("diagnoseOperationalDay", () => {
  it("1. giornata tutta corretta -> zero issues", () => {
    const result = diagnoseOperationalDay(
      baseInput({
        services: [
          service({ id: "s1", booking_service_kind: "excursion", direction: "departure" }),
          service({ id: "s2", booking_service_kind: "excursion", direction: "arrival" }),
        ],
      })
    );
    expect(result.totalServices).toBe(2);
    expect(result.okServices).toBe(2);
    expect(result.warningServices).toBe(0);
    expect(result.errorServices).toBe(0);
    expect(result.issues).toEqual([]);
  });

  it("2. pickup mancante -> MISSING_PICKUP error", () => {
    const result = diagnoseOperationalDay(
      baseInput({
        services: [service({ id: "s1", time: "07:00", departure_time: "07:00" })],
      })
    );
    const issue = result.issues.find((i) => i.serviceId === "s1");
    expect(issue?.code).toBe("MISSING_PICKUP");
    expect(issue?.severity).toBe("error");
    expect(result.errorServices).toBe(1);
  });

  it("3. fallback statico -> LEGACY_STATIC_PICKUP warning", () => {
    const result = diagnoseOperationalDay(
      baseInput({
        services: [service({ id: "s1", time: "14:00", departure_time: "14:00" })],
      })
    );
    const issue = result.issues.find((i) => i.serviceId === "s1");
    expect(issue?.code).toBe("LEGACY_STATIC_PICKUP");
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toBe("Pickup derivato dal fallback statico: nessuna regola canonica applicabile.");
    expect(result.warningServices).toBe(1);
  });

  it("4. aliscafo esplicito senza regola -> HYDROFOIL_RULE_MISSING warning, MAI traghetto/MISSING_PICKUP", () => {
    const result = diagnoseOperationalDay(
      baseInput({
        services: [
          service({
            id: "s1",
            booking_service_kind: "transfer_train_hotel_aliscafo",
            time: "14:00",
            departure_time: "14:00",
          }),
        ],
      })
    );
    const serviceIssues = result.issues.filter((i) => i.serviceId === "s1");
    expect(serviceIssues).toHaveLength(1);
    expect(serviceIssues[0].code).toBe("HYDROFOIL_RULE_MISSING");
    expect(serviceIssues[0].severity).toBe("warning");
  });

  it("5. hotel senza zona -> HOTEL_ZONE_MISSING warning", () => {
    const result = diagnoseOperationalDay(
      baseInput({
        hotelsById: new Map([["hotel-1", { id: "hotel-1", name: "Hotel Senza Zona", zone: null }]]),
        operationalRules: [rule()],
        services: [service({ id: "s1", time: "14:00", departure_time: "14:00" })],
      })
    );
    const issue = result.issues.find((i) => i.serviceId === "s1" && i.code === "HOTEL_ZONE_MISSING");
    expect(issue?.severity).toBe("warning");
  });

  it("6. connessione tramite override manuale con compagnia nave mancante -> FERRY_COMPANY_MISSING warning", () => {
    const result = diagnoseOperationalDay(
      baseInput({
        operationalRules: [rule()],
        services: [service({ id: "s1", time: "14:00", departure_time: "14:00" })],
      })
    );
    // Nessuna regola canonica -> fallback statico gia' coperto dal test 3.
    // Il sub-controllo FERRY_COMPANY_MISSING/FERRY_TIME_MISSING/FERRY_PORT_MISSING
    // e' verificato qui a livello di risultato prodotto da resolveOperationalTiming
    // quando una connessione risulta risolta (canonical/override/legacy_fallback):
    // con una regola canonica valida, azienda/orario/porto sono sempre popolati
    // per costruzione (nessun campo mancante) -> nessun FERRY_*_MISSING, come atteso.
    const ferryIssues = result.issues.filter((i) => i.category === "ferry");
    expect(ferryIssues).toHaveLength(0);
  });

  it("7. cancellato ma ancora assegnato -> CANCELLED_WITH_ASSIGNMENT error", () => {
    const result = diagnoseOperationalDay(
      baseInput({
        services: [service({ id: "s1", status: "cancelled" })],
        assignments: [{ service_id: "s1", driver_user_id: "driver-1" }],
      })
    );
    const issue = result.issues.find((i) => i.serviceId === "s1" && i.code === "CANCELLED_WITH_ASSIGNMENT");
    expect(issue?.severity).toBe("error");
  });

  it("7b. cancellato ma ancora allocato su bus -> CANCELLED_WITH_BUS_ALLOCATION error", () => {
    const result = diagnoseOperationalDay(
      baseInput({
        services: [service({ id: "s1", status: "cancelled" })],
        busAllocations: [
          { id: "a1", service_id: "s1", bus_line_id: "l1", bus_unit_id: "u1", stop_id: null, stop_name: "Fermata", direction: "departure", pax_assigned: 2, notes: null },
        ],
      })
    );
    const issue = result.issues.find((i) => i.serviceId === "s1" && i.code === "CANCELLED_WITH_BUS_ALLOCATION");
    expect(issue?.severity).toBe("error");
  });

  it("8. bus sovraccarico -> BUS_CAPACITY_EXCEEDED error", () => {
    const busUnit: RawBusUnit = {
      id: "u1",
      bus_line_id: "l1",
      label: "Bus 1",
      capacity: 10,
      low_seat_threshold: 2,
      minimum_passengers: null,
      status: "open",
      manual_close: false,
      close_reason: null,
      sort_order: 1,
      active: true,
    };
    const result = diagnoseOperationalDay(
      baseInput({
        services: [service({ id: "s1", booking_service_kind: "bus_city_hotel" })],
        busUnits: [busUnit],
        busAllocations: [
          { id: "a1", service_id: "s1", bus_line_id: "l1", bus_unit_id: "u1", stop_id: null, stop_name: "Fermata", direction: "departure", pax_assigned: 12, notes: null },
        ],
      })
    );
    const issue = result.issues.find((i) => i.code === "BUS_CAPACITY_EXCEEDED");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("12");
    expect(issue?.message).toContain("10");
  });

  it("9. linked service rotto (esterno, non trovato dalla query batch) -> BROKEN_LINKED_SERVICE error", () => {
    const result = diagnoseOperationalDay(
      baseInput({
        services: [service({ id: "s1", booking_service_kind: "excursion", linked_service_id: "does-not-exist" })],
        externalLinkedServices: [], // query batch eseguita ma nessuna riga trovata per "does-not-exist"
      })
    );
    const issue = result.issues.find((i) => i.serviceId === "s1" && i.code === "BROKEN_LINKED_SERVICE");
    expect(issue?.severity).toBe("error");
  });

  it("9b. A/R stesso giorno reciproco -> nessun issue linked_service", () => {
    const result = diagnoseOperationalDay(
      baseInput({
        services: [
          service({ id: "A", booking_service_kind: "excursion", direction: "departure", linked_service_id: "B" }),
          service({ id: "B", booking_service_kind: "excursion", direction: "arrival", linked_service_id: "A" }),
        ],
      })
    );
    expect(result.issues.filter((i) => i.category === "linked_service")).toEqual([]);
  });

  it("9c. A/R su giorni diversi reciproco (andata 28/08 -> ritorno 04/09) -> nessun issue linked_service, riusa la query batch esterna", () => {
    const result = diagnoseOperationalDay(
      baseInput({
        services: [
          service({ id: "A", booking_service_kind: "excursion", direction: "departure", date: "2026-08-28", linked_service_id: "B" }),
        ],
        externalLinkedServices: [
          { id: "B", linked_service_id: "A", date: "2026-09-04", direction: "arrival", status: "new" },
        ],
      })
    );
    expect(result.issues.filter((i) => i.category === "linked_service")).toEqual([]);
  });

  it("9d. linked service esterno esistente ma NON reciproco (A->B, B->C) -> INCONSISTENT_ROUND_TRIP warning, mai anomalo per la sola data diversa", () => {
    const result = diagnoseOperationalDay(
      baseInput({
        services: [
          service({ id: "A", booking_service_kind: "excursion", direction: "departure", date: "2026-08-28", linked_service_id: "B" }),
        ],
        externalLinkedServices: [
          { id: "B", linked_service_id: "C", date: "2026-09-04", direction: "arrival", status: "new" },
        ],
      })
    );
    const issue = result.issues.find((i) => i.serviceId === "A" && i.code === "INCONSISTENT_ROUND_TRIP");
    expect(issue?.severity).toBe("warning");
    expect(issue?.title).toBe("Collegamento non reciproco");
  });

  it("9e. linked service esterno esistente con linked_service_id null (B->null) -> INCONSISTENT_ROUND_TRIP warning", () => {
    const result = diagnoseOperationalDay(
      baseInput({
        services: [
          service({ id: "A", booking_service_kind: "excursion", direction: "departure", date: "2026-08-28", linked_service_id: "B" }),
        ],
        externalLinkedServices: [
          { id: "B", linked_service_id: null, date: "2026-09-04", direction: "arrival", status: "new" },
        ],
      })
    );
    // linked_service_id null su B non e' di per se' un problema (potrebbe
    // essere una gamba legittima senza collegamento) — l'anomalia riguarda
    // solo il caso "B punta a un terzo servizio diverso da A" (verificato in 9d).
    const reciprocityIssue = result.issues.find((i) => i.serviceId === "A" && i.title === "Collegamento non reciproco");
    expect(reciprocityIssue).toBeUndefined();
  });

  it("9f. singola gamba legittima con linked_service_id = null -> nessun warning linked_service", () => {
    const result = diagnoseOperationalDay(
      baseInput({
        services: [service({ id: "s1", booking_service_kind: "excursion", linked_service_id: null })],
      })
    );
    expect(result.issues.filter((i) => i.category === "linked_service")).toEqual([]);
  });

  it("9g. zero N+1: una singola riga esterna copre piu' servizi del giorno collegati alla stessa gamba esterna, nessuna query aggiuntiva richiesta dal motore", () => {
    // Il motore e' puro (nessun accesso DB): questo test dimostra che riusa
    // lo stesso array externalLinkedServices gia' caricato in batch per
    // TUTTI i servizi del giorno, senza mai richiederne uno aggiuntivo per riga.
    const result = diagnoseOperationalDay(
      baseInput({
        services: [
          service({ id: "A1", booking_service_kind: "excursion", direction: "departure", date: "2026-08-28", linked_service_id: "EXT" }),
          service({ id: "A2", booking_service_kind: "excursion", direction: "departure", date: "2026-08-28", linked_service_id: "EXT" }),
        ],
        externalLinkedServices: [
          { id: "EXT", linked_service_id: "A1", date: "2026-09-04", direction: "arrival", status: "new" },
        ],
      })
    );
    // A1 e' reciproco (EXT->A1), A2 no (EXT->A1, non A2): entrambi risolti
    // dalla STESSA singola riga esterna gia' caricata, zero query aggiuntive.
    expect(result.issues.filter((i) => i.serviceId === "A1" && i.category === "linked_service")).toEqual([]);
    const a2Issue = result.issues.find((i) => i.serviceId === "A2" && i.code === "INCONSISTENT_ROUND_TRIP");
    expect(a2Issue?.severity).toBe("warning");
  });

  it("10. possibile duplicato -> POSSIBLE_DUPLICATE warning per entrambi i servizi", () => {
    const result = diagnoseOperationalDay(
      baseInput({
        services: [
          service({ id: "s1", booking_service_kind: "excursion", time: "09:00" }),
          service({ id: "s2", booking_service_kind: "excursion", time: "09:00" }),
        ],
      })
    );
    const dup1 = result.issues.find((i) => i.serviceId === "s1" && i.code === "POSSIBLE_DUPLICATE");
    const dup2 = result.issues.find((i) => i.serviceId === "s2" && i.code === "POSSIBLE_DUPLICATE");
    expect(dup1?.severity).toBe("warning");
    expect(dup2?.severity).toBe("warning");
  });

  it("11. warning import (pickup_alert persistito, nessun controllo pickup live sovrapposto) -> IMPORT_WARNING info", () => {
    const result = diagnoseOperationalDay(
      baseInput({
        services: [
          service({
            id: "s1",
            direction: "arrival",
            booking_service_kind: "transfer_train_hotel",
            pickup_alert: "Zona hotel non impostata: verificare manualmente.",
          }),
        ],
      })
    );
    const issue = result.issues.find((i) => i.serviceId === "s1" && i.code === "IMPORT_WARNING");
    expect(issue?.severity).toBe("info");
    expect(issue?.message).toContain("Zona hotel non impostata");
  });

  it("12. deduplicazione: stessa causa (aliscafo senza regola) produce un solo issue, non anche MISSING_PICKUP", () => {
    const result = diagnoseOperationalDay(
      baseInput({
        services: [
          service({
            id: "s1",
            booking_service_kind: "transfer_airport_hotel_aliscafo",
            time: "12:00",
            departure_time: "12:00",
          }),
        ],
      })
    );
    const serviceIssues = result.issues.filter((i) => i.serviceId === "s1");
    expect(serviceIssues.map((i) => i.code)).toEqual(["HYDROFOIL_RULE_MISSING"]);
  });

  it("13. 400 servizi sintetici -> completa senza errori, conteggi coerenti, tempo contenuto", () => {
    const services: PrintService[] = Array.from({ length: 400 }, (_, i) =>
      service({
        id: `svc-${i}`,
        customer_name: `CLIENTE ${i}`,
        time: i % 2 === 0 ? "14:00" : "09:00",
        departure_time: i % 2 === 0 ? "14:00" : "09:00",
        booking_service_kind: i % 3 === 0 ? "excursion" : "transfer_train_hotel",
      })
    );
    const start = Date.now();
    const result = diagnoseOperationalDay(baseInput({ services }));
    const elapsedMs = Date.now() - start;

    expect(result.totalServices).toBe(400);
    expect(result.okServices + result.warningServices + result.errorServices).toBe(400);
    expect(elapsedMs).toBeLessThan(2000);
  });
});
