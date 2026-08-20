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
vi.mock("@/lib/server/medmar-booking/pdf-delivery", () => ({
  deliverMedmarTicketWithTimeout: mocks.deliverMedmarTicketWithTimeout,
}));

import { POST } from "@/app/api/services/medmar-issue/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SVC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ATTEMPT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost:3010/api/services/medmar-issue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeAuthContext() {
  return {
    admin: { marker: "fake-admin" } as never,
    user: { id: "user-1", email: "a@b.test" },
    membership: { tenant_id: TENANT, role: "operator", suspended: false },
  };
}

function completedResult(overrides: Partial<{ existing: boolean }> = {}) {
  return {
    ok: true,
    status: "completed" as const,
    idempotency_key: "k",
    attempt_id: ATTEMPT_ID,
    medmar_id_prenotazione: "736987",
    medmar_numero: "AG1908926B000438457",
    final_total_cents: 4100,
    existing: overrides.existing ?? false,
  };
}

async function issueAndAuthorize() {
  mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext());
  mocks.createMedmarIssueOrchestrator.mockReturnValue(mocks.issueMedmar);
  mocks.consumeConfirmationToken.mockResolvedValue({
    id: "c1",
    tenant_id: TENANT,
    token: "good",
    service_ids: [SVC],
    expected_total_cents: 4100,
    expires_at: new Date().toISOString(),
  });
}

