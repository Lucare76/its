import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Sprint Performance 14A — POST /api/services/list pagination tests.
 *
 * Covers: auth passthrough, tenant isolation, default/max page size, page 2,
 * has_more without a global count, search/status/date/type filters, ordering,
 * assignments/status_events/inbound_emails scoped to the returned page's
 * service ids (never the whole tenant), empty results, invalid params -> 400.
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

function ilikeMatch(value: unknown, pattern: string) {
  const inner = pattern.replace(/^%|%$/g, "").toLowerCase();
  return String(value ?? "").toLowerCase().includes(inner);
}

function evalOrClause(row: Row, clause: string): boolean {
  const match = clause.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.(ilike|eq|in)\.(.*)$/);
  if (!match) return false;
  const [, field, op, raw] = match;
  if (op === "ilike") return ilikeMatch(row[field], raw);
  if (op === "eq") return String(row[field] ?? "") === raw;
  if (op === "in") {
    const values = raw.replace(/^\(|\)$/g, "").split(",");
    return values.includes(String(row[field] ?? ""));
  }
  return false;
}

function selectBuilder(rows: Row[]) {
  let filtered = [...rows];
  const orderCriteria: Array<{ field: string; ascending: boolean }> = [];
  const applyOrder = () => {
    if (orderCriteria.length === 0) return;
    filtered = [...filtered].sort((a, b) => {
      for (const { field, ascending } of orderCriteria) {
        const left = String(a[field] ?? "");
        const right = String(b[field] ?? "");
        if (left === right) continue;
        const cmp = left < right ? -1 : 1;
        return ascending ? cmp : -cmp;
      }
      return 0;
    });
  };
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
    gte(field: string, value: unknown) {
      filtered = filtered.filter((r) => String(r[field] ?? "") >= String(value));
      return builder;
    },
    lte(field: string, value: unknown) {
      filtered = filtered.filter((r) => String(r[field] ?? "") <= String(value));
      return builder;
    },
    ilike(field: string, pattern: string) {
      filtered = filtered.filter((r) => ilikeMatch(r[field], pattern));
      return builder;
    },
    or(filterStr: string) {
      const clauses = splitTopLevelClauses(filterStr);
      filtered = filtered.filter((r) => clauses.some((clause) => evalOrClause(r, clause)));
      return builder;
    },
    order(field: string, options?: { ascending?: boolean }) {
      orderCriteria.push({ field, ascending: options?.ascending !== false });
      applyOrder();
      return builder;
    },
    range(from: number, to: number) {
      filtered = filtered.slice(from, to + 1);
      return builder;
    },
    then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
    }
  };
  return builder;
}

function failingSelectBuilder(error: { message: string; code?: string }) {
  const builder = {
    eq() {
      return builder;
    },
    in() {
      return builder;
    },
    gte() {
      return builder;
    },
    lte() {
      return builder;
    },
    ilike() {
      return builder;
    },
    or() {
      return builder;
    },
    order() {
      return builder;
    },
    range() {
      return builder;
    },
    then(resolve: (v: { data: null; error: { message: string; code?: string } }) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve({ data: null, error }).then(resolve, reject);
    }
  };
  return builder;
}

function createFakeAdmin(
  seed: Partial<Record<string, Row[]>> = {},
  failFromCalls: Partial<Record<string, number[]>> = {}
) {
  const tables: Record<string, Row[]> = {
    services: [],
    assignments: [],
    status_events: [],
    hotels: [],
    inbound_emails: [],
    ...seed
  };
  const callCounts: Record<string, number> = {};
  const admin = {
    from(table: string) {
      callCounts[table] = (callCounts[table] ?? 0) + 1;
      const fromCall = callCounts[table];
      return {
        select: () =>
          failFromCalls[table]?.includes(fromCall)
            ? failingSelectBuilder({ message: "temporary aggregate outage", code: "XX000" })
            : selectBuilder(tables[table] ?? [])
      };
    }
  };
  return { admin, tables, callCounts };
}

const mocks = vi.hoisted(() => ({
  authorizeServiceRoleRequest: vi.fn()
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizeServiceRoleRequest: mocks.authorizeServiceRoleRequest
}));

