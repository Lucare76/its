import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  runMedmarDeliveryRetryBatch: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({}),
}));

vi.mock("@/lib/server/medmar-booking/delivery-retry", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/medmar-booking/delivery-retry")>(
    "@/lib/server/medmar-booking/delivery-retry"
  );
  return {
    ...actual,
    runMedmarDeliveryRetryBatch: mocks.runMedmarDeliveryRetryBatch,
  };
});

import { GET } from "@/app/api/cron/medmar-delivery-retry/route";

function makeRequest(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, { method: "GET", headers });
}

const SUMMARY = {
  candidates_found: 2,
  processed: 2,
  delivered: 1,
  still_pending: 1,
  escalated_to_manual_review: 0,
  errors: 0,
  results: [],
};

describe("GET /api/cron/medmar-delivery-retry", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.CRON_SECRET = "test-cron-secret";
  });

  it("rifiuta richieste senza il Bearer CRON_SECRET corretto (401)", async () => {
    const res = await GET(makeRequest("http://localhost:3010/api/cron/medmar-delivery-retry"));
    expect(res.status).toBe(401);
    expect(mocks.runMedmarDeliveryRetryBatch).not.toHaveBeenCalled();
  });

  it("rifiuta un secret errato", async () => {
    const res = await GET(
      makeRequest("http://localhost:3010/api/cron/medmar-delivery-retry", { authorization: "Bearer wrong-secret" })
    );
    expect(res.status).toBe(401);
    expect(mocks.runMedmarDeliveryRetryBatch).not.toHaveBeenCalled();
  });

  it("500 se CRON_SECRET non configurato lato server", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(makeRequest("http://localhost:3010/api/cron/medmar-delivery-retry"));
    expect(res.status).toBe(500);
  });

  it("con secret corretto esegue il batch e restituisce il summary", async () => {
    mocks.runMedmarDeliveryRetryBatch.mockResolvedValue(SUMMARY);
    const res = await GET(
      makeRequest("http://localhost:3010/api/cron/medmar-delivery-retry", { authorization: "Bearer test-cron-secret" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.delivered).toBe(1);
    expect(mocks.runMedmarDeliveryRetryBatch).toHaveBeenCalledTimes(1);
  });

  it("rispetta il parametro ?limit= (capped a 50)", async () => {
    mocks.runMedmarDeliveryRetryBatch.mockResolvedValue(SUMMARY);
    await GET(
      makeRequest("http://localhost:3010/api/cron/medmar-delivery-retry?limit=3", { authorization: "Bearer test-cron-secret" })
    );
    expect(mocks.runMedmarDeliveryRetryBatch).toHaveBeenCalledWith(expect.anything(), 3);

    await GET(
      makeRequest("http://localhost:3010/api/cron/medmar-delivery-retry?limit=999", { authorization: "Bearer test-cron-secret" })
    );
    expect(mocks.runMedmarDeliveryRetryBatch).toHaveBeenCalledWith(expect.anything(), 50);
  });

  it("500 se il batch lancia un'eccezione, errore contenuto senza propagare dettagli sensibili", async () => {
    mocks.runMedmarDeliveryRetryBatch.mockRejectedValue(new Error("connessione mailbox fallita: host/porta/credenziali interne"));
    const res = await GET(
      makeRequest("http://localhost:3010/api/cron/medmar-delivery-retry", { authorization: "Bearer test-cron-secret" })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).not.toContain("host/porta/credenziali");
  });
});
