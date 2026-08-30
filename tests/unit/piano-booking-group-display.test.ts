import { describe, it, expect } from "vitest";
import {
  buildPianoDisplayUnits,
  type PianoBookingGroupLike,
  type PianoBookingGroupStopLike,
  type PianoBusReservationLike,
  type PianoBusUnitLike,
  type PianoBookingGroupUnit,
  type PianoGroupAwareService,
} from "@/lib/piano-booking-group-display";

/**
 * FASE 4 — test dell'helper puro di aggregazione Piano del Giorno.
 * Nessun DB: input/output sono solo oggetti plain TS (sezioni 34-41 del prompt).
 */

type TestService = PianoGroupAwareService & { customer_name: string };

function svc(over: Partial<TestService> & Pick<TestService, "id" | "direction" | "pax" | "time">): TestService {
  return {
    booking_group_id: null,
    booking_group_stop_id: null,
    date: "2026-09-12",
    customer_name: "Cliente",
    ...over,
  };
}

function group(over: Partial<PianoBookingGroupLike> & Pick<PianoBookingGroupLike, "id" | "expected_pax">): PianoBookingGroupLike {
  return {
    name: "Gruppo",
    kind: "other",
    status: "operational",
    service_date: "2026-09-12",
    outbound_ferry_company: null,
    outbound_departure_port: null,
    outbound_ferry_time: null,
    outbound_arrival_port: null,
    outbound_expected_arrival_time: null,
    return_ferry_company: null,
    return_departure_port: null,
    return_ferry_time: null,
    return_arrival_port: null,
    return_expected_arrival_time: null,
    ...over,
  };
}

function stop(over: Partial<PianoBookingGroupStopLike> & Pick<PianoBookingGroupStopLike, "id" | "booking_group_id" | "city" | "expected_pax" | "direction">): PianoBookingGroupStopLike {
  return { pickup_point: null, sort_order: 0, ...over };
}

const GID = "g1";

function asGroupUnit(u: ReturnType<typeof buildPianoDisplayUnits<TestService>>[number]): PianoBookingGroupUnit<TestService> {
  if (u.type !== "booking_group") throw new Error("expected booking_group unit");
  return u;
}

describe("buildPianoDisplayUnits — aggregazione base (§34)", () => {
  it("3 services stesso booking_group_id → 1 group unit con service_count=3 e pax corretto", () => {
    const services = [
      svc({ id: "s1", direction: "arrival", pax: 4, time: "10:00", booking_group_id: GID }),
      svc({ id: "s2", direction: "arrival", pax: 10, time: "10:05", booking_group_id: GID }),
      svc({ id: "s3", direction: "arrival", pax: 2, time: "10:10", booking_group_id: GID }),
    ];
    const units = buildPianoDisplayUnits({
      services,
      bookingGroups: [group({ id: GID, expected_pax: 16 })],
      stops: [],
      reservations: [],
      busUnits: [],
    });
    expect(units).toHaveLength(1);
    const g = asGroupUnit(units[0]);
    expect(g.serviceCount).toBe(3);
    expect(g.servicePax).toBe(16);
    expect(g.services.map((s) => s.id).sort()).toEqual(["s1", "s2", "s3"]);
  });

  it("service normale senza gruppo → riga service, nessun service duplicato fuori dalla unit", () => {
    const services = [
      svc({ id: "s1", direction: "arrival", pax: 4, time: "10:00", booking_group_id: GID }),
      svc({ id: "s2", direction: "arrival", pax: 2, time: "09:00" }),
    ];
    const units = buildPianoDisplayUnits({
      services,
      bookingGroups: [group({ id: GID, expected_pax: 4 })],
      stops: [],
      reservations: [],
      busUnits: [],
    });
    expect(units).toHaveLength(2);
    const normal = units.find((u) => u.type === "service");
    expect(normal?.type).toBe("service");
    if (normal?.type === "service") expect(normal.service.id).toBe("s2");
    const allIds = units.flatMap((u) => (u.type === "booking_group" ? u.services.map((s) => s.id) : [u.service.id]));
    expect(new Set(allIds).size).toBe(allIds.length);
  });
});

describe("buildPianoDisplayUnits — direzione (§35)", () => {
  it("stesso booking_group_id con 2 arrival + 2 departure → 2 group unit distinte", () => {
    const services = [
      svc({ id: "a1", direction: "arrival", pax: 5, time: "10:00", booking_group_id: GID }),
      svc({ id: "a2", direction: "arrival", pax: 5, time: "10:05", booking_group_id: GID }),
      svc({ id: "d1", direction: "departure", pax: 5, time: "18:00", booking_group_id: GID }),
      svc({ id: "d2", direction: "departure", pax: 5, time: "18:05", booking_group_id: GID }),
    ];
    const units = buildPianoDisplayUnits({
      services,
      bookingGroups: [group({ id: GID, expected_pax: 20 })],
      stops: [],
      reservations: [],
      busUnits: [],
    });
    const groupUnits = units.filter((u) => u.type === "booking_group") as PianoBookingGroupUnit<TestService>[];
    expect(groupUnits).toHaveLength(2);
    expect(groupUnits.map((g) => g.direction).sort()).toEqual(["arrival", "departure"]);
  });
});

