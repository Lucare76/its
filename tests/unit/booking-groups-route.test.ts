import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

/**
 * FASE 1 — /api/ops/booking-groups.
 * Verifica: creazione gruppo incompleto, add_stop senza service/allocazione,
 * bus reservation DATE-SCOPED che non tocca tenant_bus_units, override ferry
 * che non tocca bus_line_ferry_config, integrità tenant.
 */

const mocks = vi.hoisted(() => ({ authorizePricingRequest: vi.fn() }));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorizePricingRequest }));

import { GET, POST } from "@/app/api/ops/booking-groups/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_TENANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GROUP_ID = "11111111-1111-4111-8111-111111111111";
const BUS_UNIT_ID = "22222222-2222-4222-8222-222222222222";
const AGENCY_ID = "33333333-3333-4333-8333-333333333333";
const STOP_ID = "44444444-4444-4444-8444-444444444444";

type Row = Record<string, unknown>;

function makeAdmin(seed: Record<string, Row[]> = {}) {
  const writes = {
    inserts: [] as Array<{ table: string; row: Row }>,
    updates: [] as Array<{ table: string; filters: Row; payload: Row }>,
    deletes: [] as Array<{ table: string; filters: Row }>,
    upserts: [] as Array<{ table: string; row: Row; options: unknown }>,
  };
  let seq = 0;

  function builder(table: string) {
    const filters: Row = {};
    let pending: { kind: "insert" | "update" | "upsert" | "delete"; payload?: Row; options?: unknown } | null = null;

    const rowsForFilters = () =>
      (seed[table] ?? []).filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));

    const finish = () => {
      if (pending?.kind === "insert") {
        const row = { id: `${table}-${++seq}`, ...(pending.payload ?? {}) };
        writes.inserts.push({ table, row });
        return { data: row, error: null };
      }
      if (pending?.kind === "update") {
        writes.updates.push({ table, filters: { ...filters }, payload: pending.payload ?? {} });
        return { data: { id: filters.id, ...(pending.payload ?? {}) }, error: null };
      }
      if (pending?.kind === "upsert") {
        const row = { id: `${table}-${++seq}`, ...(pending.payload ?? {}) };
        writes.upserts.push({ table, row, options: pending.options });
        return { data: row, error: null };
      }
      return { data: null, error: null };
    };

    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.in = () => b;
    b.eq = (col: string, val: unknown) => { filters[col] = val; return b; };
    b.maybeSingle = async () => (pending ? finish() : { data: rowsForFilters()[0] ?? null, error: null });
    b.single = async () => (pending ? finish() : { data: rowsForFilters()[0] ?? null, error: null });
    b.insert = (payload: Row) => { pending = { kind: "insert", payload }; return b; };
    b.update = (payload: Row) => { pending = { kind: "update", payload }; return b; };
    b.upsert = (payload: Row, options: unknown) => { pending = { kind: "upsert", payload, options }; return b; };
    b.delete = () => { pending = { kind: "delete" }; return b; };
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      if (pending?.kind === "delete") {
        writes.deletes.push({ table, filters: { ...filters } });
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      }
      return Promise.resolve({ data: rowsForFilters(), error: null }).then(resolve, reject);
    };
    return b;
  }

  return { admin: { from: (t: string) => builder(t) } as never, writes };
}

function authCtx(admin: unknown, role = "operator") {
  return { admin, user: { id: "u1", email: "op@test.it" }, membership: { tenant_id: TENANT, role, suspended: false } };
}

function post(body: unknown) {
  return new NextRequest("http://localhost/api/ops/booking-groups", { method: "POST", body: JSON.stringify(body) });
}
function get(qs = "") {
  return new NextRequest(`http://localhost/api/ops/booking-groups${qs}`, { method: "GET" });
}

beforeEach(() => vi.clearAllMocks());

