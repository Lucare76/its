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

/**
 * FIX MIRATO — AUTO ASSEGNAZIONE BUS: PREFILTRO EXCLUSIVE + RETRY.
 *
 * L'azione "auto_assign_date" (bulk PARTENZE/ARRIVI da /bus-network) non deve
 * mai fermarsi al primo bus candidato che fallisce: deve escludere a monte i
 * bus con reservation exclusive=true per un booking_group diverso da quello
 * del service, e ritentare sul candidato successivo (in ordine sort_order)
 * se la RPC allocate_bus_service rifiuta comunque il bus scelto — mai uno
 * skip immediato al primo fallimento.
 *
 * Città "Rimini" / family_code "ADRIATICA": senza transport_code,
 * deriveServiceBusIdentity risolve la linea tramite il catalogo reale
 * (findNearestBusStop), che per "Rimini" restituisce la famiglia ADRIATICA —
 * stesso pattern già verificato in mario-exclusive-reservation-e2e.test.ts,
 * nessun mock del catalogo.
 */
describe("POST auto_assign_date — prefiltro exclusive + retry su bus successivo (FIX MIRATO)", () => {
  const AA_LINE_ID = "line-adriatica-aa";
  const AA_STOP_ID = "stop-rimini-aa";
  const AA_BUS_1 = "aa-bus-1";
  const AA_BUS_2 = "aa-bus-2";
  const AA_BUS_3 = "aa-bus-3";
  const AA_SVC_1 = "aa-svc-1";
  const AA_GROUP_ID = "aa-group-1";
  const AA_OTHER_GROUP_ID = "aa-group-2";

  function makeAutoAssignAdmin(seed: Record<string, Row[]>, opts: { failRpcForBusIds?: Set<string> } = {}) {
    const rpcCalls: Array<{ name: string; params: Row }> = [];
    function builder(table: string) {
      const filters: Row = {};
      const rowsForFilters = () => (seed[table] ?? []).filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.order = () => b;
      b.limit = () => b;
      b.in = () => b;
      b.or = () => b;
      b.eq = (col: string, val: unknown) => { filters[col] = val; return b; };
      b.maybeSingle = async () => ({ data: rowsForFilters()[0] ?? null, error: null });
      b.single = async () => ({ data: rowsForFilters()[0] ?? null, error: null });
      b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({ data: rowsForFilters(), error: null }).then(resolve, reject);
      return b;
    }
    const admin = {
      from: (t: string) => builder(t),
      rpc: async (name: string, params: Row) => {
        rpcCalls.push({ name, params });
        if (name !== "allocate_bus_service") return { data: null, error: { message: `RPC ${name} non gestita nel fake test` } };
        const busUnitId = String(params.p_bus_unit_id);
        if (opts.failRpcForBusIds?.has(busUnitId)) {
          return { data: null, error: { message: `Rifiutato (fake) per ${busUnitId}` } };
        }
        return { data: { allocation_id: `alloc-${busUnitId}` }, error: null };
      },
    };
    return { admin, rpcCalls };
  }

  function autoAssignSeed(overrides: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
    return {
      tenant_bus_lines: [{ id: AA_LINE_ID, tenant_id: TENANT, code: "ADRIATICA", name: "Adriatica", family_code: "ADRIATICA", active: true }],
      tenant_bus_line_stops: [{ id: AA_STOP_ID, tenant_id: TENANT, bus_line_id: AA_LINE_ID, direction: "departure", stop_name: "RIMINI", city: "Rimini", stop_order: 0, active: true }],
      tenant_bus_units: [
        { id: AA_BUS_1, tenant_id: TENANT, bus_line_id: AA_LINE_ID, label: "Bus 1", capacity: 54, status: "open", sort_order: 1, active: true },
        { id: AA_BUS_2, tenant_id: TENANT, bus_line_id: AA_LINE_ID, label: "Bus 2", capacity: 54, status: "open", sort_order: 2, active: true },
        { id: AA_BUS_3, tenant_id: TENANT, bus_line_id: AA_LINE_ID, label: "Bus 3", capacity: 54, status: "open", sort_order: 3, active: true },
      ],
      tenant_bus_allocations: [],
      booking_group_bus_reservations: [],
      services: [
        { id: AA_SVC_1, tenant_id: TENANT, customer_name: "Cliente Individuale", direction: "departure", booking_service_kind: "bus_city_hotel", booking_group_id: null, date: "2026-09-13", time: "18:00", pax: 1, bus_city_origin: "Rimini" },
      ],
      ...overrides,
    };
  }

  function autoAssign(admin: unknown, direction: "arrival" | "departure" = "departure") {
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    return POST(post({ action: "auto_assign_date", date: "2026-09-13", direction }));
  }

  it("1) bus 1 vuoto ma reserved exclusive per altro gruppo, bus 2 libero: servizio individuale assegnato a bus 2, non skipped", async () => {
    const { admin, rpcCalls } = makeAutoAssignAdmin(autoAssignSeed({
      booking_group_bus_reservations: [{ tenant_id: TENANT, bus_unit_id: AA_BUS_1, service_date: "2026-09-13", exclusive: true, booking_group_id: AA_OTHER_GROUP_ID }],
    }));
    const res = await autoAssign(admin);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.assigned).toBe(1);
    expect(json.skipped).toBe(0);
    const allocCalls = rpcCalls.filter((c) => c.name === "allocate_bus_service");
    expect(allocCalls.map((c) => c.params.p_bus_unit_id)).toEqual([AA_BUS_2]);
  });

  it("2) bus 1 fallisce la RPC, bus 2 riesce: servizio assegnato a bus 2", async () => {
    const { admin, rpcCalls } = makeAutoAssignAdmin(autoAssignSeed(), { failRpcForBusIds: new Set([AA_BUS_1]) });
    const res = await autoAssign(admin);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.assigned).toBe(1);
    expect(json.skipped).toBe(0);
    const allocCalls = rpcCalls.filter((c) => c.name === "allocate_bus_service");
    expect(allocCalls.map((c) => c.params.p_bus_unit_id)).toEqual([AA_BUS_1, AA_BUS_2]);
  });

  it("3) bus 1 e bus 2 falliscono la RPC, bus 3 riesce: servizio assegnato a bus 3", async () => {
    const { admin, rpcCalls } = makeAutoAssignAdmin(autoAssignSeed(), { failRpcForBusIds: new Set([AA_BUS_1, AA_BUS_2]) });
    const res = await autoAssign(admin);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.assigned).toBe(1);
    expect(json.skipped).toBe(0);
    const allocCalls = rpcCalls.filter((c) => c.name === "allocate_bus_service");
    expect(allocCalls.map((c) => c.params.p_bus_unit_id)).toEqual([AA_BUS_1, AA_BUS_2, AA_BUS_3]);
  });

  it("4) tutti i candidati falliscono: il servizio va in skipped con reason utile che elenca i tentativi", async () => {
    const { admin, rpcCalls } = makeAutoAssignAdmin(autoAssignSeed(), { failRpcForBusIds: new Set([AA_BUS_1, AA_BUS_2, AA_BUS_3]) });
    const res = await autoAssign(admin);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.assigned).toBe(0);
    expect(json.skipped).toBe(1);
    expect(json.skipped_detail[0].reason).toMatch(/Bus 1/);
    expect(json.skipped_detail[0].reason).toMatch(/Bus 2/);
    expect(json.skipped_detail[0].reason).toMatch(/Bus 3/);
    const allocCalls = rpcCalls.filter((c) => c.name === "allocate_bus_service");
    expect(allocCalls.map((c) => c.params.p_bus_unit_id)).toEqual([AA_BUS_1, AA_BUS_2, AA_BUS_3]);
  });

  it("5) bus riservato in esclusiva allo STESSO booking_group del service: non escluso, assegnazione consentita su bus 1", async () => {
    const { admin, rpcCalls } = makeAutoAssignAdmin(autoAssignSeed({
      services: [{ id: AA_SVC_1, tenant_id: TENANT, customer_name: "Gruppo Test", direction: "departure", booking_service_kind: "bus_city_hotel", booking_group_id: AA_GROUP_ID, date: "2026-09-13", time: "18:00", pax: 1, bus_city_origin: "Rimini" }],
      booking_group_bus_reservations: [{ tenant_id: TENANT, bus_unit_id: AA_BUS_1, service_date: "2026-09-13", exclusive: true, booking_group_id: AA_GROUP_ID }],
    }));
    const res = await autoAssign(admin);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.assigned).toBe(1);
    const allocCalls = rpcCalls.filter((c) => c.name === "allocate_bus_service");
    expect(allocCalls.map((c) => c.params.p_bus_unit_id)).toEqual([AA_BUS_1]);
  });

  it("6) servizio senza booking_group_id, bus riservato in esclusiva a un gruppo: escluso dai candidati", async () => {
    const { admin, rpcCalls } = makeAutoAssignAdmin(autoAssignSeed({
      booking_group_bus_reservations: [{ tenant_id: TENANT, bus_unit_id: AA_BUS_1, service_date: "2026-09-13", exclusive: true, booking_group_id: AA_OTHER_GROUP_ID }],
    }));
    const res = await autoAssign(admin);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.assigned).toBe(1);
    const allocCalls = rpcCalls.filter((c) => c.name === "allocate_bus_service");
    expect(allocCalls.some((c) => c.params.p_bus_unit_id === AA_BUS_1)).toBe(false);
  });

  it("7) direzione arrival: il retry non rompe l'assegnazione arrivi quando nessun bus e' bloccato", async () => {
    const { admin, rpcCalls } = makeAutoAssignAdmin(autoAssignSeed({
      tenant_bus_line_stops: [{ id: AA_STOP_ID, tenant_id: TENANT, bus_line_id: AA_LINE_ID, direction: "arrival", stop_name: "RIMINI", city: "Rimini", stop_order: 0, active: true }],
      services: [{ id: AA_SVC_1, tenant_id: TENANT, customer_name: "Cliente Individuale", direction: "arrival", booking_service_kind: "bus_city_hotel", booking_group_id: null, date: "2026-09-13", time: "05:10", pax: 1, bus_city_origin: "Rimini" }],
    }));
    const res = await autoAssign(admin, "arrival");
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.assigned).toBe(1);
    expect(json.skipped).toBe(0);
    const allocCalls = rpcCalls.filter((c) => c.name === "allocate_bus_service");
    expect(allocCalls).toHaveLength(1);
    expect(allocCalls[0]?.params.p_bus_unit_id).toBe(AA_BUS_1);
  });

  it("8) same stop: preferisce il bus gia' usato per la stessa fermata; se quel bus fallisce, ritenta sul successivo", async () => {
    const { admin, rpcCalls } = makeAutoAssignAdmin(autoAssignSeed({
      // Allocazione preesistente su bus 1 per la stessa fermata: pickBusCandidatesOrdered
      // lo sceglierebbe come "primary" per preferenza stessa-fermata.
      tenant_bus_allocations: [{ id: "prior-alloc", tenant_id: TENANT, service_id: "prior-svc", bus_unit_id: AA_BUS_1, bus_line_id: AA_LINE_ID, stop_id: AA_STOP_ID, stop_name: "RIMINI", direction: "departure", pax_assigned: 1 }],
    }), { failRpcForBusIds: new Set([AA_BUS_1]) });
    const res = await autoAssign(admin);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.assigned).toBe(1);
    expect(json.skipped).toBe(0);
    const allocCalls = rpcCalls.filter((c) => c.name === "allocate_bus_service");
    // primo tentativo sul bus preferito (stessa fermata) fallisce, poi ritenta sul successivo
    expect(allocCalls.map((c) => c.params.p_bus_unit_id)).toEqual([AA_BUS_1, AA_BUS_2]);
  });
});
