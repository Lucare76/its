import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * Sprint Performance 11 — test per la nuova route /api/ops/inbox-data, che
 * sostituisce /api/ops/dispatch-data come sorgente dati per la pagina Inbox.
 *
 * Fake Supabase admin dedicato (stesso stile di whatsapp-inbox-pagination-search.test.ts):
 * un query builder minimale che capisce .eq(), .in(), .or() con clausole
 * "campo.not.in.(...)"/"campo.in.(...)", .order() e .range() inclusivo.
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
  // Nota: [a-zA-Z_]+ (senza il punto) per il nome campo — con il punto incluso
  // nel charset, il gruppo greedy inghiotte "not" dentro "status.not.in.(...)"
  // trattandolo come parte del nome campo invece che come prefisso di negazione.
  const match = clause.match(/^([a-zA-Z_]+)\.(not\.)?(eq|is|ilike|in)\.(.*)$/);
  if (!match) return false;
  const [, field, notPrefix, op, rawValue] = match;
  let result: boolean;
  if (op === "in") {
    const ids = rawValue.replace(/^\(/, "").replace(/\)$/, "").split(",").filter(Boolean);
    result = ids.includes(String(row[field]));
  } else if (op === "is") {
    result = rawValue === "null" ? row[field] == null : String(row[field]) === rawValue;
  } else {
    result = String(row[field]) === rawValue;
  }
  return notPrefix ? !result : result;
}

function selectBuilder(rows: Row[]) {
  let filtered = rows.slice();
  const orderSpecs: Array<{ field: string; ascending: boolean }> = [];
  let rangeSpec: { from: number; to: number } | null = null;
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
      const clauses = splitTopLevelClauses(filterStr);
      filtered = filtered.filter((r) => clauses.some((clause) => evalOrClause(r, clause)));
      return builder;
    },
    order(field: string, opts?: { ascending?: boolean }) {
      orderSpecs.push({ field, ascending: opts?.ascending !== false });
      return builder;
    },
    range(from: number, to: number) {
      rangeSpec = { from, to };
      return builder;
    },
    then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
      let result = filtered.slice();
      if (orderSpecs.length > 0) {
        result = result.sort((a, b) => {
          for (const { field, ascending } of orderSpecs) {
            const av = a[field] as string;
            const bv = b[field] as string;
            if (av === bv) continue;
            const cmp = av > bv ? 1 : -1;
            return ascending ? cmp : -cmp;
          }
          return 0;
        });
      }
      if (rangeSpec) result = result.slice(rangeSpec.from, rangeSpec.to + 1);
      return Promise.resolve({ data: result, error: null }).then(resolve, reject);
    }
  };
  return builder;
}

function createFakeAdmin(seed: Partial<Record<string, Row[]>> = {}) {
  const tables: Record<string, Row[]> = {
    inbound_emails: [],
    services: [],
    hotels: [],
    memberships: [],
    ...seed
  };
  const fromCalls: string[] = [];
  const admin = {
    from(table: string) {
      fromCalls.push(table);
      return { select: () => selectBuilder(tables[table] ?? []) };
    }
  };
  return { admin, tables, fromCalls };
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn()
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest
}));

import { GET } from "@/app/api/ops/inbox-data/route";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function authorizeAs(admin: ReturnType<typeof createFakeAdmin>["admin"], tenantId = TENANT_A) {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: tenantId, role: "operator", suspended: false }
  });
}

function callGet(qs = "") {
  return GET(new NextRequest(`http://localhost:3010/api/ops/inbox-data${qs}`));
}

function email(id: string, createdAt: string, overrides: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT_A,
    subject: `Subject ${id}`,
    parsed_json: {},
    body_text: "body",
    raw_text: "raw",
    created_at: createdAt,
    ...overrides
  };
}

function service(id: string, overrides: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT_A,
    status: "new",
    is_draft: false,
    date: "2026-08-15",
    direction: "arrival",
    booking_service_kind: null,
    service_type_code: null,
    route_kind: null,
    vessel: null,
    customer_name: "Cliente",
    customer_first_name: null,
    customer_last_name: null,
    inbound_email_id: null,
    ...overrides
  };
}

function makeEmails(count: number) {
  return Array.from({ length: count }, (_, i) =>
    email(`email-${String(i).padStart(4, "0")}`, `2026-08-01T${String(i % 24).padStart(2, "0")}:00:00.${String(i).padStart(3, "0")}Z`)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("inbox-data — FASE 18.1 auth", () => {
  it("richiede autorizzazione con i ruoli admin/operator/supervisor", async () => {
    const fake = createFakeAdmin();
    authorizeAs(fake.admin);
    await callGet();
    expect(mocks.authorizePricingRequest).toHaveBeenCalledWith(expect.any(NextRequest), ["admin", "operator", "supervisor"]);
  });

  it("propaga il diniego di authorizePricingRequest (es. 401)", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }));
    const res = await callGet();
    expect(res.status).toBe(401);
  });
});

