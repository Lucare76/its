import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * "Libera bus del gruppo" — action delete_bus_reservation.
 * Rimuove SOLO la riga di booking_group_bus_reservations (id specifico),
 * riusando il percorso DELETE tenant-scoped già esistente in
 * app/api/ops/booking-groups/route.ts. Concetto separato da "Disalloca
 * selezionati" (delete_allocations_bulk su /bus-network, tocca
 * tenant_bus_allocations): qui non si tocca MAI services/booking_groups/
 * tenant_bus_allocations, né altre date o altri gruppi.
 */

const mocks = vi.hoisted(() => ({ authorizePricingRequest: vi.fn(), auditLog: vi.fn() }));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorizePricingRequest }));
vi.mock("@/lib/server/ops-audit", () => ({ auditLog: mocks.auditLog }));

import { POST } from "@/app/api/ops/booking-groups/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_TENANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GROUP_ID = "4f5c821a-6b86-4502-95b6-c2a3eb50f52a";
const OTHER_GROUP_ID = "99999999-9999-4999-8999-999999999999";
const BUS_UNIT_ID = "06442c06-0357-441b-b4a2-a16dc6566a8b";
const RESERVATION_ID = "33b1b1f8-cdcb-4292-a684-18ffd181ea1f";
const OTHER_DATE_RESERVATION_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_GROUP_RESERVATION_ID = "55555555-5555-4555-8555-555555555555";

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
      if (pending) {
        return Promise.resolve(finish()).then(resolve, reject);
      }
      return Promise.resolve({ data: rowsForFilters(), error: null }).then(resolve, reject);
    };
    return b;
  }

  return { admin: { from: (t: string) => builder(t), rpc: async () => ({ data: null, error: { message: "not used" } }) } as never, writes };
}

function authCtx(admin: unknown, role = "operator") {
  return { admin, user: { id: "u1", email: "op@test.it" }, membership: { tenant_id: TENANT, role, suspended: false } };
}

function post(body: unknown) {
  return new NextRequest("http://localhost/api/ops/booking-groups", { method: "POST", body: JSON.stringify(body) });
}

