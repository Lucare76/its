import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NONEXISTENT = "99999999-9999-4999-8999-999999999999";

type Row = Record<string, unknown>;
type Db = Record<string, Row[]>;

// Fake Supabase query builder covering only what escursioni/route.ts uses:
// select/insert/delete + eq/in/contains filters + maybeSingle + the
// `excursion_units!inner(tenant_id)` ownership join used by remove_passenger.
function createFakeSupabase(db: Db) {
  let idCounter = 0;

  function makeBuilder(table: string) {
    let action: "select" | "insert" | "update" | "delete" | null = null;
    let payload: unknown = null;
    const filters: Array<{ col: string; op: "eq" | "in" | "contains"; val: unknown }> = [];

    function matchRow(row: Row): boolean {
      return filters.every((f) => {
        if (f.op === "in") return (f.val as unknown[]).includes(row[f.col]);
        if (f.op === "contains") {
          const arr = row[f.col];
          return Array.isArray(arr) && (f.val as unknown[]).every((v) => arr.includes(v));
        }
        if (f.col === "excursion_units.tenant_id") {
          const unit = (db.excursion_units ?? []).find((u) => u.id === row.excursion_unit_id);
          return unit?.tenant_id === f.val;
        }
        return row[f.col] === f.val;
      });
    }

    function execute(): Promise<{ data: Row[]; error: null }> {
      db[table] = db[table] ?? [];
      let result: Row[];
      if (action === "insert") {
        const rows = Array.isArray(payload) ? (payload as Row[]) : [payload as Row];
        const inserted = rows.map((r) => ({ id: (r.id as string) ?? `gen-${++idCounter}`, ...r }));
        db[table].push(...inserted);
        result = inserted;
      } else if (action === "update") {
        result = db[table].filter(matchRow);
        result.forEach((row) => Object.assign(row, payload));
      } else if (action === "delete") {
        result = db[table].filter(matchRow);
        db[table] = db[table].filter((row) => !matchRow(row));
      } else {
        result = db[table].filter(matchRow);
      }
      return Promise.resolve({ data: result, error: null });
    }

    const builder = {
      select() {
        if (!action) action = "select";
        return builder;
      },
      insert(data: unknown) {
        action = "insert";
        payload = data;
        return builder;
      },
      update(data: unknown) {
        action = "update";
        payload = data;
        return builder;
      },
      delete() {
        action = "delete";
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push({ col, op: "eq", val });
        return builder;
      },
      in(col: string, val: unknown) {
        filters.push({ col, op: "in", val });
        return builder;
      },
      contains(col: string, val: unknown) {
        filters.push({ col, op: "contains", val });
        return builder;
      },
      order() {
        return builder;
      },
      maybeSingle() {
        return execute().then(({ data }) => ({ data: data[0] ?? null, error: null }));
      },
      single() {
        return execute().then(({ data }) => ({
          data: data[0] ?? null,
          error: data[0] ? null : { message: "not found" }
        }));
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown, reject: (e: unknown) => unknown) {
        return execute().then(resolve, reject);
      }
    };
    return builder;
  }

  return { from: (table: string) => makeBuilder(table) };
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn()
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest
}));

import { POST } from "@/app/api/ops/escursioni/route";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/ops/escursioni", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body)
  });
}