describe("POST create_group — gruppo incompleto (scenario Parrocchia Natività)", () => {
  it("A/B/C: crea 50 pax bus_exclusive to_complete senza fermate/nominativi/nave/hotel", async () => {
    const { admin, writes } = makeAdmin();
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({
      action: "create_group",
      name: "Parrocchia Natività",
      expected_pax: 50,
      kind: "bus_exclusive",
      status: "to_complete",
      service_date: "2026-09-12",
    }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.group).toBeTruthy();

    const bgInserts = writes.inserts.filter((w) => w.table === "booking_groups");
    expect(bgInserts).toHaveLength(1);
    expect(bgInserts[0]!.row).toMatchObject({
      tenant_id: TENANT,
      name: "Parrocchia Natività",
      expected_pax: 50,
      kind: "bus_exclusive",
      status: "to_complete",
      service_date: "2026-09-12",
      created_by_user_id: "u1",
    });
    expect(writes.inserts.filter((w) => w.table === "services")).toHaveLength(0);
    expect(writes.inserts.filter((w) => w.table === "tenant_bus_allocations")).toHaveLength(0);
    expect(writes.inserts.filter((w) => w.table === "booking_group_stops")).toHaveLength(0);
    expect(bgInserts[0]!.row.outbound_ferry_company).toBeUndefined();
  });

  it("expected_pax = 0 → 400 (zod)", async () => {
    const { admin } = makeAdmin();
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({ action: "create_group", name: "X", expected_pax: 0 }));
    expect(res.status).toBe(400);
  });

  it("agency_id di un altro tenant → 400 (integrità tenant)", async () => {
    const { admin } = makeAdmin({ agencies: [{ id: AGENCY_ID, tenant_id: OTHER_TENANT }] });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({ action: "create_group", name: "X", expected_pax: 10, agency_id: AGENCY_ID }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Agenzia/i);
  });

  it("J: override ferry gruppo NON tocca bus_line_ferry_config", async () => {
    const { admin, writes } = makeAdmin();
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({
      action: "create_group",
      name: "Parrocchia Natività",
      expected_pax: 50,
      outbound_ferry_company: "MEDMAR",
      outbound_ferry_time: "10:35",
      outbound_expected_arrival_time: "12:05",
    }));
    expect(res.status).toBe(200);
    const row = writes.inserts.find((w) => w.table === "booking_groups")!.row;
    expect(row).toMatchObject({ outbound_ferry_company: "MEDMAR", outbound_ferry_time: "10:35", outbound_expected_arrival_time: "12:05" });
    expect([...writes.inserts, ...writes.updates, ...writes.upserts].some((w) => (w as { table: string }).table === "bus_line_ferry_config")).toBe(false);
  });
});

describe("POST add_stop — pianificazione fermata, nessun service/allocazione", () => {
  it("città e punto di carico separati, stop_id null, nessuna tenant_bus_allocation", async () => {
    const { admin, writes } = makeAdmin({ booking_groups: [{ id: GROUP_ID, tenant_id: TENANT }] });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({
      action: "add_stop",
      booking_group_id: GROUP_ID,
      city: "Tivoli",
      pickup_point: "Villa d'Este",
      expected_pax: 20,
      direction: "arrival",
    }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    const stopInserts = writes.inserts.filter((w) => w.table === "booking_group_stops");
    expect(stopInserts).toHaveLength(1);
    expect(stopInserts[0]!.row).toMatchObject({
      tenant_id: TENANT,
      booking_group_id: GROUP_ID,
      city: "Tivoli",
      pickup_point: "Villa d'Este",
      expected_pax: 20,
      direction: "arrival",
      sort_order: 0,
    });
    expect(stopInserts[0]!.row.stop_id).toBeUndefined();
    expect(writes.inserts.filter((w) => w.table === "services")).toHaveLength(0);
    expect(writes.inserts.filter((w) => w.table === "tenant_bus_allocations")).toHaveLength(0);
  });

  it("stop_id di un altro tenant → 400", async () => {
    const { admin } = makeAdmin({
      booking_groups: [{ id: GROUP_ID, tenant_id: TENANT }],
      tenant_bus_line_stops: [{ id: STOP_ID, tenant_id: OTHER_TENANT }],
    });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({
      action: "add_stop", booking_group_id: GROUP_ID, city: "Tivoli", expected_pax: 20, direction: "arrival", stop_id: STOP_ID,
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Fermata catalogo/i);
  });

  it("gruppo inesistente → 404", async () => {
    const { admin } = makeAdmin();
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({ action: "add_stop", booking_group_id: GROUP_ID, city: "X", expected_pax: 5, direction: "arrival" }));
    expect(res.status).toBe(404);
  });
});

describe("POST upsert_bus_reservation — esclusiva DATE-SCOPED", () => {
  it("G: riserva unit il 2026-09-12; nessuna riserva implicita altre date; tenant_bus_units NON modificato", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [{ id: GROUP_ID, tenant_id: TENANT }],
      tenant_bus_units: [{ id: BUS_UNIT_ID, tenant_id: TENANT, tag: "esclusivo", group_name: null, status: "open" }],
    });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({
      action: "upsert_bus_reservation",
      booking_group_id: GROUP_ID,
      bus_unit_id: BUS_UNIT_ID,
      service_date: "2026-09-12",
      reserved_pax: 50,
      exclusive: true,
    }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    const up = writes.upserts.filter((w) => w.table === "booking_group_bus_reservations");
    expect(up).toHaveLength(1);
    expect(up[0]!.row).toMatchObject({
      tenant_id: TENANT,
      booking_group_id: GROUP_ID,
      bus_unit_id: BUS_UNIT_ID,
      service_date: "2026-09-12",
      reserved_pax: 50,
      exclusive: true,
    });
    expect(String((up[0]!.options as { onConflict?: string }).onConflict)).toContain("service_date");
    const touchedUnit = [...writes.inserts, ...writes.updates, ...writes.upserts, ...writes.deletes]
      .some((w) => (w as { table: string }).table === "tenant_bus_units");
    expect(touchedUnit).toBe(false);
  });

  it("bus_unit di un altro tenant → 400", async () => {
    const { admin } = makeAdmin({
      booking_groups: [{ id: GROUP_ID, tenant_id: TENANT }],
      tenant_bus_units: [{ id: BUS_UNIT_ID, tenant_id: OTHER_TENANT }],
    });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({
      action: "upsert_bus_reservation", booking_group_id: GROUP_ID, bus_unit_id: BUS_UNIT_ID, service_date: "2026-09-12", reserved_pax: 10,
    }));
    expect(res.status).toBe(400);
  });
});