describe("inbox-data — FASE 18.2/3/4 paginazione email", () => {
  it("pagina 1: page_size default 50, has_more=true se ci sono altre email", async () => {
    const fake = createFakeAdmin({ inbound_emails: makeEmails(65) });
    authorizeAs(fake.admin);
    const body = await (await callGet()).json();
    expect(body.ok).toBe(true);
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(50);
    expect(body.inbound_emails).toHaveLength(50);
    expect(body.has_more).toBe(true);
  });

  it("page_size richiesto oltre il massimo viene clampato a 100", async () => {
    const fake = createFakeAdmin({ inbound_emails: makeEmails(150) });
    authorizeAs(fake.admin);
    const body = await (await callGet("?page_size=500")).json();
    expect(body.page_size).toBe(100);
    expect(body.inbound_emails).toHaveLength(100);
    expect(body.has_more).toBe(true);
  });

  it("ordina le email più recenti prima (created_at desc)", async () => {
    const fake = createFakeAdmin({
      inbound_emails: [
        email("old", "2026-08-01T00:00:00Z"),
        email("newest", "2026-08-10T00:00:00Z"),
        email("mid", "2026-08-05T00:00:00Z")
      ]
    });
    authorizeAs(fake.admin);
    const body = await (await callGet()).json();
    expect(body.inbound_emails.map((e: Row) => e.id)).toEqual(["newest", "mid", "old"]);
  });

  it("ultima pagina: has_more=false quando le righe restanti sono esattamente page_size", async () => {
    const fake = createFakeAdmin({ inbound_emails: makeEmails(50) });
    authorizeAs(fake.admin);
    const body = await (await callGet()).json();
    expect(body.inbound_emails).toHaveLength(50);
    expect(body.has_more).toBe(false);
  });
});

describe("inbox-data — FASE 18.5/9 services solo collegati", () => {
  it("restituisce solo i services attivi e quelli collegati alla pagina di email corrente", async () => {
    const emails = [
      email("e1", "2026-08-10T00:00:00Z", { parsed_json: { linked_service_id: "svc-linked" } }),
      email("e2", "2026-08-09T00:00:00Z", { parsed_json: {} })
    ];
    const fake = createFakeAdmin({
      inbound_emails: emails,
      services: [
        service("svc-linked", { status: "completato" }), // collegato via parsed_json anche se terminale
        service("svc-active", { status: "new" }), // attivo, non collegato: incluso perché pagina 1
        service("svc-by-email", { inbound_email_id: "e2" }), // collegato via inbound_email_id
        service("svc-terminal-unrelated", { status: "cancelled" }) // non attivo, non collegato: escluso
      ]
    });
    authorizeAs(fake.admin);
    const body = await (await callGet()).json();
    const ids = (body.services as Row[]).map((s) => s.id).sort();
    expect(ids).toEqual(["svc-active", "svc-by-email", "svc-linked"]);
  });

  it("empty linked services: nessuna query se la pagina non ha email e non è la prima pagina", async () => {
    const fake = createFakeAdmin({
      inbound_emails: makeEmails(10),
      services: [service("svc-active", { status: "new" })]
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?page=5&page_size=50")).json();
    expect(body.inbound_emails).toHaveLength(0);
    expect(body.services).toEqual([]);
    expect(fake.fromCalls.includes("services")).toBe(false);
  });
});

describe("inbox-data — FASE 18.6/7/8 nessun dataset Dispatch", () => {
  it("non interroga mai vehicles, assignments o driver registry", async () => {
    const fake = createFakeAdmin({ inbound_emails: makeEmails(5) });
    authorizeAs(fake.admin);
    await callGet();
    expect(fake.fromCalls).not.toContain("vehicles");
    expect(fake.fromCalls).not.toContain("assignments");
    expect(fake.fromCalls).not.toContain("driver_registry");
  });
});

describe("inbox-data — FASE 18.10 pagina successiva", () => {
  it("pagina 2 non ricarica hotels/drivers e continua senza sovrapposizioni con pagina 1", async () => {
    const fake = createFakeAdmin({
      inbound_emails: makeEmails(65),
      hotels: [{ id: "h1", tenant_id: TENANT_A, name: "Hotel Test" }],
      memberships: [{ user_id: "u1", tenant_id: TENANT_A, role: "driver", full_name: "Mario" }]
    });
    authorizeAs(fake.admin);

    const page1 = await (await callGet("?page=1&page_size=50")).json();
    fake.fromCalls.length = 0;
    const page2 = await (await callGet("?page=2&page_size=50")).json();

    expect(page1.hotels).toHaveLength(1);
    expect(page1.drivers).toHaveLength(1);

    expect(page2.hotels).toEqual([]);
    expect(page2.drivers).toEqual([]);
    expect(fake.fromCalls).not.toContain("hotels");
    expect(fake.fromCalls).not.toContain("memberships");

    const idsPage1 = new Set(page1.inbound_emails.map((e: Row) => e.id));
    const idsPage2 = new Set(page2.inbound_emails.map((e: Row) => e.id));
    for (const id of idsPage2) expect(idsPage1.has(id)).toBe(false);
    expect(page2.inbound_emails).toHaveLength(15);
    expect(page2.has_more).toBe(false);
  });
});
