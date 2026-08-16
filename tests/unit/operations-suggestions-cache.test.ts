import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Sprint Performance 14F — FASE 7/12. Proves the existing server cache in
 * GET /api/ops/suggestions (key `${tenantId}:static`, TTL raised to 45s to
 * stay >= the unchanged 30s client poll interval) is tenant-safe and
 * actually avoids a DB round-trip on a hit: first request computes, a
 * second request for the SAME tenant within TTL is served from cache with
 * zero additional `services` queries, a different tenant never reads the
 * other tenant's cached entry, and a request issued after TTL expiry
 * recomputes. Each scenario uses its own tenant id so the module-level
 * cache Map (which persists for the lifetime of this test file's module
 * instance) can never leak state between `it()` blocks.
 */

type Row = Record<string, unknown>;

function selectBuilder(rows: Row[]) {
  let filtered = [...rows];
  const builder = {
    eq(field: string, value: unknown) {
      filtered = filtered.filter((r) => String(r[field] ?? "") === String(value));
      return builder;
    },
    not() {
      return builder;
    },
    order() {
      return builder;
    },
    range() {
      return builder;
    },
    maybeSingle() {
      return Promise.resolve({ data: filtered[0] ?? null, error: null });
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
    hotels: [],
    bus_lot_configs: [],
    operations_suggestions: [],
    ...seed
  };
  const selectCalls: Array<{ table: string }> = [];
  const admin = {
    from(table: string) {
      return {
        select: (_cols?: unknown) => {
          selectCalls.push({ table });
          return selectBuilder(tables[table] ?? []);
        }
      };
    }
  } as any;
  return { admin, selectCalls };
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn()
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest
}));

import { GET } from "@/app/api/ops/suggestions/route";

function authorizeAs(admin: any, tenantId: string) {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: tenantId, role: "operator", suspended: false }
  });
}

function req() {
  return new NextRequest("https://example.test/api/ops/suggestions", {
    headers: { authorization: "Bearer token" }
  });
}

describe("GET /api/ops/suggestions — cache", () => {
  beforeEach(() => {
    mocks.authorizePricingRequest.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("computes on the first request, then serves a second request for the same tenant from cache within TTL without re-querying services", async () => {
    const TENANT = "cache-hit-tenant";
    const { admin, selectCalls } = createFakeAdmin();
    authorizeAs(admin, TENANT);

    const res1 = await GET(req());
    const body1 = await res1.json();
    expect(body1.ok).toBe(true);
    expect(body1.cached).toBe(false);
    const servicesQueriesAfterFirst = selectCalls.filter((c) => c.table === "services").length;
    expect(servicesQueriesAfterFirst).toBeGreaterThan(0);

    const res2 = await GET(req());
    const body2 = await res2.json();
    expect(body2.cached).toBe(true);
    expect(body2.suggestions).toEqual(body1.suggestions);
    expect(selectCalls.filter((c) => c.table === "services").length).toBe(servicesQueriesAfterFirst);
  });

  it("keeps tenant caches fully separate — a warm cache for one tenant never serves another tenant", async () => {
    const TENANT_A = "iso-tenant-a";
    const TENANT_B = "iso-tenant-b";

    const { admin: adminA } = createFakeAdmin();
    authorizeAs(adminA, TENANT_A);
    const resA1 = await GET(req());
    expect((await resA1.json()).cached).toBe(false);
    const resA2 = await GET(req());
    expect((await resA2.json()).cached).toBe(true);

    const { admin: adminB, selectCalls: selectCallsB } = createFakeAdmin();
    authorizeAs(adminB, TENANT_B);
    const resB1 = await GET(req());
    const bodyB1 = await resB1.json();
    expect(bodyB1.cached).toBe(false);
    expect(selectCallsB.filter((c) => c.table === "services").length).toBeGreaterThan(0);
  });

  it("recomputes once the cache TTL (45s) has expired", async () => {
    const TENANT = "ttl-tenant";
    const { admin, selectCalls } = createFakeAdmin();
    authorizeAs(admin, TENANT);

    const res1 = await GET(req());
    expect((await res1.json()).cached).toBe(false);
    const servicesQueriesAfterFirst = selectCalls.filter((c) => c.table === "services").length;

    const res2 = await GET(req());
    expect((await res2.json()).cached).toBe(true);

    vi.setSystemTime(new Date("2026-08-16T10:00:46.000Z")); // +46s > 45s TTL
    const res3 = await GET(req());
    expect((await res3.json()).cached).toBe(false);
    expect(selectCalls.filter((c) => c.table === "services").length).toBeGreaterThan(servicesQueriesAfterFirst);
  });
});
