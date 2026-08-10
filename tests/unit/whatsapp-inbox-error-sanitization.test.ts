import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * Test SEC-06 Rollout 1 — sanitizzazione errori su app/api/ops/whatsapp-inbox/route.ts.
 *
 * Route autenticata (authorizePricingRequest), multi-azione (GET liste,
 * PATCH mark_read/close/reopen/delete/associate/update_phone/rename_contact,
 * POST invio manuale). Prima del fix, i raw Supabase error (`X.message`)
 * erano restituiti direttamente al client su ogni ramo DB fallito. Il fix
 * usa `sanitizedErrorResponse` (lib/server/api-error.ts) per ognuno di
 * questi rami, preservando status/field/business errors/side effects.
 *
 * Caso particolare: l'invio WhatsApp (POST) distingue un errore di business
 * del provider (sendWhatsApp* restituisce { ok:false, error }, NON un throw
 * — messaggio da preservare, fa parte del contratto operativo) da
 * un'eccezione interna imprevista (mustEnv/rete/bug — sanitizzata).
 */

type Row = Record<string, unknown>;

function createFakeAdmin(seed: Partial<Record<string, Row[]>> = {}) {
  const tables: Record<string, Row[]> = {
    whatsapp_threads: [],
    whatsapp_messages: [],
    whatsapp_message_statuses: [],
    whatsapp_contacts: [],
    whatsapp_templates: [],
    services: [],
    ...seed,
  };
  const errors: Record<string, { message: string }> = {};
  const calls: Record<string, number> = {};

  function bump(key: string) {
    calls[key] = (calls[key] ?? 0) + 1;
  }

  function applyOr(rows: Row[], filterStr: string) {
    const clauses = filterStr.split(",").map((c) => c.trim());
    return rows.filter((row) =>
      clauses.some((clause) => {
        const parts = clause.split(".");
        const field = parts[0];
        if (parts[parts.length - 1] === "null" && parts[parts.length - 2] === "is") {
          const isNot = parts.includes("not");
          const isNull = row[field] === null || row[field] === undefined;
          return isNot ? !isNull : isNull;
        }
        if (parts[1] === "eq") return String(row[field]) === parts[2];
        return true;
      })
    );
  }

  function selectBuilder(table: string) {
    let filtered = tables[table];
    const errKey = `${table}:select`;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] === value);
        return builder;
      },
      neq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] !== value);
        return builder;
      },
      gt(field: string, value: unknown) {
        filtered = filtered.filter((r) => Number(r[field] ?? 0) > Number(value));
        return builder;
      },
      is(field: string, value: null) {
        filtered = filtered.filter((r) => (r[field] ?? null) === value);
        return builder;
      },
      in(field: string, values: unknown[]) {
        filtered = filtered.filter((r) => values.includes(r[field]));
        return builder;
      },
      not() {
        return builder;
      },
      or(filterStr: string) {
        filtered = applyOr(filtered, filterStr);
        return builder;
      },
      order() {
        return builder;
      },
      limit(n: number) {
        filtered = filtered.slice(0, n);
        return builder;
      },
      maybeSingle() {
        bump(errKey);
        if (errors[errKey]) return Promise.resolve({ data: null, error: errors[errKey] });
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      single() {
        bump(errKey);
        if (errors[errKey]) return Promise.resolve({ data: null, error: errors[errKey] });
        return Promise.resolve({ data: filtered[0] ?? null, error: filtered[0] ? null : { message: "no rows" } });
      },
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        bump(errKey);
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
          return selectBuilder(table);
        },
        update(payload: Row) {
          let filtered = tables[table];
          const errKey = `${table}:update`;
          const builder = {
            eq(field: string, value: unknown) {
              filtered = filtered.filter((r) => r[field] === value);
              return builder;
            },
            or(filterStr: string) {
              filtered = applyOr(filtered, filterStr);
              return builder;
            },
            then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
              bump(errKey);
              if (errors[errKey]) return Promise.resolve({ data: null, error: errors[errKey] }).then(resolve, reject);
              for (const row of filtered) Object.assign(row, payload);
              return Promise.resolve({ data: null, error: null }).then(resolve, reject);
            },
          };
          return builder;
        },
        delete() {
          let filtered = tables[table];
          const errKey = `${table}:delete`;
          const builder = {
            eq(field: string, value: unknown) {
              filtered = filtered.filter((r) => r[field] === value);
              return builder;
            },
            in(field: string, values: unknown[]) {
              filtered = filtered.filter((r) => values.includes(r[field]));
              return builder;
            },
            or(filterStr: string) {
              filtered = applyOr(filtered, filterStr);
              return builder;
            },
            then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
              bump(errKey);
              if (errors[errKey]) return Promise.resolve({ data: null, error: errors[errKey] }).then(resolve, reject);
              const ids = new Set(filtered.map((r) => r.id));
              tables[table] = tables[table].filter((r) => !ids.has(r.id));
              return Promise.resolve({ data: null, error: null }).then(resolve, reject);
            },
          };
          return builder;
        },
        insert(rowsOrRow: Row | Row[]) {
          const rowsArr = Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow];
          const errKey = `${table}:insert`;
          return {
            then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
              bump(errKey);
              if (errors[errKey]) return Promise.resolve({ data: null, error: errors[errKey] }).then(resolve, reject);
              tables[table].push(...rowsArr);
              return Promise.resolve({ data: rowsArr, error: null }).then(resolve, reject);
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
    setError(table: string, op: "select" | "update" | "delete" | "insert", err: { message: string }) {
      errors[`${table}:${op}`] = err;
    },
  };
}

