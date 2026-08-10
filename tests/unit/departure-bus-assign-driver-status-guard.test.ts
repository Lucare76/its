import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_X1 = "a1111111-1111-4111-8111-111111111111";
const SERVICE_X2 = "a2222222-2222-4222-8222-222222222222";
const SERVICE_B1 = "b1111111-1111-4111-8111-111111111111";
const DRIVER_ACTIVE = "d1111111-1111-4111-8111-111111111111";
const DRIVER_SUSPENDED = "d2222222-2222-4222-8222-222222222222";
const DRIVER_B = "d3333333-3333-4333-8333-333333333333";
const DRIVER_GHOST = "d9999999-9999-4999-8999-999999999999";
const NON_DRIVER_A = "d4444444-4444-4444-8444-444444444444";
const DATE_1 = "2026-08-10";

type Row = Record<string, unknown>;

const RAW_DB_ERROR = { message: 'connection to server "internal-db-host.example" failed: SQLSTATE[08006]' };

/**
 * Fake Supabase in-memory, tenant-aware, dedicato al guard FUNC-03 (stato
 * operativo driver) in departure-bus-assign. Stesso schema del fake usato in
 * departure-bus-assign-driver-tenant-guard.test.ts (SEC-05), esteso con
 * errorOnNthQuery per colpire selettivamente la 2a query su "memberships"
 * (quella di FUNC-03), distinta dalla 1a (SEC-05) — permette di testare i due
 * path di errore in modo indipendente senza toccare la route.
 */
