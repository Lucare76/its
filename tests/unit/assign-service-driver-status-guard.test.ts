import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_X = "a1111111-1111-4111-8111-111111111111";
const DRIVER_ACTIVE = "d1111111-1111-4111-8111-111111111111";
const DRIVER_SUSPENDED = "d2222222-2222-4222-8222-222222222222";
const DRIVER_B = "d3333333-3333-4333-8333-333333333333";
const DRIVER_GHOST = "d9999999-9999-4999-8999-999999999999";
const NON_DRIVER_A = "d4444444-4444-4444-8444-444444444444";
const PROFILE_ACTIVE = "p1111111-1111-4111-8111-111111111111";
const PROFILE_INACTIVE = "p2222222-2222-4222-8222-222222222222";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

const RAW_DB_ERROR = { message: 'connection to server "internal-db-host.example" failed: SQLSTATE[08006]' };

/**
 * Fake Supabase in-memory, tenant-aware, dedicato ai test FUNC-03 (guard
 * operatività driver) in assign-service. Applica realmente eq/in/maybeSingle
 * sulle tabelle coinvolte, inclusi i campi reali memberships.suspended e
 * driver_profiles.active. Consente di forzare un errore separato sulla
 * SECONDA query memberships/driver_profiles (quella di FUNC-03), distinta
 * dalla prima (SEC-05), per testare i due path di errore indipendentemente.
 */
