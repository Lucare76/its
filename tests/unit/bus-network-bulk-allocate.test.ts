import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Fix C — assegnazione a blocco per fermata di un gruppo bus_exclusive.
 * Verifica l'azione POST "allocate_services_bulk" su
 * app/api/ops/bus-network/route.ts: riusa la stessa validazione/RPC del
 * percorso singolo (allocate_bus_service) in un loop, con report parziale
 * se qualche service fallisce.
 */

const mocks = vi.hoisted(() => ({ authorizePricingRequest: vi.fn() }));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorizePricingRequest }));

import { POST } from "@/app/api/ops/bus-network/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LINE_ID = "22222222-2222-4222-8222-222222222222";
const UNIT_ID = "33333333-3333-4333-8333-333333333333";
const STOP_ID = "44444444-4444-4444-8444-444444444444";
const SVC_1 = "55555555-5555-4555-8555-555555555555";
const SVC_2 = "66666666-6666-4666-8666-666666666666";
const GROUP_ID = "77777777-7777-4777-8777-777777777777";
const GROUP_STOP_ID = "88888888-8888-4888-8888-888888888888";

type Row = Record<string, unknown>;

function makeAdmin(seed: Record<string, Row[]>) {
  const writes = {
    updates: [] as Array<{ table: string; filters: Row; payload: Row }>,
    rpcCalls: [] as Array<{ name: string; params: Row }>,
  };

  function builder(table: string) {
    const filters: Row = {};
    let pending: { kind: "update"; payload: Row } | null = null;
    const rowsForFilters = () => (seed[table] ?? []).filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
    const finish = () => {
      if (pending?.kind === "update") {
        writes.updates.push({ table, filters: { ...filters }, payload: pending.payload });
        return { data: { ...Object.fromEntries(Object.entries(filters)), ...pending.payload }, error: null };
      }
      return { data: null, error: null };
    };
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.in = () => b;
    b.or = () => b;
    b.eq = (col: string, val: unknown) => { filters[col] = val; return b; };
    b.update = (payload: Row) => { pending = { kind: "update", payload }; return b; };
    b.maybeSingle = async () => (pending ? finish() : { data: rowsForFilters()[0] ?? null, error: null });
    b.single = async () => (pending ? finish() : { data: rowsForFilters()[0] ?? null, error: null });
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(pending ? finish() : { data: rowsForFilters(), error: null }).then(resolve, reject);
    return b;
  }

  const failingRpcServiceIds = new Set<string>();
  const admin = {
    from: (t: string) => builder(t),
    rpc: async (name: string, params: Row) => {
      writes.rpcCalls.push({ name, params });
      if (name !== "allocate_bus_service") return { data: null, error: { message: `RPC ${name} non gestita nel fake test` } };
      if (failingRpcServiceIds.has(String(params.p_service_id))) {
        return { data: null, error: { message: "Allocazione fallita (fake)." } };
      }
      return { data: null, error: null };
    },
    __failNext: (serviceId: string) => failingRpcServiceIds.add(serviceId),
  };
  return { admin, writes };
}

function authCtx(admin: unknown, role = "operator") {
  return { admin, user: { id: "u1", email: "op@test.it" }, membership: { tenant_id: TENANT, role, suspended: false } };
}

function post(body: unknown) {
  return new NextRequest("http://localhost/api/ops/bus-network", { method: "POST", body: JSON.stringify(body) });
}