const RICH_RAW_ERROR =
  'duplicate key value violates unique constraint "whatsapp_threads_tenant_wa_id_key" on relation "whatsapp_threads", column "wa_id" SQLSTATE=23505';

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const THREAD_A1 = "11111111-1111-4111-8111-111111111111";
const THREAD_B1 = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  auditLog: vi.fn(),
  getTenantWhatsAppSettings: vi.fn(),
  isWhatsAppCustomerCareWindowOpen: vi.fn(),
  loadSyncedWhatsAppTemplates: vi.fn(),
  logWhatsAppEvent: vi.fn(),
  normalizeE164: vi.fn(),
  normalizeWhatsAppWaId: vi.fn(),
  sendWhatsAppMediaMessage: vi.fn(),
  sendWhatsAppMessage: vi.fn(),
  sendWhatsAppTextMessage: vi.fn(),
  matchWhatsAppInboundMessage: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));
vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: mocks.auditLog,
}));
vi.mock("@/lib/server/whatsapp", () => ({
  getTenantWhatsAppSettings: mocks.getTenantWhatsAppSettings,
  isWhatsAppCustomerCareWindowOpen: mocks.isWhatsAppCustomerCareWindowOpen,
  loadSyncedWhatsAppTemplates: mocks.loadSyncedWhatsAppTemplates,
  logWhatsAppEvent: mocks.logWhatsAppEvent,
  normalizeE164: mocks.normalizeE164,
  normalizeWhatsAppWaId: mocks.normalizeWhatsAppWaId,
  sendWhatsAppMediaMessage: mocks.sendWhatsAppMediaMessage,
  sendWhatsAppMessage: mocks.sendWhatsAppMessage,
  sendWhatsAppTextMessage: mocks.sendWhatsAppTextMessage,
}));
vi.mock("@/lib/server/whatsapp/matching", () => ({
  matchWhatsAppInboundMessage: mocks.matchWhatsAppInboundMessage,
}));

import { GET, PATCH, POST } from "@/app/api/ops/whatsapp-inbox/route";

function authorizeAs(admin: ReturnType<typeof createFakeAdmin>["admin"], role = "operator", tenantId = TENANT_A) {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: tenantId, role, suspended: false },
  });
}

function threadRow(id: string, tenantId: string, overrides: Row = {}): Row {
  return {
    id,
    tenant_id: tenantId,
    wa_id: "393331234567",
    phone_e164: "+393331234567",
    customer_id: null,
    booking_id: null,
    transfer_id: null,
    last_message_at: "2026-08-01T10:00:00Z",
    last_message_preview: "Ciao",
    unread_count: 1,
    assigned_to: null,
    status: "open",
    match_status: "matched",
    match_suggestions: [],
    contact_id: "contact-1",
    created_at: "2026-08-01T09:00:00Z",
    updated_at: "2026-08-01T10:00:00Z",
    whatsapp_contacts: null,
    ...overrides,
  };
}

function makeGetRequest(qs = "") {
  return new NextRequest(`http://localhost:3010/api/ops/whatsapp-inbox${qs}`);
}
function callGet(qs = "") {
  return GET(makeGetRequest(qs));
}

function makePatchRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/ops/whatsapp-inbox", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function callPatch(body: Record<string, unknown>) {
  return PATCH(makePatchRequest(body));
}

function makePostRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/ops/whatsapp-inbox", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function callPost(body: Record<string, unknown>) {
  return POST(makePostRequest(body));
}

function assertNoForbiddenFields(body: Record<string, unknown>) {
  expect(body).not.toHaveProperty("details");
  expect(body).not.toHaveProperty("hint");
  expect(body).not.toHaveProperty("code");
  expect(body).not.toHaveProperty("stack");
}

function assertNoRawFragments(rawText: string) {
  expect(rawText).not.toContain("duplicate key");
  expect(rawText).not.toContain("unique constraint");
  expect(rawText).not.toContain("SQLSTATE");
  expect(rawText).not.toContain("whatsapp_threads_tenant_wa_id_key");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTenantWhatsAppSettings.mockResolvedValue({
    default_template: "transfer_reminder",
    template_language: "it",
    enable_2h_reminder: false,
    allow_text_fallback: false,
    enable_arrival_messages: false,
    arrival_template: "arrival_welcome",
    arrival_notice_minutes: 90,
    bus_convocazioni_send_hour: 13,
  });
  mocks.loadSyncedWhatsAppTemplates.mockResolvedValue([]);
  mocks.normalizeWhatsAppWaId.mockImplementation((v: string) => `+${v}`);
  mocks.isWhatsAppCustomerCareWindowOpen.mockReturnValue(true);
});

describe("SEC-06 — GET /api/ops/whatsapp-inbox", () => {
  it("1. auth invariata: risposta 401 di authorizePricingRequest passa invariata, nessuna query DB", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const fake = createFakeAdmin();

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body).toEqual({ error: "Sessione non valida." });
    expect(fake.calls["whatsapp_threads:select"]).toBeUndefined();
  });

  it("2. tenant isolation invariata: thread di TENANT_B non compare nei risultati di TENANT_A", async () => {
    const fake = createFakeAdmin({
      whatsapp_threads: [threadRow(THREAD_A1, TENANT_A), threadRow(THREAD_B1, TENANT_B)],
    });
    authorizeAs(fake.admin);

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    const ids = (body.threads as Row[]).map((t) => t.id);
    expect(ids).toContain(THREAD_A1);
    expect(ids).not.toContain(THREAD_B1);
  });

  it("3. success principale invariato: 200 con threads/messages/template_options", async () => {
    const fake = createFakeAdmin({ whatsapp_threads: [threadRow(THREAD_A1, TENANT_A)] });
    authorizeAs(fake.admin);

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.threads)).toBe(true);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(Array.isArray(body.template_options)).toBe(true);
    expect(body.template_fetch_error).toBeNull();
  });

  it("6. DB select failure sanitizzata (lista conversazioni): nessun raw message, status 500 invariato", async () => {
    const fake = createFakeAdmin();
    fake.setError("whatsapp_threads", "select", { message: RICH_RAW_ERROR });
    authorizeAs(fake.admin);

    const res = await callGet();
    const rawText = await res.clone().text();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "Impossibile caricare le conversazioni." });
    assertNoRawFragments(rawText);
    assertNoForbiddenFields(body);
  });

  it("template_fetch_error: raw DB error di loadSyncedWhatsAppTemplates sanitizzato nel campo embedded del success body", async () => {
    const fake = createFakeAdmin({ whatsapp_threads: [] });
    authorizeAs(fake.admin);
    mocks.loadSyncedWhatsAppTemplates.mockRejectedValue(new Error(RICH_RAW_ERROR));

    const res = await callGet();
    const rawText = await res.clone().text();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.template_fetch_error).toBe("Impossibile caricare i template sincronizzati.");
    assertNoRawFragments(rawText);
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog.mock.calls[0][0].event).toBe("whatsapp_inbox_load_templates_failed");
    expect(mocks.auditLog.mock.calls[0][0].details.message).toBe(RICH_RAW_ERROR);
  });

  it("20/21. auditLog: event corretto e tenantId inoltrato sul leak di lista conversazioni", async () => {
    const fake = createFakeAdmin();
    fake.setError("whatsapp_threads", "select", { message: RICH_RAW_ERROR });
    authorizeAs(fake.admin);

    await callGet();

    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    const logged = mocks.auditLog.mock.calls[0][0];
    expect(logged.event).toBe("whatsapp_inbox_list_threads_failed");
    expect(logged.level).toBe("error");
    expect(logged.tenantId).toBe(TENANT_A);
    expect(logged.details.message).toBe(RICH_RAW_ERROR);
  });

  it("22. nessuna PII nei details dell'audit log (nessun numero di telefono/nome cliente)", async () => {
    const fake = createFakeAdmin();
    fake.setError("whatsapp_threads", "select", { message: RICH_RAW_ERROR });
    authorizeAs(fake.admin);

    await callGet();

    const details = JSON.stringify(mocks.auditLog.mock.calls[0][0].details);
    expect(details).not.toContain("+393");
    expect(details).not.toContain("393331234567");
  });
});

