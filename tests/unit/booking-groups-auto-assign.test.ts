import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Obiettivo A del prompt "bus-network zero click": copertura per
 * `autoAssignBookingGroup` (lib/server/booking-groups-service.ts), assente
 * fino a questa sessione. Riproduce in particolare il bug osservato su
 * GIACOMONI (6-13 settembre): un gruppo bus_exclusive con SOLE fermate di
 * andata non deve mai generare/richiedere una reservation sulla
 * return_date del gruppo.
 */

const mocks = vi.hoisted(() => ({ autoAllocateBusService: vi.fn() }));
vi.mock("@/lib/server/bus-auto-allocation", () => ({ autoAllocateBusService: mocks.autoAllocateBusService }));

import { autoAssignBookingGroup, addBookingGroupPassengers, patchBookingGroup, generateReturnStopsFromArrival, linkOrphanReservationToGroup, removeOrphanReservationForGroup } from "@/lib/server/booking-groups-service";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GROUP_ID = "11111111-1111-4111-8111-111111111111";
const BUS_A = "22222222-2222-4222-8222-222222222222";
const BUS_B = "33333333-3333-4333-8333-333333333333";
const LINE_ESCLUSIVI = "44444444-4444-4444-8444-444444444444";

type Row = Record<string, unknown>;

function makeAdmin(seed: Record<string, Row[]> = {}) {
  const writes = {
    inserts: [] as Array<{ table: string; row: Row }>,
    updates: [] as Array<{ table: string; filters: Row; payload: Row }>,
    upserts: [] as Array<{ table: string; row: Row }>,
    deletes: [] as Array<{ table: string; filters: Row }>,
    rpcs: [] as Array<{ name: string; args: Row }>,
  };
  let seq = 0;

  function builder(table: string) {
    const filters: Row = {};
    let pending: { kind: "insert" | "update" | "upsert" | "delete"; payload?: Row } | null = null;

    const inFilters: Record<string, unknown[]> = {};
    const neqFilters: Record<string, unknown> = {};
    const rowsForFilters = () => (seed[table] ?? [])
      .filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v))
      .filter((r) => Object.entries(inFilters).every(([k, values]) => values.includes(r[k])))
      .filter((r) => Object.entries(neqFilters).every(([k, v]) => r[k] !== v));

    const finish = () => {
      if (pending?.kind === "insert") {
        const row = { id: `${table}-${++seq}`, ...(pending.payload ?? {}) };
        writes.inserts.push({ table, row });
        (seed[table] ??= []).push(row);
        return { data: row, error: null };
      }
      if (pending?.kind === "upsert") {
        const row = { id: `${table}-${++seq}`, ...(pending.payload ?? {}) };
        writes.upserts.push({ table, row });
        (seed[table] ??= []).push(row);
        return { data: row, error: null };
      }
      if (pending?.kind === "update") {
        writes.updates.push({ table, filters: { ...filters }, payload: pending.payload ?? {} });
        // Persiste la mutazione nel seed (come una vera UPDATE) cosi' una
        // successiva lettura nello stesso test vede i dati aggiornati —
        // necessario perche' autoAssignBookingGroup ri-legge booking_groups
        // subito dopo che patchBookingGroup lo ha aggiornato.
        for (const row of seed[table] ?? []) {
          if (Object.entries(filters).every(([k, v]) => row[k] === v)) {
            Object.assign(row, pending.payload ?? {});
          }
        }
        return { data: { id: filters.id, ...(pending.payload ?? {}) }, error: null };
      }
      if (pending?.kind === "delete") {
        writes.deletes.push({ table, filters: { ...filters } });
        const existing = seed[table] ?? [];
        seed[table] = existing.filter((row) => !Object.entries(filters).every(([k, v]) => row[k] === v));
        return { data: null, error: null };
      }
      return { data: null, error: null };
    };

    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.eq = (col: string, val: unknown) => { filters[col] = val; return b; };
    b.in = (col: string, values: unknown[]) => { inFilters[col] = values; return b; };
    b.neq = (col: string, val: unknown) => { neqFilters[col] = val; return b; };
    b.maybeSingle = async () => (pending ? finish() : { data: rowsForFilters()[0] ?? null, error: null });
    b.single = async () => (pending ? finish() : { data: rowsForFilters()[0] ?? null, error: null });
    b.insert = (payload: Row) => { pending = { kind: "insert", payload }; return b; };
    b.update = (payload: Row) => { pending = { kind: "update", payload }; return b; };
    b.upsert = (payload: Row) => { pending = { kind: "upsert", payload }; return b; };
    b.delete = () => { pending = { kind: "delete" }; return b; };
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      if (pending) return Promise.resolve(finish()).then(resolve, reject);
      const rows = rowsForFilters();
      return Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject);
    };
    return b;
  }

  const rpc = async (name: string, args: Row) => {
    writes.rpcs.push({ name, args });
    if (name === "allocate_bus_service") {
      return { data: { allocation_id: `alloc-${writes.rpcs.length}` }, error: null };
    }
    return { data: null, error: { message: `RPC ${name} non gestita nel fake test` } };
  };

  return { admin: { from: (t: string) => builder(t), rpc } as never, writes };
}

const actor = { tenantId: TENANT, userId: "u1", role: "operator" };

const GROUP = {
  id: GROUP_ID,
  tenant_id: TENANT,
  kind: "bus_exclusive",
  status: "to_complete",
  service_date: "2026-09-06",
  return_date: "2026-09-13",
  expected_pax: 38,
};

const ARRIVAL_ONLY_STOPS = [
  { id: "s1", tenant_id: TENANT, booking_group_id: GROUP_ID, direction: "arrival" },
  { id: "s2", tenant_id: TENANT, booking_group_id: GROUP_ID, direction: "arrival" },
];

const EXCLUSIVE_LINE = { id: LINE_ESCLUSIVI, tenant_id: TENANT, code: "GRUPPI_ESCLUSIVI", family_code: "GRUPPI_ESCLUSIVI", active: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.autoAllocateBusService.mockResolvedValue({ ok: true, allocated: false, serviceId: "x", reason: "n/a" });
});

