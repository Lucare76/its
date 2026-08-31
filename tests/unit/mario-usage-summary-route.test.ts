import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({ authorizePricingRequest: vi.fn() }));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorizePricingRequest }));

import { GET } from "@/app/api/mario-assistant/usage-summary/route";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Row = {
  created_at: string;
  model: string;
  action: string | null;
  fallback_used: boolean;
  failed: boolean;
  input_tokens: number;
  output_tokens: number;
  total_cost_usd: number | null;
};

function makeAdmin(rows: Row[], error: unknown = null) {
  const calls: { from?: string; eq: Array<[string, unknown]>; limit: number } = { eq: [], limit: 0 };
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: () => builder,
    eq: (c: string, v: unknown) => {
      calls.eq.push([c, v]);
      return builder;
    },
    gte: () => builder,
    order: () => builder,
    limit: () => {
      calls.limit += 1;
      return Promise.resolve({ data: rows, error });
    },
  });
  return {
    calls,
    admin: {
      from: (t: string) => {
        calls.from = t;
        return builder;
      },
    },
  };
}

function authWith(admin: unknown, tenantId = TENANT_A) {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: tenantId, role: "operator", suspended: false },
  });
}

const req = () =>
  new NextRequest("https://example.test/api/mario-assistant/usage-summary", {
    headers: { authorization: "Bearer token" },
  });

beforeEach(() => {
  mocks.authorizePricingRequest.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

const row = (over: Partial<Row>): Row => ({
  created_at: "2026-06-15T09:00:00.000Z",
  model: "claude-haiku-4-5-20251001",
  action: "tool_call",
  fallback_used: false,
  failed: false,
  input_tokens: 1000,
  output_tokens: 200,
  total_cost_usd: 0.002,
  ...over,
});

describe("GET /usage-summary — §12 aggregati", () => {
  it("today = solo oggi, month = tutta la finestra; lastRequest = riga più recente", async () => {
    const { admin, calls } = makeAdmin([
      row({ created_at: "2026-06-15T09:00:00.000Z", input_tokens: 1000, output_tokens: 200, total_cost_usd: 0.002 }),
      row({ created_at: "2026-06-03T10:00:00.000Z", input_tokens: 500, output_tokens: 100, total_cost_usd: 0.001 }),
    ]);
    authWith(admin);
    const res = await GET(req());
    const body = await res.json();

    expect(body.today).toEqual({ calls: 1, inputTokens: 1000, outputTokens: 200, costUsd: 0.002 });
    expect(body.month).toEqual({ calls: 2, inputTokens: 1500, outputTokens: 300, costUsd: 0.003 });
    expect(body.lastRequest).toMatchObject({ inputTokens: 1000, outputTokens: 200, costUsd: 0.002 });
    expect(body.pricingConfigured).toBe(true);
    // §12 nessun N+1: una sola from(), una sola query terminata
    expect(calls.from).toBe("mario_llm_usage");
    expect(calls.limit).toBe(1);
  });

  it("§11/§24 Caso E: query SEMPRE filtrata per tenant risolto server-side E user corrente", async () => {
    const { admin, calls } = makeAdmin([]);
    authWith(admin, TENANT_B);
    await GET(req());
    expect(calls.eq).toContainEqual(["tenant_id", TENANT_B]);
    expect(calls.eq).toContainEqual(["user_id", "user-1"]);
    expect(calls.eq).not.toContainEqual(["tenant_id", TENANT_A]);
  });

  it("§8 tutte le righe senza costo ma con token → costUsd = null (non 0)", async () => {
    const { admin } = makeAdmin([row({ total_cost_usd: null }), row({ total_cost_usd: null, created_at: "2026-06-04T10:00:00.000Z" })]);
    authWith(admin);
    const body = await (await GET(req())).json();
    expect(body.month.costUsd).toBeNull();
    expect(body.month.inputTokens).toBe(2000);
  });

  it("riga failed non inquina i costi (0 token, costo null) ma conta come chiamata", async () => {
    const { admin } = makeAdmin([row({ failed: true, input_tokens: 0, output_tokens: 0, total_cost_usd: null }), row({})]);
    authWith(admin);
    const body = await (await GET(req())).json();
    expect(body.month.calls).toBe(2);
    expect(body.month.costUsd).toBeCloseTo(0.002, 10);
  });

  it("§19 tabella assente/errore → risposta pulita (unavailable), mai 500", async () => {
    const { admin } = makeAdmin([], { message: 'relation "mario_llm_usage" does not exist' });
    authWith(admin);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, unavailable: true, lastRequest: null });
  });

  it("auth pass-through: 401 se non autenticato", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "unauthorized" }, { status: 401 }));
    const res = await GET(req());
    expect(res.status).toBe(401);
  });
});
