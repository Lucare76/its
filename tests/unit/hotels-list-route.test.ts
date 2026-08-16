import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Sprint Performance 14C. GET /api/ops/hotels-list replaces
 * app/(app)/settings/shuttles/page.tsx's direct call to the legacy
 * GET /api/ops/tenant-data (which fetched the whole tenant's services
 * history + assignments/status_events/memberships/bus_lot_configs just to
 * read `hotels`). This endpoint returns only tenant-scoped hotels with a
 * minimal id/name projection.
 */

type Row = Record<string, unknown>;

function selectBuilder(rows: Row[]) {
  let filtered = [...rows];
  const builder = {
    eq(field: string, value: unknown) {
      filtered = filtered.filter((r) => String(r[field] ?? "") === String(value));
      return builder;
    },
    order() {
      return builder;
    },
    then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
    }
  };
  return builder;
}

function createFakeAdmin(seed: Partial<Record<string, Row[]>> = {}) {
  const tables: Record<string, Row[]> = { hotels: [], ...seed };
  const selectCalls: Array<{ table: string; cols: unknown }> = [];
  const admin = {
    from(table: string) {
      return {
        select: (cols?: unknown) => {
          selectCalls.push({ table, cols });
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

import { GET } from "@/app/api/ops/hotels-list/route";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function authorizeAs(admin: ReturnType<typeof createFakeAdmin>["admin"], tenantId = TENANT_A, role: "admin" | "operator" | "supervisor" = "operator") {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: tenantId, role, suspended: false }
  });
}

function req() {
  return new NextRequest("https://example.test/api/ops/hotels-list", {
    headers: { authorization: "Bearer token" }
  });
}

beforeEach(() => {
  mocks.authorizePricingRequest.mockReset();
});

describe("GET /api/ops/hotels-list — auth", () => {
  it("passes through whatever authorizePricingRequest returns unchanged (401)", async () => {
    const { NextResponse } = await import("next/server");
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "unauthorized" }, { status: 401 }));
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("calls authorizePricingRequest with the same roles as tenant-data", async () => {
    const { admin } = createFakeAdmin();
    authorizeAs(admin);
    await GET(req());
    expect(mocks.authorizePricingRequest).toHaveBeenCalledWith(expect.anything(), ["admin", "operator", "supervisor"]);
  });
});

describe("GET /api/ops/hotels-list — tenant isolation", () => {
  it("never returns another tenant's hotels", async () => {
    const { admin } = createFakeAdmin({
      hotels: [
        { id: "h1", tenant_id: TENANT_A, name: "Hotel A", zone: "Ischia Porto" },
        { id: "h2", tenant_id: TENANT_B, name: "Hotel B", zone: "Forio" }
      ]
    });
    authorizeAs(admin, TENANT_A);
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.hotels.map((h: Row) => h.id)).toEqual(["h1"]);
  });

  it("returns an empty list for a tenant with no hotels", async () => {
    const { admin } = createFakeAdmin({ hotels: [] });
    authorizeAs(admin, TENANT_A);
    const res = await GET(req());
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.hotels).toEqual([]);
  });
});

describe("GET /api/ops/hotels-list — minimal projection", () => {
  it("requests only id/name columns from Supabase (not select('*'))", async () => {
    const { admin, selectCalls } = createFakeAdmin({
      hotels: [{ id: "h1", tenant_id: TENANT_A, name: "Hotel Test", zone: "Ischia Porto", address: "Via Roma 1" }]
    });
    authorizeAs(admin, TENANT_A);
    await GET(req());
    const hotelsCall = selectCalls.find((call) => call.table === "hotels");
    expect(hotelsCall?.cols).toBe("id, name");
  });
});
