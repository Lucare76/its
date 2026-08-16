import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Sprint Performance 4 — test minimi per la paginazione server-side della
 * lista thread WhatsApp e per la ricerca lato DB (sostituisce il vecchio
 * pattern "fetch fino a 5000 thread + filtro in JavaScript").
 *
 * Fake Supabase admin dedicato: a differenza di whatsapp-inbox-error-sanitization.test.ts
 * (che copre la sanitizzazione errori), qui serve un mock che capisca .range(),
 * .ilike() e clausole .or() con .in.(id1,id2) — non presenti nel fake esistente.
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

function fieldValue(row: Row, field: string): unknown {
  if (field === "hotels.name") return (row.hotels as Row | undefined)?.name ?? null;
  return row[field];
}

function matchIlike(row: Row, field: string, rawPattern: string): boolean {
  const value = fieldValue(row, field);
  if (typeof value !== "string") return false;
  const needle = rawPattern.replace(/^%/, "").replace(/%$/, "").toLowerCase();
  return value.toLowerCase().includes(needle);
}

function evalOrClause(row: Row, clause: string): boolean {
  const match = clause.match(/^([a-zA-Z_.]+)\.(not\.)?(eq|gt|is|ilike|in)\.(.*)$/);
  if (!match) return false;
  const [, field, notPrefix, op, rawValue] = match;
  let result: boolean;
  if (op === "is") {
    const isNull = fieldValue(row, field) === null || fieldValue(row, field) === undefined;
    result = rawValue === "null" ? isNull : String(fieldValue(row, field)) === rawValue;
  } else if (op === "ilike") {
    result = matchIlike(row, field, rawValue);
  } else if (op === "in") {
    const ids = rawValue.replace(/^\(/, "").replace(/\)$/, "").split(",").filter(Boolean);
    result = ids.includes(String(fieldValue(row, field)));
  } else if (op === "gt") {
    result = Number(fieldValue(row, field) ?? 0) > Number(rawValue);
  } else {
    result = String(fieldValue(row, field)) === rawValue;
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
    ilike(field: string, pattern: string) {
      filtered = filtered.filter((r) => matchIlike(r, field, pattern));
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
  const admin = {
    from(table: string) {
      return { select: () => selectBuilder(tables[table] ?? []) };
    },
  };
  return { admin, tables };
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
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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

function makeThreads(count: number, tenantId: string, overrides: Row = {}) {
  return Array.from({ length: count }, (_, i) =>
    thread(`thread-${String(i).padStart(4, "0")}`, tenantId, {
      last_message_at: `2026-08-01T${String(10 + (i % 12)).padStart(2, "0")}:00:00Z`,
      ...overrides,
    })
  );
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

describe("Sprint 4 — paginazione lista thread WhatsApp", () => {
  it("pagina 1: page_size default 50, has_more=true se ci sono altri thread", async () => {
    const fake = createFakeAdmin({ whatsapp_threads: makeThreads(65, TENANT_A) });
    authorizeAs(fake.admin);

    const res = await callGet("?filter=open");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.threads).toHaveLength(50);
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(50);
    expect(body.has_more).toBe(true);
  });

  it("pagina 2: continua senza duplicati e senza sovrapposizioni con pagina 1", async () => {
    const fake = createFakeAdmin({ whatsapp_threads: makeThreads(65, TENANT_A) });
    authorizeAs(fake.admin);

    const page1 = await (await callGet("?filter=open&page=1&page_size=50")).json();
    const page2 = await (await callGet("?filter=open&page=2&page_size=50")).json();

    const idsPage1 = new Set((page1.threads as Row[]).map((t) => t.id));
    const idsPage2 = (page2.threads as Row[]).map((t) => t.id);

    expect(page2.threads).toHaveLength(15);
    expect(page2.has_more).toBe(false);
    for (const id of idsPage2) expect(idsPage1.has(id)).toBe(false);
  });

  it("il filtro resta applicato insieme alla paginazione (closed esclude open)", async () => {
    const fake = createFakeAdmin({
      whatsapp_threads: [
        ...makeThreads(3, TENANT_A, { status: "open" }),
        thread("thread-closed-1", TENANT_A, { status: "closed" }),
      ],
    });
    authorizeAs(fake.admin);

    const res = await callGet("?filter=closed");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect((body.threads as Row[]).every((t) => t.status === "closed")).toBe(true);
    expect(body.threads).toHaveLength(1);
  });

  it("filtro urgent: include non lette e review, esclude chiuse e chat tranquille", async () => {
    const fake = createFakeAdmin({
      whatsapp_threads: [
        thread("thread-unread", TENANT_A, { unread_count: 2, status: "open", match_status: "matched" }),
        thread("thread-status-review", TENANT_A, { unread_count: 0, status: "needs_review", match_status: "matched" }),
        thread("thread-match-review", TENANT_A, { unread_count: 0, status: "open", match_status: "needs_review" }),
        thread("thread-quiet", TENANT_A, { unread_count: 0, status: "open", match_status: "matched" }),
        thread("thread-closed-unread", TENANT_A, { unread_count: 3, status: "closed", match_status: "needs_review" }),
      ],
    });
    authorizeAs(fake.admin);

    const res = await callGet("?filter=urgent");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect((body.threads as Row[]).map((t) => t.id)).toEqual([
      "thread-unread",
      "thread-status-review",
      "thread-match-review",
    ]);
  });
});

describe("Sprint 4 — ricerca lato DB (non più filtro JS su fetch da 5000)", () => {
  it("ricerca per numero (>=6 cifre) filtra via DB su wa_id/phone_e164", async () => {
    const fake = createFakeAdmin({
      whatsapp_threads: [
        thread("thread-a", TENANT_A, { wa_id: "393331112222", phone_e164: "+393331112222" }),
        thread("thread-b", TENANT_A, { wa_id: "393339998888", phone_e164: "+393339998888" }),
      ],
    });
    authorizeAs(fake.admin);

    const res = await callGet("?filter=all&q=331112222");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect((body.threads as Row[]).map((t) => t.id)).toEqual(["thread-a"]);
  });

  it("ricerca per nome contatto filtra via DB su whatsapp_contacts, non in JS", async () => {
    const fake = createFakeAdmin({
      whatsapp_threads: [
        thread("thread-mario", TENANT_A, { contact_id: "contact-mario" }),
        thread("thread-altro", TENANT_A, { contact_id: "contact-altro" }),
      ],
      whatsapp_contacts: [
        { id: "contact-mario", tenant_id: TENANT_A, profile_name: "Mario Rossi", customer_full_name: null, manual_contact_name: null, wa_profile_name: null },
        { id: "contact-altro", tenant_id: TENANT_A, profile_name: "Giulia Bianchi", customer_full_name: null, manual_contact_name: null, wa_profile_name: null },
      ],
    });
    authorizeAs(fake.admin);

    const res = await callGet("?filter=all&q=Mario");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect((body.threads as Row[]).map((t) => t.id)).toEqual(["thread-mario"]);
  });

  it("ricerca senza corrispondenze: nessun errore, threads vuoto, has_more false", async () => {
    const fake = createFakeAdmin({
      whatsapp_threads: [thread("thread-a", TENANT_A)],
      whatsapp_contacts: [],
    });
    authorizeAs(fake.admin);

    const res = await callGet("?filter=all&q=zzznessunmatchzzz");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.threads).toEqual([]);
    expect(body.has_more).toBe(false);
  });

  it("tenant isolation preservata durante la ricerca: contatto del tenant B non fa trapelare thread", async () => {
    const fake = createFakeAdmin({
      whatsapp_threads: [
        thread("thread-a", TENANT_A, { contact_id: "contact-a" }),
        thread("thread-b", TENANT_B, { contact_id: "contact-b" }),
      ],
      whatsapp_contacts: [
        { id: "contact-a", tenant_id: TENANT_A, profile_name: "Stesso Nome", customer_full_name: null, manual_contact_name: null, wa_profile_name: null },
        { id: "contact-b", tenant_id: TENANT_B, profile_name: "Stesso Nome", customer_full_name: null, manual_contact_name: null, wa_profile_name: null },
      ],
    });
    authorizeAs(fake.admin, TENANT_A);

    const res = await callGet("?filter=all&q=Stesso Nome");
    const body = await res.json();

    expect(res.status).toBe(200);
    const ids = (body.threads as Row[]).map((t) => t.id);
    expect(ids).toContain("thread-a");
    expect(ids).not.toContain("thread-b");
  });
});
