import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Test SEC-06 — sanitizzazione errori su GET /api/cancel-respond/info.
 *
 * Endpoint pubblico (nessuna autenticazione richiesta): carica in sola
 * lettura i dettagli di una richiesta di cancellazione tramite token, per la
 * pagina pubblica che precede l'azione di risposta (cancel-respond). A
 * differenza delle altre 4 route SEC-06 già chiuse, questa non controlla mai
 * `.error` sulla select (usa solo `!cr` per rilevare "non trovato") — l'unico
 * leak reale è nel catch esterno generico, che restituiva `err.message` raw
 * per qualunque eccezione non gestita. Il fix lo sostituisce con un
 * messaggio generico in italiano, loggando il dettaglio raw solo
 * server-side via `auditLog` (stesso pattern già validato nei 4 fix SEC-06
 * pubblici precedenti — nessun nuovo helper introdotto).
 */

const TOKEN = "11111111-1111-4111-8111-111111111111";

const DISTINCTIVE_RELATION_ERROR =
  'relation "cancellation_requests_internal_audit" does not exist';
const DISTINCTIVE_CONSTRAINT_ERROR =
  'duplicate key value violates unique constraint "cancellation_requests_approval_token_key" on relation "cancellation_requests", column "approval_token" SQLSTATE=23505';

type Row = Record<string, unknown>;

function createFakeAdmin(opts: { cr?: Row | null; throwError?: Error } = {}) {
  const { cr = null, throwError } = opts;
  return {
    from(_table: string) {
      return {
        select(_cols?: string) {
          return {
            eq(_field: string, _value: unknown) {
              return {
                maybeSingle() {
                  if (throwError) return Promise.reject(throwError);
                  return Promise.resolve({ data: cr, error: null });
                },
              };
            },
          };
        },
      };
    },
  };
}

function baseCancellationRequest(overrides: Row = {}) {
  return {
    id: "cr-1",
    cancel_legs: "both",
    status: "pending_agency_approval",
    penalty_cents: 5000,
    penalty_note: null,
    services: {
      customer_name: "Mario Bianchi",
      pax: 2,
      arrival_date: "2026-08-15",
      arrival_time: "10:00",
      departure_date: null,
      hotels: { name: "Hotel Test" },
    },
    ...overrides,
  };
}

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock("@/lib/server/whatsapp", () => ({
  createAdminClient: mocks.createAdminClient,
}));
vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: mocks.auditLog,
}));

import { GET } from "@/app/api/cancel-respond/info/route";

function callGet(token: string | null) {
  const url = new URL("http://localhost:3010/api/cancel-respond/info");
  if (token !== null) url.searchParams.set("token", token);
  return GET(new NextRequest(url));
}

function assertNoForbiddenFields(body: Record<string, unknown>) {
  expect(body).not.toHaveProperty("details");
  expect(body).not.toHaveProperty("hint");
  expect(body).not.toHaveProperty("code");
  expect(body).not.toHaveProperty("stack");
}