describe("autoAssignBookingGroup — regressione GIACOMONI (solo fermate andata, mai reservation sul return_date)", () => {
  it("gruppo con sole fermate arrival e un solo bus esclusivo compatibile → riserva SOLO service_date", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP],
      booking_group_stops: ARRIVAL_ONLY_STOPS,
      booking_group_bus_reservations: [],
      tenant_bus_units: [
        { id: BUS_A, tenant_id: TENANT, bus_line_id: LINE_ESCLUSIVI, label: "GRUPPO EX 3", capacity: 54, tag: "esclusivo", status: "open", manual_close: false, active: true },
      ],
      tenant_bus_lines: [EXCLUSIVE_LINE],
    });

    const result = await autoAssignBookingGroup(admin as never, actor, GROUP_ID);

    expect(result.attempted).toBe(true);
    expect(result.reservations_created).toEqual([{ service_date: "2026-09-06", bus_unit_id: BUS_A, bus_label: "GRUPPO EX 3" }]);
    expect(result.blocked).toEqual([]);
    // Mai una reservation creata sulla return_date (13-09): il gruppo non ha
    // fermate di ritorno, quindi quella data non deve mai essere richiesta.
    const reservationDates = writes.upserts.filter((w) => w.table === "booking_group_bus_reservations").map((w) => w.row.service_date);
    expect(reservationDates).toEqual(["2026-09-06"]);
    expect(reservationDates).not.toContain("2026-09-13");
  });

  it("nessun bus esclusivo con capienza libera → bloccato con motivo esplicito, nessuna reservation creata", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP],
      booking_group_stops: ARRIVAL_ONLY_STOPS,
      booking_group_bus_reservations: [],
      tenant_bus_units: [
        { id: BUS_A, tenant_id: TENANT, bus_line_id: LINE_ESCLUSIVI, label: "GRUPPO EX 3", capacity: 20, tag: "esclusivo", status: "open", manual_close: false, active: true },
      ],
      tenant_bus_lines: [EXCLUSIVE_LINE],
    });

    const result = await autoAssignBookingGroup(admin as never, actor, GROUP_ID);

    expect(result.reservations_created).toEqual([]);
    expect(result.blocked).toEqual([{ service_date: "2026-09-06", reason: "Nessun bus esclusivo con capienza sufficiente per quella data." }]);
    expect(writes.upserts.filter((w) => w.table === "booking_group_bus_reservations")).toHaveLength(0);
  });

  it("bus già riservato da un ALTRO gruppo per la stessa data → escluso dai candidati, bloccato con motivo che nomina il gruppo (Obiettivo D)", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP, { id: "other-group", tenant_id: TENANT, name: "GRUPPO GIACOMONI" }],
      booking_group_stops: ARRIVAL_ONLY_STOPS,
      booking_group_bus_reservations: [
        { id: "r-other", tenant_id: TENANT, booking_group_id: "other-group", bus_unit_id: BUS_A, service_date: "2026-09-06", exclusive: true, reserved_pax: 38 },
      ],
      tenant_bus_units: [
        { id: BUS_A, tenant_id: TENANT, bus_line_id: LINE_ESCLUSIVI, label: "GRUPPO EX 3", capacity: 54, tag: "esclusivo", status: "open", manual_close: false, active: true },
      ],
      tenant_bus_lines: [EXCLUSIVE_LINE],
    });

    const result = await autoAssignBookingGroup(admin as never, actor, GROUP_ID);

    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].service_date).toBe("2026-09-06");
    expect(result.blocked[0].reason).toMatch(/GRUPPO EX 3/);
    expect(result.blocked[0].reason).toMatch(/GRUPPO GIACOMONI/);
    expect(writes.upserts.filter((w) => w.table === "booking_group_bus_reservations")).toHaveLength(0);
  });

  it("2 bus esclusivi ugualmente compatibili e liberi → sceglie automaticamente il primo in ordine deterministico (Obiettivo A), nessun blocco", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP],
      booking_group_stops: ARRIVAL_ONLY_STOPS,
      booking_group_bus_reservations: [],
      tenant_bus_units: [
        { id: BUS_A, tenant_id: TENANT, bus_line_id: LINE_ESCLUSIVI, label: "GRUPPO EX 3", capacity: 54, tag: "esclusivo", status: "open", manual_close: false, active: true, sort_order: 3 },
        { id: BUS_B, tenant_id: TENANT, bus_line_id: LINE_ESCLUSIVI, label: "GRUPPO EX 4", capacity: 54, tag: "esclusivo", status: "open", manual_close: false, active: true, sort_order: 4 },
      ],
      tenant_bus_lines: [EXCLUSIVE_LINE],
    });

    const result = await autoAssignBookingGroup(admin as never, actor, GROUP_ID);

    expect(result.blocked).toEqual([]);
    expect(result.reservations_created).toEqual([{ service_date: "2026-09-06", bus_unit_id: BUS_A, bus_label: "GRUPPO EX 3" }]);
    const reservations = writes.upserts.filter((w) => w.table === "booking_group_bus_reservations");
    expect(reservations).toHaveLength(1);
    expect(reservations[0].row.bus_unit_id).toBe(BUS_A);
    expect(reservations[0].row.exclusive).toBe(true);
  });

  it("5 bus esclusivi ugualmente compatibili (scenario GIACOMONI) → sceglie comunque un solo bus, deterministico per sort_order", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP],
      booking_group_stops: ARRIVAL_ONLY_STOPS,
      booking_group_bus_reservations: [],
      tenant_bus_units: [1, 2, 3, 4, 5].map((n) => ({
        id: `bus-${n}`, tenant_id: TENANT, bus_line_id: LINE_ESCLUSIVI, label: `GRUPPO EX ${n}`,
        capacity: 54, tag: "esclusivo", status: "open", manual_close: false, active: true, sort_order: n,
      })),
      tenant_bus_lines: [EXCLUSIVE_LINE],
    });

    const result = await autoAssignBookingGroup(admin as never, actor, GROUP_ID);

    expect(result.blocked).toEqual([]);
    expect(result.reservations_created).toHaveLength(1);
    expect(result.reservations_created[0].bus_unit_id).toBe("bus-1");
    expect(writes.upserts.filter((w) => w.table === "booking_group_bus_reservations")).toHaveLength(1);
  });

  it("reservation già esistente per quella data → non viene ricreata, resta autorevole quella esistente", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP],
      booking_group_stops: ARRIVAL_ONLY_STOPS,
      booking_group_bus_reservations: [
        { id: "r1", tenant_id: TENANT, booking_group_id: GROUP_ID, bus_unit_id: BUS_B, service_date: "2026-09-06", exclusive: true, reserved_pax: 38 },
      ],
      tenant_bus_units: [
        { id: BUS_A, tenant_id: TENANT, bus_line_id: LINE_ESCLUSIVI, label: "GRUPPO EX 3", capacity: 54, tag: "esclusivo", status: "open", manual_close: false, active: true },
      ],
      tenant_bus_lines: [EXCLUSIVE_LINE],
    });

    const result = await autoAssignBookingGroup(admin as never, actor, GROUP_ID);

    expect(result.reservations_created).toEqual([]);
    expect(result.blocked).toEqual([]);
    expect(writes.upserts.filter((w) => w.table === "booking_group_bus_reservations")).toHaveLength(0);
  });

  it("gruppo senza fermate/pax noti → non tenta nulla (attempted: false)", async () => {
    const { admin } = makeAdmin({
      booking_groups: [{ ...GROUP, expected_pax: null, service_date: null, return_date: null }],
      booking_group_stops: [],
    });

    const result = await autoAssignBookingGroup(admin as never, actor, GROUP_ID);

    expect(result.attempted).toBe(false);
    expect(result.reservations_created).toEqual([]);
    expect(result.blocked).toEqual([]);
  });

  it("gruppo cancellato → non tenta nulla", async () => {
    const { admin } = makeAdmin({
      booking_groups: [{ ...GROUP, status: "cancelled" }],
      booking_group_stops: ARRIVAL_ONLY_STOPS,
    });

    const result = await autoAssignBookingGroup(admin as never, actor, GROUP_ID);

    expect(result.attempted).toBe(false);
  });

  it("gruppo non bus_exclusive → salta la fase di reservation, prova comunque a operativizzare", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [{ ...GROUP, kind: "bus_group" }],
      booking_group_stops: ARRIVAL_ONLY_STOPS,
    });

    const result = await autoAssignBookingGroup(admin as never, actor, GROUP_ID);

    expect(result.attempted).toBe(false);
    expect(writes.upserts.filter((w) => w.table === "booking_group_bus_reservations")).toHaveLength(0);
  });
});

