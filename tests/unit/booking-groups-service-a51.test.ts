import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * FASE A.5.1 — chiusura limiti residui A.5:
 *  - idempotenza stop/service (comando ripetuto, resume);
 *  - inspectOperationalBusGroupState (reconciliation DB, fonte di verità);
 *  - findAvailableBusesForGroup (disponibilità mezzi, capacità);
 *  - allocateReservedBookingGroupBusService (bus_exclusive: allocazione sul
 *    mezzo predeterminato dalla reservation, mai su un bus condiviso).
 */

const mocks = vi.hoisted(() => ({ autoAllocateBusService: vi.fn() }));
vi.mock("@/lib/server/bus-auto-allocation", () => ({ autoAllocateBusService: mocks.autoAllocateBusService }));

import {
  addBookingGroupStop,
  addBookingGroupPassengers,
  operationalizeBookingGroup,
  inspectOperationalBusGroupState,
  findAvailableBusesForGroup,
  allocateReservedBookingGroupBusService,
} from "@/lib/server/booking-groups-service";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GROUP_ID = "11111111-1111-4111-8111-111111111111";
const STOP_ID = "44444444-4444-4444-8444-444444444444";
const CANONICAL_STOP_ID = "55555555-5555-4555-8555-555555555555";
const BUS_UNIT_ID = "66666666-6666-4666-8666-666666666666";

type Row = Record<string, unknown>;

function makeAdmin(seed: Record<string, Row[]> = {}, rpcImpl?: (fn: string, params: Row) => { data: unknown; error: unknown }) {
  const writes = {
    inserts: [] as Array<{ table: string; row: Row }>,
    updates: [] as Array<{ table: string; filters: Row; payload: Row }>,
  };
  let seq = 0;

  function builder(table: string) {
    const filters: Row = {};
    const inFilters: Array<{ col: string; vals: unknown[] }> = [];
    let pending: { kind: "insert" | "update"; payload?: Row } | null = null;

    const rowsForFilters = () =>
      (seed[table] ?? []).filter(
        (r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v) &&
          inFilters.every(({ col, vals }) => vals.includes(r[col])),
      );

    const finish = () => {
      if (pending?.kind === "insert") {
        const row = { id: `${table}-${++seq}`, ...(pending.payload ?? {}) };
        writes.inserts.push({ table, row });
        return { data: row, error: null };
      }
      if (pending?.kind === "update") {
        writes.updates.push({ table, filters: { ...filters }, payload: pending.payload ?? {} });
        const base = rowsForFilters()[0] ?? { id: filters.id };
        return { data: { ...base, ...(pending.payload ?? {}) }, error: null };
      }
      return { data: null, error: null };
    };

    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.eq = (col: string, val: unknown) => { filters[col] = val; return b; };
    b.in = (col: string, vals: unknown[]) => { inFilters.push({ col, vals }); return b; };
    b.maybeSingle = async () => (pending ? finish() : { data: rowsForFilters()[0] ?? null, error: null });
    b.single = async () => (pending ? finish() : { data: rowsForFilters()[0] ?? null, error: null });
    b.insert = (payload: Row) => { pending = { kind: "insert", payload }; return b; };
    b.update = (payload: Row) => { pending = { kind: "update", payload }; return b; };
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      if (pending) return Promise.resolve(finish()).then(resolve, reject);
      return Promise.resolve({ data: rowsForFilters(), error: null }).then(resolve, reject);
    };
    return b;
  }

  return {
    admin: {
      from: (t: string) => builder(t),
      rpc: async (fn: string, params: Row) => (rpcImpl ? rpcImpl(fn, params) : { data: null, error: null }),
    } as never,
    writes,
  };
}

const actor = { tenantId: TENANT, userId: "u1", role: "operator" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.autoAllocateBusService.mockResolvedValue({ ok: true, allocated: true, serviceId: "svc", busUnitId: "bus", busLabel: "Bus 1", stopId: "stop", stopName: "Rimini", pax: 50 });
});

