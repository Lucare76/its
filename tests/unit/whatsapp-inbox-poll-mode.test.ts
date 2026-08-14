import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Sprint Performance 5 — poll leggero (poll_mode=1) per GET /api/ops/whatsapp-inbox.
 *
 * Copre: nessuna query "services" in poll_mode (chiave "service" assente dal
 * thread), nessun auto-select del primo thread quando non è stato passato
 * thread_id, messaggi incrementali via cursore messages_after/messages_after_id
 * (con tie-break su id per created_at identici), status_updates limitati ai
 * messaggi outbound non ancora in stato definitivo, e retrocompatibilità del
 * GET normale (senza poll_mode) che resta invariato.
 */

type Row = Record<string, unknown>;

function splitTopLevelClauses(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of input) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function evalOrClause(row: Row, clause: string): boolean {
  const match = clause.match(/^([a-zA-Z_.]+)\.(not\.)?(eq|is|ilike|in)\.(.*)$/);
  if (!match) return false;
  const [, field, notPrefix, op, rawValue] = match;
  let result: boolean;
  if (op === "is") {
    const isNull = row[field] === null || row[field] === undefined;
    result = rawValue === "null" ? isNull : String(row[field]) === rawValue;
  } else if (op === "ilike") {
    result = typeof row[field] === "string" && (row[field] as string).toLowerCase().includes(rawValue.replace(/^%/, "").replace(/%$/, "").toLowerCase());
  } else if (op === "in") {
    const ids = rawValue.replace(/^\(/, "").replace(/\)$/, "").split(",").filter(Boolean);
    result = ids.includes(String(row[field]));
  } else {
    result = String(row[field]) === rawValue;
  }
  return notPrefix ? !result : result;
}

function selectBuilder(rows: Row[]) {
  let filtered = rows;
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
      filtered = filtered.filter((r) => String(r[field] ?? "") > String(value));
      return builder;
    },
    gte(field: string, value: unknown) {
      filtered = filtered.filter((r) => String(r[field] ?? "") >= String(value));
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
    ilike(field: string, pattern: string) {
      const needle = pattern.replace(/^%/, "").replace(/%$/, "").toLowerCase();
      filtered = filtered.filter((r) => typeof r[field] === "string" && (r[field] as string).toLowerCase().includes(needle));
      return builder;
    },
    or(filterStr: string) {
      const clauses = splitTopLevelClauses(filterStr);
      filtered = filtered.filter((r) => clauses.some((clause) => evalOrClause(r, clause)));
      return builder;
    },
    order() {
      return builder;
    },
    limit(n: number) {
      filtered = filtered.slice(0, n);
      return builder;
    },
    range(from: number, to: number) {
      filtered = filtered.slice(from, to + 1);
      return builder;
    },
    then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
    },
  };
  return builder;
}

function createFakeAdmin(seed: Partial<Record<string, Row[]>> = {}) {
  const tables: Record<string, Row[]> = {
    whatsapp_threads: [],
    whatsapp_contacts: [],
    whatsapp_messages: [],
    whatsapp_message_statuses: [],
    services: [],
    ...seed,
  };
  const selectCalls: string[] = [];
  const admin = {
    from(table: string) {
      return {
        select: () => {
          selectCalls.push(table);
          return selectBuilder(tables[table] ?? []);
        },
      };
    },
  };
  return { admin, tables, selectCalls };
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  auditLog: vi.fn(),
  getTenantWhatsAppSettings: vi.fn(),
  loadSyncedWhatsAppTemplates: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));
vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: mocks.auditLog,
}));
vi.mock("@/lib/server/whatsapp", () => ({
  getTenantWhatsAppSettings: mocks.getTenantWhatsAppSettings,
  isWhatsAppCustomerCareWindowOpen: vi.fn(),
  loadSyncedWhatsAppTemplates: mocks.loadSyncedWhatsAppTemplates,
  logWhatsAppEvent: vi.fn(),
  normalizeE164: vi.fn(),
  normalizeWhatsAppWaId: vi.fn(),
  sendWhatsAppMediaMessage: vi.fn(),
  sendWhatsAppMessage: vi.fn(),
  sendWhatsAppTextMessage: vi.fn(),
}));
vi.mock("@/lib/server/whatsapp/matching", () => ({
  matchWhatsAppInboundMessage: vi.fn(),
}));

import { GET } from "@/app/api/ops/whatsapp-inbox/route";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function authorizeAs(admin: ReturnType<typeof createFakeAdmin>["admin"], tenantId = TENANT_A) {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: tenantId, role: "operator", suspended: false },
  });
}

function thread(id: string, tenantId: string, overrides: Row = {}): Row {
  return {
    id,
    tenant_id: tenantId,
    wa_id: `39333000${id.slice(-4)}`,
    phone_e164: `+39333000${id.slice(-4)}`,
    customer_id: null,
    booking_id: null,
    transfer_id: null,
    contact_id: null,
    last_message_at: "2026-08-01T10:00:00Z",
    last_message_preview: "Ciao",
    unread_count: 0,
    assigned_to: null,
    status: "open",
    match_status: "matched",
    match_suggestions: [],
    created_at: "2026-08-01T09:00:00Z",
    updated_at: "2026-08-01T10:00:00Z",
    ...overrides,
  };
}

