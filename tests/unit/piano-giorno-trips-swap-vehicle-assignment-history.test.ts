import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * Test CONC-07 — storico strutturato (driver_assignment_history) sull'action
 * swap_vehicle di piano-giorno/trips.
 *
 * swap_vehicle aggiorna assignments.vehicle_label in blocco per tutti i
 * trip_groups con un dato vehicle_label sorgente in una data, ma non
 * registrava la variazione tramite logAssignmentChange. Il fix riusa
 * esattamente lo stesso contratto già validato in
 * move_services/assign-service/departure-bus-assign/swap_driver: changeType
 * "vehicle_binding", con uno snapshot "prima" tenant-scoped letto subito
 * prima della mutazione bulk. A differenza di swap_driver, questa action non
 * tocca mai il driver: nessun campo driver viene mai valorizzato nell'entry.
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
const SERVICE_3 = "a3333333-3333-4333-8333-333333333333";
const GROUP_1 = "c1111111-1111-4111-8111-111111111111";
const GROUP_2 = "c2222222-2222-4222-8222-222222222222";
const GROUP_INACTIVE = "c3333333-3333-4333-8333-333333333333";
const GROUP_OTHER_DATE = "c4444444-4444-4444-8444-444444444444";
const GROUP_TENANT_B = "c5555555-5555-4555-8555-555555555555";
const DRIVER_1 = "d0000000-0000-4000-8000-000000000000";
const OPERATOR_1 = "u1111111-1111-4111-8111-111111111111";
const VEHICLE_FROM = "Van 8";
const VEHICLE_TO = "Van 9";
const TEST_DATE = "2026-08-10";
const OTHER_DATE = "2026-08-11";

type Row = Record<string, unknown>;

const RAW_DB_ERROR = { message: 'connection to server "internal-db-host.example" failed: SQLSTATE[08006]' };

