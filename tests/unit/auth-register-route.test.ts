import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  adminGetUserByEmail: vi.fn(),
  checkRateLimit: vi.fn(),
  sendSecurityAlert: vi.fn(),
  hasDeliverableEmailDomain: vi.fn(),
  isDisposableEmail: vi.fn(),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  updateUserById: vi.fn(),
  selectRequestMaybeSingle: vi.fn(),
  insertRequestMaybeSingle: vi.fn(),
  membershipMaybeSingle: vi.fn(),
  auditInsert: vi.fn(),
  sendAccessRequestReceivedEmail: vi.fn(),
  verifyTurnstileToken: vi.fn()
}));

vi.mock("@/lib/server/whatsapp", () => ({
  createAdminClient: mocks.createAdminClient
}));

vi.mock("@/lib/server/admin-user-lookup", () => ({
  adminGetUserByEmail: mocks.adminGetUserByEmail
}));

vi.mock("@/lib/server/rate-limit", () => ({
  RATE_LIMIT_DEFAULTS: {
    register: { maxAttempts: 5, windowMs: 60 * 60 * 1000 }
  },
  checkRateLimit: mocks.checkRateLimit
}));

vi.mock("@/lib/server/security-alert-email", () => ({
  sendSecurityAlert: mocks.sendSecurityAlert
}));

vi.mock("@/lib/email-validation", () => ({
  hasDeliverableEmailDomain: mocks.hasDeliverableEmailDomain,
  isDisposableEmail: mocks.isDisposableEmail
}));

vi.mock("@/lib/server/access-request-received-email", () => ({
  sendAccessRequestReceivedEmail: mocks.sendAccessRequestReceivedEmail
}));

vi.mock("@/lib/server/turnstile", () => ({
  verifyTurnstileToken: mocks.verifyTurnstileToken
}));

import { POST } from "@/app/api/auth/register/route";

function makeRequest(overrides: Partial<Record<string, string>> = {}) {
  return new NextRequest("http://localhost:3010/api/auth/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": "127.0.0.1"
    },
    body: JSON.stringify({
      agency_name: "Agenzia Test",
      full_name: "Mario Rossi",
      email: "mario@example.com",
      password: "password123",
      requested_role: "agency",
      turnstile_token: "valid-turnstile-token",
      ...overrides
    })
  });
}

function makeAdmin() {
  return {
    auth: {
      admin: {
        createUser: mocks.createUser,
        deleteUser: mocks.deleteUser,
        updateUserById: mocks.updateUserById
      }
    },
    from: vi.fn((table: string) => {
      if (table === "tenant_access_requests") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              is: vi.fn(() => ({
                maybeSingle: mocks.selectRequestMaybeSingle
              }))
            }))
          })),
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              maybeSingle: mocks.insertRequestMaybeSingle
            }))
          })),
          update: vi.fn(() => ({
            eq: vi.fn(() => ({
              select: vi.fn(() => ({
                maybeSingle: mocks.insertRequestMaybeSingle
              }))
            }))
          }))
        };
      }
      if (table === "memberships") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              limit: vi.fn(() => ({
                maybeSingle: mocks.membershipMaybeSingle
              }))
            }))
          }))
        };
      }
      if (table === "auth_audit_log") {
        return { insert: mocks.auditInsert };
      }
      throw new Error(`Unexpected table: ${table}`);
    })
  };
}

