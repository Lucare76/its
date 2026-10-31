import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
const m = vi.hoisted(() => ({
  agencyAuth: vi.fn(),
  opsAuth: vi.fn(),
  rpc: vi.fn(),
  send: vi.fn(),
  oldSend: vi.fn(),
}));
vi.mock("@/lib/server/pricing-auth", () => ({
  authorizeServiceRoleRequest: m.agencyAuth,
  authorizePricingRequest: m.opsAuth,
}));
vi.mock("@/lib/server/ops-audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/server/agency-approval-email", () => ({
  sendAgencyInvoiceDisputeResolvedEmail: m.send,
  sendOperatorInvoiceDisputeNotifyEmail: m.oldSend,
}));
import { POST as oldPost, GET } from "@/app/api/agency/invoice-disputes/route";
import { POST as resolve } from "@/app/api/ops/agency-invoice-disputes/[id]/resolve/route";
const T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  D = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
let dispute: Record<string, unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  dispute = {
    id: D,
    tenant_id: T,
    agency_id: A,
    service_id: "service",
    original_price_cents: 12000,
    proposed_price_cents: 11000,
    status: "pending",
    services: null,
    agencies: null,
  };
  const admin = {
    rpc: m.rpc,
    from: () => {
      const filters: Array<[string, unknown]> = [];
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => {
          filters.push([k, v]);
          return q;
        },
        order: () => q,
        limit: async () => ({
          data: [dispute].filter((r) => filters.every(([k, v]) => r[k] === v)),
          error: null,
        }),
        maybeSingle: async () => ({
          data: filters.every(([k, v]) => dispute[k] === v) ? dispute : null,
          error: null,
        }),
      };
      return q;
    },
  };
  m.agencyAuth.mockResolvedValue({
    admin,
    user: { id: "u" },
    membership: { tenant_id: T, agency_id: A },
  });
  m.opsAuth.mockResolvedValue({
    admin,
    user: { id: "u" },
    membership: { tenant_id: T, role: "operator" },
  });
  m.rpc.mockResolvedValue({ error: null });
});
const req = (body: unknown = {}) =>
  new NextRequest("https://example.test/api/disputes", {
    method: "POST",
    body: JSON.stringify(body),
  });
it("legacy per-line submission is blocked without creating disputes or sending mail", async () => {
  expect(
    (await oldPost(req({ service_id: "s", proposed_price_cents: 100 }))).status,
  ).toBe(409);
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.oldSend).not.toHaveBeenCalled();
});
it("legacy route retains authentication", async () => {
  m.agencyAuth.mockResolvedValue(
    NextResponse.json({ error: "Sessione non valida." }, { status: 401 }),
  );
  expect((await oldPost(req())).status).toBe(401);
});
it("agency sees only own tenant disputes", async () => {
  m.agencyAuth.mockResolvedValue({
    ...(await m.agencyAuth()),
    membership: { tenant_id: T, agency_id: "another-agency" },
  });
  expect(
    (
      await (
        await GET(new NextRequest("https://example.test/api/disputes"))
      ).json()
    ).disputes,
  ).toEqual([]);
});
for (const action of ["approve", "reject"])
  it(`operator ${action} goes through atomic snapshot and service update`, async () => {
    const r = await resolve(req({ action }), {
      params: Promise.resolve({ id: D }),
    });
    expect(r.status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith(
      "resolve_statement_dispute",
      expect.objectContaining({
        p_tenant_id: T,
        p_dispute_id: D,
        p_action: action,
      }),
    );
  });
it("cannot resolve twice or overwrite finalized correction", async () => {
  dispute.status = "approved";
  expect(
    (
      await resolve(req({ action: "approve" }), {
        params: Promise.resolve({ id: D }),
      })
    ).status,
  ).toBe(409);
  expect(m.rpc).not.toHaveBeenCalled();
});
it("cannot silently reduce an amount below money already received", async () => {
  m.rpc.mockResolvedValue({
    error: { message: "STATEMENT_CORRECTION_BELOW_PAID" },
  });
  const r = await resolve(req({ action: "approve" }), {
    params: Promise.resolve({ id: D }),
  });
  expect(r.status).toBe(409);
  expect(m.send).not.toHaveBeenCalled();
});
