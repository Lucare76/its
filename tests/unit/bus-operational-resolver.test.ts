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
});
