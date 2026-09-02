import { describe, it, expect } from "vitest";
import { loadBusNetwork } from "@/lib/server/bus-network-loader";
import type { PricingAuthContext } from "@/lib/server/pricing-auth";

/**
 * FASE A.5.1 §C/§H — test diretto sul VERO read-model condiviso di Linea Bus
 * (`loadBusNetwork`, estratto da `app/api/ops/bus-network/route.ts` in
 * `lib/server/bus-network-loader.ts`), non una simulazione parallela.
 *
 * Scenario: gruppo bus esclusivo Rimini, andata 13-09-2026 (arrival, 50 pax),
 * ritorno 20-09-2026 (departure, 50 pax) — verifica che stop_loads e
 * unit_loads aggregino correttamente i pax allocati per direzione/fermata e
 * per mezzo.
 */

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Row = Record<string, unknown>;

function makeAdmin(seed: Record<string, Row[]>) {
  function builder(table: string) {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.or = () => b;
    b.maybeSingle = async () => ({ data: (seed[table] ?? [])[0] ?? null, error: null });
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: seed[table] ?? [], error: null }).then(resolve);
    return b;
  }
  return { from: (t: string) => builder(t) } as unknown as PricingAuthContext["admin"];
}

describe("loadBusNetwork — read-model diretto Linea Bus (§C/§H)", () => {
  it("13-09 arrival 50 pax + 20-09 departure 50 pax: stop_loads e unit_loads corretti", async () => {
    const auth = {
      admin: makeAdmin({
        tenant_bus_lines: [{ id: "line-adriatica", tenant_id: TENANT, family_code: "ADRIATICA", name: "Adriatica" }],
        tenant_bus_line_stops: [
          { id: "stop-rimini-arr", tenant_id: TENANT, direction: "arrival", stop_name: "Rimini", city: "Rimini", stop_order: 0, active: true },
          { id: "stop-rimini-dep", tenant_id: TENANT, direction: "departure", stop_name: "Rimini", city: "Rimini", stop_order: 0, active: true },
        ],
        tenant_bus_units: [{ id: "bus-1", tenant_id: TENANT, bus_line_id: "line-adriatica", label: "Bus Esclusivo", capacity: 54, low_seat_threshold: 5, status: "open", manual_close: false, sort_order: 0, active: true }],
        tenant_bus_allocations: [
          { id: "alloc-out", tenant_id: TENANT, service_id: "svc-out", bus_line_id: "line-adriatica", bus_unit_id: "bus-1", stop_id: "stop-rimini-arr", stop_name: "Rimini", direction: "arrival", pax_assigned: 50, notes: null },
          { id: "alloc-ret", tenant_id: TENANT, service_id: "svc-ret", bus_line_id: "line-adriatica", bus_unit_id: "bus-1", stop_id: "stop-rimini-dep", stop_name: "Rimini", direction: "departure", pax_assigned: 50, notes: null },
        ],
        ops_bus_allocation_details: [],
        tenant_bus_allocation_moves: [],
        services: [
          { id: "svc-out", tenant_id: TENANT, customer_name: "Gruppo La Marra", date: "2026-09-13", time: "05:10", pax: 50, direction: "arrival", hotel_id: null, booking_service_kind: "bus_city_hotel" },
          { id: "svc-ret", tenant_id: TENANT, customer_name: "Gruppo La Marra", date: "2026-09-20", time: "07:00", pax: 50, direction: "departure", hotel_id: null, booking_service_kind: "bus_city_hotel" },
        ],
        hotels: [],
        bus_import_pending: [],
        bus_unit_driver_dates: [],
        bus_ischia_dist_buses: [],
        bus_ischia_dist_allocations: [],
        vehicles: [],
        driver_profiles: [],
        bus_line_ferry_config: [],
      }),
      membership: { tenant_id: TENANT, role: "operator", suspended: false },
      user: { id: "u1", email: "op@example.com" },
    } as unknown as PricingAuthContext;

    const result = await loadBusNetwork(auth);

    const arrivalStop = result.stop_loads.find((s: Record<string, unknown>) => s.direction === "arrival" && s.stop_name === "Rimini");
    const departureStop = result.stop_loads.find((s: Record<string, unknown>) => s.direction === "departure" && s.stop_name === "Rimini");
    expect(arrivalStop?.pax_assigned).toBe(50);
    expect(departureStop?.pax_assigned).toBe(50);

    const busLoad = result.unit_loads.find((u: Record<string, unknown>) => u.id === "bus-1");
    expect(busLoad?.pax_assigned).toBe(100);
    expect(busLoad?.remaining_seats).toBe(0);
  });
});

