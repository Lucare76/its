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

import { autoAssignBookingGroup } from "@/lib/server/booking-groups-service";

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
  };
  let seq = 0;

  function builder(table: string) {
    const filters: Row = {};
    let pending: { kind: "insert" | "update" | "upsert"; payload?: Row } | null = null;

    const rowsForFilters = () => (seed[table] ?? []).filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));

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
        return { data: { id: filters.id, ...(pending.payload ?? {}) }, error: null };
      }
      return { data: null, error: null };
    };

    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.eq = (col: string, val: unknown) => { filters[col] = val; return b; };
    b.maybeSingle = async () => (pending ? finish() : { data: rowsForFilters()[0] ?? null, error: null });
    b.single = async () => (pending ? finish() : { data: rowsForFilters()[0] ?? null, error: null });
    b.insert = (payload: Row) => { pending = { kind: "insert", payload }; return b; };
    b.update = (payload: Row) => { pending = { kind: "update", payload }; return b; };
    b.upsert = (payload: Row) => { pending = { kind: "upsert", payload }; return b; };
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      if (pending) return Promise.resolve(finish()).then(resolve, reject);
      return Promise.resolve({ data: rowsForFilters(), error: null }).then(resolve, reject);
    };
    return b;
  }

  return { admin: { from: (t: string) => builder(t) } as never, writes };
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
    expect(result.blocked).toEqual([{ service_date: "2026-09-06", reason: "Nessun bus esclusivo libero con capienza sufficiente per quella data." }]);
    expect(writes.upserts.filter((w) => w.table === "booking_group_bus_reservations")).toHaveLength(0);
  });

  it("bus già riservato da un ALTRO gruppo per la stessa data → escluso dai candidati, bloccato (mai un doppio esclusivo sullo stesso bus)", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP],
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

    expect(result.blocked).toEqual([{ service_date: "2026-09-06", reason: "Nessun bus esclusivo libero con capienza sufficiente per quella data." }]);
    expect(writes.upserts.filter((w) => w.table === "booking_group_bus_reservations")).toHaveLength(0);
  });

  it("2 bus esclusivi ugualmente compatibili → bloccato, mai una scelta a caso, elenca le label", async () => {
    const { admin } = makeAdmin({
      booking_groups: [GROUP],
      booking_group_stops: ARRIVAL_ONLY_STOPS,
      booking_group_bus_reservations: [],
      tenant_bus_units: [
        { id: BUS_A, tenant_id: TENANT, bus_line_id: LINE_ESCLUSIVI, label: "GRUPPO EX 3", capacity: 54, tag: "esclusivo", status: "open", manual_close: false, active: true },
        { id: BUS_B, tenant_id: TENANT, bus_line_id: LINE_ESCLUSIVI, label: "GRUPPO EX 4", capacity: 54, tag: "esclusivo", status: "open", manual_close: false, active: true },
      ],
      tenant_bus_lines: [EXCLUSIVE_LINE],
    });

    const result = await autoAssignBookingGroup(admin as never, actor, GROUP_ID);

    expect(result.reservations_created).toEqual([]);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].service_date).toBe("2026-09-06");
    expect(result.blocked[0].reason).toMatch(/GRUPPO EX 3/);
    expect(result.blocked[0].reason).toMatch(/GRUPPO EX 4/);
    expect(result.blocked[0].reason).toMatch(/conferma manuale/i);
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
