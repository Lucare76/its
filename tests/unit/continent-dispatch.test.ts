import { describe, expect, it } from "vitest";
import {
  buildContinentDispatchBuckets,
  isBrunoTarget,
  isContinentDispatchCandidate,
  mapContinentDispatchRow,
  resolvePlaceType,
  resolveSuggestedTarget,
  toBrunoArrival,
  toBrunoDeparture,
  type ContinentDispatchService,
} from "@/lib/server/continent-dispatch";

type ContinentDispatchRowInput = Parameters<typeof mapContinentDispatchRow>[0];

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

function makeRow(overrides: Partial<ContinentDispatchRowInput>): ContinentDispatchRowInput {
  return {
    id: "svc-row-1",
    customer_name: "Mario Rossi",
    pax: 2,
    time: "10:30",
    direction: "arrival",
    departure_time: null,
    vessel: "Alilauro 08:30 Napoli",
    place_type: "airport",
    meeting_point: "Aeroporto Napoli",
    phone: "3331234567",
    notes: "",
    porto_bruno: null,
    service_type_code: "transfer_airport_hotel",
    booking_service_kind: "transfer_airport_hotel",
    origin_place_type: null,
    destination_place_type: null,
    origin_label_raw: null,
    destination_label_raw: null,
    train_arrival_number: null,
    train_departure_number: null,
    continent_dispatch_target: null,
    continent_dispatch_source: null,
    continent_dispatch_vendor: null,
    continent_dispatch_override_reason: null,
    hotels: { name: "Hotel Test", zone: "ischia" },
    ...overrides,
  };
}

