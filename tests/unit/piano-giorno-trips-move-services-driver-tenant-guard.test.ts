import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_A1 = "a1111111-1111-4111-8111-111111111111";
const GROUP_SOURCE = "c0000000-0000-4000-8000-000000000000";
const GROUP_TARGET_WITH_DRIVER = "c1111111-1111-4111-8111-111111111111";
const GROUP_TARGET_NO_DRIVER = "c2222222-2222-4222-8222-222222222222";
const GROUP_TARGET_B = "c3333333-3333-4333-8333-333333333333";
const GROUP_GHOST = "c9999999-9999-4999-8999-999999999999";
const DRIVER_SOURCE = "d0000000-0000-4000-8000-000000000000";
const DRIVER_VALID = "d1111111-1111-4111-8111-111111111111";
const DRIVER_B = "d2222222-2222-4222-8222-222222222222";
const DRIVER_GHOST = "d9999999-9999-4999-8999-999999999999";
const DRIVER_NONDRIVER = "d3333333-3333-4333-8333-333333333333";
const DRIVER_TARGET_EXISTING = "d4444444-4444-4444-8444-444444444444";
const PROFILE_VALID = "p1111111-1111-4111-8111-111111111111";
const PROFILE_B = "p2222222-2222-4222-8222-222222222222";
const PROFILE_UNLINKED = "p3333333-3333-4333-8333-333333333333";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

const RAW_DB_ERROR = { message: 'connection to server "internal-db-host.example" failed: SQLSTATE[08006]' };

/**
 * Fake Supabase in-memory, tenant-aware, generico — stesso schema riusato dai
 * file piano-giorno-trips-{driver,update-driver,swap-driver}-tenant-guard.test.ts.
 * fromCallIndex permette di colpire selettivamente la N-esima select su
 * "memberships"/"driver_profiles" (i due guard SEC-05 di questo task — ramo
 * nuovo giro e ramo valori finali — possono entrambi interrogarle in
 * sequenza a seconda dello scenario).
 */