describe("SEC-06 — PATCH /api/ops/whatsapp-inbox", () => {
  it("5. validation error invariato: azione mancante/non valida -> 400 con messaggio zod", async () => {
    const fake = createFakeAdmin();
    authorizeAs(fake.admin);

    const res = await callPatch({ thread_id: THREAD_A1, action: "not_a_real_action" });
    expect(res.status).toBe(400);
  });

  it("4. business error principale invariato: thread_id inesistente su mark_read -> nessuna eccezione, aggiornamento no-op, 200", async () => {
    const fake = createFakeAdmin({ whatsapp_threads: [] });
    authorizeAs(fake.admin);

    const res = await callPatch({ thread_id: THREAD_A1, action: "mark_read" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("7. DB update failure sanitizzata (mark_read/close/reopen): nessun raw message, status 500 invariato", async () => {
    const fake = createFakeAdmin({ whatsapp_threads: [threadRow(THREAD_A1, TENANT_A)] });
    fake.setError("whatsapp_threads", "update", { message: RICH_RAW_ERROR });
    authorizeAs(fake.admin);

    const res = await callPatch({ thread_id: THREAD_A1, action: "close" });
    const rawText = await res.clone().text();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "Impossibile aggiornare la conversazione." });
    assertNoRawFragments(rawText);
    assertNoForbiddenFields(body);
  });

  it("delete: DB select failure sanitizzata (lookup thread)", async () => {
    const fake = createFakeAdmin();
    fake.setError("whatsapp_threads", "select", { message: RICH_RAW_ERROR });
    authorizeAs(fake.admin);

    const res = await callPatch({ thread_id: THREAD_A1, action: "delete" });
    const rawText = await res.clone().text();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "Impossibile eliminare la conversazione." });
    assertNoRawFragments(rawText);
  });

  it("delete: DB delete failure sanitizzata (whatsapp_threads)", async () => {
    const fake = createFakeAdmin({ whatsapp_threads: [threadRow(THREAD_A1, TENANT_A)] });
    fake.setError("whatsapp_threads", "delete", { message: RICH_RAW_ERROR });
    authorizeAs(fake.admin);

    const res = await callPatch({ thread_id: THREAD_A1, action: "delete" });
    const rawText = await res.clone().text();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "Impossibile eliminare la conversazione." });
    assertNoRawFragments(rawText);
  });

  it("delete: business error principale invariato: thread non trovato -> 404 invariato", async () => {
    const fake = createFakeAdmin({ whatsapp_threads: [] });
    authorizeAs(fake.admin);

    const res = await callPatch({ thread_id: THREAD_A1, action: "delete" });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ error: "Conversazione non trovata" });
  });

  it("update_phone: validation business error preservato (Numero non valido)", async () => {
    const fake = createFakeAdmin({ whatsapp_threads: [threadRow(THREAD_A1, TENANT_A)] });
    authorizeAs(fake.admin);
    mocks.normalizeE164.mockImplementation(() => {
      throw new Error("Numero non valido");
    });

    const res = await callPatch({ thread_id: THREAD_A1, action: "update_phone", phone: "abcdef" });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Numero non valido");
  });

  it("update_phone: DB update failure sanitizzata (whatsapp_threads)", async () => {
    const fake = createFakeAdmin({ whatsapp_threads: [threadRow(THREAD_A1, TENANT_A, { contact_id: null })] });
    fake.setError("whatsapp_threads", "update", { message: RICH_RAW_ERROR });
    authorizeAs(fake.admin);
    mocks.normalizeE164.mockReturnValue("+393339998877");

    const res = await callPatch({ thread_id: THREAD_A1, action: "update_phone", phone: "+393339998877" });
    const rawText = await res.clone().text();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "Impossibile aggiornare il numero di telefono." });
    assertNoRawFragments(rawText);
  });

  it("24. nessun doppio logging: auditLog invocato esattamente una volta per singolo leak", async () => {
    const fake = createFakeAdmin({ whatsapp_threads: [threadRow(THREAD_A1, TENANT_A)] });
    fake.setError("whatsapp_threads", "update", { message: RICH_RAW_ERROR });
    authorizeAs(fake.admin);

    await callPatch({ thread_id: THREAD_A1, action: "close" });

    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
  });
});

