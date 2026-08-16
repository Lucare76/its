import { describe, expect, it } from "vitest";
import { computeDashboardData } from "@/lib/server/dashboard-data";

/**
 * Sprint Performance 14B — KPI parity + date edge case tests for
 * lib/server/dashboard-data.ts, the server-side replacement for the
 * Dashboard's legacy useTenantOperationalData() full-history computation.
 *
 * Every formula reused here (buildOperationalInstances,
 * getServicePdfOperationalMeta, isInboxPdfReviewOpen/isInboxPdfTestNoise,
 * needsInboxReview, isUndeliveredReminder) is imported UNCHANGED from its
 * original module — these tests verify the bounded-query + aggregation
 * wiring around them, not the formulas themselves (those already have their
 * own dedicated test suites).
 */

type Row = Record<string, unknown>;

function splitTopLevel(input: string): string[] {
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

function parseSimpleClause(clause: string): { field: string; op: string; value: string } | null {
  const match = clause.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.(gte|lte|eq)\.(.*)$/);
  if (!match) return null;
  const [, field, op, value] = match;
  return { field, op, value };
}

function evalSimpleClause(row: Row, clause: { field: string; op: string; value: string }): boolean {
  const rowValue = row[clause.field];
  if (rowValue === null || rowValue === undefined) return false;
  const rv = String(rowValue);
  if (clause.op === "gte") return rv >= clause.value;
  if (clause.op === "lte") return rv <= clause.value;
  if (clause.op === "eq") return rv === clause.value;
  return false;
}

function evalOrFilter(row: Row, filterStr: string): boolean {
  return splitTopLevel(filterStr).some((clause) => {
    const andMatch = clause.match(/^and\((.*)\)$/);
    if (andMatch) {
      return splitTopLevel(andMatch[1]).every((sub) => {
        const parsed = parseSimpleClause(sub);
        return parsed ? evalSimpleClause(row, parsed) : false;
      });
    }
    const parsed = parseSimpleClause(clause);
    return parsed ? evalSimpleClause(row, parsed) : false;
  });
}

function selectBuilder(rows: Row[], opts?: { count?: "exact" }) {
  let filtered = [...rows];
  const orderCriteria: Array<{ field: string; ascending: boolean }> = [];
  let limitN: number | null = null;
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
    not(field: string, op: string, value: unknown) {
      if (op === "is" && value === null) filtered = filtered.filter((r) => r[field] !== null && r[field] !== undefined);
      return builder;
    },
    lt(field: string, value: unknown) {
      filtered = filtered.filter((r) => r[field] !== null && r[field] !== undefined && String(r[field]) < String(value));
      return builder;
    },
    or(filterStr: string) {
      filtered = filtered.filter((r) => evalOrFilter(r, filterStr));
      return builder;
    },
    order(field: string, options?: { ascending?: boolean }) {
      orderCriteria.push({ field, ascending: options?.ascending !== false });
      applyOrder();
      return builder;
    },
    limit(n: number) {
      limitN = n;
      return builder;
    },
    then(resolve: (v: { data: Row[]; error: null; count?: number }) => unknown, reject?: (e: unknown) => unknown) {
      const count = filtered.length;
      const data = limitN !== null ? filtered.slice(0, limitN) : filtered;
      const result: { data: Row[]; error: null; count?: number } = { data, error: null };
      if (opts?.count === "exact") result.count = count;
      return Promise.resolve(result).then(resolve, reject);
    }
  };
  return builder;
}

function createFakeAdmin(seed: Partial<Record<string, Row[]>> = {}) {
  const tables: Record<string, Row[]> = { services: [], hotels: [], assignments: [], inbound_emails: [], ...seed };
  const admin = {
    from(table: string) {
      return { select: (_cols?: string, opts?: { count?: "exact" }) => selectBuilder(tables[table] ?? [], opts) };
    }
  } as any;
  return { admin, tables };
}

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function service(id: string, overrides: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT_A,
    date: "2026-08-16",
    time: "10:00",
    direction: "arrival",
    status: "new",
    is_draft: false,
    vessel: "Alilauro",
    pax: 2,
    customer_name: `Cliente ${id}`,
    notes: "",
    ...overrides
  };
}