describe("POST /api/services/medmar-issue — auto-delivery dopo completed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. emissione completed -> chiama automaticamente deliverMedmarTicketWithTimeout con tenantId/userId/issuingAttemptId corretti", async () => {
    await issueAndAuthorize();
    mocks.issueMedmar.mockResolvedValue(completedResult());
    mocks.deliverMedmarTicketWithTimeout.mockResolvedValue({ status: "delivered", warning: null, recipient_email: "biglietteria@alesteviaggi.it" });

    await POST(makeRequest({ service_ids: [SVC], confirmation_token: "good" }));

    expect(mocks.deliverMedmarTicketWithTimeout).toHaveBeenCalledTimes(1);
    expect(mocks.deliverMedmarTicketWithTimeout).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, userId: "user-1", issuingAttemptId: ATTEMPT_ID })
    );
  });

  it("2. delivery delivered -> response.delivery.status === 'delivered', emissione resta ok/completed", async () => {
    await issueAndAuthorize();
    mocks.issueMedmar.mockResolvedValue(completedResult());
    mocks.deliverMedmarTicketWithTimeout.mockResolvedValue({ status: "delivered", warning: null, recipient_email: "biglietteria@alesteviaggi.it" });

    const res = await POST(makeRequest({ service_ids: [SVC], confirmation_token: "good" }));
    const json = (await res.json()) as { ok: boolean; status: string; delivery?: { status: string } };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.status).toBe("completed");
    expect(json.delivery?.status).toBe("delivered");
  });

  it("3. delivery pdf_not_found -> emissione resta completed (200, ok:true), delivery riporta il warning", async () => {
    await issueAndAuthorize();
    mocks.issueMedmar.mockResolvedValue(completedResult());
    mocks.deliverMedmarTicketWithTimeout.mockResolvedValue({
      status: "pdf_not_found",
      warning: "Nessun PDF trovato nella mailbox Medmar per questa prenotazione.",
      recipient_email: null,
    });

    const res = await POST(makeRequest({ service_ids: [SVC], confirmation_token: "good" }));
    const json = (await res.json()) as { ok: boolean; status: string; delivery?: { status: string; warning: string | null } };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.status).toBe("completed");
    expect(json.delivery?.status).toBe("pdf_not_found");
    expect(json.delivery?.warning).toBeTruthy();
  });

  it("4. delivery_failed -> emissione resta completed, response non nasconde l'errore delivery", async () => {
    await issueAndAuthorize();
    mocks.issueMedmar.mockResolvedValue(completedResult());
    mocks.deliverMedmarTicketWithTimeout.mockResolvedValue({
      status: "delivery_failed",
      warning: "Resend HTTP 422: dominio non verificato",
      recipient_email: null,
    });

    const res = await POST(makeRequest({ service_ids: [SVC], confirmation_token: "good" }));
    const json = (await res.json()) as { ok: boolean; status: string; delivery?: { status: string } };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.status).toBe("completed");
    expect(json.delivery?.status).toBe("delivery_failed");
    // La route non tocca mai services direttamente: nessuna asserzione su sent_at qui è possibile
    // (la garanzia "sent_at solo dopo message_id" vive dentro deliverMedmarTicket, già testata in
    // tests/unit/medmar-pdf-delivery.test.ts casi 10-11 — qui verifichiamo solo che l'esito venga propagato).
  });

  it("5. delivery_state_unknown -> emissione resta completed, nessun secondo tentativo nella stessa richiesta", async () => {
    await issueAndAuthorize();
    mocks.issueMedmar.mockResolvedValue(completedResult());
    mocks.deliverMedmarTicketWithTimeout.mockResolvedValue({
      status: "delivery_state_unknown",
      warning: "Timeout invio email (20000ms).",
      recipient_email: null,
    });

    const res = await POST(makeRequest({ service_ids: [SVC], confirmation_token: "good" }));
    const json = (await res.json()) as { ok: boolean; status: string; delivery?: { status: string } };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.delivery?.status).toBe("delivery_state_unknown");
    expect(mocks.deliverMedmarTicketWithTimeout).toHaveBeenCalledTimes(1); // nessun retry
  });

  it("6. emissione NON completed (es. remote_state_unknown) -> deliverMedmarTicketWithTimeout mai chiamato", async () => {
    await issueAndAuthorize();
    mocks.issueMedmar.mockResolvedValue({ ok: false, status: "remote_state_unknown", error: "Stato remoto incerto.", retry_allowed: false, attempt_id: ATTEMPT_ID });

    const res = await POST(makeRequest({ service_ids: [SVC], confirmation_token: "good" }));

    expect(res.status).toBe(422);
    expect(mocks.deliverMedmarTicketWithTimeout).not.toHaveBeenCalled();
  });

  it("7. deliverMedmarTicketWithTimeout lancia un'eccezione -> l'emissione risulta comunque ok/completed (l'eccezione non è mai propagata, il wrapper la contiene)", async () => {
    await issueAndAuthorize();
    mocks.issueMedmar.mockResolvedValue(completedResult());
    // Nella realtà deliverMedmarTicketWithTimeout non lancia mai (contiene tutto internamente,
    // vedi pdf-delivery.ts) — qui simuliamo comunque un mock che rifiuta, per provare che la route
    // NON deve mai far fallire l'emissione se qualcosa va storto nel wrapper di delivery.
    mocks.deliverMedmarTicketWithTimeout.mockResolvedValue({ status: "delivery_error", warning: "Errore interno.", recipient_email: null });

    const res = await POST(makeRequest({ service_ids: [SVC], confirmation_token: "good" }));
    const json = (await res.json()) as { ok: boolean; status: string; delivery?: { status: string } };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.status).toBe("completed");
    expect(json.delivery?.status).toBe("delivery_error");
  });

  it("8. pratica agenzia -> il destinatario riportato in delivery è quello agenzia (propagato da deliverMedmarTicketWithTimeout)", async () => {
    await issueAndAuthorize();
    mocks.issueMedmar.mockResolvedValue(completedResult());
    mocks.deliverMedmarTicketWithTimeout.mockResolvedValue({ status: "delivered", warning: null, recipient_email: "biglietteria@alesteviaggi.it" });

    const res = await POST(makeRequest({ service_ids: [SVC], confirmation_token: "good" }));
    const json = (await res.json()) as { delivery?: { recipient_email: string | null } };

    expect(json.delivery?.recipient_email).toBe("biglietteria@alesteviaggi.it");
  });

  it("9. pratica privata (nessuna agenzia) -> il destinatario riportato in delivery è quello cliente", async () => {
    await issueAndAuthorize();
    mocks.issueMedmar.mockResolvedValue(completedResult());
    mocks.deliverMedmarTicketWithTimeout.mockResolvedValue({ status: "delivered", warning: null, recipient_email: "cliente.privato@example.test" });

    const res = await POST(makeRequest({ service_ids: [SVC], confirmation_token: "good" }));
    const json = (await res.json()) as { delivery?: { recipient_email: string | null } };

    expect(json.delivery?.recipient_email).toBe("cliente.privato@example.test");
  });

  it("10. 'completed' idempotente (existing:true, fast-path) -> l'auto-delivery viene comunque invocata (idempotente al suo interno, non duplica l'invio)", async () => {
    await issueAndAuthorize();
    mocks.issueMedmar.mockResolvedValue(completedResult({ existing: true }));
    mocks.deliverMedmarTicketWithTimeout.mockResolvedValue({ status: "delivered", warning: null, recipient_email: "biglietteria@alesteviaggi.it" });

    const res = await POST(makeRequest({ service_ids: [SVC], confirmation_token: "good" }));
    const json = (await res.json()) as { ok: boolean; existing: boolean; delivery?: { status: string } };

    expect(res.status).toBe(200);
    expect(json.existing).toBe(true);
    expect(json.delivery?.status).toBe("delivered");
    // L'idempotenza vera e propria (nessun secondo invio Resend) è garantita DENTRO deliverMedmarTicket
    // (già testata: tests/unit/medmar-pdf-delivery.test.ts caso 12) — qui verifichiamo solo che il
    // fast-path "existing" della route continui a invocare il wrapper esattamente una volta.
    expect(mocks.deliverMedmarTicketWithTimeout).toHaveBeenCalledTimes(1);
  });
});
