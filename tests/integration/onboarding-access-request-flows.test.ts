import { randomUUID } from "crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createTestContext, type TestContext } from "./helpers/seed";

/**
 * Logical end-to-end coverage for the two official onboarding paths:
 *   register -> pending -> approve -> agency + membership + setup_required
 *   register -> pending -> reject -> rejected -> reopen -> pending -> approve
 *
 * Runs against the real route handlers and the real (test) Supabase project
 * — same convention as the other tests/integration/* files — rather than
 * mocks, so it actually exercises the DB constraints (unique indexes, FKs)
 * the unit tests can only simulate.
 *
 * RESEND_API_KEY is removed for the duration so the onboarding emails are
 * skipped (no real network calls to the email provider) — this only affects
 * the email step, which already has full unit coverage elsewhere.
 *
 * Turnstile verification is mocked (never a real call to Cloudflare
 * Siteverify from Vitest, per project policy) — its own success/failure
 * behavior has full unit coverage in tests/unit/turnstile.test.ts and
 * tests/unit/auth-register-route.test.ts.
 */
vi.mock("@/lib/server/turnstile", () => ({
  verifyTurnstileToken: vi.fn().mockResolvedValue({ success: true, errorCode: null })
}));

const { POST: registerPOST } = await import("@/app/api/auth/register/route");
const { PATCH: settingsUsersPATCH } = await import("@/app/api/settings/users/route");

let ctx: TestContext;
let originalResendApiKey: string | undefined;
const cleanupUserIds: string[] = [];
const cleanupRequestIds: string[] = [];

function registerRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function settingsUsersRequest(body: Record<string, unknown>, token: string) {
  return new NextRequest("http://localhost:3010/api/settings/users", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
}

beforeAll(async () => {
  ctx = await createTestContext();
  originalResendApiKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
});

afterAll(async () => {
  if (originalResendApiKey) process.env.RESEND_API_KEY = originalResendApiKey;

  for (const requestId of cleanupRequestIds) {
    await ctx.admin.from("tenant_access_requests").delete().eq("id", requestId);
  }
  await ctx.admin.from("memberships").delete().eq("tenant_id", ctx.tenantId).in("user_id", cleanupUserIds);
  await ctx.admin.from("agencies").delete().eq("tenant_id", ctx.tenantId).in("external_code", cleanupUserIds.map((id) => `auth_user:${id}`));
  await ctx.admin.from("auth_audit_log").delete().in("user_id", cleanupUserIds);
  for (const userId of cleanupUserIds) {
    await ctx.admin.auth.admin.deleteUser(userId);
  }
  await ctx.cleanup();
});

describe("onboarding access-request full flow (real routes + real test DB)", () => {
  it("register -> pending -> approve -> agency created (setup_required) + membership", async () => {
    const email = `integration-flowA-${randomUUID()}@example.com`;

    const registerResponse = await registerPOST(
      registerRequest({
        agency_name: "Agenzia Flusso A",
        full_name: "Mario FlussoA",
        email,
        password: randomUUID(),
        requested_role: "agency",
        turnstile_token: "integration-test-mocked-token"
      })
    );
    const registerBody = await registerResponse.json();
    expect(registerResponse.status).toBe(201);
    const requestId = registerBody.request_id as string;
    cleanupRequestIds.push(requestId);

    const { data: requestRow } = await ctx.admin
      .from("tenant_access_requests")
      .select("user_id, status")
      .eq("id", requestId)
      .single();
    expect(requestRow?.status).toBe("pending");
    const applicantUserId = requestRow!.user_id as string;
    cleanupUserIds.push(applicantUserId);

    const approveResponse = await settingsUsersPATCH(
      settingsUsersRequest({ request_id: requestId, action: "approve", role: "agency" }, ctx.token)
    );
    const approveBody = await approveResponse.json();
    expect(approveResponse.status).toBe(200);
    expect(approveBody.approved_request.role).toBe("agency");
    expect(approveBody.approved_request.email_status).toBe("skipped"); // no RESEND_API_KEY in this test run

    const { data: agencyRow } = await ctx.admin
      .from("agencies")
      .select("id, setup_required")
      .eq("tenant_id", ctx.tenantId)
      .eq("external_code", `auth_user:${applicantUserId}`)
      .single();
    expect(agencyRow?.setup_required).toBe(true);

    const { data: membershipRow } = await ctx.admin
      .from("memberships")
      .select("role, agency_id, suspended")
      .eq("tenant_id", ctx.tenantId)
      .eq("user_id", applicantUserId)
      .single();
    expect(membershipRow?.role).toBe("agency");
    expect(membershipRow?.agency_id).toBe(agencyRow?.id);
    expect(membershipRow?.suspended).toBe(false);

    const { data: finalRequestRow } = await ctx.admin
      .from("tenant_access_requests")
      .select("status")
      .eq("id", requestId)
      .single();
    expect(finalRequestRow?.status).toBe("approved");
  });

  it("register -> pending -> reject -> rejected -> reopen (same row) -> pending -> approve", async () => {
    const email = `integration-flowB-${randomUUID()}@example.com`;

    const firstRegisterResponse = await registerPOST(
      registerRequest({
        agency_name: "Agenzia Flusso B",
        full_name: "Lucia FlussoB",
        email,
        password: randomUUID(),
        requested_role: "agency",
        turnstile_token: "integration-test-mocked-token"
      })
    );
    const firstRegisterBody = await firstRegisterResponse.json();
    expect(firstRegisterResponse.status).toBe(201);
    const requestId = firstRegisterBody.request_id as string;
    cleanupRequestIds.push(requestId);

    const { data: firstRequestRow } = await ctx.admin
      .from("tenant_access_requests")
      .select("user_id")
      .eq("id", requestId)
      .single();
    const applicantUserId = firstRequestRow!.user_id as string;
    cleanupUserIds.push(applicantUserId);

    const rejectResponse = await settingsUsersPATCH(
      settingsUsersRequest({ request_id: requestId, action: "reject", review_notes: "Documenti mancanti" }, ctx.token)
    );
    const rejectBody = await rejectResponse.json();
    expect(rejectResponse.status).toBe(200);
    expect(rejectBody.request).toEqual({ id: requestId, status: "rejected", email_status: "skipped" });

    const { data: rejectedRow } = await ctx.admin
      .from("tenant_access_requests")
      .select("status, review_notes")
      .eq("id", requestId)
      .single();
    expect(rejectedRow?.status).toBe("rejected");
    expect(rejectedRow?.review_notes).toBe("Documenti mancanti");

    // Second reject attempt on the same (now non-pending) row must not
    // silently succeed a second time — this is the idempotency guard.
    const doubleRejectResponse = await settingsUsersPATCH(
      settingsUsersRequest({ request_id: requestId, action: "reject" }, ctx.token)
    );
    expect(doubleRejectResponse.status).toBe(400); // requestRow.status !== "pending" fast-path guard

    const reopenResponse = await registerPOST(
      registerRequest({
        agency_name: "Agenzia Flusso B",
        full_name: "Lucia FlussoB",
        email,
        password: randomUUID(),
        requested_role: "agency",
        turnstile_token: "integration-test-mocked-token"
      })
    );
    const reopenBody = await reopenResponse.json();
    expect(reopenResponse.status).toBe(201);
    expect(reopenBody.request_id).toBe(requestId); // same row reopened, not a new one

    const { data: reopenedRow } = await ctx.admin
      .from("tenant_access_requests")
      .select("status, review_notes, reviewed_by_user_id")
      .eq("id", requestId)
      .single();
    expect(reopenedRow?.status).toBe("pending");
    expect(reopenedRow?.review_notes).toBeNull();
    expect(reopenedRow?.reviewed_by_user_id).toBeNull();

    // Soft check: the "access_request_reopened" event_type requires migration
    // 0253 to be applied (manual step in this project's convention — see
    // scripts/db-sql-editor.mjs). The insert is fire-and-forget by design
    // (an audit-log failure must never break the reopen itself), so on a
    // project where 0253 hasn't been applied yet the row simply won't exist
    // instead of throwing — this assertion only checks its content when
    // present, it does not gate the reopen-flow correctness proven above.
    const { data: reopenedAuditRow } = await ctx.admin
      .from("auth_audit_log")
      .select("details")
      .eq("user_id", applicantUserId)
      .eq("event_type", "access_request_reopened")
      .maybeSingle();
    if (reopenedAuditRow) {
      expect((reopenedAuditRow.details as Record<string, unknown>).previous_review_notes).toBe("Documenti mancanti");
    }

    const approveResponse = await settingsUsersPATCH(
      settingsUsersRequest({ request_id: requestId, action: "approve", role: "agency" }, ctx.token)
    );
    const approveBody = await approveResponse.json();
    expect(approveResponse.status).toBe(200);
    expect(approveBody.approved_request.role).toBe("agency");

    const { data: finalRequestRow } = await ctx.admin
      .from("tenant_access_requests")
      .select("status")
      .eq("id", requestId)
      .single();
    expect(finalRequestRow?.status).toBe("approved");
  });
});
