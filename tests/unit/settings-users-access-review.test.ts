import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  getUser: vi.fn(),
  sendAccessApprovalEmail: vi.fn(),
  sendAccessRejectionEmail: vi.fn(),
  ensureDriverProfileForMembership: vi.fn(),
  reserveMembershipUsername: vi.fn(),
  unlinkDriverProfileFromMembership: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  hasDeliverableEmailDomain: vi.fn(),
  isDisposableEmail: vi.fn(),
  adminGetUserByEmail: vi.fn()
}));

vi.mock("@/lib/server/whatsapp", () => ({
  createAdminClient: mocks.createAdminClient
}));

vi.mock("@/lib/server/access-approval-email", () => ({
  sendAccessApprovalEmail: mocks.sendAccessApprovalEmail
}));

vi.mock("@/lib/server/access-rejection-email", () => ({
  sendAccessRejectionEmail: mocks.sendAccessRejectionEmail
}));

vi.mock("@/lib/server/driver-registry", () => ({
  ensureDriverProfileForMembership: mocks.ensureDriverProfileForMembership,
  reserveMembershipUsername: mocks.reserveMembershipUsername,
  unlinkDriverProfileFromMembership: mocks.unlinkDriverProfileFromMembership
}));

vi.mock("@/lib/server/password-reset-email", () => ({
  sendPasswordResetEmail: mocks.sendPasswordResetEmail
}));

vi.mock("@/lib/email-validation", () => ({
  hasDeliverableEmailDomain: mocks.hasDeliverableEmailDomain,
  isDisposableEmail: mocks.isDisposableEmail
}));

vi.mock("@/lib/server/admin-user-lookup", () => ({
  adminGetUserByEmail: mocks.adminGetUserByEmail
}));

import { PATCH } from "@/app/api/settings/users/route";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/settings/users", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-token"
    },
    body: JSON.stringify(body)
  });
}

/**
 * Minimal chainable Postgrest-like query builder mock. Each table has a FIFO
 * queue of responses consumed in the exact order the route source code
 * issues its queries for that table — this mirrors how the Supabase client
 * resolves regardless of whether the code awaits directly (`.then`) or
 * terminates with `.maybeSingle()` / `.single()`.
 */
function makeAdmin(responses: Record<string, unknown[]>) {
  const queues: Record<string, unknown[]> = Object.fromEntries(
    Object.entries(responses).map(([table, list]) => [table, [...list]])
  );

  function nextFor(table: string) {
    const queue = queues[table];
    if (!queue || queue.length === 0) {
      throw new Error(`No queued response left for table "${table}"`);
    }
    return queue.shift();
  }

  function builder(table: string) {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    b.select = vi.fn(chain);
    b.eq = vi.fn(chain);
    b.is = vi.fn(chain);
    b.or = vi.fn(chain);
    b.order = vi.fn(chain);
    b.limit = vi.fn(chain);
    b.update = vi.fn(chain);
    b.insert = vi.fn(chain);
    b.delete = vi.fn(chain);
    b.maybeSingle = vi.fn(() => Promise.resolve(nextFor(table)));
    b.single = vi.fn(() => Promise.resolve(nextFor(table)));
    b.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(nextFor(table)).then(resolve, reject);
    return b;
  }

  return {
    auth: {
      getUser: mocks.getUser,
      admin: {
        deleteUser: vi.fn(),
        updateUserById: vi.fn(),
        createUser: vi.fn(),
        getUserById: vi.fn(),
        generateLink: vi.fn(),
        signOut: vi.fn()
      }
    },
    from: vi.fn((table: string) => builder(table))
  };
}

const ADMIN_MEMBERSHIP_ROW = { tenant_id: "tenant-1", role: "admin", full_name: "Admin ITS", suspended: false };