describe("POST /api/auth/register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAdminClient.mockReturnValue(makeAdmin());
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 4, resetAt: new Date() });
    mocks.sendSecurityAlert.mockResolvedValue(undefined);
    mocks.hasDeliverableEmailDomain.mockResolvedValue(true);
    mocks.isDisposableEmail.mockReturnValue(false);
    mocks.selectRequestMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.membershipMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.auditInsert.mockResolvedValue({ error: null });
    mocks.deleteUser.mockResolvedValue({ error: null });
    mocks.adminGetUserByEmail.mockResolvedValue({ user: null, error: null });
    mocks.createUser.mockResolvedValue({
      data: { user: { id: "new-user-1" } },
      error: null
    });
    mocks.insertRequestMaybeSingle.mockResolvedValue({ data: { id: "request-1" }, error: null });
    mocks.sendAccessRequestReceivedEmail.mockResolvedValue({ status: "sent", error: null });
    mocks.verifyTurnstileToken.mockResolvedValue({ success: true, errorCode: null });
  });

  it("creates the auth user and a pending request for a brand new email", async () => {
    const response = await POST(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(mocks.createUser).toHaveBeenCalledWith({
      email: "mario@example.com",
      password: "password123",
      email_confirm: true,
      user_metadata: { full_name: "Mario Rossi" }
    });
    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expect(mocks.sendAccessRequestReceivedEmail).toHaveBeenCalledWith({
      to: "mario@example.com",
      fullName: "Mario Rossi",
      agencyName: "Agenzia Test"
    });
    expect(body).toEqual({
      ok: true,
      request_id: "request-1",
      message: "Registrazione inviata. Un admin vedra la tua richiesta e la assocera all'agenzia corretta."
    });
  });

  it("still returns 201 with the pending request created when the email provider fails", async () => {
    mocks.sendAccessRequestReceivedEmail.mockResolvedValue({
      status: "failed",
      error: "Resend HTTP 500: boom"
    });

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.ok).toBe(true);
    expect(body.request_id).toBe("request-1");
  });

  it("still returns 201 with the pending request created when the email provider throws", async () => {
    mocks.sendAccessRequestReceivedEmail.mockRejectedValue(new Error("network down"));

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.ok).toBe(true);
    expect(body.request_id).toBe("request-1");
  });

  it("rolls back (deletes) the freshly created auth user when the request insert fails, leaving no orphan", async () => {
    mocks.insertRequestMaybeSingle.mockResolvedValue({
      data: null,
      error: { message: "insert failed", code: "XXXXX" }
    });

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(mocks.createUser).toHaveBeenCalledTimes(1);
    expect(mocks.deleteUser).toHaveBeenCalledWith("new-user-1");
    expect(body.error).toBe("insert failed");
  });

  it("does NOT delete a pre-existing auth user when the request insert fails after reusing it", async () => {
    mocks.adminGetUserByEmail.mockResolvedValue({
      user: { id: "existing-user-1", email: "mario@example.com", user_metadata: {} },
      error: null
    });
    mocks.updateUserById.mockResolvedValue({ error: null });
    mocks.insertRequestMaybeSingle.mockResolvedValue({
      data: null,
      error: { message: "insert failed", code: "XXXXX" }
    });

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(mocks.createUser).not.toHaveBeenCalled();
    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expect(body.error).toBe("insert failed");
  });

  it("returns 409 (not a generic 500) when the insert hits the unique-index race condition", async () => {
    mocks.insertRequestMaybeSingle.mockResolvedValue({
      data: null,
      error: { message: "duplicate key value violates unique constraint", code: "23505" }
    });

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(mocks.deleteUser).toHaveBeenCalledWith("new-user-1");
    expect(body.error).toBe("Esiste gia una richiesta in attesa per questa email.");
  });

  it("reopens a previously rejected request instead of failing on the unique-index conflict", async () => {
    mocks.selectRequestMaybeSingle.mockResolvedValue({
      data: { id: "old-rejected-request", status: "rejected" },
      error: null
    });

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.request_id).toBe("request-1");
  });

  it("Turnstile: missing token is rejected before touching Auth or DB", async () => {
    const rawBody = {
      agency_name: "Agenzia Test",
      full_name: "Mario Rossi",
      email: "mario@example.com",
      password: "password123",
      requested_role: "agency"
      // turnstile_token intentionally omitted
    };
    const request = new NextRequest("http://localhost:3010/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "127.0.0.1" },
      body: JSON.stringify(rawBody)
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Verifica di sicurezza mancante.");
    expect(mocks.verifyTurnstileToken).not.toHaveBeenCalled();
    expect(mocks.createUser).not.toHaveBeenCalled();
    expect(mocks.insertRequestMaybeSingle).not.toHaveBeenCalled();
    expect(mocks.sendAccessRequestReceivedEmail).not.toHaveBeenCalled();
  });

  it("Turnstile: invalid token (Siteverify success:false) is rejected before touching Auth or DB", async () => {
    mocks.verifyTurnstileToken.mockResolvedValue({ success: false, errorCode: "verification_failed" });

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Verifica di sicurezza non riuscita. Riprova.");
    expect(body.error).not.toMatch(/siteverify|cloudflare|challenge/i);
    expect(mocks.createUser).not.toHaveBeenCalled();
    expect(mocks.sendAccessRequestReceivedEmail).not.toHaveBeenCalled();
  });

  it("Turnstile: unreachable Siteverify fails closed — no Auth, no DB", async () => {
    mocks.verifyTurnstileToken.mockResolvedValue({ success: false, errorCode: "network_error" });

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Verifica di sicurezza non riuscita. Riprova.");
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it("Turnstile: missing secret at runtime is treated as failure, never silently bypassed", async () => {
    mocks.verifyTurnstileToken.mockResolvedValue({ success: false, errorCode: "missing_secret" });

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Verifica di sicurezza non riuscita. Riprova.");
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it("Turnstile: logs the failure reason to the audit log without ever including the raw token", async () => {
    mocks.verifyTurnstileToken.mockResolvedValue({ success: false, errorCode: "verification_failed" });

    await POST(makeRequest({ turnstile_token: "super-secret-raw-token-value" }));

    expect(mocks.auditInsert).toHaveBeenCalled();
    const insertedPayload = JSON.stringify(mocks.auditInsert.mock.calls[0][0]);
    expect(insertedPayload).not.toContain("super-secret-raw-token-value");
  });

  it("Turnstile: a valid token lets registration proceed exactly as before", async () => {
    const response = await POST(makeRequest());
    expect(response.status).toBe(201);
    expect(mocks.verifyTurnstileToken).toHaveBeenCalledWith({ token: "valid-turnstile-token", remoteIp: "127.0.0.1" });
    expect(mocks.createUser).toHaveBeenCalled();
  });

  it("does not silently skip account creation for an unseen email", async () => {
    await POST(makeRequest({ email: "unseen@example.com" }));
    expect(mocks.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: "unseen@example.com" })
    );
  });
});
