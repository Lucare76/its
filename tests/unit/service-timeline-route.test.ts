import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * GET /api/ops/services/[id]/timeline — Fase 6/7: endpoint lazy, separato
 * dal payload di GET /api/ops/services/[id].
 */

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  getServiceTimelinePage: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));
vi.mock("@/lib/server/service-timeline", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/service-timeline")>("@/lib/server/service-timeline");
  return { ...actual, getServiceTimelinePage: mocks.getServiceTimelinePage };
});

import { GET } from "@/app/api/ops/services/[id]/timeline/route";
import { NextResponse } from "next/server";

const SERVICE_ID = "22222222-2222-2222-2222-222222222222";
const TENANT_ID = "11111111-1111-1111-1111-111111111111";

function makeRequest(url: string) {
  return new NextRequest(url);
}

describe("GET /api/ops/services/[id]/timeline", () => {
  beforeEach(() => {
    mocks.authorizePricingRequest.mockReset();
    mocks.getServiceTimelinePage.mockReset();
  });

  it("auth negata -> propaga la NextResponse di authorizePricingRequest senza chiamare la timeline", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ ok: false }, { status: 401 }));
    const res = await GET(makeRequest(`http://localhost/api/ops/services/${SERVICE_ID}/timeline`), { params: Promise.resolve({ id: SERVICE_ID }) });
    expect(res.status).toBe(401);
    expect(mocks.getServiceTimelinePage).not.toHaveBeenCalled();
  });

  it("id non valido -> 400, mai interroga il DB", async () => {
    mocks.authorizePricingRequest.mockResolvedValue({ admin: {}, user: { id: "u1" }, membership: { tenant_id: TENANT_ID, role: "operator" } });
    const res = await GET(makeRequest("http://localhost/api/ops/services/not-a-uuid/timeline"), { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(res.status).toBe(400);
    expect(mocks.getServiceTimelinePage).not.toHaveBeenCalled();
  });

  it("richiesta valida senza cursor -> chiama getServiceTimelinePage con tenantId/serviceId corretti, cursor null", async () => {
    mocks.authorizePricingRequest.mockResolvedValue({ admin: { marker: "admin" }, user: { id: "u1" }, membership: { tenant_id: TENANT_ID, role: "operator" } });
    mocks.getServiceTimelinePage.mockResolvedValue({ events: [{ id: "x" }], nextCursor: null });
    const res = await GET(makeRequest(`http://localhost/api/ops/services/${SERVICE_ID}/timeline`), { params: Promise.resolve({ id: SERVICE_ID }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.events).toEqual([{ id: "x" }]);
    expect(body.next_cursor).toBeNull();
    expect(mocks.getServiceTimelinePage).toHaveBeenCalledWith(
      expect.objectContaining({ marker: "admin" }),
      { tenantId: TENANT_ID, serviceId: SERVICE_ID, cursor: null }
    );
  });

  it("richiesta con ?cursor= -> passato correttamente all'aggregatore", async () => {
    mocks.authorizePricingRequest.mockResolvedValue({ admin: {}, user: { id: "u1" }, membership: { tenant_id: TENANT_ID, role: "operator" } });
    mocks.getServiceTimelinePage.mockResolvedValue({ events: [], nextCursor: null });
    await GET(makeRequest(`http://localhost/api/ops/services/${SERVICE_ID}/timeline?cursor=abc123`), { params: Promise.resolve({ id: SERVICE_ID }) });
    expect(mocks.getServiceTimelinePage).toHaveBeenCalledWith(expect.anything(), { tenantId: TENANT_ID, serviceId: SERVICE_ID, cursor: "abc123" });
  });

  it("un errore dell'aggregatore risponde 500 senza propagare l'eccezione", async () => {
    mocks.authorizePricingRequest.mockResolvedValue({ admin: {}, user: { id: "u1" }, membership: { tenant_id: TENANT_ID, role: "operator" } });
    mocks.getServiceTimelinePage.mockRejectedValue(new Error("boom"));
    const res = await GET(makeRequest(`http://localhost/api/ops/services/${SERVICE_ID}/timeline`), { params: Promise.resolve({ id: SERVICE_ID }) });
    expect(res.status).toBe(500);
  });
});

describe("Endpoint lazy: separato dal payload principale di GET /api/ops/services/[id]", () => {
  it("app/api/ops/services/[id]/route.ts NON importa service-timeline (nessun accoppiamento, resta un fetch separato)", () => {
    const source = readFileSync(join(process.cwd(), "app/api/ops/services/[id]/route.ts"), "utf8");
    expect(source).not.toMatch(/service-timeline/);
  });

  it("il nuovo endpoint vive in un file route.ts dedicato sotto /timeline (path distinto, chiamata HTTP separata)", () => {
    const source = readFileSync(join(process.cwd(), "app/api/ops/services/[id]/timeline/route.ts"), "utf8");
    expect(source).toMatch(/getServiceTimelinePage/);
    expect(source).toMatch(/export async function GET/);
  });
});