describe("PATCH /api/settings/users — access request review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "admin-1" } }, error: null });
    mocks.sendAccessRejectionEmail.mockResolvedValue({ status: "sent", error: null });
    mocks.sendAccessApprovalEmail.mockResolvedValue({ status: "sent", error: null });
  });

  it("rejects a pending request: status becomes rejected and the rejection email is attempted", async () => {
    const admin = makeAdmin({
      memberships: [{ data: [ADMIN_MEMBERSHIP_ROW], error: null }],
      tenant_access_requests: [
        {
          data: {
            id: "fcedf611-bfd5-4a0c-866f-5d1bd3b3be47",
            tenant_id: null,
            user_id: "user-1",
            email: "agenzia@example.com",
            full_name: "Mario Rossi",
            agency_name: "Agenzia Test",
            requested_role: "agency",
            status: "pending"
          },
          error: null
        },
        { data: { id: "fcedf611-bfd5-4a0c-866f-5d1bd3b3be47" }, error: null }
      ]
    });
    mocks.createAdminClient.mockReturnValue(admin);

    const response = await PATCH(
      makeRequest({ request_id: "fcedf611-bfd5-4a0c-866f-5d1bd3b3be47", action: "reject", review_notes: "Documenti mancanti" })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, request: { id: "fcedf611-bfd5-4a0c-866f-5d1bd3b3be47", status: "rejected" } });
    expect(mocks.sendAccessRejectionEmail).toHaveBeenCalledWith({
      to: "agenzia@example.com",
      fullName: "Mario Rossi",
      reasonForAgency: "Documenti mancanti"
    });
  });

  it("keeps the rejection valid (status stays rejected, no DB rollback) even if the rejection email fails", async () => {
    const admin = makeAdmin({
      memberships: [{ data: [ADMIN_MEMBERSHIP_ROW], error: null }],
      tenant_access_requests: [
        {
          data: {
            id: "fcedf611-bfd5-4a0c-866f-5d1bd3b3be47",
            tenant_id: null,
            user_id: "user-1",
            email: "agenzia@example.com",
            full_name: "Mario Rossi",
            agency_name: "Agenzia Test",
            requested_role: "agency",
            status: "pending"
          },
          error: null
        },
        { data: { id: "fcedf611-bfd5-4a0c-866f-5d1bd3b3be47" }, error: null }
      ]
    });
    mocks.createAdminClient.mockReturnValue(admin);
    mocks.sendAccessRejectionEmail.mockRejectedValue(new Error("provider down"));

    const response = await PATCH(makeRequest({ request_id: "fcedf611-bfd5-4a0c-866f-5d1bd3b3be47", action: "reject" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, request: { id: "fcedf611-bfd5-4a0c-866f-5d1bd3b3be47", status: "rejected" } });
  });

  it("approves an agency request: creates agency (setup_required) + membership, and still emails approval", async () => {
    const admin = makeAdmin({
      memberships: [
        { data: [ADMIN_MEMBERSHIP_ROW], error: null }, // requireAdminMembership
        { data: null, error: null }, // existingMembership check (none yet)
        { error: null } // membershipInsert
      ],
      tenant_access_requests: [
        {
          data: {
            id: "acd49c96-6dd2-4802-8dac-5548af1edf0f",
            tenant_id: null,
            user_id: "user-2",
            email: "agenzia2@example.com",
            full_name: "Lucia Bianchi",
            agency_name: "Agenzia Bianchi",
            requested_role: "agency",
            status: "pending"
          },
          error: null
        },
        { data: { id: "acd49c96-6dd2-4802-8dac-5548af1edf0f" }, error: null } // approvalUpdate
      ],
      agencies: [
        { error: null }, // hasColumn probe (setup_required column exists)
        { data: null, error: null }, // existingAgency lookup (none yet)
        { data: { id: "agency-1" }, error: null } // agencyInsert
      ]
    });
    mocks.createAdminClient.mockReturnValue(admin);

    const response = await PATCH(makeRequest({ request_id: "acd49c96-6dd2-4802-8dac-5548af1edf0f", action: "approve" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.approved_request).toEqual({
      id: "acd49c96-6dd2-4802-8dac-5548af1edf0f",
      user_id: "user-2",
      tenant_id: "tenant-1",
      full_name: "Lucia Bianchi",
      email: "agenzia2@example.com",
      role: "agency"
    });

    const agenciesBuilders = admin.from.mock.results
      .filter((_, index) => admin.from.mock.calls[index][0] === "agencies")
      .map((result) => result.value as { insert: ReturnType<typeof vi.fn> });
    const agencyInsertBuilder = agenciesBuilders.find((builder) => builder.insert.mock.calls.length > 0);
    expect(agencyInsertBuilder).toBeTruthy();
    expect(agencyInsertBuilder!.insert.mock.calls[0][0]).toEqual(
      expect.objectContaining({ setup_required: true, tenant_id: "tenant-1", name: "Agenzia Bianchi" })
    );

    expect(mocks.sendAccessApprovalEmail).toHaveBeenCalledWith({
      to: "agenzia2@example.com",
      fullName: "Lucia Bianchi",
      role: "agency",
      agencyName: "Agenzia Bianchi"
    });
  });
});
