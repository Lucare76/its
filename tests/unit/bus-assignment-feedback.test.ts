import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * ML STEP 1 — raccolta feedback strutturato delle azioni di assegnazione bus.
 * Verifica che app/api/ops/bus-network/route.ts scriva una riga in
 * bus_assignment_feedback (via lib/server/bus-assignment-feedback.ts) per:
 * prima assegnazione manuale, prima assegnazione automatica, spostamento
 * stessa linea, spostamento cross-linea, cancellazione — senza cambiare il
 * comportamento esistente delle azioni stesse (stesso RPC, stessa risposta).
 */

const mocks = vi.hoisted(() => ({ authorizePricingRequest: vi.fn() }));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorizePricingRequest }));

import { POST } from "@/app/api/ops/bus-network/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "u-mario-1";
const LINE_ITALIA = "11111111-1111-4111-8111-111111111111";
const LINE_CENTRO = "22222222-2222-4222-8222-222222222222";
const UNIT_ITALIA = "33333333-3333-4333-8333-333333333333";
const UNIT_ITALIA_2 = "33333333-3333-4333-8333-333333333334";
const UNIT_CENTRO = "44444444-4444-4444-8444-444444444444";
const STOP_ITALIA = "55555555-5555-4555-8555-555555555555";
const SVC_1 = "66666666-6666-4666-8666-666666666666";
const ALLOC_1 = "77777777-7777-4777-8777-777777777777";

type Row = Record<string, unknown>;

function makeAdmin(seed: Record<string, Row[]>) {
  const writes = {
    inserts: [] as Array<{ table: string; payload: Row }>,
    rpcCalls: [] as Array<{ name: string; params: Row }>,
  };

  function builder(table: string) {
    const filters: Row = {};
    const inFilters: Array<{ col: string; vals: unknown[] }> = [];
    let pending: { kind: "insert"; payload: Row } | { kind: "delete" } | null = null;
    const rowsForFilters = () =>
      (seed[table] ?? []).filter(
        (r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v) &&
          inFilters.every(({ col, vals }) => vals.includes(r[col]))
      );
    const finish = () => {
      if (pending?.kind === "insert") {
        writes.inserts.push({ table, payload: pending.payload });
        return { data: pending.payload, error: null };
      }
      if (pending?.kind === "delete") {
        const toDelete = new Set(rowsForFilters());
        seed[table] = (seed[table] ?? []).filter((r) => !toDelete.has(r));
        return { data: null, error: null };
      }
      return { data: null, error: null };
    };
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.or = () => b;
    b.eq = (col: string, val: unknown) => { filters[col] = val; return b; };
    b.in = (col: string, vals: unknown[]) => { inFilters.push({ col, vals }); return b; };
    b.insert = (payload: Row) => { pending = { kind: "insert", payload }; return b; };
    b.delete = () => { pending = { kind: "delete" }; return b; };
    b.maybeSingle = async () => (pending ? finish() : { data: rowsForFilters()[0] ?? null, error: null });
    b.single = async () => (pending ? finish() : { data: rowsForFilters()[0] ?? null, error: null });
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(pending ? finish() : { data: rowsForFilters(), error: null }).then(resolve, reject);
    return b;
  }

  const admin = {
    from: (t: string) => builder(t),
    rpc: async (name: string, params: Row) => {
      writes.rpcCalls.push({ name, params });
      if (name === "allocate_bus_service" || name === "move_bus_allocation") {
        return { data: { allocation_id: ALLOC_1 }, error: null };
      }
      return { data: null, error: { message: `RPC ${name} non gestita nel fake test` } };
    },
  };
  return { admin, writes };
}

function authCtx(admin: unknown, role = "operator") {
  return { admin, user: { id: USER_ID, email: "op@test.it" }, membership: { tenant_id: TENANT, role, suspended: false } };
}

function post(body: unknown) {
  return new NextRequest("http://localhost/api/ops/bus-network", { method: "POST", body: JSON.stringify(body) });
}

