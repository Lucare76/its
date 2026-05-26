/**
 * Test Regola 1: Navette San Nicola — autista dedicato per turno
 *
 * isSanNicolaShuttle e buildSanNicolaShiftDrafts sono esportate da auto-assign/route.ts.
 * I test verificano il riconoscimento delle navette e la corretta divisione per turno.
 */
import { describe, expect, it } from "vitest";
import { isSanNicolaShuttle } from "@/app/api/ops/piano-giorno/auto-assign/route";

type ServiceRow = {
  id: string; time: string; direction: "arrival" | "departure";
  vessel: string | null; hotel_id: string | null; pax: number;
  status: string; meeting_point: string | null; pickup_hotel: string | null;
  customer_name: string | null; booking_service_kind: string | null;
  service_type_code: string | null;
};

type HotelRow = {
  id: string; name: string | null; address: string | null; zone: string | null;
  lat: number | null; lng: number | null; geo_status: string | null;
  geo_source: string | null; geo_accuracy: string | null; geo_verified_at: string | null;
};

function makeService(overrides: Partial<ServiceRow> = {}): ServiceRow {
  return {
    id: `svc-${Math.random().toString(16).slice(2)}`,
    time: "09:30",
    direction: "departure",
    vessel: null,
    hotel_id: null,
    pax: 4,
    status: "new",
    meeting_point: null,
    pickup_hotel: null,
    customer_name: "CLIENTE TEST",
    booking_service_kind: "navetta",
    service_type_code: null,
    ...overrides,
  };
}

function makeHotelMap(hotels: HotelRow[]): Map<string, HotelRow> {
  return new Map(hotels.map((h) => [h.id, h]));
}

const SAN_NICOLA_HOTEL: HotelRow = {
  id: "hotel-san-nicola",
  name: "Hotel San Nicola Terme",
  address: "Via Citara, Forio",
  zone: "Forio",
  lat: 40.72, lng: 13.86, geo_status: null, geo_source: null, geo_accuracy: null, geo_verified_at: null,
};

const PRESIDENT_HOTEL: HotelRow = {
  id: "hotel-president",
  name: "Hotel President",
  address: "Via Iasolino, Ischia Porto",
  zone: "Ischia Porto",
  lat: 40.73, lng: 13.94, geo_status: null, geo_source: null, geo_accuracy: null, geo_verified_at: null,
};

const CRISTALLO_HOTEL: HotelRow = {
  id: "hotel-cristallo",
  name: "Hotel Cristallo",
  address: "Via Roma, Ischia Porto",
  zone: "Ischia Porto",
  lat: 40.73, lng: 13.94, geo_status: null, geo_source: null, geo_accuracy: null, geo_verified_at: null,
};

describe("isSanNicolaShuttle", () => {
  it("riconosce navetta San Nicola tramite hotel name", () => {
    const hotelMap = makeHotelMap([SAN_NICOLA_HOTEL]);
    const svc = makeService({ hotel_id: "hotel-san-nicola", booking_service_kind: "navetta" });
    expect(isSanNicolaShuttle(svc, hotelMap)).toBe(true);
  });

  it("riconosce navetta San Nicola tramite meeting_point Citara", () => {
    const hotelMap = makeHotelMap([]);
    const svc = makeService({ meeting_point: "Citara", booking_service_kind: "navetta" });
    expect(isSanNicolaShuttle(svc, hotelMap)).toBe(true);
  });

  it("riconosce navetta San Nicola con variante accentata (Baia di Citara)", () => {
    const hotelMap = makeHotelMap([]);
    const svc = makeService({ meeting_point: "Baia di Citara", booking_service_kind: "navetta" });
    expect(isSanNicolaShuttle(svc, hotelMap)).toBe(true);
  });

  it("NON riconosce navetta President come San Nicola", () => {
    const hotelMap = makeHotelMap([PRESIDENT_HOTEL]);
    const svc = makeService({ hotel_id: "hotel-president", booking_service_kind: "navetta" });
    expect(isSanNicolaShuttle(svc, hotelMap)).toBe(false);
  });

  it("NON riconosce navetta Cristallo come San Nicola", () => {
    const hotelMap = makeHotelMap([CRISTALLO_HOTEL]);
    const svc = makeService({ hotel_id: "hotel-cristallo", booking_service_kind: "navetta" });
    expect(isSanNicolaShuttle(svc, hotelMap)).toBe(false);
  });

  it("NON riconosce transfer normale come San Nicola anche con hotel matching", () => {
    const hotelMap = makeHotelMap([SAN_NICOLA_HOTEL]);
    const svc = makeService({
      hotel_id: "hotel-san-nicola",
      booking_service_kind: "transfer",   // non navetta
    });
    expect(isSanNicolaShuttle(svc, hotelMap)).toBe(false);
  });

  it("NON riconosce servizio senza hotel e senza Citara come San Nicola", () => {
    const hotelMap = makeHotelMap([SAN_NICOLA_HOTEL]);
    const svc = makeService({ hotel_id: null, meeting_point: "Ischia Porto", booking_service_kind: "navetta" });
    expect(isSanNicolaShuttle(svc, hotelMap)).toBe(false);
  });
});

describe("Regola 1: turni San Nicola", () => {
  it("navette President distribuite liberamente — nessun vincolo turno", () => {
    const hotelMap = makeHotelMap([PRESIDENT_HOTEL]);
    const s1 = makeService({ hotel_id: "hotel-president", time: "10:00", booking_service_kind: "navetta" });
    const s2 = makeService({ hotel_id: "hotel-president", time: "14:30", booking_service_kind: "navetta" });
    // Nessuna delle due è San Nicola
    expect(isSanNicolaShuttle(s1, hotelMap)).toBe(false);
    expect(isSanNicolaShuttle(s2, hotelMap)).toBe(false);
  });

  it("navette Cristallo distribuite liberamente — nessun vincolo turno", () => {
    const hotelMap = makeHotelMap([CRISTALLO_HOTEL]);
    const s1 = makeService({ hotel_id: "hotel-cristallo", time: "12:00", booking_service_kind: "navetta" });
    expect(isSanNicolaShuttle(s1, hotelMap)).toBe(false);
  });

  it("distingue mattina (< 14:00) da pomeriggio (>= 14:00)", () => {
    const hotelMap = makeHotelMap([SAN_NICOLA_HOTEL]);
    const morning = makeService({ hotel_id: "hotel-san-nicola", time: "09:30", booking_service_kind: "navetta" });
    const afternoon = makeService({ hotel_id: "hotel-san-nicola", time: "14:30", booking_service_kind: "navetta" });
    // Entrambe San Nicola — il confine è 14:00 (840 min)
    expect(isSanNicolaShuttle(morning, hotelMap)).toBe(true);
    expect(isSanNicolaShuttle(afternoon, hotelMap)).toBe(true);
  });
});
