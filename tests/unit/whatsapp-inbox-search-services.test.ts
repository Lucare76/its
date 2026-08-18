import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Regression test for a bug found 2026-08-18: GET /api/ops/whatsapp-inbox/search-services
 * ("Associa a prenotazione" manual search in the WhatsApp inbox) built a single
 * literal ilike("%q%") against customer_name. WhatsApp contact/thread display
 * names are commonly "SURNAME FIRSTNAME" (as typed by the operator from the
 * chat header), while services.customer_name is stored "Firstname Lastname" —
 * a literal substring match never finds it when the words are reversed
 * (verified live: query "D'ADDIO GERARDO" found nothing against the stored
 * "GERARDO D'ADDIO"). Fix: tokenize the query and require every token to
 * appear somewhere in customer_name, regardless of order.
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

function ilikeMatch(value: unknown, pattern: string) {
  const inner = pattern.replace(/^%|%$/g, "").toLowerCase();
  return String(value ?? "").toLowerCase().includes(inner);
}

function evalClause(row: Row, clause: string): boolean {
  if (clause.startsWith("and(")) {
    const inner = clause.slice(4, -1);
    return splitTopLevelClauses(inner).every((sub) => evalClause(row, sub));
  }
  const match = clause.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.(ilike)\.(.*)$/);
  if (!match) return false;
  const [, field, , raw] = match;
  return ilikeMatch(row[field], raw);
}

function selectBuilder(rows: Row[]) {
  let filtered = rows;
  const builder = {
    eq(field: string, value: unknown) {
      filtered = filtered.filter((r) => String(r[field] ?? "") === String(value));
      return builder;
    },
    or(filterStr: string) {
      const clauses = splitTopLevelClauses(filterStr);
      filtered = filtered.filter((r) => clauses.some((clause) => evalClause(r, clause)));
      return builder;
    },
    order() {
      return builder;
    },
    limit() {
      return Promise.resolve({ data: filtered, error: null });
    }
  };
  return builder;
}

const mocks = vi.hoisted(() => ({ authorizePricingRequest: vi.fn() }));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorizePricingRequest }));

import { GET } from "@/app/api/ops/whatsapp-inbox/search-services/route";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function authorizeAs(rows: Row[]) {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: { from: () => ({ select: () => selectBuilder(rows) }) },
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: TENANT_A, role: "operator", suspended: false }
  });
}

function req(q: string) {
  return new NextRequest(`https://example.test/api/ops/whatsapp-inbox/search-services?q=${encodeURIComponent(q)}`);
}

beforeEach(() => {
  mocks.authorizePricingRequest.mockReset();
});

describe("GET /api/ops/whatsapp-inbox/search-services", () => {
  it("finds a customer when the query words are in reverse order vs. the stored name", async () => {
    authorizeAs([{ id: "svc-1", tenant_id: TENANT_A, customer_name: "GERARDO D'ADDIO", phone: "3271152378" }]);
    const res = await GET(req("D'ADDIO GERARDO"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.services.map((s: Row) => s.id)).toEqual(["svc-1"]);
  });

  it("still matches when the query words are in the same order as stored", async () => {
    authorizeAs([{ id: "svc-1", tenant_id: TENANT_A, customer_name: "GERARDO D'ADDIO", phone: "3271152378" }]);
    const res = await GET(req("GERARDO D'ADDIO"));
    const body = await res.json();
    expect(body.services.map((s: Row) => s.id)).toEqual(["svc-1"]);
  });

  it("still matches a single-word query", async () => {
    authorizeAs([{ id: "svc-1", tenant_id: TENANT_A, customer_name: "GERARDO D'ADDIO", phone: "3271152378" }]);
    const res = await GET(req("D'ADDIO"));
    const body = await res.json();
    expect(body.services.map((s: Row) => s.id)).toEqual(["svc-1"]);
  });

  it("still matches by phone", async () => {
    authorizeAs([{ id: "svc-1", tenant_id: TENANT_A, customer_name: "GERARDO D'ADDIO", phone: "3271152378" }]);
    const res = await GET(req("3271152378"));
    const body = await res.json();
    expect(body.services.map((s: Row) => s.id)).toEqual(["svc-1"]);
  });

  it("does not match when only one of two tokens is present in the name", async () => {
    authorizeAs([{ id: "svc-1", tenant_id: TENANT_A, customer_name: "MARIO ROSSI", phone: "3339999999" }]);
    const res = await GET(req("D'ADDIO GERARDO"));
    const body = await res.json();
    expect(body.services).toEqual([]);
  });

  it("returns empty for a query shorter than 2 characters", async () => {
    authorizeAs([{ id: "svc-1", tenant_id: TENANT_A, customer_name: "GERARDO D'ADDIO", phone: "3271152378" }]);
    const res = await GET(req("d"));
    const body = await res.json();
    expect(body.services).toEqual([]);
  });
});