describe("addBookingGroupStop — idempotenza (§2)", () => {
  it("stessa città+direzione sullo stesso gruppo → riusa lo stop esistente, nessun secondo insert", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [{ id: GROUP_ID, tenant_id: TENANT }],
      booking_group_stops: [{ id: STOP_ID, tenant_id: TENANT, booking_group_id: GROUP_ID, city: "Rimini", direction: "arrival", stop_id: null, expected_pax: 50 }],
    });
    const res = await addBookingGroupStop(admin as never, actor, { bookingGroupId: GROUP_ID, city: "rimini", expected_pax: 50, direction: "arrival" });
    expect(res.ok).toBe(true);
    expect(res.ok && res.data.stop.id).toBe(STOP_ID);
    expect(writes.inserts.filter((w) => w.table === "booking_group_stops")).toHaveLength(0);
  });

  it("stop esistente senza stop_id canonico + ora risolvibile → update mirato, non un secondo insert", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [{ id: GROUP_ID, tenant_id: TENANT }],
      booking_group_stops: [{ id: STOP_ID, tenant_id: TENANT, booking_group_id: GROUP_ID, city: "Rimini", direction: "arrival", stop_id: null, expected_pax: 50 }],
      tenant_bus_line_stops: [{ id: CANONICAL_STOP_ID, tenant_id: TENANT, city: "Rimini", stop_name: "RIMINI", direction: "arrival", active: true, pickup_time: "05:10" }],
    });
    const res = await addBookingGroupStop(admin as never, actor, { bookingGroupId: GROUP_ID, city: "Rimini", expected_pax: 50, direction: "arrival" });
    expect(res.ok).toBe(true);
    expect(res.ok && (res.data.stop as Row).stop_id).toBe(CANONICAL_STOP_ID);
    const upd = writes.updates.filter((w) => w.table === "booking_group_stops");
    expect(upd).toHaveLength(1);
    expect(writes.inserts.filter((w) => w.table === "booking_group_stops")).toHaveLength(0);
  });

  it("città diversa → crea normalmente una nuova fermata (nessun falso positivo)", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [{ id: GROUP_ID, tenant_id: TENANT }],
      booking_group_stops: [{ id: STOP_ID, tenant_id: TENANT, booking_group_id: GROUP_ID, city: "Rimini", direction: "arrival", stop_id: null, expected_pax: 50 }],
    });
    const res = await addBookingGroupStop(admin as never, actor, { bookingGroupId: GROUP_ID, city: "Tivoli", expected_pax: 20, direction: "arrival" });
    expect(res.ok).toBe(true);
    expect(writes.inserts.filter((w) => w.table === "booking_group_stops")).toHaveLength(1);
  });
});

describe("addBookingGroupPassengers — idempotenza (§3)", () => {
  const GROUP = { id: GROUP_ID, tenant_id: TENANT, kind: "bus_exclusive", service_date: "2026-09-13" };
  const STOP = { id: STOP_ID, tenant_id: TENANT, booking_group_id: GROUP_ID, city: "Rimini", pickup_point: null, direction: "arrival", stop_id: null };

  it("stesso gruppo+fermata+data+direzione+nominativo → riusa il service esistente, nessun secondo insert", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP],
      booking_group_stops: [STOP],
      services: [{ id: "SVC-1", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: STOP_ID, date: "2026-09-13", direction: "arrival", customer_name: "Gruppo La Marra", pax: 50 }],
    });
    const res = await addBookingGroupPassengers(admin as never, actor, {
      bookingGroupId: GROUP_ID, bookingGroupStopId: STOP_ID, passengers: [{ customer_name: "Gruppo La Marra", pax: 50 }],
    });
    expect(res.ok).toBe(true);
    expect(res.data.created).toEqual([{ id: "SVC-1", customer_name: "Gruppo La Marra", pax: 50 }]);
    expect(writes.inserts.filter((w) => w.table === "services")).toHaveLength(0);
  });

  it("nominativo diverso → crea normalmente un nuovo service", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP],
      booking_group_stops: [STOP],
      services: [{ id: "SVC-1", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: STOP_ID, date: "2026-09-13", direction: "arrival", customer_name: "Gruppo La Marra", pax: 50 }],
    });
    const res = await addBookingGroupPassengers(admin as never, actor, {
      bookingGroupId: GROUP_ID, bookingGroupStopId: STOP_ID, passengers: [{ customer_name: "Rossi", pax: 4 }],
    });
    expect(res.ok).toBe(true);
    expect(writes.inserts.filter((w) => w.table === "services")).toHaveLength(1);
  });
});

