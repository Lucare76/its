import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Test SEC-06 — sanitizzazione errori su POST /api/cancel-respond.
 *
 * Endpoint pubblico (nessuna autenticazione richiesta): l'agenzia risponde
 * alla richiesta di cancellazione tramite un token nel link email. Prima del
 * fix, due punti restituivano al client il messaggio raw Postgres/RPC:
 *   1. `finalizeError.message` (esito della RPC finalize_cancellation_request);
 *   2. `err.message` del catch esterno generico.
 * Il fix sostituisce entrambi con un messaggio generico in italiano coerente
 * con lo stile della route, loggando il dettaglio raw solo server-side via
 * `auditLog` (stesso pattern già validato in
 * app/api/shuttle-schedules/[id]/route.ts, riusato qui — nessun nuovo
 * helper introdotto).
 */

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOKEN = "11111111-1111-4111-8111-111111111111";
const SERVICE_1 = "22222222-2222-4222-8222-222222222222";
const REQUEST_1 = "cr-1";

const DISTINCTIVE_CONSTRAINT_ERROR =
  'duplicate key value violates unique constraint "cancellation_requests_approval_token_key"';
const DISTINCTIVE_RELATION_ERROR =
  'relation "cancellation_requests_internal_audit" does not exist';
const DISTINCTIVE_COLUMN_ERROR =
  'column "penalty_cents_raw" of relation "cancellation_requests" does not exist';
const DISTINCTIVE_SQLSTATE_ERROR =
  'update or delete on table "cancellation_requests" violates foreign key constraint "fk_service_id" SQLSTATE=23503';
const DISTINCTIVE_STACK_LIKE_ERROR =
  "at Object.<anonymous> (/var/task/app/api/cancel-respond/route.ts:93:14)";

type Row = Record<string, unknown>;

