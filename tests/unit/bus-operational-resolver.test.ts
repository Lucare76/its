import { describe, expect, it } from "vitest";
import {
  cleanOperationalClock,
  resolveBusOperationalService,
  type BusOperationalResolverContext,
  type BusOperationalServiceInput,
} from "@/lib/server/bus-operational-resolver";

function baseContext(overrides: Partial<BusOperationalResolverContext> = {}): BusOperationalResolverContext {
  return {
    allocationsByServiceId: new Map(),
    lineById: new Map([
      ["line-italia", { id: "line-italia", family_code: "ITALIA", name: "Linea Italia" }],
      ["line-centro", { id: "line-centro", family_code: "CENTRO", name: "Linea Centro" }],
    ]),
    stops: [],
    hotelNameById: new Map([["hotel-augusto", "GRAND HOTEL TERME DI AUGUSTO"]]),
    hotelPickupTimes: [
      {
        hotel_name: "GRAND HOTEL TERME DI AUGUSTO",
        pickup_time_linea_italia: "05:15",
        pickup_time_linea_centro: "06:10",
        pickup_time_linea_adriatica: "04:50",
      },
    ],
    ...overrides,
  };
}

function busService(overrides: Partial<BusOperationalServiceInput> = {}): BusOperationalServiceInput {
  return {
    id: "service-1",
    direction: "departure",
    date: "2026-08-23",
    time: "00:00:00",
    departure_time: "00:00:00",
    booking_service_kind: "bus_city_hotel",
    service_type_code: "bus_line",
    bus_city_origin: "MODENA",
    hotel_id: "hotel-augusto",
    transport_code: "Linea Italia",
    vessel: "Linea bus",
    pax: 2,
    ...overrides,
  } as BusOperationalServiceInput;
}

