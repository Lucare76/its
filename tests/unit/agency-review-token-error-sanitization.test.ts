import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Test SEC-06 — sanitizzazione errori su GET/POST /api/agency-review/[token].
 *
 * Endpoint pubblico (nessuna autenticazione richiesta): link email tramite
 * cui l'agenzia approva o modifica un riepilogo servizi. Prima del fix, un
 * punto restituiva al client il messaggio raw Postgres/Supabase:
 *   `updateErr.message` sull'update di `agency_review_sessions`.
 * Il fix lo sostituisce con un messaggio generico in italiano, loggando il
 * dettaglio raw solo server-side via `auditLog` (stesso pattern già
 * validato in cancel-respond/vehicle-token — nessun nuovo helper
 * introdotto).
 *
 * Come vehicle/[token], questa route non ha un try/catch esterno generico:
 * nessun secondo leak di tipo "catch" esiste da sanitizzare.
 */

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "review-token-abc123";
const FUTURE_EXPIRY = "2099-01-01T00:00:00Z";
const PAST_EXPIRY = "2020-01-01T00:00:00Z";

const DISTINCTIVE_RICH_ERROR =
  'duplicate key value violates unique constraint "agency_review_sessions_token_key" on relation "agency_review_sessions", column "token" SQLSTATE=23505';

type Row = Record<string, unknown>;

function createFakeAdmin(seed: { sessions?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    agency_review_sessions: [...(seed.sessions ?? [])],
  };
  const errors: Record<string, { message: string }> = {};

  function makeSelectBuilder(table: string) {
    let filtered = tables[table];
    const errKey = `${table}:select`;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] === value);
        return builder;
      },
      maybeSingle() {
        if (errors[errKey]) return Promise.resolve({ data: null, error: errors[errKey] });
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
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
          let filtered = tables[table];
          const errKey = `${table}:update`;
          const builder = {
            eq(field: string, value: unknown) {
              filtered = filtered.filter((r) => r[field] === value);
              return builder;
            },
            then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
              if (errors[errKey]) return Promise.resolve({ data: null, error: errors[errKey] }).then(resolve, reject);
              for (const row of filtered) Object.assign(row, payload);
              return Promise.resolve({ data: null, error: null }).then(resolve, reject);
            },
          };
          return builder;
        },
      };
    },
  };

  return {
    admin,
    tables,
    setError(table: string, op: "select" | "update", err: { message: string }) {
      errors[`${table}:${op}`] = err;
    },
  };
}

function baseSession(overrides: Row = {}) {
  return {
    id: SESSION_ID,
    tenant_id: TENANT_A,
    agency_name: "Agenzia XYZ",
    report_type: "daily_summary",
    target_date: "2026-08-15",
    services: [],
    status: "pending",
    expires_at: FUTURE_EXPIRY,
    token: TOKEN,
    ...overrides,
  };
}

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getVerifiedFromEmail: vi.fn(),
  resendFetch: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mocks.createClient,
}));
vi.mock("@/lib/server/send-email", () => ({
  getVerifiedFromEmail: mocks.getVerifiedFromEmail,
  resendFetch: mocks.resendFetch,
}));
vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: mocks.auditLog,
}));

import { GET, POST } from "@/app/api/agency-review/[token]/route";

function makeGetRequest() {
  return new NextRequest(`http://localhost:3010/api/agency-review/${TOKEN}`, { method: "GET" });
}
function callGet(token: string = TOKEN) {
  return GET(makeGetRequest(), { params: Promise.resolve({ token }) });
}

