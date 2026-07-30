import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NONEXISTENT = "99999999-9999-4999-8999-999999999999";

type Row = Record<string, unknown>;
type Db = Record<string, Row[]>;

// Fake Supabase query builder covering only what pickup-runs/route.ts uses:
// select/insert/update/delete + eq/in filters + single/maybeSingle + await (thenable).
function createFakeSupabase(db: Db) {
  let idCounter = 0;

  function makeBuilder(table: string) {
    let action: "select" | "insert" | "update" | "delete" | null = null;
    let payload: unknown = null;
    const filters: Array<{ col: string; op: "eq" | "in"; val: unknown }> = [];

    function matchRow(row: Row): boolean {
      return filters.every((f) => {
        if (f.op === "in") return (f.val as unknown[]).includes(row[f.col]);
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

import { POST } from "@/app/api/ops/pickup-runs/route";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/ops/pickup-runs", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body)
  });
}

describe("POST /api/ops/pickup-runs — tenant isolation", () => {
  let db: Db;

  beforeEach(() => {
    vi.clearAllMocks();

    db = {
      pickup_runs: [
        {
          id: "run-a1",
          tenant_id: TENANT_A,
          run_date: "2026-07-30",
          port: "ischia",
          direction: "arrival",
          window_open: "10:00",
          window_close: "10:45",
          total_pax: 5,
          status: "planned",
          notes: null
        },
        {
          id: "run-b1",
          tenant_id: TENANT_B,
          run_date: "2026-07-30",
          port: "ischia",
          direction: "arrival",
          window_open: "11:00",
          window_close: "11:45",
          total_pax: 3,
          status: "planned",
          notes: null
        }
      ],
      pickup_run_arrivals: [
        { id: "arr-a1", run_id: "run-a1", service_id: null, ferry_name: "Traghetto A", arrival_time: "10:05", pax: 5, notes: null },
        { id: "arr-b1", run_id: "run-b1", service_id: null, ferry_name: "Traghetto B", arrival_time: "11:05", pax: 3, notes: null }
      ],
      pickup_run_buses: [
        { id: "bus-a1", run_id: "run-a1", direction: "ovest", direction_label: "Ovest", vehicle_id: null, driver_profile_id: null, pax_assigned: 5, notes: null },
        { id: "bus-b1", run_id: "run-b1", direction: "ovest", direction_label: "Ovest", vehicle_id: null, driver_profile_id: null, pax_assigned: 3, notes: null }
      ],
      pickup_run_services: [
        { id: "svc-a1", tenant_id: TENANT_A, run_id: "run-a1", service_id: "service-a1", passenger_name: "Mario Rossi", passenger_phone: null, hotel_id: null, hotel_name: "Hotel Forio A", hotel_zone: "forio", pax: 2, moved_to_dist_bus_id: null },
        { id: "svc-b1", tenant_id: TENANT_B, run_id: "run-b1", service_id: "service-b1", passenger_name: "Luigi Verdi", passenger_phone: null, hotel_id: null, hotel_name: "Hotel Forio B", hotel_zone: "forio", pax: 2, moved_to_dist_bus_id: null }
      ],
      bus_ischia_dist_buses: [
        { id: "dist-a1", tenant_id: TENANT_A, date: "2026-07-30", bus_line_id: "line-x", label: "Bus Forio", zone: "forio", capacity: 50, bus_ischia_dist_allocations: [] },
        { id: "dist-b1", tenant_id: TENANT_B, date: "2026-07-30", bus_line_id: "line-y", label: "Bus Forio", zone: "forio", capacity: 50, bus_ischia_dist_allocations: [] }
      ],
      bus_ischia_dist_allocations: []
    };

    const admin = createFakeSupabase(db);
    mocks.authorizePricingRequest.mockResolvedValue({
      admin,
      user: { id: "user-a", email: "opa@tenant-a.test" },
      membership: { tenant_id: TENANT_A, role: "operator", suspended: false }
    });
  });

  // ── update_run / delete_run (pickup_runs ha tenant_id diretto) ──────────

  it("Tenant A può aggiornare un proprio run", async () => {
    const res = await POST(makeRequest({ action: "update_run", run_id: "run-a1", status: "active", date: "2026-07-30" }));
    expect(res.status).toBe(200);
    expect(db.pickup_runs.find((r) => r.id === "run-a1")?.status).toBe("active");
  });

  it("Tenant A NON può aggiornare un run del Tenant B", async () => {
    const res = await POST(makeRequest({ action: "update_run", run_id: "run-b1", status: "active", date: "2026-07-30" }));
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(db.pickup_runs.find((r) => r.id === "run-b1")?.status).toBe("planned");
  });

  it("Tenant A può cancellare un proprio run", async () => {
    const res = await POST(makeRequest({ action: "delete_run", run_id: "run-a1", date: "2026-07-30" }));
    expect(res.status).toBe(200);
    expect(db.pickup_runs.find((r) => r.id === "run-a1")).toBeUndefined();
  });

  it("Tenant A NON può cancellare un run del Tenant B", async () => {
    const res = await POST(makeRequest({ action: "delete_run", run_id: "run-b1", date: "2026-07-30" }));
    expect(res.status).toBe(404);
    expect(db.pickup_runs.find((r) => r.id === "run-b1")).toBeDefined();
  });

  // ── add_arrival / remove_arrival (pickup_run_arrivals, ownership via run_id) ──

  it("Tenant A può aggiungere un arrivo al proprio run", async () => {
    const res = await POST(
      makeRequest({ action: "add_arrival", run_id: "run-a1", ferry_name: "Nuovo", arrival_time: "12:00", pax: 2, date: "2026-07-30" })
    );
    expect(res.status).toBe(200);
    expect(db.pickup_run_arrivals.some((a) => a.run_id === "run-a1" && a.ferry_name === "Nuovo")).toBe(true);
  });

  it("Tenant A NON può aggiungere un arrivo al run del Tenant B", async () => {
    const res = await POST(
      makeRequest({ action: "add_arrival", run_id: "run-b1", ferry_name: "Intruso", arrival_time: "12:00", pax: 2, date: "2026-07-30" })
    );
    expect(res.status).toBe(404);
    expect(db.pickup_run_arrivals.some((a) => a.ferry_name === "Intruso")).toBe(false);
  });

  it("Tenant A può rimuovere un arrivo dal proprio run", async () => {
    const res = await POST(makeRequest({ action: "remove_arrival", arrival_id: "arr-a1", run_id: "run-a1", date: "2026-07-30" }));
    expect(res.status).toBe(200);
    expect(db.pickup_run_arrivals.find((a) => a.id === "arr-a1")).toBeUndefined();
  });

  it("Tenant A NON può rimuovere un arrivo del run del Tenant B", async () => {
    const res = await POST(makeRequest({ action: "remove_arrival", arrival_id: "arr-b1", run_id: "run-b1", date: "2026-07-30" }));
    expect(res.status).toBe(404);
    expect(db.pickup_run_arrivals.find((a) => a.id === "arr-b1")).toBeDefined();
  });

  it("id/run_id incoerenti non cancellano l'arrivo di un altro tenant", async () => {
    // run_id proprio (autorizzato) ma arrival_id del Tenant B: il filtro combinato non deve corrispondere a nessuna riga.
    const res = await POST(makeRequest({ action: "remove_arrival", arrival_id: "arr-b1", run_id: "run-a1", date: "2026-07-30" }));
    expect(res.status).toBe(200);
    expect(db.pickup_run_arrivals.find((a) => a.id === "arr-b1")).toBeDefined();
  });

  // ── upsert_bus / remove_bus (pickup_run_buses, ownership via run_id) ────

  it("Tenant A può aggiornare un bus del proprio run", async () => {
    const res = await POST(
      makeRequest({ action: "upsert_bus", run_id: "run-a1", bus_id: "bus-a1", direction: "ovest", direction_label: "Ovest", pax_assigned: 9, date: "2026-07-30" })
    );
    expect(res.status).toBe(200);
    expect(db.pickup_run_buses.find((b) => b.id === "bus-a1")?.pax_assigned).toBe(9);
  });

  it("Tenant A NON può aggiornare un bus del run del Tenant B", async () => {
    const res = await POST(
      makeRequest({ action: "upsert_bus", run_id: "run-b1", bus_id: "bus-b1", direction: "ovest", direction_label: "Ovest", pax_assigned: 99, date: "2026-07-30" })
    );
    expect(res.status).toBe(404);
    expect(db.pickup_run_buses.find((b) => b.id === "bus-b1")?.pax_assigned).toBe(3);
  });

  it("Tenant A NON può creare un nuovo bus sul run del Tenant B", async () => {
    const res = await POST(
      makeRequest({ action: "upsert_bus", run_id: "run-b1", direction: "est", direction_label: "Est", pax_assigned: 4, date: "2026-07-30" })
    );
    expect(res.status).toBe(404);
    expect(db.pickup_run_buses.some((b) => b.run_id === "run-b1" && b.direction === "est")).toBe(false);
  });

  it("Tenant A può rimuovere un bus del proprio run", async () => {
    const res = await POST(makeRequest({ action: "remove_bus", bus_id: "bus-a1", date: "2026-07-30" }));
    expect(res.status).toBe(200);
    expect(db.pickup_run_buses.find((b) => b.id === "bus-a1")).toBeUndefined();
  });

  it("Tenant A NON può rimuovere un bus del run del Tenant B", async () => {
    const res = await POST(makeRequest({ action: "remove_bus", bus_id: "bus-b1", date: "2026-07-30" }));
    expect(res.status).toBe(404);
    expect(db.pickup_run_buses.find((b) => b.id === "bus-b1")).toBeDefined();
  });

  // ── move_to_dist_bus (pickup_run_services / bus_ischia_dist_buses, tenant_id diretto) ──

  it("Tenant A può spostare un proprio passeggero su un proprio bus smistamento", async () => {
    const res = await POST(makeRequest({ action: "move_to_dist_bus", run_service_id: "svc-a1", dist_bus_id: "dist-a1", date: "2026-07-30" }));
    expect(res.status).toBe(200);
    expect(db.pickup_run_services.find((s) => s.id === "svc-a1")?.moved_to_dist_bus_id).toBe("dist-a1");
    expect(db.bus_ischia_dist_allocations.some((a) => a.dist_bus_id === "dist-a1" && a.service_id === "service-a1")).toBe(true);
  });

  it("Tenant A NON può spostare un passeggero del Tenant B (anche verso un proprio bus)", async () => {
    const res = await POST(makeRequest({ action: "move_to_dist_bus", run_service_id: "svc-b1", dist_bus_id: "dist-a1", date: "2026-07-30" }));
    expect(res.status).toBe(404);
    expect(db.pickup_run_services.find((s) => s.id === "svc-b1")?.moved_to_dist_bus_id).toBeNull();
    expect(db.bus_ischia_dist_allocations.length).toBe(0);
  });

  it("Tenant A NON può spostare un proprio passeggero su un bus smistamento del Tenant B", async () => {
    const res = await POST(makeRequest({ action: "move_to_dist_bus", run_service_id: "svc-a1", dist_bus_id: "dist-b1", date: "2026-07-30" }));
    expect(res.status).toBe(404);
    expect(db.pickup_run_services.find((s) => s.id === "svc-a1")?.moved_to_dist_bus_id).toBeNull();
    expect(db.bus_ischia_dist_allocations.length).toBe(0);
  });

  it("move_to_dist_bus: UUID inesistente e UUID di altro tenant restituiscono la stessa risposta", async () => {
    const resMissing = await POST(makeRequest({ action: "move_to_dist_bus", run_service_id: NONEXISTENT, dist_bus_id: "dist-a1", date: "2026-07-30" }));
    const resOtherTenant = await POST(makeRequest({ action: "move_to_dist_bus", run_service_id: "svc-b1", dist_bus_id: "dist-a1", date: "2026-07-30" }));
    const bodyMissing = await resMissing.json();
    const bodyOtherTenant = await resOtherTenant.json();

    expect(resMissing.status).toBe(404);
    expect(resOtherTenant.status).toBe(404);
    expect(bodyMissing).toEqual(bodyOtherTenant);
  });

  // ── Coerenza risposte: UUID inesistente vs UUID di altro tenant ─────────

  it("UUID inesistente e UUID di un altro tenant restituiscono la stessa risposta non informativa", async () => {
    const resMissing = await POST(makeRequest({ action: "delete_run", run_id: NONEXISTENT, date: "2026-07-30" }));
    const resOtherTenant = await POST(makeRequest({ action: "delete_run", run_id: "run-b1", date: "2026-07-30" }));
    const bodyMissing = await resMissing.json();
    const bodyOtherTenant = await resOtherTenant.json();

    expect(resMissing.status).toBe(404);
    expect(resOtherTenant.status).toBe(404);
    expect(bodyMissing).toEqual(bodyOtherTenant);
  });
});
