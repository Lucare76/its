import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Sprint Performance 13 — GET /api/ops/tenant-data scoping tests.
 *
 * Covers: auth passthrough unchanged, dataset/scope whitelist (Zod),
 * date/range/ids scoped services queries, assignments/status_events cascaded
 * to the scoped service ids (never the whole tenant), tenant isolation, and
 * the untouched legacy default (no service_scope param).
 */

type Row = Record<string, unknown>;

function splitTopLevelClauses(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of input) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function fieldMatches(row: Row, field: string, op: string, rawValue: string): boolean {
  const value = row[field];
  if (op === "eq") return String(value ?? "") === rawValue;
  if (op === "gte") return String(value ?? "") >= rawValue;
  if (op === "lte") return String(value ?? "") <= rawValue;
  return false;
}

function evalClause(row: Row, clause: string): boolean {
  if (clause.startsWith("and(")) {
    const inner = clause.slice(4, -1);
    return splitTopLevelClauses(inner).every((sub) => evalClause(row, sub));
  }
  const match = clause.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.(eq|gte|lte)\.(.*)$/);
  if (!match) return false;
  const [, field, op, rawValue] = match;
  return fieldMatches(row, field, op, rawValue);
}

function selectBuilder(rows: Row[], onRange?: () => void) {
  let filtered = rows;
  const builder = {
    eq(field: string, value: unknown) {
      filtered = filtered.filter((r) => String(r[field] ?? "") === String(value));
      return builder;
    },
    in(field: string, values: unknown[]) {
      const set = new Set(values.map(String));
      filtered = filtered.filter((r) => set.has(String(r[field])));
      return builder;
    },
    or(filterStr: string) {
      const clauses = splitTopLevelClauses(filterStr);
      filtered = filtered.filter((r) => clauses.some((clause) => evalClause(r, clause)));
      return builder;
    },
    order() {
      return builder;
    },
    range(from: number, to: number) {
      onRange?.();
      filtered = filtered.slice(from, to + 1);
      return builder;
    },
    then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
    }
  };
  return builder;
}

function createFakeAdmin(seed: Partial<Record<string, Row[]>> = {}) {
  const tables: Record<string, Row[]> = {
    services: [],
    assignments: [],
    status_events: [],
    hotels: [],
    memberships: [],
    bus_lot_configs: [],
    inbound_emails: [],
    ...seed
  };
  const callCounts: Record<string, number> = {};
  const admin = {
    from(table: string) {
      callCounts[table] = (callCounts[table] ?? 0) + 1;
      return { select: () => selectBuilder(tables[table] ?? []) };
    }
  };
  return { admin, tables, callCounts };
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn()
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest
}));

import { GET } from "@/app/api/ops/tenant-data/route";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ID_1 = "11111111-1111-4111-8111-111111111111";
const ID_2 = "22222222-2222-4222-8222-222222222222";
const ID_3 = "33333333-3333-4333-8333-333333333333";

function authorizeAs(admin: ReturnType<typeof createFakeAdmin>["admin"], tenantId = TENANT_A) {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: tenantId, role: "operator", suspended: false }
  });
}

function service(id: string, tenantId: string, overrides: Row = {}): Row {
  return { id, tenant_id: tenantId, date: "2026-08-15", arrival_date: null, departure_date: null, ...overrides };
}

function req(query: string) {
  return new NextRequest(`https://example.test/api/ops/tenant-data${query}`);
}

beforeEach(() => {
  mocks.authorizePricingRequest.mockReset();
});