describe("autoAssignBookingGroup - allocazioni mancanti su services gia operativi", () => {
  it("reservation esistente + services new/is_draft=false senza allocations -> chiama allocate_bus_service sul bus riservato", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP],
      booking_group_stops: [
        { id: "stop-fano", tenant_id: TENANT, booking_group_id: GROUP_ID, direction: "arrival", city: "FANO", pickup_point: "PARCHEGGIO CASELLO A14", stop_id: "canonical-fano", expected_pax: 10 },
        { id: "stop-marotta", tenant_id: TENANT, booking_group_id: GROUP_ID, direction: "arrival", city: "MAROTTA", pickup_point: "PARCHEGGIO CASELLO A14", stop_id: "canonical-marotta", expected_pax: 18 },
      ],
      services: [
        { id: "svc-fano", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: "stop-fano", customer_name: "GIACOMONI", pax: 10, date: "2026-09-06", direction: "arrival", status: "new", is_draft: false, bus_city_origin: "FANO", meeting_point: "PARCHEGGIO CASELLO A14", booking_service_kind: "bus_city_hotel", time: "06:00" },
        { id: "svc-marotta", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: "stop-marotta", customer_name: "GIACOMONI", pax: 18, date: "2026-09-06", direction: "arrival", status: "new", is_draft: false, bus_city_origin: "MAROTTA", meeting_point: "PARCHEGGIO CASELLO A14", booking_service_kind: "bus_city_hotel", time: "06:20" },
      ],
      booking_group_bus_reservations: [
        { id: "r1", tenant_id: TENANT, booking_group_id: GROUP_ID, bus_unit_id: BUS_B, service_date: "2026-09-06", exclusive: true, reserved_pax: 38 },
      ],
      tenant_bus_allocations: [],
      tenant_bus_units: [
        { id: BUS_B, tenant_id: TENANT, bus_line_id: LINE_ESCLUSIVI, label: "GRUPPO EX 1", capacity: 54, tag: "gruppi", status: "open", manual_close: false, active: true },
      ],
      tenant_bus_line_stops: [
        { id: "canonical-fano", tenant_id: TENANT, bus_line_id: LINE_ESCLUSIVI, city: "FANO", stop_name: "FANO", pickup_note: "PARCHEGGIO CASELLO A14", direction: "arrival", active: true, pickup_time: "06:00" },
        { id: "canonical-marotta", tenant_id: TENANT, bus_line_id: LINE_ESCLUSIVI, city: "MAROTTA", stop_name: "MAROTTA", pickup_note: "PARCHEGGIO CASELLO A14", direction: "arrival", active: true, pickup_time: "06:20" },
      ],
      tenant_bus_lines: [EXCLUSIVE_LINE],
    });

    const result = await autoAssignBookingGroup(admin as never, actor, GROUP_ID);

    expect(result.blocked).toEqual([]);
    expect(result.allocations_created).toHaveLength(2);
    expect(writes.rpcs.filter((w) => w.name === "allocate_bus_service").map((w) => w.args.p_service_id)).toEqual(["svc-fano", "svc-marotta"]);
    expect(writes.rpcs.every((w) => w.args.p_bus_unit_id === BUS_B)).toBe(true);
  });

  it("service draft completo con time 00:00 -> diventa operativo e viene allocato sul bus riservato", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP],
      booking_group_stops: [
        { id: "stop-pesaro", tenant_id: TENANT, booking_group_id: GROUP_ID, direction: "departure", city: "PESARO", pickup_point: "PARCHEGGIO CASELLO A14", stop_id: "canonical-pesaro", expected_pax: 6 },
      ],
      services: [
        { id: "svc-pesaro", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: "stop-pesaro", customer_name: "GIACOMONI", pax: 6, date: "2026-09-13", direction: "departure", status: "needs_review", is_draft: true, bus_city_origin: "PESARO", meeting_point: "PARCHEGGIO CASELLO A14", booking_service_kind: "bus_hotel_city", time: "00:00" },
      ],
      booking_group_bus_reservations: [
        { id: "r-return", tenant_id: TENANT, booking_group_id: GROUP_ID, bus_unit_id: BUS_B, service_date: "2026-09-13", exclusive: true, reserved_pax: 38 },
      ],
      tenant_bus_allocations: [],
      tenant_bus_units: [
        { id: BUS_B, tenant_id: TENANT, bus_line_id: LINE_ESCLUSIVI, label: "GRUPPO EX 1", capacity: 54, tag: "gruppi", status: "open", manual_close: false, active: true },
      ],
      tenant_bus_line_stops: [
        { id: "canonical-pesaro", tenant_id: TENANT, bus_line_id: LINE_ESCLUSIVI, city: "PESARO", stop_name: "PESARO", pickup_note: "PARCHEGGIO CASELLO A14", direction: "departure", active: true, pickup_time: "09:00" },
      ],
      tenant_bus_lines: [EXCLUSIVE_LINE],
    });

    const result = await autoAssignBookingGroup(admin as never, actor, GROUP_ID);

    expect(result.blocked).toEqual([]);
    expect(result.allocations_created).toHaveLength(1);
    expect(writes.updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: "services",
        filters: expect.objectContaining({ id: "svc-pesaro", is_draft: true }),
        payload: expect.objectContaining({ is_draft: false, status: "new" }),
      }),
    ]));
    expect(writes.rpcs.filter((w) => w.name === "allocate_bus_service").map((w) => w.args.p_service_id)).toEqual(["svc-pesaro"]);
  });

  it("service draft incompleto -> resta bloccato con campi mancanti espliciti", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP],
      booking_group_stops: [],
      services: [
        { id: "svc-draft", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: null, customer_name: "GIACOMONI", pax: 6, date: "2026-09-13", direction: "departure", status: "needs_review", is_draft: true, bus_city_origin: null, meeting_point: null, time: "00:00" },
      ],
      booking_group_bus_reservations: [
        { id: "r-return", tenant_id: TENANT, booking_group_id: GROUP_ID, bus_unit_id: BUS_B, service_date: "2026-09-13", exclusive: true, reserved_pax: 38 },
      ],
      tenant_bus_allocations: [],
      tenant_bus_units: [
        { id: BUS_B, tenant_id: TENANT, bus_line_id: LINE_ESCLUSIVI, label: "GRUPPO EX 1", capacity: 54, tag: "gruppi", status: "open", manual_close: false, active: true },
      ],
      tenant_bus_lines: [EXCLUSIVE_LINE],
    });

    const result = await autoAssignBookingGroup(admin as never, actor, GROUP_ID);

    expect(result.blocked[0].reason).toContain("manca fermata gruppo");
    expect(result.blocked[0].reason).toContain("citta");
    expect(writes.rpcs.filter((w) => w.name === "allocate_bus_service")).toHaveLength(0);
  });
});

