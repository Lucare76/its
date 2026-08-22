import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));

import { GET, POST } from "@/app/api/services/medmar-credit-topups/route";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function makeGetRequest() {
  return new NextRequest("http://localhost:3010/api/services/medmar-credit-topups", { method: "GET" });
}

function makePostRequest(body: unknown) {
  return new NextRequest("http://localhost:3010/api/services/medmar-credit-topups", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function makeAuthContext(
  role: string,
  opts: { listResult?: { data: unknown; error: unknown }; insertResult?: { data: unknown; error: unknown } } = {}
) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    ctx: {
      admin: {
        from(table: string) {
          if (table !== "medmar_credit_topups") throw new Error(`tabella inattesa: ${table}`);
          const builder: Record<string, unknown> = {};
          const methods = ["select", "eq", "order", "insert", "single"];
          for (const m of methods) {
            builder[m] = (...args: unknown[]) => {
              calls.push({ method: m, args });
              if (m === "single") return Promise.resolve(opts.insertResult ?? { data: { id: "topup-1" }, error: null });
              return builder;
            };
          }
          builder.then = (onFulfilled: (v: unknown) => unknown) =>
            Promise.resolve(opts.listResult ?? { data: [], error: null }).then(onFulfilled);
          return builder;
        },
      } as never,
      user: { id: "user-1", email: "a@b.test" },
      membership: { tenant_id: TENANT_A, role, suspended: false },
    },
    calls,
  };
}

describe("GET /api/services/medmar-credit-topups", () => {
  beforeEach(() => vi.clearAllMocks());

  it("1. sessione non autorizzata -> propaga la 401", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it("2. elenco vuoto -> topups: []", async () => {
    const { ctx } = makeAuthContext("operator", { listResult: { data: [], error: null } });
    mocks.authorizePricingRequest.mockResolvedValue(ctx);
    const res = await GET(makeGetRequest());
    const json = await res.json();
    expect(json.topups).toEqual([]);
  });

  it("3. tenant isolation: filtro tenant_id applicato", async () => {
    const { ctx, calls } = makeAuthContext("operator");
    mocks.authorizePricingRequest.mockResolvedValue(ctx);
    await GET(makeGetRequest());
    const eqCall = calls.find((c) => c.method === "eq" && c.args[0] === "tenant_id");
    expect(eqCall?.args[1]).toBe(TENANT_A);
  });

  it("4. errore Supabase -> 500 generico", async () => {
    const { ctx } = makeAuthContext("operator", { listResult: { data: null, error: { message: "connection reset" } } });
    mocks.authorizePricingRequest.mockResolvedValue(ctx);
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(500);
  });
});

describe("POST /api/services/medmar-credit-topups", () => {
  beforeEach(() => vi.clearAllMocks());

  it("1. sessione non autorizzata -> propaga il 403", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    const res = await POST(makePostRequest({ amount_cents: 5000 }));
    expect(res.status).toBe(403);
  });

  it("2. richiede ruolo admin/supervisor", async () => {
    const { ctx } = makeAuthContext("admin");
    mocks.authorizePricingRequest.mockResolvedValue(ctx);
    await POST(makePostRequest({ amount_cents: 5000 }));
    expect(mocks.authorizePricingRequest).toHaveBeenCalledWith(expect.anything(), ["admin", "supervisor"]);
  });

  it("3. importo negativo rifiutato -> 400, nessuna scrittura", async () => {
    const { ctx, calls } = makeAuthContext("admin");
    mocks.authorizePricingRequest.mockResolvedValue(ctx);
    const res = await POST(makePostRequest({ amount_cents: -100 }));
    expect(res.status).toBe(400);
    expect(calls.find((c) => c.method === "insert")).toBeUndefined();
  });

  it("4. importo zero rifiutato -> 400 (deve essere strettamente positivo)", async () => {
    const { ctx } = makeAuthContext("admin");
    mocks.authorizePricingRequest.mockResolvedValue(ctx);
    const res = await POST(makePostRequest({ amount_cents: 0 }));
    expect(res.status).toBe(400);
  });

  it("5. data non valida rifiutata -> 400", async () => {
    const { ctx } = makeAuthContext("admin");
    mocks.authorizePricingRequest.mockResolvedValue(ctx);
    const res = await POST(makePostRequest({ amount_cents: 1000, topup_date: "22-08-2026" }));
    expect(res.status).toBe(400);
  });

  it("6. importo valido -> insert con tenant_id corretto, note troncate a 500 caratteri", async () => {
    const { ctx, calls } = makeAuthContext("admin");
    mocks.authorizePricingRequest.mockResolvedValue(ctx);
    const longNotes = "y".repeat(600);
    const res = await POST(makePostRequest({ amount_cents: 5000, topup_date: "2026-08-22", notes: longNotes }));
    expect(res.status).toBe(200);
    const insertCall = calls.find((c) => c.method === "insert");
    const payload = insertCall?.args[0] as { tenant_id: string; amount_cents: number; notes: string };
    expect(payload.tenant_id).toBe(TENANT_A);
    expect(payload.amount_cents).toBe(5000);
    expect(payload.notes.length).toBe(500);
  });

  it("7. nessun token/secret nel payload di risposta", async () => {
    const { ctx } = makeAuthContext("admin");
    mocks.authorizePricingRequest.mockResolvedValue(ctx);
    const res = await POST(makePostRequest({ amount_cents: 1000 }));
    const json = await res.json();
    expect(JSON.stringify(json)).not.toMatch(/token|secret|bearer/i);
  });
});