function createTenantAwareSupabase(
  seed: Partial<
    Record<
      | "services"
      | "assignments"
      | "trip_groups"
      | "driver_daily_availability"
      | "driver_profiles"
      | "memberships"
      | "hotels"
      | "daily_availability_confirmations"
      | "vehicles"
      | "status_events",
      Row[]
    >
  > = {}
) {
  const tables: Record<string, Row[]> = {
    services: [...(seed.services ?? [])],
    assignments: [...(seed.assignments ?? [])],
    trip_groups: [...(seed.trip_groups ?? [])],
    driver_daily_availability: [...(seed.driver_daily_availability ?? [])],
    driver_profiles: [...(seed.driver_profiles ?? [])],
    memberships: [...(seed.memberships ?? [])],
    hotels: [...(seed.hotels ?? [])],
    daily_availability_confirmations: [...(seed.daily_availability_confirmations ?? [])],
    vehicles: [...(seed.vehicles ?? [])],
    status_events: [...(seed.status_events ?? [])],
  };

  const tenantSensitive = new Set(["services", "assignments", "trip_groups"]);
  const tableErrors: Record<string, { message: string } | undefined> = {};
  const tableErrorFromCall: Record<string, number> = {};
  const selectCallCounts: Record<string, number> = {};

  const calls = {
    unscopedQueries: [] as string[],
    tripGroupsInserts: 0,
    tripGroupsUpdates: 0,
    assignmentsUpdates: 0,
    membershipsQueried: 0,
    driverProfilesQueried: 0,
  };

  function makeQueryBuilder(table: string, op: "select" | "delete" | "update", updatePayload?: Row) {
    const rows = tables[table];
    let filtered = rows;
    let sawTenantFilter = false;
    let limitN: number | null = null;
    let thisCallIndex = 0;
    if (op === "select") {
      selectCallCounts[table] = (selectCallCounts[table] ?? 0) + 1;
      thisCallIndex = selectCallCounts[table];
    }
    if (table === "memberships" && op === "select") calls.membershipsQueried++;
    if (table === "driver_profiles" && op === "select") calls.driverProfilesQueried++;

    function shouldError(): boolean {
      if (!tableErrors[table]) return false;
      const fromCall = tableErrorFromCall[table] ?? 1;
      return op === "select" ? thisCallIndex >= fromCall : true;
    }

    function resolveScope() {
      if (tenantSensitive.has(table) && !sawTenantFilter) {
        calls.unscopedQueries.push(`${table}.${op}`);
      }
      if (limitN !== null) filtered = filtered.slice(0, limitN);
    }

    const builder = {
      eq(field: string, value: unknown) {
        if (field === "tenant_id") sawTenantFilter = true;
        filtered = filtered.filter((r) => r[field] === value);
        return builder;
      },
      neq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] !== value);
        return builder;
      },
      in(field: string, values: unknown[]) {
        filtered = filtered.filter((r) => values.includes(r[field]));
        return builder;
      },
      not(field: string, _op: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] !== value);
        return builder;
      },
      order(field: string, opts?: { ascending?: boolean }) {
        const ascending = opts?.ascending !== false;
        filtered = [...filtered].sort((a, b) => {
          const av = a[field] as string;
          const bv = b[field] as string;
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (ascending ? 1 : -1);
        });
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      select() {
        return builder;
      },
      maybeSingle() {
        resolveScope();
        if (shouldError()) {
          return Promise.resolve({ data: null, error: tableErrors[table] });
        }
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      single() {
        resolveScope();
        if (shouldError()) {
          return Promise.resolve({ data: null, error: tableErrors[table] });
        }
        return Promise.resolve({ data: filtered[0] ?? null, error: filtered[0] ? null : { message: "not found" } });
      },
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        resolveScope();
        if (shouldError()) {
          return Promise.resolve({ data: null, error: tableErrors[table] }).then(resolve, reject);
        }
        if (op === "delete") {
          const toRemove = new Set(filtered);
          for (let i = rows.length - 1; i >= 0; i--) {
            if (toRemove.has(rows[i])) rows.splice(i, 1);
          }
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        if (op === "update" && updatePayload) {
          for (const row of filtered) Object.assign(row, updatePayload);
          if (table === "assignments") calls.assignmentsUpdates += filtered.length;
          if (table === "trip_groups") calls.tripGroupsUpdates += filtered.length;
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
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
        delete() {
          return makeQueryBuilder(table, "delete");
        },
        update(payload: Row) {
          return makeQueryBuilder(table, "update", payload);
        },
        insert(rowsOrRow: Row | Row[]) {
          const rowsArr = Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow];
          const inserted = rowsArr.map((r) => ({ id: r.id ?? `${table}-${Math.random().toString(36).slice(2)}`, ...r }));
          tables[table].push(...inserted);
          if (table === "trip_groups") calls.tripGroupsInserts += inserted.length;
          return {
            select() {
              return {
                single() {
                  return Promise.resolve({ data: inserted[0] ?? null, error: null });
                },
                maybeSingle() {
                  return Promise.resolve({ data: inserted[0] ?? null, error: null });
                },
              };
            },
            then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
              return Promise.resolve({ data: inserted, error: null }).then(resolve, reject);
            },
          };
        },
        upsert(rowsOrRow: Row | Row[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
          const rowsArr = Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow];
          const conflictFields = (opts.onConflict ?? "id").split(",");
          const arr = tables[table];
          for (const row of rowsArr) {
            const existingIdx = arr.findIndex((r) => conflictFields.every((f) => r[f] === row[f]));
            if (existingIdx >= 0) {
              if (!opts.ignoreDuplicates) Object.assign(arr[existingIdx], row);
            } else {
              arr.push({ id: row.id ?? `${table}-${Math.random().toString(36).slice(2)}`, ...row });
            }
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };

  return {
    admin,
    tables,
    calls,
    setError(table: string, err: { message: string } | null, fromCallIndex = 1) {
      tableErrors[table] = err ?? undefined;
      tableErrorFromCall[table] = fromCallIndex;
    },
  };
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  auditLog: vi.fn(),
  sendPushToUser: vi.fn(),
  logAssignmentChange: vi.fn().mockResolvedValue(undefined),
  updateLearnedPatterns: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));
vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: mocks.auditLog,
}));
vi.mock("@/lib/server/web-push", () => ({
  sendPushToUser: mocks.sendPushToUser,
}));
vi.mock("@/lib/server/assignment-history", () => ({
  extractFeatures: vi.fn().mockReturnValue({}),
  logAssignmentChange: mocks.logAssignmentChange,
}));
vi.mock("@/lib/server/learned-patterns", () => ({
  updateLearnedPatterns: mocks.updateLearnedPatterns,
}));
vi.mock("@/lib/server/vehicle-commitments", () => ({
  loadVehicleCommitmentsForDate: vi.fn().mockResolvedValue({ byVehicleId: new Map() }),
}));
vi.mock("@/lib/server/vehicle-availability", () => ({
  isVehicleManuallyBlockedOnDate: vi.fn().mockReturnValue(false),
  manualVehicleBlockMessage: vi.fn().mockReturnValue(""),
}));