function createTenantAwareSupabase(
  seed: Partial<Record<"services" | "memberships" | "assignments" | "daily_availability_confirmations" | "driver_profiles", Row[]>> = {}
) {
  const tables: Record<string, Row[]> = {
    services: [...(seed.services ?? [])],
    memberships: [...(seed.memberships ?? [])],
    assignments: [...(seed.assignments ?? [])],
    daily_availability_confirmations: [...(seed.daily_availability_confirmations ?? [])],
    // Presente solo per non far esplodere rami invarianti (create_driver_account);
    // il guard FUNC-03 di questa route non deve mai interrogarla.
    driver_profiles: [...(seed.driver_profiles ?? [])],
  };

  const tableErrors: Record<string, { message: string } | null> = {};
  const queryCountByTable: Record<string, number> = {};
  const errorOnNthQuery: Record<string, { n: number; err: { message: string } } | null> = {};

  const calls = {
    membershipsQueried: 0,
    driverProfilesQueried: 0,
    assignmentsUpsertCalls: 0,
    assignmentsDeleteCalls: 0,
    upsertedRows: [] as Row[],
    pushCalls: [] as Array<{ tenantId: string; userId: string }>,
  };

  function augmentAssignmentRow(row: Row): Row {
    return { ...row, services: tables.services.find((s) => s.id === row.service_id) ?? null };
  }

  function makeSelectBuilder(table: string) {
    if (!(table in tables)) throw new Error(`[fake supabase] tabella non definita: ${table}`);
    let filtered = tables[table];
    if (table === "memberships") calls.membershipsQueried++;
    if (table === "driver_profiles") calls.driverProfilesQueried++;
    queryCountByTable[table] = (queryCountByTable[table] ?? 0) + 1;
    const thisQueryN = queryCountByTable[table];
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
        const forcedNth = errorOnNthQuery[table];
        if (forcedNth && forcedNth.n === thisQueryN) {
          return Promise.resolve({ data: null, error: forcedNth.err });
        }
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
    setErrorOnNthQuery(table: string, n: number, err: { message: string } | null) {
      errorOnNthQuery[table] = err ? { n, err } : null;
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
      { tenant_id: TENANT_A, user_id: DRIVER_ACTIVE, role: "driver", suspended: false },
      { tenant_id: TENANT_A, user_id: DRIVER_SUSPENDED, role: "driver", suspended: true },
      { tenant_id: TENANT_B, user_id: DRIVER_B, role: "driver", suspended: false },
      { tenant_id: TENANT_A, user_id: NON_DRIVER_A, role: "operator", suspended: false },
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
    driver_user_id: DRIVER_ACTIVE,
    vehicle_label: "DEP_BUS:1",
    ...overrides,
  };
}

describe("FUNC-03 residuo — driver operational status guard in departure-bus-assign", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. driver same-tenant operativo (suspended=false): successo, upsert eseguito", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.assignmentsUpsertCalls).toBe(1);
    expect(fake.tables.assignments).toHaveLength(2);
  });

  it("2. driver suspended=true: 409 DRIVER_NOT_ACTIVE, zero scritture (sensibile alla rimozione del guard)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(assignBody({ driver_user_id: DRIVER_SUSPENDED }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      ok: false,
      error: "DRIVER_NOT_ACTIVE",
      message: "L'autista non è attualmente disponibile per nuove assegnazioni.",
    });
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
  });

  it("3. driver cross-tenant: 404 SEC-05, guard FUNC-03 mai raggiunto (una sola query memberships)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(assignBody({ driver_user_id: DRIVER_B }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
    expect(fake.calls.membershipsQueried).toBe(1);
  });

  it("4. driver inesistente: 404 SEC-05, guard FUNC-03 mai raggiunto", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(assignBody({ driver_user_id: DRIVER_GHOST }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    expect(fake.calls.membershipsQueried).toBe(1);
  });

  it("5. utente non-driver (ruolo operator): 404 SEC-05, guard FUNC-03 mai raggiunto", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(assignBody({ driver_user_id: NON_DRIVER_A }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    expect(fake.calls.membershipsQueried).toBe(1);
  });

  it("6. tenant_id malevolo nel body viene ignorato: verifica FUNC-03 resta contro il tenant della sessione", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(assignBody({ tenant_id: TENANT_B }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.upsertedRows[0].tenant_id).toBe(TENANT_A);
  });

  it("7. errore nella query suspended (2a query memberships): 500 fail-closed, zero scritture, audit invocato", async () => {
    const fake = baseSeed();
    fake.setErrorOnNthQuery("memberships", 2, RAW_DB_ERROR);
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({
      ok: false,
      error: "DRIVER_STATUS_CHECK_FAILED",
      message: "Errore durante la verifica dello stato dell'autista.",
    });
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "departure_bus_assign_driver_status_check_failed", level: "error" })
    );
  });

  it("8. risposta sanificata: nessun dettaglio DB, SQLSTATE, tenant o driver id nel body", async () => {
    const fakeSuspended = baseSeed();
    authorizeAs(fakeSuspended);
    const resSuspended = await callPost(assignBody({ driver_user_id: DRIVER_SUSPENDED }));
    const rawSuspended = JSON.stringify(await resSuspended.json());
    expect(rawSuspended).not.toMatch(new RegExp(DRIVER_SUSPENDED));
    expect(rawSuspended).not.toMatch(new RegExp(TENANT_A));

    const fakeErr = baseSeed();
    fakeErr.setErrorOnNthQuery("memberships", 2, RAW_DB_ERROR);
    authorizeAs(fakeErr);
    const resErr = await callPost(assignBody());
    const rawErr = JSON.stringify(await resErr.json());
    expect(rawErr).not.toMatch(/internal-db-host/);
    expect(rawErr.toLowerCase()).not.toMatch(/sqlstate/);
  });

  it("9. zero assignment upsert su 409 (driver sospeso)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(assignBody({ driver_user_id: DRIVER_SUSPENDED }));

    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
    expect(fake.tables.assignments).toHaveLength(0);
  });

  it("10. zero push su 409 (driver sospeso)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(assignBody({ driver_user_id: DRIVER_SUSPENDED }));

    expect(mocks.sendPushToUser).not.toHaveBeenCalled();
  });

  it("11. SEC-01 blocca prima del guard driver (service_id di tenant B)", async () => {
    const fake = baseSeed({
      services: [{ id: SERVICE_B1, tenant_id: TENANT_B, date: DATE_1, time: "10:00:00", pickup_hotel: null, direction: "departure", hotel_id: null, meeting_point: null }],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_B1] }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Uno o più servizi non trovati." });
    expect(fake.calls.membershipsQueried).toBe(0);
  });

  it("12. SEC-05 blocca prima di FUNC-03 (driver cross-tenant non arriva mai alla 2a query memberships)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(assignBody({ driver_user_id: DRIVER_B }));

    expect(res.status).toBe(404);
    // Una sola query memberships (SEC-05): FUNC-03 non è stato raggiunto.
    expect(fake.calls.membershipsQueried).toBe(1);
  });

  it("13. daily availability invariata: nessuna conferma giornaliera continua a bloccare con 409, dopo un guard driver superato", async () => {
    const fake = baseSeed({ daily_availability_confirmations: [] });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("DAILY_AVAILABILITY_NOT_CONFIRMED");
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
    // SEC-05 + FUNC-03 entrambi passati con successo prima del blocco availability.
    expect(fake.calls.membershipsQueried).toBe(2);
  });

  it("14. geografia invariata: comportamento normale non alterato dal nuovo guard", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("15. overlap driver invariato: conflitto orario esterno stesso autista continua a bloccare con 409", async () => {
    // Gap di 20 minuti: fuori dalla soglia FUNC-01 (buffer geografico "zona
    // sconosciuta" 15 min, hotel_id/meeting_point null in questi seed) ma
    // ancora dentro la finestra fissa di 30 minuti di CONC-02: isola la
    // guardia CONC-02 specificamente, evitando che FUNC-01 (aggiunta
    // successivamente, valida anch'essa lo stesso autista/tenant) intercetti
    // per prima lo stesso conflitto con un errore diverso (comportamento
    // reale e corretto, ma non l'oggetto di questo test).
    const fake = baseSeed({
      assignments: [
        {
          id: "asg-ext",
          tenant_id: TENANT_A,
          service_id: "c9999999-9999-4999-8999-999999999999",
          driver_user_id: DRIVER_ACTIVE,
          vehicle_label: "OTHER_BUS",
        },
      ],
      services: [
        serviceRow(SERVICE_X1),
        serviceRow(SERVICE_X2),
        serviceRow("c9999999-9999-4999-8999-999999999999", { time: "10:20:00" }),
      ],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("DRIVER_OVERLAP");
  });

  it("16. overlap mezzo invariato: conflitto orario esterno stesso vehicle_label continua a bloccare con 409", async () => {
    const fake = baseSeed({
      assignments: [
        {
          id: "asg-ext",
          tenant_id: TENANT_A,
          service_id: "c9999999-9999-4999-8999-999999999999",
          driver_user_id: DRIVER_B,
          vehicle_label: "DEP_BUS:1",
        },
      ],
      services: [
        serviceRow(SERVICE_X1),
        serviceRow(SERVICE_X2),
        serviceRow("c9999999-9999-4999-8999-999999999999", { time: "10:05:00" }),
      ],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("VEHICLE_OVERLAP");
  });

  it("17. RACE-01 invariato: upsert, mai DELETE, con il nuovo guard attivo e driver operativo", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(assignBody());

    expect(fake.calls.assignmentsDeleteCalls).toBe(0);
    expect(fake.calls.assignmentsUpsertCalls).toBe(1);
  });

  it("18. metadata UPSERT invariati: reset esplicito dei metadati stale sulla riga scritta", async () => {
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

  it("19. remove_driver invariata: guard FUNC-03 non invocato", async () => {
    const fake = baseSeed({
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_X1, driver_user_id: DRIVER_ACTIVE, vehicle_label: "DEP_BUS:1" }],
    });
    authorizeAs(fake);

    const res = await callPost({ action: "remove_driver", service_ids: [SERVICE_X1] });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.assignmentsDeleteCalls).toBe(1);
    expect(fake.calls.membershipsQueried).toBe(0);
  });

  it("20. create_driver_account invariata: azione non tocca il guard FUNC-03", async () => {
    mocks.authorizePricingRequest.mockResolvedValue({
      admin: baseSeed().admin,
      user: { id: "user-1", email: "op@test.dev" },
      membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
    });

    const res = await callPost({ action: "create_driver_account", driver_profile_id: "does-not-exist", email: "test@example.com" });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Profilo autista non trovato" });
  });

  it("21. utente non autenticato: 401, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const fake = baseSeed();

    const res = await callPost(assignBody());

    expect(res.status).toBe(401);
    expect(fake.calls.membershipsQueried).toBe(0);
  });

  it("22. ruolo non autorizzato: 403, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    const fake = baseSeed();

    const res = await callPost(assignBody());

    expect(res.status).toBe(403);
    expect(fake.calls.membershipsQueried).toBe(0);
  });

  it("23. nessuna query driver_profiles nel guard FUNC-03 (questa route persiste solo driver_user_id)", async () => {
    // Il guard FUNC-03 (verifyDriverIsOperational) stesso non ha mai
    // interrogato driver_profiles (verifica memberships.suspended). Dopo
    // CONC-07 una query driver_profiles esiste comunque nella route, ma solo
    // DOPO il successo completo (lookup del profilo per lo storico
    // strutturato) — non è parte del guard. Questa chiamata (driver sospeso)
    // viene bloccata da FUNC-03 prima di CONC-07: zero query driver_profiles
    // attribuibili al guard, invariante originale confermata.
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(assignBody({ driver_user_id: DRIVER_SUSPENDED }));
    expect(fake.calls.driverProfilesQueried).toBe(0);
  });

  it("23b. CONC-07: la query driver_profiles compare solo dopo il successo (lookup per lo storico), mai nel guard", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(assignBody());

    expect(res.status).toBe(200);
    expect(fake.calls.driverProfilesQueried).toBe(1);
  });

  it("24. audit su errore DB nella query suspended: evento dedicato, non confuso con SEC-05", async () => {
    const fake = baseSeed();
    fake.setErrorOnNthQuery("memberships", 2, RAW_DB_ERROR);
    authorizeAs(fake);

    await callPost(assignBody());

    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "departure_bus_assign_driver_status_check_failed",
        level: "error",
        tenantId: TENANT_A,
      })
    );
    expect(mocks.auditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "departure_bus_assign_driver_verification_failed" })
    );
  });

  it("25. sensibilità — rimozione del controllo suspended: driver sospeso deve restare bloccato (contratto del guard)", async () => {
    // Verifica di contratto, non implementazione: un driver con suspended=true
    // seedato correttamente deve produrre 409 indipendentemente da come il
    // guard è implementato internamente — vedi FASE 8 per l'esperimento reale
    // di rimozione del controllo nel codice sorgente.
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(assignBody({ driver_user_id: DRIVER_SUSPENDED }));

    expect(res.status).toBe(409);
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
  });

  it("26. sensibilità — bypass completo del guard: un driver sospeso non deve mai raggiungere l'upsert", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(assignBody({ driver_user_id: DRIVER_SUSPENDED, service_ids: [SERVICE_X1, SERVICE_X2] }));
    const body = await res.json();

    expect(res.status).not.toBe(200);
    expect(body.ok).toBe(false);
    expect(fake.tables.assignments).toHaveLength(0);
  });
});