function baseSeed(overrides: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  return {
    tenant_bus_lines: [{ id: LINE_ID, tenant_id: TENANT, code: "GRUPPI_ESCLUSIVI", name: "Gruppi Esclusivi", family_code: "GRUPPI_ESCLUSIVI", family_name: "Gruppi Esclusivi", active: true }],
    tenant_bus_units: [{ id: UNIT_ID, tenant_id: TENANT, bus_line_id: LINE_ID, label: "Bus 1", capacity: 54, low_seat_threshold: 5, status: "open" }],
    tenant_bus_line_stops: [{ id: STOP_ID, tenant_id: TENANT, bus_line_id: LINE_ID, direction: "arrival", stop_name: "Cattolica", city: "Cattolica", active: true }],
    tenant_bus_allocations: [],
    ops_bus_allocation_details: [],
    tenant_bus_allocation_moves: [],
    hotels: [],
    bus_import_pending: [],
    bus_unit_driver_dates: [],
    bus_ischia_dist_buses: [],
    bus_ischia_dist_allocations: [],
    vehicles: [],
    driver_profiles: [],
    bus_line_ferry_config: [],
    booking_group_stops: [{ id: GROUP_STOP_ID, tenant_id: TENANT, booking_group_id: GROUP_ID, city: "Cattolica", direction: "arrival" }],
    booking_groups: [{ id: GROUP_ID, tenant_id: TENANT, name: "Gruppo GIACOMONI", kind: "bus_exclusive", status: "passengers_defined" }],
    services: [
      { id: SVC_1, tenant_id: TENANT, customer_name: "Muratori Sandra", direction: "arrival", booking_service_kind: "bus_city_hotel", booking_group_id: GROUP_ID, booking_group_stop_id: GROUP_STOP_ID, date: "2026-09-13", time: "05:10", pax: 1, hotel_id: null },
      { id: SVC_2, tenant_id: TENANT, customer_name: "Onori Valdes", direction: "arrival", booking_service_kind: "bus_city_hotel", booking_group_id: GROUP_ID, booking_group_stop_id: GROUP_STOP_ID, date: "2026-09-13", time: "05:10", pax: 1, hotel_id: null },
    ],
    ...overrides,
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("POST allocate_services_bulk — assegnazione a blocco fermata gruppo (Fix C)", () => {
  it("assegna tutti i services della fermata in un'unica chiamata, nessun click uno per uno", async () => {
    const { admin, writes } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({
      action: "allocate_services_bulk",
      services: [{ service_id: SVC_1, pax_assigned: 1 }, { service_id: SVC_2, pax_assigned: 1 }],
      bus_line_id: LINE_ID, bus_unit_id: UNIT_ID, direction: "arrival",
      stop_name: "Cattolica", stop_id: STOP_ID,
    }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.assigned_count).toBe(2);
    expect(json.partial_errors).toBeUndefined();
    const rpcCalls = writes.rpcCalls.filter((c) => c.name === "allocate_bus_service");
    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls.map((c) => c.params.p_service_id).sort()).toEqual([SVC_1, SVC_2].sort());
  });

  it("un service fallisce, l'altro va a buon fine: risposta ok con partial_errors", async () => {
    const { admin } = makeAdmin(baseSeed());
    (admin as unknown as { __failNext: (id: string) => void }).__failNext(SVC_2);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({
      action: "allocate_services_bulk",
      services: [{ service_id: SVC_1, pax_assigned: 1 }, { service_id: SVC_2, pax_assigned: 1 }],
      bus_line_id: LINE_ID, bus_unit_id: UNIT_ID, direction: "arrival",
      stop_name: "Cattolica", stop_id: STOP_ID,
    }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.assigned_count).toBe(1);
    expect(json.partial_errors).toHaveLength(1);
    expect(json.partial_errors[0].service_id).toBe(SVC_2);
  });

  it("tutti i services falliscono: 400, nessun successo mascherato", async () => {
    const { admin } = makeAdmin(baseSeed());
    (admin as unknown as { __failNext: (id: string) => void }).__failNext(SVC_1);
    (admin as unknown as { __failNext: (id: string) => void }).__failNext(SVC_2);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({
      action: "allocate_services_bulk",
      services: [{ service_id: SVC_1, pax_assigned: 1 }, { service_id: SVC_2, pax_assigned: 1 }],
      bus_line_id: LINE_ID, bus_unit_id: UNIT_ID, direction: "arrival",
      stop_name: "Cattolica", stop_id: STOP_ID,
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
  });

  it("bus con tag 'esclusivo' già pieno: rifiuta l'intera richiesta prima di iterare", async () => {
    const { admin, writes } = makeAdmin(baseSeed({
      tenant_bus_units: [{ id: UNIT_ID, tenant_id: TENANT, bus_line_id: LINE_ID, label: "Bus 1", capacity: 54, low_seat_threshold: 5, status: "open", tag: "esclusivo" }],
    }));
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({
      action: "allocate_services_bulk",
      services: [{ service_id: SVC_1, pax_assigned: 1 }],
      bus_line_id: LINE_ID, bus_unit_id: UNIT_ID, direction: "arrival",
      stop_name: "Cattolica", stop_id: STOP_ID,
    }));
    expect(res.status).toBe(400);
    expect(writes.rpcCalls).toHaveLength(0);
  });
});
