import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * SEC-06 — auto-assign non deve restituire al client testi raw di errori
 * DB/interni (Postgres/Supabase message, stack, ecc). Il report array e il
 * catch finale devono contenere solo messaggi generici; il dettaglio raw va
 * solo in auditLog (server-side).
 */

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVICE_ARRIVAL = "a1111111-1111-4111-8111-111111111111";
const DRIVER_PROFILE = "d1111111-1111-4111-8111-111111111111";
const DRIVER_USER = "u1111111-1111-4111-8111-111111111111";
const VEHICLE_ID = "v1111111-1111-4111-8111-111111111111";
const VEHICLE_LABEL = "Van 8";
const TEST_DATE = "2026-08-10";

const RAW_GROUPS_ERROR = "insert or update on table \"trip_groups\" violates foreign key constraint xyz_secret";
const RAW_ASSIGN_ERROR = "duplicate key value violates unique constraint assignments_pkey internal detail";

type Row = Record<string, unknown>;

function createFakeSupabase(opts: { groupsInsertError?: string; assignUpsertError?: string; confirmed?: boolean } = {}) {
  const tables: Record<string, Row[]> = {
    services: [{
      id: SERVICE_ARRIVAL, tenant_id: TENANT_A, date: TEST_DATE, time: "09:00:00",
      direction: "arrival", vessel: "SNAV", hotel_id: null, pax: 2, status: "new",
      is_draft: false, meeting_point: "Ischia Porto", pickup_hotel: null,
      customer_name: "Cliente Test", booking_service_kind: null, service_type_code: null,
      arrival_time: null, orario_barca: null, porto_bruno: null, barca_compagnia: null, ferry_details: null,
    }],
    hotels: [],
    vehicles: [{ id: VEHICLE_ID, tenant_id: TENANT_A, label: VEHICLE_LABEL, capacity: 8, active: true }],
    assignments: [],
    trip_groups: [],
    hotel_vehicle_limits: [],
    driver_daily_availability: [],
    vehicle_daily_availability: [],
    vehicle_time_blocks: [],
    daily_availability_confirmations: opts.confirmed === false
      ? []
      : [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
    status_events: [],
  };

  const calls = { tripGroupsInserted: [] as Row[], assignmentsUpserted: [] as Row[] };

  function makeChain(table: string, op: "select" | "update") {
    let filtered = tables[table] ?? [];
    const builder = {
      eq(field: string, value: unknown) { filtered = filtered.filter((r) => r[field] === value); return builder; },
      neq(field: string, value: unknown) { filtered = filtered.filter((r) => r[field] !== value); return builder; },
      in(field: string, values: unknown[]) { filtered = filtered.filter((r) => values.includes(r[field])); return builder; },
      not() { return builder; },
      order() { return builder; },
      limit(n: number) { filtered = filtered.slice(0, n); return builder; },
      maybeSingle() { return Promise.resolve({ data: filtered[0] ?? null, error: null }); },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        if (op === "update") return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      return {
        select() { return makeChain(table, "select"); },
        update() { return makeChain(table, "update"); },
        insert(rows: Row | Row[]) {
          const rowsArr = Array.isArray(rows) ? rows : [rows];
          if (table === "trip_groups") {
            if (opts.groupsInsertError) {
              return { select: () => Promise.resolve({ data: null, error: { message: opts.groupsInsertError } }) };
            }
            const inserted = rowsArr.map((r, idx) => ({ id: `grp-${idx + 1}`, status: "active", ...r }));
            calls.tripGroupsInserted.push(...inserted);
            return { select: () => Promise.resolve({ data: inserted, error: null }) };
          }
          return Promise.resolve({ data: rowsArr, error: null });
        },
        upsert(rows: Row | Row[]) {
          const rowsArr = Array.isArray(rows) ? rows : [rows];
          if (table === "assignments") {
            if (opts.assignUpsertError) {
              return Promise.resolve({ data: null, error: { message: opts.assignUpsertError } });
            }
            calls.assignmentsUpserted.push(...rowsArr);
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };

  return { admin, calls };
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  listDriverRegistry: vi.fn(),
  loadVehicleCommitmentsForDate: vi.fn(),
  loadLearnedPatterns: vi.fn(),
  updateLearnedPatterns: vi.fn(),
  extractFeatures: vi.fn(),
  logAssignmentChange: vi.fn(),
  assignGlobalPlanner: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorizePricingRequest }));
vi.mock("@/lib/server/driver-registry", () => ({ listDriverRegistry: mocks.listDriverRegistry }));
vi.mock("@/lib/server/vehicle-commitments", () => ({ loadVehicleCommitmentsForDate: mocks.loadVehicleCommitmentsForDate }));
vi.mock("@/lib/server/learned-patterns", () => ({
  loadLearnedPatterns: mocks.loadLearnedPatterns,
  updateLearnedPatterns: mocks.updateLearnedPatterns,
}));
vi.mock("@/lib/server/assignment-history", () => ({
  extractFeatures: mocks.extractFeatures,
  logAssignmentChange: mocks.logAssignmentChange,
  buildAssignmentDecisionFeatures: (base, decision = {}) => ({ ...base, ...Object.fromEntries(Object.entries(decision).filter(([, v]) => v !== undefined)) }),
}));
vi.mock("@/lib/piano-global-planner", () => ({ assignGlobalPlanner: mocks.assignGlobalPlanner }));
vi.mock("@/lib/server/ops-audit", () => ({ auditLog: mocks.auditLog }));

import { POST } from "@/app/api/ops/piano-giorno/auto-assign/route";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/ops/piano-giorno/auto-assign", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}
function callPost(body: Record<string, unknown> = { date: TEST_DATE, mode: "unassigned_only" }) {
  return POST(makeRequest(body));
}

function authorizeAs(fake: ReturnType<typeof createFakeSupabase>) {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
  });
}

describe("SEC-06 — auto-assign error sanitization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listDriverRegistry.mockResolvedValue([{
      id: DRIVER_PROFILE, user_id: DRIVER_USER, full_name: "Mario Rossi", phone: null,
      username: null, active: true, has_access: true, access_suspended: false,
      role: "driver", max_vehicle_capacity: null,
    }]);
    mocks.loadVehicleCommitmentsForDate.mockResolvedValue({ rows: [], byVehicleId: new Map() });
    mocks.loadLearnedPatterns.mockResolvedValue([]);
    mocks.updateLearnedPatterns.mockResolvedValue(undefined);
    mocks.extractFeatures.mockReturnValue({});
    mocks.logAssignmentChange.mockResolvedValue(undefined);
    mocks.assignGlobalPlanner.mockReturnValue([{
      id: "draft_0", assigned: true, proposed_driver_key: DRIVER_PROFILE,
      proposed_driver_name: "Mario Rossi", proposed_vehicle_label: VEHICLE_LABEL, proposed_vehicle_capacity: 8,
    }]);
  });

  it("1. groupsErr raw non compare nel report, ok:true preservato, audit eseguito", async () => {
    const fake = createFakeSupabase({ groupsInsertError: RAW_GROUPS_ERROR });
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.report)).toBe(true);
    expect(body.report.join(" ")).not.toContain(RAW_GROUPS_ERROR);
    expect(body.report.join(" ")).toContain("1 errori: Errore creazione giri.");
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "piano_auto_assign_groups_insert_failed",
        details: expect.objectContaining({ message: RAW_GROUPS_ERROR }),
      })
    );
  });

  it("2. assignRes.error.message raw non compare nel report, ok:true preservato, audit eseguito", async () => {
    const fake = createFakeSupabase({ assignUpsertError: RAW_ASSIGN_ERROR });
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.report.join(" ")).not.toContain(RAW_ASSIGN_ERROR);
    expect(body.report.join(" ")).toContain("Errore salvataggio assegnazioni.");
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "piano_auto_assign_write_failed",
        details: expect.objectContaining({ step: "assignments", message: RAW_ASSIGN_ERROR }),
      })
    );
  });

  it("3. catch finale: err.message raw non compare, status 500 invariato, audit eseguito", async () => {
    const fake = createFakeSupabase();
    authorizeAs(fake);
    const rawInternal = "TypeError: cannot read property 'x' of undefined at internal/module secret-path";
    mocks.loadVehicleCommitmentsForDate.mockRejectedValueOnce(new Error(rawInternal));

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBeUndefined();
    expect(body.error).toBe("Errore durante l'auto-assign.");
    expect(body.error).not.toContain(rawInternal);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "piano_auto_assign_unhandled_error",
        details: expect.objectContaining({ message: rawInternal }),
      })
    );
  });

  it("4. business error rappresentativo invariato (disponibilita non confermata)", async () => {
    const fake = createFakeSupabase({ confirmed: false });
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain("Disponibilita del giorno non confermata");
  });

  it("5. percorso senza errori: report resta shape string[], nessun audit di errore", async () => {
    const fake = createFakeSupabase();
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.report)).toBe(true);
    expect(body.report.every((line: unknown) => typeof line === "string")).toBe(true);
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });
});