function makePostRequest(body: Record<string, unknown>) {
  return new NextRequest(`http://localhost:3010/api/agency-review/${TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function callPost(body: Record<string, unknown>, token: string = TOKEN) {
  return POST(makePostRequest(body), { params: Promise.resolve({ token }) });
}

function assertNoForbiddenFields(body: Record<string, unknown>) {
  expect(body).not.toHaveProperty("details");
  expect(body).not.toHaveProperty("hint");
  expect(body).not.toHaveProperty("code");
  expect(body).not.toHaveProperty("stack");
}

describe("SEC-06 — sanitizzazione errori su agency-review/[token]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Nessuna email verificata configurata: le funzioni di invio email
    // ritornano subito (comportamento preesistente, `if (!apiKey || !from) return;`)
    // senza toccare altre tabelle — isolamento pulito per i test di sanitizzazione.
    mocks.getVerifiedFromEmail.mockReturnValue(null);
  });

  it("1. success path invariato: approved riuscito → 200 { ok: true }", async () => {
    const fake = createFakeAdmin({ sessions: [baseSession()] });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ action: "approved" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("2. token invalido invariato (GET): 404 messaggio business invariato", async () => {
    const fake = createFakeAdmin({ sessions: [] });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callGet("token-inesistente");
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ error: "Sessione non trovata." });
  });

  it("3. not-found invariato (POST): 404 messaggio business invariato", async () => {
    const fake = createFakeAdmin({ sessions: [] });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ action: "approved" }, "token-inesistente");
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ error: "Sessione non trovata." });
  });

  it("4. business error invariato: link scaduto (410) e già risposto (409)", async () => {
    const fakeExpired = createFakeAdmin({ sessions: [baseSession({ expires_at: PAST_EXPIRY })] });
    mocks.createClient.mockReturnValue(fakeExpired.admin);
    const resExpired = await callPost({ action: "approved" });
    expect(resExpired.status).toBe(410);
    expect(await resExpired.json()).toEqual({ error: "Link scaduto." });

    const fakeAnswered = createFakeAdmin({ sessions: [baseSession({ status: "approved" })] });
    mocks.createClient.mockReturnValue(fakeAnswered.admin);
    const resAnswered = await callPost({ action: "approved" });
    expect(resAnswered.status).toBe(409);
    expect(await resAnswered.json()).toEqual({ error: "Già risposto." });

    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it("5. update error con violazione di vincolo univoco: nessun frammento raw nella risposta", async () => {
    const fake = createFakeAdmin({ sessions: [baseSession()] });
    fake.setError("agency_review_sessions", "update", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ action: "approved" });
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("duplicate key");
    expect(rawText).not.toContain("unique constraint");
  });

  it("6. constraint name NON presente", async () => {
    const fake = createFakeAdmin({ sessions: [baseSession()] });
    fake.setError("agency_review_sessions", "update", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ action: "approved" });
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("agency_review_sessions_token_key");
  });

  it("7. table/relation name NON presente", async () => {
    const fake = createFakeAdmin({ sessions: [baseSession()] });
    fake.setError("agency_review_sessions", "update", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ action: "approved" });
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("relation");
  });

  it("8. column name NON presente", async () => {
    const fake = createFakeAdmin({ sessions: [baseSession()] });
    fake.setError("agency_review_sessions", "update", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ action: "approved" });
    const rawText = await res.clone().text();

    expect(rawText).not.toContain('column "token"');
    expect(rawText).not.toContain("SQLSTATE");
  });

  it("9. fallback generico corretto", async () => {
    const fake = createFakeAdmin({ sessions: [baseSession()] });
    fake.setError("agency_review_sessions", "update", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    const body = await (await callPost({ action: "approved" })).json();

    expect(body).toEqual({ error: "Impossibile registrare la risposta." });
  });

  it("10. status HTTP invariato: resta 500", async () => {
    const fake = createFakeAdmin({ sessions: [baseSession()] });
    fake.setError("agency_review_sessions", "update", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ action: "approved" });

    expect(res.status).toBe(500);
  });

  it("11. nessun details/hint/code nel body", async () => {
    const fake = createFakeAdmin({ sessions: [baseSession()] });
    fake.setError("agency_review_sessions", "update", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    assertNoForbiddenFields(await (await callPost({ action: "approved" })).json());
  });

  it("12. nessun oggetto error serializzato: body.error è sempre una stringa", async () => {
    const fake = createFakeAdmin({ sessions: [baseSession()] });
    fake.setError("agency_review_sessions", "update", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    const body = await (await callPost({ action: "approved" })).json();

    expect(typeof body.error).toBe("string");
  });

  it("13. endpoint resta pubblico: POST senza Authorization raggiunge comunque la business logic", async () => {
    const fake = createFakeAdmin({ sessions: [baseSession()] });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ action: "approved" });

    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });

  it("14. nessuna auth introdotta: GET senza Authorization raggiunge comunque la business logic", async () => {
    const fake = createFakeAdmin({ sessions: [baseSession()] });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callGet();

    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });

  it("15. side effects invariati: nessuna email inviata quando l'update fallisce (il codice ritorna prima della logica email)", async () => {
    const fake = createFakeAdmin({ sessions: [baseSession()] });
    fake.setError("agency_review_sessions", "update", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    await callPost({ action: "approved" });

    expect(mocks.resendFetch).not.toHaveBeenCalled();
  });

  it("16. server-side logging avviene una sola volta per errore", async () => {
    const fake = createFakeAdmin({ sessions: [baseSession()] });
    fake.setError("agency_review_sessions", "update", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    await callPost({ action: "approved" });

    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    const logged = mocks.auditLog.mock.calls[0][0];
    expect(logged.level).toBe("error");
    expect(logged.tenantId).toBe(TENANT_A);
    expect(logged.details.message).toBe(DISTINCTIVE_RICH_ERROR);
  });

  it("17. response success invariata: body { ok: true } identico a prima", async () => {
    const fake = createFakeAdmin({ sessions: [baseSession()] });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ action: "modified", modifications: [] });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Object.keys(body)).toEqual(["ok"]);
    expect(body.ok).toBe(true);
  });

  it("18. nessuna mutazione aggiuntiva: quando l'update fallisce, lo status della sessione resta invariato (pending)", async () => {
    const fake = createFakeAdmin({ sessions: [baseSession()] });
    fake.setError("agency_review_sessions", "update", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    await callPost({ action: "approved" });

    const session = fake.tables.agency_review_sessions.find((s) => s.id === SESSION_ID);
    expect(session?.status).toBe("pending");
  });
});