describe("bus operational resolver", () => {
  it("ignora 00:00 come orario operativo valido", () => {
    expect(cleanOperationalClock("00:00:00")).toBeNull();
    expect(cleanOperationalClock("05:15:00")).toBe("05:15");
  });

  it("risolve MODENA tramite fermata, linea e pickup hotel anche con departure_time 00:00", () => {
    const resolution = resolveBusOperationalService(
      busService(),
      baseContext({
        stops: [
          {
            id: "stop-modena",
            bus_line_id: "line-italia",
            direction: "departure",
            stop_name: "MODENA",
            city: "MODENA",
            pickup_note: "Casello autostradale nord",
            pickup_time: "05:15",
          },
        ],
      })
    );

    expect(resolution.resolutionSource).toBe("bus_city_origin");
    expect(resolution.lineName).toBe("Linea Italia");
    expect(resolution.stopName).toBe("MODENA");
    expect(resolution.stopPickupNote).toBe("Casello autostradale nord");
    expect(resolution.destinationLabel).toBe("MODENA");
    expect(resolution.hotelPickupTime).toBe("05:15");
  });

  it("dà priorità all'allocazione Rete Bus esistente rispetto al fallback città", () => {
    const context = baseContext({
      allocationsByServiceId: new Map([
        [
          "service-1",
          [
            {
              service_id: "service-1",
              direction: "departure",
              family_code: "CENTRO",
              line_name: "Linea Centro",
              stop_name: "ORTE",
              stop_city: "ORTE",
              stop_pickup_note: "Hotel Tevere",
              stop_pickup_time: "13:30",
              hotel_pickup_time: "06:10",
            },
          ],
        ],
      ]),
      stops: [
        {
          id: "stop-modena",
          bus_line_id: "line-italia",
          direction: "departure",
          stop_name: "MODENA",
          city: "MODENA",
          pickup_note: "Casello autostradale nord",
          pickup_time: "05:15",
        },
      ],
    });

    const resolution = resolveBusOperationalService(busService(), context);

    expect(resolution.resolutionSource).toBe("allocation");
    expect(resolution.lineName).toBe("Linea Centro");
    expect(resolution.stopName).toBe("ORTE");
    expect(resolution.hotelPickupTime).toBe("06:10");
  });

  it("usa i campi servizio solo quando non riesce a risolvere linea e fermata", () => {
    const resolution = resolveBusOperationalService(
      busService({
        bus_city_origin: "CITTA NON CENSITA",
        meeting_point: "Meeting point linea bus",
        pickup_time: "07:20",
      }),
      baseContext()
    );

    expect(resolution.resolutionSource).toBe("service_fields");
    expect(resolution.destinationLabel).toBe("CITTA NON CENSITA");
    expect(resolution.hotelPickupTime).toBe("07:20");
  });

  describe("Obiettivo A: bus_exclusive vince sempre sulla città (mai Linea Adriatica per geografia)", () => {
    const ADRIATICA_STOP = {
      id: "stop-marotta-adriatica",
      bus_line_id: "line-adriatica",
      direction: "departure" as const,
      stop_name: "MAROTTA",
      city: "MAROTTA",
      pickup_note: null,
      pickup_time: "08:00",
    };

    it("service di gruppo bus_exclusive con fermata MAROTTA (reale su Linea Adriatica) NON diventa Linea Adriatica", () => {
      const resolution = resolveBusOperationalService(
        busService({ id: "svc-marotta", bus_city_origin: "MAROTTA", booking_group_id: "bg-giacomoni", transport_code: null, vessel: null }),
        baseContext({
          lineById: new Map([["line-adriatica", { id: "line-adriatica", family_code: "ADRIATICA", name: "Linea Adriatica" }]]),
          stops: [ADRIATICA_STOP],
          bookingGroupKindById: new Map([["bg-giacomoni", "bus_exclusive"]]),
        }),
      );
      expect(resolution.familyCode).toBe("GRUPPI_ESCLUSIVI");
      expect(resolution.lineName).not.toBe("Linea Adriatica");
      expect(resolution.familyCode).not.toBe("ADRIATICA");
    });

    it("service di gruppo bus_exclusive con fermata PESARO -> resta Bus esclusivi gruppi", () => {
      const resolution = resolveBusOperationalService(
        busService({ id: "svc-pesaro", direction: "arrival", bus_city_origin: "PESARO", booking_group_id: "bg-giacomoni", transport_code: null, vessel: null }),
        baseContext({
          lineById: new Map([
            ["line-adriatica", { id: "line-adriatica", family_code: "ADRIATICA", name: "Linea Adriatica" }],
            ["line-esclusivi", { id: "line-esclusivi", family_code: "GRUPPI_ESCLUSIVI", name: "Bus esclusivi gruppi" }],
          ]),
          stops: [{ ...ADRIATICA_STOP, id: "stop-pesaro", stop_name: "PESARO", city: "PESARO", direction: "arrival" }],
          bookingGroupKindById: new Map([["bg-giacomoni", "bus_exclusive"]]),
        }),
      );
      expect(resolution.familyCode).toBe("GRUPPI_ESCLUSIVI");
      expect(resolution.lineName).toBe("Bus esclusivi gruppi");
      expect(resolution.destinationLabel).toBe("PESARO");
    });

    it("ritorno (departure) generato da ritorno invertito resta Bus esclusivi gruppi, non Linea Adriatica", () => {
      const resolution = resolveBusOperationalService(
        busService({ id: "svc-ret-fano", direction: "departure", bus_city_origin: "FANO", booking_group_id: "bg-giacomoni", transport_code: null, vessel: null }),
        baseContext({
          lineById: new Map([["line-adriatica", { id: "line-adriatica", family_code: "ADRIATICA", name: "Linea Adriatica" }]]),
          stops: [{ ...ADRIATICA_STOP, id: "stop-fano", stop_name: "FANO", city: "FANO" }],
          bookingGroupKindById: new Map([["bg-giacomoni", "bus_exclusive"]]),
        }),
      );
      expect(resolution.familyCode).toBe("GRUPPI_ESCLUSIVI");
    });

    it("prenotazione individuale (booking_group_id null) con fermata PESARO resta Linea Adriatica (nessuna regressione)", () => {
      const resolution = resolveBusOperationalService(
        busService({ id: "svc-individuale", bus_city_origin: "PESARO", booking_group_id: null, transport_code: null, vessel: null }),
        baseContext({
          lineById: new Map([["line-adriatica", { id: "line-adriatica", family_code: "ADRIATICA", name: "Linea Adriatica" }]]),
          stops: [{ ...ADRIATICA_STOP, id: "stop-pesaro", stop_name: "PESARO", city: "PESARO" }],
          bookingGroupKindById: new Map(),
        }),
      );
      expect(resolution.lineName).toBe("Linea Adriatica");
      expect(resolution.familyCode).toBe("ADRIATICA");
    });

    it("gruppo non bus_exclusive con fermata su Linea Adriatica -> comportamento geografico invariato", () => {
      const resolution = resolveBusOperationalService(
        busService({ id: "svc-gruppo-normale", bus_city_origin: "MAROTTA", booking_group_id: "bg-altro", transport_code: null, vessel: null }),
        baseContext({
          lineById: new Map([["line-adriatica", { id: "line-adriatica", family_code: "ADRIATICA", name: "Linea Adriatica" }]]),
          stops: [ADRIATICA_STOP],
          bookingGroupKindById: new Map([["bg-altro", "bus_group"]]),
        }),
      );
      expect(resolution.familyCode).toBe("ADRIATICA");
    });

    it("bus_exclusive CON allocazione reale -> l'allocazione resta autorevole (mai sovrascritta dal gate)", () => {
      const resolution = resolveBusOperationalService(
        busService({ id: "svc-allocated", bus_city_origin: "MAROTTA", booking_group_id: "bg-giacomoni", transport_code: null, vessel: null }),
        baseContext({
          allocationsByServiceId: new Map([
            ["svc-allocated", [{ service_id: "svc-allocated", direction: "departure", family_code: "GRUPPI_ESCLUSIVI", line_name: "Bus esclusivi gruppi", stop_name: "MAROTTA", stop_city: "MAROTTA", stop_pickup_note: null, stop_pickup_time: "08:00", hotel_pickup_time: null }],
          ]]),
          bookingGroupKindById: new Map([["bg-giacomoni", "bus_exclusive"]]),
        }),
      );
      expect(resolution.resolutionSource).toBe("allocation");
      expect(resolution.familyCode).toBe("GRUPPI_ESCLUSIVI");
    });
  });
});