describe("buildPianoDisplayUnits — fermate (§36)", () => {
  it("raggruppa per booking_group_stop_id e crea sezione 'non associata' per stop_id null", () => {
    const stopTivoli = stop({ id: "st-tivoli", booking_group_id: GID, city: "Tivoli", pickup_point: "Villa d'Este", expected_pax: 20, direction: "arrival", sort_order: 0 });
    const stopGuidonia = stop({ id: "st-guidonia", booking_group_id: GID, city: "Guidonia", pickup_point: "Fermata Bus", expected_pax: 15, direction: "arrival", sort_order: 1 });
    const services = [
      svc({ id: "s1", direction: "arrival", pax: 2, time: "10:00", booking_group_id: GID, booking_group_stop_id: "st-tivoli" }),
      svc({ id: "s2", direction: "arrival", pax: 2, time: "10:01", booking_group_id: GID, booking_group_stop_id: "st-tivoli" }),
      svc({ id: "s3", direction: "arrival", pax: 10, time: "10:02", booking_group_id: GID, booking_group_stop_id: "st-tivoli" }),
      svc({ id: "s4", direction: "arrival", pax: 6, time: "10:02", booking_group_id: GID, booking_group_stop_id: "st-tivoli" }),
      svc({ id: "s5", direction: "arrival", pax: 15, time: "10:10", booking_group_id: GID, booking_group_stop_id: "st-guidonia" }),
      svc({ id: "s6", direction: "arrival", pax: 3, time: "10:20", booking_group_id: GID }), // senza stop
    ];
    const units = buildPianoDisplayUnits({
      services,
      bookingGroups: [group({ id: GID, expected_pax: 50 })],
      stops: [stopTivoli, stopGuidonia],
      reservations: [],
      busUnits: [],
    });
    const g = asGroupUnit(units[0]);
    expect(g.stopCount).toBe(2);
    expect(g.stops).toHaveLength(3); // 2 fermate + 1 sezione "non associata"
    const tivoli = g.stops.find((s) => s.bookingGroupStopId === "st-tivoli")!;
    expect(tivoli.serviceCount).toBe(4);
    expect(tivoli.servicePax).toBe(20);
    const unlinked = g.stops.find((s) => s.bookingGroupStopId === null)!;
    expect(unlinked.serviceCount).toBe(1);
    expect(unlinked.expectedPax).toBeNull();
    expect(g.warnings).toContain("unlinked_group_service");
  });
});

describe("buildPianoDisplayUnits — pax (§37)", () => {
  it("expected 50, services 35 → warning group_pax_incomplete", () => {
    const services = [svc({ id: "s0", direction: "arrival", pax: 35, time: "10:00", booking_group_id: GID })];
    const units = buildPianoDisplayUnits({
      services,
      bookingGroups: [group({ id: GID, expected_pax: 50 })],
      stops: [],
      reservations: [],
      busUnits: [],
    });
    const g = asGroupUnit(units[0]);
    expect(g.servicePax).toBe(35);
    expect(g.warnings).toContain("group_pax_incomplete");
    expect(g.warnings).not.toContain("group_pax_overbooked");
  });

  it("expected 50, services 55 → warning group_pax_overbooked", () => {
    const services = [svc({ id: "s1", direction: "arrival", pax: 55, time: "10:00", booking_group_id: GID })];
    const units = buildPianoDisplayUnits({
      services,
      bookingGroups: [group({ id: GID, expected_pax: 50 })],
      stops: [],
      reservations: [],
      busUnits: [],
    });
    const g = asGroupUnit(units[0]);
    expect(g.warnings).toContain("group_pax_overbooked");
  });
});