describe("GET /api/ops/tenant-data — auth", () => {
  it("passes through whatever authorizePricingRequest returns unchanged (auth logic untouched)", async () => {
    const { NextResponse } = await import("next/server");
    const denied = NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    mocks.authorizePricingRequest.mockResolvedValue(denied);

    const res = await GET(req("?service_scope=date&date=2026-08-15&datasets=services"));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/ops/tenant-data — whitelist validation", () => {
  it("rejects an unknown dataset value with 400", async () => {
    const fake = createFakeAdmin();
    authorizeAs(fake.admin);
    const res = await GET(req("?service_scope=date&date=2026-08-15&datasets=services,not_a_real_dataset"));
    expect(res.status).toBe(400);
  });

  it("rejects an unknown service_scope mode with 400 (active is not implemented yet)", async () => {
    const fake = createFakeAdmin();
    authorizeAs(fake.admin);
    const res = await GET(req("?service_scope=active&datasets=services"));
    expect(res.status).toBe(400);
  });

  it("rejects an invalid date with 400", async () => {
    const fake = createFakeAdmin();
    authorizeAs(fake.admin);
    const res = await GET(req("?service_scope=date&date=15-08-2026&datasets=services"));
    expect(res.status).toBe(400);
  });

  it("rejects from > to with 400", async () => {
    const fake = createFakeAdmin();
    authorizeAs(fake.admin);
    const res = await GET(req("?service_scope=range&from=2026-08-20&to=2026-08-10&datasets=services"));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/ops/tenant-data — date scope", () => {
  it("returns only services touching the requested date", async () => {
    const fake = createFakeAdmin({
      services: [
        service(ID_1, TENANT_A, { date: "2026-08-15" }),
        service(ID_2, TENANT_A, { date: "2026-08-16" }),
        service(ID_3, TENANT_A, { arrival_date: "2026-08-15", date: "2026-09-01" })
      ]
    });
    authorizeAs(fake.admin);
    const res = await GET(req("?service_scope=date&date=2026-08-15&datasets=services"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.services.map((s: Row) => s.id).sort()).toEqual([ID_1, ID_3]);
  });
});

describe("GET /api/ops/tenant-data — range scope", () => {
  it("returns only services within the requested range", async () => {
    const fake = createFakeAdmin({
      services: [
        service(ID_1, TENANT_A, { date: "2026-08-09" }),
        service(ID_2, TENANT_A, { date: "2026-08-12" }),
        service(ID_3, TENANT_A, { date: "2026-08-21" })
      ]
    });
    authorizeAs(fake.admin);
    const res = await GET(req("?service_scope=range&from=2026-08-10&to=2026-08-20&datasets=services"));
    const body = await res.json();
    expect(body.services.map((s: Row) => s.id)).toEqual([ID_2]);
  });
});

describe("GET /api/ops/tenant-data — ids scope", () => {
  it("returns only the requested ids", async () => {
    const fake = createFakeAdmin({
      services: [service(ID_1, TENANT_A), service(ID_2, TENANT_A), service(ID_3, TENANT_A)]
    });
    authorizeAs(fake.admin);
    const res = await GET(req(`?service_scope=ids&ids=${ID_1},${ID_3}&datasets=services`));
    const body = await res.json();
    expect(body.services.map((s: Row) => s.id).sort()).toEqual([ID_1, ID_3]);
  });
});

describe("GET /api/ops/tenant-data — datasets are optional", () => {
  it("does not query a dataset that wasn't requested", async () => {
    const fake = createFakeAdmin({ services: [service(ID_1, TENANT_A)], hotels: [{ id: "h1", tenant_id: TENANT_A }] });
    authorizeAs(fake.admin);
    const res = await GET(req(`?service_scope=ids&ids=${ID_1}&datasets=services`));
    const body = await res.json();
    expect(body.hotels).toEqual([]);
    expect(fake.callCounts.hotels ?? 0).toBe(0);
  });
});

describe("GET /api/ops/tenant-data — assignments/status_events cascade to scoped services", () => {
  it("limits assignments to the returned service ids, not the whole tenant", async () => {
    const fake = createFakeAdmin({
      services: [service(ID_1, TENANT_A, { date: "2026-08-15" })],
      assignments: [
        { id: "a1", tenant_id: TENANT_A, service_id: ID_1 },
        { id: "a2", tenant_id: TENANT_A, service_id: ID_2 } // belongs to a service NOT in scope
      ]
    });
    authorizeAs(fake.admin);
    const res = await GET(req("?service_scope=date&date=2026-08-15&datasets=services,assignments"));
    const body = await res.json();
    expect(body.assignments.map((a: Row) => a.id)).toEqual(["a1"]);
  });

  it("limits status_events to the returned service ids", async () => {
    const fake = createFakeAdmin({
      services: [service(ID_1, TENANT_A, { date: "2026-08-15" })],
      status_events: [
        { id: "e1", tenant_id: TENANT_A, service_id: ID_1 },
        { id: "e2", tenant_id: TENANT_A, service_id: ID_2 }
      ]
    });
    authorizeAs(fake.admin);
    const res = await GET(req("?service_scope=date&date=2026-08-15&datasets=services,statusEvents"));
    const body = await res.json();
    expect(body.status_events.map((e: Row) => e.id)).toEqual(["e1"]);
  });

  it("does not query assignments at all when zero services are in scope", async () => {
    const fake = createFakeAdmin({ services: [], assignments: [{ id: "a1", tenant_id: TENANT_A, service_id: ID_1 }] });
    authorizeAs(fake.admin);
    const res = await GET(req("?service_scope=date&date=2026-08-15&datasets=services,assignments"));
    const body = await res.json();
    expect(body.assignments).toEqual([]);
    expect(fake.callCounts.assignments ?? 0).toBe(0);
  });

  it("does not query status_events at all when zero services are in scope", async () => {
    const fake = createFakeAdmin({ services: [], status_events: [{ id: "e1", tenant_id: TENANT_A, service_id: ID_1 }] });
    authorizeAs(fake.admin);
    const res = await GET(req("?service_scope=date&date=2026-08-15&datasets=services,statusEvents"));
    const body = await res.json();
    expect(body.status_events).toEqual([]);
    expect(fake.callCounts.status_events ?? 0).toBe(0);
  });
});

describe("GET /api/ops/tenant-data — tenant isolation", () => {
  it("never returns another tenant's services for a date scope", async () => {
    const fake = createFakeAdmin({
      services: [service(ID_1, TENANT_A, { date: "2026-08-15" }), service(ID_2, TENANT_B, { date: "2026-08-15" })]
    });
    authorizeAs(fake.admin, TENANT_A);
    const res = await GET(req("?service_scope=date&date=2026-08-15&datasets=services"));
    const body = await res.json();
    expect(body.services.map((s: Row) => s.id)).toEqual([ID_1]);
  });

  it("never returns another tenant's services for an ids scope", async () => {
    const fake = createFakeAdmin({ services: [service(ID_1, TENANT_B)] });
    authorizeAs(fake.admin, TENANT_A);
    const res = await GET(req(`?service_scope=ids&ids=${ID_1}&datasets=services`));
    const body = await res.json();
    expect(body.services).toEqual([]);
  });
});

describe("GET /api/ops/tenant-data — legacy default", () => {
  it("keeps returning every dataset when no service_scope param is present", async () => {
    const fake = createFakeAdmin({
      services: [service(ID_1, TENANT_A)],
      hotels: [{ id: "h1", tenant_id: TENANT_A }],
      memberships: [{ user_id: "u1", tenant_id: TENANT_A, role: "driver", full_name: "Mario" }]
    });
    authorizeAs(fake.admin);
    const res = await GET(req(""));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.services.map((s: Row) => s.id)).toEqual([ID_1]);
    expect(body.hotels).toHaveLength(1);
    expect(body.memberships).toHaveLength(1);
    expect(body.inbound_emails).toEqual([]);
  });

  it("legacy path with include_inbound_emails=true still includes inbound emails", async () => {
    const fake = createFakeAdmin({ inbound_emails: [{ id: "ie1", tenant_id: TENANT_A }] });
    authorizeAs(fake.admin);
    const res = await GET(req("?include_inbound_emails=true"));
    const body = await res.json();
    expect(body.inbound_emails).toHaveLength(1);
  });
});

/**
 * Sprint Performance 14D — the legacy branch (no service_scope, or
 * service_scope=legacy) now honors `datasets` too, instead of always
 * fetching every table regardless of what's requested. `datasets` absent
 * entirely still means "fetch everything" (case 1, already covered by the
 * "legacy default" tests above) — these cover `datasets` PRESENT in legacy
 * mode.
 */
describe("GET /api/ops/tenant-data — legacy path respects `datasets`", () => {
  function fullFixture() {
    return createFakeAdmin({
      services: [service(ID_1, TENANT_A)],
      assignments: [{ id: "a1", tenant_id: TENANT_A, service_id: ID_1 }],
      status_events: [{ id: "e1", tenant_id: TENANT_A, service_id: ID_1 }],
      hotels: [{ id: "h1", tenant_id: TENANT_A }],
      memberships: [{ user_id: "u1", tenant_id: TENANT_A, role: "driver", full_name: "Mario" }],
      bus_lot_configs: [{ id: "b1", tenant_id: TENANT_A }],
      inbound_emails: [{ id: "ie1", tenant_id: TENANT_A }]
    });
  }

  it("1. legacy, no `datasets` param at all: every table is still queried (full backward-compat)", async () => {
    const fake = fullFixture();
    authorizeAs(fake.admin);
    const res = await GET(req(""));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.services).toHaveLength(1);
    expect(body.assignments).toHaveLength(1);
    expect(body.status_events).toHaveLength(1);
    expect(body.hotels).toHaveLength(1);
    expect(body.memberships).toHaveLength(1);
    expect(body.bus_lot_configs).toHaveLength(1);
    // inbound_emails follows the pre-existing include_inbound_emails flag, absent here.
    expect(body.inbound_emails).toEqual([]);
    expect(fake.callCounts.assignments ?? 0).toBeGreaterThan(0);
    expect(fake.callCounts.hotels ?? 0).toBeGreaterThan(0);
    expect(fake.callCounts.memberships ?? 0).toBeGreaterThan(0);
    expect(fake.callCounts.bus_lot_configs ?? 0).toBeGreaterThan(0);
    expect(fake.callCounts.status_events ?? 0).toBeGreaterThan(0);
  });

  it("2. legacy, datasets=services: only services is queried", async () => {
    const fake = fullFixture();
    authorizeAs(fake.admin);
    const res = await GET(req("?datasets=services"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.services).toHaveLength(1);
    expect(body.assignments).toEqual([]);
    expect(body.status_events).toEqual([]);
    expect(body.hotels).toEqual([]);
    expect(body.memberships).toEqual([]);
    expect(body.bus_lot_configs).toEqual([]);
    expect(body.inbound_emails).toEqual([]);
    expect(fake.callCounts.assignments ?? 0).toBe(0);
    expect(fake.callCounts.status_events ?? 0).toBe(0);
    expect(fake.callCounts.hotels ?? 0).toBe(0);
    expect(fake.callCounts.memberships ?? 0).toBe(0);
    expect(fake.callCounts.bus_lot_configs ?? 0).toBe(0);
    expect(fake.callCounts.inbound_emails ?? 0).toBe(0);
  });

  it("3. legacy, datasets=hotels: zero fetchAllServices, only hotels queried", async () => {
    const fake = fullFixture();
    authorizeAs(fake.admin);
    const res = await GET(req("?datasets=hotels"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.services).toEqual([]);
    expect(body.hotels).toHaveLength(1);
    expect(fake.callCounts.services ?? 0).toBe(0);
    expect(fake.callCounts.assignments ?? 0).toBe(0);
    expect(fake.callCounts.status_events ?? 0).toBe(0);
    expect(fake.callCounts.memberships ?? 0).toBe(0);
    expect(fake.callCounts.bus_lot_configs ?? 0).toBe(0);
    expect(fake.callCounts.inbound_emails ?? 0).toBe(0);
  });

  it("4. legacy, datasets=services,hotels: services + hotels queried, nothing else", async () => {
    const fake = fullFixture();
    authorizeAs(fake.admin);
    const res = await GET(req("?datasets=services,hotels"));
    const body = await res.json();
    expect(body.services).toHaveLength(1);
    expect(body.hotels).toHaveLength(1);
    expect(body.assignments).toEqual([]);
    expect(body.status_events).toEqual([]);
    expect(body.memberships).toEqual([]);
    expect(body.bus_lot_configs).toEqual([]);
    expect(body.inbound_emails).toEqual([]);
    expect(fake.callCounts.assignments ?? 0).toBe(0);
    expect(fake.callCounts.status_events ?? 0).toBe(0);
    expect(fake.callCounts.memberships ?? 0).toBe(0);
    expect(fake.callCounts.bus_lot_configs ?? 0).toBe(0);
  });

  it("5. legacy, datasets=assignments,memberships: assignments + memberships queried, zero services", async () => {
    const fake = fullFixture();
    authorizeAs(fake.admin);
    const res = await GET(req("?datasets=assignments,memberships"));
    const body = await res.json();
    expect(body.assignments).toHaveLength(1);
    expect(body.memberships).toHaveLength(1);
    expect(body.services).toEqual([]);
    expect(fake.callCounts.services ?? 0).toBe(0);
    expect(fake.callCounts.hotels ?? 0).toBe(0);
    expect(fake.callCounts.status_events ?? 0).toBe(0);
    expect(fake.callCounts.bus_lot_configs ?? 0).toBe(0);
    expect(fake.callCounts.inbound_emails ?? 0).toBe(0);
  });

  it("6. legacy, datasets=inboundEmails: only inbound emails queried", async () => {
    const fake = fullFixture();
    authorizeAs(fake.admin);
    const res = await GET(req("?datasets=inboundEmails"));
    const body = await res.json();
    expect(body.inbound_emails).toHaveLength(1);
    expect(body.services).toEqual([]);
    expect(fake.callCounts.services ?? 0).toBe(0);
    expect(fake.callCounts.assignments ?? 0).toBe(0);
    expect(fake.callCounts.status_events ?? 0).toBe(0);
    expect(fake.callCounts.hotels ?? 0).toBe(0);
    expect(fake.callCounts.memberships ?? 0).toBe(0);
    expect(fake.callCounts.bus_lot_configs ?? 0).toBe(0);
  });

  it("7. legacy, an invalid dataset value: 400, consistent with the scoped branch's whitelist", async () => {
    const fake = fullFixture();
    authorizeAs(fake.admin);
    const res = await GET(req("?datasets=services,not_a_real_dataset"));
    expect(res.status).toBe(400);
  });

  it("include_inbound_emails=true still works as a legacy alias even when datasets is present but omits inboundEmails", async () => {
    const fake = fullFixture();
    authorizeAs(fake.admin);
    const res = await GET(req("?datasets=services&include_inbound_emails=true"));
    const body = await res.json();
    expect(body.inbound_emails).toHaveLength(1);
  });

  it("datasets=[] (empty) requests nothing at all, including services", async () => {
    const fake = fullFixture();
    authorizeAs(fake.admin);
    const res = await GET(req("?datasets="));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.services).toEqual([]);
    expect(fake.callCounts.services ?? 0).toBe(0);
    expect(fake.callCounts.hotels ?? 0).toBe(0);
  });
});
