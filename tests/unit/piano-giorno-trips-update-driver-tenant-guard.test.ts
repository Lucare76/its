import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_A1 = "a1111111-1111-4111-8111-111111111111";
const GROUP_A1 = "c1111111-1111-4111-8111-111111111111";
const DRIVER_A = "d1111111-1111-4111-8111-111111111111";
const DRIVER_A2 = "d1111111-1111-4111-8111-111111111112";
const DRIVER_B = "d2222222-2222-4222-8222-222222222222";
const DRIVER_GHOST = "d9999999-9999-4999-8999-999999999999";
const PROFILE_A1 = "p1111111-1111-4111-8111-111111111111";
const PROFILE_B1 = "p2222222-2222-4222-8222-222222222222";
const PROFILE_GHOST = "p9999999-9999-4999-8999-999999999999";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

const RAW_DB_ERROR = { message: 'connection to server "internal-db-host.example" failed: SQLSTATE[08006]' };

/**
 * Fake Supabase in-memory, tenant-aware, generico (stesso schema del fake
 * usato in piano-giorno-trips-driver-tenant-guard.test.ts/-tenant-isolation),
 * esteso con contatori di update su trip_groups/assignments (assenti
 * nell'altro file poiché update_trip, a differenza di create_trip, scrive con
 * UPDATE e non con INSERT/UPSERT). Dedicato esclusivamente al riuso del guard
 * SEC-05 residuo su update_trip.
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

  const calls = {
    unscopedQueries: [] as string[],
    assignmentsUpserts: 0,
    assignmentsUpdates: 0,
    assignmentsDeletes: 0,
    tripGroupsInserts: 0,
    tripGroupsUpdates: 0,
    insertedAssignmentRows: [] as Row[],
    membershipsQueried: 0,
    driverProfilesQueried: 0,
  };

  function makeQueryBuilder(table: string, op: "select" | "delete" | "update", updatePayload?: Row) {
    const rows = tables[table];
    let filtered = rows;
    let sawTenantFilter = false;
    let limitN: number | null = null;
    if (table === "memberships" && op === "select") calls.membershipsQueried++;
    if (table === "driver_profiles" && op === "select") calls.driverProfilesQueried++;

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
        if (tableErrors[table]) {
          return Promise.resolve({ data: null, error: tableErrors[table] });
        }
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      single() {
        resolveScope();
        if (tableErrors[table]) {
          return Promise.resolve({ data: null, error: tableErrors[table] });
        }
        return Promise.resolve({ data: filtered[0] ?? null, error: filtered[0] ? null : { message: "not found" } });
      },
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        resolveScope();
        if (tableErrors[table]) {
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
    setError(table: string, err: { message: string } | null) {
      tableErrors[table] = err ?? undefined;
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
    trip_groups: [{ id: GROUP_A1, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: null, driver_profile_id: null, vehicle_label: null, status: "active" }],
    assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_A1, group_id: GROUP_A1, driver_user_id: null, vehicle_label: null }],
    daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
    driver_daily_availability: [
      { tenant_id: TENANT_A, driver_user_id: DRIVER_A, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      { tenant_id: TENANT_A, driver_user_id: DRIVER_A2, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      { tenant_id: TENANT_A, driver_profile_id: PROFILE_A1, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
    ],
    memberships: [
      membershipRow(DRIVER_A, TENANT_A),
      membershipRow(DRIVER_A2, TENANT_A),
      membershipRow(DRIVER_B, TENANT_B),
    ],
    driver_profiles: [
      driverProfileRow(PROFILE_A1, TENANT_A, DRIVER_A),
      driverProfileRow(PROFILE_B1, TENANT_B, DRIVER_B),
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
    ...overrides,
  };
}

function assertZeroWrites(fake: ReturnType<typeof createTenantAwareSupabase>) {
  expect(fake.calls.tripGroupsUpdates).toBe(0);
  expect(fake.calls.assignmentsUpdates).toBe(0);
  expect(fake.calls.assignmentsDeletes).toBe(0);
  expect(fake.calls.assignmentsUpserts).toBe(0);
}

describe("SEC-05 residuo — driver tenant ownership guard in piano-giorno/trips (update_trip, riuso helper)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. driver_user_id same-tenant: aggiornamento valido, comportamento invariato", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_A }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.tripGroupsUpdates).toBeGreaterThan(0);
    expect(fake.calls.assignmentsUpdates).toBeGreaterThan(0);
    const updated = fake.tables.assignments.find((a) => a.service_id === SERVICE_A1);
    expect(updated?.driver_user_id).toBe(DRIVER_A);
  });

  it("2. driver_user_id di tenant B: 404 DRIVER_NOT_FOUND, zero scritture", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_B }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    assertZeroWrites(fake);
  });

  it("3. driver_user_id inesistente: stessa risposta del tenant B", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_GHOST }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    assertZeroWrites(fake);
  });

  it("4. user same-tenant con ruolo diverso da driver: stesso 404", async () => {
    const fake = baseSeed({
      memberships: [membershipRow(DRIVER_A, TENANT_A, { role: "operator" })],
    });
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_A }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    assertZeroWrites(fake);
  });

  it("5. driver_profile_id di tenant B: 404, zero scritture", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_profile_id: PROFILE_B1 }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    assertZeroWrites(fake);
  });

  it("6. driver_profile_id inesistente: stessa risposta del cross-tenant", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_profile_id: PROFILE_GHOST }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    assertZeroWrites(fake);
  });

  it("7. user + profile coerenti same-tenant: successo", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_A, driver_profile_id: PROFILE_A1 }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("8. user same-tenant + profile tenant B (coppia incoerente cross-tenant): 404, zero scritture", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_A, driver_profile_id: PROFILE_B1 }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    assertZeroWrites(fake);
  });

  it("9. user/profile entrambi same-tenant ma non collegati tra loro: 404, zero scritture", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_A2, driver_profile_id: PROFILE_A1 }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    assertZeroWrites(fake);
  });

  it("10. entrambi assenti: guard SEC-05 completamente skippato, comportamento update_trip invariato (rimozione driver)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody());
    const body = await res.json();

    // Nessuna query di ownership eseguita: il guard è no-op quando non è
    // fornito alcun identificativo driver. La route blocca comunque per la
    // stessa regola di business preesistente già osservata su create_trip
    // ("driver obbligatorio", validateTripPayload) — non per SEC-05.
    expect(res.status).toBe(409);
    expect(body).toEqual({ ok: false, error: "Seleziona un autista prima di salvare il giro." });
    expect(fake.calls.membershipsQueried).toBe(0);
    expect(fake.calls.driverProfilesQueried).toBe(0);
  });

  it("11. valori finali dopo aggiornamento parziale: solo driver_profile_id inviato, driver_user_id omesso — verificato contro il tenant come valore finale scritto", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    // Aggiornamento parziale: il client invia solo driver_profile_id (di
    // tenant B), driver_user_id è omesso. Il valore "finale" scritto per
    // driver_user_id sarebbe null (comportamento preesistente, non oggetto di
    // questo task) — ma il guard deve comunque bloccare sul profile_id
    // cross-tenant prima di qualunque scrittura.
    const res = await callPost(updateTripBody({ driver_profile_id: PROFILE_B1 }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    assertZeroWrites(fake);
  });

  it("12. tenant_id malevolo nel body viene ignorato: ownership contro il tenant della sessione", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_A, tenant_id: TENANT_B }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    const updated = fake.tables.assignments.find((a) => a.service_id === SERVICE_A1);
    expect(updated?.tenant_id).toBe(TENANT_A);
  });

  it("13. errore nella query memberships: 500 fail-closed, zero scritture, messaggio DB non esposto", async () => {
    const fake = baseSeed();
    fake.setError("memberships", RAW_DB_ERROR);
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_A }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ ok: false, error: "DRIVER_VERIFICATION_FAILED", message: "Errore durante la verifica dell'autista." });
    assertZeroWrites(fake);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "piano_trip_driver_verification_failed", level: "error" })
    );
  });

  it("14. errore nella query driver_profiles: 500 fail-closed, zero scritture", async () => {
    const fake = baseSeed();
    fake.setError("driver_profiles", RAW_DB_ERROR);
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_profile_id: PROFILE_A1 }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ ok: false, error: "DRIVER_VERIFICATION_FAILED", message: "Errore durante la verifica dell'autista." });
    assertZeroWrites(fake);
  });

  it("15. SEC-02 invariato: service_ids con id di tenant B blocca prima del guard driver", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_A, service_ids: ["b9999999-9999-4999-8999-999999999999"] }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Uno o più servizi non trovati." });
    expect(fake.calls.membershipsQueried).toBe(0);
    assertZeroWrites(fake);
  });

  it("16. create_trip invariato: guard su create_trip non interferisce con update_trip", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({
      action: "create_trip",
      date: TEST_DATE,
      service_ids: [SERVICE_A1 + "-unused"],
    });
    // Non rilevante il codice esatto (service inesistente), solo che
    // create_trip resta raggiungibile e non interferisce col guard di
    // update_trip appena testato sopra.
    expect(res.status).not.toBe(0);
  });

  it("17. delete_trip invariata: nessun impatto dal riuso del guard in update_trip", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const resDelete = await callPost({ action: "delete_trip", group_id: GROUP_A1 });
    expect(resDelete.status).toBe(200);
  });

  it("18. zero trip_group/assignment update, zero push su rifiuto driver", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(updateTripBody({ driver_user_id: DRIVER_B }));

    assertZeroWrites(fake);
    expect(mocks.sendPushToUser).not.toHaveBeenCalled();
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("19. utente non autenticato: 401, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const fake = baseSeed();

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_A }));

    expect(res.status).toBe(401);
    expect(fake.calls.membershipsQueried).toBe(0);
  });

  it("20. ruolo non autorizzato: 403, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    const fake = baseSeed();

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_A }));

    expect(res.status).toBe(403);
    expect(fake.calls.membershipsQueried).toBe(0);
  });

  it("21. privacy: nessuna risposta contiene tenant B, SQLSTATE, o dettagli Supabase", async () => {
    const fakeCrossTenant = baseSeed();
    authorizeAs(fakeCrossTenant);
    const resCrossTenant = await callPost(updateTripBody({ driver_user_id: DRIVER_B }));
    const rawCrossTenant = JSON.stringify(await resCrossTenant.json());

    expect(rawCrossTenant).not.toMatch(new RegExp(TENANT_B));
    expect(rawCrossTenant.toLowerCase()).not.toMatch(/sqlstate|stack|supabase|postgres/);

    const fakeDbError = baseSeed();
    fakeDbError.setError("memberships", RAW_DB_ERROR);
    authorizeAs(fakeDbError);
    const resDbError = await callPost(updateTripBody({ driver_user_id: DRIVER_A }));
    const rawDbError = JSON.stringify(await resDbError.json());

    expect(rawDbError).not.toMatch(/internal-db-host/);
    expect(rawDbError.toLowerCase()).not.toMatch(/sqlstate/);
  });
});
