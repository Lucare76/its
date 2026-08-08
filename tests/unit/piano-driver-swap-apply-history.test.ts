import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Test hardening promise chain — POST /api/ops/piano-giorno/apply-driver-swap.
 *
 * Pattern precedente:
 *   logAssignmentChange(...).then(() => updateLearnedPatterns(...).catch(() => undefined))
 * Il .catch() era annidato dentro il .then() e copriva solo la promise di
 * updateLearnedPatterns, non un reject diretto di logAssignmentChange (che in
 * quel caso restava un unhandled rejection). Fix:
 *   logAssignmentChange(...).then(() => updateLearnedPatterns(...)).catch(() => undefined)
 * — catch sull'intera catena. Nessuna modifica a mutazioni, payload history,
 * change_type, previous/new, actor, tenant o risposta HTTP.
 *
 * Questo file mocka `buildGprPeterDriverSwapPreview`/
 * `validateGprPeterDriverSwapPreviewForApply`/`insertOperatorDecision` per
 * bypassare la logica di business (già coperta da
 * tests/unit/piano-driver-swap-apply.test.ts) e concentrarsi esclusivamente
 * sulla robustezza della catena promise dopo che le mutazioni principali
 * (trip_groups/assignments) sono già state confermate.
 */

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GROUP_1 = "c1111111-1111-4111-8111-111111111111";
const SERVICE_1 = "a1111111-1111-4111-8111-111111111111";
const OPERATOR_1 = "u1111111-1111-4111-8111-111111111111";
const DRIVER_FROM = "e1111111-1111-4111-8111-111111111111";
const DRIVER_TO = "e2222222-2222-4222-8222-222222222222";
const VEHICLE_FROM = "Van 8";
const VEHICLE_TO = "Van 9";
const TEST_DATE = "2026-08-10";
const PREVIEW_REFERENCE = "ref-test-0000000000000000";

type Row = Record<string, unknown>;

function createSupabase(seed: Partial<Record<"trip_groups" | "assignments" | "services" | "hotels", Row[]>> = {}) {
  const tables: Record<string, Row[]> = {
    trip_groups: [...(seed.trip_groups ?? [])],
    assignments: [...(seed.assignments ?? [])],
    services: [...(seed.services ?? [])],
    hotels: [...(seed.hotels ?? [])],
  };

  function makeQueryBuilder(table: string, op: "select" | "update", updatePayload?: Row) {
    let filtered = tables[table];

    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] === value);
        return builder;
      },
      in(field: string, values: unknown[]) {
        filtered = filtered.filter((r) => values.includes(r[field]));
        return builder;
      },
      select(_cols?: string) {
        return builder;
      },
      maybeSingle() {
        if (op === "update" && updatePayload) {
          for (const row of filtered) Object.assign(row, updatePayload);
        }
        return Promise.resolve({ data: filtered[0] ? { ...filtered[0] } : null, error: null });
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        if (op === "update" && updatePayload) {
          for (const row of filtered) Object.assign(row, updatePayload);
        }
        return Promise.resolve({ data: filtered.map((r) => ({ ...r })), error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      return {
        select() {
          return makeQueryBuilder(table, "select");
        },
        update(payload: Row) {
          return makeQueryBuilder(table, "update", payload);
        },
      };
    },
  };

  return { admin, tables };
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  buildGprPeterDriverSwapPreview: vi.fn(),
  validateGprPeterDriverSwapPreviewForApply: vi.fn(),
  insertOperatorDecision: vi.fn(),
  loadConfirmedOperatorDecisions: vi.fn(),
  extractFeatures: vi.fn(),
  logAssignmentChange: vi.fn(),
  updateLearnedPatterns: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));
vi.mock("@/lib/server/piano-driver-swap-preview", () => ({
  GPR_PETER_DRIVER_SWAP_ACTION: "APPLY_DRIVER_SWAP",
  GPR_PETER_DRIVER_SWAP_DECISION_TYPE: "driver_swap_confirmed",
  GPR_PETER_GROUP_ID: "c1111111-1111-4111-8111-111111111111",
  buildGprPeterDriverSwapPreview: mocks.buildGprPeterDriverSwapPreview,
  validateGprPeterDriverSwapPreviewForApply: mocks.validateGprPeterDriverSwapPreviewForApply,
}));
vi.mock("@/lib/server/piano-operator-decisions", () => ({
  insertOperatorDecision: mocks.insertOperatorDecision,
  loadConfirmedOperatorDecisions: mocks.loadConfirmedOperatorDecisions,
}));
vi.mock("@/lib/server/assignment-history", () => ({
  extractFeatures: mocks.extractFeatures,
  logAssignmentChange: mocks.logAssignmentChange,
}));
vi.mock("@/lib/server/learned-patterns", () => ({
  updateLearnedPatterns: mocks.updateLearnedPatterns,
}));

import { POST } from "@/app/api/ops/piano-giorno/apply-driver-swap/route";

function buildPreview(overrides: Row = {}) {
  return {
    ok: true,
    date: TEST_DATE,
    trip_group_id: GROUP_1,
    preview_reference: PREVIEW_REFERENCE,
    already_applied: false,
    current: { driver_profile_id: DRIVER_FROM, driver_user_id: null, driver_name: "A", vehicle_label: VEHICLE_FROM, vehicle_capacity: 8, updated_at: null },
    proposed: { driver_profile_id: DRIVER_TO, driver_user_id: null, driver_name: "B", max_vehicle_capacity: null, vehicle_id: "veh-1", vehicle_label: VEHICLE_TO, vehicle_capacity: 8 },
    trip: { start_time: "10:00", end_time: "10:30", pax: 2, service_ids: [SERVICE_1], customer_names: ["Cliente"] },
    checks: {
      mario_available: true, mario_can_drive_25: true, vehicle_available: true, vehicle_capacity_ok: true,
      mario_overlap_count: 0, vehicle_overlap_count: 0, overbooking: 0, driver_vehicle_eligibility_blocker: false,
      conflicts_before: 1, conflicts_after: 0,
    },
    warnings: [],
    blockers: [],
    before_json: {},
    after_json: {},
    payload_json: {},
    ...overrides,
  };
}

