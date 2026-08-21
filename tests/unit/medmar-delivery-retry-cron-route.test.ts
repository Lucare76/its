import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  runMedmarDeliveryRetryBatch: vi.fn(),
  auditLogAwaited: vi.fn(async () => {}),
  auditLog: vi.fn(),
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

vi.mock("@/lib/server/ops-audit", () => ({
  auditLogAwaited: mocks.auditLogAwaited,
  auditLog: mocks.auditLog,
}));

import { GET } from "@/app/api/cron/medmar-delivery-retry/route";

function makeRequest(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, { method: "GET", headers });
}

const SUMMARY = {
  candidates_found: 2,
  processed: 2,
  delivered: 1,
  deferred: 0,
  skipped: 0,
  still_pending: 1,
  escalated_to_manual_review: 0,
  errors: 0,
  timed_out: false,
  db_query_ms: 12,
  total_ms: 340,
  items: [
    {
      delivery_attempt_id: "attempt-1",
      tenant_id: "tenant-1",
      issuing_attempt_id: "issuing-1",
      medmar_id_prenotazione: "738278",
      medmar_numero: "AG1908926B000442656",
      status_before: "awaiting_pdf",
      result: "delivered",
      resend_message_id: "resend-1",
      elapsed_ms: 300,
    },
  ],
};

describe("GET /api/cron/medmar-delivery-retry", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.auditLogAwaited.mockResolvedValue(undefined);
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

  it("con secret corretto esegue il batch e restituisce il summary con items dettagliati", async () => {
    mocks.runMedmarDeliveryRetryBatch.mockResolvedValue(SUMMARY);
    const res = await GET(
      makeRequest("http://localhost:3010/api/cron/medmar-delivery-retry", { authorization: "Bearer test-cron-secret" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.delivered).toBe(1);
    expect(body.candidates_found).toBe(2);
    expect(body.timedOut).toBe(false);
    expect(body.deferred).toBe(0);
    expect(body.skipped).toBe(0);
    expect(body.total_ms).toBe(340);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].result).toBe("delivered");
    expect(body.items[0].resend_message_id).toBe("resend-1");
    expect(mocks.runMedmarDeliveryRetryBatch).toHaveBeenCalledTimes(1);
  });

  it("rispetta il parametro ?limit= (capped a 3, il max consentito)", async () => {
    mocks.runMedmarDeliveryRetryBatch.mockResolvedValue(SUMMARY);
    await GET(
      makeRequest("http://localhost:3010/api/cron/medmar-delivery-retry?limit=2", { authorization: "Bearer test-cron-secret" })
    );
    expect(mocks.runMedmarDeliveryRetryBatch).toHaveBeenCalledWith(expect.anything(), 2);

    await GET(
      makeRequest("http://localhost:3010/api/cron/medmar-delivery-retry?limit=999", { authorization: "Bearer test-cron-secret" })
    );
    expect(mocks.runMedmarDeliveryRetryBatch).toHaveBeenCalledWith(expect.anything(), 3);
  });

  it("default limit senza ?limit= e' 1", async () => {
    mocks.runMedmarDeliveryRetryBatch.mockResolvedValue(SUMMARY);
    await GET(makeRequest("http://localhost:3010/api/cron/medmar-delivery-retry", { authorization: "Bearer test-cron-secret" }));
    expect(mocks.runMedmarDeliveryRetryBatch).toHaveBeenCalledWith(expect.anything(), 1);
  });

  it("risposta include timedOut/deferred/skipped e items con result='timed_out' quando il batch va in timeout", async () => {
    mocks.runMedmarDeliveryRetryBatch.mockResolvedValue({
      ...SUMMARY,
      timed_out: true,
      processed: 1,
      delivered: 0,
      deferred: 1,
      items: [{ ...SUMMARY.items[0], result: "timed_out", resend_message_id: undefined, elapsed_ms: 26_000 }],
    });
    const res = await GET(
      makeRequest("http://localhost:3010/api/cron/medmar-delivery-retry", { authorization: "Bearer test-cron-secret" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.timedOut).toBe(true);
    expect(body.deferred).toBe(1);
    expect(body.items[0].result).toBe("timed_out");
  });

  it("zero candidati -> HTTP 200 rapido con candidates_found=0 e items vuoto", async () => {
    mocks.runMedmarDeliveryRetryBatch.mockResolvedValue({
      candidates_found: 0,
      processed: 0,
      delivered: 0,
      deferred: 0,
      skipped: 0,
      still_pending: 0,
      escalated_to_manual_review: 0,
      errors: 0,
      timed_out: false,
      db_query_ms: 8,
      total_ms: 15,
      items: [],
    });
    const res = await GET(
      makeRequest("http://localhost:3010/api/cron/medmar-delivery-retry", { authorization: "Bearer test-cron-secret" })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.candidates_found).toBe(0);
    expect(body.timedOut).toBe(false);
    expect(body.items).toEqual([]);
  });

  it("audit cron viene scritto in modo awaited (non fire-and-forget) prima della response", async () => {
    mocks.runMedmarDeliveryRetryBatch.mockResolvedValue(SUMMARY);
    await GET(makeRequest("http://localhost:3010/api/cron/medmar-delivery-retry", { authorization: "Bearer test-cron-secret" }));
    expect(mocks.auditLogAwaited).toHaveBeenCalledTimes(1);
    expect(mocks.auditLogAwaited).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "medmar_delivery_retry_batch",
        tenantId: "tenant-1", // preso dal primo item del batch: ops_audit_events.tenant_id e' NOT NULL
        details: expect.objectContaining({ delivered: 1, timed_out: false }),
      })
    );
  });

  it("500 se il batch lancia un'eccezione, errore contenuto senza propagare dettagli sensibili, audit failure scritto via auditLogAwaited", async () => {
    mocks.runMedmarDeliveryRetryBatch.mockRejectedValue(new Error("connessione mailbox fallita: host/porta/credenziali interne"));
    const res = await GET(
      makeRequest("http://localhost:3010/api/cron/medmar-delivery-retry", { authorization: "Bearer test-cron-secret" })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).not.toContain("host/porta/credenziali");
    expect(mocks.auditLogAwaited).toHaveBeenCalledWith(expect.objectContaining({ event: "medmar_delivery_retry_batch_failed" }));
  });
});
