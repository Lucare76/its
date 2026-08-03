import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_X1 = "a1111111-1111-4111-8111-111111111111";
const SERVICE_X2 = "a2222222-2222-4222-8222-222222222222";
const SERVICE_B1 = "b1111111-1111-4111-8111-111111111111";
const DRIVER_A = "d1111111-1111-4111-8111-111111111111";
const DRIVER_B = "d2222222-2222-4222-8222-222222222222";
const DRIVER_GHOST = "d9999999-9999-4999-8999-999999999999";
const NON_DRIVER_A = "d3333333-3333-4333-8333-333333333333";
const DATE_1 = "2026-08-10";

type Row = Record<string, unknown>;

const RAW_DB_ERROR = { message: 'connection to server "internal-db-host.example" failed: SQLSTATE[08006]' };

/**
 * Fake Supabase in-memory, tenant-aware, dedicato al guard SEC-05 residuo
 * (driver ownership) in departure-bus-assign. Applica realmente eq/in/not/
 * maybeSingle sulle tabelle coinvolte (services, memberships, assignments,
 * daily_availability_confirmations), cosi i test cross-tenant/ruolo-non-driver
 * osservano un vero 404, non un placeholder — e i due esperimenti di
 * sensibilità (FASE 8) possono davvero far fallire i test rimuovendo un filtro.
 */
