import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_A1 = "a1111111-1111-4111-8111-111111111111";
const SERVICE_A2 = "a2222222-2222-4222-8222-222222222222";
const SERVICE_B1 = "b1111111-1111-4111-8111-111111111111";
const NONEXISTENT_SERVICE = "99999999-9999-4999-8999-999999999999";
const GROUP_A1 = "c1111111-1111-4111-8111-111111111111";
const GROUP_B1 = "c2222222-2222-4222-8222-222222222222";
const NONEXISTENT_GROUP = "c9999999-9999-4999-8999-999999999999";
const DRIVER_A = "d1111111-1111-4111-8111-111111111111";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

/**
 * Fake Supabase in-memory, tenant-aware, che applica realmente i filtri usati
 * da app/api/ops/piano-giorno/trips/route.ts (eq/in/not/neq/limit/select
 * insert/upsert/update/delete/maybeSingle/single). Tabelle condivise tra
 * tenant A e B: una regressione che rimuova un filtro tenant critico fa
 * fallire per davvero i test cross-tenant sotto, non solo un placeholder.
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
    // SEC-05 residuo: DRIVER_A è l'unico driver usato in questo file
    // (concentrato su SEC-02/tenant isolation dei servizi), seedato qui come
    // membership valida del tenant A per non interferire con quegli scenari.
    memberships: seed.memberships ?? [{ tenant_id: TENANT_A, user_id: DRIVER_A, role: "driver" }],
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
    servicesUpdates: 0,
    insertedAssignmentRows: [] as Row[],
    insertedTripGroupRows: [] as Row[],
  };

  function makeQueryBuilder(table: string, op: "select" | "delete" | "update", updatePayload?: Row) {
    const rows = tables[table];
    let filtered = rows;
    let sawTenantFilter = false;

    function resolveScope() {
      if (tenantSensitive.has(table) && !sawTenantFilter) {
        calls.unscopedQueries.push(`${table}.${op}`);
      }
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
        filtered = filtered.slice(0, n);
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
          if (table === "services") calls.servicesUpdates += filtered.length;
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
          if (table === "trip_groups") {
            calls.tripGroupsInserts += inserted.length;
            calls.insertedTripGroupRows.push(...inserted);
          }
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

function baseSeed(overrides: Parameters<typeof createTenantAwareSupabase>[0] = {}) {
  return createTenantAwareSupabase({
    daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
    driver_daily_availability: [
      { tenant_id: TENANT_A, driver_user_id: DRIVER_A, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
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

function authorizeAs(tenantId: string, fake: ReturnType<typeof createTenantAwareSupabase>, role: string = "operator") {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: tenantId, role, suspended: false },
  });
}

describe("Tenant isolation — piano-giorno/trips API (SEC-02)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── CREATE_TRIP ────────────────────────────────────────────────────────────

  it("1. create_trip same-tenant: procede, assignments creati con tenant A", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1)] });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({
      action: "create_trip",
      date: TEST_DATE,
      service_ids: [SERVICE_A1],
      driver_user_id: DRIVER_A,
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.tripGroupsInserts).toBe(1);
    expect(fake.calls.assignmentsUpserts).toBe(1);
    expect(fake.calls.insertedAssignmentRows).toHaveLength(1);
    expect(fake.calls.insertedAssignmentRows[0].tenant_id).toBe(TENANT_A);
    expect(fake.calls.unscopedQueries).toEqual([]);
    expect(mocks.sendPushToUser).toHaveBeenCalledTimes(1);
  });

  it("2. create_trip con service_id di tenant B: 404 generico, zero scritture, zero push", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_B, SERVICE_B1)] });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({
      action: "create_trip",
      date: TEST_DATE,
      service_ids: [SERVICE_B1],
      driver_user_id: DRIVER_A,
    });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Uno o più servizi non trovati." });
    expect(fake.calls.tripGroupsInserts).toBe(0);
    expect(fake.calls.assignmentsUpserts).toBe(0);
    expect(mocks.sendPushToUser).not.toHaveBeenCalled();
  });

  it("3. create_trip con service_id inesistente: stesso 404 generico del caso tenant B", async () => {
    const fakeCrossTenant = baseSeed({ services: [serviceRow(TENANT_B, SERVICE_B1)] });
    authorizeAs(TENANT_A, fakeCrossTenant);
    const resCrossTenant = await callPost({
      action: "create_trip",
      date: TEST_DATE,
      service_ids: [SERVICE_B1],
      driver_user_id: DRIVER_A,
    });

    const fakeNonexistent = baseSeed({ services: [] });
    authorizeAs(TENANT_A, fakeNonexistent);
    const resNonexistent = await callPost({
      action: "create_trip",
      date: TEST_DATE,
      service_ids: [NONEXISTENT_SERVICE],
      driver_user_id: DRIVER_A,
    });

    expect(resCrossTenant.status).toBe(resNonexistent.status);
    expect(await resCrossTenant.json()).toEqual(await resNonexistent.json());
  });

  it("4. create_trip array misto A+B: intera operazione rifiutata, zero scritture", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1), serviceRow(TENANT_B, SERVICE_B1)] });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({
      action: "create_trip",
      date: TEST_DATE,
      service_ids: [SERVICE_A1, SERVICE_B1],
      driver_user_id: DRIVER_A,
    });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Uno o più servizi non trovati." });
    expect(fake.calls.tripGroupsInserts).toBe(0);
    expect(fake.calls.assignmentsUpserts).toBe(0);
  });

  it("5. create_trip con service_ids duplicati same-tenant: deduplicati, nessun falso 404", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1, { pax: 1 })] });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({
      action: "create_trip",
      date: TEST_DATE,
      service_ids: [SERVICE_A1, SERVICE_A1],
      driver_user_id: DRIVER_A,
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // upsert riceve l'array deduplicato: una sola riga per service_id
    expect(fake.calls.insertedAssignmentRows).toHaveLength(1);
  });

  it("6. create_trip: tenant_id malevolo nel body viene ignorato", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1)] });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({
      action: "create_trip",
      date: TEST_DATE,
      service_ids: [SERVICE_A1],
      driver_user_id: DRIVER_A,
      tenant_id: TENANT_B,
    });
    expect(res.status).toBe(200);
    expect(fake.calls.insertedAssignmentRows[0].tenant_id).toBe(TENANT_A);
  });

  it("7. create_trip: errore nella query ownership → fail-closed 500, zero scritture, messaggio non esposto", async () => {
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1)] });
    fake.setError("services", { message: "connection refused: internal db detail" });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({
      action: "create_trip",
      date: TEST_DATE,
      service_ids: [SERVICE_A1],
      driver_user_id: DRIVER_A,
    });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).not.toMatch(/connection refused/i);
    expect(fake.calls.tripGroupsInserts).toBe(0);
    expect(fake.calls.assignmentsUpserts).toBe(0);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "piano_trip_service_ownership_check_failed", level: "error" })
    );
  });

  it("8. create_trip: query push è tenant-scoped (difesa in profondità)", async () => {
    // Tecnica di test: due righe con lo stesso id ma tenant diversi non sono
    // possibili in produzione (id è PK), ma permettono di verificare qui che
    // la query di supporto alla push resta scoped per tenant indipendentemente
    // dal fatto che l'array id sia già stato verificato a monte — la difesa in
    // profondità richiesta esplicitamente dal fix (Fase 5) deve avere un
    // effetto osservabile, non essere solo codice morto.
    const fake = baseSeed({
      services: [
        serviceRow(TENANT_A, SERVICE_A1, { time: "09:00:00", customer_name: "Cliente Tenant A" }),
        serviceRow(TENANT_B, SERVICE_A1, { time: "01:00:00", customer_name: "Cliente Tenant B" }),
      ],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({
      action: "create_trip",
      date: TEST_DATE,
      service_ids: [SERVICE_A1],
      driver_user_id: DRIVER_A,
    });
    expect(res.status).toBe(200);
    expect(fake.calls.unscopedQueries).toEqual([]);
    expect(mocks.sendPushToUser).toHaveBeenCalledTimes(1);
    const pushCallArgs = mocks.sendPushToUser.mock.calls[0];
    expect(pushCallArgs[2].body).not.toContain("Cliente Tenant B");
    expect(pushCallArgs[2].body).toContain("Cliente Tenant A");
  });

  // ─── UPDATE_TRIP ────────────────────────────────────────────────────────────

  it("9. update_trip same-tenant valido: procede, assignments aggiornati", async () => {
    const fake = baseSeed({
      services: [serviceRow(TENANT_A, SERVICE_A1)],
      trip_groups: [{ id: GROUP_A1, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: null, driver_profile_id: null, vehicle_label: null, status: "active" }],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_A1, group_id: GROUP_A1, driver_user_id: null, vehicle_label: null }],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({ action: "update_trip", group_id: GROUP_A1, driver_user_id: DRIVER_A });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.tripGroupsUpdates).toBeGreaterThan(0);
    expect(fake.calls.assignmentsUpdates).toBeGreaterThan(0);
  });

  it("10. update_trip con service_ids contenente un id di tenant B: 404, zero modifiche", async () => {
    const fake = baseSeed({
      services: [serviceRow(TENANT_A, SERVICE_A1), serviceRow(TENANT_B, SERVICE_B1)],
      trip_groups: [{ id: GROUP_A1, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: null, driver_profile_id: null, vehicle_label: null, status: "active" }],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_A1, group_id: GROUP_A1, driver_user_id: null, vehicle_label: null }],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({
      action: "update_trip",
      group_id: GROUP_A1,
      driver_user_id: DRIVER_A,
      service_ids: [SERVICE_B1],
    });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Uno o più servizi non trovati." });
    expect(fake.calls.tripGroupsUpdates).toBe(0);
    expect(fake.calls.assignmentsUpdates).toBe(0);
    expect(fake.calls.assignmentsDeletes).toBe(0);
    expect(fake.calls.assignmentsUpserts).toBe(0);
  });

  it("11. update_trip array misto A+B: zero scritture parziali", async () => {
    const fake = baseSeed({
      services: [serviceRow(TENANT_A, SERVICE_A1), serviceRow(TENANT_A, SERVICE_A2), serviceRow(TENANT_B, SERVICE_B1)],
      trip_groups: [{ id: GROUP_A1, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: null, driver_profile_id: null, vehicle_label: null, status: "active" }],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_A1, group_id: GROUP_A1, driver_user_id: null, vehicle_label: null }],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({
      action: "update_trip",
      group_id: GROUP_A1,
      driver_user_id: DRIVER_A,
      service_ids: [SERVICE_A2, SERVICE_B1],
    });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Uno o più servizi non trovati." });
    expect(fake.calls.tripGroupsUpdates).toBe(0);
    expect(fake.calls.assignmentsUpdates).toBe(0);
    expect(fake.calls.assignmentsUpserts).toBe(0);
    // Il servizio A2 (valido) non viene assegnato da solo: nessun comportamento parziale.
    expect(fake.tables.assignments.some((a) => a.service_id === SERVICE_A2)).toBe(false);
  });

  it("12. update_trip con id inesistente: stessa risposta del caso cross-tenant", async () => {
    const fakeCrossTenant = baseSeed({
      services: [serviceRow(TENANT_A, SERVICE_A1), serviceRow(TENANT_B, SERVICE_B1)],
      trip_groups: [{ id: GROUP_A1, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: null, driver_profile_id: null, vehicle_label: null, status: "active" }],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_A1, group_id: GROUP_A1, driver_user_id: null, vehicle_label: null }],
    });
    authorizeAs(TENANT_A, fakeCrossTenant);
    const resCrossTenant = await callPost({
      action: "update_trip",
      group_id: GROUP_A1,
      driver_user_id: DRIVER_A,
      service_ids: [SERVICE_B1],
    });

    const fakeNonexistent = baseSeed({
      services: [serviceRow(TENANT_A, SERVICE_A1)],
      trip_groups: [{ id: GROUP_A1, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: null, driver_profile_id: null, vehicle_label: null, status: "active" }],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_A1, group_id: GROUP_A1, driver_user_id: null, vehicle_label: null }],
    });
    authorizeAs(TENANT_A, fakeNonexistent);
    const resNonexistent = await callPost({
      action: "update_trip",
      group_id: GROUP_A1,
      driver_user_id: DRIVER_A,
      service_ids: [NONEXISTENT_SERVICE],
    });

    expect(resCrossTenant.status).toBe(resNonexistent.status);
    expect(await resCrossTenant.json()).toEqual(await resNonexistent.json());
  });

  it("13. update_trip: assegnazioni preesistenti same-tenant restano coerenti dopo il fix", async () => {
    const fake = baseSeed({
      services: [serviceRow(TENANT_A, SERVICE_A1)],
      trip_groups: [{ id: GROUP_A1, tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: null, driver_profile_id: null, vehicle_label: null, status: "active" }],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_A1, group_id: GROUP_A1, driver_user_id: null, vehicle_label: null }],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({ action: "update_trip", group_id: GROUP_A1, driver_user_id: DRIVER_A });
    expect(res.status).toBe(200);
    const updated = fake.tables.assignments.find((a) => a.service_id === SERVICE_A1);
    expect(updated?.driver_user_id).toBe(DRIVER_A);
    expect(updated?.tenant_id).toBe(TENANT_A);
  });

  // ─── DELETE_TRIP (regressione — comportamento già sicuro, invariato) ───────

  it("14. delete_trip con group_id di tenant B: 404, zero scritture (comportamento preesistente)", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: GROUP_B1, tenant_id: TENANT_B, date: TEST_DATE, status: "active" }],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({ action: "delete_trip", group_id: GROUP_B1 });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Data giro non trovata." });
    expect(fake.calls.assignmentsDeletes).toBe(0);
    expect(fake.calls.tripGroupsUpdates).toBe(0);
  });

  it("15. delete_trip same-tenant: comportamento invariato", async () => {
    const fake = baseSeed({
      services: [serviceRow(TENANT_A, SERVICE_A1, { status: "assigned" })],
      trip_groups: [{ id: GROUP_A1, tenant_id: TENANT_A, date: TEST_DATE, status: "active" }],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_A1, group_id: GROUP_A1 }],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({ action: "delete_trip", group_id: GROUP_A1 });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.tables.assignments).toHaveLength(0);
    const service = fake.tables.services.find((s) => s.id === SERVICE_A1);
    expect(service?.status).toBe("new");
  });

  // ─── MOVE_SERVICES ──────────────────────────────────────────────────────────

  it("16. move_services con target_group_id di tenant B: 404, zero scritture", async () => {
    const fake = baseSeed({
      services: [serviceRow(TENANT_A, SERVICE_A1, { status: "assigned" })],
      trip_groups: [{ id: GROUP_B1, tenant_id: TENANT_B, date: TEST_DATE, status: "active" }],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_A1, group_id: null }],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({
      action: "move_services",
      service_ids: [SERVICE_A1],
      target_group_id: GROUP_B1,
      date: TEST_DATE,
    });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Giro di destinazione non trovato." });
    expect(fake.calls.assignmentsUpdates).toBe(0);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "piano_trip_target_group_ownership_check_failed" })
    );
  });

  it("17. move_services con target_group_id inesistente: stessa risposta del caso tenant B", async () => {
    const fakeCrossTenant = baseSeed({
      services: [serviceRow(TENANT_A, SERVICE_A1)],
      trip_groups: [{ id: GROUP_B1, tenant_id: TENANT_B, date: TEST_DATE, status: "active" }],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_A1, group_id: null }],
    });
    authorizeAs(TENANT_A, fakeCrossTenant);
    const resCrossTenant = await callPost({
      action: "move_services",
      service_ids: [SERVICE_A1],
      target_group_id: GROUP_B1,
      date: TEST_DATE,
    });

    const fakeNonexistent = baseSeed({
      services: [serviceRow(TENANT_A, SERVICE_A1)],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_A1, group_id: null }],
    });
    authorizeAs(TENANT_A, fakeNonexistent);
    const resNonexistent = await callPost({
      action: "move_services",
      service_ids: [SERVICE_A1],
      target_group_id: NONEXISTENT_GROUP,
      date: TEST_DATE,
    });

    expect(resCrossTenant.status).toBe(resNonexistent.status);
    expect(await resCrossTenant.json()).toEqual(await resNonexistent.json());
  });

  it("18. move_services con service_id di tenant B: nessuna scrittura cross-tenant (comportamento corrente documentato)", async () => {
    const fake = baseSeed({
      services: [serviceRow(TENANT_B, SERVICE_B1)],
      trip_groups: [{ id: GROUP_A1, tenant_id: TENANT_A, date: TEST_DATE, status: "active" }],
      assignments: [{ id: "asg-b", tenant_id: TENANT_B, service_id: SERVICE_B1, group_id: null }],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({
      action: "move_services",
      service_ids: [SERVICE_B1],
      target_group_id: GROUP_A1,
      date: TEST_DATE,
    });
    const body = await res.json();

    // Comportamento documentato: l'UPDATE è filtrato .eq("tenant_id", tenantId),
    // quindi non trova righe (l'assignment reale ha tenant_id=B) e non scrive
    // nulla — successo apparente ma nessuna riga di tenant B viene toccata.
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    const untouched = fake.tables.assignments.find((a) => a.id === "asg-b");
    expect(untouched?.tenant_id).toBe(TENANT_B);
    expect(untouched?.group_id).toBe(null);
  });

  it("19. move_services ramo 'nuovo gruppo' (target_group_id assente): non è rotto dal fix", async () => {
    const fake = baseSeed({
      services: [serviceRow(TENANT_A, SERVICE_A1)],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({
      action: "move_services",
      service_ids: [SERVICE_A1],
      target_group_id: null,
      date: TEST_DATE,
      driver_user_id: DRIVER_A,
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.tripGroupsInserts).toBe(1);
    expect(mocks.auditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "piano_trip_target_group_ownership_check_failed" })
    );
  });

  it("20. move_services verso target group same-tenant: procede come prima", async () => {
    const fake = baseSeed({
      services: [serviceRow(TENANT_A, SERVICE_A1, { status: "assigned" })],
      trip_groups: [{ id: GROUP_A1, tenant_id: TENANT_A, date: TEST_DATE, status: "active", driver_user_id: null, driver_profile_id: null, vehicle_label: null, vehicle_capacity: null }],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_A1, group_id: null }],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({
      action: "move_services",
      service_ids: [SERVICE_A1],
      target_group_id: GROUP_A1,
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    const moved = fake.tables.assignments.find((a) => a.id === "asg-1");
    expect(moved?.group_id).toBe(GROUP_A1);
  });

  // ─── AUTH ───────────────────────────────────────────────────────────────────

  it("21. utente non autenticato: 401, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1)] });

    const res = await callPost({ action: "create_trip", date: TEST_DATE, service_ids: [SERVICE_A1], driver_user_id: DRIVER_A });
    expect(res.status).toBe(401);
    expect(fake.calls.tripGroupsInserts).toBe(0);
    expect(fake.calls.assignmentsUpserts).toBe(0);
  });

  it("22. ruolo non autorizzato: 403, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    const fake = baseSeed({ services: [serviceRow(TENANT_A, SERVICE_A1)] });

    const res = await callPost({ action: "create_trip", date: TEST_DATE, service_ids: [SERVICE_A1], driver_user_id: DRIVER_A });
    expect(res.status).toBe(403);
    expect(fake.calls.tripGroupsInserts).toBe(0);
    expect(fake.calls.assignmentsUpserts).toBe(0);
  });
});