function createTenantAwareSupabase(
  seed: Partial<Record<
    "services" | "memberships" | "driver_profiles" | "assignments" | "trip_groups" | "daily_availability_confirmations" | "status_events",
    Row[]
  >> = {}
) {
  const tables: Record<string, Row[]> = {
    services: [...(seed.services ?? [])],
    memberships: [...(seed.memberships ?? [])],
    driver_profiles: [...(seed.driver_profiles ?? [])],
    assignments: [...(seed.assignments ?? [])],
    trip_groups: [...(seed.trip_groups ?? [])],
    daily_availability_confirmations: [...(seed.daily_availability_confirmations ?? [])],
    status_events: [...(seed.status_events ?? [])],
    // CONC-07: destinazione dello storico strutturato fire-and-forget scritto
    // dopo l'assegnazione riuscita — deve esistere perché l'insert non crashi.
    driver_assignment_history: [],
  };

  const tableErrors: Record<string, { message: string } | null> = {};
  // Contatore per-tabella: permette di forzare l'errore solo dalla Nma query
  // (1a = SEC-05 esistenza/ruolo, 2a = FUNC-03 stato operativo).
  const queryCountByTable: Record<string, number> = {};
  const errorOnNthQuery: Record<string, { n: number; err: { message: string } } | null> = {};

  const calls = {
    membershipsQueried: 0,
    driverProfilesQueried: 0,
    tripGroupsInserted: [] as Row[],
    tripGroupsUpdated: 0,
    assignmentsInserted: [] as Row[],
    assignmentsUpdated: 0,
    assignmentsDeleted: 0,
    servicesUpdated: 0,
    statusEventsUpserted: 0,
  };

  function augmentAssignmentRow(row: Row): Row {
    return { ...row, services: tables.services.find((s) => s.id === row.service_id) ?? null };
  }

  function makeSelectBuilder(table: string) {
    if (!(table in tables)) throw new Error(`[fake supabase] tabella non definita: ${table}`);
    let filtered = tables[table];
    if (table === "memberships") calls.membershipsQueried++;
    if (table === "driver_profiles") calls.driverProfilesQueried++;
    queryCountByTable[table] = (queryCountByTable[table] ?? 0) + 1;
    const thisQueryN = queryCountByTable[table];
    const augment = table === "assignments" ? augmentAssignmentRow : undefined;
    const builder = {
      eq(field: string, value: unknown) {
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
        filtered = filtered.filter((r) => (r[field] ?? null) !== value);
        return builder;
      },
      maybeSingle() {
        const forcedNth = errorOnNthQuery[table];
        if (forcedNth && forcedNth.n === thisQueryN) {
          return Promise.resolve({ data: null, error: forcedNth.err });
        }
        const err = tableErrors[table] ?? null;
        if (err) return Promise.resolve({ data: null, error: err });
        const row = filtered[0] ?? null;
        return Promise.resolve({ data: row ? (augment ? augment(row) : row) : null, error: null });
      },
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        const err = tableErrors[table] ?? null;
        if (err) return Promise.resolve({ data: null, error: err }).then(resolve, reject);
        const data = augment ? filtered.map(augment) : filtered;
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  function makeMutationBuilder(table: string, op: "delete" | "update", payload?: Row) {
    const rows = tables[table];
    let filtered = rows;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] === value);
        return builder;
      },
      then(resolve: (v: { data: null; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        if (op === "delete") {
          const toRemove = new Set(filtered);
          for (let i = rows.length - 1; i >= 0; i--) {
            if (toRemove.has(rows[i])) {
              if (table === "assignments") calls.assignmentsDeleted++;
              rows.splice(i, 1);
            }
          }
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        for (const row of filtered) Object.assign(row, payload);
        if (table === "assignments") calls.assignmentsUpdated += filtered.length;
        if (table === "trip_groups") calls.tripGroupsUpdated += filtered.length;
        if (table === "services") calls.servicesUpdated += filtered.length;
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      return {
        select() {
          return makeSelectBuilder(table);
        },
        delete() {
          return makeMutationBuilder(table, "delete");
        },
        update(payload: Row) {
          return makeMutationBuilder(table, "update", payload);
        },
        insert(row: Row) {
          if (table === "trip_groups") {
            const inserted = { id: `grp-${tables.trip_groups.length + 1}`, status: "active", ...row };
            tables.trip_groups.push(inserted);
            calls.tripGroupsInserted.push(inserted);
            return {
              select() {
                return { single: () => Promise.resolve({ data: inserted, error: null }) };
              },
            };
          }
          if (table === "assignments") {
            const key = `${row.service_id}:${row.tenant_id}`;
            const conflict = tables.assignments.some((a) => `${a.service_id}:${a.tenant_id}` === key);
            if (conflict) return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate" } });
            const inserted = { id: `asg-${tables.assignments.length + 1}`, ...row };
            tables.assignments.push(inserted);
            calls.assignmentsInserted.push(inserted);
            return Promise.resolve({ data: inserted, error: null });
          }
          tables[table].push(row);
          return Promise.resolve({ data: row, error: null });
        },
        upsert(row: Row) {
          if (table === "status_events") calls.statusEventsUpserted += 1;
          tables[table].push(row);
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };

  return {
    admin,
    tables,
    calls,
    setTableError(table: string, err: { message: string } | null) {
      tableErrors[table] = err;
    },
    setErrorOnNthQuery(table: string, n: number, err: { message: string }) {
      errorOnNthQuery[table] = { n, err };
    },
  };
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));
vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: mocks.auditLog,
}));

import { POST } from "@/app/api/ops/assign-service/route";

function serviceRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT_A,
    date: TEST_DATE,
    status: "new",
    is_draft: false,
    time: "10:00:00",
    pickup_hotel: null,
    direction: "departure",
    hotel_id: null,
    meeting_point: null,
    arrival_time: null,
    orario_barca: null,
    porto_bruno: null,
    barca_compagnia: null,
    booking_service_kind: null,
    service_type_code: null,
    vessel: null,
    ferry_details: null,
    ...overrides,
  };
}