function baseSeed(overrides: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  return {
    tenant_bus_lines: [
      { id: LINE_ITALIA, tenant_id: TENANT, code: "ITALIA", name: "Linea Italia", family_code: "ITALIA", family_name: "Italia", active: true },
      { id: LINE_CENTRO, tenant_id: TENANT, code: "CENTRO", name: "Linea Centro", family_code: "CENTRO", family_name: "Centro", active: true },
    ],
    tenant_bus_units: [
      { id: UNIT_ITALIA, tenant_id: TENANT, bus_line_id: LINE_ITALIA, label: "Bus Italia 1", capacity: 54, low_seat_threshold: 5, status: "open", active: true, sort_order: 1 },
      { id: UNIT_ITALIA_2, tenant_id: TENANT, bus_line_id: LINE_ITALIA, label: "Bus Italia 2", capacity: 54, low_seat_threshold: 5, status: "open", active: true, sort_order: 2 },
      { id: UNIT_CENTRO, tenant_id: TENANT, bus_line_id: LINE_CENTRO, label: "Bus Centro 1", capacity: 54, low_seat_threshold: 5, status: "open", active: true, sort_order: 1 },
    ],
    tenant_bus_line_stops: [
      { id: STOP_ITALIA, tenant_id: TENANT, bus_line_id: LINE_ITALIA, direction: "arrival", stop_name: "Roma", city: "Roma", active: true },
    ],
    tenant_bus_allocations: [],
    ops_bus_allocation_details: [],
    tenant_bus_allocation_moves: [],
    bus_assignment_feedback: [],
    hotels: [{ id: "hotel-1", tenant_id: TENANT, name: "Hotel Test", zone: "centro" }],
    bus_import_pending: [],
    bus_unit_driver_dates: [],
    bus_ischia_dist_buses: [],
    bus_ischia_dist_allocations: [],
    vehicles: [],
    driver_profiles: [],
    bus_line_ferry_config: [],
    booking_group_stops: [],
    booking_groups: [],
    services: [
      { id: SVC_1, tenant_id: TENANT, customer_name: "Rossi Mario", customer_first_name: null, customer_last_name: null, direction: "arrival", booking_service_kind: "bus_city_hotel", date: "2026-09-13", time: "05:10", pax: 2, hotel_id: "hotel-1", bus_city_origin: "Roma", transport_code: null },
    ],
    ...overrides,
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("ML STEP 1 — feedback su allocate_service (prima assegnazione manuale)", () => {
  it("scrive UNA riga bus_assignment_feedback: initial_allocation/manual, tenant_id e created_by_user_id valorizzati", async () => {
    const { admin, writes } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({
      action: "allocate_service",
      service_id: SVC_1, bus_line_id: LINE_ITALIA, bus_unit_id: UNIT_ITALIA,
      direction: "arrival", stop_name: "Roma", stop_id: STOP_ITALIA, pax_assigned: 2,
    }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);

    const feedbackWrites = writes.inserts.filter((w) => w.table === "bus_assignment_feedback");
    expect(feedbackWrites).toHaveLength(1); // #6 nessun doppio log nella stessa azione

    const row = feedbackWrites[0].payload;
    expect(row.action_type).toBe("initial_allocation");
    expect(row.source).toBe("manual");
    expect(row.tenant_id).toBe(TENANT); // #7
    expect(row.created_by_user_id).toBe(USER_ID); // #8
    expect(row.service_id).toBe(SVC_1);
    expect(row.new_bus_unit_id).toBe(UNIT_ITALIA);
    expect(row.new_bus_line_id).toBe(LINE_ITALIA);
    expect(row.final_family_code).toBe("ITALIA");
    expect(row.customer_name).toBe("Rossi Mario");
    expect(row.hotel_name).toBe("Hotel Test");
  });
});

describe("ML STEP 1 — feedback su auto_assign_date (prima assegnazione automatica)", () => {
  it("scrive feedback con source auto_assignment quando l'allocazione automatica riesce", async () => {
    const { admin, writes } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({ action: "auto_assign_date", date: "2026-09-13", direction: "arrival" }));
    const json = await res.json();

    expect(json.ok).toBe(true);
    expect(json.assigned).toBe(1);

    const feedbackWrites = writes.inserts.filter((w) => w.table === "bus_assignment_feedback");
    expect(feedbackWrites).toHaveLength(1);
    const row = feedbackWrites[0].payload;
    expect(row.action_type).toBe("initial_allocation");
    expect(row.source).toBe("auto_assignment");
    expect(row.tenant_id).toBe(TENANT);
    expect(row.service_id).toBe(SVC_1);
    expect(row.new_bus_line_id).toBe(LINE_ITALIA);
  });
});

describe("ML STEP 1 — feedback su move_allocation (stessa linea vs cross-linea)", () => {
  function seedWithExistingAllocation() {
    return baseSeed({
      tenant_bus_allocations: [
        { id: ALLOC_1, tenant_id: TENANT, service_id: SVC_1, bus_line_id: LINE_ITALIA, bus_unit_id: UNIT_ITALIA, stop_id: STOP_ITALIA, stop_name: "Roma", direction: "arrival", pax_assigned: 2 },
      ],
    });
  }

  it("spostamento stessa linea (Italia -> Italia): action_type=move, old/new bus_unit_id corretti", async () => {
    const { admin, writes } = makeAdmin(seedWithExistingAllocation());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({
      action: "move_allocation", allocation_id: ALLOC_1, to_bus_unit_id: UNIT_ITALIA_2, pax_moved: 2,
    }));
    expect((await res.json()).ok).toBe(true);

    const feedbackWrites = writes.inserts.filter((w) => w.table === "bus_assignment_feedback");
    expect(feedbackWrites).toHaveLength(1); // #6
    const row = feedbackWrites[0].payload;
    expect(row.action_type).toBe("move");
    expect(row.old_bus_unit_id).toBe(UNIT_ITALIA); // #3
    expect(row.new_bus_unit_id).toBe(UNIT_ITALIA_2); // #3
    expect(row.old_bus_line_id).toBe(LINE_ITALIA);
    expect(row.new_bus_line_id).toBe(LINE_ITALIA);
    expect(row.tenant_id).toBe(TENANT);
    expect(row.created_by_user_id).toBe(USER_ID);
  });

  it("spostamento cross-linea (Italia -> Centro): action_type=cross_line_move, old/new bus_line_id diversi", async () => {
    const { admin, writes } = makeAdmin(seedWithExistingAllocation());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({
      action: "move_allocation", allocation_id: ALLOC_1, to_bus_unit_id: UNIT_CENTRO, pax_moved: 2,
    }));
    expect((await res.json()).ok).toBe(true);

    const feedbackWrites = writes.inserts.filter((w) => w.table === "bus_assignment_feedback");
    expect(feedbackWrites).toHaveLength(1); // #6
    const row = feedbackWrites[0].payload;
    expect(row.action_type).toBe("cross_line_move"); // #4
    expect(row.old_bus_line_id).toBe(LINE_ITALIA); // #4
    expect(row.new_bus_line_id).toBe(LINE_CENTRO); // #4
    expect(row.old_bus_unit_id).toBe(UNIT_ITALIA);
    expect(row.new_bus_unit_id).toBe(UNIT_CENTRO);
    expect(row.final_family_code).toBe("CENTRO");
  });
});

