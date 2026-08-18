import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_A1 = "a1111111-1111-4111-8111-111111111111";
const SERVICE_A2 = "a1111111-1111-4111-8111-111111111112";
const DRIVER_A = "d1111111-1111-4111-8111-111111111111";
const DRIVER_B = "d2222222-2222-4222-8222-222222222222";
const PROFILE_A1 = "p1111111-1111-4111-8111-111111111111";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

const RAW_DB_ERROR = { message: 'connection to server "internal-db-host.example" failed: SQLSTATE[08006]' };

/**
 * Fake Supabase in-memory, tenant-aware, generico — stesso schema riusato dai
 * file piano-giorno-trips-tenant-isolation.test.ts e
 * piano-giorno-trips-driver-tenant-guard.test.ts. Applica realmente
 * eq/neq/in/not/limit/order/select/insert/upsert/update/delete/maybeSingle/
 * single per qualunque tabella seedata. Dedicato ai test del guard FUNC-02
 * residuo (stato operativo dei servizi) su create_trip.
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
    servicesStatusQueried: 0,
    membershipsQueried: 0,
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
    // La 2a query select su "services" è quella del guard FUNC-02 (la 1a è
    // sempre SEC-02, che seleziona solo "id"); usato per contare/errore mirato.
    if (table === "services" && op === "select" && thisCallIndex >= 2) calls.servicesStatusQueried++;
    if (table === "memberships" && op === "select") calls.membershipsQueried++;

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
  return { user_id: userId, tenant_id: tenantId, role: "driver", ...overrides };
}

function driverProfileRow(id: string, tenantId: string, userId: string | null, overrides: Row = {}): Row {
  return { id, tenant_id: tenantId, user_id: userId, ...overrides };
}

function baseSeed(overrides: Parameters<typeof createTenantAwareSupabase>[0] = {}) {
  return createTenantAwareSupabase({
    services: [serviceRow(TENANT_A, SERVICE_A1)],
    daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
    driver_daily_availability: [
      { tenant_id: TENANT_A, driver_user_id: DRIVER_A, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      { tenant_id: TENANT_A, driver_profile_id: PROFILE_A1, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
    ],
    memberships: [
      membershipRow(DRIVER_A, TENANT_A),
      membershipRow(DRIVER_B, TENANT_B),
    ],
    driver_profiles: [
      driverProfileRow(PROFILE_A1, TENANT_A, DRIVER_A),
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
    driver_user_id: DRIVER_A,
    ...overrides,
  };
}

function assertZeroWrites(fake: ReturnType<typeof createTenantAwareSupabase>) {
  expect(fake.calls.tripGroupsInserts).toBe(0);
  expect(fake.calls.assignmentsUpserts).toBe(0);
}

const OPERATIONAL_STATUSES = ["new", "assigned", "partito", "caricato", "scaricato", "arrivato", "problema"];
const BLOCKED_STATUSES = ["completato", "cancelled", "needs_review", "pending_cancellation"];

describe("FUNC-02 residuo — guard stato operativo servizi in piano-giorno/trips (create_trip)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const status of OPERATIONAL_STATUSES) {
    it(`stato "${status}": operativo, create_trip procede normalmente`, async () => {
      const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status })] });
      authorizeAs(fake);

      const res = await callPost(createTripBody());
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(fake.calls.tripGroupsInserts).toBe(1);
    });
  }

  for (const status of BLOCKED_STATUSES) {
    it(`stato "${status}": bloccato, 409 SERVICE_NOT_ASSIGNABLE, zero scritture`, async () => {
      const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status })] });
      authorizeAs(fake);

      const res = await callPost(createTripBody());
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body).toEqual({
        ok: false,
        error: "SERVICE_NOT_ASSIGNABLE",
        message: "Uno o più servizi non possono essere assegnati nello stato attuale.",
      });
      assertZeroWrites(fake);
    });
  }

  it("is_draft=true: bloccato indipendentemente dallo status, 409, zero scritture", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "new", is_draft: true })] });
    authorizeAs(fake);

    const res = await callPost(createTripBody());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      ok: false,
      error: "SERVICE_NOT_ASSIGNABLE",
      message: "Uno o più servizi non possono essere assegnati nello stato attuale.",
    });
    assertZeroWrites(fake);
  });

  it("array misto: un solo servizio non operativo blocca l'intero create_trip, zero scritture", async () => {
    const fake = baseSeed({
      services: [
        serviceRow(TENANT_A, SERVICE_A1, { status: "new" }),
        serviceRow(TENANT_A, SERVICE_A2, { status: "cancelled" }),
      ],
    });
    authorizeAs(fake);

    const res = await callPost(createTripBody({ service_ids: [SERVICE_A1, SERVICE_A2] }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("SERVICE_NOT_ASSIGNABLE");
    assertZeroWrites(fake);
  });

  it("cross tenant continua a bloccare prima (SEC-02): guard di stato non viene mai raggiunto", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_B, SERVICE_A1, { status: "cancelled" })] });
    authorizeAs(fake);

    const res = await callPost(createTripBody());
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Uno o più servizi non trovati." });
    // SEC-02 blocca alla prima query su "services": il guard di stato (2a query) non viene mai raggiunto.
    expect(fake.calls.servicesStatusQueried).toBe(0);
  });

  it("driver guard (SEC-05) continua a bloccare prima del guard di stato", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "cancelled" })] });
    authorizeAs(fake);

    const res = await callPost(createTripBody({ driver_user_id: DRIVER_B }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    // Guard driver interviene prima: la query di stato servizi non è ancora stata eseguita.
    expect(fake.calls.servicesStatusQueried).toBe(0);
  });

  it("errore DB nella verifica stato: 500 fail-closed, zero scritture, nessun dettaglio DB esposto", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "new" })] });
    // fromCallIndex=2: la 1a query "services" è SEC-02 (deve continuare a
    // funzionare), la 2a è il guard di stato oggetto di questo test.
    fake.setError("services", RAW_DB_ERROR, 2);
    authorizeAs(fake);

    const res = await callPost(createTripBody());
    const body = await res.json();
    const raw = JSON.stringify(body);

    expect(res.status).toBe(500);
    expect(body).toEqual({ ok: false, error: "SERVICE_STATUS_CHECK_FAILED", message: "Errore durante la verifica dello stato dei servizi." });
    assertZeroWrites(fake);
    expect(raw).not.toMatch(/internal-db-host/);
    expect(raw.toLowerCase()).not.toMatch(/sqlstate/);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "piano_trip_service_status_check_failed", level: "error" })
    );
  });

  it("zero scritture su rifiuto: nessun trip_group/assignment/push/history", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "cancelled" })] });
    authorizeAs(fake);

    await callPost(createTripBody());

    expect(fake.calls.tripGroupsInserts).toBe(0);
    expect(fake.calls.assignmentsUpserts).toBe(0);
    expect(mocks.sendPushToUser).not.toHaveBeenCalled();
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("create_trip invariato su servizio operativo: assignment con driver corretto", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "new" })] });
    authorizeAs(fake);

    const res = await callPost(createTripBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.insertedAssignmentRows[0].driver_user_id).toBe(DRIVER_A);
  });

  it("warning timeline invariato: array warnings presente su successo", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "new" })] });
    authorizeAs(fake);

    const res = await callPost(createTripBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  it("401: utente non autenticato, guard di stato mai raggiunto", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "cancelled" })] });

    const res = await callPost(createTripBody());

    expect(res.status).toBe(401);
    expect(fake.calls.servicesStatusQueried).toBe(0);
  });

  it("403: ruolo non autorizzato, guard di stato mai raggiunto", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "cancelled" })] });

    const res = await callPost(createTripBody());

    expect(res.status).toBe(403);
    expect(fake.calls.servicesStatusQueried).toBe(0);
  });

  it("sanitizzazione: risposta 409 non contiene id/stato del servizio bloccato", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "cancelled" })] });
    authorizeAs(fake);

    const res = await callPost(createTripBody());
    const raw = JSON.stringify(await res.json());

    expect(raw).not.toMatch(new RegExp(SERVICE_A1));
    expect(raw).not.toMatch(/cancelled/);
  });
});
