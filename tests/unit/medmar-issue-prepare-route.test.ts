import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  auditLog: vi.fn(),
  runMedmarPreflight: vi.fn(),
  loadServices: vi.fn(),
  createConfirmationToken: vi.fn(),
  getMedmarIssueConfig: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorizePricingRequest }));
vi.mock("@/lib/server/ops-audit", () => ({ auditLog: mocks.auditLog }));
vi.mock("@/lib/server/medmar-booking/preflight", () => ({ runMedmarPreflight: mocks.runMedmarPreflight }));
vi.mock("@/lib/server/medmar-booking/issue-repository", () => ({
  createIssueRepository: () => ({ loadServices: mocks.loadServices }),
}));
vi.mock("@/lib/server/medmar-booking/issue-confirmation", () => ({
  createConfirmationToken: mocks.createConfirmationToken,
}));
vi.mock("@/lib/server/medmar-booking/issue-config", () => ({
  getMedmarIssueConfig: mocks.getMedmarIssueConfig,
}));

import { POST } from "@/app/api/services/medmar-issue/prepare/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SVC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost:3010/api/services/medmar-issue/prepare", {
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

function preflightOk(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    can_issue: true,
    is_live: true,
    status: "ok",
    pax: 1,
    outward: {
      direction: "outward",
      route: { from: "NAPOLI", to: "ISCHIA" },
      date: "2026-08-20",
      requested_time: "08:40",
      matched_departure_time: "08:40:00",
      vessel: "MEDMAR GIULIA",
      id_corsa: 131943,
      source: "live",
    },
    return: null,
    expected_total_cents: 1150,
    ...overrides,
  };
}

describe("POST /api/services/medmar-issue/prepare — contratto (Fase 2B.4)", () => {
  const ORIGINAL_MEDMAR_DELIVERY_EMAIL = process.env.MEDMAR_DELIVERY_EMAIL;
  beforeEach(() => {
    vi.clearAllMocks();
    // Fase 2B.6 — email tecnica configurata di default: i test di questo
    // blocco esercitano il contratto preesistente del prepare (nessuna
    // agenzia collegata nelle fixture -> destinatario finale = cliente via
    // customer_email), non la gate email in sé (coperta in un blocco dedicato).
    process.env.MEDMAR_DELIVERY_EMAIL = "info@ischiatransferservice.it";
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext());
    mocks.loadServices.mockResolvedValue([
      { id: SVC, tenant_id: TENANT, customer_name: "Mario Rossi", customer_email: "mario@example.test", customer_phone: "123456", pax: 1 },
    ]);
    mocks.createConfirmationToken.mockResolvedValue({ confirmation_token: "tok-1", expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString() });
    mocks.getMedmarIssueConfig.mockReturnValue({ enabled: false, causaleId: 1, modalitaId: 5, vettoreAndataId: 1, vettoreRitornoId: 1 });
  });
  afterEach(() => {
    process.env.MEDMAR_DELIVERY_EMAIL = ORIGINAL_MEDMAR_DELIVERY_EMAIL;
  });

  it("preflight ok + issuing OFF -> 200, issuing_enabled: false, token creato una volta", async () => {
    mocks.runMedmarPreflight.mockResolvedValue(preflightOk());
    const res = await POST(makeRequest({ service_ids: [SVC] }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.issuing_enabled).toBe(false);
    expect(body.confirmation_token).toBe("tok-1");
    expect(body.expected_total_cents).toBe(1150);
    expect(mocks.createConfirmationToken).toHaveBeenCalledTimes(1);
  });

  it("preflight ok + issuing ON -> issuing_enabled: true nella response (capability server-derived)", async () => {
    mocks.runMedmarPreflight.mockResolvedValue(preflightOk());
    mocks.getMedmarIssueConfig.mockReturnValue({ enabled: true, causaleId: 1, modalitaId: 5, vettoreAndataId: 1, vettoreRitornoId: 1 });
    const res = await POST(makeRequest({ service_ids: [SVC] }));
    const body = await res.json();
    expect(body.issuing_enabled).toBe(true);
  });

  it("preflight non ok -> 422, zero token creato (sensitivity #6/7/8: prepare non muta nulla)", async () => {
    mocks.runMedmarPreflight.mockResolvedValue(preflightOk({ ok: false, can_issue: false, status: "no_match" }));
    const res = await POST(makeRequest({ service_ids: [SVC] }));
    expect(res.status).toBe(422);
    expect(mocks.createConfirmationToken).not.toHaveBeenCalled();
  });

  it("cliente incompleto -> manual_review, zero token creato (validazione locale prima di qualunque gate)", async () => {
    mocks.runMedmarPreflight.mockResolvedValue(preflightOk());
    mocks.loadServices.mockResolvedValue([
      { id: SVC, tenant_id: TENANT, customer_name: "Mario Rossi", customer_email: "mario@example.test", customer_phone: null, pax: 1 },
    ]);
    const res = await POST(makeRequest({ service_ids: [SVC] }));
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.status).toBe("manual_review");
    expect(mocks.createConfirmationToken).not.toHaveBeenCalled();
  });

  it("expected_total_cents null -> manual_review, zero token creato (sensitivity #9: nessun prezzo dal browser)", async () => {
    mocks.runMedmarPreflight.mockResolvedValue(preflightOk({ expected_total_cents: null }));
    const res = await POST(makeRequest({ service_ids: [SVC] }));
    expect(res.status).toBe(422);
    expect(mocks.createConfirmationToken).not.toHaveBeenCalled();
  });

  it("Fase 2B.6 — 14/15. preflight ok + nessuna agenzia -> response include delivery { medmar_recipient tecnico, final_recipient cliente }", async () => {
    mocks.runMedmarPreflight.mockResolvedValue(preflightOk());
    const res = await POST(makeRequest({ service_ids: [SVC] }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.delivery).toEqual({
      medmar_recipient: { type: "technical", email: "info@ischiatransferservice.it" },
      final_recipient: { type: "customer", name: "Mario Rossi", email: "mario@example.test" },
    });
  });

  it("Fase 2B.6 — 5/17. email tecnica Medmar non configurata -> 422, medmar_delivery_email_not_configured, zero token", async () => {
    delete process.env.MEDMAR_DELIVERY_EMAIL;
    mocks.runMedmarPreflight.mockResolvedValue(preflightOk());
    const res = await POST(makeRequest({ service_ids: [SVC] }));
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.status).toBe("medmar_delivery_email_not_configured");
    expect(mocks.createConfirmationToken).not.toHaveBeenCalled();
  });

  it("Fase 2B.6 — 10/17. nessuna agenzia + email cliente mancante -> 422, customer_recipient_email_missing (NON 'mail cliente mancante' generico), zero token", async () => {
    mocks.runMedmarPreflight.mockResolvedValue(preflightOk());
    mocks.loadServices.mockResolvedValue([
      { id: SVC, tenant_id: TENANT, customer_name: "Mario Rossi", customer_email: null, customer_phone: "123456", pax: 1 },
    ]);
    const res = await POST(makeRequest({ service_ids: [SVC] }));
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.status).toBe("customer_recipient_email_missing");
    expect(mocks.createConfirmationToken).not.toHaveBeenCalled();
  });

  it("service_ids mancante/malformato -> 400, zero token creato", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    expect(mocks.createConfirmationToken).not.toHaveBeenCalled();
  });
});