describe("linkOrphanReservationToGroup - evita doppia reservation sul reale", () => {
  it("rifiuta se il gruppo reale ha gia una reservation esclusiva sulla stessa data", async () => {
    const orphanId = "orphan-group-id";
    const { admin, writes } = makeAdmin({
      booking_groups: [
        { ...GROUP, name: "GRUPPO GIACOMONI" },
        { id: orphanId, tenant_id: TENANT, name: "GIACOMONI", kind: "bus_exclusive", status: "to_complete" },
      ],
      booking_group_bus_reservations: [
        { id: "r-real", tenant_id: TENANT, booking_group_id: GROUP_ID, bus_unit_id: BUS_B, service_date: "2026-09-06", exclusive: true, reserved_pax: 38 },
        { id: "r-orphan", tenant_id: TENANT, booking_group_id: orphanId, bus_unit_id: BUS_A, service_date: "2026-09-06", exclusive: true, reserved_pax: 38 },
      ],
      services: [
        { id: "svc-real", tenant_id: TENANT, booking_group_id: GROUP_ID, customer_name: "GIACOMONI", pax: 38, direction: "arrival", status: "new" },
      ],
    });

    const res = await linkOrphanReservationToGroup(admin as never, actor, {
      reservationId: "r-orphan",
      orphanBookingGroupId: orphanId,
      realBookingGroupId: GROUP_ID,
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
    expect(writes.updates.filter((w) => w.table === "booking_group_bus_reservations")).toHaveLength(0);
  });
});

describe("removeOrphanReservationForGroup - rimuove solo reservation orfane sicure", () => {
  const ORPHAN_ID = "orphan-group-id";

  function seed(overrides: Record<string, unknown[]> = {}) {
    return {
      booking_groups: [
        { ...GROUP, name: "GIACOMONI", kind: "bus_exclusive", status: "to_complete" },
        { id: ORPHAN_ID, tenant_id: TENANT, name: "GRUPPO GIACOMONI", kind: "bus_exclusive", status: "operational" },
      ],
      booking_group_bus_reservations: [
        { id: "r-real", tenant_id: TENANT, booking_group_id: GROUP_ID, bus_unit_id: BUS_B, service_date: "2026-09-06", exclusive: true, reserved_pax: 38 },
        { id: "r-orphan", tenant_id: TENANT, booking_group_id: ORPHAN_ID, bus_unit_id: BUS_A, service_date: "2026-09-06", exclusive: true, reserved_pax: 38 },
      ],
      services: [
        { id: "svc-real", tenant_id: TENANT, booking_group_id: GROUP_ID, customer_name: "GIACOMONI", pax: 38, direction: "arrival", status: "new" },
      ],
      ...overrides,
    };
  }

  it("rimuove la reservation orfana quando il reale ha gia reservation sulla stessa data", async () => {
    const { admin, writes } = makeAdmin(seed());

    const res = await removeOrphanReservationForGroup(admin as never, actor, {
      reservationId: "r-orphan",
      orphanBookingGroupId: ORPHAN_ID,
      realBookingGroupId: GROUP_ID,
    });

    expect(res.ok).toBe(true);
    expect(writes.deletes).toEqual([
      {
        table: "booking_group_bus_reservations",
        filters: expect.objectContaining({ id: "r-orphan", booking_group_id: ORPHAN_ID, tenant_id: TENANT }),
      },
    ]);
  });

  it("rifiuta se il gruppo orfano ha services attivi", async () => {
    const { admin, writes } = makeAdmin(seed({
      services: [
        { id: "svc-real", tenant_id: TENANT, booking_group_id: GROUP_ID, customer_name: "GIACOMONI", pax: 38, direction: "arrival", status: "new" },
        { id: "svc-orphan", tenant_id: TENANT, booking_group_id: ORPHAN_ID, customer_name: "GIACOMONI", pax: 1, direction: "arrival", status: "new" },
      ],
    }));

    const res = await removeOrphanReservationForGroup(admin as never, actor, {
      reservationId: "r-orphan",
      orphanBookingGroupId: ORPHAN_ID,
      realBookingGroupId: GROUP_ID,
    });

    expect(res.ok).toBe(false);
    expect(writes.deletes).toHaveLength(0);
  });
});

describe("addBookingGroupPassengers — Obiettivo A: zero click reale via aggiunta passeggeri", () => {
  const STOP_ID = "s1";
  const STOP = { id: STOP_ID, tenant_id: TENANT, booking_group_id: GROUP_ID, city: "Cattolica", pickup_point: "CASELLO A14", direction: "arrival", stop_id: "canonical-stop" };

  it("UI umana (autoAssign di default): aggiunge il passeggero e riserva/operativizza da sola, nessun click aggiuntivo", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [{ ...GROUP, expected_pax: 38 }],
      booking_group_stops: [STOP],
      booking_group_bus_reservations: [],
      tenant_bus_line_stops: [{ id: "canonical-stop", tenant_id: TENANT, pickup_time: "05:20" }],
      tenant_bus_units: [
        { id: BUS_A, tenant_id: TENANT, bus_line_id: LINE_ESCLUSIVI, label: "GRUPPO EX 3", capacity: 54, tag: "esclusivo", status: "open", manual_close: false, active: true },
      ],
      tenant_bus_lines: [EXCLUSIVE_LINE],
    });

    const res = await addBookingGroupPassengers(admin as never, actor, {
      bookingGroupId: GROUP_ID,
      bookingGroupStopId: STOP_ID,
      passengers: [{ customer_name: "GIACOMONI", pax: 38 }],
    });

    expect(res.ok).toBe(true);
    const reservations = writes.upserts.filter((w) => w.table === "booking_group_bus_reservations");
    expect(reservations).toHaveLength(1);
    expect(reservations[0].row.service_date).toBe("2026-09-06");
    expect(reservations[0].row.bus_unit_id).toBe(BUS_A);
  });

  it("chiamata MCP (autoAssign: false, come Mario): aggiunge il passeggero ma NON riserva/operativizza automaticamente", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [{ ...GROUP, expected_pax: 38 }],
      booking_group_stops: [STOP],
      booking_group_bus_reservations: [],
      tenant_bus_line_stops: [{ id: "canonical-stop", tenant_id: TENANT, pickup_time: "05:20" }],
      tenant_bus_units: [
        { id: BUS_A, tenant_id: TENANT, bus_line_id: LINE_ESCLUSIVI, label: "GRUPPO EX 3", capacity: 54, tag: "esclusivo", status: "open", manual_close: false, active: true },
      ],
      tenant_bus_lines: [EXCLUSIVE_LINE],
    });

    const res = await addBookingGroupPassengers(admin as never, actor, {
      bookingGroupId: GROUP_ID,
      bookingGroupStopId: STOP_ID,
      passengers: [{ customer_name: "GIACOMONI", pax: 38 }],
      autoAssign: false,
    });

    expect(res.ok).toBe(true);
    expect(writes.upserts.filter((w) => w.table === "booking_group_bus_reservations")).toHaveLength(0);
  });
});