describe("SEC-06 — sanitizzazione errori su cancel-respond/info", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. success path invariato: richiesta trovata → 200 con dati completi", async () => {
    mocks.createAdminClient.mockReturnValue(createFakeAdmin({ cr: baseCancellationRequest() }));

    const res = await callGet(TOKEN);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe("cr-1");
    expect(body.data.service.customer_name).toBe("Mario Bianchi");
    expect(body.data.service.hotel_name).toBe("Hotel Test");
  });

  it("2. token invalido invariato: token mancante → 400", async () => {
    mocks.createAdminClient.mockReturnValue(createFakeAdmin({ cr: null }));

    const res = await callGet(null);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ ok: false, error: "Token mancante." });
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it("3. not-found invariato: richiesta non trovata → 404", async () => {
    mocks.createAdminClient.mockReturnValue(createFakeAdmin({ cr: null }));

    const res = await callGet(TOKEN);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Richiesta non trovata." });
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it("4. business error invariato: né token mancante né not-found generano audit log (non sono DB/internal error)", async () => {
    mocks.createAdminClient.mockReturnValue(createFakeAdmin({ cr: null }));
    await callGet(null);
    await callGet(TOKEN);

    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it("5. catch con \"relation ... does not exist\": messaggio raw NON presente nella risposta", async () => {
    mocks.createAdminClient.mockReturnValue(createFakeAdmin({ throwError: new Error(DISTINCTIVE_RELATION_ERROR) }));

    const res = await callGet(TOKEN);
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("cancellation_requests_internal_audit");
    expect(rawText).not.toContain("relation");
  });

  it("6. catch con violazione di vincolo univoco: messaggio raw NON presente nella risposta", async () => {
    mocks.createAdminClient.mockReturnValue(createFakeAdmin({ throwError: new Error(DISTINCTIVE_CONSTRAINT_ERROR) }));

    const res = await callGet(TOKEN);
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("duplicate key");
    expect(rawText).not.toContain("unique constraint");
  });

  it("7. constraint name NON presente", async () => {
    mocks.createAdminClient.mockReturnValue(createFakeAdmin({ throwError: new Error(DISTINCTIVE_CONSTRAINT_ERROR) }));

    const res = await callGet(TOKEN);
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("cancellation_requests_approval_token_key");
  });

  it("8. table/column NON presenti", async () => {
    mocks.createAdminClient.mockReturnValue(createFakeAdmin({ throwError: new Error(DISTINCTIVE_CONSTRAINT_ERROR) }));

    const res = await callGet(TOKEN);
    const rawText = await res.clone().text();

    expect(rawText).not.toContain('column "approval_token"');
    expect(rawText).not.toContain("SQLSTATE");
  });

  it("9. details/hint/code assenti nel body", async () => {
    mocks.createAdminClient.mockReturnValue(createFakeAdmin({ throwError: new Error(DISTINCTIVE_CONSTRAINT_ERROR) }));

    assertNoForbiddenFields(await (await callGet(TOKEN)).json());
  });

  it("10. fallback generico corretto", async () => {
    mocks.createAdminClient.mockReturnValue(createFakeAdmin({ throwError: new Error(DISTINCTIVE_CONSTRAINT_ERROR) }));

    const body = await (await callGet(TOKEN)).json();

    expect(body).toEqual({ ok: false, error: "Si è verificato un errore durante il caricamento della richiesta." });
  });

  it("11. status HTTP invariato: resta 500", async () => {
    mocks.createAdminClient.mockReturnValue(createFakeAdmin({ throwError: new Error(DISTINCTIVE_CONSTRAINT_ERROR) }));

    const res = await callGet(TOKEN);

    expect(res.status).toBe(500);
  });

  it("12. endpoint resta pubblico: richiesta senza Authorization raggiunge comunque la business logic", async () => {
    mocks.createAdminClient.mockReturnValue(createFakeAdmin({ cr: baseCancellationRequest() }));

    const res = await callGet(TOKEN);

    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });

  it("13. nessuna auth introdotta: stesso comportamento con o senza header Authorization", async () => {
    mocks.createAdminClient.mockReturnValue(createFakeAdmin({ cr: baseCancellationRequest() }));
    const url = new URL("http://localhost:3010/api/cancel-respond/info");
    url.searchParams.set("token", TOKEN);
    const res = await GET(new NextRequest(url, { headers: { authorization: "Bearer invalid-or-absent" } }));

    expect(res.status).toBe(200);
  });

  it("14. success response invariata: stessa forma { ok, data } con tutti i campi attesi", async () => {
    mocks.createAdminClient.mockReturnValue(createFakeAdmin({ cr: baseCancellationRequest() }));

    const body = await (await callGet(TOKEN)).json();

    expect(Object.keys(body).sort()).toEqual(["data", "ok"].sort());
    expect(Object.keys(body.data).sort()).toEqual(
      ["id", "cancel_legs", "status", "penalty_cents", "penalty_note", "service"].sort()
    );
  });

  it("15. auditLog invocato una sola volta per errore", async () => {
    mocks.createAdminClient.mockReturnValue(createFakeAdmin({ throwError: new Error(DISTINCTIVE_CONSTRAINT_ERROR) }));

    await callGet(TOKEN);

    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    const logged = mocks.auditLog.mock.calls[0][0];
    expect(logged.level).toBe("error");
    expect(logged.details.message).toBe(DISTINCTIVE_CONSTRAINT_ERROR);
  });

  it("16. nessun oggetto error serializzato: body.error è sempre una stringa", async () => {
    mocks.createAdminClient.mockReturnValue(createFakeAdmin({ throwError: new Error(DISTINCTIVE_CONSTRAINT_ERROR) }));

    const body = await (await callGet(TOKEN)).json();

    expect(typeof body.error).toBe("string");
  });
});
