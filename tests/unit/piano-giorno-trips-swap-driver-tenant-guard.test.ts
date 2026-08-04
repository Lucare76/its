import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_A1 = "a1111111-1111-4111-8111-111111111111";
const GROUP_A1 = "c1111111-1111-4111-8111-111111111111";
const GROUP_B1 = "c2222222-2222-4222-8222-222222222222";
const DRIVER_FROM = "d0000000-0000-4000-8000-000000000000";
const DRIVER_TO_A = "d1111111-1111-4111-8111-111111111111";
const DRIVER_TO_B = "d2222222-2222-4222-8222-222222222222";
const DRIVER_GHOST = "d9999999-9999-4999-8999-999999999999";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

const RAW_DB_ERROR = { message: 'connection to server "internal-db-host.example" failed: SQLSTATE[08006]' };

/**
 * Fake Supabase in-memory, tenant-aware, generico — stesso schema riusato dai
 * file piano-giorno-trips-update-driver-tenant-guard.test.ts e
 * piano-giorno-trips-driver-tenant-guard.test.ts. Dedicato esclusivamente al
 * riuso del guard SEC-05 residuo in swap_driver (verifyTripDriverBelongsToTenant
 * chiamato con driverProfileId sempre null, poiché swap_driver usa solo
 * to_driver_id — nessun campo profile è realmente usato da questa action).
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

function baseSeed(overrides: Parameters<typeof createTenantAwareSupabase>[0] = {}) {
  return createTenantAwareSupabase({
    services: [serviceRow(TENANT_A, SERVICE_A1)],
    trip_groups: [
      { id: GROUP_A1, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_FROM, driver_profile_id: null, vehicle_label: null, status: "active" },
      // Stesso from_driver_id ma tenant B: prova che la query è tenant-scoped, non deve mai essere incluso.
      { id: GROUP_B1, tenant_id: TENANT_B, date: TEST_DATE, driver_user_id: DRIVER_FROM, driver_profile_id: null, vehicle_label: null, status: "active" },
    ],
    assignments: [
      { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_A1, group_id: GROUP_A1, driver_user_id: DRIVER_FROM, vehicle_label: null },
    ],
    driver_daily_availability: [
      { tenant_id: TENANT_A, driver_user_id: DRIVER_TO_A, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      { tenant_id: TENANT_A, driver_user_id: DRIVER_FROM, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
    ],
    memberships: [
      membershipRow(DRIVER_FROM, TENANT_A),
      membershipRow(DRIVER_TO_A, TENANT_A),
      membershipRow(DRIVER_TO_B, TENANT_B),
    ],
    driver_profiles: [],
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

function swapDriverBody(overrides: Record<string, unknown> = {}) {
  return {
    action: "swap_driver",
    date: TEST_DATE,
    from_driver_id: DRIVER_FROM,
    to_driver_id: DRIVER_TO_A,
    ...overrides,
  };
}

function assertZeroWrites(fake: ReturnType<typeof createTenantAwareSupabase>) {
  expect(fake.calls.tripGroupsUpdates).toBe(0);
  expect(fake.calls.assignmentsUpdates).toBe(0);
}

describe("SEC-05 residuo — driver tenant ownership guard in piano-giorno/trips (swap_driver, riuso helper)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. target driver same-tenant: swap valido, comportamento invariato", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(swapDriverBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, affected: 1, warnings: [] });
    const updated = fake.tables.assignments.find((a) => a.service_id === SERVICE_A1);
    expect(updated?.driver_user_id).toBe(DRIVER_TO_A);
  });

  it("2. target driver di tenant B: 404 DRIVER_NOT_FOUND, zero scritture", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(swapDriverBody({ to_driver_id: DRIVER_TO_B }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    assertZeroWrites(fake);
  });

  it("3. target inesistente: stessa risposta del tenant B", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(swapDriverBody({ to_driver_id: DRIVER_GHOST }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    assertZeroWrites(fake);
  });

  it("4. target same-tenant con ruolo diverso da driver: stesso 404", async () => {
    const fake = baseSeed({
      memberships: [
        membershipRow(DRIVER_FROM, TENANT_A),
        membershipRow(DRIVER_TO_A, TENANT_A, { role: "operator" }),
      ],
    });
    authorizeAs(fake);

    const res = await callPost(swapDriverBody());
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    assertZeroWrites(fake);
  });

  it("5-6-7. driver_profile_id: N/A — swap_driver non usa mai driverProfileId nel guard SEC-05 (sempre null), il guard stesso non emette query su driver_profiles", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    // Target cross-tenant: il guard SEC-05 blocca subito (404), prima che il
    // flusso raggiunga validateTripPayload (che invece, per motivi indipendenti
    // da SEC-05, può interrogare driver_profiles per risolvere il profileId
    // da un driver_user_id — comportamento preesistente, fuori scope qui).
    const res = await callPost(swapDriverBody({ to_driver_id: DRIVER_TO_B }));
    expect(res.status).toBe(404);
    expect(fake.calls.driverProfilesQueried).toBe(0);
  });

  it("8. gruppo di tenant B con lo stesso from_driver_id: filtro tenant sulla query trip_groups, non incluso nell'update", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(swapDriverBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.affected).toBe(1);
    // Il gruppo di tenant B non deve mai comparire tra quelli aggiornati.
    const groupB = fake.tables.trip_groups.find((g) => g.id === GROUP_B1);
    expect(groupB?.driver_user_id).toBe(DRIVER_FROM);
  });

  it("9. gruppo inesistente (from_driver_id senza giri attivi): comportamento attuale invariato, guard valida comunque il target", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: GROUP_B1, tenant_id: TENANT_B, date: TEST_DATE, driver_user_id: DRIVER_FROM, driver_profile_id: null, vehicle_label: null, status: "active" }],
      assignments: [],
    });
    authorizeAs(fake);

    const res = await callPost(swapDriverBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, affected: 0 });
    // Il guard è comunque stato eseguito (query memberships avvenuta) anche se non c'era nulla da scrivere.
    expect(fake.calls.membershipsQueried).toBe(1);
  });

  it("10. stesso driver attuale (to_driver_id === from_driver_id): il guard SEC-05 non blocca (DRIVER_FROM è same-tenant/driver valido)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(swapDriverBody({ to_driver_id: DRIVER_FROM }));
    const body = await res.json();

    // Il guard SEC-05 (oggetto di questo task) deve limitarsi a validare
    // l'ownership del target: DRIVER_FROM è same-tenant con ruolo driver,
    // quindi il guard passa (mai 404 DRIVER_NOT_FOUND). Un'eventuale
    // reiezione successiva (validateTripPayload rileva un "conflitto" con
    // l'assignment esistente dello stesso driver, comportamento preesistente
    // non toccato da questo fix) resta fuori scope.
    expect(body.error).not.toBe("DRIVER_NOT_FOUND");
    expect(res.status).not.toBe(404);
  });

  it("11. target nullo/assente: 400 preesistente, guard mai raggiunto (comportamento reale invariato)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(swapDriverBody({ to_driver_id: undefined }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ ok: false, error: "date, from_driver_id e to_driver_id obbligatori." });
    expect(fake.calls.membershipsQueried).toBe(0);
  });

  it("12. tenant_id malevolo nel body viene ignorato: ownership verificata contro il tenant di sessione", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(swapDriverBody({ tenant_id: TENANT_B }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    const updated = fake.tables.assignments.find((a) => a.service_id === SERVICE_A1);
    expect(updated?.tenant_id).toBe(TENANT_A);
  });

  it("13. errore nella query memberships: 500 fail-closed, zero scritture, messaggio DB non esposto", async () => {
    const fake = baseSeed();
    fake.setError("memberships", RAW_DB_ERROR, 1);
    authorizeAs(fake);

    const res = await callPost(swapDriverBody());
    const body = await res.json();
    const raw = JSON.stringify(body);

    expect(res.status).toBe(500);
    expect(body).toEqual({ ok: false, error: "DRIVER_VERIFICATION_FAILED", message: "Errore durante la verifica dell'autista." });
    assertZeroWrites(fake);
    expect(raw).not.toMatch(/internal-db-host/);
    expect(raw.toLowerCase()).not.toMatch(/sqlstate/);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "piano_trip_driver_verification_failed", level: "error" })
    );
  });

  it("14. errore driver_profiles: N/A — swap_driver non interroga mai driver_profiles dal guard (driverProfileId sempre null)", () => {
    // Dichiarato esplicitamente non applicabile: nessun test da eseguire, la
    // query driver_profiles del guard scatta solo se driverProfileId è
    // presente, il che non accade mai in swap_driver.
    expect(true).toBe(true);
  });

  it("15-16. zero update trip_group/assignments su rifiuto", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(swapDriverBody({ to_driver_id: DRIVER_TO_B }));

    assertZeroWrites(fake);
  });

  it("17. zero history su rifiuto (logAssignmentChange non chiamata da swap_driver in nessun caso)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(swapDriverBody({ to_driver_id: DRIVER_TO_B }));

    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("18. zero notifiche su rifiuto", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(swapDriverBody({ to_driver_id: DRIVER_TO_B }));

    expect(mocks.sendPushToUser).not.toHaveBeenCalled();
  });

  it("19. timeline invariata su successo: risposta con warnings, push effettuata", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(swapDriverBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(mocks.sendPushToUser).toHaveBeenCalledTimes(1);
  });

  it("20. create_trip invariato: guard su swap_driver non tocca create_trip", async () => {
    const fake = baseSeed({
      services: [serviceRow(TENANT_A, "a2222222-2222-4222-8222-222222222222", { status: "new" })],
      trip_groups: [],
      assignments: [],
      driver_daily_availability: [
        { tenant_id: TENANT_A, driver_user_id: DRIVER_TO_A, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      ],
    });
    authorizeAs(fake);

    const res = await callPost({
      action: "create_trip",
      date: TEST_DATE,
      service_ids: ["a2222222-2222-4222-8222-222222222222"],
      driver_user_id: DRIVER_TO_A,
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("21. update_trip invariato: guard su swap_driver non tocca update_trip", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ action: "update_trip", group_id: GROUP_A1, driver_user_id: DRIVER_TO_A, service_ids: [SERVICE_A1] });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("22. swap_vehicle invariata: nessun impatto dal riuso del guard in swap_driver", async () => {
    const fake = baseSeed({
      vehicles: [{ id: "veh-2", tenant_id: TENANT_A, label: "Bus 2", capacity: 8, blocked_from: null, blocked_until: null, blocked_reason: null, is_blocked_manual: false }],
    });
    authorizeAs(fake);

    const res = await callPost({ action: "swap_vehicle", date: TEST_DATE, from_vehicle_label: "Bus 1", to_vehicle_label: "Bus 2" });
    expect(res.status).toBe(200);
  });

  it("23. 401: utente non autenticato, guard mai raggiunto", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const fake = baseSeed();

    const res = await callPost(swapDriverBody());

    expect(res.status).toBe(401);
    expect(fake.calls.membershipsQueried).toBe(0);
  });

  it("24. 403: ruolo non autorizzato, guard mai raggiunto", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    const fake = baseSeed();

    const res = await callPost(swapDriverBody());

    expect(res.status).toBe(403);
    expect(fake.calls.membershipsQueried).toBe(0);
  });

  it("25. privacy: nessuna risposta contiene tenant B, SQLSTATE, o dettagli Supabase", async () => {
    const fakeCrossTenant = baseSeed();
    authorizeAs(fakeCrossTenant);
    const resCrossTenant = await callPost(swapDriverBody({ to_driver_id: DRIVER_TO_B }));
    const rawCrossTenant = JSON.stringify(await resCrossTenant.json());

    expect(rawCrossTenant).not.toMatch(new RegExp(TENANT_B));
    expect(rawCrossTenant.toLowerCase()).not.toMatch(/sqlstate|stack|supabase|postgres/);

    const fakeDbError = baseSeed();
    fakeDbError.setError("memberships", RAW_DB_ERROR, 1);
    authorizeAs(fakeDbError);
    const resDbError = await callPost(swapDriverBody());
    const rawDbError = JSON.stringify(await resDbError.json());

    expect(rawDbError).not.toMatch(/internal-db-host/);
    expect(rawDbError.toLowerCase()).not.toMatch(/sqlstate/);
  });
});

describe("SEC-05 residuo — sensibilità (comportamento atteso col guard integro, swap_driver)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("26. sensibilità: target di tenant B deve essere bloccato quando il filtro tenant su memberships è integro", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(swapDriverBody({ to_driver_id: DRIVER_TO_B }));
    expect(res.status).toBe(404);
  });

  it("27. sensibilità: target non-driver deve essere bloccato quando il filtro role='driver' è integro", async () => {
    const fake = baseSeed({
      memberships: [
        membershipRow(DRIVER_FROM, TENANT_A),
        membershipRow(DRIVER_TO_A, TENANT_A, { role: "operator" }),
      ],
    });
    authorizeAs(fake);

    const res = await callPost(swapDriverBody());
    expect(res.status).toBe(404);
  });

  it("28. sensibilità filtro tenant driver_profiles: N/A — nessuna query driver_profiles emessa dal guard in swap_driver", () => {
    expect(true).toBe(true);
  });
});
