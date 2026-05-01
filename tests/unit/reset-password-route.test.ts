import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  generateLink: vi.fn(),
  insert: vi.fn(),
  createAdminClient: vi.fn(),
  adminGetUserByEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  checkRateLimit: vi.fn(),
  sendSecurityAlert: vi.fn(),
  hasDeliverableEmailDomain: vi.fn(),
  isDisposableEmail: vi.fn()
}));

vi.mock("@/lib/server/whatsapp", () => ({
  createAdminClient: mocks.createAdminClient
}));

vi.mock("@/lib/server/admin-user-lookup", () => ({
  adminGetUserByEmail: mocks.adminGetUserByEmail
}));

vi.mock("@/lib/server/password-reset-email", () => ({
  sendPasswordResetEmail: mocks.sendPasswordResetEmail
}));

vi.mock("@/lib/server/rate-limit", () => ({
  RATE_LIMIT_DEFAULTS: {
    resetPassword: { maxAttempts: 3, windowMs: 60 * 60 * 1000 }
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

import { POST } from "@/app/api/auth/reset-password/route";

function makeRequest(email: string) {
  return new NextRequest("http://localhost:3010/api/auth/reset-password", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": "127.0.0.1"
    },
    body: JSON.stringify({ email })
  });
}

function makeAdmin() {
  return {
    auth: {
      admin: {
        generateLink: mocks.generateLink
      }
    },
    from: vi.fn(() => ({
      insert: mocks.insert
    }))
  };
}

describe("POST /api/auth/reset-password", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insert.mockResolvedValue({});
    mocks.createAdminClient.mockReturnValue(makeAdmin());
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 2, resetAt: new Date() });
    mocks.sendSecurityAlert.mockResolvedValue(undefined);
    mocks.hasDeliverableEmailDomain.mockResolvedValue(true);
    mocks.isDisposableEmail.mockReturnValue(false);
    mocks.sendPasswordResetEmail.mockResolvedValue({ status: "sent", error: null });
    mocks.generateLink.mockResolvedValue({
      data: { properties: { action_link: "https://example.com/recover" } },
      error: null
    });
    mocks.adminGetUserByEmail.mockResolvedValue({
      user: { id: "user-1", email: "mario@example.com", user_metadata: { full_name: "Mario Rossi" } },
      error: null
    });
  });

  it("sends a recovery link instead of rotating the password", async () => {
    const response = await POST(makeRequest("mario@example.com"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.generateLink).toHaveBeenCalledWith({
      type: "recovery",
      email: "mario@example.com",
      options: {
        redirectTo: "http://localhost:3010/auth/update-password"
      }
    });
    expect(mocks.sendPasswordResetEmail).toHaveBeenCalledWith({
      to: "mario@example.com",
      fullName: "Mario Rossi",
      resetUrl: "https://example.com/recover"
    });
    expect(body).toEqual({
      ok: true,
      message: "Se l'account esiste, abbiamo inviato un link per reimpostare la password."
    });
  });

  it("returns the same generic success message when the account is missing", async () => {
    mocks.adminGetUserByEmail.mockResolvedValueOnce({ user: null, error: null });

    const response = await POST(makeRequest("ghost@example.com"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.generateLink).not.toHaveBeenCalled();
    expect(mocks.sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(body).toEqual({
      ok: true,
      message: "Controlla la tua casella di posta per le istruzioni."
    });
  });

  it("fails cleanly when recovery link generation fails", async () => {
    mocks.generateLink.mockResolvedValueOnce({
      data: { properties: { action_link: null } },
      error: { message: "boom" }
    });

    const response = await POST(makeRequest("mario@example.com"));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(mocks.sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(body).toEqual({ error: "Impossibile generare il link di reset." });
  });
});