describe("SEC-06 — POST /api/ops/whatsapp-inbox (invio manuale)", () => {
  it("business/provider error preservato: sendWhatsAppTextMessage risponde ok:false (non un'eccezione) -> messaggio provider invariato", async () => {
    const fake = createFakeAdmin({ whatsapp_threads: [threadRow(THREAD_A1, TENANT_A)] });
    authorizeAs(fake.admin);
    mocks.sendWhatsAppTextMessage.mockResolvedValue({
      ok: false,
      error: "Recipient phone number not in allowed list",
      phoneE164: "+393331234567",
    });

    const res = await callPost({ thread_id: THREAD_A1, mode: "text", text: "Ciao!" });
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body).toEqual({ error: "Recipient phone number not in allowed list" });
  });

  it("10. catch/internal Error sanitizzato: eccezione interna imprevista durante l'invio -> messaggio generico, nessun raw", async () => {
    const fake = createFakeAdmin({ whatsapp_threads: [threadRow(THREAD_A1, TENANT_A)] });
    authorizeAs(fake.admin);
    mocks.sendWhatsAppTextMessage.mockRejectedValue(new Error("WHATSAPP_PHONE_NUMBER_ID env var mancante"));

    const res = await callPost({ thread_id: THREAD_A1, mode: "text", text: "Ciao!" });
    const rawText = await res.clone().text();
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body).toEqual({ error: "Invio WhatsApp non riuscito." });
    expect(rawText).not.toContain("WHATSAPP_PHONE_NUMBER_ID");
    assertNoForbiddenFields(body);
  });

  it("20/21. auditLog per l'eccezione interna: event corretto, tenantId inoltrato", async () => {
    const fake = createFakeAdmin({ whatsapp_threads: [threadRow(THREAD_A1, TENANT_A)] });
    authorizeAs(fake.admin);
    mocks.sendWhatsAppTextMessage.mockRejectedValue(new Error("network fetch failed"));

    await callPost({ thread_id: THREAD_A1, mode: "text", text: "Ciao!" });

    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    const logged = mocks.auditLog.mock.calls[0][0];
    expect(logged.event).toBe("whatsapp_inbox_send_internal_error");
    expect(logged.tenantId).toBe(TENANT_A);
    expect(logged.details.message).toBe("network fetch failed");
  });

  it("12/13. status e response field invariati sul ramo success", async () => {
    const fake = createFakeAdmin({ whatsapp_threads: [threadRow(THREAD_A1, TENANT_A)] });
    authorizeAs(fake.admin);
    mocks.sendWhatsAppTextMessage.mockResolvedValue({ ok: true, messageId: "wamid.123", phoneE164: "+393331234567" });

    const res = await callPost({ thread_id: THREAD_A1, mode: "text", text: "Ciao!" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, thread_id: THREAD_A1, message_id: "wamid.123", phone_e164: "+393331234567" });
  });

  it("6b. DB select failure sanitizzata (lookup thread per invio)", async () => {
    const fake = createFakeAdmin();
    fake.setError("whatsapp_threads", "select", { message: RICH_RAW_ERROR });
    authorizeAs(fake.admin);

    const res = await callPost({ thread_id: THREAD_A1, mode: "text", text: "Ciao!" });
    const rawText = await res.clone().text();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "Impossibile caricare la conversazione." });
    assertNoRawFragments(rawText);
  });

  it("business error principale invariato: thread inesistente -> 404 'Conversazione non trovata'", async () => {
    const fake = createFakeAdmin({ whatsapp_threads: [] });
    authorizeAs(fake.admin);

    const res = await callPost({ thread_id: THREAD_A1, mode: "text", text: "Ciao!" });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ error: "Conversazione non trovata" });
  });

  it("5b. validation error invariato: nessun thread_id né phone -> 400 con messaggio zod custom", async () => {
    const fake = createFakeAdmin();
    authorizeAs(fake.admin);

    const res = await callPost({ mode: "text", text: "Ciao!" });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Seleziona una conversazione o inserisci un numero.");
  });
});