describe("patchBookingGroup — Obiettivo C/H: arrival_date/departure_date seguono `date` sui services draft", () => {
  it("service arrival draft: cambiare service_date del gruppo aggiorna date + arrival_date, MAI departure_date", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [{ ...GROUP, service_date: "2026-09-01" }],
      services: [
        { id: "svc-1", tenant_id: TENANT, booking_group_id: GROUP_ID, direction: "arrival", date: "2026-09-01", hotel_id: null, is_draft: true },
      ],
    });

    const res = await patchBookingGroup(admin as never, actor, GROUP_ID, { service_date: "2026-09-06" });

    expect(res.ok).toBe(true);
    const svcUpdate = writes.updates.find((w) => w.table === "services" && w.filters.id === "svc-1");
    expect(svcUpdate?.payload.date).toBe("2026-09-06");
    expect(svcUpdate?.payload.arrival_date).toBe("2026-09-06");
    expect(svcUpdate?.payload.departure_date).toBeUndefined();
  });

  it("service departure draft: cambiare return_date del gruppo aggiorna date + departure_date, MAI arrival_date", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [{ ...GROUP, return_date: null }],
      services: [
        { id: "svc-2", tenant_id: TENANT, booking_group_id: GROUP_ID, direction: "departure", date: "2026-09-06", hotel_id: null, is_draft: true },
      ],
    });

    const res = await patchBookingGroup(admin as never, actor, GROUP_ID, { return_date: "2026-09-13" });

    expect(res.ok).toBe(true);
    const svcUpdate = writes.updates.find((w) => w.table === "services" && w.filters.id === "svc-2");
    expect(svcUpdate?.payload.date).toBe("2026-09-13");
    expect(svcUpdate?.payload.departure_date).toBe("2026-09-13");
    expect(svcUpdate?.payload.arrival_date).toBeUndefined();
  });

  it("cambio date su gruppo bus_exclusive completo (fermate + pax noti) → tenta anche l'auto-assegnazione (best effort)", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [{ ...GROUP, service_date: "2026-09-01" }],
      booking_group_stops: ARRIVAL_ONLY_STOPS,
      booking_group_bus_reservations: [],
      tenant_bus_units: [
        { id: BUS_A, tenant_id: TENANT, bus_line_id: LINE_ESCLUSIVI, label: "GRUPPO EX 3", capacity: 54, tag: "esclusivo", status: "open", manual_close: false, active: true },
      ],
      tenant_bus_lines: [EXCLUSIVE_LINE],
    });

    await patchBookingGroup(admin as never, actor, GROUP_ID, { service_date: "2026-09-06" });

    const reservations = writes.upserts.filter((w) => w.table === "booking_group_bus_reservations");
    expect(reservations).toHaveLength(1);
    expect(reservations[0].row.service_date).toBe("2026-09-06");
  });
});

