import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Sprint Performance 13 — targeted fix — GET /api/ops/services-nearest-date.
 *
 * Covers: auth passthrough unchanged, finds the earliest date with data
 * (including far outside any 21-day window — this endpoint never windows),
 * never requests full rows (`select("*")`), tenant isolation, the "nothing
 * found" case, and — the follow-up fix covered here — that the LIMIT 200
 * candidate budget per query is spent only on rows that can actually produce
 * an instance (is_draft/status pre-filtered in SQL), with a deterministic
 * `id` tie-break, so >200 draft/cancelled rows older than the true earliest
 * valid service can never crowd it out of the window.
 */

type Row = Record<string, unknown>;

function evalOrClause(row: Row, clause: string): boolean {
  const match = clause.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.(eq|is)\.(.*)$/);
  if (!match) return false;
  const [, field, op, rawValue] = match;
  if (op === "is") {
    const isNull = row[field] === null || row[field] === undefined;
    return rawValue === "null" ? isNull : String(row[field]) === rawValue;
  }
  return String(row[field] ?? "") === rawValue;
}

function selectSpy(rows: Row[]) {
  let filtered = rows;
  const orderKeys: Array<{ field: string; ascending: boolean }> = [];
  let limitValue: number | null = null;

  const builder = {
    eq(field: string, value: unknown) {
      filtered = filtered.filter((r) => String(r[field] ?? "") === String(value));
      return builder;
    },
    neq(field: string, value: unknown) {
      filtered = filtered.filter((r) => String(r[field] ?? "") !== String(value));
      return builder;
    },
    or(filterStr: string) {
      const clauses = filterStr.split(",");
      filtered = filtered.filter((r) => clauses.some((clause) => evalOrClause(r, clause)));
      return builder;
    },
    not(field: string, _op: string, _value: unknown) {
      filtered = filtered.filter((r) => r[field] !== null && r[field] !== undefined);
      return builder;
    },
    order(field: string, opts: { ascending?: boolean } = {}) {
      // Multiple .order() calls compose as a real ORDER BY would: the first
      // call is the primary key, later calls are tie-breakers — not
      // independent, overriding re-sorts.
      orderKeys.push({ field, ascending: opts.ascending !== false });
      return builder;
    },
    limit(n: number) {
      limitValue = n;
      return builder;
    },
    then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
      let result = [...filtered];
      if (orderKeys.length > 0) {
        result.sort((a, b) => {
          for (const { field, ascending } of orderKeys) {
            const av = String(a[field] ?? "");
            const bv = String(b[field] ?? "");
            if (av !== bv) return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
          }
          return 0;
        });
      }
      // Sort happens BEFORE limit is applied — matches real SQL ORDER BY ... LIMIT n.
      if (limitValue !== null) result = result.slice(0, limitValue);
      return Promise.resolve({ data: result, error: null }).then(resolve, reject);
    }
  };
  return builder;
}

function createFakeAdmin(seed: Partial<Record<string, Row[]>> = {}) {
  const tables: Record<string, Row[]> = { services: [], ...seed };
  const selectCalls: string[] = [];
  const admin = {
    from(table: string) {
      return {
        select: (columns: string) => {
          selectCalls.push(columns);
          return selectSpy(tables[table] ?? []);
        }
      };
    }
  };
  return { admin, tables, selectCalls };
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn()
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest
}));

import { GET } from "@/app/api/ops/services-nearest-date/route";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function authorizeAs(admin: ReturnType<typeof createFakeAdmin>["admin"], tenantId = TENANT_A) {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: tenantId, role: "operator", suspended: false }
  });
}

function service(id: string, tenantId: string, overrides: Row = {}): Row {
  return {
    id,
    tenant_id: tenantId,
    date: "2026-08-15",
    arrival_date: null,
    departure_date: null,
    direction: "arrival",
    linked_service_id: null,
    is_draft: false,
    status: "confermato",
    customer_name: "Mario Rossi",
    ...overrides
  };
}

function req() {
  return new NextRequest("https://example.test/api/ops/services-nearest-date");
}

beforeEach(() => {
  mocks.authorizePricingRequest.mockReset();
});

describe("GET /api/ops/services-nearest-date — auth", () => {
  it("passes through whatever authorizePricingRequest returns unchanged", async () => {
    const { NextResponse } = await import("next/server");
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }));
    const res = await GET(req());
    expect(res.status).toBe(401);
  });
});

