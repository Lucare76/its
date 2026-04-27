import { describe, expect, it } from "vitest";
import { isBrunoTarget, resolvePlaceType, resolveSuggestedTarget, toBrunoArrival, toBrunoDeparture, type ContinentDispatchService } from "@/lib/server/continent-dispatch";

function makeService(overrides: Partial<ContinentDispatchService>): ContinentDispatchService {
  return {
    id: "svc-1",
    direction: "arrival",
    customer_name: "Mario Rossi",
    pax: 2,
    time: "10:30",
    vessel: "SNAV 08:30 Napoli",
    boat_t: null,
    place_type: "airport",
    meeting_point: "Napoli Beverello",
    phone: "3331234567",
    notes: "",
    hotel_name: "Hotel Test",
    hotel_zone: "ischia",
    booking_service_kind: "transfer_airport_hotel",
    service_type_code: "transfer_airport_hotel",
    connection_time: null,
    arrival_at_porto: null,
    arrival_at_ischia: "09:35",
    porto_bruno: null,
    continent_hub: "napoli",
    train_arrival_number: "FR1234",
    train_departure_number: "FR4321",
    suggested_target: "bruno",
    effective_target: "bruno",
    target_source: "rule",
    vendor_name: null,
    override_reason: null,
    ...overrides,
  };
}

describe("continent dispatch Bruno rules", () => {
  it("manda a Bruno gli arrivi aeroporto", () => {
    expect(
      resolveSuggestedTarget(
        { direction: "arrival", booking_service_kind: "transfer_airport_hotel", service_type_code: "transfer_airport_hotel" },
        "airport",
        "napoli"
      )
    ).toBe("bruno");
  });

  it("non manda automaticamente a Bruno gli arrivi stazione", () => {
    expect(
      resolveSuggestedTarget(
        { direction: "arrival", booking_service_kind: "transfer_train_hotel", service_type_code: "transfer_train_hotel" },
        "station",
        "napoli"
      )
    ).toBe("continent_dispatch");
  });

  it("include gli arrivi stazione con aliscafo o esclusivo", () => {
    expect(
      resolveSuggestedTarget(
        { direction: "arrival", booking_service_kind: "transfer_train_hotel_aliscafo", service_type_code: "transfer_train_hotel_aliscafo" },
        "station",
        "napoli"
      )
    ).toBe("bruno");

    expect(
      resolveSuggestedTarget(
        { direction: "arrival", booking_service_kind: "transfer_train_hotel_exclusive", service_type_code: "transfer_train_hotel_exclusive" },
        "station",
        "napoli"
      )
    ).toBe("bruno");
  });

  it("include le partenze private aeroporto e stazione", () => {
    expect(
      resolveSuggestedTarget(
        { direction: "departure", booking_service_kind: "transfer_airport_hotel_exclusive", service_type_code: "transfer_airport_hotel_exclusive" },
        "airport",
        "napoli"
      )
    ).toBe("bruno");

    expect(
      resolveSuggestedTarget(
        { direction: "departure", booking_service_kind: "transfer_train_hotel_exclusive", service_type_code: "transfer_train_hotel_exclusive" },
        "station",
        "pozzuoli"
      )
    ).toBe("bruno");
  });

  it("include le partenze con aliscafo aeroporto e stazione", () => {
    expect(
      resolveSuggestedTarget(
        { direction: "departure", booking_service_kind: "transfer_airport_hotel_aliscafo", service_type_code: "transfer_airport_hotel_aliscafo" },
        "airport",
        "napoli"
      )
    ).toBe("bruno");

    expect(
      resolveSuggestedTarget(
        { direction: "departure", booking_service_kind: "transfer_train_hotel_aliscafo", service_type_code: "transfer_train_hotel_aliscafo" },
        "station",
        "pozzuoli"
      )
    ).toBe("bruno");
  });

  it("esclude le partenze standard", () => {
    expect(
      resolveSuggestedTarget(
        { direction: "departure", booking_service_kind: "transfer_train_hotel", service_type_code: "transfer_train_hotel" },
        "station",
        "pozzuoli"
      )
    ).toBe("continent_dispatch");
  });

  it("esclude le partenze aeroporto standard", () => {
    expect(
      resolveSuggestedTarget(
        { direction: "departure", booking_service_kind: "transfer_airport_hotel", service_type_code: "transfer_airport_hotel" },
        "airport",
        "napoli"
      )
    ).toBe("continent_dispatch");
  });

  it("espone un mapping coerente per tutti gli output Bruno", () => {
    const arrival = toBrunoArrival(makeService({}));
    const departure = toBrunoDeparture(
      makeService({
        direction: "departure",
        time: "16:20",
        boat_t: "14:20",
        arrival_at_porto: "15:50",
        porto_bruno: "Napoli Beverello",
      })
    );

    expect(isBrunoTarget({ effective_target: "bruno" })).toBe(true);
    expect(arrival.flight_number).toBe("FR1234");
    expect(departure.flight_number).toBe("FR4321");
    expect(departure.arrival_at_porto).toBe("15:50");
    expect(departure.porto_bruno).toBe("Napoli Beverello");
  });
});

describe("resolvePlaceType", () => {
  it("restituisce il place_type esplicito se già airport o station", () => {
    expect(resolvePlaceType({ place_type: "airport", service_type_code: null, booking_service_kind: null })).toBe("airport");
    expect(resolvePlaceType({ place_type: "station", service_type_code: null, booking_service_kind: null })).toBe("station");
  });

  it("deduce airport da booking_service_kind transfer_airport_*", () => {
    expect(resolvePlaceType({ place_type: null, service_type_code: null, booking_service_kind: "transfer_airport_hotel" })).toBe("airport");
    expect(resolvePlaceType({ place_type: null, service_type_code: null, booking_service_kind: "transfer_airport_hotel_exclusive" })).toBe("airport");
    expect(resolvePlaceType({ place_type: null, service_type_code: null, booking_service_kind: "transfer_airport_hotel_aliscafo" })).toBe("airport");
  });

  it("deduce airport da service_type_code transfer_airport_hotel", () => {
    expect(resolvePlaceType({ place_type: null, service_type_code: "transfer_airport_hotel", booking_service_kind: null })).toBe("airport");
  });

  it("fallback a station per i transfer treno e qualsiasi altro tipo", () => {
    expect(resolvePlaceType({ place_type: null, service_type_code: null, booking_service_kind: "transfer_train_hotel" })).toBe("station");
    expect(resolvePlaceType({ place_type: null, service_type_code: null, booking_service_kind: "transfer_train_hotel_exclusive" })).toBe("station");
    expect(resolvePlaceType({ place_type: null, service_type_code: "transfer_port_hotel", booking_service_kind: null })).toBe("station");
    expect(resolvePlaceType({ place_type: null, service_type_code: null, booking_service_kind: null })).toBe("station");
  });
});
