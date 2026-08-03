import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_X = "a1111111-1111-4111-8111-111111111111";
const SERVICE_B1 = "b1111111-1111-4111-8111-111111111111";
const NONEXISTENT_SERVICE = "99999999-9999-4999-8999-999999999999";
const DRIVER_A = "d1111111-1111-4111-8111-111111111111";
const DRIVER_B = "d2222222-2222-4222-8222-222222222222";
const ADMIN_USER = "u1111111-1111-4111-8111-111111111111";

type Row = Record<string, unknown>;

const RAW_DB_ERROR = { message: 'connection to server "internal-db-host.example" failed: SQLSTATE[08006]' };

/**
 * Fake Supabase in-memory, tenant-aware e actor-aware, dedicato ai test
 * SEC-04 (guard ownership driver) in driver-status. Applica realmente
 * eq/single/maybeSingle sulle tabelle coinvolte (services, assignments,
 * status_events). RADIUS_REFRESH_TOKEN non è mai settato nei test: il ramo
 * GPS via Radius è sempre saltato, resta solo la query assignments del
 * nuovo guard SEC-04 (una sola query per richiesta, niente contatore n-esimo
 * necessario).
 */
function createFake(seed: Partial<Record<"services" | "assignments", Row[]>> = {}) {
  const tables: Record<string, Row[]> = {
    services: [...(seed.services ?? [])],
    assignments: [...(seed.assignments ?? [])],
    status_events: [],
  };

  const tableErrors: Record<string, { message: string } | null> = {};
  const updateErrors: Record<string, { message: string } | null> = {};

  const calls = {
    assignmentsQueried: 0,
    servicesUpdated: 0,
    statusEventsInserted: [] as Row[],
  };

  function makeSelectBuilder(table: string) {
    if (!(table in tables)) throw new Error(`[fake supabase] tabella non definita: ${table}`);
    let filtered = tables[table];
    if (table === "assignments") calls.assignmentsQueried++;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] === value);
        return builder;
      },
      limit(_n: number) {
        return builder;
      },
      single() {
        const err = tableErrors[table] ?? null;
        if (err) return Promise.resolve({ data: null, error: err });
        const row = filtered[0] ?? null;
        if (!row) return Promise.resolve({ data: null, error: { message: "no rows", code: "PGRST116" } });
        return Promise.resolve({ data: row, error: null });
      },
      maybeSingle() {
        const err = tableErrors[table] ?? null;
        if (err) return Promise.resolve({ data: null, error: err });
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
    };
    return builder;
  }

  function makeUpdateBuilder(table: string, payload: Row) {
    let filtered = tables[table];
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] === value);
        return builder;
      },
      then(resolve: (v: { error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        const err = updateErrors[table] ?? null;
        if (err) return Promise.resolve({ error: err }).then(resolve, reject);
        for (const row of filtered) Object.assign(row, payload);
        if (table === "services") calls.servicesUpdated += filtered.length;
        return Promise.resolve({ error: null }).then(resolve, reject);
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
        update(payload: Row) {
          return makeUpdateBuilder(table, payload);
        },
        insert(row: Row) {
          if (table === "status_events") {
            calls.statusEventsInserted.push(row);
            tables.status_events.push(row);
          }
          return Promise.resolve({ error: null });
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
    setUpdateError(table: string, err: { message: string } | null) {
      updateErrors[table] = err;
    },
  };
}

const mocks = vi.hoisted(() => ({
  authorizeServiceRoleRequest: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizeServiceRoleRequest: mocks.authorizeServiceRoleRequest,
}));

import { POST } from "@/app/api/ops/driver-status/route";

function serviceRow(id: string, overrides: Row = {}): Row {
  return { id, tenant_id: TENANT_A, status: "partito", ...overrides };
}

function assignmentRow(serviceId: string, driverUserId: string, overrides: Row = {}): Row {
  return { id: `asg-${serviceId}`, service_id: serviceId, tenant_id: TENANT_A, driver_user_id: driverUserId, ...overrides };
}

function baseSeed(overrides: Parameters<typeof createFake>[0] = {}) {
  return createFake({
    services: [serviceRow(SERVICE_X)],
    assignments: [assignmentRow(SERVICE_X, DRIVER_A)],
    ...overrides,
  });
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/ops/driver-status", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}
function callPost(body: Record<string, unknown>) {
  return POST(makeRequest(body));
}

function authorizeAs(fake: ReturnType<typeof createFake>, userId: string, role: string) {
  mocks.authorizeServiceRoleRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: userId, email: "test@example.com" },
    membership: { tenant_id: TENANT_A, role, suspended: false },
  });
}

