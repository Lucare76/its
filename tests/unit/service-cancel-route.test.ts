import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  getOperatorName: vi.fn(),
  readServiceSnapshot: vi.fn(),
  logServiceChange: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));

vi.mock("@/lib/server/service-audit-log", () => ({
  getOperatorName: mocks.getOperatorName,
  readServiceSnapshot: mocks.readServiceSnapshot,
  logServiceChange: mocks.logServiceChange,
}));

import { POST } from "@/app/api/ops/services/[id]/cancel/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTWARD_ID = "11111111-1111-4111-8111-111111111111";
const RETURN_ID = "22222222-2222-4222-8222-222222222222";

function makeRequest(id: string, body: unknown) {
  return {
    request: new NextRequest(`http://localhost:3010/api/ops/services/${id}/cancel`, { method: "POST", body: JSON.stringify(body) }),
    params: Promise.resolve({ id }),
  };
}

function makeAuthContext(rpcImpl: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>) {
  return {
    admin: { rpc: rpcImpl },
    user: { id: "user-1", email: "operatore@test.it" },
    membership: { tenant_id: TENANT, role: "operator", suspended: false },
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return { id: OUTWARD_ID, status: "confirmed", linked_service_id: null, ...overrides };
}

describe("POST /api/ops/services/[id]/cancel — scope leg vs practice, atomicita'", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOperatorName.mockResolvedValue("Mario Rossi");
    mocks.readServiceSnapshot.mockResolvedValue(snapshot());
    mocks.logServiceChange.mockResolvedValue(undefined);
  });

  it("1. pratica A/R -> cancella solo ANDATA: RPC chiamata con scope='leg' sul solo id ANDATA", async () => {
    mocks.readServiceSnapshot.mockResolvedValue(snapshot({ id: OUTWARD_ID, linked_service_id: RETURN_ID }));
    const rpcSpy = vi.fn(async () => ({
      data: [{ out_service_id: OUTWARD_ID, assignments_cleared: 0, bus_allocations_cleared: 0 }],
      error: null,
    }));
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(rpcSpy));

    const { request, params } = makeRequest(OUTWARD_ID, { reason: "Cliente ha annullato", scope: "leg" });
    const res = await POST(request, { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.service_ids).toEqual([OUTWARD_ID]);
    expect(rpcSpy).toHaveBeenCalledWith("cancel_service_practice", expect.objectContaining({ p_service_id: OUTWARD_ID, p_scope: "leg" }));
  });

  it("2. pratica A/R -> cancella solo RITORNO: RPC chiamata con scope='leg' sul solo id RITORNO", async () => {
    mocks.readServiceSnapshot.mockResolvedValue(snapshot({ id: RETURN_ID, linked_service_id: OUTWARD_ID }));
    const rpcSpy = vi.fn(async () => ({
      data: [{ out_service_id: RETURN_ID, assignments_cleared: 0, bus_allocations_cleared: 0 }],
      error: null,
    }));
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(rpcSpy));

    const { request, params } = makeRequest(RETURN_ID, { reason: "Cliente ha annullato", scope: "leg" });
    const res = await POST(request, { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.service_ids).toEqual([RETURN_ID]);
    expect(rpcSpy).toHaveBeenCalledWith("cancel_service_practice", expect.objectContaining({ p_service_id: RETURN_ID, p_scope: "leg" }));
  });

  it("3. pratica A/R -> cancella entrambe: RPC chiamata con scope='practice', response include entrambi gli id", async () => {
    mocks.readServiceSnapshot.mockResolvedValue(snapshot({ id: OUTWARD_ID, linked_service_id: RETURN_ID }));
    const rpcSpy = vi.fn(async () => ({
      data: [
        { out_service_id: OUTWARD_ID, assignments_cleared: 0, bus_allocations_cleared: 0 },
        { out_service_id: RETURN_ID, assignments_cleared: 0, bus_allocations_cleared: 0 },
      ],
      error: null,
    }));
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(rpcSpy));

    const { request, params } = makeRequest(OUTWARD_ID, { reason: "Cliente ha annullato", scope: "practice" });
    const res = await POST(request, { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.service_ids.sort()).toEqual([OUTWARD_ID, RETURN_ID].sort());
    expect(rpcSpy).toHaveBeenCalledWith("cancel_service_practice", expect.objectContaining({ p_scope: "practice" }));
  });

  it("4. prenotazione solo ANDATA (nessuna gamba collegata) -> scope default 'leg', un solo id coinvolto", async () => {
    mocks.readServiceSnapshot.mockResolvedValue(snapshot({ id: OUTWARD_ID, linked_service_id: null }));
    const rpcSpy = vi.fn(async () => ({
      data: [{ out_service_id: OUTWARD_ID, assignments_cleared: 0, bus_allocations_cleared: 0 }],
      error: null,
    }));
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(rpcSpy));

    const { request, params } = makeRequest(OUTWARD_ID, { reason: "Cliente ha annullato" });
    const res = await POST(request, { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.service_ids).toEqual([OUTWARD_ID]);
    expect(rpcSpy).toHaveBeenCalledWith("cancel_service_practice", expect.objectContaining({ p_scope: "leg" }));
  });

  it("5. tratta con assignment autista -> assignments_cleared riflesso nella response", async () => {
    const rpcSpy = vi.fn(async () => ({
      data: [{ out_service_id: OUTWARD_ID, assignments_cleared: 1, bus_allocations_cleared: 0 }],
      error: null,
    }));
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(rpcSpy));
    const { request, params } = makeRequest(OUTWARD_ID, { reason: "Cliente ha annullato" });
    const res = await POST(request, { params });
    const json = await res.json();
    expect(json.assignments_cleared).toBe(1);
  });

  it("6. tratta con allocazione Rete Bus -> bus_allocations_cleared riflesso nella response", async () => {
    const rpcSpy = vi.fn(async () => ({
      data: [{ out_service_id: OUTWARD_ID, assignments_cleared: 0, bus_allocations_cleared: 1 }],
      error: null,
    }));
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(rpcSpy));
    const { request, params } = makeRequest(OUTWARD_ID, { reason: "Cliente ha annullato" });
    const res = await POST(request, { params });
    const json = await res.json();
    expect(json.bus_allocations_cleared).toBe(1);
  });

  it("7. tratta con assignment + bus allocation, scope='practice' -> conteggi sommati su entrambe le gambe", async () => {
    mocks.readServiceSnapshot.mockResolvedValue(snapshot({ id: OUTWARD_ID, linked_service_id: RETURN_ID }));
    const rpcSpy = vi.fn(async () => ({
      data: [
        { out_service_id: OUTWARD_ID, assignments_cleared: 1, bus_allocations_cleared: 1 },
        { out_service_id: RETURN_ID, assignments_cleared: 1, bus_allocations_cleared: 0 },
      ],
      error: null,
    }));
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(rpcSpy));
    const { request, params } = makeRequest(OUTWARD_ID, { reason: "Cliente ha annullato", scope: "practice" });
    const res = await POST(request, { params });
    const json = await res.json();
    expect(json.assignments_cleared).toBe(2);
    expect(json.bus_allocations_cleared).toBe(1);
  });

  it("8. errore nella RPC (es. rimozione assignment fallita nella transazione) -> 500, nessun successo, nessuna scrittura parziale percepita", async () => {
    const rpcSpy = vi.fn(async () => ({ data: null, error: { message: "assignment removal failed" } }));
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(rpcSpy));
    const { request, params } = makeRequest(OUTWARD_ID, { reason: "Cliente ha annullato" });
    const res = await POST(request, { params });
    const json = await res.json();
    expect(res.status).toBe(500);
    expect(json.ok).not.toBe(true);
    expect(typeof json.error).toBe("string");
  });

  it("9. errore nella RPC (es. rimozione allocazione bus fallita nella transazione) -> 500, nessun successo", async () => {
    const rpcSpy = vi.fn(async () => ({ data: null, error: { message: "bus allocation removal failed" } }));
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(rpcSpy));
    const { request, params } = makeRequest(OUTWARD_ID, { reason: "Cliente ha annullato" });
    const res = await POST(request, { params });
    const json = await res.json();
    expect(res.status).toBe(500);
    expect(json.ok).not.toBe(true);
  });

  it("13. nessun falso messaggio di successo in presenza di errore parziale: risposta di errore non contiene mai ok:true", async () => {
    const rpcSpy = vi.fn(async () => ({ data: null, error: { message: "transaction rolled back" } }));
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(rpcSpy));
    const { request, params } = makeRequest(OUTWARD_ID, { reason: "Cliente ha annullato" });
    const res = await POST(request, { params });
    const json = await res.json();
    expect(json).not.toHaveProperty("ok", true);
    expect(res.status).not.toBe(200);
  });

  it("servizio gia' cancellato, scope='leg' -> nessuna chiamata RPC, risposta idempotente already_cancelled", async () => {
    mocks.readServiceSnapshot.mockResolvedValue(snapshot({ id: OUTWARD_ID, status: "cancelled", linked_service_id: null }));
    const rpcSpy = vi.fn();
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(rpcSpy));
    const { request, params } = makeRequest(OUTWARD_ID, { reason: "Cliente ha annullato" });
    const res = await POST(request, { params });
    const json = await res.json();
    expect(json).toEqual({ ok: true, already_cancelled: true });
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("nessun body/reason mancante -> 400, nessuna chiamata RPC", async () => {
    const rpcSpy = vi.fn();
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(rpcSpy));
    const { request, params } = makeRequest(OUTWARD_ID, {});
    const res = await POST(request, { params });
    expect(res.status).toBe(400);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("scope non valido -> 400 (zod), nessuna chiamata RPC", async () => {
    const rpcSpy = vi.fn();
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(rpcSpy));
    const { request, params } = makeRequest(OUTWARD_ID, { reason: "Cliente ha annullato", scope: "everything" });
    const res = await POST(request, { params });
    expect(res.status).toBe(400);
    expect(rpcSpy).not.toHaveBeenCalled();
  });
});