describe("ML STEP 1 — feedback su delete_allocation (cancellazione)", () => {
  it("scrive feedback delete_allocation con lo stato precedente (old_bus_unit_id/old_bus_line_id)", async () => {
    const { admin, writes } = makeAdmin(baseSeed({
      tenant_bus_allocations: [
        { id: ALLOC_1, tenant_id: TENANT, service_id: SVC_1, bus_line_id: LINE_ITALIA, bus_unit_id: UNIT_ITALIA, stop_id: STOP_ITALIA, stop_name: "Roma", direction: "arrival", pax_assigned: 2 },
      ],
    }));
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({ action: "delete_allocation", allocation_id: ALLOC_1 }));
    const json = await res.json();
    expect(json.ok).toBe(true);

    const feedbackWrites = writes.inserts.filter((w) => w.table === "bus_assignment_feedback");
    expect(feedbackWrites).toHaveLength(1); // #5, #6
    const row = feedbackWrites[0].payload;
    expect(row.action_type).toBe("delete_allocation");
    expect(row.source).toBe("manual");
    expect(row.old_bus_unit_id).toBe(UNIT_ITALIA);
    expect(row.old_bus_line_id).toBe(LINE_ITALIA);
    expect(row.new_bus_unit_id).toBeNull();
    expect(row.tenant_id).toBe(TENANT);
    expect(row.created_by_user_id).toBe(USER_ID);
  });
});