function message(id: string, threadId: string, tenantId: string, overrides: Row = {}): Row {
  return {
    id,
    tenant_id: tenantId,
    thread_id: threadId,
    wa_message_id: `wamid.${id}`,
    reply_to_wa_message_id: null,
    direction: "inbound",
    wa_id: "393330001234",
    phone_e164: "+393330001234",
    message_type: "text",
    template_name: null,
    text_body: `Testo ${id}`,
    media_id: null,
    media_mime_type: null,
    status: "received",
    timestamp: "2026-08-01T10:00:00Z",
    created_at: "2026-08-01T10:00:00Z",
    booking_id: null,
    transfer_id: null,
    raw_message: null,
    ...overrides,
  };
}

function callGet(qs = "") {
  return GET(new NextRequest(`http://localhost:3010/api/ops/whatsapp-inbox${qs}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTenantWhatsAppSettings.mockResolvedValue({
    default_template: "transfer_reminder",
    template_language: "it",
    arrival_template: "arrival_welcome",
  });
  mocks.loadSyncedWhatsAppTemplates.mockResolvedValue([]);
});

describe("poll_mode=1 — niente template/settings/services", () => {
  it("non chiama getTenantWhatsAppSettings/loadSyncedWhatsAppTemplates", async () => {
    const fake = createFakeAdmin({ whatsapp_threads: [thread("t1", TENANT_A)] });
    authorizeAs(fake.admin);

    const res = await callGet("?filter=open&poll_mode=1");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.getTenantWhatsAppSettings).not.toHaveBeenCalled();
    expect(mocks.loadSyncedWhatsAppTemplates).not.toHaveBeenCalled();
    expect(body.templates_included).toBe(false);
    expect(body.template_options).toEqual([]);
  });

  it("non interroga la tabella services e omette la chiave 'service' dal thread", async () => {
    const fake = createFakeAdmin({
      whatsapp_threads: [thread("t1", TENANT_A, { booking_id: "svc-1" })],
      services: [{ id: "svc-1", customer_name: "Mario Rossi", tenant_id: TENANT_A }],
    });
    authorizeAs(fake.admin);

    const res = await callGet("?filter=open&poll_mode=1&thread_id=t1");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(fake.selectCalls).not.toContain("services");
    expect("service" in body.threads[0]).toBe(false);
  });

  it("il GET normale (senza poll_mode) resta invariato: services interrogato e 'service' presente", async () => {
    const fake = createFakeAdmin({
      whatsapp_threads: [thread("t1", TENANT_A, { booking_id: "svc-1" })],
      services: [{ id: "svc-1", customer_name: "Mario Rossi", tenant_id: TENANT_A }],
    });
    authorizeAs(fake.admin);

    const res = await callGet("?filter=open&thread_id=t1");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(fake.selectCalls).toContain("services");
    expect(body.threads[0].service?.id).toBe("svc-1");
  });
});

describe("poll_mode=1 — nessun thread selezionato", () => {
  it("non fa auto-select del primo thread e non legge messaggi", async () => {
    const fake = createFakeAdmin({
      whatsapp_threads: [thread("t1", TENANT_A)],
      whatsapp_messages: [message("m1", "t1", TENANT_A)],
    });
    authorizeAs(fake.admin);

    const res = await callGet("?filter=open&poll_mode=1");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.selected_thread_id).toBeNull();
    expect(body.messages).toEqual([]);
    expect(body.status_updates).toEqual([]);
  });
});

describe("poll_mode=1 — messaggi incrementali (messages_after/messages_after_id)", () => {
  it("senza cursore: fallback a fetch completo, messages_mode='full'", async () => {
    const fake = createFakeAdmin({
      whatsapp_threads: [thread("t1", TENANT_A)],
      whatsapp_messages: [
        message("m1", "t1", TENANT_A, { created_at: "2026-08-01T10:00:00.000Z" }),
        message("m2", "t1", TENANT_A, { created_at: "2026-08-01T10:01:00.000Z" }),
      ],
    });
    authorizeAs(fake.admin);

    const res = await callGet("?filter=open&poll_mode=1&thread_id=t1");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.messages_mode).toBe("full");
    expect(body.messages).toHaveLength(2);
  });

  it("con cursore: restituisce solo i messaggi dopo il cursore, messages_mode='incremental'", async () => {
    const fake = createFakeAdmin({
      whatsapp_threads: [thread("t1", TENANT_A)],
      whatsapp_messages: [
        message("m1", "t1", TENANT_A, { created_at: "2026-08-01T10:00:00.000Z" }),
        message("m2", "t1", TENANT_A, { created_at: "2026-08-01T10:01:00.000Z" }),
        message("m3", "t1", TENANT_A, { created_at: "2026-08-01T10:02:00.000Z" }),
      ],
    });
    authorizeAs(fake.admin);

    const res = await callGet(
      "?filter=open&poll_mode=1&thread_id=t1&messages_after=2026-08-01T10%3A01%3A00.000Z&messages_after_id=m2"
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.messages_mode).toBe("incremental");
    expect((body.messages as Row[]).map((m) => m.id)).toEqual(["m3"]);
  });

  it("tie-break per created_at identico: esclude il messaggio-cursore, include solo id maggiore", async () => {
    const fake = createFakeAdmin({
      whatsapp_threads: [thread("t1", TENANT_A)],
      whatsapp_messages: [
        message("ma", "t1", TENANT_A, { created_at: "2026-08-01T10:00:00.000Z" }),
        message("mb", "t1", TENANT_A, { created_at: "2026-08-01T10:00:00.000Z" }),
      ],
    });
    authorizeAs(fake.admin);

    const res = await callGet(
      "?filter=open&poll_mode=1&thread_id=t1&messages_after=2026-08-01T10%3A00%3A00.000Z&messages_after_id=ma"
    );
    const body = await res.json();

    expect(body.messages_mode).toBe("incremental");
    expect((body.messages as Row[]).map((m) => m.id)).toEqual(["mb"]);
  });

  it("nessun messaggio nuovo: array messages vuoto, nessun errore", async () => {
    const fake = createFakeAdmin({
      whatsapp_threads: [thread("t1", TENANT_A)],
      whatsapp_messages: [message("m1", "t1", TENANT_A, { created_at: "2026-08-01T10:00:00.000Z" })],
    });
    authorizeAs(fake.admin);

    const res = await callGet(
      "?filter=open&poll_mode=1&thread_id=t1&messages_after=2026-08-01T10%3A00%3A00.000Z&messages_after_id=m1"
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.messages).toEqual([]);
  });

  it("risolve l'anteprima reply_to per un messaggio più vecchio non incluso nel batch incrementale", async () => {
    const fake = createFakeAdmin({
      whatsapp_threads: [thread("t1", TENANT_A)],
      whatsapp_messages: [
        message("old", "t1", TENANT_A, {
          created_at: "2026-08-01T09:00:00.000Z",
          wa_message_id: "wamid.old",
          text_body: "Messaggio originale",
        }),
        message("m2", "t1", TENANT_A, { created_at: "2026-08-01T10:01:00.000Z" }),
        message("new", "t1", TENANT_A, {
          created_at: "2026-08-01T10:02:00.000Z",
          reply_to_wa_message_id: "wamid.old",
        }),
      ],
    });
    authorizeAs(fake.admin);

    const res = await callGet(
      "?filter=open&poll_mode=1&thread_id=t1&messages_after=2026-08-01T10%3A01%3A00.000Z&messages_after_id=m2"
    );
    const body = await res.json();

    const newMsg = (body.messages as Row[]).find((m) => m.id === "new") as Row;
    expect((newMsg.reply_to_message as Row).preview).toBe("Messaggio originale");
  });
});

describe("poll_mode=1 — status_updates (spunte messaggi outbound)", () => {
  it("include solo i messaggi outbound non in stato definitivo, con lo status più recente", async () => {
    const fake = createFakeAdmin({
      whatsapp_threads: [thread("t1", TENANT_A)],
      whatsapp_messages: [
        message("m1", "t1", TENANT_A, { created_at: "2026-08-01T10:00:00.000Z" }),
        message("out-pending", "t1", TENANT_A, {
          created_at: "2026-08-01T09:55:00.000Z",
          direction: "outbound",
          wa_message_id: "wamid.out-pending",
          status: "sent",
        }),
        message("out-read", "t1", TENANT_A, {
          created_at: "2026-08-01T09:50:00.000Z",
          direction: "outbound",
          wa_message_id: "wamid.out-read",
          status: "read",
        }),
        message("out-failed", "t1", TENANT_A, {
          created_at: "2026-08-01T09:45:00.000Z",
          direction: "outbound",
          wa_message_id: "wamid.out-failed",
          status: "failed",
        }),
      ],
      whatsapp_message_statuses: [
        { wa_message_id: "wamid.out-pending", status: "delivered", created_at: "2026-08-01T09:56:00.000Z", tenant_id: TENANT_A, raw_status: null },
      ],
    });
    authorizeAs(fake.admin);

    const res = await callGet(
      "?filter=open&poll_mode=1&thread_id=t1&messages_after=2026-08-01T10%3A00%3A00.000Z&messages_after_id=m1"
    );
    const body = await res.json();

    expect(body.status_updates).toHaveLength(1);
    expect(body.status_updates[0]).toMatchObject({
      wa_message_id: "wamid.out-pending",
      status: "delivered",
    });
  });

  it("nessun messaggio outbound pendente: status_updates vuoto", async () => {
    const fake = createFakeAdmin({
      whatsapp_threads: [thread("t1", TENANT_A)],
      whatsapp_messages: [message("m1", "t1", TENANT_A, { created_at: "2026-08-01T10:00:00.000Z" })],
    });
    authorizeAs(fake.admin);

    const res = await callGet(
      "?filter=open&poll_mode=1&thread_id=t1&messages_after=2026-08-01T10%3A00%3A00.000Z&messages_after_id=m1"
    );
    const body = await res.json();

    expect(body.status_updates).toEqual([]);
  });
});
