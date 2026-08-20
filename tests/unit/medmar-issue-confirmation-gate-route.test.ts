import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  consumeConfirmationToken: vi.fn(),
  createMedmarIssueOrchestrator: vi.fn(),
  issueMedmar: vi.fn(),
  auditLog: vi.fn(),
  deliverMedmarTicketWithTimeout: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));

vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: mocks.auditLog,
}));

vi.mock("@/lib/server/medmar-booking/issue-confirmation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/medmar-booking/issue-confirmation")>(
    "@/lib/server/medmar-booking/issue-confirmation"
  );
  return { ...actual, consumeConfirmationToken: mocks.consumeConfirmationToken };
});

vi.mock("@/lib/server/medmar-booking/issue-orchestrator", () => ({
  createMedmarIssueOrchestrator: mocks.createMedmarIssueOrchestrator,
}));

// Critico: senza questo mock, ogni test qui che restituisce status "completed"
// (vedi mocks.issueMedmar sotto) innescherebbe una VERA connessione POP3 alla
// mailbox reale tramite l'auto-delivery collegata alla route — mai accettabile
// in un test unitario.
vi.mock("@/lib/server/medmar-booking/pdf-delivery", () => ({
  deliverMedmarTicketWithTimeout: mocks.deliverMedmarTicketWithTimeout,
}));

import { POST } from "@/app/api/services/medmar-issue/route";
import { MedmarConfirmationInvalidError } from "@/lib/server/medmar-booking/issue-confirmation";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SVC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost:3010/api/services/medmar-issue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeAuthContext() {
  return {
    admin: {} as never,
    user: { id: "user-1", email: "a@b.test" },
    membership: { tenant_id: TENANT, role: "operator", suspended: false },
  };
}

describe("POST /api/services/medmar-issue — gate di conferma server-side (Fase 2B.3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext());
    mocks.createMedmarIssueOrchestrator.mockReturnValue(mocks.issueMedmar);
    mocks.issueMedmar.mockResolvedValue({
      ok: true,
      status: "completed",
      idempotency_key: "k",
      attempt_id: "a1",
      medmar_id_prenotazione: "1",
      medmar_numero: "N1",
      final_total_cents: 1150,
      existing: false,
    });
    mocks.deliverMedmarTicketWithTimeout.mockResolvedValue({ status: "delivered", warning: null, recipient_email: "agenzia@example.test" });
  });

  it("confirmation_token mancante -> 400, zero orchestrazione", async () => {
    const res = await POST(makeRequest({ service_ids: [SVC] }));
    expect(res.status).toBe(400);
    expect(mocks.consumeConfirmationToken).not.toHaveBeenCalled();
    expect(mocks.issueMedmar).not.toHaveBeenCalled();
  });

  it("confirmation_token invalido/scaduto/gia usato -> 409, zero orchestrazione", async () => {
    mocks.consumeConfirmationToken.mockRejectedValue(new MedmarConfirmationInvalidError());
    const res = await POST(makeRequest({ service_ids: [SVC], confirmation_token: "bad" }));
    expect(res.status).toBe(409);
    expect(mocks.issueMedmar).not.toHaveBeenCalled();
  });

  it("confirmation_token valido -> orchestrazione invocata una sola volta", async () => {
    mocks.consumeConfirmationToken.mockResolvedValue({
      id: "c1",
      tenant_id: TENANT,
      token: "good",
      service_ids: [SVC],
      expected_total_cents: 1150,
      expires_at: new Date().toISOString(),
    });
    const res = await POST(makeRequest({ service_ids: [SVC], confirmation_token: "good" }));
    expect(res.status).toBe(200);
    expect(mocks.issueMedmar).toHaveBeenCalledTimes(1);
  });

  it("stesso token riusato su una seconda richiesta -> seconda bloccata, zero seconda orchestrazione", async () => {
    mocks.consumeConfirmationToken
      .mockResolvedValueOnce({
        id: "c1",
        tenant_id: TENANT,
        token: "good",
        service_ids: [SVC],
        expected_total_cents: 1150,
        expires_at: new Date().toISOString(),
      })
      .mockRejectedValueOnce(new MedmarConfirmationInvalidError());

    const first = await POST(makeRequest({ service_ids: [SVC], confirmation_token: "good" }));
    expect(first.status).toBe(200);
    expect(mocks.issueMedmar).toHaveBeenCalledTimes(1);

    const second = await POST(makeRequest({ service_ids: [SVC], confirmation_token: "good" }));
    expect(second.status).toBe(409);
    expect(mocks.issueMedmar).toHaveBeenCalledTimes(1);
  });
});