describe("loadBusNetwork — Fix D: fallback hotel del booking group quando service.hotel_id è null", () => {
  const GROUP_ID = "bg-giacomoni";
  const HOTEL_ID = "hotel-adriatico";

  function baseSeed(overrides: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
    return {
      tenant_bus_lines: [],
      tenant_bus_line_stops: [],
      tenant_bus_units: [],
      tenant_bus_allocations: [],
      ops_bus_allocation_details: [],
      tenant_bus_allocation_moves: [],
      hotels: [{ id: HOTEL_ID, tenant_id: TENANT, name: "Hotel Adriatico", zone: "porto" }],
      bus_import_pending: [],
      bus_unit_driver_dates: [],
      bus_ischia_dist_buses: [],
      bus_ischia_dist_allocations: [],
      vehicles: [],
      driver_profiles: [],
      bus_line_ferry_config: [],
      booking_groups: [{ id: GROUP_ID, tenant_id: TENANT, name: "Gruppo GIACOMONI", kind: "bus_exclusive", status: "passengers_defined", hotel_id: HOTEL_ID }],
      ...overrides,
    };
  }

  it("service.hotel_id null + booking_group_id valorizzato → hotel_name usa l'hotel del gruppo, non 'Hotel N/D'", async () => {
    const auth = {
      admin: makeAdmin(baseSeed({
        services: [
          { id: "svc-1", tenant_id: TENANT, customer_name: "Bernardi Luisa", date: "2026-09-13", time: "05:10", pax: 1, direction: "arrival", hotel_id: null, booking_group_id: GROUP_ID, booking_service_kind: "bus_city_hotel" },
        ],
      })),
      membership: { tenant_id: TENANT, role: "operator", suspended: false },
      user: { id: "u1", email: "op@example.com" },
    } as unknown as PricingAuthContext;

    const result = await loadBusNetwork(auth);
    const svc = result.services.find((s: Record<string, unknown>) => s.id === "svc-1") as Record<string, unknown>;
    expect(svc.hotel_name).toBe("Hotel Adriatico");
    expect(svc.hotel_name).not.toBe("Hotel N/D");
  });

  it("service.hotel_id valorizzato ha priorità sull'hotel del gruppo", async () => {
    const OWN_HOTEL_ID = "hotel-own";
    const auth = {
      admin: makeAdmin(baseSeed({
        hotels: [
          { id: HOTEL_ID, tenant_id: TENANT, name: "Hotel Adriatico", zone: "porto" },
          { id: OWN_HOTEL_ID, tenant_id: TENANT, name: "Hotel Proprio", zone: "centro" },
        ],
        services: [
          { id: "svc-2", tenant_id: TENANT, customer_name: "Onori Valdes", date: "2026-09-13", time: "05:10", pax: 1, direction: "arrival", hotel_id: OWN_HOTEL_ID, booking_group_id: GROUP_ID, booking_service_kind: "bus_city_hotel" },
        ],
      })),
      membership: { tenant_id: TENANT, role: "operator", suspended: false },
      user: { id: "u1", email: "op@example.com" },
    } as unknown as PricingAuthContext;

    const result = await loadBusNetwork(auth);
    const svc = result.services.find((s: Record<string, unknown>) => s.id === "svc-2") as Record<string, unknown>;
    expect(svc.hotel_name).toBe("Hotel Proprio");
  });

  it("nessun booking_group_id e nessun hotel_id → resta 'Hotel N/D' (nessuna regressione)", async () => {
    const auth = {
      admin: makeAdmin(baseSeed({
        services: [
          { id: "svc-3", tenant_id: TENANT, customer_name: "Cliente Senza Gruppo", date: "2026-09-13", time: "05:10", pax: 1, direction: "arrival", hotel_id: null, booking_group_id: null, booking_service_kind: "bus_city_hotel" },
        ],
      })),
      membership: { tenant_id: TENANT, role: "operator", suspended: false },
      user: { id: "u1", email: "op@example.com" },
    } as unknown as PricingAuthContext;

    const result = await loadBusNetwork(auth);
    const svc = result.services.find((s: Record<string, unknown>) => s.id === "svc-3") as Record<string, unknown>;
    expect(svc.hotel_name).toBe("Hotel N/D");
  });
});