function createTenantAwareSupabase(
  seed: Partial<Record<"services" | "memberships" | "assignments" | "daily_availability_confirmations" | "driver_profiles", Row[]>> = {}
) {
  const tables: Record<string, Row[]> = {
    services: [...(seed.services ?? [])],
    memberships: [...(seed.memberships ?? [])],
    assignments: [...(seed.assignments ?? [])],
    daily_availability_confirmations: [...(seed.daily_availability_confirmations ?? [])],
    // Usata solo dal ramo invariato create_driver_account (test 14), non dal
    // guard SEC-05 residuo: vuota di default, un profilo inesistente deve
    // produrre il 404 esistente di quel ramo, non un errore di fake.
    driver_profiles: [...(seed.driver_profiles ?? [])],
  };

  const tableErrors: Record<string, { message: string } | null> = {};

  const calls = {
    membershipsQueried: 0,
    assignmentsUpsertCalls: 0,
    assignmentsDeleteCalls: 0,
    upsertedRows: [] as Row[],
  };

  function augmentAssignmentRow(row: Row): Row {
    return { ...row, services: tables.services.find((s) => s.id === row.service_id) ?? null };
  }

  function makeSelectBuilder(table: string) {
    if (!(table in tables)) throw new Error(`[fake supabase] tabella non definita: ${table}`);
    let filtered = tables[table];
    if (table === "memberships") calls.membershipsQueried++;
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

  function makeDeleteBuilder(table: string) {
    const rows = tables[table];
    let filtered = rows;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] === value);
        return builder;
      },
      in(field: string, values: unknown[]) {
        filtered = filtered.filter((r) => values.includes(r[field]));
        return builder;
      },
      then(resolve: (v: { data: null; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        if (table === "assignments") calls.assignmentsDeleteCalls++;
        const toRemove = new Set(filtered);
        for (let i = rows.length - 1; i >= 0; i--) {
          if (toRemove.has(rows[i])) rows.splice(i, 1);
        }
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
          return makeDeleteBuilder(table);
        },
        upsert(rows: Row[], _options?: { onConflict?: string; ignoreDuplicates?: boolean }) {
          return {
            then(resolve: (v: { data: null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
              const err = tableErrors["assignments_upsert"] ?? null;
              if (err) return Promise.resolve({ data: null, error: err }).then(resolve, reject);
              calls.assignmentsUpsertCalls++;
              for (const row of rows) {
                calls.upsertedRows.push(row);
                const idx = tables.assignments.findIndex((a) => a.service_id === row.service_id && a.tenant_id === row.tenant_id);
                if (idx >= 0) tables.assignments[idx] = { ...tables.assignments[idx], ...row };
                else tables.assignments.push({ id: `asg-${tables.assignments.length + 1}`, ...row });
              }
              return Promise.resolve({ data: null, error: null }).then(resolve, reject);
            },
          };
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
    setUpsertError(err: { message: string } | null) {
      tableErrors["assignments_upsert"] = err;
    },
  };
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  auditLog: vi.fn(),
  sendPushToUser: vi.fn(),
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

import { POST } from "@/app/api/ops/departure-bus-assign/route";

function serviceRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT_A,
    date: DATE_1,
    time: "10:00:00",
    pickup_hotel: null,
    direction: "departure",
    hotel_id: null,
    meeting_point: null,
    ...overrides,
  };
}

function confirmedDate(date: string, tenantId: string = TENANT_A): Row {
  return { tenant_id: tenantId, date, confirmed: true };
}

function baseSeed(overrides: Parameters<typeof createTenantAwareSupabase>[0] = {}) {
  return createTenantAwareSupabase({
    services: [serviceRow(SERVICE_X1), serviceRow(SERVICE_X2)],
    daily_availability_confirmations: [confirmedDate(DATE_1)],
    memberships: [
      { tenant_id: TENANT_A, user_id: DRIVER_A, role: "driver" },
      { tenant_id: TENANT_B, user_id: DRIVER_B, role: "driver" },
      { tenant_id: TENANT_A, user_id: NON_DRIVER_A, role: "operator" },
    ],
    ...overrides,
  });
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/ops/departure-bus-assign", {
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

function assignBody(overrides: Record<string, unknown> = {}) {
  return {
    action: "assign_driver",
    service_ids: [SERVICE_X1, SERVICE_X2],
    driver_user_id: DRIVER_A,
    vehicle_label: "DEP_BUS:1",
    ...overrides,
  };
}

describe("SEC-05 residuo — driver tenant ownership guard in departure-bus-assign", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. driver same-tenant: successo, upsert eseguito", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.assignmentsUpsertCalls).toBe(1);
    expect(fake.tables.assignments).toHaveLength(2);
  });

  it("2. driver di tenant B: 404 DRIVER_NOT_FOUND, zero scritture (sensibile alla rimozione del filtro tenant)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(assignBody({ driver_user_id: DRIVER_B }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
    expect(fake.calls.assignmentsDeleteCalls).toBe(0);
  });

  it("3. driver inesistente: stesso status/body del tenant B", async () => {
    const fakeGhost = baseSeed();
    authorizeAs(fakeGhost);
    const resGhost = await callPost(assignBody({ driver_user_id: DRIVER_GHOST }));

    const fakeTenantB = baseSeed();
    authorizeAs(fakeTenantB);
    const resTenantB = await callPost(assignBody({ driver_user_id: DRIVER_B }));

    expect(resGhost.status).toBe(resTenantB.status);
    expect(await resGhost.json()).toEqual(await resTenantB.json());
    expect(resGhost.status).toBe(404);
  });

  it("4. utente same-tenant con ruolo diverso da driver: 404, zero scritture (sensibile alla rimozione del filtro role)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(assignBody({ driver_user_id: NON_DRIVER_A }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
  });

  it("5. tenant_id malevolo nel body viene ignorato: ownership driver contro il tenant della sessione", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(assignBody({ tenant_id: TENANT_B }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.upsertedRows[0].tenant_id).toBe(TENANT_A);
  });

  it("6. errore nella query memberships: 500 fail-closed, zero scritture, risposta sanificata, audit log invocato", async () => {
    const fake = baseSeed();
    fake.setTableError("memberships", RAW_DB_ERROR);
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({
      ok: false,
      error: "DRIVER_VERIFICATION_FAILED",
      message: "Errore durante la verifica dell'autista.",
    });
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "departure_bus_assign_driver_verification_failed", level: "error" })
    );
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/internal-db-host/);
    expect(raw.toLowerCase()).not.toMatch(/sqlstate/);
  });

  it("7. driver_user_id assente: comportamento corrente invariato (400 body validation, non 404 driver)", async () => {
    // assign_driver richiede driver_user_id a monte (body validation), quindi
    // il guard non può essere raggiunto con il campo assente in questa route:
    // verifichiamo che resti il 400 esistente, non un nuovo comportamento.
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ action: "assign_driver", service_ids: [SERVICE_X1], vehicle_label: "DEP_BUS:1" });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ ok: false, error: "service_ids, driver_user_id e vehicle_label richiesti" });
    expect(fake.calls.membershipsQueried).toBe(0);
  });

  it("8. SEC-01 invariato: service_id di tenant B blocca prima del driver guard", async () => {
    const fake = baseSeed({
      services: [{ id: SERVICE_B1, tenant_id: TENANT_B, date: DATE_1, time: "10:00:00", pickup_hotel: null, direction: "departure", hotel_id: null, meeting_point: null }],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_B1] }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Uno o più servizi non trovati." });
    // Il guard driver non deve nemmeno essere raggiunto: SEC-01 blocca prima.
    expect(fake.calls.membershipsQueried).toBe(0);
  });

  it("9. FUNC-01 disponibilità invariato: nessuna conferma giornaliera continua a bloccare con 409", async () => {
    const fake = baseSeed({ daily_availability_confirmations: [] });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("DAILY_AVAILABILITY_NOT_CONFIRMED");
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
    // Il guard driver deve essere già passato con successo (driver valido):
    // il blocco arriva dopo, dalla disponibilità.
    expect(fake.calls.membershipsQueried).toBe(1);
  });

  it("10. FUNC-01 geografia invariato: comportamento normale non alterato dal nuovo guard", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("11. RACE-01 invariato: upsert, mai DELETE, anche con il nuovo guard attivo", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(assignBody());

    expect(fake.calls.assignmentsDeleteCalls).toBe(0);
    expect(fake.calls.assignmentsUpsertCalls).toBe(1);
  });

  it("12. semantica upsert invariata: reset esplicito dei metadati stale sulla riga scritta", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(assignBody({ service_ids: [SERVICE_X1] }));

    expect(fake.calls.upsertedRows[0]).toMatchObject({
      driver_profile_id: null,
      group_id: null,
      assignment_source: null,
      locked_by_operator: false,
      lock_reason: null,
    });
  });

  it("13. remove_driver invariata: guard driver non invocato", async () => {
    const fake = baseSeed({
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_X1, driver_user_id: DRIVER_A, vehicle_label: "DEP_BUS:1" }],
    });
    authorizeAs(fake);

    const res = await callPost({ action: "remove_driver", service_ids: [SERVICE_X1] });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.assignmentsDeleteCalls).toBe(1);
    expect(fake.calls.membershipsQueried).toBe(0);
  });

  it("14. create_driver_account invariata: azione non tocca il guard driver ownership", async () => {
    mocks.authorizePricingRequest.mockResolvedValue({
      admin: baseSeed().admin,
      user: { id: "user-1", email: "op@test.dev" },
      membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
    });

    const res = await callPost({ action: "create_driver_account", driver_profile_id: "does-not-exist", email: "test@example.com" });
    const body = await res.json();

    // Profilo inesistente: 404 dal ramo create_driver_account esistente,
    // invariato — non deve mai coinvolgere verifyDriverBelongsToTenant.
    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Profilo autista non trovato" });
  });

  it("15. utente non autenticato: 401, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const fake = baseSeed();

    const res = await callPost(assignBody());

    expect(res.status).toBe(401);
    expect(fake.calls.membershipsQueried).toBe(0);
  });

  it("16. ruolo non autorizzato: 403, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    const fake = baseSeed();

    const res = await callPost(assignBody());

    expect(res.status).toBe(403);
    expect(fake.calls.membershipsQueried).toBe(0);
  });

  it("19. privacy: nessuna risposta contiene dettagli DB o tenant B", async () => {
    const fakeCrossTenant = baseSeed();
    authorizeAs(fakeCrossTenant);
    const resCrossTenant = await callPost(assignBody({ driver_user_id: DRIVER_B }));
    const rawCrossTenant = JSON.stringify(await resCrossTenant.json());

    expect(rawCrossTenant).not.toMatch(new RegExp(TENANT_B));
    expect(rawCrossTenant.toLowerCase()).not.toMatch(/sqlstate|stack|supabase|postgres/);

    const fakeDbError = baseSeed();
    fakeDbError.setTableError("memberships", RAW_DB_ERROR);
    authorizeAs(fakeDbError);
    const resDbError = await callPost(assignBody());
    const rawDbError = JSON.stringify(await resDbError.json());

    expect(rawDbError).not.toMatch(/internal-db-host/);
    expect(rawDbError.toLowerCase()).not.toMatch(/sqlstate/);
  });
});