describe("computeDashboardData — window bounding", () => {
  it("1. empty tenant: everything is zero/empty", async () => {
    const { admin } = createFakeAdmin();
    const result = await computeDashboardData({ admin, tenantId: TENANT_A, today: "2026-08-16", next48h: "2026-08-18" });
    expect(result.windowServices).toEqual([]);
    expect(result.hotels).toEqual([]);
    expect(result.assignments).toEqual([]);
    expect(result.todayPdfNeedsAttentionCount).toBe(0);
    expect(result.inboxPdfNeedsReviewCount).toBe(0);
    expect(result.inboxToReviewCount).toBe(0);
    expect(result.undeliveredReminderCount).toBe(0);
    expect(result.undeliveredReminderSample).toEqual([]);
  });

  it("2. a service matching only via date is included; one entirely outside range is excluded (never fetchAllServices)", async () => {
    const { admin } = createFakeAdmin({
      services: [
        service("in-range", { date: "2026-08-17" }),
        service("historical", { date: "2020-01-01" })
      ]
    });
    const result = await computeDashboardData({ admin, tenantId: TENANT_A, today: "2026-08-16", next48h: "2026-08-18" });
    expect(result.windowServices.map((s: any) => s.id)).toEqual(["in-range"]);
  });

  it("3. a service matching only via arrival_date (date itself outside range) is included — safe superset", async () => {
    const { admin } = createFakeAdmin({
      services: [service("arrival-match", { date: "2020-01-01", arrival_date: "2026-08-17" })]
    });
    const result = await computeDashboardData({ admin, tenantId: TENANT_A, today: "2026-08-16", next48h: "2026-08-18" });
    expect(result.windowServices.map((s: any) => s.id)).toEqual(["arrival-match"]);
  });

  it("4. a service matching only via departure_date is included", async () => {
    const { admin } = createFakeAdmin({
      services: [service("departure-match", { date: "2020-01-01", departure_date: "2026-08-18" })]
    });
    const result = await computeDashboardData({ admin, tenantId: TENANT_A, today: "2026-08-16", next48h: "2026-08-18" });
    expect(result.windowServices.map((s: any) => s.id)).toEqual(["departure-match"]);
  });

  it("5. cancelled and draft services stay in windowServices (buildOperationalInstances excludes them downstream, not this query)", async () => {
    const { admin } = createFakeAdmin({
      services: [
        service("cancelled", { date: "2026-08-16", status: "cancelled" }),
        service("draft", { date: "2026-08-16", is_draft: true })
      ]
    });
    const result = await computeDashboardData({ admin, tenantId: TENANT_A, today: "2026-08-16", next48h: "2026-08-18" });
    expect(result.windowServices.map((s: any) => s.id).sort()).toEqual(["cancelled", "draft"]);
  });
});

describe("computeDashboardData — PDF review KPI (isPdf fix semantics)", () => {
  it("6. manual service (no PDF markers) today is NOT counted as needing PDF attention", async () => {
    const { admin } = createFakeAdmin({
      services: [service("manual-today", { date: "2026-08-16" })]
    });
    const result = await computeDashboardData({ admin, tenantId: TENANT_A, today: "2026-08-16", next48h: "2026-08-18" });
    expect(result.todayPdfNeedsAttentionCount).toBe(0);
  });

  it("7. agency service (agency_id set, no PDF markers) today is NOT counted as needing PDF attention", async () => {
    const { admin } = createFakeAdmin({
      services: [service("agency-today", { date: "2026-08-16", agency_id: "agency-1" })]
    });
    const result = await computeDashboardData({ admin, tenantId: TENANT_A, today: "2026-08-16", next48h: "2026-08-18" });
    expect(result.todayPdfNeedsAttentionCount).toBe(0);
  });

  it("8. a real PDF service today with low quality IS counted as needing PDF attention", async () => {
    const { admin } = createFakeAdmin({
      services: [service("pdf-today", { date: "2026-08-16", notes: "[source:pdf][parsing_quality:low]" })]
    });
    const result = await computeDashboardData({ admin, tenantId: TENANT_A, today: "2026-08-16", next48h: "2026-08-18" });
    expect(result.todayPdfNeedsAttentionCount).toBe(1);
  });

  it("9. a PDF service OUTSIDE today (e.g. tomorrow within the window) is not counted for today's KPI", async () => {
    const { admin } = createFakeAdmin({
      services: [service("pdf-future", { date: "2026-08-17", notes: "[source:pdf][parsing_quality:low]" })]
    });
    const result = await computeDashboardData({ admin, tenantId: TENANT_A, today: "2026-08-16", next48h: "2026-08-18" });
    expect(result.windowServices).toHaveLength(1);
    expect(result.todayPdfNeedsAttentionCount).toBe(0);
  });
});