describe("generateReturnStopsFromArrival — Obiettivo B: fermate ritorno da andata in ordine inverso", () => {
  const STOP_CATTOLICA = "stop-cattolica";
  const STOP_PESARO = "stop-pesaro";
  const STOP_FANO = "stop-fano";
  const STOP_MAROTTA = "stop-marotta";

  function arrivalStopsSeed() {
    return [
      { id: STOP_CATTOLICA, tenant_id: TENANT, booking_group_id: GROUP_ID, city: "CATTOLICA", pickup_point: "CASELLO A14", direction: "arrival", expected_pax: 4, notes: null },
      { id: STOP_PESARO, tenant_id: TENANT, booking_group_id: GROUP_ID, city: "PESARO", pickup_point: "CASELLO A14", direction: "arrival", expected_pax: 6, notes: null },
      { id: STOP_FANO, tenant_id: TENANT, booking_group_id: GROUP_ID, city: "FANO", pickup_point: "PARCHEGGIO CASELLO A14", direction: "arrival", expected_pax: 10, notes: null },
      { id: STOP_MAROTTA, tenant_id: TENANT, booking_group_id: GROUP_ID, city: "MAROTTA", pickup_point: "PARCHEGGIO CASELLO A14", direction: "arrival", expected_pax: 18, notes: null },
    ];
  }
  function arrivalServicesSeed() {
    return [
      { id: "svc-cattolica", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: STOP_CATTOLICA, customer_name: "GIACOMONI", pax: 4, direction: "arrival", status: "needs_review", phone: null, hotel_id: null, notes: null },
      { id: "svc-pesaro", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: STOP_PESARO, customer_name: "GIACOMONI", pax: 6, direction: "arrival", status: "needs_review", phone: null, hotel_id: null, notes: null },
      { id: "svc-fano", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: STOP_FANO, customer_name: "GIACOMONI", pax: 10, direction: "arrival", status: "needs_review", phone: null, hotel_id: null, notes: null },
      { id: "svc-marotta", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: STOP_MAROTTA, customer_name: "GIACOMONI", pax: 18, direction: "arrival", status: "needs_review", phone: null, hotel_id: null, notes: null },
    ];
  }

  it("genera le fermate ritorno nello stesso ordine dell'andata INVERTITO (Sud->Nord se andata era Nord->Sud)", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP],
      booking_group_stops: arrivalStopsSeed(),
      services: arrivalServicesSeed(),
    });

    const res = await generateReturnStopsFromArrival(admin as never, actor, GROUP_ID);

    expect(res.ok).toBe(true);
    const newStops = writes.inserts.filter((w) => w.table === "booking_group_stops");
    expect(newStops.map((w) => w.row.city)).toEqual(["MAROTTA", "FANO", "PESARO", "CATTOLICA"]);
    expect(newStops.every((w) => w.row.direction === "departure")).toBe(true);
  });

  it("mantiene pax e booking_group_id sui nuovi services departure, data = return_date", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP],
      booking_group_stops: arrivalStopsSeed(),
      services: arrivalServicesSeed(),
    });

    const res = await generateReturnStopsFromArrival(admin as never, actor, GROUP_ID);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.created_stops).toBe(4);
    if (res.ok) expect(res.data.created_services).toBe(4);
    const newServices = writes.inserts.filter((w) => w.table === "services");
    expect(newServices).toHaveLength(4);
    const paxByCity = new Map(newServices.map((w) => [w.row.bus_city_origin, w.row.pax]));
    expect(paxByCity.get("MAROTTA")).toBe(18);
    expect(paxByCity.get("FANO")).toBe(10);
    expect(paxByCity.get("PESARO")).toBe(6);
    expect(paxByCity.get("CATTOLICA")).toBe(4);
    expect(newServices.every((w) => w.row.booking_group_id === GROUP_ID)).toBe(true);
    expect(newServices.every((w) => w.row.direction === "departure")).toBe(true);
    expect(newServices.every((w) => w.row.date === "2026-09-13")).toBe(true);
    expect(newServices.every((w) => w.row.departure_date === "2026-09-13")).toBe(true);
    // Obiettivo B: mai un orario inventato senza una regola canonica nota.
    expect(newServices.every((w) => w.row.time === "00:00")).toBe(true);
  });

  it("idempotente: una seconda chiamata non duplica le fermate/services già generati", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP],
      booking_group_stops: arrivalStopsSeed(),
      services: arrivalServicesSeed(),
    });

    await generateReturnStopsFromArrival(admin as never, actor, GROUP_ID);
    const res2 = await generateReturnStopsFromArrival(admin as never, actor, GROUP_ID);

    expect(res2.ok).toBe(true);
    if (res2.ok) expect(res2.data.created_stops).toBe(0);
    expect(writes.inserts.filter((w) => w.table === "booking_group_stops")).toHaveLength(4);
    expect(writes.inserts.filter((w) => w.table === "services" && w.row.direction === "departure")).toHaveLength(4);
  });

  it("Obiettivo E (prompt ALLINEARE TUTTE LE VISTE): ritorno parziale (manca MAROTTA) -> completa SOLO la fermata mancante, nessun duplicato di FANO/PESARO/CATTOLICA", async () => {
    const partialDepartureStops = [
      { id: "dep-fano", tenant_id: TENANT, booking_group_id: GROUP_ID, city: "FANO", pickup_point: "PARCHEGGIO CASELLO A14", direction: "departure", expected_pax: 10, notes: null },
      { id: "dep-pesaro", tenant_id: TENANT, booking_group_id: GROUP_ID, city: "PESARO", pickup_point: "CASELLO A14", direction: "departure", expected_pax: 6, notes: null },
      { id: "dep-cattolica", tenant_id: TENANT, booking_group_id: GROUP_ID, city: "CATTOLICA", pickup_point: "CASELLO A14", direction: "departure", expected_pax: 4, notes: null },
    ];
    const partialDepartureServices = [
      { id: "svc-dep-fano", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: "dep-fano", customer_name: "GIACOMONI", pax: 10, direction: "departure", status: "needs_review", phone: null, hotel_id: null, notes: null, date: "2026-09-13" },
      { id: "svc-dep-pesaro", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: "dep-pesaro", customer_name: "GIACOMONI", pax: 6, direction: "departure", status: "needs_review", phone: null, hotel_id: null, notes: null, date: "2026-09-13" },
      { id: "svc-dep-cattolica", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: "dep-cattolica", customer_name: "GIACOMONI", pax: 4, direction: "departure", status: "needs_review", phone: null, hotel_id: null, notes: null, date: "2026-09-13" },
    ];
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP],
      booking_group_stops: [...arrivalStopsSeed(), ...partialDepartureStops],
      services: [...arrivalServicesSeed(), ...partialDepartureServices],
    });

    const res = await generateReturnStopsFromArrival(admin as never, actor, GROUP_ID);

    expect(res.ok).toBe(true);
    // Solo 1 fermata NUOVA (MAROTTA); addBookingGroupPassengers e' idempotente
    // per nominativo quindi le 3 fermate gia' esistenti vengono riusate
    // (nessun insert), non ricreate — created_services conta 1 nuovo + 3
    // riusati (stesso conteggio di addBookingGroupPassengers altrove).
    if (res.ok) {
      expect(res.data.created_stops).toBe(1);
      expect(res.data.created_services).toBe(4);
    }
    const newStops = writes.inserts.filter((w) => w.table === "booking_group_stops");
    expect(newStops).toHaveLength(1);
    expect(newStops[0].row.city).toBe("MAROTTA");
    expect(newStops[0].row.direction).toBe("departure");
    const newServices = writes.inserts.filter((w) => w.table === "services" && w.row.direction === "departure");
    expect(newServices).toHaveLength(1);
    expect(newServices[0].row.bus_city_origin).toBe("MAROTTA");
    expect(newServices[0].row.pax).toBe(18);
  });

  it("non genera nulla se return_date è null", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [{ ...GROUP, return_date: null }],
      booking_group_stops: arrivalStopsSeed(),
      services: arrivalServicesSeed(),
    });

    const res = await generateReturnStopsFromArrival(admin as never, actor, GROUP_ID);

    expect(res.ok).toBe(false);
    expect(writes.inserts.filter((w) => w.table === "booking_group_stops")).toHaveLength(0);
  });

  it("non genera nulla se il gruppo non è bus_exclusive", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [{ ...GROUP, kind: "bus_group" }],
      booking_group_stops: arrivalStopsSeed(),
      services: arrivalServicesSeed(),
    });

    const res = await generateReturnStopsFromArrival(admin as never, actor, GROUP_ID);

    expect(res.ok).toBe(false);
    expect(writes.inserts.filter((w) => w.table === "booking_group_stops")).toHaveLength(0);
  });

  it("non genera nulla se non esistono fermate andata", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP],
      booking_group_stops: [],
      services: [],
    });

    const res = await generateReturnStopsFromArrival(admin as never, actor, GROUP_ID);

    expect(res.ok).toBe(false);
    expect(writes.inserts.filter((w) => w.table === "booking_group_stops")).toHaveLength(0);
  });
});