describe("inspectOperationalBusGroupState — reconciliation DB (§20)", () => {
  it("gruppo inesistente → nextStep create_group", async () => {
    const { admin } = makeAdmin({});
    const state = await inspectOperationalBusGroupState(admin as never, TENANT, GROUP_ID);
    expect(state.groupExists).toBe(false);
    expect(state.nextStep).toBe("create_group");
  });

  it("gruppo senza fermate → add_outbound_stop", async () => {
    const { admin } = makeAdmin({ booking_groups: [{ id: GROUP_ID, tenant_id: TENANT, status: "draft", expected_pax: 50 }] });
    const state = await inspectOperationalBusGroupState(admin as never, TENANT, GROUP_ID);
    expect(state.nextStep).toBe("add_outbound_stop");
  });

  it("fermata andata senza service → add_outbound_service", async () => {
    const { admin } = makeAdmin({
      booking_groups: [{ id: GROUP_ID, tenant_id: TENANT, status: "draft", expected_pax: 50 }],
      booking_group_stops: [{ id: STOP_ID, tenant_id: TENANT, booking_group_id: GROUP_ID, direction: "arrival", expected_pax: 50 }],
    });
    const state = await inspectOperationalBusGroupState(admin as never, TENANT, GROUP_ID);
    expect(state.nextStep).toBe("add_outbound_service");
    expect(state.arrivalStopsMissingService).toHaveLength(1);
  });

  it("andata completa, expectReturn=true, nessuna fermata ritorno → add_return_stop", async () => {
    const { admin } = makeAdmin({
      booking_groups: [{ id: GROUP_ID, tenant_id: TENANT, status: "draft", expected_pax: 50 }],
      booking_group_stops: [{ id: STOP_ID, tenant_id: TENANT, booking_group_id: GROUP_ID, direction: "arrival", expected_pax: 50 }],
      services: [{ id: "SVC-1", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: STOP_ID, pax: 50, direction: "arrival" }],
    });
    const state = await inspectOperationalBusGroupState(admin as never, TENANT, GROUP_ID, { expectReturn: true, returnDate: "2026-09-20" });
    expect(state.nextStep).toBe("add_return_stop");
  });

  it("bus_exclusive, andata+ritorno completi, nessuna reservation → reserve_bus", async () => {
    const { admin } = makeAdmin({
      booking_groups: [{ id: GROUP_ID, tenant_id: TENANT, status: "draft", expected_pax: 50, kind: "bus_exclusive", service_date: "2026-09-13" }],
      booking_group_stops: [
        { id: "s-out", tenant_id: TENANT, booking_group_id: GROUP_ID, direction: "arrival", expected_pax: 50 },
        { id: "s-ret", tenant_id: TENANT, booking_group_id: GROUP_ID, direction: "departure", expected_pax: 50 },
      ],
      services: [
        { id: "SVC-OUT", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: "s-out", pax: 50, direction: "arrival" },
        { id: "SVC-RET", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: "s-ret", pax: 50, direction: "departure" },
      ],
    });
    const state = await inspectOperationalBusGroupState(admin as never, TENANT, GROUP_ID, { expectReturn: true, returnDate: "2026-09-20" });
    expect(state.nextStep).toBe("reserve_bus");
  });

  it("bus_exclusive con reservation SOLO andata, manca quella di ritorno → reserve_bus (§17)", async () => {
    const { admin } = makeAdmin({
      booking_groups: [{ id: GROUP_ID, tenant_id: TENANT, status: "draft", expected_pax: 50, kind: "bus_exclusive", service_date: "2026-09-13" }],
      booking_group_stops: [
        { id: "s-out", tenant_id: TENANT, booking_group_id: GROUP_ID, direction: "arrival", expected_pax: 50 },
        { id: "s-ret", tenant_id: TENANT, booking_group_id: GROUP_ID, direction: "departure", expected_pax: 50 },
      ],
      services: [
        { id: "SVC-OUT", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: "s-out", pax: 50, direction: "arrival" },
        { id: "SVC-RET", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: "s-ret", pax: 50, direction: "departure" },
      ],
      booking_group_bus_reservations: [{ id: "r1", tenant_id: TENANT, booking_group_id: GROUP_ID, bus_unit_id: BUS_UNIT_ID, service_date: "2026-09-13", reserved_pax: 50, exclusive: true }],
    });
    const state = await inspectOperationalBusGroupState(admin as never, TENANT, GROUP_ID, { expectReturn: true, returnDate: "2026-09-20" });
    expect(state.nextStep).toBe("reserve_bus");
  });

  it("bus_group (non exclusive), tutto pronto, readiness ready>0 → operationalize", async () => {
    const { admin } = makeAdmin({
      booking_groups: [{ id: GROUP_ID, tenant_id: TENANT, status: "draft", expected_pax: 50, kind: "bus_group", service_date: "2026-09-13" }],
      booking_group_stops: [{ id: STOP_ID, tenant_id: TENANT, booking_group_id: GROUP_ID, city: "Rimini", direction: "arrival", expected_pax: 50, stop_id: CANONICAL_STOP_ID, pickup_point: null }],
      services: [{ id: "SVC-1", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: STOP_ID, pax: 50, direction: "arrival", is_draft: true, status: "needs_review", customer_name: "Gruppo X", date: "2026-09-13", time: "05:10", bus_city_origin: "Rimini", booking_service_kind: "bus_city_hotel" }],
    });
    const state = await inspectOperationalBusGroupState(admin as never, TENANT, GROUP_ID);
    expect(state.nextStep).toBe("operationalize");
    expect(state.readiness?.services_ready).toBe(1);
  });
});

