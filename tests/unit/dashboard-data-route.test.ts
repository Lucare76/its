import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Sprint Performance 14B — GET /api/ops/dashboard-data tests: auth passthrough,
 * tenant isolation, invalid params, and that the response only ever carries
 * the bounded/aggregate shape (never a raw full-history services array).
 */

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  computeDashboardData: vi.fn()
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest
}));
vi.mock("@/lib/server/dashboard-data", () => ({
  computeDashboardData: mocks.computeDashboardData
}));

import { GET } from "@/app/api/ops/dashboard-data/route";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function authorizeAs(tenantId = TENANT_A, role: "admin" | "operator" | "supervisor" = "operator") {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: {},
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: tenantId, role, suspended: false }
  });
}

function req(query: Record<string, string>) {
  const params = new URLSearchParams(query).toString();
  return new NextRequest(`https://example.test/api/ops/dashboard-data?${params}`, {
    headers: { authorization: "Bearer token" }
  });
}

const EMPTY_DASHBOARD_DATA = {
  windowServices: [],
  hotels: [],
  assignments: [],
  todayPdfNeedsAttentionCount: 0,
  inboxPdfNeedsReviewCount: 0,
  inboxToReviewCount: 0,
  undeliveredReminderCount: 0,
  undeliveredReminderSample: []
};

beforeEach(() => {
  mocks.authorizePricingRequest.mockReset();
  mocks.computeDashboardData.mockReset();
  mocks.computeDashboardData.mockResolvedValue(EMPTY_DASHBOARD_DATA);
});

describe("GET /api/ops/dashboard-data — auth", () => {
  it("passes through whatever authorizePricingRequest returns unchanged (401)", async () => {
    const { NextResponse } = await import("next/server");
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "unauthorized" }, { status: 401 }));
    const res = await GET(req({ today: "2026-08-16", next48h: "2026-08-18" }));
    expect(res.status).toBe(401);
  });

  it("calls authorizePricingRequest with the same roles as the legacy tenant-data endpoint", async () => {
    authorizeAs();
    await GET(req({ today: "2026-08-16", next48h: "2026-08-18" }));
    expect(mocks.authorizePricingRequest).toHaveBeenCalledWith(expect.anything(), ["admin", "operator", "supervisor"]);
  });
});

describe("GET /api/ops/dashboard-data — invalid params", () => {
  it("rejects a missing today (400)", async () => {
    authorizeAs();
    const res = await GET(req({ next48h: "2026-08-18" }));
    expect(res.status).toBe(400);
  });

  it("rejects a malformed date (400)", async () => {
    authorizeAs();
    const res = await GET(req({ today: "16-08-2026", next48h: "2026-08-18" }));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/ops/dashboard-data — tenant isolation", () => {
  it("computes dashboard data scoped to the caller's own membership tenant_id, never a client-supplied one", async () => {
    authorizeAs(TENANT_A);
    await GET(req({ today: "2026-08-16", next48h: "2026-08-18" }));
    expect(mocks.computeDashboardData).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_A, today: "2026-08-16", next48h: "2026-08-18" })
    );
  });
});

describe("GET /api/ops/dashboard-data — response shape", () => {
  it("returns the compact aggregate shape, never a services[] key (no accidental full-history leak)", async () => {
    authorizeAs();
    const res = await GET(req({ today: "2026-08-16", next48h: "2026-08-18" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty("window_services");
    expect(body).not.toHaveProperty("services");
    expect(body).not.toHaveProperty("inbound_emails");
    expect(body).toHaveProperty("today_pdf_needs_attention_count");
    expect(body).toHaveProperty("undelivered_reminder_sample");
  });

  it("returns 500 with a generic error message when the aggregation throws", async () => {
    authorizeAs();
    mocks.computeDashboardData.mockRejectedValue(new Error("db exploded"));
    const res = await GET(req({ today: "2026-08-16", next48h: "2026-08-18" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});
