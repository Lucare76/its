import { describe, expect, it } from "vitest";
import {
  resolveAssignableService,
  type AssignableService,
} from "@/lib/piano-assignable-service";

function service(overrides: Partial<AssignableService>): AssignableService {
  return {
    id: "svc-1",
    time: "09:30",
    direction: "departure",
    customer_name: "TEST CLIENT",
    pax: 2,
    service_type: "transfer",
    ...overrides,
  };
}

describe("resolveAssignableService", () => {
  it("marks GPR PETER excursion without Mortella destination as needs_review", () => {
    const result = resolveAssignableService(service({
      customer_name: "GPR PETER",
      pax: 21,
      booking_service_kind: "excursion",
      service_type_code: "excursion",
      service_type: "bus_tour",
      excursion_details: { from: "PARCO AURORA" },
    }));

    expect(result.macro_category).toBe("ESCURSIONE");
    expect(result.assignable).toBe(false);
    expect(result.needs_review).toBe(true);
    expect(result.review_reasons).toContain("Destinazione escursione mancante");
  });

  it("accepts CAM 320 excursion Felix to Nitrodi", () => {
    const result = resolveAssignableService(service({
      customer_name: "CAM 320",
      booking_service_kind: "excursion",
      service_type_code: "excursion",
      service_type: "bus_tour",
      excursion_details: { from: "FELIX", to: "NITRODI" },
    }));

    expect(result.macro_category).toBe("ESCURSIONE");
    expect(result.assignable).toBe(true);
    expect(result.pickup_label).toBe("FELIX");
    expect(result.destination_label).toBe("NITRODI");
  });

  it("accepts CAM 320 excursion return Nitrodi to Felix", () => {
    const result = resolveAssignableService(service({
      customer_name: "CAM 320",
      direction: "arrival",
      booking_service_kind: "excursion",
      service_type_code: "excursion",
      service_type: "bus_tour",
      excursion_details: { from: "NITRODI", to: "FELIX" },
    }));

    expect(result.macro_category).toBe("ESCURSIONE");
    expect(result.assignable).toBe(true);
    expect(result.pickup_label).toBe("NITRODI");
    expect(result.destination_label).toBe("FELIX");
  });

  it("does not treat La Villa as a real port for Medmar departure", () => {
    const result = resolveAssignableService(
      service({
        customer_name: "Cazzanti Ivano",
        booking_service_kind: "formula_medmar_pozzuoli",
        service_type_code: "ferry_transfer",
        pickup_hotel: "07:00",
        meeting_point: "LA VILLA",
        barca_compagnia: "Medmar",
        orario_barca: "08:40",
      }),
      { hotel: { name: "LA VILLA", zone: "Forio" } }
    );

    expect(result.macro_category).toBe("PARTENZA");
    expect(result.assignable).toBe(false);
    expect(result.needs_review).toBe(true);
    expect(result.review_reasons).toContain("Porto imbarco non determinato");
    expect(result.port_departure).toBeNull();
    expect(result.destination_label).toBe("Porto da verificare");
  });

  it("does not treat Re Ferdinando as a real port for SNAV departure", () => {
    const result = resolveAssignableService(
      service({
        customer_name: "SNAV CLIENT",
        booking_service_kind: "formula_snav",
        service_type_code: "ferry_transfer",
        pickup_hotel: "06:30",
        meeting_point: "RE FERDINANDO",
        barca_compagnia: "SNAV",
        orario_barca: "07:10",
      }),
      { hotel: { name: "RE FERDINANDO", zone: "Ischia Porto" } }
    );

    expect(result.macro_category).toBe("PARTENZA");
    expect(result.needs_review).toBe(true);
    expect(result.review_reasons).toContain("Porto imbarco non determinato");
    expect(result.port_departure).toBeNull();
  });

  it("blocks airport arrival with only flight data", () => {
    const result = resolveAssignableService(
      service({
        direction: "arrival",
        customer_name: "FEST ROMON CELINE",
        booking_service_kind: "transfer_airport_hotel",
        service_type_code: "transfer_airport_hotel",
        place_type: "airport",
        meeting_point: "AEROPORTO",
        transport_code: "LX1712",
        arrival_time: "08:40",
      }),
      { hotel: { name: "RESORT PUNTO AZZURRO", zone: "Forio" } }
    );

    expect(result.macro_category).toBe("ARRIVO");
    expect(result.assignable).toBe(false);
    expect(result.review_reasons).toContain("Arrivo isola non determinato");
  });

  it("accepts airport arrival when ferry island arrival and port are available", () => {
    const result = resolveAssignableService(
      service({
        direction: "arrival",
        customer_name: "FEST ROMON CELINE",
        booking_service_kind: "transfer_airport_hotel",
        service_type_code: "transfer_airport_hotel",
        place_type: "airport",
        meeting_point: "AEROPORTO",
        transport_code: "LX1712",
        barca_compagnia: "Medmar",
        orario_barca: "08:40",
        ferry_details: {
          arrival_at_ischia: "10:10",
          arrival_port: "ischia_porto",
        },
      }),
      { hotel: { name: "RESORT PUNTO AZZURRO", zone: "Forio" } }
    );

    expect(result.macro_category).toBe("ARRIVO");
    expect(result.assignable).toBe(true);
    expect(result.operational_time).toBe("10:10");
    expect(result.pickup_label).toBe("Ischia Porto");
    expect(result.destination_label).toBe("RESORT PUNTO AZZURRO");
  });

  it("uses island ferry arrival as operational_time for FEST ROMON CELINE", () => {
    const result = resolveAssignableService(
      service({
        direction: "arrival",
        customer_name: "FEST ROMON CELINE",
        booking_service_kind: "transfer_airport_hotel",
        service_type_code: "transfer_airport_hotel",
        place_type: "airport",
        meeting_point: "AEROPORTO",
        transport_code: "LX1712",
        arrival_time: "08:40",
        ferry_details: {
          ferry_company: "Caremar",
          departure_time: "10:45",
          arrival_at_ischia: "12:15",
          arrival_port: "Ischia Porto",
        },
      }),
      { hotel: { name: "RESORT PUNTO AZZURRO", zone: "Forio" } }
    );

    expect(result.macro_category).toBe("ARRIVO");
    expect(result.assignable).toBe(true);
    expect(result.operational_time).toBe("12:15");
    expect(result.ferry_departure_time).toBe("10:45");
    expect(result.ferry_arrival_time).toBe("12:15");
  });

  it("uses train connection only as detail and island arrival as operational_time", () => {
    const result = resolveAssignableService(
      service({
        direction: "arrival",
        customer_name: "RIGATELLI SILVANA",
        booking_service_kind: "transfer_station_hotel",
        service_type_code: "transfer_station_hotel",
        place_type: "station",
        meeting_point: "STAZIONE",
        transport_code: "TRENO 11:38",
        arrival_time: "11:38",
        ferry_details: {
          ferry_company: "Medmar",
          departure_time: "13:30",
          arrival_at_ischia: "14:30",
          arrival_port: "Ischia Porto",
        },
      }),
      { hotel: { name: "HOTEL TERME COLELLA", zone: "Forio" } }
    );

    expect(result.macro_category).toBe("ARRIVO");
    expect(result.assignable).toBe(true);
    expect(result.operational_time).toBe("14:30");
    expect(result.ferry_departure_time).toBe("13:30");
  });

  it("computes Medmar island arrival from ferry departure when explicit arrival is missing", () => {
    const result = resolveAssignableService(
      service({
        direction: "arrival",
        booking_service_kind: "transfer_station_hotel",
        service_type_code: "transfer_station_hotel",
        place_type: "station",
        meeting_point: "STAZIONE",
        arrival_time: "11:38",
        ferry_details: {
          ferry_company: "Medmar",
          departure_time: "13:30",
          arrival_port: "Ischia Porto",
        },
      }),
      { hotel: { name: "HOTEL TERME COLELLA", zone: "Forio" } }
    );

    expect(result.macro_category).toBe("ARRIVO");
    expect(result.assignable).toBe(true);
    expect(result.operational_time).toBe("14:30");
    expect(result.ferry_arrival_time).toBe("14:30");
  });

  it("computes Caremar island arrival from ferry departure when explicit arrival is missing", () => {
    const result = resolveAssignableService(
      service({
        direction: "arrival",
        booking_service_kind: "transfer_airport_hotel",
        service_type_code: "transfer_airport_hotel",
        place_type: "airport",
        meeting_point: "AEROPORTO",
        arrival_time: "08:40",
        ferry_details: {
          ferry_company: "Caremar",
          departure_time: "10:45",
          arrival_port: "Ischia Porto",
        },
      }),
      { hotel: { name: "RESORT PUNTO AZZURRO", zone: "Forio" } }
    );

    expect(result.macro_category).toBe("ARRIVO");
    expect(result.assignable).toBe(true);
    expect(result.operational_time).toBe("12:15");
    expect(result.ferry_arrival_time).toBe("12:15");
  });

  it("does not use flight or train time as operational_time when ferry data is missing", () => {
    const result = resolveAssignableService(
      service({
        direction: "arrival",
        booking_service_kind: "transfer_airport_hotel",
        service_type_code: "transfer_airport_hotel",
        place_type: "airport",
        meeting_point: "AEROPORTO",
        transport_code: "LX1712",
        arrival_time: "08:40",
        time: "08:40",
      }),
      { hotel: { name: "RESORT PUNTO AZZURRO", zone: "Forio" } }
    );

    expect(result.macro_category).toBe("ARRIVO");
    expect(result.assignable).toBe(false);
    expect(result.operational_time).toBeNull();
    expect(result.review_reasons).toContain("Arrivo isola non determinato");
  });

  it("keeps departure operational_time on pickup fields", () => {
    const result = resolveAssignableService(
      service({
        direction: "departure",
        booking_service_kind: "formula_medmar",
        service_type_code: "ferry_transfer",
        pickup_hotel: "07:00",
        pickup_time: "07:05",
        arrival_time: "08:40",
        time: "08:40",
        barca_compagnia: "Medmar",
        orario_barca: "08:40",
        ferry_details: {
          departure_port: "Casamicciola",
        },
      }),
      { hotel: { name: "LA VILLA", zone: "Forio" } }
    );

    expect(result.macro_category).toBe("PARTENZA");
    expect(result.operational_time).toBe("07:00");
    expect(result.ferry_departure_time).toBe("08:40");
  });

  it("accepts arrival with Ischia Porto as island pickup", () => {
    const result = resolveAssignableService(
      service({
        direction: "arrival",
        booking_service_kind: "transfer_airport_hotel",
        service_type_code: "transfer_airport_hotel",
        ferry_details: {
          arrival_at_ischia: "10:10",
          arrival_port: "Ischia Porto",
        },
      }),
      { hotel: { name: "RESORT PUNTO AZZURRO", zone: "Forio" } }
    );

    expect(result.macro_category).toBe("ARRIVO");
    expect(result.assignable).toBe(true);
    expect(result.pickup_label).toBe("Ischia Porto");
  });

  it("accepts arrival with Casamicciola as island pickup", () => {
    const result = resolveAssignableService(
      service({
        direction: "arrival",
        booking_service_kind: "formula_snav",
        service_type_code: "ferry_transfer",
        ferry_details: {
          arrival_at_ischia: "17:25",
          arrival_port: "Casamicciola",
        },
      }),
      { hotel: { name: "HOTEL TERME COLELLA", zone: "Forio" } }
    );

    expect(result.macro_category).toBe("ARRIVO");
    expect(result.assignable).toBe(true);
    expect(result.pickup_label).toBe("Casamicciola");
  });

  it("blocks arrival with null island port", () => {
    const result = resolveAssignableService(
      service({
        direction: "arrival",
        booking_service_kind: "formula_snav",
        service_type_code: "ferry_transfer",
        ferry_details: { arrival_at_ischia: "17:25" },
      }),
      { hotel: { name: "HOTEL TERME COLELLA", zone: "Forio" } }
    );

    expect(result.assignable).toBe(false);
    expect(result.review_reasons).toContain("Porto arrivo isola non determinato");
    expect(result.hard_constraints).toContain("island_arrival_pickup_required");
  });

  it.each(["Pozzuoli", "Napoli", "Aeroporto", "Stazione"])(
    "blocks arrival with continent pickup %s",
    (arrivalPort) => {
      const result = resolveAssignableService(
        service({
          direction: "arrival",
          booking_service_kind: "formula_snav",
          service_type_code: "ferry_transfer",
          ferry_details: {
            arrival_at_ischia: "17:25",
            arrival_port: arrivalPort,
          },
        }),
        { hotel: { name: "HOTEL TERME COLELLA", zone: "Forio" } }
      );

      expect(result.assignable).toBe(false);
      expect(result.review_reasons).toContain("Porto arrivo isola non determinato");
    }
  );

  it("accepts departure toward Casamicciola as island port", () => {
    const result = resolveAssignableService(
      service({
        direction: "departure",
        booking_service_kind: "formula_medmar",
        service_type_code: "ferry_transfer",
        pickup_hotel: "07:00",
        ferry_details: { departure_port: "Casamicciola" },
      }),
      { hotel: { name: "LA VILLA", zone: "Forio" } }
    );

    expect(result.macro_category).toBe("PARTENZA");
    expect(result.assignable).toBe(true);
    expect(result.destination_label).toBe("Casamicciola");
  });

  it("accepts departure toward Ischia Porto as island port", () => {
    const result = resolveAssignableService(
      service({
        direction: "departure",
        booking_service_kind: "formula_snav",
        service_type_code: "ferry_transfer",
        pickup_hotel: "06:30",
        ferry_details: { departure_port: "Ischia Porto" },
      }),
      { hotel: { name: "RE FERDINANDO", zone: "Ischia Porto" } }
    );

    expect(result.macro_category).toBe("PARTENZA");
    expect(result.assignable).toBe(true);
    expect(result.destination_label).toBe("Ischia Porto");
  });

  it("blocks departure toward Pozzuoli as operational destination", () => {
    const result = resolveAssignableService(
      service({
        direction: "departure",
        booking_service_kind: "formula_medmar_pozzuoli",
        service_type_code: "ferry_transfer",
        pickup_hotel: "07:00",
        porto_bruno: "Pozzuoli",
      }),
      { hotel: { name: "LA VILLA", zone: "Forio" } }
    );

    expect(result.assignable).toBe(false);
    expect(result.destination_label).toBe("Porto da verificare");
    expect(result.review_reasons).toContain("Porto imbarco non determinato");
    expect(result.review_reasons).toContain("Porto imbarco isola non determinato");
  });

  it("does not block porto_bruno Pozzuoli when operative island port is Casamicciola", () => {
    const result = resolveAssignableService(
      service({
        direction: "departure",
        booking_service_kind: "formula_medmar_pozzuoli",
        service_type_code: "ferry_transfer",
        pickup_hotel: "07:00",
        porto_bruno: "Pozzuoli",
        ferry_details: { departure_port: "Casamicciola" },
      }),
      { hotel: { name: "LA VILLA", zone: "Forio" } }
    );

    expect(result.assignable).toBe(true);
    expect(result.destination_label).toBe("Casamicciola");
    expect(result.review_reasons).not.toContain("Destinazione continente usata come destinazione operativa isola");
  });

  it("uses db_computed porto_bruno as island pickup for airport arrivals", () => {
    const result = resolveAssignableService(
      service({
        direction: "arrival",
        customer_name: "FEST ROMON CELINE",
        booking_service_kind: "transfer_airport_hotel",
        service_type_code: "transfer_airport_hotel",
        place_type: "airport",
        meeting_point: "AEROPORTO",
        transport_code: "LX1712",
        arrival_time: "08:40",
        ferry_details: {
          ferry_company: "Caremar",
          departure_time: "10:45",
          arrival_at_ischia: "12:15",
          db_computed: {
            porto_bruno: "ischia_porto",
            nave_db: "caremar - 10:45 - ischia_porto",
          },
        },
      }),
      { hotel: { name: "RESORT PUNTO AZZURRO", zone: "Forio" } }
    );

    expect(result.assignable).toBe(true);
    expect(result.operational_time).toBe("12:15");
    expect(result.pickup_label).toBe("Ischia Porto");
    expect(result.connection_label).toContain("LX1712");
  });

  it("uses route island port as pickup for station arrivals", () => {
    const result = resolveAssignableService(
      service({
        direction: "arrival",
        customer_name: "SPADA CINZIA",
        booking_service_kind: "transfer_station_hotel",
        service_type_code: "transfer_station_hotel",
        place_type: "station",
        meeting_point: "STAZIONE",
        transport_code: "TRENO 11:38",
        arrival_time: "11:38",
        ferry_details: {
          ferry_company: "Medmar",
          departure_time: "13:30",
          arrival_at_ischia: "14:30",
          db_computed: {
            nave_db: "medmar - 13:30 - ischia_porto",
          },
        },
      }),
      { hotel: { name: "HOTEL TERME COLELLA", zone: "Forio" } }
    );

    expect(result.assignable).toBe(true);
    expect(result.operational_time).toBe("14:30");
    expect(result.pickup_label).toBe("Ischia Porto");
  });

  it("uses route island port instead of Pozzuoli for CAZZANTI departure", () => {
    const result = resolveAssignableService(
      service({
        direction: "departure",
        customer_name: "CAZZANTI IVANO",
        booking_service_kind: "formula_medmar_pozzuoli",
        service_type_code: "ferry_transfer",
        pickup_hotel: "07:00",
        porto_bruno: "Pozzuoli",
        vessel: "MEDMAR - 08:10 - POZZUOLI - ISCHIA",
        ferry_details: {
          ferry_company: "Medmar",
          departure_time: "08:10",
          db_computed: {
            nave_db: "MEDMAR - 08:10 - POZZUOLI - ISCHIA",
          },
        },
      }),
      { hotel: { name: "LA VILLA", zone: "Forio" } }
    );

    expect(result.assignable).toBe(true);
    expect(result.pickup_label).toBe("LA VILLA");
    expect(result.destination_label).toBe("Ischia Porto");
    expect(result.review_reasons).not.toContain("Destinazione continente usata come destinazione operativa isola");
  });

  it("uses route island port instead of Napoli for DIOLOSA and ROSSI departures", () => {
    for (const customer_name of ["DIOLOSA'", "ROSSI"]) {
      const result = resolveAssignableService(
        service({
          direction: "departure",
          customer_name,
          booking_service_kind: "formula_snav",
          service_type_code: "ferry_transfer",
          pickup_hotel: "12:30",
          porto_bruno: "Napoli",
          ferry_details: {
            ferry_company: "SNAV",
            departure_time: "14:00",
            to: "CASAMICCIOLA",
            db_computed: {
              nave_db: "SNAV - 14:00 - NAPOLI - CASAMICCIOLA",
            },
          },
        }),
        { hotel: { name: "LA VILLA", zone: "Forio" } }
      );

      expect(result.assignable).toBe(true);
      expect(result.destination_label).toBe("Casamicciola");
    }
  });

  it("marks President shuttle without specific point as needs_review", () => {
    const result = resolveAssignableService(
      service({
        booking_service_kind: "navetta",
        service_type_code: "bus_line",
        meeting_point: null,
      }),
      { hotel: { name: "HOTEL TERME PRESIDENT", zone: "Ischia Porto" } }
    );

    expect(result.macro_category).toBe("NAVETTA");
    expect(result.needs_review).toBe(true);
    expect(result.review_reasons).toContain("Pickup navetta non abbastanza specifico");
  });

  it("accepts shuttle with explicit pickup and destination", () => {
    const result = resolveAssignableService(
      service({
        booking_service_kind: "navetta",
        service_type_code: "bus_line",
        direction: "departure",
        meeting_point: "Piazzale Trieste 6, Ischia (Caffe del Direttore)",
      }),
      { hotel: { name: "HOTEL TERME PRESIDENT", zone: "Ischia Porto" } }
    );

    expect(result.macro_category).toBe("NAVETTA");
    expect(result.assignable).toBe(true);
    expect(result.pickup_label).toBe("HOTEL TERME PRESIDENT");
    expect(result.destination_label).toBe("Piazzale Trieste 6, Ischia (Caffe del Direttore)");
  });

  it("blocks Hotel San Nicola shuttle when pickup equals destination", () => {
    const result = resolveAssignableService(
      service({
        booking_service_kind: "navetta",
        service_type_code: "bus_line",
        direction: "departure",
        meeting_point: "Hotel San Nicola",
      }),
      { hotel: { name: "HOTEL SAN NICOLA", zone: "Forio/Panza" } }
    );

    expect(result.assignable).toBe(false);
    expect(result.review_reasons).toContain("Pickup navetta uguale a destinazione");
  });

  it("accepts Hotel San Nicola shuttle toward Citara", () => {
    const result = resolveAssignableService(
      service({
        booking_service_kind: "navetta",
        service_type_code: "bus_line",
        direction: "departure",
        meeting_point: "Citara",
      }),
      { hotel: { name: "HOTEL SAN NICOLA", zone: "Forio/Panza" } }
    );

    expect(result.assignable).toBe(true);
    expect(result.pickup_label).toBe("HOTEL SAN NICOLA");
    expect(result.destination_label).toBe("Citara");
  });

  it("keeps SNAV and Medmar as details, never macro categories", () => {
    const arrival = resolveAssignableService(
      service({
        direction: "arrival",
        booking_service_kind: "formula_snav",
        service_type_code: "ferry_transfer",
        vessel: "SNAV",
        ferry_details: { arrival_at_ischia: "08:15", arrival_port: "casamicciola" },
      }),
      { hotel: { name: "HOTEL TEST", zone: "Forio" } }
    );
    const departure = resolveAssignableService(
      service({
        direction: "departure",
        booking_service_kind: "formula_medmar_pozzuoli",
        service_type_code: "ferry_transfer",
        pickup_hotel: "07:00",
        porto_bruno: "Casamicciola",
      }),
      { hotel: { name: "HOTEL TEST", zone: "Forio" } }
    );

    expect(arrival.macro_category).toBe("ARRIVO");
    expect(departure.macro_category).toBe("PARTENZA");
    expect([arrival.macro_category, departure.macro_category]).not.toContain("FORMULA_NAVE");
  });

  it("does not block CAM 320 room references", () => {
    const result = resolveAssignableService(service({
      customer_name: "CAM 320",
      booking_service_kind: "excursion",
      service_type_code: "excursion",
      service_type: "bus_tour",
      excursion_details: { from: "FELIX", to: "NITRODI" },
    }));

    expect(result.assignable).toBe(true);
    expect(result.review_reasons).not.toContain("Nome cliente mancante");
    expect(result.soft_preferences).toContain("Nome cliente non disponibile: riferimento camera");
  });

  it("marks missing pax as needs_review", () => {
    const result = resolveAssignableService(service({
      pax: null,
      booking_service_kind: "excursion",
      service_type_code: "excursion",
      service_type: "bus_tour",
      excursion_details: { from: "FELIX", to: "NITRODI" },
    }));

    expect(result.assignable).toBe(false);
    expect(result.needs_review).toBe(true);
    expect(result.review_reasons).toContain("Pax mancante/non valido");
  });

  it("marks missing operational time as needs_review", () => {
    const result = resolveAssignableService(service({
      time: null,
      departure_time: null,
      booking_service_kind: "excursion",
      service_type_code: "excursion",
      service_type: "bus_tour",
      excursion_details: { from: "FELIX", to: "NITRODI" },
    }));

    expect(result.assignable).toBe(false);
    expect(result.review_reasons).toContain("Orario operativo non determinato");
  });

  it("marks missing pickup and destination together as needs_review", () => {
    const result = resolveAssignableService(service({
      time: null,
      direction: null,
      booking_service_kind: "unknown",
      service_type_code: "unknown",
    }));

    expect(result.assignable).toBe(false);
    expect(result.review_reasons).toContain("Pickup e destinazione entrambi mancanti");
  });

  it("blocks simplified 07/05 arrivals without island pickup port", () => {
    const names = [
      "FEST ROMON CELINE",
      "MARTINO FILOMENA",
      "RIGATELLI SILVANA",
      "SPADA CINZIA",
      "D'ARIA PLACIDO",
      "GUIDA DANIELA",
      "PETTENNUZZO",
      "CAM 176X2 - 330X1",
      "DE SILVA TEREZINHA",
      "PINNA MAURO",
    ];

    for (const name of names) {
      const result = resolveAssignableService(
        service({
          direction: "arrival",
          customer_name: name,
          booking_service_kind: "formula_snav",
          service_type_code: "ferry_transfer",
          ferry_details: { arrival_at_ischia: "16:20" },
        }),
        { hotel: { name: "HOTEL TEST", zone: "Forio" } }
      );

      expect(result.assignable).toBe(false);
      expect(result.review_reasons).toContain("Porto arrivo isola non determinato");
    }
  });

  it("blocks simplified 07/05 departures without island embarkation port", () => {
    const names = [
      "CAZZANTI IVANO",
      "IORI ISABELLA",
      "SCARANI GIOVANNI",
      "CATULLO LUCIA",
      "LODI BARBARA",
    ];

    for (const name of names) {
      const result = resolveAssignableService(
        service({
          direction: "departure",
          customer_name: name,
          booking_service_kind: "formula_medmar_pozzuoli",
          service_type_code: "ferry_transfer",
          pickup_hotel: "07:00",
          porto_bruno: "Pozzuoli",
        }),
        { hotel: { name: "LA VILLA", zone: "Forio" } }
      );

      expect(result.assignable).toBe(false);
      expect(result.review_reasons).toContain("Porto imbarco non determinato");
      expect(result.review_reasons).toContain("Porto imbarco isola non determinato");
    }
  });
});