describe("computeDashboardData — inbox review counts (minimal projection, not full email fetch)", () => {
  it("10. needsInboxReview / isInboxPdfReviewOpen counts match direct evaluation over the fixture", async () => {
    const { admin } = createFakeAdmin({
      inbound_emails: [
        { id: "e1", tenant_id: TENANT_A, subject: "Prenotazione", parsed_json: {} }, // needsInboxReview -> true (default), not pdf review-open
        { id: "e2", tenant_id: TENANT_A, subject: "Conferma", parsed_json: { review_status: "confirmed" } }, // not review
        {
          id: "e3",
          tenant_id: TENANT_A,
          subject: "PDF Import",
          parsed_json: { pdf_import: { import_state: "draft", missing_fields: ["pax"] }, review_status: "needs_review" }
        } // isInboxPdfReviewOpen -> true
      ]
    });
    const result = await computeDashboardData({ admin, tenantId: TENANT_A, today: "2026-08-16", next48h: "2026-08-18" });
    expect(result.inboxToReviewCount).toBe(2); // e1 + e3 (e3 has no linked_service_id/draft_service_id -> needsInboxReview default true)
    expect(result.inboxPdfNeedsReviewCount).toBe(1); // only e3
  });

  it("11. e2e test-noise PDF emails are excluded from inbox_pdf_needs_review_count", async () => {
    const { admin } = createFakeAdmin({
      inbound_emails: [
        {
          id: "noise",
          tenant_id: TENANT_A,
          subject: "Draft PDF E2E test",
          parsed_json: { pdf_import: { import_state: "draft", missing_fields: ["pax"] }, review_status: "needs_review" }
        }
      ]
    });
    const result = await computeDashboardData({ admin, tenantId: TENANT_A, today: "2026-08-16", next48h: "2026-08-18" });
    expect(result.inboxPdfNeedsReviewCount).toBe(0);
  });
});

describe("computeDashboardData — reminder KPI (delivered vs undelivered, historical services included)", () => {
  it("12. reminder sent recently (within threshold) is NOT counted as undelivered", async () => {
    const recentIso = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago, default threshold 30 min
    const { admin } = createFakeAdmin({
      services: [service("recent-reminder", { reminder_status: "sent", sent_at: recentIso })]
    });
    const result = await computeDashboardData({ admin, tenantId: TENANT_A, today: "2026-08-16", next48h: "2026-08-18" });
    expect(result.undeliveredReminderCount).toBe(0);
  });

  it("13. reminder sent long ago (beyond threshold) IS counted as undelivered", async () => {
    const staleIso = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 60 min ago
    const { admin } = createFakeAdmin({
      services: [service("stale-reminder", { reminder_status: "sent", sent_at: staleIso })]
    });
    const result = await computeDashboardData({ admin, tenantId: TENANT_A, today: "2026-08-16", next48h: "2026-08-18" });
    expect(result.undeliveredReminderCount).toBe(1);
    expect(result.undeliveredReminderSample.map((s) => s.id)).toEqual(["stale-reminder"]);
  });

  it("14. reminder_status='delivered' (already delivered) is never counted regardless of sent_at", async () => {
    const staleIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { admin } = createFakeAdmin({
      services: [service("delivered", { reminder_status: "delivered", sent_at: staleIso })]
    });
    const result = await computeDashboardData({ admin, tenantId: TENANT_A, today: "2026-08-16", next48h: "2026-08-18" });
    expect(result.undeliveredReminderCount).toBe(0);
  });

  it("15. sent_at = null is never counted even if reminder_status='sent'", async () => {
    const { admin } = createFakeAdmin({
      services: [service("no-sent-at", { reminder_status: "sent", sent_at: null })]
    });
    const result = await computeDashboardData({ admin, tenantId: TENANT_A, today: "2026-08-16", next48h: "2026-08-18" });
    expect(result.undeliveredReminderCount).toBe(0);
  });

  it("16. a HISTORICAL service (date far outside the window) with an undelivered reminder is still counted — reminder KPI is not date-bounded", async () => {
    const staleIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { admin } = createFakeAdmin({
      services: [service("historical-reminder", { date: "2020-01-01", reminder_status: "sent", sent_at: staleIso })]
    });
    const result = await computeDashboardData({ admin, tenantId: TENANT_A, today: "2026-08-16", next48h: "2026-08-18" });
    // Not part of the bounded window fetch...
    expect(result.windowServices).toEqual([]);
    // ...but still surfaced by the separate, unbounded reminder query.
    expect(result.undeliveredReminderCount).toBe(1);
  });

  it("17. reminder sample is capped at 5 even when more than 5 match, but the count reflects the true total", async () => {
    const staleIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const services = Array.from({ length: 8 }, (_, i) => service(`stale-${i}`, { reminder_status: "sent", sent_at: staleIso }));
    const { admin } = createFakeAdmin({ services });
    const result = await computeDashboardData({ admin, tenantId: TENANT_A, today: "2026-08-16", next48h: "2026-08-18" });
    expect(result.undeliveredReminderCount).toBe(8);
    expect(result.undeliveredReminderSample).toHaveLength(5);
  });
});