import { POST } from "@/app/api/ops/piano-giorno/trips/route";

function serviceRow(tenantId: string, id: string, overrides: Row = {}): Row {
  return {
    id,
    tenant_id: tenantId,
    time: "10:00:00",
    pickup_hotel: null,
    direction: "departure",
    pax: 2,
    hotel_id: null,
    meeting_point: null,
    arrival_time: null,
    orario_barca: null,
    porto_bruno: null,
    barca_compagnia: null,
    booking_service_kind: "transfer",
    service_type_code: null,
    vessel: null,
    ferry_details: null,
    status: "new",
    is_draft: false,
    ...overrides,
  };
}

function membershipRow(userId: string, tenantId: string, overrides: Row = {}): Row {
  return { user_id: userId, tenant_id: tenantId, role: "driver", suspended: false, ...overrides };
}

function driverProfileRow(id: string, tenantId: string, userId: string | null, overrides: Row = {}): Row {
  return { id, tenant_id: tenantId, user_id: userId, active: true, ...overrides };
}

function baseSeed(overrides: Parameters<typeof createTenantAwareSupabase>[0] = {}) {
  return createTenantAwareSupabase({
    services: [serviceRow(TENANT_A, SERVICE_A1)],
    trip_groups: [
      { id: GROUP_SOURCE, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_SOURCE, driver_profile_id: null, vehicle_label: null, status: "active" },
      { id: GROUP_TARGET_WITH_DRIVER, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_TARGET_EXISTING, driver_profile_id: null, vehicle_label: null, status: "active" },
      { id: GROUP_TARGET_NO_DRIVER, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: null, driver_profile_id: null, vehicle_label: null, status: "active" },
      { id: GROUP_TARGET_B, tenant_id: TENANT_B, date: TEST_DATE, driver_user_id: null, driver_profile_id: null, vehicle_label: null, status: "active" },
    ],
    assignments: [
      { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_A1, group_id: GROUP_SOURCE, driver_user_id: DRIVER_SOURCE, vehicle_label: null },
    ],
    driver_daily_availability: [
      { tenant_id: TENANT_A, driver_user_id: DRIVER_VALID, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      { tenant_id: TENANT_A, driver_user_id: DRIVER_TARGET_EXISTING, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      { tenant_id: TENANT_A, driver_profile_id: PROFILE_VALID, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
    ],
    memberships: [
      membershipRow(DRIVER_SOURCE, TENANT_A),
      membershipRow(DRIVER_VALID, TENANT_A),
      membershipRow(DRIVER_TARGET_EXISTING, TENANT_A),
      membershipRow(DRIVER_B, TENANT_B),
      membershipRow(DRIVER_NONDRIVER, TENANT_A, { role: "operator" }),
    ],
    driver_profiles: [
      driverProfileRow(PROFILE_VALID, TENANT_A, DRIVER_VALID),
      driverProfileRow(PROFILE_B, TENANT_B, DRIVER_B),
      driverProfileRow(PROFILE_UNLINKED, TENANT_A, null),
    ],
    daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
    ...overrides,
  });
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/ops/piano-giorno/trips", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}
function callPost(body: Record<string, unknown>) {
  return POST(makeRequest(body));
}

function authorizeAs(fake: ReturnType<typeof createTenantAwareSupabase>, role: string = "operator") {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: TENANT_A, role, suspended: false },
  });
}

function moveServicesBody(overrides: Record<string, unknown> = {}) {
  return {
    action: "move_services",
    service_ids: [SERVICE_A1],
    group_id: GROUP_SOURCE,
    ...overrides,
  };
}

function assertZeroWrites(fake: ReturnType<typeof createTenantAwareSupabase>) {
  expect(fake.calls.tripGroupsInserts).toBe(0);
  expect(fake.calls.tripGroupsUpdates).toBe(0);
  expect(fake.calls.assignmentsUpdates).toBe(0);
}

describe("SEC-05 residuo — driver tenant ownership guard in piano-giorno/trips (move_services, entrambi i rami)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── RAMO GRUPPO ESISTENTE ────────────────────────────────────────────────

  it("1. target group esistente senza driver + driver_user_id same-tenant nel body: successo", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_NO_DRIVER, driver_user_id: DRIVER_VALID }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    const updated = fake.tables.assignments.find((a) => a.service_id === SERVICE_A1);
    expect(updated?.driver_user_id).toBe(DRIVER_VALID);
    expect(updated?.group_id).toBe(GROUP_TARGET_NO_DRIVER);
  });

  it("2. target group esistente senza driver + driver_user_id di tenant B: 404, zero scritture", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_NO_DRIVER, driver_user_id: DRIVER_B }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    assertZeroWrites(fake);
  });

  it("3. target group esistente senza driver + driver_user_id inesistente: stesso 404", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_NO_DRIVER, driver_user_id: DRIVER_GHOST }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    assertZeroWrites(fake);
  });

  it("4. target group esistente senza driver + utente same-tenant non-driver: 404", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_NO_DRIVER, driver_user_id: DRIVER_NONDRIVER }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    assertZeroWrites(fake);
  });

  it("5. target group esistente senza driver + driver_profile_id same-tenant: successo", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_NO_DRIVER, driver_user_id: DRIVER_VALID, driver_profile_id: PROFILE_VALID }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("6. target group esistente senza driver + driver_profile_id di tenant B: 404", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_NO_DRIVER, driver_user_id: DRIVER_VALID, driver_profile_id: PROFILE_B }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    assertZeroWrites(fake);
  });

  it("7. target group esistente senza driver + coppia user/profile incoerente: 404", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_NO_DRIVER, driver_user_id: DRIVER_SOURCE, driver_profile_id: PROFILE_VALID }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    assertZeroWrites(fake);
  });

  it("8. target group esistente CON driver già valido, nessun driver nel body: guard rivalida il driver del gruppo, successo invariato", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_WITH_DRIVER }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    const updated = fake.tables.assignments.find((a) => a.service_id === SERVICE_A1);
    expect(updated?.driver_user_id).toBe(DRIVER_TARGET_EXISTING);
  });

  it("9. target group di tenant B: 404 preesistente (ownership gruppo, non SEC-05 driver), guard SEC-05 mai raggiunto", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_B, driver_user_id: DRIVER_VALID }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Giro di destinazione non trovato." });
    expect(fake.calls.membershipsQueried).toBe(0);
  });

  it("10. gruppo destinazione inesistente: stesso 404 preesistente (ownership gruppo)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ target_group_id: GROUP_GHOST, driver_user_id: DRIVER_VALID }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Giro di destinazione non trovato." });
  });

  // ─── RAMO NUOVO GIRO ────────────────────────────────────────────────────

  it("11. nuovo giro, driver_user_id same-tenant: successo", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ date: TEST_DATE, driver_user_id: DRIVER_VALID }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.tripGroupsInserts).toBe(1);
  });

  it("12. nuovo giro, driver_user_id di tenant B: 404, zero trip_group creato", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ date: TEST_DATE, driver_user_id: DRIVER_B }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    assertZeroWrites(fake);
  });

  it("13. nuovo giro, driver_user_id inesistente: stesso 404, zero trip_group creato", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ date: TEST_DATE, driver_user_id: DRIVER_GHOST }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    assertZeroWrites(fake);
  });

  it("14. nuovo giro, ruolo non-driver: 404, zero trip_group creato", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ date: TEST_DATE, driver_user_id: DRIVER_NONDRIVER }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    assertZeroWrites(fake);
  });

  it("15. nuovo giro, driver_profile_id same-tenant coerente: successo", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ date: TEST_DATE, driver_user_id: DRIVER_VALID, driver_profile_id: PROFILE_VALID }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.tripGroupsInserts).toBe(1);
  });

  it("16. nuovo giro, driver_profile_id di tenant B: 404, zero trip_group creato", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ date: TEST_DATE, driver_user_id: DRIVER_VALID, driver_profile_id: PROFILE_B }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    assertZeroWrites(fake);
  });

  it("16b. nuovo giro, solo driver_profile_id di tenant B (senza driver_user_id): 404 isolato sul filtro tenant driver_profiles, non sulla coerenza coppia", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    // Nessun driver_user_id: il ramo di coerenza coppia (che richiede
    // entrambi i campi) non scatta mai — questo scenario isola davvero il
    // filtro tenant sulla query driver_profiles.
    const res = await callPost(moveServicesBody({ date: TEST_DATE, driver_profile_id: PROFILE_B }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    assertZeroWrites(fake);
  });

  it("17. nuovo giro, coppia user/profile coerente (profilo non collegato a nessuno): guard SEC-05 non blocca (nessun 404)", async () => {
    const fake = baseSeed({
      driver_daily_availability: [
        { tenant_id: TENANT_A, driver_user_id: DRIVER_VALID, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
        { tenant_id: TENANT_A, driver_profile_id: PROFILE_UNLINKED, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      ],
    });
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ date: TEST_DATE, driver_user_id: DRIVER_VALID, driver_profile_id: PROFILE_UNLINKED }));
    const body = await res.json();

    // Il guard SEC-05 (oggetto di questo task) verifica la coppia ed è
    // coerente (profilo non collegato a nessun altro utente): nessun 404.
    expect(body.error).not.toBe("DRIVER_NOT_FOUND");
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("18. nuovo giro, coppia user/profile incoerente: 404, zero trip_group creato", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ date: TEST_DATE, driver_user_id: DRIVER_SOURCE, driver_profile_id: PROFILE_VALID }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    assertZeroWrites(fake);
  });

  it("19. nuovo giro, entrambi assenti: guard SEC-05 skippato (no-op); comportamento attuale invariato — la route richiede comunque un autista per regola di business preesistente, non SEC-05", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ date: TEST_DATE }));
    const body = await res.json();

    // validateTripPayload richiede sempre un driver_user_id (comportamento
    // preesistente, identico a create_trip, non oggetto di SEC-05): qui
    // verifichiamo solo che il guard SEC-05 non produca mai un falso 404.
    expect(body.error).not.toBe("DRIVER_NOT_FOUND");
    expect(res.status).toBe(409);
    expect(body).toEqual({ ok: false, error: "Seleziona un autista prima di salvare il giro." });
    expect(fake.calls.tripGroupsInserts).toBe(0);
    expect(fake.calls.membershipsQueried).toBe(0);
  });

  it("20. nuovo giro, valori null espliciti: comportamento attuale invariato (equivalente ad assenti, guard SEC-05 skippato)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ date: TEST_DATE, driver_user_id: null, driver_profile_id: null }));
    const body = await res.json();

    expect(body.error).not.toBe("DRIVER_NOT_FOUND");
    expect(res.status).toBe(409);
    expect(fake.calls.membershipsQueried).toBe(0);
  });

  // ─── GENERALI ───────────────────────────────────────────────────────────

  it("21. tenant_id malevolo nel body viene ignorato: ownership verificata contro il tenant di sessione", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_NO_DRIVER, driver_user_id: DRIVER_VALID, tenant_id: TENANT_B }));
    const body = await res.json();

    expect(res.status).toBe(200);
    const updated = fake.tables.assignments.find((a) => a.service_id === SERVICE_A1);
    expect(updated?.tenant_id).toBe(TENANT_A);
  });

  it("22. errore query memberships (ramo nuovo giro): 500 fail-closed, zero scritture", async () => {
    const fake = baseSeed();
    fake.setError("memberships", RAW_DB_ERROR, 1);
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ date: TEST_DATE, driver_user_id: DRIVER_VALID }));
    const body = await res.json();
    const raw = JSON.stringify(body);

    expect(res.status).toBe(500);
    expect(body).toEqual({ ok: false, error: "DRIVER_VERIFICATION_FAILED", message: "Errore durante la verifica dell'autista." });
    assertZeroWrites(fake);
    expect(raw).not.toMatch(/internal-db-host/);
    expect(raw.toLowerCase()).not.toMatch(/sqlstate/);
  });

  it("23. errore query driver_profiles (ramo valori finali): 500 fail-closed, zero scritture", async () => {
    const fake = baseSeed();
    fake.setError("driver_profiles", RAW_DB_ERROR, 1);
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_NO_DRIVER, driver_user_id: DRIVER_VALID, driver_profile_id: PROFILE_VALID }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ ok: false, error: "DRIVER_VERIFICATION_FAILED", message: "Errore durante la verifica dell'autista." });
    assertZeroWrites(fake);
  });

  it("24. zero insert trip_group su rifiuto (ramo nuovo giro)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(moveServicesBody({ date: TEST_DATE, driver_user_id: DRIVER_B }));

    expect(fake.calls.tripGroupsInserts).toBe(0);
  });

  it("25. zero update assignments su rifiuto (ramo gruppo esistente)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_NO_DRIVER, driver_user_id: DRIVER_B }));

    expect(fake.calls.assignmentsUpdates).toBe(0);
  });

  it("26. zero history su rifiuto (logAssignmentChange non chiamata da move_services in nessun caso)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_NO_DRIVER, driver_user_id: DRIVER_B }));

    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("27. zero notifiche su rifiuto (move_services non invia push in nessun caso)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_NO_DRIVER, driver_user_id: DRIVER_B }));

    expect(mocks.sendPushToUser).not.toHaveBeenCalled();
  });

  it("28. timeline invariata su successo: warnings presenti, group_id nel body di risposta", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_NO_DRIVER, driver_user_id: DRIVER_VALID }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.group_id).toBe(GROUP_TARGET_NO_DRIVER);
  });

  it("29. create_trip invariato: guard su move_services non tocca create_trip", async () => {
    const fake = baseSeed({
      services: [serviceRow(TENANT_A, "a5555555-5555-4555-8555-555555555555", { status: "new" })],
      trip_groups: [],
      assignments: [],
      driver_daily_availability: [
        { tenant_id: TENANT_A, driver_user_id: DRIVER_VALID, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
        { tenant_id: TENANT_A, driver_profile_id: PROFILE_VALID, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      ],
    });
    authorizeAs(fake);

    const res = await callPost({
      action: "create_trip",
      date: TEST_DATE,
      service_ids: ["a5555555-5555-4555-8555-555555555555"],
      driver_user_id: DRIVER_VALID,
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("30. update_trip invariato: guard su move_services non tocca update_trip", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ action: "update_trip", group_id: GROUP_SOURCE, driver_user_id: DRIVER_VALID, service_ids: [SERVICE_A1] });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("31. swap_driver invariato: guard su move_services non tocca swap_driver", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ action: "swap_driver", date: TEST_DATE, from_driver_id: DRIVER_SOURCE, to_driver_id: DRIVER_VALID });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("32. 401: utente non autenticato, guard mai raggiunto", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const fake = baseSeed();

    const res = await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_NO_DRIVER, driver_user_id: DRIVER_B }));

    expect(res.status).toBe(401);
    expect(fake.calls.membershipsQueried).toBe(0);
  });

  it("33. 403: ruolo non autorizzato, guard mai raggiunto", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    const fake = baseSeed();

    const res = await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_NO_DRIVER, driver_user_id: DRIVER_B }));

    expect(res.status).toBe(403);
    expect(fake.calls.membershipsQueried).toBe(0);
  });

  it("34. privacy/sanitizzazione: nessuna risposta contiene tenant B, SQLSTATE, o dettagli Supabase", async () => {
    const fakeCrossTenant = baseSeed();
    authorizeAs(fakeCrossTenant);
    const resCrossTenant = await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_NO_DRIVER, driver_user_id: DRIVER_B }));
    const rawCrossTenant = JSON.stringify(await resCrossTenant.json());

    expect(rawCrossTenant).not.toMatch(new RegExp(TENANT_B));
    expect(rawCrossTenant.toLowerCase()).not.toMatch(/sqlstate|stack|supabase|postgres/);

    const fakeDbError = baseSeed();
    fakeDbError.setError("memberships", RAW_DB_ERROR, 1);
    authorizeAs(fakeDbError);
    const resDbError = await callPost(moveServicesBody({ date: TEST_DATE, driver_user_id: DRIVER_VALID }));
    const rawDbError = JSON.stringify(await resDbError.json());
    expect(rawDbError).not.toMatch(/internal-db-host/);
    expect(rawDbError.toLowerCase()).not.toMatch(/sqlstate/);
  });
});

