import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));

import { GET, POST } from "@/app/api/services/medmar-credit-settings/route";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function makeGetRequest() {
  return new NextRequest("http://localhost:3010/api/services/medmar-credit-settings", { method: "GET" });
}

function makePostRequest(body: unknown) {
  return new NextRequest("http://localhost:3010/api/services/medmar-credit-settings", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function makeAuthContext(role: string, opts: { selectResult?: { data: unknown; error: unknown }; upsertResult?: { error: unknown } } = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    ctx: {
      admin: {
        from(table: string) {
          if (table !== "medmar_credit_settings") throw new Error(`tabella inattesa: ${table}`);
          const builder: Record<string, unknown> = {};
          const methods = ["select", "eq", "maybeSingle", "upsert"];
          for (const m of methods) {
            builder[m] = (...args: unknown[]) => {
              calls.push({ method: m, args });
              if (m === "upsert") return Promise.resolve(opts.upsertResult ?? { error: null });
              return builder;
            };
          }
          builder.then = (onFulfilled: (v: unknown) => unknown) =>
            Promise.resolve(opts.selectResult ?? { data: null, error: null }).then(onFulfilled);
          return builder;
        },
      } as never,
      user: { id: "user-1", email: "a@b.test" },
      membership: { tenant_id: TENANT_A, role, suspended: false },
    },
    calls,
  };
}

describe("GET /api/services/medmar-credit-settings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("1. sessione non autorizzata -> propaga la 401", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it("2. nessun setting salvato -> settings: null (mai un valore inventato)", async () => {
    const { ctx } = makeAuthContext("operator", { selectResult: { data: null, error: null } });
    mocks.authorizePricingRequest.mockResolvedValue(ctx);
    const res = await GET(makeGetRequest());
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.settings).toBeNull();
  });

  it("3. setting presente -> restituito senza secret", async () => {
    const { ctx } = makeAuthContext("operator", {
      selectResult: { data: { initial_credit_cents: 100000, safety_threshold_cents: 20000, notes: null, updated_at: "2026-08-22T08:00:00.000Z" }, error: null },
    });
    mocks.authorizePricingRequest.mockResolvedValue(ctx);
    const res = await GET(makeGetRequest());
    const json = await res.json();
    expect(json.settings.initial_credit_cents).toBe(100000);
    expect(JSON.stringify(json)).not.toMatch(/token|secret|bearer/i);
  });

  it("4. errore Supabase -> 500 generico, nessun dettaglio interno esposto", async () => {
    const { ctx } = makeAuthContext("operator", { selectResult: { data: null, error: { message: "connection reset" } } });
    mocks.authorizePricingRequest.mockResolvedValue(ctx);
    const res = await GET(makeGetRequest());
    const json = await res.json();
    expect(res.status).toBe(500);
    expect(json.error).not.toContain("connection reset");
  });

  it("5. tenant isolation: filtro tenant_id applicato", async () => {
    const { ctx, calls } = makeAuthContext("operator");
    mocks.authorizePricingRequest.mockResolvedValue(ctx);
    await GET(makeGetRequest());
    const eqCall = calls.find((c) => c.method === "eq" && c.args[0] === "tenant_id");
    expect(eqCall?.args[1]).toBe(TENANT_A);
  });
});

describe("POST /api/services/medmar-credit-settings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("1. sessione non autorizzata -> propaga la 401/403 di authorizePricingRequest", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    const res = await POST(makePostRequest({ initial_credit_cents: 1000, safety_threshold_cents: 2000 }));
    expect(res.status).toBe(403);
  });

  it("2. richiede ruolo admin/supervisor -> la route lo delega ad authorizePricingRequest con i ruoli corretti", async () => {
    const { ctx } = makeAuthContext("admin");
    mocks.authorizePricingRequest.mockResolvedValue(ctx);
    await POST(makePostRequest({ initial_credit_cents: 1000, safety_threshold_cents: 2000 }));
    expect(mocks.authorizePricingRequest).toHaveBeenCalledWith(expect.anything(), ["admin", "supervisor"]);
  });

  it("3. importo negativo rifiutato -> 400, nessuna scrittura", async () => {
    const { ctx, calls } = makeAuthContext("admin");
    mocks.authorizePricingRequest.mockResolvedValue(ctx);
    const res = await POST(makePostRequest({ initial_credit_cents: -100, safety_threshold_cents: 2000 }));
    expect(res.status).toBe(400);
    expect(calls.find((c) => c.method === "upsert")).toBeUndefined();
  });

  it("4. soglia negativa rifiutata -> 400", async () => {
    const { ctx } = makeAuthContext("admin");
    mocks.authorizePricingRequest.mockResolvedValue(ctx);
    const res = await POST(makePostRequest({ initial_credit_cents: 100, safety_threshold_cents: -1 }));
    expect(res.status).toBe(400);
  });

  it("5. body non valido -> 400", async () => {
    const { ctx } = makeAuthContext("admin");
    mocks.authorizePricingRequest.mockResolvedValue(ctx);
    const req = new NextRequest("http://localhost:3010/api/services/medmar-credit-settings", { method: "POST", body: "{not json" });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("6. importi validi -> upsert con tenant_id corretto, note troncate a 500 caratteri", async () => {
    const { ctx, calls } = makeAuthContext("admin");
    mocks.authorizePricingRequest.mockResolvedValue(ctx);
    const longNotes = "x".repeat(600);
    const res = await POST(makePostRequest({ initial_credit_cents: 100000, safety_threshold_cents: 20000, notes: longNotes }));
    expect(res.status).toBe(200);
    const upsertCall = calls.find((c) => c.method === "upsert");
    const payload = upsertCall?.args[0] as { tenant_id: string; notes: string };
    expect(payload.tenant_id).toBe(TENANT_A);
    expect(payload.notes.length).toBe(500);
  });

  it("7. nessun token/secret nel payload di risposta", async () => {
    const { ctx } = makeAuthContext("admin");
    mocks.authorizePricingRequest.mockResolvedValue(ctx);
    const res = await POST(makePostRequest({ initial_credit_cents: 100, safety_threshold_cents: 200 }));
    const json = await res.json();
    expect(JSON.stringify(json)).not.toMatch(/token|secret|bearer/i);
  });
});