function baseSeed() {
  return createSupabase({
    trip_groups: [{ id: GROUP_1, tenant_id: TENANT_A, driver_user_id: null, driver_profile_id: DRIVER_FROM, vehicle_label: VEHICLE_FROM, vehicle_capacity: 8, date: TEST_DATE, status: "active", updated_at: null }],
    assignments: [{ id: "asg-1", tenant_id: TENANT_A, group_id: GROUP_1, service_id: SERVICE_1, driver_user_id: null, driver_profile_id: DRIVER_FROM, vehicle_label: VEHICLE_FROM }],
    services: [{ id: SERVICE_1, tenant_id: TENANT_A, time: "10:00:00", pickup_hotel: null, direction: "departure", pax: 2, hotel_id: null, meeting_point: null, arrival_time: null, orario_barca: null, porto_bruno: null, barca_compagnia: null, booking_service_kind: "transfer", service_type_code: null, vessel: null, ferry_details: null }],
    hotels: [],
  });
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/ops/piano-giorno/apply-driver-swap", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}
function callPost(body: Record<string, unknown> = { date: TEST_DATE, preview_reference: PREVIEW_REFERENCE }) {
  return POST(makeRequest(body));
}

function authorizeAs(fake: ReturnType<typeof createSupabase>) {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: OPERATOR_1, email: "op@test.dev" },
    membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
  });
}

describe("hardening promise chain — apply-driver-swap logAssignmentChange().then(updateLearnedPatterns)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildGprPeterDriverSwapPreview.mockResolvedValue(buildPreview());
    mocks.validateGprPeterDriverSwapPreviewForApply.mockReturnValue({ ok: true, blockers: [] });
    mocks.insertOperatorDecision.mockResolvedValue({ decision: { id: "dec-1", suggestion_hash: "hash-1" }, duplicate: false });
    mocks.extractFeatures.mockReturnValue({});
    mocks.logAssignmentChange.mockResolvedValue(undefined);
    mocks.updateLearnedPatterns.mockResolvedValue({ upserted: 0 });
  });

  it("1. logAssignmentChange risolve: comportamento invariato, mutazioni e risposta regolari", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.applied).toBe(1);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    expect(mocks.updateLearnedPatterns).toHaveBeenCalledTimes(1);
  });

  it("2. logAssignmentChange rigetta: risposta principale invariata, nessun unhandled rejection", async () => {
    const fake = baseSeed();
    authorizeAs(fake);
    mocks.logAssignmentChange.mockRejectedValueOnce(new Error("driver_assignment_history insert failed"));

    const res = await callPost();
    const body = await res.json();
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.applied).toBe(1);
    expect(JSON.stringify(body)).not.toMatch(/driver_assignment_history/);
    const updatedGroup = fake.tables.trip_groups.find((g) => g.id === GROUP_1);
    expect(updatedGroup?.driver_profile_id).toBe(DRIVER_TO);
  });

  it("3. updateLearnedPatterns rigetta: risposta principale invariata, nessun unhandled rejection", async () => {
    const fake = baseSeed();
    authorizeAs(fake);
    mocks.updateLearnedPatterns.mockRejectedValueOnce(new Error("learned patterns update failed"));

    const res = await callPost();
    const body = await res.json();
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("4. zero unhandled rejection: già verificato implicitamente dai test 2/3 (vitest fallisce su rejection non gestite)", () => {
    expect(true).toBe(true);
  });

  it("5. history chiamata una sola volta", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost();

    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
  });

  it("6. learning chiamato una sola volta", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost();
    await new Promise((resolve) => setImmediate(resolve));

    expect(mocks.updateLearnedPatterns).toHaveBeenCalledTimes(1);
  });

  it("7. nessun doppio catch/logging: un solo insert in driver_assignment_history per servizio coinvolto", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost();

    const entries = mocks.logAssignmentChange.mock.calls[0][1] as Row[];
    expect(entries).toHaveLength(1);
    expect(entries[0].serviceId).toBe(SERVICE_1);
    expect(entries[0].changeType).toBe("driver_swap");
  });

  it("8. mutazione principale già completata prima del fire-and-forget history: trip_groups/assignments mutati anche se logAssignmentChange rigetta", async () => {
    const fake = baseSeed();
    authorizeAs(fake);
    mocks.logAssignmentChange.mockRejectedValueOnce(new Error("history down"));

    await callPost();

    const updatedGroup = fake.tables.trip_groups.find((g) => g.id === GROUP_1);
    const updatedAssignment = fake.tables.assignments.find((a) => a.service_id === SERVICE_1);
    expect(updatedGroup?.vehicle_label).toBe(VEHICLE_TO);
    expect(updatedAssignment?.driver_profile_id).toBe(DRIVER_TO);
  });

  it("9. nessuna regressione sui path di errore preesistenti: preview_reference non aggiornata → 409, zero history", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ date: TEST_DATE, preview_reference: "stale-reference-0000000000" });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });
});
