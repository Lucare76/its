import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * Test CONC-07 — storico strutturato (driver_assignment_history) sull'action
 * move_services di piano-giorno/trips.
 *
 * move_services aggiorna assignments (group_id/driver/vehicle) in batch, sia
 * verso un gruppo appena creato sia verso un gruppo esistente, ma non
 * registrava la variazione tramite logAssignmentChange. Il fix riusa
 * esattamente lo stesso contratto già validato in assign-service/update_trip
 * (cambio driver_profile_id -> "driver_swap", solo mezzo -> "vehicle_binding"),
 * con uno snapshot "prima" tenant-scoped letto subito prima della mutazione.
 *
 * logAssignmentChange e updateLearnedPatterns sono mockati come spy: permette
 * di asserire con precisione gli argomenti (previous/new, actor, tenant,
 * changeType) senza dipendere dai dettagli interni della loro implementazione
 * reale (già testata altrove).
 */

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_1 = "a1111111-1111-4111-8111-111111111111";
const SERVICE_2 = "a2222222-2222-4222-8222-222222222222";
const GROUP_SOURCE = "c0000000-0000-4000-8000-000000000000";
const GROUP_TARGET_DIFF_DRIVER = "c1111111-1111-4111-8111-111111111111";
const GROUP_TARGET_SAME_DRIVER_DIFF_VEHICLE = "c2222222-2222-4222-8222-222222222222";
const GROUP_TARGET_IDENTICAL = "c3333333-3333-4333-8333-333333333333";
const GROUP_TARGET_NO_DRIVER = "c4444444-4444-4444-8444-444444444444";
const DRIVER_SOURCE = "d0000000-0000-4000-8000-000000000000";
const DRIVER_TARGET = "d1111111-1111-4111-8111-111111111111";
const PROFILE_SOURCE = "p0000000-0000-4000-8000-000000000000";
const PROFILE_TARGET = "p1111111-1111-4111-8111-111111111111";
const OPERATOR_1 = "u1111111-1111-4111-8111-111111111111";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

const RAW_DB_ERROR = { message: 'connection to server "internal-db-host.example" failed: SQLSTATE[08006]' };

