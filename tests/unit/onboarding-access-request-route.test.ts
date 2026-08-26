import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  membershipMaybeSingle: vi.fn(),
  tenantsLimit: vi.fn(),
  existingRequestMaybeSingle: vi.fn(),
  insertSingle: vi.fn(),
  updateSingle: vi.fn()
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: mocks.getUser },
    from: vi.fn((table: string) => {
      if (table === "memberships") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              not: vi.fn(() => ({
                maybeSingle: mocks.membershipMaybeSingle
              }))
            }))
          }))
        };
      }
      if (table === "tenants") {
        return {
          select: vi.fn(() => ({
            order: vi.fn(() => ({
              limit: mocks.tenantsLimit
            }))
          }))
        };
      }
      if (table === "tenant_access_requests") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: mocks.existingRequestMaybeSingle
              }))
            }))
          })),
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: mocks.insertSingle
            }))
          })),
          update: vi.fn(() => ({
            eq: vi.fn(() => ({
              select: vi.fn(() => ({
                single: mocks.updateSingle
              }))
            }))
          }))
        };
      }
      if (table === "auth_audit_log") {
        return { insert: vi.fn(() => Promise.resolve({ error: null })) };
      }
      throw new Error(`Unexpected table: ${table}`);
    })
  })
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";

import { POST } from "@/app/api/onboarding/access-request/route";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/onboarding/access-request", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-token"
    },
    body: JSON.stringify(body)
  });
}

describe("POST /api/onboarding/access-request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "user@example.com" } },
      error: null
    });
    mocks.membershipMaybeSingle.mockResolvedValue({ data: null });
    mocks.tenantsLimit.mockResolvedValue({ data: [{ id: "tenant-1", name: "Ischia Transfer" }] });
    mocks.existingRequestMaybeSingle.mockResolvedValue({ data: null });
    mocks.insertSingle.mockResolvedValue({
      data: { id: "req-1", tenant_id: "tenant-1", status: "pending", created_at: "2026-08-26T10:00:00Z" },
      error: null
    });
    mocks.updateSingle.mockResolvedValue({
      data: { id: "req-1", tenant_id: "tenant-1", status: "pending", created_at: "2026-08-26T10:00:00Z" },
      error: null
    });
  });

  it("creates a new pending request when none exists yet", async () => {
    const response = await POST(makeRequest({ full_name: "Mario Rossi", requested_role: "agency" }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.request.status).toBe("pending");
  });

  it("blocks a duplicate request while one is already pending", async () => {
    mocks.existingRequestMaybeSingle.mockResolvedValue({ data: { id: "req-1", status: "pending" } });

    const response = await POST(makeRequest({ full_name: "Mario Rossi", requested_role: "agency" }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/gi[àa] una richiesta accesso/i);
  });

  it("reopens (does not insert-conflict on) a previously rejected request", async () => {
    mocks.existingRequestMaybeSingle.mockResolvedValue({ data: { id: "req-1", status: "rejected" } });

    const response = await POST(makeRequest({ full_name: "Mario Rossi", requested_role: "agency" }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.request.status).toBe("pending");
  });
});