describe("continent dispatch Bruno rules", () => {
  it("manda a Bruno gli arrivi aeroporto standard", () => {
    const service = mapContinentDispatchRow(makeRow({
      place_type: null,
      origin_place_type: "airport",
      origin_label_raw: "Aeroporto Napoli Capodichino",
      meeting_point: "Aeroporto Napoli Capodichino",
    }));

    expect(service.place_type).toBe("airport");
    expect(service.suggested_target).toBe("bruno");
    expect(service.effective_target).toBe("bruno");
  });

  it("manda a Bruno gli arrivi stazione con aliscafo", () => {
    const service = mapContinentDispatchRow(makeRow({
      place_type: null,
      origin_place_type: "station",
      origin_label_raw: "Stazione Napoli Centrale",
      meeting_point: "Stazione Napoli Centrale",
      vessel: "Treno + aliscafo",
      booking_service_kind: "transfer_train_hotel_aliscafo",
      service_type_code: "transfer_station_hotel",
    }));

    expect(service.place_type).toBe("station");
    expect(service.suggested_target).toBe("bruno");
    expect(service.effective_target).toBe("bruno");
  });

  it("manda a Bruno le partenze stazione con aliscafo", () => {
    expect(
      resolveSuggestedTarget(
        { direction: "departure", booking_service_kind: "transfer_train_hotel_aliscafo", service_type_code: "transfer_train_hotel_aliscafo" },
        "station",
        "napoli"
      )
    ).toBe("bruno");
  });

  it("manda a Bruno gli arrivi aeroporto con aliscafo", () => {
    expect(
      resolveSuggestedTarget(
        { direction: "arrival", booking_service_kind: "transfer_airport_hotel_aliscafo", service_type_code: "transfer_airport_hotel_aliscafo" },
        "airport",
        "napoli"
      )
    ).toBe("bruno");
  });

  it("manda a Bruno le partenze aeroporto con aliscafo", () => {
    expect(
      resolveSuggestedTarget(
        { direction: "departure", booking_service_kind: "transfer_airport_hotel_aliscafo", service_type_code: "transfer_airport_hotel_aliscafo" },
        "airport",
        "napoli"
      )
    ).toBe("bruno");
  });

  it("non manda automaticamente a Bruno la stazione standard senza aliscafo", () => {
    const service = mapContinentDispatchRow(makeRow({
      place_type: null,
      origin_place_type: "station",
      origin_label_raw: "Stazione Napoli Centrale",
      meeting_point: "Stazione Napoli Centrale",
      vessel: "Treno/Bus",
      booking_service_kind: "transfer_train_hotel",
      service_type_code: "transfer_station_hotel",
    }));

    expect(service.place_type).toBe("station");
    expect(service.suggested_target).toBe("continent_dispatch");
    expect(service.effective_target).toBe("continent_dispatch");
  });

  it("non manda a Bruno una stazione reale anche se il kind legacy dice aeroporto", () => {
    const service = mapContinentDispatchRow(makeRow({
      id: "demo-cliente-007",
      customer_name: "DEMO_CLIENTE_007",
      place_type: "airport",
      origin_place_type: null,
      origin_label_raw: "Stazione Napoli Centrale",
      meeting_point: "Stazione Napoli Centrale",
      vessel: "Treno/Bus",
      booking_service_kind: "transfer_airport_hotel",
      service_type_code: "transfer_airport_hotel",
    }));
    const buckets = buildContinentDispatchBuckets([service]);

    expect(service.place_type).toBe("station");
    expect(service.suggested_target).toBe("continent_dispatch");
    expect(service.effective_target).toBe("continent_dispatch");
    expect(buckets.bruno.services).toHaveLength(0);
    expect(buckets.unassigned.services).toHaveLength(1);
    expect(buckets.unassigned.services[0]).toMatchObject({
      service_id: "demo-cliente-007",
      place_type: "station",
      meeting_point: "Stazione Napoli Centrale",
    });
  });

  it("non manda automaticamente a Bruno transfer_train_hotel_exclusive", () => {
    expect(
      resolveSuggestedTarget(
        { direction: "arrival", booking_service_kind: "transfer_train_hotel_exclusive", service_type_code: "transfer_train_hotel_exclusive" },
        "station",
        "napoli"
      )
    ).toBe("continent_dispatch");
  });

  it("non manda automaticamente a Bruno transfer_airport_hotel_exclusive in partenza", () => {
    expect(
      resolveSuggestedTarget(
        { direction: "departure", booking_service_kind: "transfer_airport_hotel_exclusive", service_type_code: "transfer_airport_hotel_exclusive" },
        "airport",
        "napoli"
      )
    ).toBe("continent_dispatch");
  });

  it("esclude formula_snav dal continente anche se il place_type sembra continente", () => {
    expect(isContinentDispatchCandidate({ booking_service_kind: "formula_snav", service_type_code: null })).toBe(false);
    expect(isContinentDispatchCandidate({ booking_service_kind: "formula_snav", service_type_code: "transfer_airport_hotel" })).toBe(false);
  });

  it("esclude formula_medmar_napoli dal continente anche se il place_type sembra continente", () => {
    expect(isContinentDispatchCandidate({ booking_service_kind: "formula_medmar_napoli", service_type_code: null })).toBe(false);
    expect(isContinentDispatchCandidate({ booking_service_kind: "formula_medmar_napoli", service_type_code: "transfer_train_hotel" })).toBe(false);
  });

  it("esclude formula_medmar_pozzuoli dal continente anche se il place_type sembra continente", () => {
    expect(isContinentDispatchCandidate({ booking_service_kind: "formula_medmar_pozzuoli", service_type_code: null })).toBe(false);
    expect(isContinentDispatchCandidate({ booking_service_kind: "formula_medmar_pozzuoli", service_type_code: "transfer_train_hotel" })).toBe(false);
  });

  it("rispetta l'override manuale continente e conserva il vendor libero", () => {
    const service = mapContinentDispatchRow(makeRow({
      continent_dispatch_target: "continent_dispatch",
      continent_dispatch_source: "manual",
      continent_dispatch_vendor: "Ditta Rossi Transfer",
    }));

    expect(service.suggested_target).toBe("bruno");
    expect(service.effective_target).toBe("continent_dispatch");
    expect(service.target_source).toBe("manual");
    expect(service.vendor_name).toBe("Ditta Rossi Transfer");
  });

  it("ammette piu servizi Bruno allo stesso orario senza conflitto rigido", () => {
    const first = mapContinentDispatchRow(makeRow({ id: "svc-a", time: "10:30" }));
    const second = mapContinentDispatchRow(makeRow({ id: "svc-b", time: "10:30", pax: 8 }));

    expect(first.effective_target).toBe("bruno");
    expect(second.effective_target).toBe("bruno");
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

  it("fa prevalere il testo reale stazione sul kind legacy airport", () => {
    expect(resolvePlaceType({
      direction: "arrival",
      place_type: "airport",
      service_type_code: "transfer_airport_hotel",
      booking_service_kind: "transfer_airport_hotel",
      origin_label_raw: "Stazione Napoli Centrale",
      meeting_point: "Stazione Napoli Centrale",
      vessel: "Treno/Bus",
    })).toBe("station");
  });

  it("fallback a station per i transfer treno e qualsiasi altro tipo", () => {
    expect(resolvePlaceType({ place_type: null, service_type_code: null, booking_service_kind: "transfer_train_hotel" })).toBe("station");
    expect(resolvePlaceType({ place_type: null, service_type_code: null, booking_service_kind: "transfer_train_hotel_exclusive" })).toBe("station");
    expect(resolvePlaceType({ place_type: null, service_type_code: "transfer_port_hotel", booking_service_kind: null })).toBe("station");
    expect(resolvePlaceType({ place_type: null, service_type_code: null, booking_service_kind: null })).toBe("station");
  });
});

describe("buildContinentDispatchBuckets", () => {
  it("mette due servizi Bruno allo stesso orario nel bucket Bruno senza conflitto", () => {
    const buckets = buildContinentDispatchBuckets([
      makeService({ id: "bruno-1", customer_name: "Anna Bianchi", time: "10:30" }),
      makeService({ id: "bruno-2", customer_name: "Mario Rossi", time: "10:30", pax: 7 }),
    ], { date: "2026-05-13" });

    expect(buckets.bruno.services.map((service) => service.service_id)).toEqual(["bruno-1", "bruno-2"]);
    expect(buckets.bruno.services.every((service) => service.effective_target === "bruno")).toBe(true);
  });

  it("raggruppa un servizio manuale nel bucket vendor Ditta Rossi Transfer", () => {
    const buckets = buildContinentDispatchBuckets([
      makeService({
        id: "vendor-1",
        effective_target: "continent_dispatch",
        target_source: "manual",
        vendor_name: "Ditta Rossi Transfer",
      }),
    ]);

    expect(buckets.vendors).toHaveLength(1);
    expect(buckets.vendors[0].label).toBe("Ditta Rossi Transfer");
    expect(buckets.vendors[0].services.map((service) => service.service_id)).toEqual(["vendor-1"]);
  });

  it("mette due servizi dello stesso vendor nello stesso bucket", () => {
    const buckets = buildContinentDispatchBuckets([
      makeService({
        id: "vendor-1",
        effective_target: "continent_dispatch",
        target_source: "manual",
        vendor_name: "NCC Napoli",
      }),
      makeService({
        id: "vendor-2",
        effective_target: "continent_dispatch",
        target_source: "manual",
        vendor_name: "NCC Napoli",
      }),
    ]);

    expect(buckets.vendors).toHaveLength(1);
    expect(buckets.vendors[0].vendor).toBe("NCC Napoli");
    expect(buckets.vendors[0].services.map((service) => service.service_id)).toEqual(["vendor-1", "vendor-2"]);
  });

  it("separa vendor manuali diversi in bucket diversi", () => {
    const buckets = buildContinentDispatchBuckets([
      makeService({
        id: "rossi-1",
        effective_target: "continent_dispatch",
        target_source: "manual",
        vendor_name: "Ditta Rossi Transfer",
      }),
      makeService({
        id: "ncc-1",
        effective_target: "continent_dispatch",
        target_source: "manual",
        vendor_name: "NCC Napoli",
      }),
    ]);

    expect(buckets.vendors.map((bucket) => bucket.vendor)).toEqual(["Ditta Rossi Transfer", "NCC Napoli"]);
  });

  it("manda continent_dispatch senza vendor nel bucket Da smistare", () => {
    const buckets = buildContinentDispatchBuckets([
      makeService({
        id: "todo-1",
        effective_target: "continent_dispatch",
        target_source: "rule",
        vendor_name: null,
      }),
      makeService({
        id: "todo-2",
        effective_target: "continent_dispatch",
        target_source: "manual",
        vendor_name: "   ",
      }),
    ]);

    expect(buckets.unassigned.label).toBe("Da smistare");
    expect(buckets.unassigned.services.map((service) => service.service_id)).toEqual(["todo-1", "todo-2"]);
  });

  it("manda al vendor manuale un servizio che da regola sarebbe Bruno", () => {
    const buckets = buildContinentDispatchBuckets([
      makeService({
        id: "manual-bruno-rule",
        suggested_target: "bruno",
        effective_target: "continent_dispatch",
        target_source: "manual",
        vendor_name: "NCC Napoli",
      }),
    ]);

    expect(buckets.bruno.services).toHaveLength(0);
    expect(buckets.vendors[0].vendor).toBe("NCC Napoli");
    expect(buckets.vendors[0].services[0].service_id).toBe("manual-bruno-rule");
  });

  it("esclude SNAV e Medmar dai bucket continente", () => {
    const buckets = buildContinentDispatchBuckets([
      makeService({ id: "snav", booking_service_kind: "formula_snav", service_type_code: null }),
      makeService({ id: "medmar-napoli", booking_service_kind: "formula_medmar_napoli", service_type_code: null }),
      makeService({ id: "medmar-pozzuoli", booking_service_kind: "formula_medmar_pozzuoli", service_type_code: null }),
    ]);

    expect(buckets.bruno.services).toHaveLength(0);
    expect(buckets.vendors).toHaveLength(0);
    expect(buckets.unassigned.services).toHaveLength(0);
  });

  it("ordina i servizi in modo stabile per data, orario, cliente e hotel", () => {
    const buckets = buildContinentDispatchBuckets([
      makeService({ id: "late", time: "11:00", customer_name: "Carlo Verdi", hotel_name: "Hotel B" }),
      makeService({ id: "anna", time: "09:00", customer_name: "Anna Bianchi", hotel_name: "Hotel C" }),
      makeService({ id: "mario-a", time: "09:00", customer_name: "Mario Rossi", hotel_name: "Hotel A" }),
      makeService({ id: "mario-b", time: "09:00", customer_name: "Mario Rossi", hotel_name: "Hotel B" }),
    ], { date: "2026-05-13" });

    expect(buckets.bruno.services.map((service) => service.service_id)).toEqual(["anna", "mario-a", "mario-b", "late"]);
    expect(buckets.bruno.services[0]).toMatchObject({
      date: "2026-05-13",
      phone_display: "3331234567",
      continent_dispatch_vendor: null,
      warnings: [],
    });
  });
});