function makeBuilder(rows: Row[], opts: { throwError?: Error; resultError?: { message: string } } = {}) {
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
    maybeSingle() {
      if (opts.throwError) return Promise.reject(opts.throwError);
      return Promise.resolve({ data: filtered[0] ?? null, error: opts.resultError ?? null });
    },
    then(resolve: (v: { data: Row[]; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
      if (opts.throwError) return Promise.reject(opts.throwError).then(resolve, reject);
      return Promise.resolve({ data: filtered, error: opts.resultError ?? null }).then(resolve, reject);
    },
  };
  return builder;
}

function baseCr(overrides: Row = {}) {
  return {
    id: REQUEST_1,
    tenant_id: TENANT_A,
    cancel_legs: "both",
    status: "pending_agency_approval",
    penalty_cents: 0,
    penalty_note: null,
    approval_token: TOKEN,
    services: {
      id: SERVICE_1,
      customer_name: "Mario Bianchi",
      pax: 2,
      date: "2026-08-15",
      time: "10:00",
      arrival_date: null,
      arrival_time: null,
      departure_date: "2026-08-15",
      departure_time: "10:00",
      hotels: { name: "Hotel Test" },
      agencies: { name: "Agenzia XYZ", booking_email: "a@b.it", contact_email: null },
    },
    ...overrides,
  };
}

function createFakeAdmin(opts: { cr?: Row | null; crThrow?: Error; rpcError?: { message: string } | null } = {}) {
  const { cr = baseCr(), crThrow, rpcError = null } = opts;
  const calls = {
    rpcCalls: [] as Array<{ name: string; params: Record<string, unknown> }>,
    crUpdates: 0,
    notificationsInserted: [] as Row[],
  };

  const admin = {
    from(table: string) {
      if (table === "cancellation_requests") {
        return {
          select() {
            return makeBuilder(cr ? [cr] : [], { throwError: crThrow });
          },
          update(_payload: Row) {
            return {
              eq() {
                calls.crUpdates += 1;
                return Promise.resolve({ data: null, error: null });
              },
            };
          },
        };
      }
      if (table === "assignments") {
        return { select() { return makeBuilder([]); } };
      }
      if (table === "memberships") {
        return { select() { return makeBuilder([]); } };
      }
      if (table === "notifications") {
        return {
          insert(rows: Row | Row[]) {
            const arr = Array.isArray(rows) ? rows : [rows];
            calls.notificationsInserted.push(...arr);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      throw new Error(`fake admin: unexpected table "${table}"`);
    },
    rpc(name: string, params: Record<string, unknown>) {
      calls.rpcCalls.push({ name, params });
      return Promise.resolve({ data: null, error: rpcError });
    },
    auth: {
      admin: {
        listUsers() {
          return Promise.resolve({ data: { users: [] } });
        },
      },
    },
  };

  return { admin, calls };
}

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  sendEmail: vi.fn(),
  notifyDriverServiceCancelled: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock("@/lib/server/whatsapp", () => ({
  createAdminClient: mocks.createAdminClient,
}));
vi.mock("@/lib/server/send-email", () => ({
  sendEmail: mocks.sendEmail,
}));
vi.mock("@/lib/server/driver-cancellation-whatsapp", () => ({
  notifyDriverServiceCancelled: mocks.notifyDriverServiceCancelled,
}));
vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: mocks.auditLog,
}));

import { POST } from "@/app/api/cancel-respond/route";

function makeRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost:3010/api/cancel-respond", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
function callPost(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return POST(makeRequest(body, headers));
}

function acceptBody(overrides: Record<string, unknown> = {}) {
  return { token: TOKEN, action: "accept", ...overrides };
}

function assertNoForbiddenFields(body: Record<string, unknown>) {
  expect(body).not.toHaveProperty("details");
  expect(body).not.toHaveProperty("hint");
  expect(body).not.toHaveProperty("code");
  expect(body).not.toHaveProperty("stack");
}

describe("SEC-06 — sanitizzazione errori su cancel-respond", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendEmail.mockResolvedValue({ ok: true });
    mocks.notifyDriverServiceCancelled.mockResolvedValue(undefined);
  });

  it("1. success path invariato: accept riuscito → 200 { ok: true, action, status }", async () => {
    const fake = createFakeAdmin();
    mocks.createAdminClient.mockReturnValue(fake.admin);

    const res = await callPost(acceptBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, action: "accept", status: "approved" });
    expect(fake.calls.rpcCalls).toHaveLength(1);
    expect(fake.calls.rpcCalls[0].name).toBe("finalize_cancellation_request");
  });

  it("2. token/body invalido invariato: 400 con messaggio di validazione Zod originale (non generico)", async () => {
    const fake = createFakeAdmin();
    mocks.createAdminClient.mockReturnValue(fake.admin);

    const res = await callPost({ token: "not-a-uuid", action: "accept" });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it("3. business error invariato: richiesta non trovata → 404 messaggio business invariato; già risposta → 409 messaggio business invariato", async () => {
    const fakeNotFound = createFakeAdmin({ cr: null });
    mocks.createAdminClient.mockReturnValue(fakeNotFound.admin);
    const resNotFound = await callPost(acceptBody());
    const bodyNotFound = await resNotFound.json();
    expect(resNotFound.status).toBe(404);
    expect(bodyNotFound).toEqual({ error: "Richiesta non trovata o link non valido." });

    const fakeAlreadyResponded = createFakeAdmin({ cr: baseCr({ status: "approved" }) });
    mocks.createAdminClient.mockReturnValue(fakeAlreadyResponded.admin);
    const resAlready = await callPost(acceptBody());
    const bodyAlready = await resAlready.json();
    expect(resAlready.status).toBe(409);
    expect(bodyAlready).toEqual({ error: "Questa richiesta non e piu in attesa di risposta." });

    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it("4. RPC finalize fallisce con violazione di vincolo univoco: testo del constraint NON presente nella risposta", async () => {
    const fake = createFakeAdmin({ rpcError: { message: DISTINCTIVE_CONSTRAINT_ERROR } });
    mocks.createAdminClient.mockReturnValue(fake.admin);

    const res = await callPost(acceptBody());
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("duplicate key");
    expect(rawText).not.toContain("unique constraint");
  });

  it("5. constraint name NON presente nella risposta", async () => {
    const fake = createFakeAdmin({ rpcError: { message: DISTINCTIVE_CONSTRAINT_ERROR } });
    mocks.createAdminClient.mockReturnValue(fake.admin);

    const res = await callPost(acceptBody());
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("cancellation_requests_approval_token_key");
  });

  it("6. table name NON presente nella risposta", async () => {
    const fake = createFakeAdmin({ rpcError: { message: DISTINCTIVE_RELATION_ERROR } });
    mocks.createAdminClient.mockReturnValue(fake.admin);

    const res = await callPost(acceptBody());
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("cancellation_requests_internal_audit");
    expect(rawText).not.toContain("relation");
  });

  it("7. column name NON presente nella risposta", async () => {
    const fake = createFakeAdmin({ rpcError: { message: DISTINCTIVE_COLUMN_ERROR } });
    mocks.createAdminClient.mockReturnValue(fake.admin);

    const res = await callPost(acceptBody());
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("penalty_cents_raw");
    expect(rawText).not.toContain("does not exist");
  });

  it("8. dettaglio SQL-like (SQLSTATE/foreign key) NON presente nella risposta", async () => {
    const fake = createFakeAdmin({ rpcError: { message: DISTINCTIVE_SQLSTATE_ERROR } });
    mocks.createAdminClient.mockReturnValue(fake.admin);

    const res = await callPost(acceptBody());
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("SQLSTATE");
    expect(rawText).not.toContain("fk_service_id");
    expect(rawText).not.toContain("foreign key constraint");
  });

  it("9. finalize error: risposta con fallback generico esatto", async () => {
    const fake = createFakeAdmin({ rpcError: { message: DISTINCTIVE_CONSTRAINT_ERROR } });
    mocks.createAdminClient.mockReturnValue(fake.admin);

    const res = await callPost(acceptBody());
    const body = await res.json();

    expect(body).toEqual({ error: "Impossibile completare la richiesta di cancellazione." });
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    const logged = mocks.auditLog.mock.calls[0][0];
    expect(logged.level).toBe("error");
    expect(logged.details.message).toBe(DISTINCTIVE_CONSTRAINT_ERROR);
  });

  it("10. status HTTP invariato per errore RPC: resta 500", async () => {
    const fake = createFakeAdmin({ rpcError: { message: DISTINCTIVE_CONSTRAINT_ERROR } });
    mocks.createAdminClient.mockReturnValue(fake.admin);

    const res = await callPost(acceptBody());

    expect(res.status).toBe(500);
  });

  it("11. catch esterno con errore tipo \"relation ... does not exist\": messaggio raw NON presente", async () => {
    const fake = createFakeAdmin({ crThrow: new Error(DISTINCTIVE_RELATION_ERROR) });
    mocks.createAdminClient.mockReturnValue(fake.admin);

    const res = await callPost(acceptBody());
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("cancellation_requests_internal_audit");
    expect(rawText).not.toContain("relation");
  });

  it("12. catch esterno con errore contenente un nome di constraint: NON presente", async () => {
    const fake = createFakeAdmin({ crThrow: new Error(DISTINCTIVE_CONSTRAINT_ERROR) });
    mocks.createAdminClient.mockReturnValue(fake.admin);

    const res = await callPost(acceptBody());
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("cancellation_requests_approval_token_key");
    expect(rawText).not.toContain("duplicate key");
  });

  it("13. catch esterno con testo stack-like/path-like: NON presente", async () => {
    const fake = createFakeAdmin({ crThrow: new Error(DISTINCTIVE_STACK_LIKE_ERROR) });
    mocks.createAdminClient.mockReturnValue(fake.admin);

    const res = await callPost(acceptBody());
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("/var/task/app/api/cancel-respond/route.ts");
    expect(rawText).not.toContain("Object.<anonymous>");
  });

  it("14. catch esterno: risposta con fallback generico esatto", async () => {
    const fake = createFakeAdmin({ crThrow: new Error(DISTINCTIVE_RELATION_ERROR) });
    mocks.createAdminClient.mockReturnValue(fake.admin);

    const res = await callPost(acceptBody());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ ok: false, error: "Si è verificato un errore durante l'elaborazione della richiesta." });
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    const logged = mocks.auditLog.mock.calls[0][0];
    expect(logged.level).toBe("error");
    expect(logged.details.message).toBe(DISTINCTIVE_RELATION_ERROR);
  });

  it("15. nessun oggetto error serializzato: body.error è sempre una stringa, mai un oggetto", async () => {
    const fakeRpc = createFakeAdmin({ rpcError: { message: DISTINCTIVE_CONSTRAINT_ERROR } });
    mocks.createAdminClient.mockReturnValue(fakeRpc.admin);
    const resRpc = await callPost(acceptBody());
    expect(typeof (await resRpc.json()).error).toBe("string");

    const fakeCatch = createFakeAdmin({ crThrow: new Error(DISTINCTIVE_RELATION_ERROR) });
    mocks.createAdminClient.mockReturnValue(fakeCatch.admin);
    const resCatch = await callPost(acceptBody());
    expect(typeof (await resCatch.json()).error).toBe("string");
  });

  it("16. nessun campo details/hint/code/stack nel body per entrambi i path (RPC e catch esterno)", async () => {
    const fakeRpc = createFakeAdmin({ rpcError: { message: DISTINCTIVE_CONSTRAINT_ERROR } });
    mocks.createAdminClient.mockReturnValue(fakeRpc.admin);
    assertNoForbiddenFields(await (await callPost(acceptBody())).json());

    const fakeCatch = createFakeAdmin({ crThrow: new Error(DISTINCTIVE_RELATION_ERROR) });
    mocks.createAdminClient.mockReturnValue(fakeCatch.admin);
    assertNoForbiddenFields(await (await callPost(acceptBody())).json());
  });

  it("17. response success invariata: reject/counter restituiscono comunque { ok: true, action, status: pending_agency_approval }", async () => {
    const fake = createFakeAdmin();
    mocks.createAdminClient.mockReturnValue(fake.admin);

    const res = await callPost({ token: TOKEN, action: "reject" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, action: "reject", status: "pending_agency_approval" });
  });

  it("18. nessuna mutazione aggiuntiva quando la RPC finalize fallisce: nessun update a cancellation_requests, nessuna notification inserita", async () => {
    const fake = createFakeAdmin({ rpcError: { message: DISTINCTIVE_CONSTRAINT_ERROR } });
    mocks.createAdminClient.mockReturnValue(fake.admin);

    await callPost(acceptBody());

    expect(fake.calls.crUpdates).toBe(0);
    expect(fake.calls.notificationsInserted).toHaveLength(0);
    expect(mocks.notifyDriverServiceCancelled).not.toHaveBeenCalled();
  });

  it("19. nessun doppio logging: auditLog chiamato esattamente una volta per scenario di errore", async () => {
    const fakeRpc = createFakeAdmin({ rpcError: { message: DISTINCTIVE_CONSTRAINT_ERROR } });
    mocks.createAdminClient.mockReturnValue(fakeRpc.admin);
    await callPost(acceptBody());
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mocks.sendEmail.mockResolvedValue({ ok: true });
    mocks.notifyDriverServiceCancelled.mockResolvedValue(undefined);

    const fakeCatch = createFakeAdmin({ crThrow: new Error(DISTINCTIVE_RELATION_ERROR) });
    mocks.createAdminClient.mockReturnValue(fakeCatch.admin);
    await callPost(acceptBody());
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
  });

  it("20. endpoint resta pubblico: nessuna auth introdotta, richiesta senza header Authorization raggiunge comunque la business logic", async () => {
    const fake = createFakeAdmin();
    mocks.createAdminClient.mockReturnValue(fake.admin);

    const res = await callPost(acceptBody());

    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });
});