import { POST } from "@/app/api/services/list/route";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DRIVER_1 = "d1111111-1111-4111-8111-111111111111";

function authorizeAs(admin: ReturnType<typeof createFakeAdmin>["admin"], tenantId = TENANT_A, role: "admin" | "operator" | "agency" | "supervisor" = "operator") {
  mocks.authorizeServiceRoleRequest.mockResolvedValue({
    admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: tenantId, role, suspended: false, agency_id: null }
  });
}

function service(id: string, tenantId: string, overrides: Row = {}): Row {
  return {
    id,
    tenant_id: tenantId,
    date: "2026-08-15",
    time: "10:00",
    status: "new",
    customer_name: "Cliente Test",
    vessel: "Alilauro",
    ...overrides
  };
}

function req(body: Record<string, unknown>) {
  return new NextRequest("https://example.test/api/services/list", {
    method: "POST",
    headers: { authorization: "Bearer token", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  mocks.authorizeServiceRoleRequest.mockReset();
});

describe("POST /api/services/list — auth", () => {
  it("passes through whatever authorizeServiceRoleRequest returns unchanged (401)", async () => {
    const { NextResponse } = await import("next/server");
    mocks.authorizeServiceRoleRequest.mockResolvedValue(NextResponse.json({ error: "unauthorized" }, { status: 401 }));
    const res = await POST(req({ tenant_id: TENANT_A }));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/services/list — tenant isolation", () => {
  it("rejects a tenant_id different from the caller's membership (403)", async () => {
    const fake = createFakeAdmin();
    authorizeAs(fake.admin, TENANT_A);
    const res = await POST(req({ tenant_id: TENANT_B }));
    expect(res.status).toBe(403);
  });

  it("never returns another tenant's services", async () => {
    const fake = createFakeAdmin({
      services: [service("s1", TENANT_A), service("s2", TENANT_B)]
    });
    authorizeAs(fake.admin, TENANT_A);
    const res = await POST(req({ tenant_id: TENANT_A }));
    const body = await res.json();
    expect(body.services.map((s: Row) => s.id)).toEqual(["s1"]);
  });
});

describe("POST /api/services/list — invalid params", () => {
  it("rejects an invalid tenant_id (400)", async () => {
    const fake = createFakeAdmin();
    authorizeAs(fake.admin);
    const res = await POST(req({ tenant_id: "not-a-uuid" }));
    expect(res.status).toBe(400);
  });

  it("rejects page=0 (400)", async () => {
    const fake = createFakeAdmin();
    authorizeAs(fake.admin);
    const res = await POST(req({ tenant_id: TENANT_A, page: 0 }));
    expect(res.status).toBe(400);
  });

  it("rejects page_size over the max of 100 (400)", async () => {
    const fake = createFakeAdmin();
    authorizeAs(fake.admin);
    const res = await POST(req({ tenant_id: TENANT_A, page_size: 101 }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/services/list — pagination", () => {
  function seedMany(count: number) {
    return Array.from({ length: count }, (_, i) =>
      service(`s${String(i).padStart(3, "0")}`, TENANT_A, { date: "2026-08-01", time: `${String(8 + Math.floor(i / 10)).padStart(2, "0")}:${String(i % 10).padStart(2, "0")}` })
    );
  }

  it("defaults to page_size=50 and reports has_more when more rows exist", async () => {
    const fake = createFakeAdmin({ services: seedMany(60) });
    authorizeAs(fake.admin);
    const res = await POST(req({ tenant_id: TENANT_A }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.services).toHaveLength(50);
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(50);
    expect(body.has_more).toBe(true);
  });

  it("accepts page_size=100 (the max)", async () => {
    const fake = createFakeAdmin({ services: seedMany(60) });
    authorizeAs(fake.admin);
    const res = await POST(req({ tenant_id: TENANT_A, page_size: 100 }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.services).toHaveLength(60);
    expect(body.has_more).toBe(false);
  });

  it("returns the correct slice on page 2 and reports has_more=false on the last page", async () => {
    const fake = createFakeAdmin({ services: seedMany(5) });
    authorizeAs(fake.admin);
    const res = await POST(req({ tenant_id: TENANT_A, page: 2, page_size: 2 }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.services.map((s: Row) => s.id)).toEqual(["s002", "s003"]);
    expect(body.has_more).toBe(true);

    const lastRes = await POST(req({ tenant_id: TENANT_A, page: 3, page_size: 2 }));
    const lastBody = await lastRes.json();
    expect(lastBody.services.map((s: Row) => s.id)).toEqual(["s004"]);
    expect(lastBody.has_more).toBe(false);
  });

  it("orders by date then time ascending", async () => {
    const fake = createFakeAdmin({
      services: [
        service("late", TENANT_A, { date: "2026-08-16", time: "09:00" }),
        service("early", TENANT_A, { date: "2026-08-15", time: "09:00" }),
        service("midday", TENANT_A, { date: "2026-08-15", time: "14:00" })
      ]
    });
    authorizeAs(fake.admin);
    const res = await POST(req({ tenant_id: TENANT_A }));
    const body = await res.json();
    expect(body.services.map((s: Row) => s.id)).toEqual(["early", "midday", "late"]);
  });

  it("returns an empty result with has_more=false when nothing matches", async () => {
    const fake = createFakeAdmin({ services: [] });
    authorizeAs(fake.admin);
    const res = await POST(req({ tenant_id: TENANT_A }));
    const body = await res.json();
    expect(body.services).toEqual([]);
    expect(body.has_more).toBe(false);
  });
});

describe("POST /api/services/list — filters", () => {
  it("filters by status", async () => {
    const fake = createFakeAdmin({
      services: [service("s1", TENANT_A, { status: "new" }), service("s2", TENANT_A, { status: "cancelled" })]
    });
    authorizeAs(fake.admin);
    const res = await POST(req({ tenant_id: TENANT_A, status: ["new"] }));
    const body = await res.json();
    expect(body.services.map((s: Row) => s.id)).toEqual(["s1"]);
  });

  it("filters by dateFrom/dateTo", async () => {
    const fake = createFakeAdmin({
      services: [
        service("in-range", TENANT_A, { date: "2026-08-15" }),
        service("out-of-range", TENANT_A, { date: "2026-09-01" })
      ]
    });
    authorizeAs(fake.admin);
    const res = await POST(req({ tenant_id: TENANT_A, dateFrom: "2026-08-01", dateTo: "2026-08-31" }));
    const body = await res.json();
    expect(body.services.map((s: Row) => s.id)).toEqual(["in-range"]);
  });

  it("filters by service_type, treating null as transfer", async () => {
    const fake = createFakeAdmin({
      services: [
        service("transfer-null", TENANT_A, { service_type: null }),
        service("transfer-explicit", TENANT_A, { service_type: "transfer" }),
        service("bus", TENANT_A, { service_type: "bus_tour" })
      ]
    });
    authorizeAs(fake.admin);
    const res = await POST(req({ tenant_id: TENANT_A, service_type: "bus_tour" }));
    const body = await res.json();
    expect(body.services.map((s: Row) => s.id)).toEqual(["bus"]);
  });

  it("filters by search (customer_name)", async () => {
    const fake = createFakeAdmin({
      services: [service("match", TENANT_A, { customer_name: "Mario Rossi" }), service("nomatch", TENANT_A, { customer_name: "Luigi Bianchi" })]
    });
    authorizeAs(fake.admin);
    const res = await POST(req({ tenant_id: TENANT_A, search: "Rossi" }));
    const body = await res.json();
    expect(body.services.map((s: Row) => s.id)).toEqual(["match"]);
  });

  it("filters by driver_user_id via the assignments subquery", async () => {
    const fake = createFakeAdmin({
      services: [service("assigned-to-driver", TENANT_A), service("other", TENANT_A)],
      assignments: [{ id: "a1", tenant_id: TENANT_A, service_id: "assigned-to-driver", driver_user_id: DRIVER_1, vehicle_label: "VAN" }]
    });
    authorizeAs(fake.admin);
    const res = await POST(req({ tenant_id: TENANT_A, driver_user_id: DRIVER_1 }));
    const body = await res.json();
    expect(body.services.map((s: Row) => s.id)).toEqual(["assigned-to-driver"]);
  });
});

describe("POST /api/services/list — relational data is scoped to the page", () => {
  it("limits assignments/status_events to the returned page's service ids, not the whole tenant", async () => {
    const fake = createFakeAdmin({
      services: [service("s1", TENANT_A)],
      assignments: [
        { id: "a1", tenant_id: TENANT_A, service_id: "s1", driver_user_id: DRIVER_1, vehicle_label: "VAN" },
        { id: "a2", tenant_id: TENANT_A, service_id: "s-not-in-page", driver_user_id: DRIVER_1, vehicle_label: "CAR" }
      ],
      status_events: [
        { id: "e1", tenant_id: TENANT_A, service_id: "s1", status: "new", at: "2026-08-15T09:00:00Z", by_user_id: "u1" },
        { id: "e2", tenant_id: TENANT_A, service_id: "s-not-in-page", status: "new", at: "2026-08-15T09:00:00Z", by_user_id: "u1" }
      ]
    });
    authorizeAs(fake.admin);
    const res = await POST(req({ tenant_id: TENANT_A }));
    const body = await res.json();
    expect(body.assignments.map((a: Row) => a.id)).toEqual(["a1"]);
    expect(body.status_events.map((e: Row) => e.id)).toEqual(["e1"]);
  });

  it("does not query assignments/status_events/inbound_emails at all when the page has zero services", async () => {
    const fake = createFakeAdmin({
      services: [],
      assignments: [{ id: "a1", tenant_id: TENANT_A, service_id: "s1", driver_user_id: null, vehicle_label: "VAN" }]
    });
    authorizeAs(fake.admin);
    const res = await POST(req({ tenant_id: TENANT_A }));
    const body = await res.json();
    expect(body.assignments).toEqual([]);
    expect(fake.callCounts.assignments ?? 0).toBe(0);
    expect(fake.callCounts.status_events ?? 0).toBe(0);
    expect(fake.callCounts.inbound_emails ?? 0).toBe(0);
  });

  it("scopes inbound_emails to the page's inbound_email_id foreign keys only", async () => {
    const fake = createFakeAdmin({
      services: [service("s1", TENANT_A, { inbound_email_id: "ie1" })],
      inbound_emails: [
        { id: "ie1", tenant_id: TENANT_A, raw_text: "linked" },
        { id: "ie2", tenant_id: TENANT_A, raw_text: "not linked to any service on this page" }
      ]
    });
    authorizeAs(fake.admin);
    const res = await POST(req({ tenant_id: TENANT_A }));
    const body = await res.json();
    expect(body.inbound_emails.map((e: Row) => e.id)).toEqual(["ie1"]);
  });
});

/**
 * Sprint Performance 14A FIX — regression tests (mandatory test plan A-E, G).
 * Stats, the source/reviewed/agency/quality filters, and vessel dropdown
 * options must reflect the whole filtered dataset, never just the current page.
 */
describe("POST /api/services/list — dataset-wide stats, filters and dropdown options", () => {
  function seedMany(count: number, overrideAt: Record<number, Row> = {}) {
    return Array.from({ length: count }, (_, i) =>
      service(`s${String(i).padStart(3, "0")}`, TENANT_A, {
        date: "2026-08-01",
        time: `${String(8 + Math.floor(i / 10)).padStart(2, "0")}:${String(i % 10).padStart(2, "0")}`,
        ...(overrideAt[i] ?? {})
      })
    );
  }

  it("A: stats.totale represents the whole 300-row dataset, not just the 50-row page", async () => {
    const fake = createFakeAdmin({ services: seedMany(300) });
    authorizeAs(fake.admin);
    const res = await POST(req({ tenant_id: TENANT_A }));
    const body = await res.json();
    expect(body.services).toHaveLength(50);
    expect(body.stats.totale).toBe(300);
  });

  it("A2: aggregate failure without advanced filters keeps the list visible and marks stats unavailable", async () => {
    const fake = createFakeAdmin({ services: seedMany(3) }, { services: [1] });
    authorizeAs(fake.admin);
    const res = await POST(req({ tenant_id: TENANT_A }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.services).toHaveLength(3);
    expect(body.stats_available).toBe(false);
    expect(body.stats_error).toBe("Statistiche non disponibili.");
    expect(body.stats.totale).toBe(0);
  });

  it("B: reviewed=no finds a record that only exists beyond page 1", async () => {
    const services = seedMany(60, {
      55: { notes: "[source:pdf]" } // not reviewed: isPdf without a manual_review marker
    });
    for (let i = 0; i < 60; i++) {
      if (i !== 55) services[i].notes = "[source:pdf][manual_review:true]"; // reviewed=yes filler
    }
    const fake = createFakeAdmin({ services });
    authorizeAs(fake.admin);
    const res = await POST(req({ tenant_id: TENANT_A, reviewed: "no" }));
    const body = await res.json();
    expect(body.services.map((s: Row) => s.id)).toEqual(["s055"]);
    expect(body.stats.totale).toBe(1);
  });

  it("C: an origine-import (source) value present only beyond page 1 is still found", async () => {
    // lib/service-pdf-metadata.ts's isPdf-always-true bug is fixed (see
    // lib/service-pdf-metadata.ts + tests/unit/service-pdf-metadata.test.ts),
    // so source="pdf" now correctly discriminates: only s055 carries the PDF
    // marker, the other 59 filler rows are plain manual services.
    const services = seedMany(60, { 55: { notes: "[source:pdf]" } });
    const fake = createFakeAdmin({ services });
    authorizeAs(fake.admin);
    const res = await POST(req({ tenant_id: TENANT_A, source: "pdf" }));
    const body = await res.json();
    expect(body.services.map((s: Row) => s.id)).toEqual(["s055"]);
    expect(body.stats.totale).toBe(1);
  });

  it("D: agency and parsing-quality filters apply globally, matching lib/service-pdf-metadata.ts semantics", async () => {
    const services = seedMany(60, {
      55: { notes: "[source:pdf]", inbound_email_id: "ie-agency" }
    });
    const fake = createFakeAdmin({
      services,
      inbound_emails: [
        {
          id: "ie-agency",
          tenant_id: TENANT_A,
          parsed_json: { pdf_import: { normalized: { agency_name: "Agenzia Target" } } }
        }
      ]
    });
    authorizeAs(fake.admin);
    const agencyRes = await POST(req({ tenant_id: TENANT_A, agency: "Agenzia Target" }));
    const agencyBody = await agencyRes.json();
    expect(agencyBody.services.map((s: Row) => s.id)).toEqual(["s055"]);

    const qualityServices = seedMany(60, { 55: { notes: "[source:pdf][parsing_quality:low]" } });
    const qualityFake = createFakeAdmin({ services: qualityServices });
    authorizeAs(qualityFake.admin);
    const qualityRes = await POST(req({ tenant_id: TENANT_A, quality: "low" }));
    const qualityBody = await qualityRes.json();
    expect(qualityBody.services.map((s: Row) => s.id)).toEqual(["s055"]);
  });

  it("E: a vessel present only in service #250 shows up in known_vessels without visiting page 5", async () => {
    const services = seedMany(300, { 250: { vessel: "RaroNave" } });
    const fake = createFakeAdmin({ services });
    authorizeAs(fake.admin);
    const res = await POST(req({ tenant_id: TENANT_A }));
    const body = await res.json();
    expect(body.services.map((s: Row) => s.vessel)).not.toContain("RaroNave");
    expect(body.known_vessels).toContain("RaroNave");
  });

  it("G: pagination stays 50 default / 100 max even with dataset-wide aggregates active", async () => {
    const fake = createFakeAdmin({ services: seedMany(150) });
    authorizeAs(fake.admin);
    const defaultRes = await POST(req({ tenant_id: TENANT_A }));
    expect((await defaultRes.json()).services).toHaveLength(50);
    const maxRes = await POST(req({ tenant_id: TENANT_A, page_size: 100 }));
    expect((await maxRes.json()).services).toHaveLength(100);
    const overMaxRes = await POST(req({ tenant_id: TENANT_A, page_size: 101 }));
    expect(overMaxRes.status).toBe(400);
  });
});