describe("SEC-05 residuo — sensibilità (comportamento atteso col guard integro, move_services)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("35. sensibilità: target di tenant B deve essere bloccato quando il filtro tenant su memberships è integro", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_NO_DRIVER, driver_user_id: DRIVER_B }));
    expect(res.status).toBe(404);
  });

  it("36. sensibilità: target non-driver deve essere bloccato quando il filtro role='driver' è integro", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_NO_DRIVER, driver_user_id: DRIVER_NONDRIVER }));
    expect(res.status).toBe(404);
  });

  it("37. sensibilità: profilo di tenant B (isolato, senza driver_user_id) deve essere bloccato quando il filtro tenant su driver_profiles è integro", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ date: TEST_DATE, driver_profile_id: PROFILE_B }));
    expect(res.status).toBe(404);
  });

  it("38. sensibilità: bypass del guard nel ramo gruppo esistente deve essere rilevabile (verificato con guard integro: 404 reale)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_NO_DRIVER, driver_user_id: DRIVER_B }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("DRIVER_NOT_FOUND");
  });

  it("39. sensibilità: bypass del guard nel ramo nuovo giro deve essere rilevabile (verificato con guard integro: 404 reale)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ date: TEST_DATE, driver_user_id: DRIVER_B }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("DRIVER_NOT_FOUND");
  });
});
