import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Test SEC-06 — sanitizzazione errori su GET/POST /api/public/service-quotes/accept.
 *
 * Endpoint pubblico (nessuna autenticazione richiesta): pagina di
 * accettazione preventivo raggiunta tramite link email con token. Prima del
 * fix, un punto restituiva al client il messaggio raw Postgres/Supabase:
 *   `updateErr.message` sull'update di `service_quotes` (accettazione).
 * Il fix lo sostituisce con un messaggio generico in italiano, loggando il
 * dettaglio raw solo server-side via `auditLog` (stesso pattern già
 * validato in cancel-respond/vehicle-token/agency-review — nessun nuovo
 * helper introdotto).
 *
 * Come vehicle/[token] e agency-review/[token], questa route non ha un
 * try/catch esterno generico e non chiama alcuna RPC: un solo leak reale
 * esiste (confermato leggendo integralmente il codice), non se ne inventano
 * altri.
 */

const QUOTE_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";
const FUTURE_EXPIRY = "2099-01-01T00:00:00.000Z";
const PAST_EXPIRY = "2020-01-01T00:00:00.000Z";

const DISTINCTIVE_RICH_ERROR =
  'duplicate key value violates unique constraint "service_quotes_accept_token_key" on relation "service_quotes", column "accept_token" SQLSTATE=23505';

type Row = Record<string, unknown>;

function createFakeAdmin(seed: { quotes?: Row[]; items?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    service_quotes: [...(seed.quotes ?? [])],
    service_quote_items: [...(seed.items ?? [])],
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
      order() {
        return builder;
      },
      single() {
        if (errors[errKey]) return Promise.resolve({ data: null, error: errors[errKey] });
        return Promise.resolve({ data: filtered[0] ?? null, error: filtered[0] ? null : { message: "no rows" } });
      },
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        if (errors[errKey]) return Promise.resolve({ data: null, error: errors[errKey] }).then(resolve, reject);
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
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

function baseQuote(overrides: Row = {}) {
  return {
    id: QUOTE_ID,
    tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    accept_token: TOKEN,
    quote_number: "Q-2026-001",
    status: "offer_sent",
    customer_first_name: "Mario",
    customer_last_name: "Rossi",
    customer_language: "it",
    service_type: "transfer",
    direction: "arrival",
    price_cents: 5000,
    price_mode: "fixed",
    currency: "EUR",
    accept_token_expires_at: FUTURE_EXPIRY,
    ...overrides,
  };
}

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mocks.createClient,
}));
vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: mocks.auditLog,
}));

import { GET, POST } from "@/app/api/public/service-quotes/accept/route";

function callGet(token: string | null) {
  const url = new URL("http://localhost:3010/api/public/service-quotes/accept");
  if (token !== null) url.searchParams.set("token", token);
  return GET(new NextRequest(url));
}
function callPost(token: string | null) {
  const url = new URL("http://localhost:3010/api/public/service-quotes/accept");
  if (token !== null) url.searchParams.set("token", token);
  return POST(new NextRequest(url, { method: "POST" }));
}

function assertNoForbiddenFields(body: Record<string, unknown>) {
  expect(body).not.toHaveProperty("details");
  expect(body).not.toHaveProperty("hint");
  expect(body).not.toHaveProperty("code");
  expect(body).not.toHaveProperty("stack");
}