function baseSeed(overrides: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  return {
    booking_group_bus_reservations: [
      { id: RESERVATION_ID, tenant_id: TENANT, booking_group_id: GROUP_ID, bus_unit_id: BUS_UNIT_ID, service_date: "2026-09-13", reserved_pax: 38, exclusive: true, notes: null },
      // Stesso gruppo, ALTRA data (arrivo) — non deve mai essere toccata.
      { id: OTHER_DATE_RESERVATION_ID, tenant_id: TENANT, booking_group_id: GROUP_ID, bus_unit_id: "77777777-7777-4777-8777-777777777777", service_date: "2026-09-06", reserved_pax: 38, exclusive: true, notes: null },
      // ALTRO gruppo, stessa data — non deve mai essere toccato.
      { id: OTHER_GROUP_RESERVATION_ID, tenant_id: TENANT, booking_group_id: OTHER_GROUP_ID, bus_unit_id: "88888888-8888-4888-8888-888888888888", service_date: "2026-09-13", reserved_pax: 20, exclusive: true, notes: null },
    ],
    services: [
      { id: "svc-1", tenant_id: TENANT, booking_group_id: GROUP_ID, status: "new" },
    ],
    booking_groups: [
      { id: GROUP_ID, tenant_id: TENANT, name: "GIACOMONI", kind: "bus_exclusive", status: "operational" },
    ],
    tenant_bus_allocations: [
      { id: "alloc-1", tenant_id: TENANT, service_id: "svc-1", bus_unit_id: BUS_UNIT_ID, pax_assigned: 20 },
    ],
    ...overrides,
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("delete_bus_reservation — Libera bus del gruppo", () => {
  it("1. cancellazione reservation singola: rimuove esattamente quella riga", async () => {
    const { admin, writes } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({ action: "delete_bus_reservation", id: RESERVATION_ID }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.deleted).toBe(RESERVATION_ID);
    const deletes = writes.deletes.filter((w) => w.table === "booking_group_bus_reservations");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].filters).toMatchObject({ tenant_id: TENANT, id: RESERVATION_ID });
  });

  it("2. tenant isolation: reservation di un altro tenant -> 404, nessuna delete/audit", async () => {
    const { admin, writes } = makeAdmin(baseSeed());
    const otherAuth = { admin, user: { id: "u2", email: "op2@test.it" }, membership: { tenant_id: OTHER_TENANT, role: "operator", suspended: false } };
    mocks.authorizePricingRequest.mockResolvedValue(otherAuth);

    const res = await POST(post({ action: "delete_bus_reservation", id: RESERVATION_ID }));
    expect(res.status).toBe(404);
    expect((await res.json()).ok).toBe(false);
    expect(writes.deletes.filter((w) => w.table === "booking_group_bus_reservations")).toHaveLength(0);
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it("3. un'altra data (ARRIVO) dello stesso gruppo resta intatta", async () => {
    const { admin, writes } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    await POST(post({ action: "delete_bus_reservation", id: RESERVATION_ID }));

    const deletes = writes.deletes.filter((w) => w.table === "booking_group_bus_reservations");
    expect(deletes.map((w) => w.filters.id)).not.toContain(OTHER_DATE_RESERVATION_ID);
  });

  it("4. un altro booking group resta intatto", async () => {
    const { admin, writes } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    await POST(post({ action: "delete_bus_reservation", id: RESERVATION_ID }));

    const deletes = writes.deletes.filter((w) => w.table === "booking_group_bus_reservations");
    expect(deletes.map((w) => w.filters.id)).not.toContain(OTHER_GROUP_RESERVATION_ID);
  });

  it("5. services non vengono toccati", async () => {
    const { admin, writes } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    await POST(post({ action: "delete_bus_reservation", id: RESERVATION_ID }));

    expect(writes.deletes.filter((w) => w.table === "services")).toHaveLength(0);
    expect(writes.updates.filter((w) => w.table === "services")).toHaveLength(0);
  });

  it("6. booking_groups non viene toccato", async () => {
    const { admin, writes } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    await POST(post({ action: "delete_bus_reservation", id: RESERVATION_ID }));

    expect(writes.deletes.filter((w) => w.table === "booking_groups")).toHaveLength(0);
    expect(writes.updates.filter((w) => w.table === "booking_groups")).toHaveLength(0);
  });

  it("7. tenant_bus_allocations (passeggeri) non vengono toccate", async () => {
    const { admin, writes } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    await POST(post({ action: "delete_bus_reservation", id: RESERVATION_ID }));

    expect(writes.deletes.filter((w) => w.table === "tenant_bus_allocations")).toHaveLength(0);
    expect(writes.updates.filter((w) => w.table === "tenant_bus_allocations")).toHaveLength(0);
  });

  it("8. audit: outcome = deleted, stesso event dell'upsert (nessun nuovo tipo)", async () => {
    const { admin } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({ action: "delete_bus_reservation", id: RESERVATION_ID }));
    expect((await res.json()).ok).toBe(true);

    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    const [payload] = mocks.auditLog.mock.calls[0];
    expect(payload.event).toBe("booking_group_bus_reservation_changed");
    expect(payload.outcome).toBe("deleted");
  });

  it("9. audit: details contiene booking_group_id, bus_unit_id, service_date (e reserved_pax/exclusive)", async () => {
    const { admin } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    await POST(post({ action: "delete_bus_reservation", id: RESERVATION_ID }));

    const [payload] = mocks.auditLog.mock.calls[0];
    expect(payload.details).toMatchObject({
      booking_group_id: GROUP_ID,
      bus_unit_id: BUS_UNIT_ID,
      service_date: "2026-09-13",
      reserved_pax: 38,
      exclusive: true,
    });
    expect(payload.tenantId).toBe(TENANT);
  });

  it("reservation inesistente per il tenant -> 404 coerente con gli altri pattern della route, nessun delete/audit", async () => {
    const { admin, writes } = makeAdmin(baseSeed({ booking_group_bus_reservations: [] }));
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({ action: "delete_bus_reservation", id: RESERVATION_ID }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/non trovata/i);
    expect(writes.deletes.filter((w) => w.table === "booking_group_bus_reservations")).toHaveLength(0);
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it("permessi: stesso gate admin/operator già esistente sulla route (supervisor escluso, invariato)", async () => {
    const { NextResponse } = await import("next/server");
    const denied = NextResponse.json({ ok: false, error: "Ruolo non autorizzato." }, { status: 403 });
    mocks.authorizePricingRequest.mockResolvedValue(denied);

    const res = await POST(post({ action: "delete_bus_reservation", id: RESERVATION_ID }));
    expect(res.status).toBe(403);
  });
});