describe("findAvailableBusesForGroup — disponibilità mezzi (§13/§16)", () => {
  it("esclude bus con capacità insufficiente", async () => {
    const { admin } = makeAdmin({
      tenant_bus_units: [
        { id: "small", tenant_id: TENANT, label: "Small", capacity: 30, active: true, status: "open", manual_close: false, tag: null },
        { id: "big", tenant_id: TENANT, label: "Big", capacity: 54, active: true, status: "open", manual_close: false, tag: null },
      ],
      booking_group_bus_reservations: [],
    });
    const res = await findAvailableBusesForGroup(admin as never, TENANT, { serviceDate: "2026-09-13", requiredCapacity: 50 });
    expect(res.map((b) => b.id)).toEqual(["big"]);
  });

  it("esclude bus già riservato in esclusiva sulla stessa data", async () => {
    const { admin } = makeAdmin({
      tenant_bus_units: [{ id: "big", tenant_id: TENANT, label: "Big", capacity: 54, active: true, status: "open", manual_close: false, tag: "esclusivo" }],
      booking_group_bus_reservations: [{ bus_unit_id: "big", exclusive: true, tenant_id: TENANT, service_date: "2026-09-13" }],
    });
    const res = await findAvailableBusesForGroup(admin as never, TENANT, { serviceDate: "2026-09-13", requiredCapacity: 50 });
    expect(res).toHaveLength(0);
  });

  it("esclude bus chiusi", async () => {
    const { admin } = makeAdmin({
      tenant_bus_units: [{ id: "closed", tenant_id: TENANT, label: "Closed", capacity: 54, active: true, status: "closed", manual_close: false, tag: null }],
      booking_group_bus_reservations: [],
    });
    const res = await findAvailableBusesForGroup(admin as never, TENANT, { serviceDate: "2026-09-13", requiredCapacity: 50 });
    expect(res).toHaveLength(0);
  });
});

describe("allocateReservedBookingGroupBusService — mai su bus condiviso (§15/§16)", () => {
  it("alloca sul bus predeterminato via RPC allocate_bus_service", async () => {
    let rpcCall: Row | null = null;
    const { admin } = makeAdmin(
      {
        services: [{ id: "SVC-1", tenant_id: TENANT, date: "2026-09-13", direction: "arrival", pax: 50, bus_city_origin: "Rimini" }],
        tenant_bus_units: [{ id: BUS_UNIT_ID, tenant_id: TENANT, bus_line_id: "line-adriatica", label: "Bus Esclusivo", capacity: 54 }],
        tenant_bus_line_stops: [{ id: CANONICAL_STOP_ID, tenant_id: TENANT, city: "Rimini", stop_name: "RIMINI", direction: "arrival", active: true, pickup_time: "05:10" }],
        tenant_bus_allocations: [],
      },
      (fn, params) => {
        rpcCall = { fn, ...params };
        return { data: { id: "alloc-1" }, error: null };
      },
    );
    const res = await allocateReservedBookingGroupBusService(admin as never, { tenantId: TENANT, serviceId: "SVC-1", busUnitId: BUS_UNIT_ID, userId: "u1" });
    expect(res.allocated).toBe(true);
    expect(rpcCall).toMatchObject({ fn: "allocate_bus_service", p_bus_unit_id: BUS_UNIT_ID, p_bus_line_id: "line-adriatica", p_stop_id: CANONICAL_STOP_ID, p_pax_assigned: 50 });
  });

  it("capacità del bus riservato insufficiente → non alloca", async () => {
    const { admin } = makeAdmin({
      services: [{ id: "SVC-1", tenant_id: TENANT, date: "2026-09-13", direction: "arrival", pax: 60, bus_city_origin: "Rimini" }],
      tenant_bus_units: [{ id: BUS_UNIT_ID, tenant_id: TENANT, bus_line_id: "line-adriatica", label: "Bus 54", capacity: 54 }],
      tenant_bus_allocations: [],
    });
    const res = await allocateReservedBookingGroupBusService(admin as never, { tenantId: TENANT, serviceId: "SVC-1", busUnitId: BUS_UNIT_ID, userId: "u1" });
    expect(res.allocated).toBe(false);
    expect(!res.allocated && res.reason).toMatch(/[Cc]apacità/);
  });

  it("città non risolvibile → non alloca (mai un fallback su Linea Italia)", async () => {
    const { admin } = makeAdmin({
      services: [{ id: "SVC-1", tenant_id: TENANT, date: "2026-09-13", direction: "arrival", pax: 50, bus_city_origin: "Città Inventata" }],
      tenant_bus_units: [{ id: BUS_UNIT_ID, tenant_id: TENANT, bus_line_id: "line-adriatica", label: "Bus 54", capacity: 54 }],
      tenant_bus_line_stops: [],
      tenant_bus_allocations: [],
    });
    const res = await allocateReservedBookingGroupBusService(admin as never, { tenantId: TENANT, serviceId: "SVC-1", busUnitId: BUS_UNIT_ID, userId: "u1" });
    expect(res.allocated).toBe(false);
    expect(!res.allocated && res.reason).toMatch(/[Ff]ermata non risolta/);
  });

  it("già allocato → no-op idempotente (§4)", async () => {
    const { admin } = makeAdmin({
      services: [{ id: "SVC-1", tenant_id: TENANT, date: "2026-09-13", direction: "arrival", pax: 50, bus_city_origin: "Rimini" }],
      tenant_bus_units: [{ id: BUS_UNIT_ID, tenant_id: TENANT, bus_line_id: "line-adriatica", label: "Bus 54", capacity: 54 }],
      tenant_bus_allocations: [{ id: "alloc-existing", tenant_id: TENANT, service_id: "SVC-1", bus_unit_id: BUS_UNIT_ID }],
    });
    const res = await allocateReservedBookingGroupBusService(admin as never, { tenantId: TENANT, serviceId: "SVC-1", busUnitId: BUS_UNIT_ID, userId: "u1" });
    expect(res.allocated).toBe(false);
    expect(!res.allocated && res.reason).toMatch(/gi.\s*allocato/i);
  });
});

