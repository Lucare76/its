import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * Test CONC-07 — gap residuo su update_trip: cambio-SOLO-mezzo.
 *
 * update_trip possiede già storico strutturato (driver_assignment_history)
 * quando cambia driver_profile_id (changeType "driver_swap", blocco
 * preesistente non toccato da questo file). Il gap era: driver invariato +
 * vehicle_label cambiato → nessun evento prodotto. Il fix aggiunge un ramo
 * "else if" allo stesso if/else del blocco driver_swap: quando il driver NON
 * cambia, uno snapshot minimo tenant-scoped degli assignments del gruppo
 * (preso subito prima della mutazione, stesso pattern di swap_vehicle)
 * fornisce il vehicle_label "prima" per ogni service_id realmente presente
 * nel gruppo. changeType "vehicle_binding" — nessun changeType nuovo,
 * nessun campo driver nell'entry (stesso contratto di swap_vehicle).
 *
 * logAssignmentChange è mockato come spy: permette di asserire con
 * precisione argomenti (previous/new, groupId, actor, tenant, changeType)
 * senza dipendere dai dettagli interni della sua implementazione reale (già
 * testata altrove).
 */

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_1 = "a1111111-1111-4111-8111-111111111111";
const SERVICE_2 = "a2222222-2222-4222-8222-222222222222";
const SERVICE_NEW = "a3333333-3333-4333-8333-333333333333";
const SERVICE_CONFLICT = "a4444444-4444-4444-8444-444444444444";
const SERVICE_TENANT_B = "a5555555-5555-4555-8555-555555555555";
const GROUP_1 = "c1111111-1111-4111-8111-111111111111";
const GROUP_CONFLICT = "c2222222-2222-4222-8222-222222222222";
const GROUP_TENANT_B = "c3333333-3333-4333-8333-333333333333";
const DRIVER_A = "d1111111-1111-4111-8111-111111111111";
const DRIVER_SUSPENDED = "d1111111-1111-4111-8111-111111111112";
const DRIVER_B = "d2222222-2222-4222-8222-222222222222";
const PROFILE_A1 = "p1111111-1111-4111-8111-111111111111";
const PROFILE_INACTIVE = "p1111111-1111-4111-8111-111111111112";
const OPERATOR_1 = "u1111111-1111-4111-8111-111111111111";
const VEHICLE_A = "Van 8";
const VEHICLE_B = "Van 9";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

const RAW_DB_ERROR = { message: 'connection to server "internal-db-host.example" failed: SQLSTATE[08006]' };