describe("autoAssignBookingGroup — Obiettivo C/D: rilevamento conflitto reservation orfana", () => {
  const ORPHAN_ID = "orphan-group-id";

  it("bus bloccato da un gruppo con 0 services attivi -> orphan_conflict rilevato", async () => {
    const { admin } = makeAdmin({
      booking_groups: [GROUP, { id: ORPHAN_ID, tenant_id: TENANT, name: "GRUPPO GIACOMONI", kind: "bus_exclusive" }],
      booking_group_stops: ARRIVAL_ONLY_STOPS,
      booking_group_bus_reservations: [
        { id: "r-orphan", tenant_id: TENANT, booking_group_id: ORPHAN_ID, bus_unit_id: BUS_A, service_date: "2026-09-06", exclusive: true, reserved_pax: 38 },
      ],
      tenant_bus_units: [
        { id: BUS_A, tenant_id: TENANT, bus_line_id: LINE_ESCLUSIVI, label: "GRUPPO EX 3", capacity: 54, tag: "esclusivo", status: "open", manual_close: false, active: true },
      ],
      tenant_bus_lines: [EXCLUSIVE_LINE],
      services: [], // il gruppo orfano non ha nessun service
    });

    const result = await autoAssignBookingGroup(admin as never, actor, GROUP_ID);

    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].orphan_conflict).toMatchObject({
      busUnitId: BUS_A,
      busLabel: "GRUPPO EX 3",
      orphanBookingGroupId: ORPHAN_ID,
      orphanBookingGroupName: "GRUPPO GIACOMONI",
      reservationId: "r-orphan",
    });
  });

  it("bus bloccato da un gruppo CON services attivi -> nessun orphan_conflict (non è sicuro considerarlo orfano)", async () => {
    const { admin } = makeAdmin({
      booking_groups: [GROUP, { id: ORPHAN_ID, tenant_id: TENANT, name: "ALTRO GRUPPO REALE", kind: "bus_exclusive" }],
      booking_group_stops: ARRIVAL_ONLY_STOPS,
      booking_group_bus_reservations: [
        { id: "r-other", tenant_id: TENANT, booking_group_id: ORPHAN_ID, bus_unit_id: BUS_A, service_date: "2026-09-06", exclusive: true, reserved_pax: 38 },
      ],
      tenant_bus_units: [
        { id: BUS_A, tenant_id: TENANT, bus_line_id: LINE_ESCLUSIVI, label: "GRUPPO EX 3", capacity: 54, tag: "esclusivo", status: "open", manual_close: false, active: true },
      ],
      tenant_bus_lines: [EXCLUSIVE_LINE],
      services: [
        { id: "svc-other", tenant_id: TENANT, booking_group_id: ORPHAN_ID, customer_name: "Altro Gruppo", pax: 40, direction: "arrival", status: "needs_review" },
      ],
    });

    const result = await autoAssignBookingGroup(admin as never, actor, GROUP_ID);

    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].orphan_conflict).toBeUndefined();
  });
});