function statusBody(overrides: Record<string, unknown> = {}) {
  return { service_id: SERVICE_X, status: "completato", ...overrides };
}

describe("SEC-04 — driver ownership access control in driver-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. driver aggiorna il proprio stato: successo", async () => {
    const fake = baseSeed();
    authorizeAs(fake, DRIVER_A, "driver");

    const res = await callPost(statusBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.servicesUpdated).toBe(1);
    expect(fake.calls.statusEventsInserted).toHaveLength(1);
  });

  it("2. driver tenta di aggiornare il servizio di un altro driver same-tenant: 403 DRIVER_STATUS_FORBIDDEN (sensibile alla rimozione del confronto actor/target)", async () => {
    const fake = baseSeed();
    authorizeAs(fake, DRIVER_B, "driver");

    const res = await callPost(statusBody());
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual({
      ok: false,
      error: "DRIVER_STATUS_FORBIDDEN",
      message: "Non puoi modificare lo stato di un altro autista.",
    });
    expect(fake.calls.servicesUpdated).toBe(0);
    expect(fake.calls.statusEventsInserted).toHaveLength(0);
  });

  it("3. driver tenta un service_id di tenant B: 404 invariato (tenant isolation esistente blocca prima del guard SEC-04), nessun leak", async () => {
    const fake = createFake({
      services: [serviceRow(SERVICE_B1, { tenant_id: TENANT_B })],
      assignments: [assignmentRow(SERVICE_B1, DRIVER_B, { tenant_id: TENANT_B })],
    });
    authorizeAs(fake, DRIVER_A, "driver");

    const res = await callPost(statusBody({ service_id: SERVICE_B1 }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Servizio non trovato." });
    expect(fake.calls.assignmentsQueried).toBe(0);
  });

  it("4. driver invia service_id inesistente: nessuna scrittura (404 invariato)", async () => {
    const fake = createFake({ services: [], assignments: [] });
    authorizeAs(fake, DRIVER_A, "driver");

    const res = await callPost(statusBody({ service_id: NONEXISTENT_SERVICE }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Servizio non trovato." });
    expect(fake.calls.servicesUpdated).toBe(0);
  });

  it("5. service_id omesso: 400 invariato (contratto API esistente, nessun campo target separato da derivare)", async () => {
    const fake = baseSeed();
    authorizeAs(fake, DRIVER_A, "driver");

    const res = await callPost({ status: "completato" });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ ok: false, error: "service_id e status sono obbligatori." });
    expect(fake.calls.assignmentsQueried).toBe(0);
  });

  it("6. admin aggiorna un servizio assegnato a un driver same-tenant: successo, guard SEC-04 non applicato", async () => {
    const fake = baseSeed();
    authorizeAs(fake, ADMIN_USER, "admin");

    const res = await callPost(statusBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // Il guard driver non deve nemmeno essere interrogato per un admin.
    expect(fake.calls.assignmentsQueried).toBe(0);
  });

  it("7. admin con service_id di tenant B: 404 invariato", async () => {
    const fake = createFake({
      services: [serviceRow(SERVICE_B1, { tenant_id: TENANT_B })],
    });
    authorizeAs(fake, ADMIN_USER, "admin");

    const res = await callPost(statusBody({ service_id: SERVICE_B1 }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Servizio non trovato." });
  });

  it("8. operator same-tenant: comportamento invariato (successo, nessun guard driver)", async () => {
    const fake = baseSeed();
    authorizeAs(fake, ADMIN_USER, "operator");

    const res = await callPost(statusBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.assignmentsQueried).toBe(0);
  });

  it("9. supervisor same-tenant: comportamento invariato (successo, nessun guard driver)", async () => {
    const fake = baseSeed();
    authorizeAs(fake, ADMIN_USER, "supervisor");

    const res = await callPost(statusBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.assignmentsQueried).toBe(0);
  });

  it("10. ruolo non autorizzato: 403 dall'auth centrale, zero query operative", async () => {
    mocks.authorizeServiceRoleRequest.mockResolvedValue(
      NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 })
    );
    const fake = baseSeed();

    const res = await callPost(statusBody());

    expect(res.status).toBe(403);
    expect(fake.calls.servicesUpdated).toBe(0);
  });

  it("11. utente non autenticato: 401, zero query operative", async () => {
    mocks.authorizeServiceRoleRequest.mockResolvedValue(
      NextResponse.json({ error: "Sessione non valida." }, { status: 401 })
    );
    const fake = baseSeed();

    const res = await callPost(statusBody());

    expect(res.status).toBe(401);
    expect(fake.calls.servicesUpdated).toBe(0);
  });

  it("12. membership mancante: 403 dall'auth centrale, zero query operative", async () => {
    mocks.authorizeServiceRoleRequest.mockResolvedValue(
      NextResponse.json({ error: "Membership non trovata." }, { status: 403 })
    );
    const fake = baseSeed();

    const res = await callPost(statusBody());

    expect(res.status).toBe(403);
    expect(fake.calls.servicesUpdated).toBe(0);
  });

  it("13. tenant_id malevolo nel body viene ignorato: ownership/tenant usano sempre il tenant della sessione", async () => {
    const fake = baseSeed();
    authorizeAs(fake, DRIVER_A, "driver");

    const res = await callPost(statusBody({ tenant_id: TENANT_B }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("14. errore nella query ownership (assignments): 500 DRIVER_STATUS_CHECK_FAILED, fail-closed, zero scritture, nessun dettaglio DB", async () => {
    const fake = baseSeed();
    fake.setTableError("assignments", RAW_DB_ERROR);
    authorizeAs(fake, DRIVER_A, "driver");

    const res = await callPost(statusBody());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({
      ok: false,
      error: "DRIVER_STATUS_CHECK_FAILED",
      message: "Errore durante la verifica dell'autista.",
    });
    expect(fake.calls.servicesUpdated).toBe(0);
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/internal-db-host/);
    expect(raw.toLowerCase()).not.toMatch(/sqlstate/);
  });

  it("15. zero scritture su ogni rifiuto (driver su collega, tenant B, ownership error)", async () => {
    const fakeForbidden = baseSeed();
    authorizeAs(fakeForbidden, DRIVER_B, "driver");
    await callPost(statusBody());
    expect(fakeForbidden.calls.servicesUpdated).toBe(0);
    expect(fakeForbidden.calls.statusEventsInserted).toHaveLength(0);

    const fakeCrossTenant = createFake({ services: [serviceRow(SERVICE_B1, { tenant_id: TENANT_B })] });
    authorizeAs(fakeCrossTenant, DRIVER_A, "driver");
    await callPost(statusBody({ service_id: SERVICE_B1 }));
    expect(fakeCrossTenant.calls.servicesUpdated).toBe(0);

    const fakeDbError = baseSeed();
    fakeDbError.setTableError("assignments", RAW_DB_ERROR);
    authorizeAs(fakeDbError, DRIVER_A, "driver");
    await callPost(statusBody());
    expect(fakeDbError.calls.servicesUpdated).toBe(0);
  });

  it("16. audit di successo (status_events) solo dopo write riuscita", async () => {
    const fake = baseSeed();
    authorizeAs(fake, DRIVER_A, "driver");

    await callPost(statusBody());

    expect(fake.calls.statusEventsInserted).toHaveLength(1);
    expect(fake.calls.statusEventsInserted[0]).toMatchObject({
      service_id: SERVICE_X,
      status: "completato",
      by_user_id: DRIVER_A,
    });
  });

  it("17. nessun status_event scritto sul tentativo vietato", async () => {
    const fake = baseSeed();
    authorizeAs(fake, DRIVER_B, "driver");

    await callPost(statusBody());

    expect(fake.calls.statusEventsInserted).toHaveLength(0);
  });

  it("18. risposta sanificata: nessun dettaglio DB/tenant esposto sui rifiuti", async () => {
    const fakeForbidden = baseSeed();
    authorizeAs(fakeForbidden, DRIVER_B, "driver");
    const resForbidden = await callPost(statusBody());
    const rawForbidden = JSON.stringify(await resForbidden.json());
    expect(rawForbidden.toLowerCase()).not.toMatch(/sqlstate|stack|supabase|postgres/);

    const fakeDbError = baseSeed();
    fakeDbError.setTableError("assignments", RAW_DB_ERROR);
    authorizeAs(fakeDbError, DRIVER_A, "driver");
    const resDbError = await callPost(statusBody());
    const rawDbError = JSON.stringify(await resDbError.json());
    expect(rawDbError).not.toMatch(/internal-db-host/);
  });

  it("19. driver same-tenant con status diverso: comportamento legittimo invariato", async () => {
    const fake = baseSeed();
    authorizeAs(fake, DRIVER_A, "driver");

    const res = await callPost({ service_id: SERVICE_X, status: "arrivato" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("arrivato");
    const updatedService = fake.tables.services.find((s) => s.id === SERVICE_X);
    expect(updatedService?.status).toBe("arrivato");
  });

  it("20. errore aggiornamento status (services.update) resta gestito come prima (500, messaggio esistente)", async () => {
    const fake = baseSeed();
    fake.setUpdateError("services", { message: "constraint violation xyz" });
    authorizeAs(fake, DRIVER_A, "driver");

    const res = await callPost(statusBody());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
  });
});
