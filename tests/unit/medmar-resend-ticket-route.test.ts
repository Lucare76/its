import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  resendMedmarTicket: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));

vi.mock("@/lib/server/medmar-booking/ticket-resend", () => ({
  resendMedmarTicket: mocks.resendMedmarTicket,
}));

import { POST } from "@/app/api/services/medmar-resend-ticket/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DELIVERY_ATTEMPT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost:3010/api/services/medmar-resend-ticket", {
    method: "POST",
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

describe("POST /api/services/medmar-resend-ticket", () => {
  beforeEach(() => vi.clearAllMocks());

  it("1. sessione non autorizzata -> propaga la 401, resendMedmarTicket non chiamato", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const res = await POST(makeRequest({ delivery_attempt_id: DELIVERY_ATTEMPT_ID }));
    expect(res.status).toBe(401);
    expect(mocks.resendMedmarTicket).not.toHaveBeenCalled();
  });

  it("2. richiede ruolo admin/operator/supervisor (coerente con /biglietti-medmar)", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext());
    mocks.resendMedmarTicket.mockResolvedValue({ ok: true, status: "sent", resendMessageId: "m1", hashWarning: false, ledgerId: "l1" });
    await POST(makeRequest({ delivery_attempt_id: DELIVERY_ATTEMPT_ID }));
    expect(mocks.authorizePricingRequest).toHaveBeenCalledWith(expect.anything(), ["admin", "operator", "supervisor"]);
  });

  it("3. body non valido -> 400, resendMedmarTicket non chiamato", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext());
    const req = new NextRequest("http://localhost:3010/api/services/medmar-resend-ticket", { method: "POST", body: "{not json" });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mocks.resendMedmarTicket).not.toHaveBeenCalled();
  });

  it("4. delivery_attempt_id mancante -> 400", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext());
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    expect(mocks.resendMedmarTicket).not.toHaveBeenCalled();
  });

  it("5. NON accetta recipient_email nel payload: anche se inviato, il valore passato all'orchestratore non lo include", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext());
    mocks.resendMedmarTicket.mockResolvedValue({ ok: true, status: "sent", resendMessageId: "m1", hashWarning: false, ledgerId: "l1" });
    await POST(makeRequest({ delivery_attempt_id: DELIVERY_ATTEMPT_ID, recipient_email: "attacker@example.com" }));
    const callArg = mocks.resendMedmarTicket.mock.calls[0]![0];
    expect(callArg).not.toHaveProperty("recipientEmail");
    expect(callArg).not.toHaveProperty("recipient_email");
    expect(callArg.deliveryAttemptId).toBe(DELIVERY_ATTEMPT_ID);
  });

  it("6. tenant isolation: tenantId passato all'orchestratore e' quello della membership autenticata", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext());
    mocks.resendMedmarTicket.mockResolvedValue({ ok: true, status: "sent", resendMessageId: "m1", hashWarning: false, ledgerId: "l1" });
    await POST(makeRequest({ delivery_attempt_id: DELIVERY_ATTEMPT_ID }));
    expect(mocks.resendMedmarTicket).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT }));
  });

  it("7. successo -> 200 con resend_message_id ed esito", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext());
    mocks.resendMedmarTicket.mockResolvedValue({ ok: true, status: "sent", resendMessageId: "m1", hashWarning: true, ledgerId: "l1" });
    const res = await POST(makeRequest({ delivery_attempt_id: DELIVERY_ATTEMPT_ID }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.resend_message_id).toBe("m1");
    expect(json.hash_warning).toBe(true);
  });

  it("8. rifiuta delivery non delivered -> 422 con status not_delivered", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext());
    mocks.resendMedmarTicket.mockResolvedValue({ ok: false, status: "not_delivered", error: "non consegnato", ledgerId: null });
    const res = await POST(makeRequest({ delivery_attempt_id: DELIVERY_ATTEMPT_ID }));
    const json = await res.json();
    expect(res.status).toBe(422);
    expect(json.status).toBe("not_delivered");
  });

  it("9. rifiuta delivery senza recipient_email -> 422 con status recipient_email_missing", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext());
    mocks.resendMedmarTicket.mockResolvedValue({ ok: false, status: "recipient_email_missing", error: "manca destinatario", ledgerId: null });
    const res = await POST(makeRequest({ delivery_attempt_id: DELIVERY_ATTEMPT_ID }));
    const json = await res.json();
    expect(res.status).toBe(422);
    expect(json.status).toBe("recipient_email_missing");
  });

  it("10. rifiuta delivery senza pdf_mailbox_message_uid -> 422 con status pdf_mailbox_message_uid_missing", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext());
    mocks.resendMedmarTicket.mockResolvedValue({ ok: false, status: "pdf_mailbox_message_uid_missing", error: "manca uid", ledgerId: null });
    const res = await POST(makeRequest({ delivery_attempt_id: DELIVERY_ATTEMPT_ID }));
    const json = await res.json();
    expect(res.status).toBe(422);
    expect(json.status).toBe("pdf_mailbox_message_uid_missing");
  });

  it("11. delivery non trovato -> 404", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext());
    mocks.resendMedmarTicket.mockResolvedValue({ ok: false, status: "delivery_attempt_not_found", error: "non trovato", ledgerId: null });
    const res = await POST(makeRequest({ delivery_attempt_id: DELIVERY_ATTEMPT_ID }));
    expect(res.status).toBe(404);
  });

  it("12. errore PDF/invio (es. pdf_not_found) -> 409", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext());
    mocks.resendMedmarTicket.mockResolvedValue({ ok: false, status: "pdf_not_found", error: "PDF non recuperabile dalla mailbox, reinvio non eseguito.", ledgerId: "l1" });
    const res = await POST(makeRequest({ delivery_attempt_id: DELIVERY_ATTEMPT_ID }));
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error).toContain("PDF non recuperabile dalla mailbox");
  });

  it("13. nessun campo pdf/token/segreto nella risposta di successo", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext());
    mocks.resendMedmarTicket.mockResolvedValue({ ok: true, status: "sent", resendMessageId: "m1", hashWarning: false, ledgerId: "l1" });
    const res = await POST(makeRequest({ delivery_attempt_id: DELIVERY_ATTEMPT_ID }));
    const json = await res.json();
    expect(JSON.stringify(json)).not.toMatch(/pdf_base64|bearer|password/i);
  });
});
