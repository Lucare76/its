import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  deliverMedmarTicket: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));

vi.mock("@/lib/server/medmar-booking/pdf-delivery", () => ({
  deliverMedmarTicket: mocks.deliverMedmarTicket,
}));

import { POST } from "@/app/api/services/medmar-send/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SVC1 = "11111111-1111-4111-8111-111111111111";
const SVC2 = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost:3010/api/services/medmar-send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeAuthContext(servicesUpdateSpy: (payload: unknown) => void, attemptsOverlapResult: unknown[]) {
  return {
    admin: {
      from(table: string) {
        if (table === "medmar_issuing_attempts") {
          return {
            select() {
              return this;
            },
            eq() {
              return this;
            },
            overlaps() {
              return Promise.resolve({ data: attemptsOverlapResult, error: null });
            },
          };
        }
        if (table === "services") {
          // Se il vecchio comportamento sopravvivesse, questo spy lo rileverebbe:
          // nessun test qui invoca mai .update() su services, la route non deve
          // toccare la tabella direttamente (delega sempre a deliverMedmarTicket).
          return {
            update(payload: unknown) {
              servicesUpdateSpy(payload);
              return { in() { return this; }, eq() { return Promise.resolve({ error: null }); } };
            },
          };
        }
        throw new Error(`tabella inattesa: ${table}`);
      },
    } as never,
    user: { id: "user-1", email: "a@b.test" },
    membership: { tenant_id: TENANT, role: "operator", suspended: false },
  };
}

describe("POST /api/services/medmar-send — wrapper sicuro (Fase delivery)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("15a. senza medmar_issuing_attempts 'completed' per i service_ids -> fail-closed, nessuna mutazione, deliverMedmarTicket mai chiamato", async () => {
    const servicesUpdateSpy = vi.fn();
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(servicesUpdateSpy, []));

    const res = await POST(makeRequest({ service_ids: [SVC1, SVC2] }));
    const json = (await res.json()) as { ok: boolean; code?: string };

    expect(res.status).toBe(409);
    expect(json.ok).toBe(false);
    expect(json.code).toBe("no_completed_issuing_attempt");
    expect(mocks.deliverMedmarTicket).not.toHaveBeenCalled();
    expect(servicesUpdateSpy).not.toHaveBeenCalled();
  });

  it("15b. con un PDF client-side allegato (pdf_base64 legacy) e nessun attempt completato -> comunque fail-closed, il body pdf_base64 viene ignorato e mai inoltrato", async () => {
    const servicesUpdateSpy = vi.fn();
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(servicesUpdateSpy, []));

    const res = await POST(makeRequest({ service_ids: [SVC1], pdf_base64: "ZmFrZS1wZGYtb3JpZ2luYWxl", pdf_filename: "originale.pdf" }));
    const json = (await res.json()) as { ok: boolean };

    expect(res.status).toBe(409);
    expect(json.ok).toBe(false);
    expect(mocks.deliverMedmarTicket).not.toHaveBeenCalled();
  });

  it("15c. con un medmar_issuing_attempts 'completed' corrispondente -> delega a deliverMedmarTicket, non muta mai services direttamente", async () => {
    const servicesUpdateSpy = vi.fn();
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(servicesUpdateSpy, [{ id: ATTEMPT_ID, service_ids: [SVC1, SVC2] }])
    );
    mocks.deliverMedmarTicket.mockResolvedValue({
      ok: true,
      status: "delivered",
      already_delivered: false,
      attempt: { recipient_email: "biglietteria@alesteviaggi.it", resend_message_id: "resend-msg-1" },
    });

    const res = await POST(makeRequest({ service_ids: [SVC1, SVC2] }));
    const json = (await res.json()) as { ok: boolean; status?: string; resend_message_id?: string };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.status).toBe("delivered");
    expect(json.resend_message_id).toBe("resend-msg-1");
    expect(mocks.deliverMedmarTicket).toHaveBeenCalledTimes(1);
    expect(mocks.deliverMedmarTicket).toHaveBeenCalledWith(expect.objectContaining({ issuingAttemptId: ATTEMPT_ID, tenantId: TENANT }));
    // La route non deve mai chiamare .update() su services essa stessa: solo deliverMedmarTicket lo fa (mockato qui, quindi zero chiamate reali).
    expect(servicesUpdateSpy).not.toHaveBeenCalled();
  });

  it("15d. deliverMedmarTicket restituisce un esito negativo (es. pdf_not_found) -> la route lo propaga fedelmente, non lo trasforma mai in un 'ok'", async () => {
    const servicesUpdateSpy = vi.fn();
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(servicesUpdateSpy, [{ id: ATTEMPT_ID, service_ids: [SVC1, SVC2] }])
    );
    mocks.deliverMedmarTicket.mockResolvedValue({
      ok: false,
      status: "pdf_not_found",
      error: "Nessun PDF trovato nella mailbox Medmar per questa prenotazione.",
    });

    const res = await POST(makeRequest({ service_ids: [SVC1, SVC2] }));
    const json = (await res.json()) as { ok: boolean; status?: string };

    expect(res.status).toBe(409);
    expect(json.ok).toBe(false);
    expect(json.status).toBe("pdf_not_found");
  });

  it("15e. la route espone attempt_count/last_attempt_at per popolare la diagnostica retry in UI (letti da outcome.attempt, nessun invio aggiuntivo)", async () => {
    const servicesUpdateSpy = vi.fn();
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(servicesUpdateSpy, [{ id: ATTEMPT_ID, service_ids: [SVC1, SVC2] }])
    );
    mocks.deliverMedmarTicket.mockResolvedValue({
      ok: false,
      status: "pdf_not_found",
      error: "Nessun PDF trovato nella mailbox Medmar per questa prenotazione.",
      attempt: { attempt_count: 2, updated_at: "2026-08-20T15:00:00.000Z" },
    });

    const res = await POST(makeRequest({ service_ids: [SVC1, SVC2] }));
    const json = (await res.json()) as { attempt_count?: number; last_attempt_at?: string };

    expect(json.attempt_count).toBe(2);
    expect(json.last_attempt_at).toBe("2026-08-20T15:00:00.000Z");
  });
});