describe("operationalizeBookingGroup — bus_exclusive CON reservation alloca sul mezzo dedicato (§15)", () => {
  it("reservation esclusiva presente per la data del service → alloca via RPC, nessun allocation_pending", async () => {
    const GROUP = { id: GROUP_ID, tenant_id: TENANT, kind: "bus_exclusive", service_date: "2026-09-13", expected_pax: 50, status: "passengers_defined", outbound_ferry_company: "x", outbound_ferry_time: "x", return_ferry_company: "x", return_ferry_time: "x" };
    const STOP = { id: STOP_ID, tenant_id: TENANT, booking_group_id: GROUP_ID, city: "Rimini", pickup_point: null, stop_id: CANONICAL_STOP_ID, expected_pax: 50 };
    const svc = { id: "s1", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: STOP_ID, is_draft: true, status: "needs_review", pax: 50, customer_name: "Gruppo La Marra", date: "2026-09-13", time: "05:10", direction: "arrival", bus_city_origin: "Rimini", meeting_point: null, hotel_id: null, booking_service_kind: "bus_city_hotel" };
    let rpcCalled = false;
    const { admin } = makeAdmin(
      {
        booking_groups: [GROUP], booking_group_stops: [STOP],
        services: [svc],
        booking_group_bus_reservations: [{ id: "r1", tenant_id: TENANT, booking_group_id: GROUP_ID, bus_unit_id: BUS_UNIT_ID, service_date: "2026-09-13", reserved_pax: 50, exclusive: true }],
        tenant_bus_units: [{ id: BUS_UNIT_ID, tenant_id: TENANT, bus_line_id: "line-adriatica", label: "Bus Esclusivo", capacity: 54 }],
        tenant_bus_line_stops: [{ id: CANONICAL_STOP_ID, tenant_id: TENANT, city: "Rimini", stop_name: "RIMINI", direction: "arrival", active: true, pickup_time: "05:10" }],
        tenant_bus_allocations: [],
      },
      (fn) => { rpcCalled = fn === "allocate_bus_service"; return { data: { id: "alloc-1" }, error: null }; },
    );
    const res = await operationalizeBookingGroup(admin as never, actor, { bookingGroupId: GROUP_ID });
    expect(mocks.autoAllocateBusService).not.toHaveBeenCalled();
    expect(rpcCalled).toBe(true);
    const opWarnings = res.data && "operationalized" in res.data ? res.data.operationalized[0]?.warnings ?? [] : [];
    expect(opWarnings).not.toContain("allocation_pending");
  });
});