/**
 * Fake Supabase in-memory, tenant-aware — stesso schema riusato da
 * piano-giorno-trips-swap-driver-assignment-history.test.ts e
 * piano-giorno-trips-move-services-assignment-history.test.ts.
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
  const tableUpdateErrors: Record<string, { message: string } | undefined> = {};

  const calls = {
    tripGroupsUpdates: 0,
    assignmentsUpdates: 0,
  };

  function makeQueryBuilder(table: string, op: "select" | "delete" | "update", updatePayload?: Row) {
    const rows = tables[table];
    let filtered = rows;
    let limitN: number | null = null;
    let thisCallIndex = 0;

    function cloneRow(row: Row): Row {
      if (table !== "assignments") return { ...row };
      return { ...row, services: tables.services.find((s) => s.id === row.service_id) ?? null };
    }

    if (op === "select") {
      selectCallCounts[table] = (selectCallCounts[table] ?? 0) + 1;
      thisCallIndex = selectCallCounts[table];
    }

    function shouldError(): boolean {
      if (!tableErrors[table]) return false;
      const fromCall = tableErrorFromCall[table] ?? 1;
      return op === "select" ? thisCallIndex >= fromCall : true;
    }

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
        // conservato altrove.
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
          const rowsArr = Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow];
          const inserted = rowsArr.map((r) => ({ id: r.id ?? `${table}-${Math.random().toString(36).slice(2)}`, status: "active", ...r }));
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

function baseSeed(overrides: Parameters<typeof createTenantAwareSupabase>[0] = {}) {
  return createTenantAwareSupabase({
    services: [serviceRow(SERVICE_1), serviceRow(SERVICE_2, { time: "14:00:00" })],
    trip_groups: [
      { id: GROUP_1, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: VEHICLE_FROM, status: "active" },
      { id: GROUP_INACTIVE, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: VEHICLE_FROM, status: "cancelled" },
      { id: GROUP_OTHER_DATE, tenant_id: TENANT_A, date: OTHER_DATE, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: VEHICLE_FROM, status: "active" },
      { id: GROUP_TENANT_B, tenant_id: TENANT_B, date: TEST_DATE, driver_user_id: null, driver_profile_id: null, vehicle_label: VEHICLE_FROM, status: "active" },
    ],
    assignments: [
      { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_1, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: VEHICLE_FROM },
    ],
    memberships: [],
    driver_profiles: [],
    vehicles: [],
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

function swapVehicleBody(overrides: Record<string, unknown> = {}) {
  return {
    action: "swap_vehicle",
    date: TEST_DATE,
    from_vehicle_label: VEHICLE_FROM,
    to_vehicle_label: VEHICLE_TO,
    ...overrides,
  };
}

function lastHistoryEntries(): Row[] {
  const calls = mocks.logAssignmentChange.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as Row[];
}

describe("CONC-07 — storico strutturato (driver_assignment_history) su swap_vehicle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extractFeatures.mockReturnValue({ mocked_features: true });
    mocks.logAssignmentChange.mockResolvedValue(undefined);
    mocks.updateLearnedPatterns.mockResolvedValue({ upserted: 0 });
  });

  it("1. swap singolo gruppo: history scritto, changeType vehicle_binding", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(swapVehicleBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].changeType).toBe("vehicle_binding");
    expect(entries[0].serviceId).toBe(SERVICE_1);
  });

  it("2. swap più gruppi: un entry per service_id", async () => {
    const fake = baseSeed({
      trip_groups: [
        { id: GROUP_1, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: VEHICLE_FROM, status: "active" },
        { id: GROUP_2, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: VEHICLE_FROM, status: "active" },
      ],
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_1, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: VEHICLE_FROM },
        { id: "asg-2", tenant_id: TENANT_A, service_id: SERVICE_2, group_id: GROUP_2, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: VEHICLE_FROM },
      ],
    });
    authorizeAs(fake);

    const res = await callPost(swapVehicleBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.serviceId).sort()).toEqual([SERVICE_1, SERVICE_2].sort());
  });

  it("3. più servizi nello stesso gruppo: entry per ciascuno, stesso groupId", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1), serviceRow(SERVICE_2, { time: "14:00:00" }), serviceRow(SERVICE_3, { time: "18:00:00" })],
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_1, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: VEHICLE_FROM },
        { id: "asg-2", tenant_id: TENANT_A, service_id: SERVICE_2, group_id: GROUP_1, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: VEHICLE_FROM },
      ],
    });
    authorizeAs(fake);

    await callPost(swapVehicleBody());

    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.groupId === GROUP_1)).toBe(true);
  });

  it("4. previous vehicle corretto", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(swapVehicleBody());

    const entries = lastHistoryEntries();
    expect(entries[0].fromVehicleLabel).toBe(VEHICLE_FROM);
  });

  it("5. target vehicle corretto", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(swapVehicleBody());

    const entries = lastHistoryEntries();
    expect(entries[0].toVehicleLabel).toBe(VEHICLE_TO);
  });

  it("6. previous null: target valorizzato, evento comunque generato", async () => {
    const fake = baseSeed({
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_1, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: null },
      ],
    });
    authorizeAs(fake);

    await callPost(swapVehicleBody());

    const entries = lastHistoryEntries();
    expect(entries[0].fromVehicleLabel).toBeNull();
    expect(entries[0].toVehicleLabel).toBe(VEHICLE_TO);
  });

  it("7. previous già uguale al target: zero evento (no-op, nessuno swap reale)", async () => {
    const fake = baseSeed({
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_1, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: VEHICLE_TO },
      ],
    });
    authorizeAs(fake);

    const res = await callPost(swapVehicleBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("8. driver invariato: nessun campo driver nell'entry (swap_vehicle non tocca il driver)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(swapVehicleBody());

    const entries = lastHistoryEntries();
    expect(entries[0].fromDriverProfileId).toBeUndefined();
    expect(entries[0].toDriverProfileId).toBeUndefined();
    const updated = fake.tables.assignments.find((a) => a.service_id === SERVICE_1);
    expect(updated?.driver_user_id).toBe(DRIVER_1);
  });

  it("9. groupId corretto nell'entry", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(swapVehicleBody());

    const entries = lastHistoryEntries();
    expect(entries[0].groupId).toBe(GROUP_1);
  });

  it("10. actor corretto: operatorId coincide con l'utente autenticato", async () => {
    const fake = baseSeed();
    authorizeAs(fake, "operator-xyz");

    await callPost(swapVehicleBody());

    const entries = lastHistoryEntries();
    expect(entries[0].operatorId).toBe("operator-xyz");
  });

  it("11. tenant corretto: tenantId coincide con quello della sessione", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(swapVehicleBody());

    const entries = lastHistoryEntries();
    expect(entries[0].tenantId).toBe(TENANT_A);
  });

  it("12. tenant_id malevolo nel body viene ignorato: history usa il tenant di sessione", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(swapVehicleBody({ tenant_id: TENANT_B }));

    const entries = lastHistoryEntries();
    expect(entries[0].tenantId).toBe(TENANT_A);
    expect(entries[0].tenantId).not.toBe(TENANT_B);
  });

  it("13. gruppo di tenant B escluso: nessuna entry lo riguarda", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(swapVehicleBody());

    const entries = lastHistoryEntries();
    expect(entries.every((e) => e.groupId !== GROUP_TENANT_B)).toBe(true);
    const groupB = fake.tables.trip_groups.find((g) => g.id === GROUP_TENANT_B);
    expect(groupB?.vehicle_label).toBe(VEHICLE_FROM);
  });

  it("14. gruppo di altra data escluso: nessuna entry lo riguarda", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(swapVehicleBody());

    const entries = lastHistoryEntries();
    expect(entries.every((e) => e.groupId !== GROUP_OTHER_DATE)).toBe(true);
    const groupOtherDate = fake.tables.trip_groups.find((g) => g.id === GROUP_OTHER_DATE);
    expect(groupOtherDate?.vehicle_label).toBe(VEHICLE_FROM);
  });

  it("15. gruppo non attivo (status cancelled) escluso: nessuna entry lo riguarda", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(swapVehicleBody());

    const entries = lastHistoryEntries();
    expect(entries.every((e) => e.groupId !== GROUP_INACTIVE)).toBe(true);
  });

  it("16. service_ids deduplicati: nessun doppio history per lo stesso servizio", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(swapVehicleBody());

    const entries = lastHistoryEntries();
    const serviceIds = entries.map((e) => e.serviceId);
    expect(new Set(serviceIds).size).toBe(serviceIds.length);
  });

  it("17. nessun gruppo trovato (from_vehicle_label senza giri attivi): comportamento invariato, zero history", async () => {
    const fake = baseSeed({
      trip_groups: [],
      assignments: [],
    });
    authorizeAs(fake);

    const res = await callPost(swapVehicleBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, affected: 0, warnings: [] });
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("18. nessun history su 401 (sessione non valida)", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));

    const res = await callPost(swapVehicleBody());

    expect(res.status).toBe(401);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("19. nessun history su 403 (ruolo non autorizzato)", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));

    const res = await callPost(swapVehicleBody());

    expect(res.status).toBe(403);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("20. nessun history su body invalido (400)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(swapVehicleBody({ to_vehicle_label: undefined }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("21. nessun history su timeline: N/A — swap_vehicle non esegue alcuna validazione timeline/availability (a differenza di create_trip/update_trip/move_services/swap_driver, non chiama validateTripPayload)", () => {
    expect(true).toBe(true);
  });

  it("22. nessun history su errori guard (errore query trip_groups, 500)", async () => {
    const fake = baseSeed();
    fake.setError("trip_groups", RAW_DB_ERROR, 1);
    authorizeAs(fake);

    const res = await callPost(swapVehicleBody());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("23. nessun history se l'update di assignments fallisce", async () => {
    const fake = baseSeed();
    fake.setUpdateError("assignments", { message: "update failed" });
    authorizeAs(fake);

    const res = await callPost(swapVehicleBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("23b. nessun history se l'update di trip_groups fallisce", async () => {
    const fake = baseSeed();
    fake.setUpdateError("trip_groups", { message: "update failed" });
    authorizeAs(fake);

    const res = await callPost(swapVehicleBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("24. snapshot previous fallisce: swap riuscito, zero history", async () => {
    const fake = baseSeed();
    // 1a select assignments: lo snapshot CONC-07 sotto test (nessuna altra
    // select su "assignments" precede lo snapshot in swap_vehicle, a
    // differenza di swap_driver/move_services che passano da
    // validateTripPayload).
    fake.setError("assignments", RAW_DB_ERROR, 1);
    authorizeAs(fake);

    const res = await callPost(swapVehicleBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("25. logAssignmentChange rigetta: risposta di successo invariata (fire-and-forget)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);
    mocks.logAssignmentChange.mockRejectedValueOnce(new Error("driver_assignment_history insert failed"));

    const res = await callPost(swapVehicleBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/driver_assignment_history/);
  });

  it("27. risposta HTTP invariata: stessa forma { ok, affected, warnings }", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(swapVehicleBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["affected", "ok", "warnings"]);
  });

  it("28. create_trip invariata: la modifica a swap_vehicle non lo tocca", async () => {
    const fake = baseSeed({
      services: [serviceRow("a5555555-5555-4555-8555-555555555555")],
      trip_groups: [],
      assignments: [],
      driver_daily_availability: [
        { tenant_id: TENANT_A, driver_user_id: DRIVER_1, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      ],
      memberships: [{ user_id: DRIVER_1, tenant_id: TENANT_A, role: "driver", suspended: false }],
    });
    authorizeAs(fake);

    const res = await callPost({
      action: "create_trip",
      date: TEST_DATE,
      service_ids: ["a5555555-5555-4555-8555-555555555555"],
      driver_user_id: DRIVER_1,
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("29. update_trip invariata: la modifica a swap_vehicle non lo tocca", async () => {
    const fake = baseSeed({
      driver_daily_availability: [
        { tenant_id: TENANT_A, driver_user_id: DRIVER_1, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      ],
      memberships: [{ user_id: DRIVER_1, tenant_id: TENANT_A, role: "driver", suspended: false }],
    });
    authorizeAs(fake);

    const res = await callPost({ action: "update_trip", group_id: GROUP_1, driver_user_id: DRIVER_1, service_ids: [SERVICE_1] });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("30. move_services invariata: la modifica a swap_vehicle non lo tocca", async () => {
    const DRIVER_2 = "d9999999-9999-4999-8999-999999999998";
    const fake = baseSeed({
      trip_groups: [
        { id: GROUP_1, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: VEHICLE_FROM, status: "active" },
        { id: GROUP_2, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_2, driver_profile_id: null, vehicle_label: VEHICLE_TO, status: "active" },
      ],
      driver_daily_availability: [
        { tenant_id: TENANT_A, driver_user_id: DRIVER_1, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
        { tenant_id: TENANT_A, driver_user_id: DRIVER_2, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      ],
      memberships: [
        { user_id: DRIVER_1, tenant_id: TENANT_A, role: "driver", suspended: false },
        { user_id: DRIVER_2, tenant_id: TENANT_A, role: "driver", suspended: false },
      ],
    });
    authorizeAs(fake);

    const res = await callPost({
      action: "move_services",
      service_ids: [SERVICE_1],
      group_id: GROUP_1,
      target_group_id: GROUP_2,
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("31. swap_driver invariata: la modifica a swap_vehicle non lo tocca", async () => {
    const DRIVER_2 = "d9999999-9999-4999-8999-999999999999";
    const fake = baseSeed({
      driver_daily_availability: [
        { tenant_id: TENANT_A, driver_user_id: DRIVER_1, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
        { tenant_id: TENANT_A, driver_user_id: DRIVER_2, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      ],
      memberships: [
        { user_id: DRIVER_1, tenant_id: TENANT_A, role: "driver", suspended: false },
        { user_id: DRIVER_2, tenant_id: TENANT_A, role: "driver", suspended: false },
      ],
    });
    authorizeAs(fake);

    const res = await callPost({ action: "swap_driver", date: TEST_DATE, from_driver_id: DRIVER_1, to_driver_id: DRIVER_2 });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("32. delete_trip invariata: la modifica a swap_vehicle non lo tocca", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ action: "delete_trip", group_id: GROUP_1 });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });
});