describe("computeDashboardData — reference data + assignments scoping", () => {
  it("18. assignments are scoped to windowServices ids only, not the whole tenant", async () => {
    const { admin } = createFakeAdmin({
      services: [service("in-window", { date: "2026-08-16" })],
      assignments: [
        { id: "a1", tenant_id: TENANT_A, service_id: "in-window", driver_profile_id: "d1", vehicle_label: "VAN" },
        { id: "a2", tenant_id: TENANT_A, service_id: "not-in-window", driver_profile_id: "d2", vehicle_label: "CAR" }
      ]
    });
    const result = await computeDashboardData({ admin, tenantId: TENANT_A, today: "2026-08-16", next48h: "2026-08-18" });
    expect(result.assignments.map((a) => a.service_id)).toEqual(["in-window"]);
  });

  it("19. hotels are returned with minimal columns for the whole tenant (reference data)", async () => {
    const { admin } = createFakeAdmin({
      hotels: [{ id: "h1", tenant_id: TENANT_A, name: "Hotel Test", zone: "Ischia Porto", address: "Via Roma 1", lat: null, lng: null }]
    });
    const result = await computeDashboardData({ admin, tenantId: TENANT_A, today: "2026-08-16", next48h: "2026-08-18" });
    expect(result.hotels).toEqual([{ id: "h1", tenant_id: TENANT_A, name: "Hotel Test", zone: "Ischia Porto", address: "Via Roma 1", lat: null, lng: null }]);
  });
});

describe("computeDashboardData — date edge cases", () => {
  it("20. a service with date/arrival_date/departure_date all different still resolves via the OR-superset", async () => {
    const { admin } = createFakeAdmin({
      services: [service("split-dates", { date: "2020-01-01", arrival_date: "2026-08-16", departure_date: "2026-08-20" })]
    });
    const result = await computeDashboardData({ admin, tenantId: TENANT_A, today: "2026-08-16", next48h: "2026-08-18" });
    expect(result.windowServices.map((s: any) => s.id)).toEqual(["split-dates"]);
  });

  it("21. today===next48h (degenerate single-day window) still works without crashing", async () => {
    const { admin } = createFakeAdmin({ services: [service("same-day", { date: "2026-08-16" })] });
    const result = await computeDashboardData({ admin, tenantId: TENANT_A, today: "2026-08-16", next48h: "2026-08-16" });
    expect(result.windowServices.map((s: any) => s.id)).toEqual(["same-day"]);
  });

  it("22. ISO date strings are compared lexicographically without timezone conversion (no Europe/Rome regression)", async () => {
    const { admin } = createFakeAdmin({
      services: [service("boundary", { date: "2026-08-18" })] // exactly on next48h boundary
    });
    const result = await computeDashboardData({ admin, tenantId: TENANT_A, today: "2026-08-16", next48h: "2026-08-18" });
    expect(result.windowServices.map((s: any) => s.id)).toEqual(["boundary"]);
  });
});
