import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_A1 = "a1111111-1111-4111-8111-111111111111";
const SERVICE_A2 = "a1111111-1111-4111-8111-111111111112";
const SERVICE_B1 = "b1111111-1111-4111-8111-111111111111";
const GROUP_A1 = "c1111111-1111-4111-8111-111111111111";
const DRIVER_A = "d1111111-1111-4111-8111-111111111111";
const DRIVER_B = "d2222222-2222-4222-8222-222222222222";
const PROFILE_A1 = "p1111111-1111-4111-8111-111111111111";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

const RAW_DB_ERROR = { message: 'connection to server "internal-db-host.example" failed: SQLSTATE[08006]' };

/**
 * Fake Supabase in-memory, tenant-aware, generico — stesso schema riusato dai
 * file piano-giorno-trips-service-status-guard.test.ts (create_trip) e
 * piano-giorno-trips-update-driver-tenant-guard.test.ts (update_trip).
 * Combina: fromCallIndex per errori mirati sulla N-esima select sulla stessa
 * tabella (necessario perché su update_trip la query "services" del guard
 * FUNC-02 può essere la 1a o la 2a a seconda che service_ids sia presente nel
 * body, diversamente da create_trip dove è sempre la 2a) + contatori di
 * update su trip_groups/assignments (assenti nel fake di create_trip, dove
 * si scrive con INSERT/UPSERT, non UPDATE).
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
    trip_groups: [{ id: GROUP_A1, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_A, driver_profile_id: null, vehicle_label: null, status: "active" }],
    assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_A1, group_id: GROUP_A1, driver_user_id: DRIVER_A, vehicle_label: null }],
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

const OPERATIONAL_STATUSES = ["new", "assigned", "partito", "caricato", "scaricato", "arrivato", "problema"];
const BLOCKED_STATUSES = ["completato", "cancelled", "needs_review", "pending_cancellation"];

describe("FUNC-02 residuo — guard stato operativo servizi in piano-giorno/trips (update_trip, riuso helper)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const status of OPERATIONAL_STATUSES) {
    it(`1.${status} — stato operativo con service_ids esplicito: successo`, async () => {
      const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status })] });
      authorizeAs(fake);

      const res = await callPost(updateTripBody({ service_ids: [SERVICE_A1] }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(fake.calls.tripGroupsUpdates).toBeGreaterThan(0);
    });
  }

  for (const status of BLOCKED_STATUSES) {
    it(`2.${status} — stato bloccato con service_ids esplicito: 409 SERVICE_NOT_ASSIGNABLE, zero scritture`, async () => {
      const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status })] });
      authorizeAs(fake);

      const res = await callPost(updateTripBody({ service_ids: [SERVICE_A1] }));
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

  it("3. is_draft=true: bloccato indipendentemente dallo status, 409, zero scritture", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "new", is_draft: true })] });
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ service_ids: [SERVICE_A1] }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("SERVICE_NOT_ASSIGNABLE");
    assertZeroWrites(fake);
  });

  it("4. array misto (nuovo insieme): un solo servizio bloccato rifiuta l'intero update, zero scritture", async () => {
    const fake = baseSeed({
      services: [
        serviceRow(TENANT_A, SERVICE_A1, { status: "new" }),
        serviceRow(TENANT_A, SERVICE_A2, { status: "cancelled" }),
      ],
    });
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ service_ids: [SERVICE_A1, SERVICE_A2] }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("SERVICE_NOT_ASSIGNABLE");
    assertZeroWrites(fake);
  });

  it("5. service_ids omesso, il gruppo esistente contiene già un servizio bloccato: 409 — l'update NON diventa una via per bypassare il guard", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "cancelled" })] });
    authorizeAs(fake);

    // Solo cambio driver/mezzo, nessun service_ids nel body: l'insieme finale
    // resta quello già associato al gruppo (SERVICE_A1, cancelled).
    const res = await callPost(updateTripBody({ vehicle_label: "Bus 12" }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("SERVICE_NOT_ASSIGNABLE");
    assertZeroWrites(fake);
  });

  it("6. update solo driver con servizi operativi (service_ids omesso): successo", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "assigned" })] });
    authorizeAs(fake);

    const res = await callPost(updateTripBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("7. update solo mezzo con servizi operativi (service_ids omesso): successo", async () => {
    const fake = baseSeed({
      services: [serviceRow(TENANT_A, SERVICE_A1, { status: "new" })],
      vehicles: [{ id: "veh-1", tenant_id: TENANT_A, label: "Bus 7", capacity: 8, blocked_from: null, blocked_until: null, blocked_reason: null, is_blocked_manual: false }],
    });
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ vehicle_label: "Bus 7" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("8. update parziale non trasforma service_ids omesso in insieme vuoto: guard verifica davvero i servizi esistenti", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "needs_review" })] });
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ notes: "aggiornamento note" }));
    const body = await res.json();

    // Se il codice trattasse erroneamente l'omissione come [], il guard
    // (serviceIds.length===0 → ok:true) passerebbe sempre: qui deve invece
    // bloccare, prova che l'insieme esistente è stato caricato realmente.
    expect(res.status).toBe(409);
    expect(body.error).toBe("SERVICE_NOT_ASSIGNABLE");
  });

  it("9. stesso insieme servizi (rinviato esplicitamente, tutti operativi): successo invariato", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "new" })] });
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ service_ids: [SERVICE_A1] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("10. service_ids con duplicati, tutti operativi: deduplicati, successo", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "new" })] });
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ service_ids: [SERVICE_A1, SERVICE_A1] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("11. update correttivo: nuovo service_ids rimuove esplicitamente il servizio bloccato → successo (non impedisce la correzione)", async () => {
    const fake = baseSeed({
      services: [
        serviceRow(TENANT_A, SERVICE_A1, { status: "cancelled" }),
        serviceRow(TENANT_A, SERVICE_A2, { status: "new" }),
      ],
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_A1, group_id: GROUP_A1, driver_user_id: DRIVER_A, vehicle_label: null },
        { id: "asg-2", tenant_id: TENANT_A, service_id: SERVICE_A2, group_id: GROUP_A1, driver_user_id: DRIVER_A, vehicle_label: null },
      ],
    });
    authorizeAs(fake);

    // Il client invia il nuovo insieme finale senza il servizio cancellato:
    // l'update deve passare, non deve restare bloccato per sempre.
    const res = await callPost(updateTripBody({ service_ids: [SERVICE_A2] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("12. servizio di tenant B nel service_ids: SEC-02 blocca prima, guard di stato mai raggiunto", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1), serviceRow(TENANT_B, SERVICE_B1, { status: "cancelled" })] });
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ service_ids: [SERVICE_B1] }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Uno o più servizi non trovati." });
    // SEC-02 esegue l'unica query su "services" in questo scenario (select "id"): il guard di stato non è mai raggiunto.
    expect(fake.calls.servicesQueried).toBe(1);
  });

  it("13. servizio inesistente nel service_ids: stessa risposta SEC-02 del caso cross-tenant", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1)] });
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ service_ids: ["99999999-9999-4999-8999-999999999999"] }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Uno o più servizi non trovati." });
  });

  it("14. driver cross-tenant: SEC-05 blocca prima del guard di stato, anche con servizio bloccato nell'insieme finale", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "cancelled" })] });
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ driver_user_id: DRIVER_B }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    // SEC-05 non tocca "services": nessuna query eseguita prima del rifiuto.
    expect(fake.calls.servicesQueried).toBe(0);
  });

  it("15. errore DB nella verifica stato (service_ids esplicito, 2a select 'services' dopo SEC-02): 500 fail-closed, zero scritture", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "new" })] });
    fake.setError("services", RAW_DB_ERROR, 2);
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ service_ids: [SERVICE_A1] }));
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

  it("15b. errore DB nella verifica stato (service_ids omesso, 1a e unica select 'services'): 500 fail-closed, zero scritture", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "new" })] });
    fake.setError("services", RAW_DB_ERROR, 1);
    authorizeAs(fake);

    const res = await callPost(updateTripBody());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ ok: false, error: "SERVICE_STATUS_CHECK_FAILED", message: "Errore durante la verifica dello stato dei servizi." });
    assertZeroWrites(fake);
  });

  it("16-17-18-19. zero scritture/history/push su rifiuto: nessun trip_group/assignment update, nessuna history, nessuna push", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "cancelled" })] });
    authorizeAs(fake);

    await callPost(updateTripBody({ service_ids: [SERVICE_A1] }));

    assertZeroWrites(fake);
    expect(mocks.sendPushToUser).not.toHaveBeenCalled();
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("20-21. timeline driver/vehicle invariata: successo end-to-end su servizio operativo", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "new" })] });
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ service_ids: [SERVICE_A1] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  it("22. create_trip invariato: guard su update_trip non tocca create_trip", async () => {
    // trip_groups/assignments vuoti (a differenza di baseSeed): questo test
    // verifica solo che create_trip resti raggiungibile, non l'interazione
    // con il gruppo GROUP_A1 usato altrove in questo file per update_trip.
    const fake = baseSeed({
      services: [serviceRow(TENANT_A, SERVICE_A2, { status: "new" })],
      trip_groups: [],
      assignments: [],
    });
    authorizeAs(fake);

    const res = await callPost({
      action: "create_trip",
      date: TEST_DATE,
      service_ids: [SERVICE_A2],
      driver_user_id: DRIVER_A,
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("23. delete_trip invariata: nessun impatto dal riuso del guard in update_trip", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ action: "delete_trip", group_id: GROUP_A1 });
    expect(res.status).toBe(200);
  });

  it("24. 401: utente non autenticato, guard di stato mai raggiunto", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "cancelled" })] });

    const res = await callPost(updateTripBody({ service_ids: [SERVICE_A1] }));

    expect(res.status).toBe(401);
    expect(fake.calls.servicesQueried).toBe(0);
  });

  it("25. 403: ruolo non autorizzato, guard di stato mai raggiunto", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "cancelled" })] });

    const res = await callPost(updateTripBody({ service_ids: [SERVICE_A1] }));

    expect(res.status).toBe(403);
    expect(fake.calls.servicesQueried).toBe(0);
  });

  it("26. tenant_id malevolo nel body viene ignorato: verifica stato contro il tenant di sessione", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "new" })] });
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ service_ids: [SERVICE_A1], tenant_id: TENANT_B }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("27. sanitizzazione: risposta 409 non contiene id/stato del servizio bloccato", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "cancelled" })] });
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ service_ids: [SERVICE_A1] }));
    const raw = JSON.stringify(await res.json());

    expect(raw).not.toMatch(new RegExp(SERVICE_A1));
    expect(raw).not.toMatch(/cancelled/);
  });
});

describe("FUNC-02 residuo — sensibilità (comportamento atteso col guard integro, update_trip)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("28. sensibilità: servizio bloccato deve essere rifiutato quando il guard è integro", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "cancelled" })] });
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ service_ids: [SERVICE_A1] }));
    expect(res.status).toBe(409);
  });

  it("29. sensibilità: is_draft=true deve essere rifiutato quando il guard è integro", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "new", is_draft: true })] });
    authorizeAs(fake);

    const res = await callPost(updateTripBody({ service_ids: [SERVICE_A1] }));
    expect(res.status).toBe(409);
  });

  it("30. sensibilità: service_ids omesso con gruppo bloccato deve essere rifiutato quando il caricamento dell'insieme esistente è integro", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { status: "needs_review" })] });
    authorizeAs(fake);

    const res = await callPost(updateTripBody());
    expect(res.status).toBe(409);
  });
});
