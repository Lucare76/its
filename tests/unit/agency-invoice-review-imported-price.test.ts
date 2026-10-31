import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({
  client: vi.fn(),
  auth: vi.fn(),
  verify: vi.fn(),
  rpc: vi.fn(),
  batch: vi.fn(),
  approve: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: m.client }));
vi.mock("@/lib/server/pricing-auth", () => ({
  authorizeServiceRoleRequest: m.auth,
}));
vi.mock("@/lib/server/agency-action-token", () => ({
  verifyAgencyActionToken: m.verify,
}));
vi.mock("@/lib/server/agency-approval-email", () => ({
  sendOperatorInvoiceBatchDisputeNotifyEmail: m.batch,
  sendOperatorInvoiceApprovedNotifyEmail: m.approve,
}));
import { POST as tokenPOST } from "@/app/api/agency/statement-token/route";
import { POST as sessionPOST } from "@/app/api/agency/invoices/[id]/review/route";
const T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  I = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  S = "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  S2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const corrections = [
  { service_id: S, proposed_price_cents: 11000, note: "First correction" },
  { service_id: S2, proposed_price_cents: 9000, note: "Second correction" },
];
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "unit-test");
  const invoice = {
    id: I,
    invoice_number: "EC-2026-00001",
    agency_name: "Test",
    period_from: "2026-10-01",
    period_to: "2026-10-31",
    total_cents: 24000,
    invoice_data: [
      {
        service_id: S,
        cliente_nome: "Synthetic 1",
        data_servizio: "2026-10-02",
        importo_cents: 12000,
      },
      {
        service_id: S2,
        cliente_nome: "Synthetic 2",
        data_servizio: "2026-10-03",
        importo_cents: 12000,
      },
    ],
  };
  const q = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => ({ data: invoice, error: null }),
  };
  const admin = { from: () => q, rpc: m.rpc };
  m.client.mockReturnValue(admin);
  m.auth.mockResolvedValue({
    admin,
    user: { id: "user" },
    membership: { tenant_id: T, agency_id: A },
  });
  m.verify.mockReturnValue({ tid: T, aid: A, iid: I, act: "invoice_review" });
  m.rpc.mockResolvedValue({ data: { disputes: [] }, error: null });
  m.batch.mockResolvedValue({ status: "sent" });
  m.approve.mockResolvedValue({ status: "sent" });
});
for (const mode of ["token", "session"])
  describe(`Whole statement review via ${mode}`, () => {
    const call = (body: unknown) => {
      const r = new NextRequest(`https://example.test/api/agency/${mode}`, {
        method: "POST",
        body: JSON.stringify({ ...(body as object), token: "test-token" }),
      });
      return mode === "token"
        ? tokenPOST(r)
        : sessionPOST(r, { params: Promise.resolve({ id: I }) });
    };
    it("saves multiple corrections in one draft with zero emails", async () => {
      expect((await call({ action: "draft", corrections })).status).toBe(200);
      expect(m.rpc).toHaveBeenCalledWith(
        "review_agency_statement",
        expect.objectContaining({
          p_action: "draft",
          p_invoice_id: I,
          p_tenant_id: T,
          p_agency_id: A,
        }),
      );
      expect(m.batch).not.toHaveBeenCalled();
      expect(m.approve).not.toHaveBeenCalled();
    });
    it("one final submission sends one batch email with original snapshot amounts", async () => {
      expect((await call({ action: "dispute", corrections })).status).toBe(200);
      expect(m.batch).toHaveBeenCalledTimes(1);
      expect(m.batch.mock.calls[0][0].corrections).toHaveLength(2);
      expect(m.batch.mock.calls[0][0].corrections[0].originalPriceCents).toBe(
        12000,
      );
      expect(m.batch.mock.calls[0][0].agencyName).toContain("EC-2026-00001");
      expect(m.approve).not.toHaveBeenCalled();
    });
    it("atomic duplicate or invalid ownership rejection sends no email", async () => {
      m.rpc.mockResolvedValue({
        error: { message: "STATEMENT_ALREADY_REVIEWED" },
      });
      expect((await call({ action: "dispute", corrections })).status).toBe(409);
      expect(m.batch).not.toHaveBeenCalled();
    });
    it("correct statement approval is separate from payment and sends once", async () => {
      expect((await call({ action: "approve" })).status).toBe(200);
      expect(m.rpc).toHaveBeenCalledWith(
        "review_agency_statement",
        expect.objectContaining({ p_action: "approve", p_corrections: [] }),
      );
      expect(m.approve).toHaveBeenCalledTimes(1);
      expect(m.batch).not.toHaveBeenCalled();
    });
    it("invalid fractional or negative proposal is rejected before database", async () => {
      for (const amount of [-1, 1.5])
        expect(
          (
            await call({
              action: "dispute",
              corrections: [{ service_id: S, proposed_price_cents: amount }],
            })
          ).status,
        ).toBe(400);
      expect(m.rpc).not.toHaveBeenCalled();
    });
    it("empty final revision is rejected, empty draft is valid", async () => {
      expect((await call({ action: "dispute", corrections: [] })).status).toBe(
        400,
      );
      expect((await call({ action: "draft", corrections: [] })).status).toBe(
        200,
      );
    });
  });