describe("linkOrphanReservationToGroup — Obiettivo C: azione sicura, mai automatica", () => {
  const ORPHAN_ID = "orphan-group-id";
  const REAL_STOPS = [
    { id: "s1", tenant_id: TENANT, booking_group_id: GROUP_ID, direction: "arrival" },
  ];

  function baseSeed(overrides: Record<string, unknown[]> = {}) {
    return {
      booking_groups: [{ ...GROUP, name: "GIACOMONI" }, { id: ORPHAN_ID, tenant_id: TENANT, name: "GRUPPO GIACOMONI", kind: "bus_exclusive", status: "operational" }],
      booking_group_bus_reservations: [
        { id: "r-orphan", tenant_id: TENANT, booking_group_id: ORPHAN_ID, bus_unit_id: BUS_A, service_date: "2026-09-06", exclusive: true, reserved_pax: 38 },
      ],
      services: [
        { id: "svc-real", tenant_id: TENANT, booking_group_id: GROUP_ID, customer_name: "GIACOMONI", pax: 38, direction: "arrival", status: "needs_review" },
      ],
      booking_group_stops: REAL_STOPS,
      tenant_bus_units: [
        { id: BUS_A, tenant_id: TENANT, bus_line_id: LINE_ESCLUSIVI, label: "GRUPPO EX 3", capacity: 54, tag: "esclusivo", status: "open", manual_close: false, active: true },
      ],
      tenant_bus_lines: [EXCLUSIVE_LINE],
      ...overrides,
    };
  }

  it("caso reale: sposta la reservation dal gruppo orfano (0 services, nome compatibile) al gruppo reale", async () => {
    const { admin, writes } = makeAdmin(baseSeed());

    const res = await linkOrphanReservationToGroup(admin as never, actor, {
      reservationId: "r-orphan",
      orphanBookingGroupId: ORPHAN_ID,
      realBookingGroupId: GROUP_ID,
    });

    expect(res.ok).toBe(true);
    const reservationUpdate = writes.updates.find((w) => w.table === "booking_group_bus_reservations" && w.filters.id === "r-orphan");
    expect(reservationUpdate?.payload.booking_group_id).toBe(GROUP_ID);
  });

  it("rifiuta se il gruppo orfano ha services attivi (non è sicuro considerarlo orfano)", async () => {
    const { admin, writes } = makeAdmin(baseSeed({
      services: [
        { id: "svc-real", tenant_id: TENANT, booking_group_id: GROUP_ID, customer_name: "GIACOMONI", pax: 38, direction: "arrival", status: "needs_review" },
        { id: "svc-orphan", tenant_id: TENANT, booking_group_id: ORPHAN_ID, customer_name: "GRUPPO GIACOMONI", pax: 5, direction: "arrival", status: "needs_review" },
      ],
    }));

    const res = await linkOrphanReservationToGroup(admin as never, actor, {
      reservationId: "r-orphan",
      orphanBookingGroupId: ORPHAN_ID,
      realBookingGroupId: GROUP_ID,
    });

    expect(res.ok).toBe(false);
    expect(writes.updates.filter((w) => w.table === "booking_group_bus_reservations")).toHaveLength(0);
  });

  it("rifiuta se i nomi dei due gruppi non sono abbastanza simili", async () => {
    const { admin, writes } = makeAdmin(baseSeed({
      booking_groups: [GROUP, { id: ORPHAN_ID, tenant_id: TENANT, name: "PARROCCHIA SANTA BEATA", kind: "bus_exclusive", status: "operational" }],
    }));

    const res = await linkOrphanReservationToGroup(admin as never, actor, {
      reservationId: "r-orphan",
      orphanBookingGroupId: ORPHAN_ID,
      realBookingGroupId: GROUP_ID,
    });

    expect(res.ok).toBe(false);
    expect(writes.updates.filter((w) => w.table === "booking_group_bus_reservations")).toHaveLength(0);
  });

  it("rifiuta se il gruppo reale non ha services attivi", async () => {
    const { admin, writes } = makeAdmin(baseSeed({ services: [] }));

    const res = await linkOrphanReservationToGroup(admin as never, actor, {
      reservationId: "r-orphan",
      orphanBookingGroupId: ORPHAN_ID,
      realBookingGroupId: GROUP_ID,
    });

    expect(res.ok).toBe(false);
    expect(writes.updates.filter((w) => w.table === "booking_group_bus_reservations")).toHaveLength(0);
  });

  it("rifiuta se uno dei due gruppi non è bus_exclusive", async () => {
    const { admin, writes } = makeAdmin(baseSeed({
      booking_groups: [GROUP, { id: ORPHAN_ID, tenant_id: TENANT, name: "GRUPPO GIACOMONI", kind: "bus_group", status: "operational" }],
    }));

    const res = await linkOrphanReservationToGroup(admin as never, actor, {
      reservationId: "r-orphan",
      orphanBookingGroupId: ORPHAN_ID,
      realBookingGroupId: GROUP_ID,
    });

    expect(res.ok).toBe(false);
    expect(writes.updates.filter((w) => w.table === "booking_group_bus_reservations")).toHaveLength(0);
  });

  it("rifiuta se la reservation non appartiene più al gruppo orfano indicato (race condition)", async () => {
    const { admin, writes } = makeAdmin(baseSeed({
      booking_group_bus_reservations: [
        { id: "r-orphan", tenant_id: TENANT, booking_group_id: "someone-else", bus_unit_id: BUS_A, service_date: "2026-09-06", exclusive: true, reserved_pax: 38 },
      ],
    }));

    const res = await linkOrphanReservationToGroup(admin as never, actor, {
      reservationId: "r-orphan",
      orphanBookingGroupId: ORPHAN_ID,
      realBookingGroupId: GROUP_ID,
    });

    expect(res.ok).toBe(false);
    expect(writes.updates.filter((w) => w.table === "booking_group_bus_reservations")).toHaveLength(0);
  });
});
