import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_A1 = "a1111111-1111-4111-8111-111111111111";
const GROUP_A1 = "c1111111-1111-4111-8111-111111111111";
const DRIVER_A = "d1111111-1111-4111-8111-111111111111";
const DRIVER_SUSPENDED = "d1111111-1111-4111-8111-111111111112";
const DRIVER_B = "d2222222-2222-4222-8222-222222222222";
const PROFILE_A1 = "p1111111-1111-4111-8111-111111111111";
const PROFILE_INACTIVE = "p1111111-1111-4111-8111-111111111112";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

const RAW_DB_ERROR = { message: 'connection to server "internal-db-host.example" failed: SQLSTATE[08006]' };

/**
 * Fake Supabase in-memory, tenant-aware, generico — stesso schema riusato dai
 * file piano-giorno-trips-driver-status-guard.test.ts (create_trip),
 * piano-giorno-trips-update-driver-tenant-guard.test.ts e
 * piano-giorno-trips-update-service-status-guard.test.ts (update_trip).
 * fromCallIndex permette di colpire selettivamente la N-esima select sulla
 * stessa tabella (SEC-05 e FUNC-03 su update_trip leggono entrambi da
 * "memberships"/"driver_profiles": SEC-05 è la 1a, FUNC-03 la 2a).
 */