describe("SEC-06 — sanitizzazione errori su public/service-quotes/accept", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. success path invariato: accettazione riuscita → 200 { ok: true, already_accepted: false }", async () => {
    const fake = createFakeAdmin({ quotes: [baseQuote()] });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost(TOKEN);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, already_accepted: false });
  });

  it("1b. success path GET invariato: preventivo trovato → 200 con quote e items", async () => {
    const fake = createFakeAdmin({ quotes: [baseQuote()], items: [] });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callGet(TOKEN);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.quote.id).toBe(QUOTE_ID);
    expect(body.quote.items).toEqual([]);
  });

  it("2. body/token invalido invariato: formato token non valido → 400", async () => {
    const fake = createFakeAdmin({ quotes: [baseQuote()] });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost("not-a-valid-token");
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "Token non valido." });
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it("3. not-found/business error invariato: token sconosciuto → 404", async () => {
    const fake = createFakeAdmin({ quotes: [] });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost(TOKEN);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ error: "Preventivo non trovato." });
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it("4. conflict/already-accepted invariato: già accettato → 200 already_accepted:true; stato non idoneo → 409; offerta scaduta → 410", async () => {
    const fakeAccepted = createFakeAdmin({ quotes: [baseQuote({ status: "accepted" })] });
    mocks.createClient.mockReturnValue(fakeAccepted.admin);
    const resAccepted = await callPost(TOKEN);
    expect(resAccepted.status).toBe(200);
    expect(await resAccepted.json()).toEqual({ ok: true, already_accepted: true });

    const fakeDraft = createFakeAdmin({ quotes: [baseQuote({ status: "draft" })] });
    mocks.createClient.mockReturnValue(fakeDraft.admin);
    const resDraft = await callPost(TOKEN);
    expect(resDraft.status).toBe(409);
    expect(await resDraft.json()).toEqual({ error: "Offerta non disponibile per l'accettazione." });

    const fakeExpired = createFakeAdmin({ quotes: [baseQuote({ accept_token_expires_at: PAST_EXPIRY })] });
    mocks.createClient.mockReturnValue(fakeExpired.admin);
    const resExpired = await callPost(TOKEN);
    expect(resExpired.status).toBe(410);
    expect(await resExpired.json()).toEqual({ error: "L'offerta è scaduta." });

    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it("5. update error con violazione di vincolo univoco: nessun frammento raw nella risposta", async () => {
    const fake = createFakeAdmin({ quotes: [baseQuote()] });
    fake.setError("service_quotes", "update", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost(TOKEN);
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("duplicate key");
    expect(rawText).not.toContain("unique constraint");
  });

  it("6. constraint name NON presente", async () => {
    const fake = createFakeAdmin({ quotes: [baseQuote()] });
    fake.setError("service_quotes", "update", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost(TOKEN);
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("service_quotes_accept_token_key");
  });

  it("7. relation/table name NON presente", async () => {
    const fake = createFakeAdmin({ quotes: [baseQuote()] });
    fake.setError("service_quotes", "update", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost(TOKEN);
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("relation");
  });

  it("8. column name NON presente", async () => {
    const fake = createFakeAdmin({ quotes: [baseQuote()] });
    fake.setError("service_quotes", "update", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost(TOKEN);
    const rawText = await res.clone().text();

    expect(rawText).not.toContain('column "accept_token"');
  });

  it("9. SQLSTATE/code NON presente", async () => {
    const fake = createFakeAdmin({ quotes: [baseQuote()] });
    fake.setError("service_quotes", "update", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost(TOKEN);
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("SQLSTATE");
  });

  it("10. details/hint NON presenti nel body", async () => {
    const fake = createFakeAdmin({ quotes: [baseQuote()] });
    fake.setError("service_quotes", "update", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    assertNoForbiddenFields(await (await callPost(TOKEN)).json());
  });

  it("11. fallback generico corretto", async () => {
    const fake = createFakeAdmin({ quotes: [baseQuote()] });
    fake.setError("service_quotes", "update", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    const body = await (await callPost(TOKEN)).json();

    expect(body).toEqual({ error: "Impossibile completare l'accettazione del preventivo." });
  });

  it("12. status HTTP invariato: resta 500", async () => {
    const fake = createFakeAdmin({ quotes: [baseQuote()] });
    fake.setError("service_quotes", "update", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost(TOKEN);

    expect(res.status).toBe(500);
  });

  it("13. response shape invariata: solo { error }", async () => {
    const fake = createFakeAdmin({ quotes: [baseQuote()] });
    fake.setError("service_quotes", "update", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    const body = await (await callPost(TOKEN)).json();

    expect(Object.keys(body)).toEqual(["error"]);
  });

  it("14. nessun oggetto error serializzato: body.error è sempre una stringa", async () => {
    const fake = createFakeAdmin({ quotes: [baseQuote()] });
    fake.setError("service_quotes", "update", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    const body = await (await callPost(TOKEN)).json();

    expect(typeof body.error).toBe("string");
  });

  it("15. endpoint resta pubblico: nessuna auth introdotta, GET/POST senza Authorization raggiungono la business logic", async () => {
    const fake = createFakeAdmin({ quotes: [baseQuote()] });
    mocks.createClient.mockReturnValue(fake.admin);

    const resGet = await callGet(TOKEN);
    expect(resGet.status).not.toBe(401);

    const fake2 = createFakeAdmin({ quotes: [baseQuote()] });
    mocks.createClient.mockReturnValue(fake2.admin);
    const resPost = await callPost(TOKEN);
    expect(resPost.status).not.toBe(401);
  });

  it("16. success side effects invariati: accettazione riuscita aggiorna status/accepted_at/accepted_ip", async () => {
    const fake = createFakeAdmin({ quotes: [baseQuote()] });
    mocks.createClient.mockReturnValue(fake.admin);

    await callPost(TOKEN);

    const quote = fake.tables.service_quotes.find((q) => q.id === QUOTE_ID);
    expect(quote?.status).toBe("accepted");
    expect(typeof quote?.accepted_at).toBe("string");
  });

  it("17. nessuna mutazione aggiuntiva quando l'update fallisce: status della quote resta invariato (offer_sent)", async () => {
    const fake = createFakeAdmin({ quotes: [baseQuote()] });
    fake.setError("service_quotes", "update", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    await callPost(TOKEN);

    const quote = fake.tables.service_quotes.find((q) => q.id === QUOTE_ID);
    expect(quote?.status).toBe("offer_sent");
  });

  it("18. auditLog invocato una sola volta per errore sanitizzato", async () => {
    const fake = createFakeAdmin({ quotes: [baseQuote()] });
    fake.setError("service_quotes", "update", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    await callPost(TOKEN);

    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    const logged = mocks.auditLog.mock.calls[0][0];
    expect(logged.level).toBe("error");
    expect(logged.details.quoteId).toBe(QUOTE_ID);
    expect(logged.details.message).toBe(DISTINCTIVE_RICH_ERROR);
  });
});
