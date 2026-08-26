import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  getUser: vi.fn(),
  membershipsMaybeSingle: vi.fn(),
  pendingRequestMaybeSingle: vi.fn(),
  latestAccessRequestMaybeSingle: vi.fn(),
  tenantCountHead: vi.fn(),
  tenantsInsertSingle: vi.fn(),
  membershipInsert: vi.fn()
}));

vi.mock("@/lib/server/supabase-admin", () => ({
  createAdminClient: mocks.createAdminClient
}));

import { GET, POST } from "@/app/api/onboarding/tenant/route";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/onboarding/tenant", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-token"
    },
    body: JSON.stringify(body)
  });
}

function makeGetRequest() {
  return new NextRequest("http://localhost:3010/api/onboarding/tenant", {
    method: "GET",
    headers: { Authorization: "Bearer test-token" }
  });
}

function makeAdmin() {
  return {
    auth: {
      getUser: mocks.getUser
    },
    from: vi.fn((table: string) => {
      if (table === "memberships") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => mocks.membershipsMaybeSingle())
          })),
          insert: mocks.membershipInsert
        };
      }
      if (table === "tenant_access_requests") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: mocks.pendingRequestMaybeSingle
              })),
              order: vi.fn(() => ({
                limit: vi.fn(() => ({
                  maybeSingle: mocks.latestAccessRequestMaybeSingle
                }))
              }))
            }))
          }))
        };
      }
      if (table === "tenants") {
        return {
          select: vi.fn(() => mocks.tenantCountHead()),
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: mocks.tenantsInsertSingle
            }))
          }))
        };
      }
      if (table === "role_capability_overrides") {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ data: [] })) })) })) };
      }
      throw new Error(`Unexpected table: ${table}`);
    })
  };
}

describe("POST /api/onboarding/tenant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAdminClient.mockReturnValue(makeAdmin());
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "user@example.com", user_metadata: {} } },
      error: null
    });
    // No existing memberships for this user.
    mocks.membershipsMaybeSingle.mockResolvedValue({ data: [], error: null });
    mocks.pendingRequestMaybeSingle.mockResolvedValue({ data: null });
    mocks.latestAccessRequestMaybeSingle.mockResolvedValue({ data: null });
    mocks.membershipInsert.mockResolvedValue({ error: null });
  });

  it("denies tenant creation for a normal authenticated user when a tenant already exists", async () => {
    mocks.tenantCountHead.mockReturnValue({ count: 1, error: null });

    const response = await POST(makeRequest({ company_name: "Nuova Agenzia SRL" }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toMatch(/accesso negato/i);
    expect(mocks.tenantsInsertSingle).not.toHaveBeenCalled();
  });

  it("still allows tenant creation on genuine first-run bootstrap (zero tenants system-wide)", async () => {
    mocks.tenantCountHead.mockReturnValue({ count: 0, error: null });
    mocks.tenantsInsertSingle.mockResolvedValue({
      data: { id: "tenant-1", name: "Nuova Agenzia SRL" },
      error: null
    });

    const response = await POST(makeRequest({ company_name: "Nuova Agenzia SRL" }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.created).toBe(true);
    expect(body.tenant).toEqual({ id: "tenant-1", name: "Nuova Agenzia SRL" });
  });

  it("rejects a second self-service request while one is already pending (no duplicate)", async () => {
    mocks.pendingRequestMaybeSingle.mockResolvedValue({ data: { id: "existing-pending-request" } });

    const response = await POST(makeRequest({ company_name: "Altra Agenzia" }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/gia una richiesta accesso in attesa/i);
    expect(mocks.tenantsInsertSingle).not.toHaveBeenCalled();
  });
});

describe("GET /api/onboarding/tenant — pending/rejected request state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAdminClient.mockReturnValue(makeAdmin());
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "user@example.com", user_metadata: {} } },
      error: null
    });
    mocks.membershipsMaybeSingle.mockResolvedValue({ data: [], error: null });
    // Default: a tenant already exists system-wide (the common case for this
    // already-bootstrapped ITS installation) — "Crea nuova azienda" must stay hidden.
    mocks.tenantCountHead.mockReturnValue({ count: 1, error: null });
  });

  it("reports a pending request without exposing tenant-creation ability", async () => {
    mocks.latestAccessRequestMaybeSingle.mockResolvedValue({
      data: { id: "req-1", tenant_id: null, status: "pending", created_at: "2026-08-20T10:00:00Z", review_notes: null, tenants: null }
    });

    const response = await GET(makeGetRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.hasTenant).toBe(false);
    expect(body.pending_request?.id).toBe("req-1");
    expect(body.rejected_request).toBeNull();
    expect(body.can_create_tenant).toBe(false);
  });

  it("exposes can_create_tenant=true only on genuine first-run bootstrap (zero tenants)", async () => {
    mocks.tenantCountHead.mockReturnValue({ count: 0, error: null });
    mocks.latestAccessRequestMaybeSingle.mockResolvedValue({ data: null });

    const response = await GET(makeGetRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.can_create_tenant).toBe(true);
  });

  it("reports a rejected request distinctly from pending", async () => {
    mocks.latestAccessRequestMaybeSingle.mockResolvedValue({
      data: { id: "req-2", tenant_id: null, status: "rejected", created_at: "2026-08-20T10:00:00Z", review_notes: "Documenti mancanti", tenants: null }
    });

    const response = await GET(makeGetRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.hasTenant).toBe(false);
    expect(body.pending_request).toBeNull();
    expect(body.rejected_request?.id).toBe("req-2");
    expect(body.rejected_request?.review_notes).toBe("Documenti mancanti");
    expect(body.can_create_tenant).toBe(false);
  });
});