describe("GET /api/ops/services-nearest-date — finds the earliest date", () => {
  it("test 2: finds a date within a normal window", async () => {
    const fake = createFakeAdmin({
      services: [
        service("s1", TENANT_A, { date: "2026-08-20" }),
        service("s2", TENANT_A, { date: "2026-08-05" })
      ]
    });
    authorizeAs(fake.admin);
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.date).toBe("2026-08-05");
  });

  it("test 3: finds a date far outside any 21-day window (no windowing at all)", async () => {
    const fake = createFakeAdmin({
      services: [
        service("s1", TENANT_A, { date: "2026-08-15" }),
        service("s2", TENANT_A, { date: "2024-01-10" }) // ~2.5 years before "today"
      ]
    });
    authorizeAs(fake.admin);
    const res = await GET(req());
    const body = await res.json();
    expect(body.date).toBe("2024-01-10");
  });

  it("prefers an arrival_date override over the fallback `date` column", async () => {
    const fake = createFakeAdmin({
      services: [service("s1", TENANT_A, { date: "2026-08-20", arrival_date: "2026-01-01", direction: "departure" })]
    });
    authorizeAs(fake.admin);
    const res = await GET(req());
    const body = await res.json();
    expect(body.date).toBe("2026-01-01");
  });

  it("respects cancelled/draft filtering via the unchanged buildOperationalInstances", async () => {
    const fake = createFakeAdmin({
      services: [
        service("s1", TENANT_A, { date: "2026-01-01", status: "cancelled" }),
        service("s2", TENANT_A, { date: "2026-06-01", is_draft: true }),
        service("s3", TENANT_A, { date: "2026-08-15" })
      ]
    });
    authorizeAs(fake.admin);
    const res = await GET(req());
    const body = await res.json();
    expect(body.date).toBe("2026-08-15");
  });
});

describe("GET /api/ops/services-nearest-date — LIMIT 200 mathematical guarantee", () => {
  it("finds the historical date even with 250 recent records ahead of it", async () => {
    const recent = Array.from({ length: 250 }, (_, i) =>
      service(`recent-${i}`, TENANT_A, { date: `2027-01-${String((i % 28) + 1).padStart(2, "0")}` })
    );
    const historical = service("old-1", TENANT_A, { date: "2019-03-04" });
    const fake = createFakeAdmin({ services: [...recent, historical] });
    authorizeAs(fake.admin);
    const res = await GET(req());
    const body = await res.json();
    expect(body.date).toBe("2019-03-04");
  });

  it("is not crowded out of the LIMIT 200 window by 250 older draft/cancelled rows (the actual fix)", async () => {
    // 250 rows dated even OLDER than the one valid service, but none of them
    // can ever produce an instance (draft or cancelled). Without SQL-side
    // is_draft/status filtering, an ascending ORDER BY date LIMIT 200 would
    // fill its entire candidate budget with these 250 rows (they sort first,
    // being older) and never even see the valid, slightly-less-old service —
    // silently returning the wrong (later) date, or null.
    const noise = Array.from({ length: 250 }, (_, i) => {
      const date = `2010-01-${String((i % 28) + 1).padStart(2, "0")}`;
      return i % 2 === 0
        ? service(`cancelled-${i}`, TENANT_A, { date, status: "cancelled" })
        : service(`draft-${i}`, TENANT_A, { date, is_draft: true });
    });
    const valid = service("valid-1", TENANT_A, { date: "2015-06-15" });
    const fake = createFakeAdmin({ services: [...noise, valid] });
    authorizeAs(fake.admin);
    const res = await GET(req());
    const body = await res.json();
    expect(body.date).toBe("2015-06-15");
  });

  it("applies a deterministic id tie-break so equal-date candidates aren't dropped non-deterministically", async () => {
    const sameDate = Array.from({ length: 5 }, (_, i) => service(`s${i}`, TENANT_A, { date: "2020-01-01" }));
    const fake = createFakeAdmin({ services: sameDate });
    authorizeAs(fake.admin);
    const res = await GET(req());
    const body = await res.json();
    expect(body.date).toBe("2020-01-01");
  });
});

describe("GET /api/ops/services-nearest-date — never downloads full rows", () => {
  it("test 4: only selects the narrow candidate column list, never '*'", async () => {
    const fake = createFakeAdmin({ services: [service("s1", TENANT_A)] });
    authorizeAs(fake.admin);
    await GET(req());
    expect(fake.selectCalls.length).toBeGreaterThan(0);
    for (const columns of fake.selectCalls) {
      expect(columns).not.toBe("*");
      expect(columns).toContain("id");
      expect(columns).toContain("date");
      expect(columns).not.toContain("notes");
      expect(columns).not.toContain("phone");
    }
  });
});

describe("GET /api/ops/services-nearest-date — tenant isolation", () => {
  it("never returns another tenant's earliest date", async () => {
    const fake = createFakeAdmin({
      services: [service("s1", TENANT_A, { date: "2026-08-15" }), service("s2", TENANT_B, { date: "2020-01-01" })]
    });
    authorizeAs(fake.admin, TENANT_A);
    const res = await GET(req());
    const body = await res.json();
    expect(body.date).toBe("2026-08-15");
  });
});

describe("GET /api/ops/services-nearest-date — nothing found", () => {
  it("returns date: null when the tenant has no operationally-visible services", async () => {
    const fake = createFakeAdmin({ services: [] });
    authorizeAs(fake.admin);
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.date).toBeNull();
  });
});