function createTenantAwareSupabase(
  seed: Partial<
    Record<
      | "services"
      | "assignments"
      | "trip_groups"
      | "daily_availability_confirmations"
      | "driver_daily_availability"
      | "driver_profiles"
      | "memberships"
      | "hotels"
      | "status_events"
      | "vehicles",
      Row[]
    >
  > = {}
) {
  const tables: Record<string, Row[]> = {
    services: [...(seed.services ?? [])],
    assignments: [...(seed.assignments ?? [])],
    trip_groups: [...(seed.trip_groups ?? [])],
    vehicles: [...(seed.vehicles ?? [])],
    daily_availability_confirmations: [...(seed.daily_availability_confirmations ?? [])],
    driver_daily_availability: [...(seed.driver_daily_availability ?? [])],
    driver_profiles: [...(seed.driver_profiles ?? [])],
    memberships: [...(seed.memberships ?? [])],
    hotels: [...(seed.hotels ?? [])],
    status_events: [...(seed.status_events ?? [])],
  };

  const tenantSensitive = new Set(["services", "assignments", "trip_groups"]);
  const tableErrors: Record<string, { message: string } | undefined> = {};
  const tableErrorFromCall: Record<string, number> = {};
  const selectCallCounts: Record<string, number> = {};

  const calls = {
    unscopedQueries: [] as string[],
    assignmentsUpserts: 0,
    assignmentsUpdates: 0,
    assignmentsDeletes: 0,
    tripGroupsInserts: 0,
    tripGroupsUpdates: 0,
    insertedAssignmentRows: [] as Row[],
    servicesQueried: 0,
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
    if (table === "services" && op === "select") calls.servicesQueried++;
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
          if (table === "assignments") calls.assignmentsDeletes += filtered.length;
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
              const inserted = { id: row.id ?? `${table}-${Math.random().toString(36).slice(2)}`, ...row };
              arr.push(inserted);
              if (table === "assignments") calls.insertedAssignmentRows.push(inserted);
            }
          }
          if (table === "assignments") calls.assignmentsUpserts += rowsArr.length;
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
    trip_groups: [{ id: GROUP_A1, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_A, driver_profile_id: null, vehicle_label: null, status: "active" }],
    assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_A1, group_id: GROUP_A1, driver_user_id: DRIVER_A, vehicle_label: null }],
    daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
    driver_daily_availability: [
      { tenant_id: TENANT_A, driver_user_id: DRIVER_A, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      { tenant_id: TENANT_A, driver_user_id: DRIVER_SUSPENDED, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      { tenant_id: TENANT_A, driver_profile_id: PROFILE_A1, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      { tenant_id: TENANT_A, driver_profile_id: PROFILE_INACTIVE, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
    ],
    memberships: [
      membershipRow(DRIVER_A, TENANT_A, { suspended: false }),
      membershipRow(DRIVER_SUSPENDED, TENANT_A, { suspended: true }),
      membershipRow(DRIVER_B, TENANT_B, { suspended: false }),
    ],
    driver_profiles: [
      driverProfileRow(PROFILE_A1, TENANT_A, DRIVER_A, { active: true }),
      driverProfileRow(PROFILE_INACTIVE, TENANT_A, DRIVER_A, { active: false }),
    ],
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

function updateTripBody(overrides: Record<string, unknown> = {}) {
  return {
    action: "update_trip",
    group_id: GROUP_A1,
    driver_user_id: DRIVER_A,
    ...overrides,
  };
}

function assertZeroWrites(fake: ReturnType<typeof createTenantAwareSupabase>) {
  expect(fake.calls.tripGroupsUpdates).toBe(0);
  expect(fake.calls.assignmentsUpdates).toBe(0);
  expect(fake.calls.assignmentsDeletes).toBe(0);
  expect(fake.calls.assignmentsUpserts).toBe(0);
}

describe("FUNC-03 residuo — guard operatività driver in piano-giorno/trips (update_trip, riuso helper)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. driver operativo (membership non sospesa): successo, comportamento invariato", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_A }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("2. membership sospesa (suspended=true): 409 DRIVER_NOT_ACTIVE, zero scritture", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_SUSPENDED }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_ACTIVE", message: "L'autista non è attualmente disponibile per nuove assegnazioni." });
    assertZeroWrites(fake);
  });

  it("3. driver_profile inattivo (active=false): 409 DRIVER_NOT_ACTIVE, zero scritture", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_A, driver_profile_id: PROFILE_INACTIVE }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_ACTIVE", message: "L'autista non è attualmente disponibile per nuove assegnazioni." });
    assertZeroWrites(fake);
  });

  it("4. entrambi presenti e operativi: successo", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_A, driver_profile_id: PROFILE_A1 }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("5. update parziale: solo driver_profile_id inviato (inattivo) — verificato sui valori finali", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_profile_id: PROFILE_INACTIVE }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("DRIVER_NOT_ACTIVE");
    assertZeroWrites(fake);
  });

  it("6. effectiveServiceIds invariato: il guard FUNC-03 non altera l'insieme servizi risolto da FUNC-02 (successo end-to-end)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_A, service_ids: [SERVICE_A1] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    const updated = fake.tables.assignments.find((a) => a.service_id === SERVICE_A1);
    expect(updated?.driver_user_id).toBe(DRIVER_A);
  });

  it("7. service_ids omesso, driver sospeso: 409 comunque (guard non dipende dalla presenza di service_ids)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_SUSPENDED }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("DRIVER_NOT_ACTIVE");
  });

  it("8. SEC-02 blocca prima: service_id di tenant B impedisce di raggiungere il guard FUNC-03", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1), serviceRow(TENANT_B, "b9999999-9999-4999-8999-999999999999")] });
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_SUSPENDED, service_ids: ["b9999999-9999-4999-8999-999999999999"] }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Uno o più servizi non trovati." });
    expect(fake.calls.membershipsQueried).toBe(0);
  });

  it("9. SEC-05 blocca prima: driver cross-tenant impedisce di raggiungere il guard FUNC-03", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_B }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    // SEC-05 esegue l'unica query su "memberships" in questo scenario: FUNC-03 non è mai raggiunto.
    expect(fake.calls.membershipsQueried).toBe(1);
  });

  it("10. FUNC-02 blocca prima: servizio non operativo impedisce di raggiungere il guard FUNC-03", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "cancelled" })] });
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_SUSPENDED, service_ids: [SERVICE_A1] }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("SERVICE_NOT_ASSIGNABLE");
    // SEC-05 (1a query memberships) passa comunque per un driver esistente/same-tenant;
    // FUNC-02 blocca prima che FUNC-03 esegua la propria (2a) query.
    expect(fake.calls.membershipsQueried).toBe(1);
  });

  it("11. zero scritture su rifiuto: nessun trip_group/assignment update, nessuna push, nessuna history", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(updateTripBody({ driver_user_id: DRIVER_SUSPENDED }));

    assertZeroWrites(fake);
    expect(mocks.sendPushToUser).not.toHaveBeenCalled();
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("12. timeline invariata: successo end-to-end su driver operativo, warnings presenti", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_A }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  it("13. create_trip invariato: guard su update_trip non tocca create_trip", async () => {
    const fake = baseSeed({
      services: [serviceRow(TENANT_A, "a2222222-2222-4222-8222-222222222222", { status: "new" })],
      trip_groups: [],
      assignments: [],
    });
    authorizeAs(fake);

    const res = await callPost({
      action: "create_trip",
      date: TEST_DATE,
      service_ids: ["a2222222-2222-4222-8222-222222222222"],
      driver_user_id: DRIVER_A,
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("14. update driver (cambio autista verso un sospeso): 409", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_SUSPENDED }));
    expect(res.status).toBe(409);
  });

  it("15. update mezzo (driver invariato e operativo): successo", async () => {
    const fake = baseSeed({
      vehicles: [{ id: "veh-1", tenant_id: TENANT_A, label: "Bus 9", capacity: 8, blocked_from: null, blocked_until: null, blocked_reason: null, is_blocked_manual: false }],
    });
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_A, vehicle_label: "Bus 9" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("16. update servizi (nuovo service_ids, driver operativo): successo", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_A, service_ids: [SERVICE_A1] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("17. error sanitization: errore query memberships → 500 fail-closed, nessun dettaglio DB esposto", async () => {
    const fake = baseSeed();
    // fromCallIndex=2: la 1a select su "memberships" è SEC-05 (deve
    // continuare a funzionare), la 2a è il guard FUNC-03 di questo task.
    fake.setError("memberships", RAW_DB_ERROR, 2);
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_A }));
    const body = await res.json();
    const raw = JSON.stringify(body);

    expect(res.status).toBe(500);
    expect(body).toEqual({ ok: false, error: "DRIVER_STATUS_CHECK_FAILED", message: "Errore durante la verifica dello stato dell'autista." });
    assertZeroWrites(fake);
    expect(raw).not.toMatch(/internal-db-host/);
    expect(raw.toLowerCase()).not.toMatch(/sqlstate/);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "piano_trip_driver_status_check_failed", level: "error" })
    );
  });

  it("17b. error sanitization: errore query driver_profiles → 500 fail-closed", async () => {
    const fake = baseSeed();
    // fromCallIndex=2: la 1a select su "driver_profiles" è SEC-05 (deve
    // continuare a funzionare), la 2a è il guard FUNC-03 di questo task.
    fake.setError("driver_profiles", RAW_DB_ERROR, 2);
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_A, driver_profile_id: PROFILE_A1 }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ ok: false, error: "DRIVER_STATUS_CHECK_FAILED", message: "Errore durante la verifica dello stato dell'autista." });
    assertZeroWrites(fake);
  });

  it("18. 401: utente non autenticato, guard mai raggiunto", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const fake = baseSeed();

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_SUSPENDED }));

    expect(res.status).toBe(401);
    expect(fake.calls.membershipsQueried).toBe(0);
  });

  it("19. 403: ruolo non autorizzato, guard mai raggiunto", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    const fake = baseSeed();

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_SUSPENDED }));

    expect(res.status).toBe(403);
    expect(fake.calls.membershipsQueried).toBe(0);
  });
});

describe("FUNC-03 residuo — sensibilità (comportamento atteso col guard integro, update_trip)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("20. sensibilità: driver sospeso deve essere bloccato quando il filtro suspended è integro", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_SUSPENDED }));
    expect(res.status).toBe(409);
  });

  it("21. sensibilità: profilo inattivo deve essere bloccato quando il filtro active è integro", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_A, driver_profile_id: PROFILE_INACTIVE }));
    expect(res.status).toBe(409);
  });
});