describe("GET list / detail", () => {
  it("list → gruppi del tenant", async () => {
    const { admin } = makeAdmin({ booking_groups: [{ id: GROUP_ID, tenant_id: TENANT, name: "Parrocchia Natività", expected_pax: 50, status: "to_complete" }] });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin, "supervisor"));
    const res = await GET(get());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.groups).toHaveLength(1);
  });

  it("detail → include summary pax derivato (planned 40 / unplanned 10)", async () => {
    const { admin } = makeAdmin({
      booking_groups: [{ id: GROUP_ID, tenant_id: TENANT, name: "Parrocchia Natività", expected_pax: 50, status: "stops_defined" }],
      booking_group_stops: [
        { id: "s1", tenant_id: TENANT, booking_group_id: GROUP_ID, expected_pax: 20, direction: "arrival", sort_order: 0 },
        { id: "s2", tenant_id: TENANT, booking_group_id: GROUP_ID, expected_pax: 20, direction: "arrival", sort_order: 1 },
      ],
      booking_group_bus_reservations: [],
      services: [],
    });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await GET(get(`?id=${GROUP_ID}`));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.summary.pax).toMatchObject({ expectedPax: 50, plannedPax: 40, unplannedPax: 10, overbooked: false });
    expect(json.summary.suggestedStatus).toBe("stops_defined");
  });
});

describe("migration 0263 — vincoli chiave", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/0263_booking_groups.sql", import.meta.url), "utf8");

  it("services.booking_group_id nullable, FK ON DELETE SET NULL (I: cancellazione gruppo lascia i services)", () => {
    expect(sql).toMatch(/alter table public\.services\s+add column if not exists booking_group_id uuid null/);
    expect(sql).toMatch(/references public\.booking_groups\(id\) on delete set null/);
  });

  it("stops e reservations sono figli puri → ON DELETE CASCADE", () => {
    expect(sql).toMatch(/booking_group_id uuid not null references public\.booking_groups\(id\) on delete cascade/);
  });

  it("tenant_bus_allocations NON alterato / nessun insert dalla migration", () => {
    expect(sql).not.toMatch(/alter table public\.tenant_bus_allocations/i);
    expect(sql).not.toMatch(/insert into public\.tenant_bus_allocations/i);
  });

  it("bus reservation date-scoped: unique(tenant_id, booking_group_id, bus_unit_id, service_date)", () => {
    expect(sql).toMatch(/unique \(tenant_id, booking_group_id, bus_unit_id, service_date\)/);
  });

  it("nessuna modifica a trip_groups / tenant_bus_units / bus_line_ferry_config", () => {
    expect(sql).not.toMatch(/alter table public\.trip_groups/);
    expect(sql).not.toMatch(/alter table public\.tenant_bus_units/);
    expect(sql).not.toMatch(/alter table public\.bus_line_ferry_config/);
  });
});