/**
 * Fake Supabase in-memory, tenant-aware — stesso schema riusato da
 * piano-giorno-trips-move-services-{driver-tenant,status}-guard.test.ts.
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

  const tableErrors: Record<string, { message: string } | undefined> = {};
  const tableErrorFromCall: Record<string, number> = {};
  const selectCallCounts: Record<string, number> = {};
  const tableInsertErrors: Record<string, { message: string } | undefined> = {};

  const calls = {
    tripGroupsInserts: 0,
    tripGroupsUpdates: 0,
    assignmentsUpdates: 0,
  };

  function makeQueryBuilder(table: string, op: "select" | "delete" | "update", updatePayload?: Row) {
    const rows = tables[table];
    let filtered = rows;
    let limitN: number | null = null;

    // Simula il join embedded `services!inner(...)` che le route reali usano
    // su "assignments" (es. ASSIGNMENT_SERVICE_VALIDATION_COLUMNS in
    // validateTripPayload/validateVehicleTimelinePayload): senza questo, le
    // righe "assignments" restituite dal fake non avrebbero mai `.services`
    // popolato e il codice reale (che lo legge sempre) lancerebbe.
    function cloneRow(row: Row): Row {
      if (table !== "assignments") return { ...row };
      return { ...row, services: tables.services.find((s) => s.id === row.service_id) ?? null };
    }
    let thisCallIndex = 0;
    if (op === "select") {
      selectCallCounts[table] = (selectCallCounts[table] ?? 0) + 1;
      thisCallIndex = selectCallCounts[table];
      
    }

    function shouldError(): boolean {
      if (!tableErrors[table]) return false;
      const fromCall = tableErrorFromCall[table] ?? 1;
      return op === "select" ? thisCallIndex >= fromCall : true;
    }

    // limit() è applicato pigramente, solo alla risoluzione finale (come le
    // altre clausole): Supabase valuta l'intera catena solo quando la query
    // viene eseguita, indipendentemente dall'ordine di chiamata dei metodi
    // (es. .limit(1) prima di un .eq() successivo nella catena reale).
    function resolveScope() {
      if (limitN !== null) filtered = filtered.slice(0, limitN);
    }

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
        return Promise.resolve({ data: filtered[0] ? cloneRow(filtered[0]) : null, error: null });
      },
      single() {
        resolveScope();
        if (shouldError()) {
          return Promise.resolve({ data: null, error: tableErrors[table] });
        }
        return Promise.resolve({ data: filtered[0] ? cloneRow(filtered[0]) : null, error: filtered[0] ? null : { message: "not found" } });
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
        // select: restituisce copie, non i riferimenti live alle righe della
        // tabella — altrimenti una mutazione successiva (update) sulla stessa
        // riga altererebbe retroattivamente uno snapshot "prima" già letto e
        // conservato altrove (esattamente lo scenario che i test su
        // logAssignmentChange devono poter verificare in modo affidabile).
        return Promise.resolve({ data: filtered.map((r) => cloneRow(r)), error: null }).then(resolve, reject);
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
          if (tableInsertErrors[table]) {
            return {
              select() {
                return {
                  single: () => Promise.resolve({ data: null, error: tableInsertErrors[table] }),
                  maybeSingle: () => Promise.resolve({ data: null, error: tableInsertErrors[table] }),
                };
              },
              then(resolve: (v: { data: null; error: { message: string } }) => unknown, reject?: (e: unknown) => unknown) {
                return Promise.resolve({ data: null, error: tableInsertErrors[table] }).then(resolve, reject);
              },
            };
          }
          const rowsArr = Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow];
          const inserted = rowsArr.map((r) => ({ id: r.id ?? `${table}-${Math.random().toString(36).slice(2)}`, status: "active", ...r }));
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
    setInsertError(table: string, err: { message: string } | null) {
      tableInsertErrors[table] = err ?? undefined;
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

function serviceRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT_A,
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
    services: [serviceRow(SERVICE_1), serviceRow(SERVICE_2, { time: "14:00:00" })],
    trip_groups: [
      { id: GROUP_SOURCE, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_SOURCE, driver_profile_id: PROFILE_SOURCE, vehicle_label: "Van 8", status: "active" },
      { id: GROUP_TARGET_DIFF_DRIVER, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_TARGET, driver_profile_id: PROFILE_TARGET, vehicle_label: "Van 9", status: "active" },
      { id: GROUP_TARGET_SAME_DRIVER_DIFF_VEHICLE, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_SOURCE, driver_profile_id: PROFILE_SOURCE, vehicle_label: "Van 9", status: "active" },
      { id: GROUP_TARGET_IDENTICAL, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_SOURCE, driver_profile_id: PROFILE_SOURCE, vehicle_label: "Van 8", status: "active" },
      { id: GROUP_TARGET_NO_DRIVER, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: null, driver_profile_id: null, vehicle_label: null, status: "active" },
    ],
    assignments: [
      { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_SOURCE, driver_user_id: DRIVER_SOURCE, driver_profile_id: PROFILE_SOURCE, vehicle_label: "Van 8" },
      { id: "asg-2", tenant_id: TENANT_A, service_id: SERVICE_2, group_id: GROUP_SOURCE, driver_user_id: DRIVER_SOURCE, driver_profile_id: PROFILE_SOURCE, vehicle_label: "Van 8" },
    ],
    memberships: [
      membershipRow(DRIVER_SOURCE, TENANT_A),
      membershipRow(DRIVER_TARGET, TENANT_A),
    ],
    driver_profiles: [
      driverProfileRow(PROFILE_SOURCE, TENANT_A, DRIVER_SOURCE),
      driverProfileRow(PROFILE_TARGET, TENANT_A, DRIVER_TARGET),
    ],
    driver_daily_availability: [
      { tenant_id: TENANT_A, driver_user_id: DRIVER_SOURCE, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      { tenant_id: TENANT_A, driver_user_id: DRIVER_TARGET, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      { tenant_id: TENANT_A, driver_profile_id: PROFILE_SOURCE, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      { tenant_id: TENANT_A, driver_profile_id: PROFILE_TARGET, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
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

function authorizeAs(fake: ReturnType<typeof createTenantAwareSupabase>, userId: string = OPERATOR_1, role: string = "operator") {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: userId, email: `${userId}@test.dev` },
    membership: { tenant_id: TENANT_A, role, suspended: false },
  });
}

function moveServicesBody(overrides: Record<string, unknown> = {}) {
  return {
    action: "move_services",
    service_ids: [SERVICE_1],
    group_id: GROUP_SOURCE,
    target_group_id: GROUP_TARGET_DIFF_DRIVER,
    ...overrides,
  };
}

function lastHistoryEntries(): Row[] {
  const calls = mocks.logAssignmentChange.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as Row[];
}

describe("CONC-07 — storico strutturato (driver_assignment_history) su move_services", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extractFeatures.mockReturnValue({ mocked_features: true });
    mocks.logAssignmentChange.mockResolvedValue(undefined);
    mocks.updateLearnedPatterns.mockResolvedValue({ upserted: 0 });
  });

  it("1. spostamento singolo verso gruppo esistente con driver diverso: history scritto, changeType driver_swap", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].changeType).toBe("driver_swap");
    expect(entries[0].serviceId).toBe(SERVICE_1);
  });

  it("2. batch verso gruppo esistente: un entry per servizio", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ service_ids: [SERVICE_1, SERVICE_2] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.serviceId).sort()).toEqual([SERVICE_1, SERVICE_2].sort());
  });

  it("3. creazione nuovo gruppo (target_group_id assente): history scritto", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ target_group_id: undefined, date: TEST_DATE, driver_user_id: DRIVER_TARGET, driver_profile_id: PROFILE_TARGET }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryEntries();
    expect(entries[0].groupId).toBe(body.group_id);
  });

  it("4. cambio driver: previous/new driver_profile_id corretti", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(moveServicesBody());

    const entries = lastHistoryEntries();
    expect(entries[0].changeType).toBe("driver_swap");
    expect(entries[0].fromDriverProfileId).toBe(PROFILE_SOURCE);
    expect(entries[0].toDriverProfileId).toBe(PROFILE_TARGET);
  });

  it("5. cambio driver_profile (stesso schema del punto 4, verificato esplicitamente)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_DIFF_DRIVER }));

    const entries = lastHistoryEntries();
    expect(entries[0].toDriverProfileId).toBe(PROFILE_TARGET);
  });

  it("6. cambio solo mezzo (driver invariato): changeType vehicle_binding, nessun campo driver", async () => {
    // Gruppo sorgente marcato "cancelled": evita che la validazione timeline
    // (stesso driver su due gruppi attivi) confronti il servizio in movimento
    // con se stesso nel gruppo di origine — scenario non pertinente
    // all'assertion sotto test (solo mezzo cambiato, stesso driver).
    const fake = baseSeed({
      trip_groups: [
        { id: GROUP_SOURCE, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_SOURCE, driver_profile_id: PROFILE_SOURCE, vehicle_label: "Van 8", status: "cancelled" },
        { id: GROUP_TARGET_SAME_DRIVER_DIFF_VEHICLE, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_SOURCE, driver_profile_id: PROFILE_SOURCE, vehicle_label: "Van 9", status: "active" },
      ],
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_SOURCE, driver_user_id: DRIVER_SOURCE, driver_profile_id: PROFILE_SOURCE, vehicle_label: "Van 8" },
      ],
    });
    authorizeAs(fake);

    await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_SAME_DRIVER_DIFF_VEHICLE }));

    const entries = lastHistoryEntries();
    expect(entries[0].changeType).toBe("vehicle_binding");
    expect(entries[0].fromVehicleLabel).toBe("Van 8");
    expect(entries[0].toVehicleLabel).toBe("Van 9");
    expect(entries[0].fromDriverProfileId).toBeUndefined();
    expect(entries[0].toDriverProfileId).toBeUndefined();
  });

  it("7. cambio driver e mezzo insieme: precedenza driver_swap, entrambi i previous/new valorizzati", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_DIFF_DRIVER }));

    const entries = lastHistoryEntries();
    expect(entries[0].changeType).toBe("driver_swap");
    expect(entries[0].fromDriverProfileId).toBe(PROFILE_SOURCE);
    expect(entries[0].toDriverProfileId).toBe(PROFILE_TARGET);
    expect(entries[0].fromVehicleLabel).toBe("Van 8");
    expect(entries[0].toVehicleLabel).toBe("Van 9");
  });

  it("8. cambio SOLO group_id (stesso driver, stesso mezzo): nessun evento (limite di schema documentato, nessun changeType inventato)", async () => {
    // Stesso accorgimento del test 6: gruppo sorgente "cancelled" per non far
    // rientrare il servizio in movimento nella propria validazione timeline.
    const fake = baseSeed({
      trip_groups: [
        { id: GROUP_SOURCE, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_SOURCE, driver_profile_id: PROFILE_SOURCE, vehicle_label: "Van 8", status: "cancelled" },
        { id: GROUP_TARGET_IDENTICAL, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_SOURCE, driver_profile_id: PROFILE_SOURCE, vehicle_label: "Van 8", status: "active" },
      ],
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_SOURCE, driver_user_id: DRIVER_SOURCE, driver_profile_id: PROFILE_SOURCE, vehicle_label: "Van 8" },
      ],
    });
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_IDENTICAL }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("9. assignment precedente assente: nuova assegnazione, driver_swap da null", async () => {
    const fake = baseSeed({
      assignments: [],
    });
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_DIFF_DRIVER }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    const entries = lastHistoryEntries();
    expect(entries[0].changeType).toBe("driver_swap");
    expect(entries[0].fromDriverProfileId).toBeNull();
    expect(entries[0].toDriverProfileId).toBe(PROFILE_TARGET);
  });

  it("10. previous da un gruppo diverso da quello indicato nel body (group_id sorgente non attendibile, si legge lo snapshot reale)", async () => {
    const fake = baseSeed({
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: "altro-gruppo-non-dichiarato", driver_user_id: DRIVER_SOURCE, driver_profile_id: PROFILE_SOURCE, vehicle_label: "Van 8" },
      ],
    });
    authorizeAs(fake);

    await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_DIFF_DRIVER }));

    const entries = lastHistoryEntries();
    expect(entries[0].fromDriverProfileId).toBe(PROFILE_SOURCE);
  });

  it("11. previous con assignment_source 'auto_assign_dispatch' (proveniente da auto-assign): letto correttamente", async () => {
    const fake = baseSeed({
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_SOURCE, driver_user_id: DRIVER_SOURCE, driver_profile_id: PROFILE_SOURCE, vehicle_label: "Van 8", assignment_source: "auto_assign_dispatch", locked_by_operator: false },
      ],
    });
    authorizeAs(fake);

    await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_DIFF_DRIVER }));

    const entries = lastHistoryEntries();
    expect(entries[0].fromDriverProfileId).toBe(PROFILE_SOURCE);
  });

  it("12. previous con assignment_source 'manual_assign_service' (proveniente da assign-service): letto correttamente", async () => {
    const fake = baseSeed({
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_SOURCE, driver_user_id: DRIVER_SOURCE, driver_profile_id: PROFILE_SOURCE, vehicle_label: "Van 8", assignment_source: "manual_assign_service", locked_by_operator: true },
      ],
    });
    authorizeAs(fake);

    await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_DIFF_DRIVER }));

    const entries = lastHistoryEntries();
    expect(entries[0].fromDriverProfileId).toBe(PROFILE_SOURCE);
  });

  it("13. previous con group_id=null (proveniente da departure-bus-assign): letto correttamente senza filtrare per gruppo", async () => {
    const fake = baseSeed({
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: null, driver_user_id: DRIVER_SOURCE, driver_profile_id: PROFILE_SOURCE, vehicle_label: "Van 8" },
      ],
    });
    authorizeAs(fake);

    await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_DIFF_DRIVER }));

    const entries = lastHistoryEntries();
    expect(entries[0].fromDriverProfileId).toBe(PROFILE_SOURCE);
  });

  it("14. duplicati nel body (stesso service_id ripetuto): nessun doppio history", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ service_ids: [SERVICE_1, SERVICE_1, SERVICE_1] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    expect(lastHistoryEntries()).toHaveLength(1);
  });

  it("15. due servizi con previous diversi: due entry con from differenti", async () => {
    const fake = baseSeed({
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_SOURCE, driver_user_id: DRIVER_SOURCE, driver_profile_id: PROFILE_SOURCE, vehicle_label: "Van 8" },
        { id: "asg-2", tenant_id: TENANT_A, service_id: SERVICE_2, group_id: null, driver_user_id: null, driver_profile_id: null, vehicle_label: null },
      ],
    });
    authorizeAs(fake);

    await callPost(moveServicesBody({ service_ids: [SERVICE_1, SERVICE_2], target_group_id: GROUP_TARGET_DIFF_DRIVER }));

    const entries = lastHistoryEntries();
    const bySvc = new Map(entries.map((e) => [e.serviceId, e]));
    expect(bySvc.get(SERVICE_1)?.fromDriverProfileId).toBe(PROFILE_SOURCE);
    expect(bySvc.get(SERVICE_2)?.fromDriverProfileId).toBeNull();
  });

  it("16. actor corretto: operatorId coincide con l'utente autenticato", async () => {
    const fake = baseSeed();
    authorizeAs(fake, "operator-xyz");

    await callPost(moveServicesBody());

    const entries = lastHistoryEntries();
    expect(entries[0].operatorId).toBe("operator-xyz");
  });

  it("17. tenant corretto: tenantId coincide con quello della sessione", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(moveServicesBody());

    const entries = lastHistoryEntries();
    expect(entries[0].tenantId).toBe(TENANT_A);
  });

  it("18. tenant_id malevolo nel body viene ignorato: history usa il tenant di sessione", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(moveServicesBody({ tenant_id: TENANT_B }));

    const entries = lastHistoryEntries();
    expect(entries[0].tenantId).toBe(TENANT_A);
    expect(entries[0].tenantId).not.toBe(TENANT_B);
  });

  it("19. tenant B non contamina il previous: una riga omonima di TENANT_B viene ignorata dallo snapshot", async () => {
    const fake = baseSeed({
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_SOURCE, driver_user_id: DRIVER_SOURCE, driver_profile_id: PROFILE_SOURCE, vehicle_label: "Van 8" },
        { id: "asg-b", tenant_id: TENANT_B, service_id: SERVICE_1, group_id: "grp-b", driver_user_id: "driver-b", driver_profile_id: "profile-b", vehicle_label: "Van B" },
      ],
    });
    authorizeAs(fake);

    await callPost(moveServicesBody());

    const entries = lastHistoryEntries();
    expect(entries[0].fromDriverProfileId).toBe(PROFILE_SOURCE);
    expect(entries[0].fromDriverProfileId).not.toBe("profile-b");
  });

  it("20. nessun history su 401 (sessione non valida)", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));

    const res = await callPost(moveServicesBody());

    expect(res.status).toBe(401);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("21. nessun history su 403 (ruolo non autorizzato)", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));

    const res = await callPost(moveServicesBody());

    expect(res.status).toBe(403);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("22. nessun history su SEC-02 (target_group_id inesistente/altro tenant)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ target_group_id: "gruppo-inesistente" }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Giro di destinazione non trovato.");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("23. nessun history su SEC-05 (driver cross-tenant)", async () => {
    const fake = baseSeed({
      memberships: [
        membershipRow(DRIVER_SOURCE, TENANT_A),
        membershipRow(DRIVER_TARGET, TENANT_A),
        membershipRow("driver-b", TENANT_B),
      ],
    });
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ target_group_id: undefined, date: TEST_DATE, driver_user_id: "driver-b" }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("DRIVER_NOT_FOUND");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("24. nessun history su FUNC-02 (servizio non operativo)", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1, { status: "cancelled" }), serviceRow(SERVICE_2)],
    });
    authorizeAs(fake);

    const res = await callPost(moveServicesBody());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("SERVICE_NOT_ASSIGNABLE");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("25. nessun history su FUNC-03 (driver destinazione sospeso)", async () => {
    const fake = baseSeed({
      memberships: [
        membershipRow(DRIVER_SOURCE, TENANT_A),
        membershipRow(DRIVER_TARGET, TENANT_A, { suspended: true }),
      ],
    });
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_DIFF_DRIVER }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("DRIVER_NOT_ACTIVE");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("26. nessun history su errore creazione nuovo trip_group (500)", async () => {
    const fake = baseSeed();
    fake.setInsertError("trip_groups", RAW_DB_ERROR);
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ target_group_id: undefined, date: TEST_DATE, driver_user_id: DRIVER_TARGET, driver_profile_id: PROFILE_TARGET }));

    expect(res.status).toBe(500);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("27. nessun history se l'update di assignments fallisce", async () => {
    const fake = baseSeed();
    const originalFrom = fake.admin.from.bind(fake.admin);
    fake.admin.from = ((table: string) => {
      const base = originalFrom(table);
      if (table === "assignments") {
        return {
          ...base,
          update: () => ({
            in() {
              return {
                eq() {
                  return Promise.resolve({ data: null, error: { message: "update failed" } });
                },
              };
            },
          }),
        };
      }
      return base;
    }) as typeof fake.admin.from;
    authorizeAs(fake);

    const res = await callPost(moveServicesBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("28. snapshot previous fallisce: move riuscito ma zero history", async () => {
    const fake = baseSeed();
    // Per questo scenario (target GROUP_TARGET_DIFF_DRIVER, vehicle_label
    // "Van 9" condiviso con GROUP_TARGET_SAME_DRIVER_DIFF_VEHICLE) la route
    // interroga "assignments" 3 volte prima del nuovo snapshot CONC-07:
    // #1 loadGroupServiceIds, #2 validateTripPayload.otherAssignments,
    // #3 validateVehicleTimelinePayload — lo snapshot sotto test e' quindi
    // la #4: errore mirato solo su quest'ultima, per non alterare i guard
    // precedenti.
    fake.setError("assignments", RAW_DB_ERROR, 4);
    authorizeAs(fake);

    const res = await callPost(moveServicesBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("29. logAssignmentChange rigetta: risposta di successo invariata (fire-and-forget)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);
    mocks.logAssignmentChange.mockRejectedValueOnce(new Error("driver_assignment_history insert failed"));

    const res = await callPost(moveServicesBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/driver_assignment_history/);
  });

  it("30. nessuna modifica a push/notifiche: sendPushToUser non toccato da move_services", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(moveServicesBody());

    expect(mocks.sendPushToUser).not.toHaveBeenCalled();
  });

  it("31. risposta HTTP invariata: stessa forma { ok, group_id, warnings }", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(moveServicesBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["group_id", "ok", "warnings"]);
  });

  it("32. create_trip invariato: la modifica a move_services non lo tocca", async () => {
    const fake = baseSeed({
      services: [serviceRow("a5555555-5555-4555-8555-555555555555")],
      trip_groups: [],
      assignments: [],
    });
    authorizeAs(fake);

    const res = await callPost({
      action: "create_trip",
      date: TEST_DATE,
      service_ids: ["a5555555-5555-4555-8555-555555555555"],
      driver_user_id: DRIVER_SOURCE,
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("33. update_trip invariato: la modifica a move_services non lo tocca", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ action: "update_trip", group_id: GROUP_SOURCE, driver_user_id: DRIVER_SOURCE, service_ids: [SERVICE_1] });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("34. swap_driver invariato: la modifica a move_services non lo tocca", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ action: "swap_driver", date: TEST_DATE, from_driver_id: DRIVER_SOURCE, to_driver_id: DRIVER_TARGET });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("35. swap_vehicle invariato: la modifica a move_services non lo tocca", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ action: "swap_vehicle", date: TEST_DATE, from_vehicle_label: "Van 8", to_vehicle_label: "Van 10" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("36. delete_trip invariato: la modifica a move_services non lo tocca", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ action: "delete_trip", group_id: GROUP_SOURCE });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("37. nessun history quando il gruppo destinazione non ha driver e il body non ne fornisce uno (nessun cambio rappresentabile)", async () => {
    const fake = baseSeed({
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: null, driver_user_id: null, driver_profile_id: null, vehicle_label: null },
      ],
    });
    authorizeAs(fake);

    const res = await callPost(moveServicesBody({ target_group_id: GROUP_TARGET_NO_DRIVER, driver_user_id: undefined }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });
});