describe("buildPianoDisplayUnits — bus reservation (§38)", () => {
  const busUnit: PianoBusUnitLike = { id: "bu1", label: "EUROBUS 1", capacity: 54 };
  const services = [svc({ id: "s1", direction: "arrival", pax: 50, time: "10:00", booking_group_id: GID })];

  it("capacity 54, reserved 50 → nessun warning di capienza, reservation esposta", () => {
    const reservation: PianoBusReservationLike = { id: "r1", booking_group_id: GID, bus_unit_id: "bu1", service_date: "2026-09-12", reserved_pax: 50, exclusive: true };
    const units = buildPianoDisplayUnits({
      services,
      bookingGroups: [group({ id: GID, expected_pax: 50, kind: "bus_exclusive" })],
      stops: [],
      reservations: [reservation],
      busUnits: [busUnit],
    });
    const g = asGroupUnit(units[0]);
    expect(g.busReservation).toEqual({ busUnitId: "bu1", busLabel: "EUROBUS 1", reservedPax: 50, capacity: 54, exclusive: true });
    expect(g.warnings).not.toContain("reserved_pax_above_capacity");
    expect(g.warnings).not.toContain("reserved_pax_below_expected");
  });

  it("capacity 40, reserved 50 → warning reserved_pax_above_capacity", () => {
    const smallBus: PianoBusUnitLike = { id: "bu1", label: "MINIBUS", capacity: 40 };
    const reservation: PianoBusReservationLike = { id: "r1", booking_group_id: GID, bus_unit_id: "bu1", service_date: "2026-09-12", reserved_pax: 50, exclusive: true };
    const units = buildPianoDisplayUnits({
      services,
      bookingGroups: [group({ id: GID, expected_pax: 50, kind: "bus_exclusive" })],
      stops: [],
      reservations: [reservation],
      busUnits: [smallBus],
    });
    const g = asGroupUnit(units[0]);
    expect(g.warnings).toContain("reserved_pax_above_capacity");
  });

  it("bus_exclusive senza reservation → warning bus_reservation_missing", () => {
    const units = buildPianoDisplayUnits({
      services,
      bookingGroups: [group({ id: GID, expected_pax: 50, kind: "bus_exclusive" })],
      stops: [],
      reservations: [],
      busUnits: [],
    });
    const g = asGroupUnit(units[0]);
    expect(g.busReservation).toBeNull();
    expect(g.warnings).toContain("bus_reservation_missing");
  });
});

describe("buildPianoDisplayUnits — service draft/cancellato (§39)", () => {
  it("l'helper aggrega solo i services ricevuti: il Piano esclude già is_draft/cancelled a monte (query)", () => {
    const operational = [svc({ id: "s1", direction: "arrival", pax: 10, time: "10:00", booking_group_id: GID })];
    const units = buildPianoDisplayUnits({
      services: operational,
      bookingGroups: [group({ id: GID, expected_pax: 50 })],
      stops: [],
      reservations: [],
      busUnits: [],
    });
    const g = asGroupUnit(units[0]);
    expect(g.serviceCount).toBe(1);
    expect(g.servicePax).toBe(10);
  });
});

describe("buildPianoDisplayUnits — gruppo orfano / fail-safe", () => {
  it("booking_group_id che punta a un gruppo inesistente degrada a service normale", () => {
    const services = [svc({ id: "s1", direction: "arrival", pax: 10, time: "10:00", booking_group_id: "ghost" })];
    const units = buildPianoDisplayUnits({
      services,
      bookingGroups: [],
      stops: [],
      reservations: [],
      busUnits: [],
    });
    expect(units).toHaveLength(1);
    expect(units[0].type).toBe("service");
  });
});

describe("buildPianoDisplayUnits — ordinamento", () => {
  it("la group unit occupa la posizione del primo service del gruppo nell'array in ingresso", () => {
    const services = [
      svc({ id: "solo1", direction: "arrival", pax: 2, time: "08:00" }),
      svc({ id: "g-first", direction: "arrival", pax: 4, time: "09:00", booking_group_id: GID }),
      svc({ id: "solo2", direction: "arrival", pax: 3, time: "09:30" }),
      svc({ id: "g-second", direction: "arrival", pax: 4, time: "09:45", booking_group_id: GID }),
      svc({ id: "solo3", direction: "arrival", pax: 1, time: "11:00" }),
    ];
    const units = buildPianoDisplayUnits({
      services,
      bookingGroups: [group({ id: GID, expected_pax: 8 })],
      stops: [],
      reservations: [],
      busUnits: [],
    });
    const shape = units.map((u) => (u.type === "service" ? u.service.id : "GROUP"));
    expect(shape).toEqual(["solo1", "GROUP", "solo2", "solo3"]);
  });
});

describe("buildPianoDisplayUnits — performance (§41)", () => {
  it("400 services su 20 gruppi si aggregano senza esplosione quadratica evidente", () => {
    const groups: PianoBookingGroupLike[] = Array.from({ length: 20 }, (_, i) => group({ id: `g${i}`, expected_pax: 10 }));
    const services: TestService[] = [];
    for (let i = 0; i < 400; i += 1) {
      const groupId = i % 2 === 0 ? `g${i % 20}` : null;
      services.push(svc({ id: `s${i}`, direction: i % 2 === 0 ? "arrival" : "departure", pax: 1, time: `${String(8 + (i % 10)).padStart(2, "0")}:00`, booking_group_id: groupId }));
    }
    const start = performance.now();
    const units = buildPianoDisplayUnits({ services, bookingGroups: groups, stops: [], reservations: [], busUnits: [] });
    const elapsedMs = performance.now() - start;
    expect(units.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(200);
  });
});
