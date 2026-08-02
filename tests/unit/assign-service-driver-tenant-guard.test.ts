import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_X = "a1111111-1111-4111-8111-111111111111";
const DRIVER_A = "d1111111-1111-4111-8111-111111111111";
const DRIVER_A2 = "d1111111-1111-4111-8111-111111111112";
const DRIVER_B = "d2222222-2222-4222-8222-222222222222";
const DRIVER_GHOST = "d9999999-9999-4999-8999-999999999999";
const PROFILE_A1 = "p1111111-1111-4111-8111-111111111111";
const PROFILE_A2 = "p1111111-1111-4111-8111-111111111112";
const PROFILE_A_UNLINKED = "p1111111-1111-4111-8111-111111111113";
const PROFILE_B1 = "p2222222-2222-4222-8222-222222222222";
const PROFILE_GHOST = "p9999999-9999-4999-8999-999999999999";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

const UNIQUE_VIOLATION_ERROR = { code: "23505", message: 'duplicate key value violates unique constraint "assignments_service_tenant_unique"' };
const RAW_DB_ERROR = { message: 'connection to server "internal-db-host.example" failed: SQLSTATE[08006]' };

/**
 * Fake Supabase in-memory, tenant-aware, per il guard SEC-05 (driver ownership)
 * in assign-service. Applica realmente eq/in/not/maybeSingle/select su tabelle
 * condivise (services, memberships, driver_profiles, assignments, trip_groups,
 * daily_availability_confirmations, status_events), con errori forzabili per
 * tabella per testare il fail-closed.
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
  };

  const tableErrors: Record<string, { message: string } | null> = {};
  let forcedAssignmentInsertError: { code: string; message: string } | null = null;

  const calls = {
    membershipsQueried: 0,
    driverProfilesQueried: 0,
    assignmentsInserted: [] as Row[],
    assignmentsUpdated: 0,
    assignmentsDeleted: 0,
    tripGroupsInserted: [] as Row[],
    tripGroupsUpdated: 0,
    tripGroupsDeleted: 0,
    servicesUpdated: 0,
    statusEventsUpserted: 0,
  };

  function augmentAssignmentRow(row: Row): Row {
    return { ...row, services: tables.services.find((s) => s.id === row.service_id) ?? null };
  }

  function makeSelectBuilder(table: string) {
    let filtered = tables[table];
    if (table === "memberships") calls.membershipsQueried++;
    if (table === "driver_profiles") calls.driverProfilesQueried++;
    const augment = table === "assignments" ? augmentAssignmentRow : undefined;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] === value);
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
            if (toRemove.has(rows[i])) {
              if (table === "assignments") calls.assignmentsDeleted++;
              if (table === "trip_groups") calls.tripGroupsDeleted++;
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
            const inserted = { id: `grp-${tables.trip_groups.length + 1}`, ...row };
            tables.trip_groups.push(inserted);
            calls.tripGroupsInserted.push(inserted);
            return {
              select() {
                return { single: () => Promise.resolve({ data: inserted, error: null }) };
              },
            };
          }
          if (table === "assignments") {
            if (forcedAssignmentInsertError) {
              return Promise.resolve({ data: null, error: forcedAssignmentInsertError });
            }
            const key = `${row.service_id}:${row.tenant_id}`;
            const conflict = tables.assignments.some((a) => `${a.service_id}:${a.tenant_id}` === key);
            if (conflict) return Promise.resolve({ data: null, error: UNIQUE_VIOLATION_ERROR });
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
    forceAssignmentInsertError(err: { code: string; message: string } | null) {
      forcedAssignmentInsertError = err;
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
    time: "10:00:00",
    pickup_hotel: null,
    direction: "departure",
    hotel_id: null,
    meeting_point: null,
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
    services: [serviceRow(SERVICE_X)],
    daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
    memberships: [membershipRow(DRIVER_A, TENANT_A), membershipRow(DRIVER_A2, TENANT_A), membershipRow(DRIVER_B, TENANT_B)],
    driver_profiles: [
      driverProfileRow(PROFILE_A1, TENANT_A, DRIVER_A),
      driverProfileRow(PROFILE_A2, TENANT_A, DRIVER_A2),
      driverProfileRow(PROFILE_A_UNLINKED, TENANT_A, null),
      driverProfileRow(PROFILE_B1, TENANT_B, DRIVER_B),
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

describe("SEC-05 — driver tenant ownership guard in assign-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. driver_user_id same-tenant: assegnazione valida, comportamento invariato", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.assignmentsInserted).toHaveLength(1);
    expect(fake.calls.assignmentsInserted[0].driver_user_id).toBe(DRIVER_A);
  });

  it("2. driver_user_id di tenant B: 404 DRIVER_NOT_FOUND, zero scritture", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_B, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    expect(fake.calls.assignmentsInserted).toHaveLength(0);
    expect(fake.calls.tripGroupsInserted).toHaveLength(0);
  });

  it("3. driver_user_id inesistente: stessa risposta del tenant B", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_GHOST, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    expect(fake.calls.assignmentsInserted).toHaveLength(0);
  });

  it("4. driver_profile_id same-tenant: assegnazione valida", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_profile_id: PROFILE_A1, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.assignmentsInserted[0].driver_profile_id).toBe(PROFILE_A1);
  });

  it("5. driver_profile_id di tenant B: 404, zero scritture", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_profile_id: PROFILE_B1, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    expect(fake.calls.assignmentsInserted).toHaveLength(0);
  });

  it("6. driver_profile_id inesistente: stessa risposta del cross-tenant", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_profile_id: PROFILE_GHOST, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    expect(fake.calls.assignmentsInserted).toHaveLength(0);
  });

  it("7. user + profile coerenti same-tenant: successo", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, driver_profile_id: PROFILE_A1, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.assignmentsInserted[0]).toMatchObject({ driver_user_id: DRIVER_A, driver_profile_id: PROFILE_A1 });
  });

  it("8. user same-tenant + profile tenant B: 404, zero scritture", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, driver_profile_id: PROFILE_B1, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    expect(fake.calls.assignmentsInserted).toHaveLength(0);
  });

  it("9. user tenant B + profile same-tenant: 404, zero scritture", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_B, driver_profile_id: PROFILE_A1, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    expect(fake.calls.assignmentsInserted).toHaveLength(0);
  });

  it("10. user/profile entrambi same-tenant ma non collegati: 404, zero scritture", async () => {
    // DRIVER_A2 e PROFILE_A1 sono entrambi del tenant A, ma PROFILE_A1.user_id = DRIVER_A, non DRIVER_A2.
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A2, driver_profile_id: PROFILE_A1, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    expect(fake.calls.assignmentsInserted).toHaveLength(0);
  });

  it("11. driver_profile.user_id null: profilo valido non collegato, nessun legame inventato, successo", async () => {
    // PROFILE_A_UNLINKED ha user_id null: nessuna incoerenza da verificare, entrambi gli id sono
    // individualmente validi per il tenant, la coppia deve passare.
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, driver_profile_id: PROFILE_A_UNLINKED, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("12. nessun driver indicato: comportamento corrente invariato", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.assignmentsInserted[0]).toMatchObject({ driver_user_id: null, driver_profile_id: null });
    expect(fake.calls.membershipsQueried).toBe(0);
    expect(fake.calls.driverProfilesQueried).toBe(0);
  });

  it("13. tenant_id malevolo nel body viene ignorato: ownership contro il tenant della sessione", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1", tenant_id: TENANT_B });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.assignmentsInserted[0].tenant_id).toBe(TENANT_A);
  });

  it("14. errore nella query memberships: 500 fail-closed, zero scritture, messaggio DB non esposto", async () => {
    const fake = baseSeed();
    fake.setTableError("memberships", RAW_DB_ERROR);
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ ok: false, error: "DRIVER_VERIFICATION_FAILED", message: "Errore durante la verifica dell'autista." });
    expect(fake.calls.assignmentsInserted).toHaveLength(0);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "assign_service_driver_verification_failed", level: "error" })
    );
  });

  it("15. errore nella query driver_profiles: 500 fail-closed, zero scritture", async () => {
    const fake = baseSeed();
    fake.setTableError("driver_profiles", RAW_DB_ERROR);
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_profile_id: PROFILE_A1, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ ok: false, error: "DRIVER_VERIFICATION_FAILED", message: "Errore durante la verifica dell'autista." });
    expect(fake.calls.assignmentsInserted).toHaveLength(0);
  });

  it("16. ramo nuova assegnazione invariato: crea trip_group e assignment", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });
    await res.json();

    expect(fake.calls.tripGroupsInserted).toHaveLength(1);
    expect(fake.calls.assignmentsInserted).toHaveLength(1);
    expect(fake.calls.servicesUpdated).toBe(1);
    expect(fake.calls.statusEventsUpserted).toBe(1);
  });

  it("17. ramo update assegnazione esistente invariato", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: "grp-existing", tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_A, vehicle_label: "Bus old" }],
      assignments: [{ id: "asg-existing", tenant_id: TENANT_A, service_id: SERVICE_X, driver_user_id: DRIVER_A, group_id: "grp-existing", vehicle_label: "Bus old" }],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A2, vehicle_label: "Bus new" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.tripGroupsUpdated).toBe(1);
    expect(fake.calls.assignmentsUpdated).toBe(1);
    expect(fake.calls.tripGroupsInserted).toHaveLength(0);
    expect(fake.calls.assignmentsInserted).toHaveLength(0);
    const updated = fake.tables.assignments.find((a) => a.id === "asg-existing");
    expect(updated?.driver_user_id).toBe(DRIVER_A2);
  });

  it("18. action remove invariata: guard SEC-05 non si applica", async () => {
    const fake = baseSeed({
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_X, driver_user_id: DRIVER_A, group_id: null, vehicle_label: "Bus 1" }],
    });
    authorizeAs(fake);

    // driver_user_id di tenant B nel body: irrilevante per "remove", non deve bloccare nulla.
    const res = await callPost({ service_id: SERVICE_X, action: "remove", driver_user_id: DRIVER_B });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.assignmentsDeleted).toBe(1);
    expect(fake.calls.membershipsQueried).toBe(0);
    expect(fake.calls.driverProfilesQueried).toBe(0);
  });

  it("19. CONC-01 invariato: 23505 continua a produrre 409, cleanup tentato", async () => {
    const fake = baseSeed();
    fake.forceAssignmentInsertError(UNIQUE_VIOLATION_ERROR);
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      ok: false,
      error: "SERVICE_ALREADY_ASSIGNED",
      message: "Il servizio è già stato assegnato da un altro operatore. Ricarica la pagina.",
    });
    expect(fake.calls.tripGroupsDeleted).toBe(1);
  });

  it("20. utente non autenticato: 401, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const fake = baseSeed();

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A });

    expect(res.status).toBe(401);
    expect(fake.calls.membershipsQueried).toBe(0);
    expect(fake.calls.assignmentsInserted).toHaveLength(0);
  });

  it("21. ruolo non autorizzato: 403, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    const fake = baseSeed();

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A });

    expect(res.status).toBe(403);
    expect(fake.calls.membershipsQueried).toBe(0);
  });

  it("24. privacy: nessuna risposta contiene tenant B, SQLSTATE, query o dettagli Supabase", async () => {
    const fakeCrossTenant = baseSeed();
    authorizeAs(fakeCrossTenant);
    const resCrossTenant = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_B });
    const rawCrossTenant = JSON.stringify(await resCrossTenant.json());

    expect(rawCrossTenant).not.toMatch(new RegExp(TENANT_B));
    expect(rawCrossTenant.toLowerCase()).not.toMatch(/sqlstate|stack|supabase|postgres/);

    const fakeDbError = baseSeed();
    fakeDbError.setTableError("memberships", RAW_DB_ERROR);
    authorizeAs(fakeDbError);
    const resDbError = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A });
    const rawDbError = JSON.stringify(await resDbError.json());

    expect(rawDbError).not.toMatch(/internal-db-host/);
    expect(rawDbError.toLowerCase()).not.toMatch(/sqlstate/);
  });
});