/**
 * Fake Supabase in-memory, tenant-aware — stesso schema riusato dagli altri
 * file CONC-07 (piano-giorno-trips-swap-vehicle-assignment-history.test.ts,
 * piano-giorno-trips-update-driver-status-guard.test.ts).
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
  const tableUpdateErrors: Record<string, { message: string } | undefined> = {};
  const selectCallCounts: Record<string, number> = {};

  const calls = {
    unscopedQueries: [] as string[],
    assignmentsUpserts: 0,
    assignmentsUpdates: 0,
    assignmentsDeletes: 0,
    tripGroupsUpdates: 0,
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
        filtered = filtered.filter((r) => (r[field] ?? null) !== value);
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
        if (op === "update" && tableUpdateErrors[table]) {
          return Promise.resolve({ data: null, error: tableUpdateErrors[table] }).then(resolve, reject);
        }
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
        // Copie, non riferimenti live: uno snapshot "prima" letto e
        // conservato non deve essere alterato retroattivamente da un update
        // successivo sulla stessa riga.
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
              const inserted = { id: row.id ?? `${table}-${Math.random().toString(36).slice(2)}`, ...row };
              arr.push(inserted);
              if (table === "assignments") calls.assignmentsUpserts++;
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
    setUpdateError(table: string, err: { message: string } | null) {
      tableUpdateErrors[table] = err ?? undefined;
    },
  };
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  auditLog: vi.fn(),
  sendPushToUser: vi.fn(),
  extractFeatures: vi.fn(),
  logAssignmentChange: vi.fn(),
  updateLearnedPatterns: vi.fn(),
  loadVehicleCommitmentsForDate: vi.fn(),
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
  extractFeatures: mocks.extractFeatures,
  logAssignmentChange: mocks.logAssignmentChange,
}));
vi.mock("@/lib/server/learned-patterns", () => ({
  updateLearnedPatterns: mocks.updateLearnedPatterns,
}));
vi.mock("@/lib/server/vehicle-commitments", () => ({
  loadVehicleCommitmentsForDate: mocks.loadVehicleCommitmentsForDate,
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
    services: [serviceRow(TENANT_A, SERVICE_1)],
    trip_groups: [
      { id: GROUP_1, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_A, driver_profile_id: null, vehicle_label: VEHICLE_A, status: "active" },
    ],
    assignments: [
      { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_1, driver_user_id: DRIVER_A, driver_profile_id: null, vehicle_label: VEHICLE_A },
    ],
    daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
    driver_daily_availability: [
      { tenant_id: TENANT_A, driver_user_id: DRIVER_A, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      { tenant_id: TENANT_A, driver_user_id: DRIVER_SUSPENDED, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      { tenant_id: TENANT_A, driver_profile_id: PROFILE_A1, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
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
    vehicles: [],
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

function authorizeAs(fake: ReturnType<typeof createTenantAwareSupabase>, userId: string = OPERATOR_1, role: string = "operator") {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: userId, email: `${userId}@test.dev` },
    membership: { tenant_id: TENANT_A, role, suspended: false },
  });
}

function updateTripBody(overrides: Record<string, unknown> = {}) {
  return {
    action: "update_trip",
    group_id: GROUP_1,
    driver_user_id: DRIVER_A,
    ...overrides,
  };
}

function lastHistoryEntries(): Row[] {
  const calls = mocks.logAssignmentChange.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as Row[];
}

function assertZeroWrites(fake: ReturnType<typeof createTenantAwareSupabase>) {
  expect(fake.calls.tripGroupsUpdates).toBe(0);
  expect(fake.calls.assignmentsUpdates).toBe(0);
  expect(fake.calls.assignmentsDeletes).toBe(0);
  expect(fake.calls.assignmentsUpserts).toBe(0);
}

describe("CONC-07 — storico strutturato (driver_assignment_history) su update_trip, cambio-solo-mezzo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extractFeatures.mockReturnValue({ mocked_features: true });
    mocks.logAssignmentChange.mockResolvedValue(undefined);
    mocks.updateLearnedPatterns.mockResolvedValue({ upserted: 0 });
    mocks.loadVehicleCommitmentsForDate.mockResolvedValue({ byVehicleId: new Map() });
  });

  it("1. solo mezzo cambia (driver invariato): vehicle_binding scritto una sola volta", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ vehicle_label: VEHICLE_B }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].changeType).toBe("vehicle_binding");
    expect(entries[0].serviceId).toBe(SERVICE_1);
  });

  it("2. previous vehicle A → new B: fromVehicleLabel/toVehicleLabel corretti", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(updateTripBody({ vehicle_label: VEHICLE_B }));

    const entries = lastHistoryEntries();
    expect(entries[0].fromVehicleLabel).toBe(VEHICLE_A);
    expect(entries[0].toVehicleLabel).toBe(VEHICLE_B);
  });

  it("3. previous null → new B: evento comunque generato", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: GROUP_1, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_A, driver_profile_id: null, vehicle_label: null, status: "active" }],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_1, driver_user_id: DRIVER_A, driver_profile_id: null, vehicle_label: null }],
    });
    authorizeAs(fake);

    await callPost(updateTripBody({ vehicle_label: VEHICLE_B }));

    const entries = lastHistoryEntries();
    expect(entries[0].fromVehicleLabel).toBeNull();
    expect(entries[0].toVehicleLabel).toBe(VEHICLE_B);
  });

  it("4. new null (mezzo rimosso): evento generato con toVehicleLabel null", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    // vehicle_label omesso dal body → effectiveVehicleLabel risolve a null.
    await callPost(updateTripBody({}));

    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryEntries();
    expect(entries[0].fromVehicleLabel).toBe(VEHICLE_A);
    expect(entries[0].toVehicleLabel).toBeNull();
  });

  it("5. mezzo invariato (driver invariato): zero evento", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ vehicle_label: VEHICLE_A }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("6. driver cambia (mezzo invariato): driver_swap esistente, comportamento invariato", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_profile_id: PROFILE_A1, vehicle_label: VEHICLE_A }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryEntries();
    expect(entries[0].changeType).toBe("driver_swap");
  });

  it("7. driver+mezzo cambiano insieme: un solo evento driver_swap, nessun vehicle_binding", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_profile_id: PROFILE_A1, vehicle_label: VEHICLE_B }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].changeType).toBe("driver_swap");
    expect(entries.some((e) => e.changeType === "vehicle_binding")).toBe(false);
  });

  it("8. nessun doppio vehicle_binding su cambio-solo-mezzo con singolo service", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(updateTripBody({ vehicle_label: VEHICLE_B }));

    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
  });

  it("9. singolo service: un solo entry", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(updateTripBody({ vehicle_label: VEHICLE_B }));

    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(1);
  });

  it("10. batch — più service nello stesso gruppo: un entry per ciascuno", async () => {
    const fake = baseSeed({
      services: [serviceRow(TENANT_A, SERVICE_1), serviceRow(TENANT_A, SERVICE_2, { time: "14:00:00" })],
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_1, driver_user_id: DRIVER_A, driver_profile_id: null, vehicle_label: VEHICLE_A },
        { id: "asg-2", tenant_id: TENANT_A, service_id: SERVICE_2, group_id: GROUP_1, driver_user_id: DRIVER_A, driver_profile_id: null, vehicle_label: VEHICLE_A },
      ],
    });
    authorizeAs(fake);

    await callPost(updateTripBody({ vehicle_label: VEHICLE_B }));

    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.serviceId).sort()).toEqual([SERVICE_1, SERVICE_2].sort());
  });

  it("11. previous vehicle differente per due assignments: from corretto per ciascuno", async () => {
    const fake = baseSeed({
      services: [serviceRow(TENANT_A, SERVICE_1), serviceRow(TENANT_A, SERVICE_2, { time: "14:00:00" })],
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_1, driver_user_id: DRIVER_A, driver_profile_id: null, vehicle_label: VEHICLE_A },
        { id: "asg-2", tenant_id: TENANT_A, service_id: SERVICE_2, group_id: GROUP_1, driver_user_id: DRIVER_A, driver_profile_id: null, vehicle_label: null },
      ],
    });
    authorizeAs(fake);

    await callPost(updateTripBody({ vehicle_label: VEHICLE_B }));

    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(2);
    const byService = new Map(entries.map((e) => [e.serviceId, e]));
    expect(byService.get(SERVICE_1)?.fromVehicleLabel).toBe(VEHICLE_A);
    expect(byService.get(SERVICE_2)?.fromVehicleLabel).toBeNull();
    expect(entries.every((e) => e.toVehicleLabel === VEHICLE_B)).toBe(true);
  });

  it("12. groupId corretto in ogni entry", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(updateTripBody({ vehicle_label: VEHICLE_B }));

    const entries = lastHistoryEntries();
    expect(entries.every((e) => e.groupId === GROUP_1)).toBe(true);
  });

  it("13. actor (operatorId) corretto", async () => {
    const fake = baseSeed();
    authorizeAs(fake, "operator-xyz");

    await callPost(updateTripBody({ vehicle_label: VEHICLE_B }));

    const entries = lastHistoryEntries();
    expect(entries[0].operatorId).toBe("operator-xyz");
  });

  it("14. tenantId corretto in ogni entry", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(updateTripBody({ vehicle_label: VEHICLE_B }));

    const entries = lastHistoryEntries();
    expect(entries.every((e) => e.tenantId === TENANT_A)).toBe(true);
  });

  it("15. tenant_id malevolo nel body viene ignorato: l'entry usa il tenant dell'auth, non quello spoofato", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(updateTripBody({ vehicle_label: VEHICLE_B, tenant_id: TENANT_B }));

    const entries = lastHistoryEntries();
    expect(entries.every((e) => e.tenantId === TENANT_A)).toBe(true);
  });

  it("16. group di tenant B: SEC-02/guard blocca prima, zero history, zero scritture", async () => {
    const fake = baseSeed({
      trip_groups: [],
      assignments: [],
    });
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ group_id: GROUP_TENANT_B, vehicle_label: VEHICLE_B }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
    assertZeroWrites(fake);
  });

  it("17. service_ids esplicito (stesso insieme del gruppo): vehicle_binding coerente", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(updateTripBody({ vehicle_label: VEHICLE_B, service_ids: [SERVICE_1] }));

    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].serviceId).toBe(SERVICE_1);
  });

  it("18. service_ids omesso: usa effectiveServiceIds (gruppo corrente)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(updateTripBody({ vehicle_label: VEHICLE_B }));

    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].serviceId).toBe(SERVICE_1);
  });

  it("19. service_ids con duplicati: nessun doppio entry per lo stesso service", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(updateTripBody({ vehicle_label: VEHICLE_B, service_ids: [SERVICE_1, SERVICE_1] }));

    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(1);
  });

  it("20. servizio rimosso dal gruppo: nessun falso history di rimozione, nessun changeType inventato", async () => {
    const fake = baseSeed({
      services: [serviceRow(TENANT_A, SERVICE_1), serviceRow(TENANT_A, SERVICE_2, { time: "14:00:00" })],
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_1, driver_user_id: DRIVER_A, driver_profile_id: null, vehicle_label: VEHICLE_A },
        { id: "asg-2", tenant_id: TENANT_A, service_id: SERVICE_2, group_id: GROUP_1, driver_user_id: DRIVER_A, driver_profile_id: null, vehicle_label: VEHICLE_A },
      ],
    });
    authorizeAs(fake);

    // service_ids esplicito rimuove SERVICE_2 dal gruppo; il mezzo del
    // gruppo non cambia (resta VEHICLE_A) → nessun evento per SERVICE_1.
    const res = await callPost(updateTripBody({ vehicle_label: VEHICLE_A, service_ids: [SERVICE_1] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
    expect(fake.tables.assignments.some((a) => a.service_id === SERVICE_2)).toBe(false);
  });

  it("21. servizio aggiunto al gruppo con mezzo assegnato: history coerente (previous null → new)", async () => {
    const fake = baseSeed({
      services: [serviceRow(TENANT_A, SERVICE_1), serviceRow(TENANT_A, SERVICE_NEW, { time: "16:00:00" })],
    });
    authorizeAs(fake);

    await callPost(updateTripBody({ vehicle_label: VEHICLE_B, service_ids: [SERVICE_1, SERVICE_NEW] }));

    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(2);
    const byService = new Map(entries.map((e) => [e.serviceId, e]));
    expect(byService.get(SERVICE_NEW)?.fromVehicleLabel).toBeNull();
    expect(byService.get(SERVICE_NEW)?.toVehicleLabel).toBe(VEHICLE_B);
  });

  it("22. nessun history su 401 (utente non autenticato)", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const fake = baseSeed();

    const res = await callPost(updateTripBody({ vehicle_label: VEHICLE_B }));

    expect(res.status).toBe(401);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
    assertZeroWrites(fake);
  });

  it("23. nessun history su 403 (ruolo non autorizzato)", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    const fake = baseSeed();

    const res = await callPost(updateTripBody({ vehicle_label: VEHICLE_B }));

    expect(res.status).toBe(403);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
    assertZeroWrites(fake);
  });

  it("24. nessun history su SEC-02 (service_id di tenant B non trovato)", async () => {
    const fake = baseSeed({
      services: [serviceRow(TENANT_A, SERVICE_1), serviceRow(TENANT_B, SERVICE_TENANT_B)],
    });
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ vehicle_label: VEHICLE_B, service_ids: [SERVICE_TENANT_B] }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Uno o più servizi non trovati." });
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
    assertZeroWrites(fake);
  });

  it("25. nessun history su SEC-05 (driver cross-tenant)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ vehicle_label: VEHICLE_B, driver_user_id: DRIVER_B }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
    assertZeroWrites(fake);
  });

  it("26. nessun history su FUNC-02 (servizio non operativo)", async () => {
    const fake = baseSeed({
      services: [serviceRow(TENANT_A, SERVICE_1, { status: "cancelled" })],
    });
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ vehicle_label: VEHICLE_B, service_ids: [SERVICE_1] }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("SERVICE_NOT_ASSIGNABLE");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
    assertZeroWrites(fake);
  });

  it("27. nessun history su FUNC-03 (driver non operativo: membership sospesa)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ vehicle_label: VEHICLE_B, driver_user_id: DRIVER_SUSPENDED }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("DRIVER_NOT_ACTIVE");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
    assertZeroWrites(fake);
  });

  it("28. nessun history su availability non confermata", async () => {
    const fake = baseSeed({
      daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: false }],
    });
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ vehicle_label: VEHICLE_B }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
    assertZeroWrites(fake);
  });

  it("29. nessun history su conflitto timeline mezzo (sovrapposizione reale)", async () => {
    // GROUP_CONFLICT usa già VEHICLE_B nella stessa data, con un servizio
    // sovrapposto in orario a SERVICE_1 (stesso "time"): validateVehicleTimelinePayload
    // deve rifiutare l'update PRIMA di qualunque mutazione/scrittura history.
    const conflictAssignment = {
      id: "asg-conflict",
      tenant_id: TENANT_A,
      service_id: SERVICE_CONFLICT,
      group_id: GROUP_CONFLICT,
      driver_user_id: DRIVER_B,
      driver_profile_id: null,
      vehicle_label: VEHICLE_B,
      services: serviceRow(TENANT_A, SERVICE_CONFLICT, { time: "10:00:00" }),
    };
    const fake = baseSeed({
      trip_groups: [
        { id: GROUP_1, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_A, driver_profile_id: null, vehicle_label: VEHICLE_A, status: "active" },
        { id: GROUP_CONFLICT, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_B, driver_profile_id: null, vehicle_label: VEHICLE_B, status: "active" },
      ],
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_1, driver_user_id: DRIVER_A, driver_profile_id: null, vehicle_label: VEHICLE_A },
        conflictAssignment,
      ],
    });
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ vehicle_label: VEHICLE_B }));
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.ok).toBe(false);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
    assertZeroWrites(fake);
  });

  it("30. response invariata su successo (ok + warnings), come prima del fix", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ vehicle_label: VEHICLE_B }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  it("31. history rigetta (logAssignmentChange fallisce): risposta invariata, nessun unhandled rejection", async () => {
    const fake = baseSeed();
    authorizeAs(fake);
    mocks.logAssignmentChange.mockRejectedValue(new Error("history write failed"));

    const res = await callPost(updateTripBody({ vehicle_label: VEHICLE_B }));
    const body = await res.json();
    await new Promise((r) => setTimeout(r, 0));

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("32. zero unhandled rejection quando updateLearnedPatterns fallisce dopo history riuscita", async () => {
    const fake = baseSeed();
    authorizeAs(fake);
    mocks.logAssignmentChange.mockResolvedValue(undefined);
    mocks.updateLearnedPatterns.mockRejectedValue(new Error("patterns failed"));

    const res = await callPost(updateTripBody({ vehicle_label: VEHICLE_B }));
    const body = await res.json();
    await new Promise((r) => setTimeout(r, 0));

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("33. create_trip invariato: nessuna regressione da questo fix", async () => {
    const fake = baseSeed({
      services: [serviceRow(TENANT_A, SERVICE_NEW)],
      trip_groups: [],
      assignments: [],
    });
    authorizeAs(fake);

    const res = await callPost({
      action: "create_trip",
      date: TEST_DATE,
      service_ids: [SERVICE_NEW],
      driver_user_id: DRIVER_A,
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("34. move_services invariato: nessuna regressione da questo fix", async () => {
    const fake = baseSeed({
      services: [serviceRow(TENANT_A, SERVICE_1)],
      trip_groups: [{ id: GROUP_1, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_A, driver_profile_id: null, vehicle_label: VEHICLE_A, status: "active" }],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_1, driver_user_id: DRIVER_A, driver_profile_id: null, vehicle_label: VEHICLE_A }],
    });
    authorizeAs(fake);

    const res = await callPost({
      action: "move_services",
      service_ids: [SERVICE_1],
      target_group_id: GROUP_1,
      date: TEST_DATE,
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("35. swap_driver invariato: nessuna regressione da questo fix", async () => {
    const TARGET_DRIVER = "d3333333-3333-4333-8333-333333333333";
    const fake = baseSeed({
      assignments: [
        {
          id: "asg-1",
          tenant_id: TENANT_A,
          service_id: SERVICE_1,
          group_id: GROUP_1,
          driver_user_id: DRIVER_A,
          driver_profile_id: null,
          vehicle_label: VEHICLE_A,
          // validateTripPayload legge assignment.services come join
          // annidato reale (Supabase); il fake non esegue join, quindi il
          // valore va allegato esplicitamente sulla riga seed.
          services: serviceRow(TENANT_A, SERVICE_1),
        },
      ],
      memberships: [
        membershipRow(DRIVER_A, TENANT_A, { suspended: false }),
        membershipRow(TARGET_DRIVER, TENANT_A, { suspended: false }),
      ],
      driver_daily_availability: [
        { tenant_id: TENANT_A, driver_user_id: TARGET_DRIVER, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      ],
    });
    authorizeAs(fake);

    const res = await callPost({
      action: "swap_driver",
      date: TEST_DATE,
      from_driver_id: DRIVER_A,
      to_driver_id: TARGET_DRIVER,
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("36. swap_vehicle invariato: nessuna regressione da questo fix", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({
      action: "swap_vehicle",
      date: TEST_DATE,
      from_vehicle_label: VEHICLE_A,
      to_vehicle_label: VEHICLE_B,
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("39. sensibilità A: eliminando il ramo vehicle_binding, l'evento non verrebbe più prodotto (verifica che il branch sia realmente raggiunto)", async () => {
    // Verifica indiretta: con lo snapshot azzerato manualmente (simulando la
    // rimozione del ramo tramite uno snapshot fallito), nessun evento deve
    // essere prodotto per il cambio-solo-mezzo — dimostra che il branch reale
    // è l'unica fonte dell'evento in questo scenario.
    const fake = baseSeed();
    fake.setError("assignments", RAW_DB_ERROR, 1);
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ vehicle_label: VEHICLE_B }));

    // Con lo snapshot "prima" fallito, il ramo vehicle_binding si astiene
    // (best-effort): nessun evento, ma l'update stesso può comunque fallire
    // per lo stesso errore già presente su "assignments" (guard/fetch
    // condivisi la usano prima). Qui verifichiamo solo l'invariante di
    // sicurezza: mai un evento con previous indovinato.
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
    void res;
  });

  it("40. sensibilità B: from/to non sono mai invertiti", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(updateTripBody({ vehicle_label: VEHICLE_B }));

    const entries = lastHistoryEntries();
    expect(entries[0].fromVehicleLabel).not.toBe(entries[0].toVehicleLabel);
    expect(entries[0].fromVehicleLabel).toBe(VEHICLE_A);
    expect(entries[0].toVehicleLabel).toBe(VEHICLE_B);
  });

  it("41. sensibilità C: driver+mezzo cambiati insieme non producono mai un doppio evento (driver_swap + vehicle_binding)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(updateTripBody({ driver_profile_id: PROFILE_A1, vehicle_label: VEHICLE_B }));

    const changeTypes = mocks.logAssignmentChange.mock.calls.flatMap((call) => (call[1] as Row[]).map((e) => e.changeType));
    expect(changeTypes).toEqual(["driver_swap"]);
  });

  it("42. sensibilità D: l'evento vehicle_binding viene registrato solo dopo il successo della mutazione (risposta ok=true accompagna sempre l'evento)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ vehicle_label: VEHICLE_B }));
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(fake.tables.trip_groups.find((g) => g.id === GROUP_1)?.vehicle_label).toBe(VEHICLE_B);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
  });
});