function baseSeed(overrides: Parameters<typeof createTenantAwareSupabase>[0] = {}) {
  return createTenantAwareSupabase({
    services: [serviceRow(SERVICE_X)],
    daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
    memberships: [
      { tenant_id: TENANT_A, user_id: DRIVER_ACTIVE, role: "driver", suspended: false },
      { tenant_id: TENANT_A, user_id: DRIVER_SUSPENDED, role: "driver", suspended: true },
      { tenant_id: TENANT_B, user_id: DRIVER_B, role: "driver", suspended: false },
      { tenant_id: TENANT_A, user_id: NON_DRIVER_A, role: "operator", suspended: false },
    ],
    driver_profiles: [
      { id: PROFILE_ACTIVE, tenant_id: TENANT_A, user_id: null, active: true },
      { id: PROFILE_INACTIVE, tenant_id: TENANT_A, user_id: null, active: false },
    ],
    ...overrides,
  });
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/ops/assign-service", {
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

function assertZeroWrites(fake: ReturnType<typeof createTenantAwareSupabase>) {
  expect(fake.calls.tripGroupsInserted).toHaveLength(0);
  expect(fake.calls.assignmentsInserted).toHaveLength(0);
  expect(fake.calls.tripGroupsUpdated).toBe(0);
  expect(fake.calls.assignmentsUpdated).toBe(0);
  expect(fake.calls.servicesUpdated).toBe(0);
  expect(fake.calls.statusEventsUpserted).toBe(0);
}

describe("FUNC-03 — driver operational status guard in assign-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. driver operativo (suspended=false) same-tenant: successo", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_ACTIVE, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.assignmentsInserted).toHaveLength(1);
  });

  it("2. driver sospeso (suspended=true): 409 DRIVER_NOT_ACTIVE (sensibile alla rimozione del filtro stato)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_SUSPENDED, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      ok: false,
      error: "DRIVER_NOT_ACTIVE",
      message: "L'autista non è attualmente disponibile per nuove assegnazioni.",
    });
    assertZeroWrites(fake);
  });

  it("3. driver_profile inattivo (active=false): 409 DRIVER_NOT_ACTIVE, zero scritture", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_profile_id: PROFILE_INACTIVE, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("DRIVER_NOT_ACTIVE");
    assertZeroWrites(fake);
  });

  it("3b. driver_profile attivo (active=true): successo", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_profile_id: PROFILE_ACTIVE, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("4. driver cross-tenant: 404 invariato, non 409 (ownership blocca prima dell'operatività)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_B, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
  });

  it("5. driver inesistente: 404 invariato", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_GHOST, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
  });

  it("6. ruolo non-driver: 404 invariato", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: NON_DRIVER_A, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
  });

  it("7. errore nella query di stato (2a query memberships): 500 DRIVER_STATUS_CHECK_FAILED, fail-closed, zero scritture, audit log", async () => {
    const fake = baseSeed();
    fake.setErrorOnNthQuery("memberships", 2, RAW_DB_ERROR);
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_ACTIVE, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({
      ok: false,
      error: "DRIVER_STATUS_CHECK_FAILED",
      message: "Errore durante la verifica dello stato dell'autista.",
    });
    assertZeroWrites(fake);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "assign_service_driver_status_check_failed", level: "error" })
    );
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/internal-db-host/);
    expect(raw.toLowerCase()).not.toMatch(/sqlstate/);
  });

  it("7b. errore nella query di stato driver_profiles: 500 DRIVER_STATUS_CHECK_FAILED", async () => {
    const fake = baseSeed();
    fake.setErrorOnNthQuery("driver_profiles", 2, RAW_DB_ERROR);
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_profile_id: PROFILE_ACTIVE, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("DRIVER_STATUS_CHECK_FAILED");
  });

  it("7c. SEC-05 invariato: errore sulla 1a query memberships resta DRIVER_VERIFICATION_FAILED", async () => {
    const fake = baseSeed();
    fake.setErrorOnNthQuery("memberships", 1, RAW_DB_ERROR);
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_ACTIVE, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("DRIVER_VERIFICATION_FAILED");
  });

  it("8. nessuna scrittura su driver sospeso (dettaglio: zero trip_group, zero assignment)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_SUSPENDED, vehicle_label: "Bus 1" });

    expect(fake.calls.tripGroupsInserted).toHaveLength(0);
    expect(fake.calls.assignmentsInserted).toHaveLength(0);
  });

  it("9. ramo update con driver operativo invariato: driver/mezzo aggiornati", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: "grp-existing", tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: "Bus old" }],
      assignments: [{ id: "asg-existing", tenant_id: TENANT_A, service_id: SERVICE_X, group_id: "grp-existing", driver_user_id: DRIVER_ACTIVE, vehicle_label: "Bus old" }],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_ACTIVE, vehicle_label: "Bus new" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.tripGroupsUpdated).toBe(1);
    expect(fake.calls.assignmentsUpdated).toBe(1);
  });

  it("10. action remove invariata: guard operatività non invocato", async () => {
    const fake = baseSeed({
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_X, group_id: null, driver_user_id: DRIVER_SUSPENDED, vehicle_label: "Bus 1" }],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, action: "remove" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.assignmentsDeleted).toBe(1);
  });

  it("11. FUNC-02 invariato: servizio non assegnabile blocca prima del guard operatività driver", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X, { status: "cancelled" })] });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_SUSPENDED, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("SERVICE_NOT_ASSIGNABLE");
    // Il guard driver (SEC-05/FUNC-03) non deve nemmeno essere raggiunto.
    expect(fake.calls.membershipsQueried).toBe(0);
  });

  it("12. SEC-05 invariato: driver esistente e operativo ma cross-tenant resta 404, non 409", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_B, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("DRIVER_NOT_FOUND");
  });

  it("13. CONC-01 invariato: comportamento normale su driver operativo non alterato dal nuovo guard", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_ACTIVE, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("14. CONC-03 invariato: overlap mezzo su driver operativo continua a produrre 409 VEHICLE_OVERLAP", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_X, { time: "10:00:00" }), serviceRow("other-service", { time: "10:00:00" })],
      trip_groups: [{ id: "grp-other", tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: "Bus 1" }],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: "other-service", group_id: "grp-other", vehicle_label: "Bus 1" }],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_ACTIVE, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("VEHICLE_OVERLAP");
  });

  it("15. utente non autenticato: 401, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const fake = baseSeed();

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_SUSPENDED, vehicle_label: "Bus 1" });

    expect(res.status).toBe(401);
    assertZeroWrites(fake);
  });

  it("16. ruolo non autorizzato: 403, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    const fake = baseSeed();

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_SUSPENDED, vehicle_label: "Bus 1" });

    expect(res.status).toBe(403);
    assertZeroWrites(fake);
  });

  it("17. privacy: nessuna risposta contiene dettagli DB o tenant B", async () => {
    const fakeSuspended = baseSeed();
    authorizeAs(fakeSuspended);
    const resSuspended = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_SUSPENDED, vehicle_label: "Bus 1" });
    const rawSuspended = JSON.stringify(await resSuspended.json());
    expect(rawSuspended.toLowerCase()).not.toMatch(/sqlstate|stack|supabase|postgres/);

    const fakeCrossTenant = baseSeed();
    authorizeAs(fakeCrossTenant);
    const resCrossTenant = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_B, vehicle_label: "Bus 1" });
    const rawCrossTenant = JSON.stringify(await resCrossTenant.json());
    expect(rawCrossTenant).not.toMatch(new RegExp(TENANT_B));

    const fakeDbError = baseSeed();
    fakeDbError.setErrorOnNthQuery("memberships", 2, RAW_DB_ERROR);
    authorizeAs(fakeDbError);
    const resDbError = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_ACTIVE, vehicle_label: "Bus 1" });
    const rawDbError = JSON.stringify(await resDbError.json());
    expect(rawDbError).not.toMatch(/internal-db-host/);
  });
});
