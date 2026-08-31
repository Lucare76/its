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
