import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_X = "a1111111-1111-4111-8111-111111111111";
const SERVICE_OTHER = "a1111111-1111-4111-8111-111111111112";
const SERVICE_OTHER_TENANT_B = "a1111111-1111-4111-8111-111111111113";
const DRIVER_A = "d1111111-1111-4111-8111-111111111111";
const DRIVER_B = "d2222222-2222-4222-8222-222222222222";
const PROFILE_A = "p1111111-1111-4111-8111-111111111111";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

const RAW_DB_ERROR = { message: 'connection to server "internal-db-host.example" failed: SQLSTATE[08006]' };

/**
 * Fake Supabase in-memory, tenant-aware, dedicato ai test CONC-02 (overlap
 * autista) su assign-service. Stesso schema del fake usato per CONC-03
 * (assign-service-vehicle-overlap.test.ts): applica realmente eq/neq/in/
 * maybeSingle sulle tabelle coinvolte. Non definisce vehicle_time_blocks.
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

  const calls = {
    tripGroupsQueried: 0,
    assignmentsQueried: 0,
    assignmentsInserted: [] as Row[],
    assignmentsUpdated: 0,
    servicesUpdated: 0,
    statusEventsUpserted: 0,
  };

  function augmentAssignmentRow(row: Row): Row {
    return { ...row, services: tables.services.find((s) => s.id === row.service_id) ?? null };
  }

  function makeSelectBuilder(table: string) {
    if (!(table in tables)) throw new Error(`[fake supabase] tabella non definita: ${table}`);
    let filtered = tables[table];
    if (table === "trip_groups") calls.tripGroupsQueried++;
    if (table === "assignments") calls.assignmentsQueried++;
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
            if (toRemove.has(rows[i])) rows.splice(i, 1);
          }
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        for (const row of filtered) Object.assign(row, payload);
        if (table === "assignments") calls.assignmentsUpdated += filtered.length;
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
            return {
              select() {
                return { single: () => Promise.resolve({ data: inserted, error: null }) };
              },
            };
          }
          if (table === "assignments") {
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
    memberships: [{ tenant_id: TENANT_A, user_id: DRIVER_A, role: "driver", suspended: false }],
    driver_profiles: [{ id: PROFILE_A, tenant_id: TENANT_A, user_id: null, active: true }],
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

describe("CONC-02 — driver overlap guard in assign-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. autista libero: assegnazione riuscita, 200", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.assignmentsInserted).toHaveLength(1);
  });

  it("2. overlap reale stesso tenant/autista/orario (driver_user_id): 409 DRIVER_OVERLAP (sensibile alla rimozione del guard)", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: "grp-other", tenant_id: TENANT_A, date: TEST_DATE, status: "active", driver_user_id: DRIVER_A }],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: SERVICE_OTHER, group_id: "grp-other", driver_user_id: DRIVER_A }],
      services: [serviceRow(SERVICE_X), serviceRow(SERVICE_OTHER, { time: "10:00:00" })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      ok: false,
      error: "DRIVER_OVERLAP",
      message: "L'autista è già impegnato in un altro servizio nello stesso orario.",
    });
  });

  it("3. zero scritture su overlap rilevato", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: "grp-other", tenant_id: TENANT_A, date: TEST_DATE, status: "active", driver_user_id: DRIVER_A }],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: SERVICE_OTHER, group_id: "grp-other", driver_user_id: DRIVER_A }],
      services: [serviceRow(SERVICE_X), serviceRow(SERVICE_OTHER, { time: "10:00:00" })],
    });
    authorizeAs(fake);

    await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A });

    expect(fake.calls.assignmentsInserted).toHaveLength(0);
    expect(fake.calls.assignmentsUpdated).toBe(0);
    expect(fake.calls.servicesUpdated).toBe(0);
    expect(fake.calls.statusEventsUpserted).toBe(0);
  });

  it("4. stesso driver_user_id impegnato nel tenant B: nessun blocco (sensibile alla rimozione del filtro tenant)", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: "grp-tenantB", tenant_id: TENANT_B, date: TEST_DATE, status: "active", driver_user_id: DRIVER_A }],
      assignments: [{ id: "asg-tenantB", tenant_id: TENANT_B, service_id: SERVICE_OTHER_TENANT_B, group_id: "grp-tenantB", driver_user_id: DRIVER_A }],
      services: [serviceRow(SERVICE_X), serviceRow(SERVICE_OTHER_TENANT_B, { tenant_id: TENANT_B, time: "10:00:00" })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("4b. gruppo del tenant corretto ma assignment con tenant_id anomalo (altro tenant): non deve contare come overlap (sensibile alla rimozione del filtro tenant sulla query assignments)", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: "grp-mixed", tenant_id: TENANT_A, date: TEST_DATE, status: "active", driver_user_id: DRIVER_A }],
      assignments: [{ id: "asg-mixed", tenant_id: TENANT_B, service_id: SERVICE_OTHER_TENANT_B, group_id: "grp-mixed", driver_user_id: DRIVER_A }],
      services: [serviceRow(SERVICE_X), serviceRow(SERVICE_OTHER_TENANT_B, { tenant_id: TENANT_B, time: "10:00:00" })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("5. servizio corrente escluso dal confronto (assignment residuo per lo stesso service_id in altro gruppo)", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: "grp-stray", tenant_id: TENANT_A, date: TEST_DATE, status: "active", driver_user_id: DRIVER_A }],
      assignments: [{ id: "asg-stray", tenant_id: TENANT_A, service_id: SERVICE_X, group_id: "grp-stray", driver_user_id: DRIVER_A }],
      services: [serviceRow(SERVICE_X, { time: "10:00:00" })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("6. update della stessa assegnazione (stesso gruppo riusato): nessun falso conflitto", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: "grp-existing", tenant_id: TENANT_A, date: TEST_DATE, status: "active", driver_user_id: DRIVER_A }],
      assignments: [{ id: "asg-existing", tenant_id: TENANT_A, service_id: SERVICE_X, group_id: "grp-existing", driver_user_id: DRIVER_A }],
      services: [serviceRow(SERVICE_X, { time: "10:00:00" })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.assignmentsUpdated).toBe(1);
  });

  it("7. nessun driver_user_id/driver_profile_id: comportamento invariato, nessuna query overlap", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.tripGroupsQueried).toBe(0);
  });

  it("8. errore query trip_groups: 500 DRIVER_OVERLAP_CHECK_FAILED, fail-closed, zero scritture", async () => {
    const fake = baseSeed();
    fake.setTableError("trip_groups", RAW_DB_ERROR);
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({
      ok: false,
      error: "DRIVER_OVERLAP_CHECK_FAILED",
      message: "Errore durante la verifica della disponibilità dell'autista.",
    });
    expect(fake.calls.assignmentsInserted).toHaveLength(0);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "assign_service_driver_overlap_check_failed", level: "error" })
    );
  });

  it("8b. errore query assignments (secondo stadio): 500 DRIVER_OVERLAP_CHECK_FAILED", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: "grp-other", tenant_id: TENANT_A, date: TEST_DATE, status: "active", driver_user_id: DRIVER_A }],
    });
    fake.setTableError("assignments", RAW_DB_ERROR);
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("DRIVER_OVERLAP_CHECK_FAILED");
  });

  it("9. risposta 409 sanificata: nessun service_id/tenant/dettaglio DB esposto", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: "grp-other", tenant_id: TENANT_A, date: TEST_DATE, status: "active", driver_user_id: DRIVER_A }],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: SERVICE_OTHER, group_id: "grp-other", driver_user_id: DRIVER_A }],
      services: [serviceRow(SERVICE_X), serviceRow(SERVICE_OTHER, { time: "10:00:00" })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A });
    const raw = JSON.stringify(await res.json());

    expect(raw).not.toMatch(new RegExp(SERVICE_OTHER));
    expect(raw).not.toMatch(new RegExp(TENANT_A));
    expect(raw.toLowerCase()).not.toMatch(/sqlstate|stack|supabase|postgres/);
  });

  it("10. CONC-01 invariato: assegnazione senza group_id viene sostituita correttamente su autista libero", async () => {
    const fake = baseSeed({
      assignments: [{ id: "asg-conflict", tenant_id: TENANT_A, service_id: SERVICE_X, group_id: null, driver_user_id: null, vehicle_label: "" }],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("11. SEC-05 invariato: driver di tenant B produce ancora 404 prima del controllo overlap", async () => {
    const fake = baseSeed({
      memberships: [{ user_id: DRIVER_B, tenant_id: TENANT_B, role: "driver" }],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_B });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    expect(fake.calls.tripGroupsQueried).toBe(0);
  });

  it("12a. confine temporale: il candidato inizia esattamente quando l'altro termina → nessun overlap, 200", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: "grp-other", tenant_id: TENANT_A, date: TEST_DATE, status: "active", driver_user_id: DRIVER_A }],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: SERVICE_OTHER, group_id: "grp-other", driver_user_id: DRIVER_A }],
      services: [serviceRow(SERVICE_X, { time: "10:30:00" }), serviceRow(SERVICE_OTHER, { time: "10:00:00" })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A });
    expect(res.status).toBe(200);
  });

  it("12b. sovrapposizione parziale: 409", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: "grp-other", tenant_id: TENANT_A, date: TEST_DATE, status: "active", driver_user_id: DRIVER_A }],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: SERVICE_OTHER, group_id: "grp-other", driver_user_id: DRIVER_A }],
      services: [serviceRow(SERVICE_X, { time: "10:15:00" }), serviceRow(SERVICE_OTHER, { time: "10:00:00" })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A });
    expect(res.status).toBe(409);
  });

  it("13. overlap con driver_profile_id (non solo driver_user_id): 409", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: "grp-other", tenant_id: TENANT_A, date: TEST_DATE, status: "active", driver_profile_id: PROFILE_A }],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: SERVICE_OTHER, group_id: "grp-other", driver_profile_id: PROFILE_A }],
      services: [serviceRow(SERVICE_X), serviceRow(SERVICE_OTHER, { time: "10:00:00" })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_profile_id: PROFILE_A });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("DRIVER_OVERLAP");
  });

  it("14. CONC-03 invariato: overlap mezzo continua a produrre 409 VEHICLE_OVERLAP indipendentemente da CONC-02", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: "grp-other", tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: "Bus 1" }],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: SERVICE_OTHER, group_id: "grp-other", vehicle_label: "Bus 1" }],
      services: [serviceRow(SERVICE_X), serviceRow(SERVICE_OTHER, { time: "10:00:00" })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("VEHICLE_OVERLAP");
  });

  it("15. action remove invariata: nessuna interrogazione del guard overlap autista", async () => {
    const fake = baseSeed({
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_X, group_id: null, driver_user_id: DRIVER_A }],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, action: "remove" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.tripGroupsQueried).toBe(0);
  });

  it("16. 401: zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const fake = baseSeed();

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A });

    expect(res.status).toBe(401);
    expect(fake.calls.tripGroupsQueried).toBe(0);
  });

  it("17. 403: zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    const fake = baseSeed();

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A });

    expect(res.status).toBe(403);
    expect(fake.calls.tripGroupsQueried).toBe(0);
  });
});