describe("loadBusNetwork — Obiettivo E: booking_group_reservations esposte per label bus data-scoped", () => {
  const GROUP_ID = "bg-giacomoni";
  const ORPHAN_ID = "bg-orphan";
  const BUS_ID = "bus-shared";

  function baseSeed(overrides: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
    return {
      tenant_bus_lines: [], tenant_bus_line_stops: [], tenant_bus_units: [],
      tenant_bus_allocations: [], ops_bus_allocation_details: [], tenant_bus_allocation_moves: [],
      hotels: [], bus_import_pending: [], bus_unit_driver_dates: [],
      bus_ischia_dist_buses: [], bus_ischia_dist_allocations: [], vehicles: [], driver_profiles: [],
      bus_line_ferry_config: [], services: [],
      ...overrides,
    };
  }

  it("reservation esclusiva per bus+data -> esposta con nome/kind gruppo risolti", async () => {
    const auth = {
      admin: makeAdmin(baseSeed({
        booking_groups: [{ id: GROUP_ID, tenant_id: TENANT, name: "GIACOMONI", kind: "bus_exclusive", status: "to_complete", hotel_id: null }],
        booking_group_bus_reservations: [
          { id: "r1", tenant_id: TENANT, booking_group_id: GROUP_ID, bus_unit_id: BUS_ID, service_date: "2026-09-06", exclusive: true, reserved_pax: 38 },
        ],
      })),
      membership: { tenant_id: TENANT, role: "operator", suspended: false },
      user: { id: "u1", email: "op@example.com" },
    } as unknown as PricingAuthContext;

    const result = await loadBusNetwork(auth);
    expect(result.booking_group_reservations).toMatchObject([
      { id: "r1", booking_group_id: GROUP_ID, bus_unit_id: BUS_ID, service_date: "2026-09-06", exclusive: true, reserved_pax: 38, booking_group_name: "GIACOMONI", booking_group_kind: "bus_exclusive" },
    ]);
  });

  it("reservation di un gruppo CANCELLATO -> esclusa (mai una label per un gruppo cancellato)", async () => {
    const auth = {
      admin: makeAdmin(baseSeed({
        booking_groups: [{ id: GROUP_ID, tenant_id: TENANT, name: "GIACOMONI", kind: "bus_exclusive", status: "cancelled", hotel_id: null }],
        booking_group_bus_reservations: [
          { id: "r1", tenant_id: TENANT, booking_group_id: GROUP_ID, bus_unit_id: BUS_ID, service_date: "2026-09-06", exclusive: true, reserved_pax: 38 },
        ],
      })),
      membership: { tenant_id: TENANT, role: "operator", suspended: false },
      user: { id: "u1", email: "op@example.com" },
    } as unknown as PricingAuthContext;

    const result = await loadBusNetwork(auth);
    expect(result.booking_group_reservations).toEqual([]);
  });

  it("due gruppi (reale + orfano) con reservation su bus/date diverse -> entrambe esposte distintamente, mai mescolate", async () => {
    const auth = {
      admin: makeAdmin(baseSeed({
        booking_groups: [
          { id: GROUP_ID, tenant_id: TENANT, name: "GIACOMONI", kind: "bus_exclusive", status: "to_complete", hotel_id: null },
          { id: ORPHAN_ID, tenant_id: TENANT, name: "GRUPPO GIACOMONI", kind: "bus_exclusive", status: "operational", hotel_id: null },
        ],
        booking_group_bus_reservations: [
          { id: "r-real", tenant_id: TENANT, booking_group_id: GROUP_ID, bus_unit_id: BUS_ID, service_date: "2026-09-13", exclusive: true, reserved_pax: 38 },
          { id: "r-orphan", tenant_id: TENANT, booking_group_id: ORPHAN_ID, bus_unit_id: BUS_ID, service_date: "2026-09-06", exclusive: true, reserved_pax: 38 },
        ],
      })),
      membership: { tenant_id: TENANT, role: "operator", suspended: false },
      user: { id: "u1", email: "op@example.com" },
    } as unknown as PricingAuthContext;

    const result = await loadBusNetwork(auth);
    const byDate = new Map((result.booking_group_reservations ?? []).map((r: Record<string, unknown>) => [r.service_date, r.booking_group_name]));
    expect(byDate.get("2026-09-06")).toBe("GRUPPO GIACOMONI");
    expect(byDate.get("2026-09-13")).toBe("GIACOMONI");
  });

  it("nessuna reservation -> array vuoto, nessun errore", async () => {
    const auth = {
      admin: makeAdmin(baseSeed()),
      membership: { tenant_id: TENANT, role: "operator", suspended: false },
      user: { id: "u1", email: "op@example.com" },
    } as unknown as PricingAuthContext;
    const result = await loadBusNetwork(auth);
    expect(result.booking_group_reservations).toEqual([]);
  });
});
