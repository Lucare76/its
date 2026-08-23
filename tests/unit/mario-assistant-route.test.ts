import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  checkRateLimit: vi.fn(),
  runMarioAssistant: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));
vi.mock("@/lib/server/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
}));
vi.mock("@/lib/server/mario-assistant/orchestrator", () => ({
  runMarioAssistant: mocks.runMarioAssistant,
}));

import { POST } from "@/app/api/mario-assistant/route";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function authorizeAs(role: "admin" | "operator" | "supervisor" = "operator", tenantId = TENANT_A) {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: {} as unknown,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: tenantId, role, suspended: false },
  });
}

function req(body: unknown) {
  return new NextRequest("https://example.test/api/mario-assistant", {
    method: "POST",
    headers: { authorization: "Bearer token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.authorizePricingRequest.mockReset();
  mocks.checkRateLimit.mockReset();
  mocks.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 19, resetAt: new Date() });
  mocks.runMarioAssistant.mockReset();
  mocks.runMarioAssistant.mockResolvedValue({ intent: "operational_brief", answer: "Tutto ok.", actions: [], data: {} });
});

describe("POST /api/mario-assistant — 11. richiesta valida", () => {
  it("risponde 200 con ok/intent/answer/actions", async () => {
    authorizeAs();
    const res = await POST(req({ message: "come siamo messi oggi" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, intent: "operational_brief", answer: "Tutto ok.", actions: [] });
  });
});

describe("POST /api/mario-assistant — 12/13. auth", () => {
  it("12. non autenticato -> 401 (pass-through di authorizePricingRequest)", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "unauthorized" }, { status: 401 }));
    const res = await POST(req({ message: "ciao" }));
    expect(res.status).toBe(401);
    expect(mocks.runMarioAssistant).not.toHaveBeenCalled();
  });

  it("13. ruolo non ammesso -> 403 (pass-through di authorizePricingRequest, mai driver/agency)", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    const res = await POST(req({ message: "ciao" }));
    expect(res.status).toBe(403);
  });

  it("chiama authorizePricingRequest con SOLO admin/operator/supervisor (mai driver/agency)", async () => {
    authorizeAs();
    await POST(req({ message: "ciao" }));
    expect(mocks.authorizePricingRequest).toHaveBeenCalledWith(expect.anything(), ["admin", "operator", "supervisor"]);
  });
});

describe("POST /api/mario-assistant — 14/21. tenant isolation", () => {
  it("14/21. un tenantId nel body viene ignorato/rifiutato: il tenant usato e' SEMPRE quello risolto server-side da authorizePricingRequest", async () => {
    authorizeAs("operator", TENANT_A);
    const res = await POST(req({ message: "ciao", tenantId: "attacker-tenant" }));
    // bodySchema e' .strict(): un campo extra come tenantId fa fallire la validazione -> 400, mai accettato.
    expect(res.status).toBe(400);
    expect(mocks.runMarioAssistant).not.toHaveBeenCalled();
  });
});

describe("POST /api/mario-assistant — 15. rate limit", () => {
  it("troppe richieste -> 429, nessuna chiamata a runMarioAssistant", async () => {
    authorizeAs();
    mocks.checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    const res = await POST(req({ message: "ciao" }));
    expect(res.status).toBe(429);
    expect(mocks.runMarioAssistant).not.toHaveBeenCalled();
  });

  it("usa tenant+user come chiave di rate limit (mai solo IP/globale)", async () => {
    authorizeAs("operator", TENANT_A);
    await POST(req({ message: "ciao" }));
    expect(mocks.checkRateLimit).toHaveBeenCalledWith("mario-assistant", `${TENANT_A}:user-1`, expect.any(Object));
  });
});

describe("POST /api/mario-assistant — 16. nessun tool selezionabile dal client", () => {
  it("un campo toolName nel body viene rifiutato dallo schema .strict(), mai raggiunge l'orchestratore", async () => {
    authorizeAs();
    const res = await POST(req({ message: "ciao", toolName: "its.assign_driver" }));
    expect(res.status).toBe(400);
    expect(mocks.runMarioAssistant).not.toHaveBeenCalled();
  });
});

describe("POST /api/mario-assistant — 17. safe error / input invalido", () => {
  it("messaggio mancante -> 400, mai un'eccezione grezza", async () => {
    authorizeAs();
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });

  it("messaggio troppo lungo (>500) -> 400", async () => {
    authorizeAs();
    const res = await POST(req({ message: "a".repeat(600) }));
    expect(res.status).toBe(400);
  });

  it("corpo JSON malformato -> 400, non un 500", async () => {
    authorizeAs();
    const badReq = new NextRequest("https://example.test/api/mario-assistant", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: "{not json",
    });
    const res = await POST(badReq);
    expect(res.status).toBe(400);
  });
});