describe("POST /api/ops/escursioni — tenant isolation", () => {
  let db: Db;

  beforeEach(() => {
    vi.clearAllMocks();

    db = {
      excursion_lines: [
        { id: "line-a1", tenant_id: TENANT_A, name: "Giro dell'Isola", description: null, color: "#6366f1", icon: "🏝️", active: true, sort_order: 1, days_of_week: [0, 1, 2, 3, 4, 5, 6] },
        { id: "line-b1", tenant_id: TENANT_B, name: "Epomeo", description: null, color: "#16a34a", icon: "⛰️", active: true, sort_order: 1, days_of_week: [0, 1, 2, 3, 4, 5, 6] }
      ],
      excursion_units: [
        {
          id: "unit-a1",
          tenant_id: TENANT_A,
          excursion_line_id: "line-a1",
          excursion_date: "2026-07-30",
          label: "Bus 1",
          capacity: 50,
          departure_time: null,
          vehicle_id: null,
          driver_profile_id: null,
          notes: null,
          status: "open"
        },
        {
          id: "unit-b1",
          tenant_id: TENANT_B,
          excursion_line_id: "line-b1",
          excursion_date: "2026-07-30",
          label: "Bus 1",
          capacity: 50,
          departure_time: null,
          vehicle_id: null,
          driver_profile_id: null,
          notes: null,
          status: "open"
        }
      ],
      excursion_allocations: [
        { id: "alloc-a1", excursion_unit_id: "unit-a1", customer_name: "Mario Rossi", pax: 2, hotel_name: null, pickup_time: null, phone: null, agency_name: null, notes: null },
        { id: "alloc-b1", excursion_unit_id: "unit-b1", customer_name: "Luigi Verdi", pax: 2, hotel_name: null, pickup_time: null, phone: null, agency_name: null, notes: null }
      ]
    };

    const admin = createFakeSupabase(db);
    mocks.authorizePricingRequest.mockResolvedValue({
      admin,
      user: { id: "user-a", email: "opa@tenant-a.test" },
      membership: { tenant_id: TENANT_A, role: "operator", suspended: false }
    });
  });

  // ── add_passenger (insert su excursion_allocations, ownership via excursion_unit_id) ──

  it("Tenant A può aggiungere un passeggero al proprio bus escursione", async () => {
    const res = await POST(
      makeRequest({ action: "add_passenger", excursion_unit_id: "unit-a1", customer_name: "Nuovo Cliente", pax: 1, date: "2026-07-30" })
    );
    expect(res.status).toBe(200);
    expect(db.excursion_allocations.some((a) => a.excursion_unit_id === "unit-a1" && a.customer_name === "Nuovo Cliente")).toBe(true);
  });

  it("Tenant A NON può aggiungere un passeggero al bus escursione del Tenant B", async () => {
    const res = await POST(
      makeRequest({ action: "add_passenger", excursion_unit_id: "unit-b1", customer_name: "Intruso", pax: 1, date: "2026-07-30" })
    );
    expect(res.status).toBe(404);
    expect(db.excursion_allocations.some((a) => a.customer_name === "Intruso")).toBe(false);
  });

  // ── add_unit (insert su excursion_units, ownership via excursion_line_id) ──

  it("Tenant A può aggiungere un bus a una propria excursion_line", async () => {
    const res = await POST(
      makeRequest({ action: "add_unit", excursion_line_id: "line-a1", label: "Bus 2", capacity: 40, date: "2026-07-30" })
    );
    expect(res.status).toBe(200);
    expect(db.excursion_units.some((u) => u.excursion_line_id === "line-a1" && u.label === "Bus 2")).toBe(true);
  });

  it("Tenant A NON può aggiungere un bus a una excursion_line del Tenant B", async () => {
    const res = await POST(
      makeRequest({ action: "add_unit", excursion_line_id: "line-b1", label: "Bus Intruso", capacity: 40, date: "2026-07-30" })
    );
    expect(res.status).toBe(404);
    expect(db.excursion_units.some((u) => u.label === "Bus Intruso")).toBe(false);
  });

  it("add_unit: UUID inesistente e UUID di altro tenant restituiscono la stessa risposta", async () => {
    const resMissing = await POST(
      makeRequest({ action: "add_unit", excursion_line_id: NONEXISTENT, label: "Bus X", capacity: 40, date: "2026-07-30" })
    );
    const resOtherTenant = await POST(
      makeRequest({ action: "add_unit", excursion_line_id: "line-b1", label: "Bus X", capacity: 40, date: "2026-07-30" })
    );
    const bodyMissing = await resMissing.json();
    const bodyOtherTenant = await resOtherTenant.json();

    expect(resMissing.status).toBe(404);
    expect(resOtherTenant.status).toBe(404);
    expect(bodyMissing).toEqual(bodyOtherTenant);
  });

  // ── remove_passenger (delete su excursion_allocations, ownership via unit padre) ──

  it("Tenant A può rimuovere un proprio passeggero", async () => {
    const res = await POST(makeRequest({ action: "remove_passenger", allocation_id: "alloc-a1", date: "2026-07-30" }));
    expect(res.status).toBe(200);
    expect(db.excursion_allocations.find((a) => a.id === "alloc-a1")).toBeUndefined();
  });

  it("Tenant A NON può rimuovere un passeggero del Tenant B", async () => {
    const res = await POST(makeRequest({ action: "remove_passenger", allocation_id: "alloc-b1", date: "2026-07-30" }));
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(db.excursion_allocations.find((a) => a.id === "alloc-b1")).toBeDefined();
  });

  // ── Coerenza risposte: UUID inesistente vs UUID di altro tenant ─────────

  it("UUID inesistente e UUID di un altro tenant restituiscono la stessa risposta non informativa", async () => {
    const resMissing = await POST(makeRequest({ action: "remove_passenger", allocation_id: NONEXISTENT, date: "2026-07-30" }));
    const resOtherTenant = await POST(makeRequest({ action: "remove_passenger", allocation_id: "alloc-b1", date: "2026-07-30" }));
    const bodyMissing = await resMissing.json();
    const bodyOtherTenant = await resOtherTenant.json();

    expect(resMissing.status).toBe(404);
    expect(resOtherTenant.status).toBe(404);
    expect(bodyMissing).toEqual(bodyOtherTenant);
  });
});
