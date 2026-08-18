import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_A1 = "a1111111-1111-4111-8111-111111111111";
const DRIVER_A = "d1111111-1111-4111-8111-111111111111";
const DRIVER_SUSPENDED = "d1111111-1111-4111-8111-111111111112";
const DRIVER_B = "d2222222-2222-4222-8222-222222222222";
const DRIVER_GHOST = "d9999999-9999-4999-8999-999999999999";
const PROFILE_A1 = "p1111111-1111-4111-8111-111111111111";
const PROFILE_INACTIVE = "p1111111-1111-4111-8111-111111111112";
const PROFILE_SUSPENDED_ACTIVE = "p1111111-1111-4111-8111-111111111113";
const PROFILE_SUSPENDED_INACTIVE = "p1111111-1111-4111-8111-111111111114";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

const RAW_DB_ERROR = { message: 'connection to server "internal-db-host.example" failed: SQLSTATE[08006]' };

/**
 * Fake Supabase in-memory, tenant-aware, generico — stesso schema riusato dai
 * file piano-giorno-trips-tenant-isolation/-driver-tenant-guard/
 * -service-status-guard.test.ts. Applica realmente eq/neq/in/not/limit/order/
 * select/insert/upsert/update/delete/maybeSingle/single per qualunque tabella
 * seedata. Dedicato ai test del guard FUNC-03 residuo (operatività driver) su
 * create_trip. setError supporta un fromCallIndex per colpire selettivamente
 * la N-esima query select sulla stessa tabella (es. per non rompere SEC-05
 * quando si simula un errore mirato al guard FUNC-03 su "memberships").
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
      | "status_events",
      Row[]
    >
  > = {}
) {
  const tables: Record<string, Row[]> = {
    services: [...(seed.services ?? [])],
    assignments: [...(seed.assignments ?? [])],
    trip_groups: [...(seed.trip_groups ?? [])],
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
    tripGroupsInserts: 0,
    insertedAssignmentRows: [] as Row[],
    membershipsSelectCount: 0,
    driverProfilesSelectCount: 0,
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
    if (table === "memberships" && op === "select") calls.membershipsSelectCount++;
    if (table === "driver_profiles" && op === "select") calls.driverProfilesSelectCount++;

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
  buildAssignmentDecisionFeatures: (base, decision = {}) => ({ ...base, ...Object.fromEntries(Object.entries(decision).filter(([, v]) => v !== undefined)) }),
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
    daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
    driver_daily_availability: [
      { tenant_id: TENANT_A, driver_user_id: DRIVER_A, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      { tenant_id: TENANT_A, driver_user_id: DRIVER_SUSPENDED, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      { tenant_id: TENANT_A, driver_profile_id: PROFILE_A1, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      { tenant_id: TENANT_A, driver_profile_id: PROFILE_INACTIVE, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      { tenant_id: TENANT_A, driver_profile_id: PROFILE_SUSPENDED_ACTIVE, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      { tenant_id: TENANT_A, driver_profile_id: PROFILE_SUSPENDED_INACTIVE, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
    ],
    memberships: [
      membershipRow(DRIVER_A, TENANT_A, { suspended: false }),
      membershipRow(DRIVER_SUSPENDED, TENANT_A, { suspended: true }),
      membershipRow(DRIVER_B, TENANT_B, { suspended: false }),
    ],
    driver_profiles: [
      // PROFILE_INACTIVE è collegato a DRIVER_A (non a DRIVER_SUSPENDED) per
      // restare coerente con SEC-05 quando testato in coppia con DRIVER_A —
      // altrimenti SEC-05 bloccherebbe con 404 "coppia incoerente" prima che
      // il guard FUNC-03 (oggetto di questo file) venga mai raggiunto.
      driverProfileRow(PROFILE_A1, TENANT_A, DRIVER_A, { active: true }),
      driverProfileRow(PROFILE_INACTIVE, TENANT_A, DRIVER_A, { active: false }),
      driverProfileRow(PROFILE_SUSPENDED_ACTIVE, TENANT_A, DRIVER_SUSPENDED, { active: true }),
      driverProfileRow(PROFILE_SUSPENDED_INACTIVE, TENANT_A, DRIVER_SUSPENDED, { active: false }),
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

function createTripBody(overrides: Record<string, unknown> = {}) {
  return {
    action: "create_trip",
    date: TEST_DATE,
    service_ids: [SERVICE_A1],
    ...overrides,
  };
}

function assertZeroWrites(fake: ReturnType<typeof createTenantAwareSupabase>) {
  expect(fake.calls.tripGroupsInserts).toBe(0);
  expect(fake.calls.assignmentsUpserts).toBe(0);
}

describe("FUNC-03 residuo — guard operatività driver in piano-giorno/trips (create_trip)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. driver_user operativo same-tenant: successo, comportamento invariato", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(createTripBody({ driver_user_id: DRIVER_A }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("2. membership suspended=true: 409 DRIVER_NOT_ACTIVE, zero scritture", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(createTripBody({ driver_user_id: DRIVER_SUSPENDED }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_ACTIVE", message: "L'autista non è attualmente disponibile per nuove assegnazioni." });
    assertZeroWrites(fake);
  });

  it("3. driver_profile active=true: il guard operativo passa, successo", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(createTripBody({ driver_profile_id: PROFILE_A1 }));
    const body = await res.json();

    // La route richiede comunque driver_user_id per la regola di business
    // "Seleziona un autista prima di salvare il giro." (invariata, non FUNC-03):
    // qui verifichiamo solo che il guard operativo non blocchi con 409 DRIVER_NOT_ACTIVE.
    expect(body.error).not.toBe("DRIVER_NOT_ACTIVE");
  });

  it("4. driver_profile active=false: 409 DRIVER_NOT_ACTIVE, zero scritture", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(createTripBody({ driver_user_id: DRIVER_A, driver_profile_id: PROFILE_INACTIVE }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_ACTIVE", message: "L'autista non è attualmente disponibile per nuove assegnazioni." });
    assertZeroWrites(fake);
  });

  it("5. user e profile entrambi operativi e coerenti: successo", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(createTripBody({ driver_user_id: DRIVER_A, driver_profile_id: PROFILE_A1 }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("6. user operativo + profile inattivo: 409, zero scritture", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(createTripBody({ driver_user_id: DRIVER_A, driver_profile_id: PROFILE_INACTIVE }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("DRIVER_NOT_ACTIVE");
    assertZeroWrites(fake);
  });

  it("7. user sospeso + profile attivo: 409, zero scritture", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(createTripBody({ driver_user_id: DRIVER_SUSPENDED, driver_profile_id: PROFILE_SUSPENDED_ACTIVE }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("DRIVER_NOT_ACTIVE");
    assertZeroWrites(fake);
  });

  it("8. driver cross-tenant: 404 DRIVER_NOT_FOUND (SEC-05 invariato), guard operativo mai raggiunto", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(createTripBody({ driver_user_id: DRIVER_B }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    assertZeroWrites(fake);
  });

  it("9. driver inesistente: 404, guard operativo mai raggiunto", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(createTripBody({ driver_user_id: DRIVER_GHOST }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    assertZeroWrites(fake);
  });

  it("10. ruolo non-driver: 404, guard operativo mai raggiunto", async () => {
    const fake = baseSeed({
      memberships: [membershipRow(DRIVER_A, TENANT_A, { role: "operator", suspended: false })],
    });
    authorizeAs(fake);

    const res = await callPost(createTripBody({ driver_user_id: DRIVER_A }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    assertZeroWrites(fake);
  });

  it("11. servizi non operativi: FUNC-02 blocca prima del guard operativo driver", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "cancelled" })] });
    authorizeAs(fake);

    const res = await callPost(createTripBody({ driver_user_id: DRIVER_SUSPENDED }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("SERVICE_NOT_ASSIGNABLE");
    expect(fake.calls.membershipsSelectCount).toBe(1); // solo la query SEC-05, FUNC-03 non raggiunto
  });

  it("12. entrambi driver ID assenti: guard FUNC-03 skippato, comportamento corrente invariato", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(createTripBody());
    const body = await res.json();

    // Comportamento preesistente: create_trip richiede sempre driver_user_id
    // per "Seleziona un autista prima di salvare il giro." — non è FUNC-03.
    expect(body.error).not.toBe("DRIVER_NOT_ACTIVE");
    expect(body.error).not.toBe("DRIVER_NOT_FOUND");
  });

  it("13. tenant_id malevolo nel body: ignorato, verifica operatività contro tenant di sessione", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(createTripBody({ driver_user_id: DRIVER_A, tenant_id: TENANT_B }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.insertedAssignmentRows[0].tenant_id).toBe(TENANT_A);
  });

  it("14. errore query memberships (2a select, dopo SEC-05): 500 fail-closed, zero scritture", async () => {
    const fake = baseSeed();
    // fromCallIndex=2: la 1a select su "memberships" è SEC-05 (deve
    // continuare a funzionare), la 2a è il guard operativo FUNC-03.
    fake.setError("memberships", RAW_DB_ERROR, 2);
    authorizeAs(fake);

    const res = await callPost(createTripBody({ driver_user_id: DRIVER_A }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ ok: false, error: "DRIVER_STATUS_CHECK_FAILED", message: "Errore durante la verifica dello stato dell'autista." });
    assertZeroWrites(fake);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "piano_trip_driver_status_check_failed", level: "error" })
    );
  });

  it("15. errore query driver_profiles (2a select, dopo SEC-05): 500 fail-closed, zero scritture", async () => {
    const fake = baseSeed();
    fake.setError("driver_profiles", RAW_DB_ERROR, 2);
    authorizeAs(fake);

    const res = await callPost(createTripBody({ driver_user_id: DRIVER_A, driver_profile_id: PROFILE_A1 }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ ok: false, error: "DRIVER_STATUS_CHECK_FAILED", message: "Errore durante la verifica dello stato dell'autista." });
    assertZeroWrites(fake);
  });

  it("16. zero scritture su 409/500: nessun trip_group/assignment/push/history", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(createTripBody({ driver_user_id: DRIVER_SUSPENDED }));

    expect(fake.calls.tripGroupsInserts).toBe(0);
    expect(fake.calls.assignmentsUpserts).toBe(0);
    expect(mocks.sendPushToUser).not.toHaveBeenCalled();
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("17. timeline invariata: successo end-to-end con driver operativo", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(createTripBody({ driver_user_id: DRIVER_A }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.insertedAssignmentRows[0].driver_user_id).toBe(DRIVER_A);
  });

  it("18. warnings invariati: array presente su successo", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(createTripBody({ driver_user_id: DRIVER_A }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  it("19. 401: utente non autenticato, guard operativo mai raggiunto", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const fake = baseSeed();

    const res = await callPost(createTripBody({ driver_user_id: DRIVER_SUSPENDED }));

    expect(res.status).toBe(401);
    expect(fake.calls.membershipsSelectCount).toBe(0);
  });

  it("20. 403: ruolo non autorizzato, guard operativo mai raggiunto", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    const fake = baseSeed();

    const res = await callPost(createTripBody({ driver_user_id: DRIVER_SUSPENDED }));

    expect(res.status).toBe(403);
    expect(fake.calls.membershipsSelectCount).toBe(0);
  });

  it("21. risposta sanificata: nessun dettaglio DB/tenant B nella risposta 409/500", async () => {
    const fakeSuspended = baseSeed();
    authorizeAs(fakeSuspended);
    const resSuspended = await callPost(createTripBody({ driver_user_id: DRIVER_SUSPENDED }));
    const rawSuspended = JSON.stringify(await resSuspended.json());
    expect(rawSuspended).not.toMatch(new RegExp(DRIVER_SUSPENDED));

    const fakeDbError = baseSeed();
    fakeDbError.setError("memberships", RAW_DB_ERROR, 2);
    authorizeAs(fakeDbError);
    const resDbError = await callPost(createTripBody({ driver_user_id: DRIVER_A }));
    const rawDbError = JSON.stringify(await resDbError.json());
    expect(rawDbError).not.toMatch(/internal-db-host/);
    expect(rawDbError.toLowerCase()).not.toMatch(/sqlstate/);
  });
});

describe("FUNC-03 residuo — sensibilità (comportamento atteso col guard integro)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("22. sensibilità filtro suspended: driver sospeso deve essere bloccato quando il filtro è integro", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(createTripBody({ driver_user_id: DRIVER_SUSPENDED }));
    expect(res.status).toBe(409);
  });

  it("23. sensibilità filtro active: profilo inattivo deve essere bloccato quando il filtro è integro", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(createTripBody({ driver_user_id: DRIVER_A, driver_profile_id: PROFILE_INACTIVE }));
    expect(res.status).toBe(409);
  });

  it("24. sensibilità bypass intero guard: driver sospeso E profilo inattivo devono essere entrambi bloccati", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(createTripBody({ driver_user_id: DRIVER_SUSPENDED, driver_profile_id: PROFILE_SUSPENDED_INACTIVE }));
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toBe("DRIVER_NOT_ACTIVE");
  });
});
