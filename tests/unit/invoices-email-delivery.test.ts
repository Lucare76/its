import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({
  auth: vi.fn(),
  rpc: vi.fn(),
  send: vi.fn(),
  update: vi.fn(),
  html: vi.fn(),
  xlsx: vi.fn(),
}));
vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: m.auth,
}));
vi.mock("@/lib/server/send-email", () => ({
  resendFetch: m.send,
  getVerifiedFromEmail: () => "info@ischiatransferservice.it",
}));
vi.mock("@/lib/server/invoice-pdf", () => ({
  generateInvoiceHtml: m.html,
  buildInvoiceXlsx: m.xlsx,
}));
vi.mock("@/lib/server/agency-action-token", () => ({
  generateAgencyActionToken: () => "opaque-test-token",
}));
import { POST } from "@/app/api/invoices/route";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  T = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const invoice = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  agency_id: A,
  tenant_id: T,
  agency_name: "Test",
  invoice_number: "EC-2026-00001",
  date_basis: "arrival",
  period_from: "2026-10-25",
  period_to: "2026-10-31",
  status: "draft",
  sent_at: null,
  total_cents: 26200,
  paid_cents: 10000,
  waived_cents: 0,
  services_count: 1,
  created_at: "2026-10-31",
  invoice_data: [
    {
      service_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      numero_pratica: "26/001",
      cliente_nome: "Synthetic",
      data_servizio: "2026-10-31",
      tipo_servizio: "formula_medmar_pozzuoli",
      pax: 9,
      importo_cents: 26200,
      paid_cents: 10000,
    },
  ],
};
function req(extra = {}) {
  return new NextRequest("https://example.test/api/invoices", {
    method: "POST",
    body: JSON.stringify({
      agency_id: A,
      agency_name: "Test",
      period_from: "2026-10-25",
      period_to: "2026-10-31",
      date_basis: "arrival",
      send: true,
      ...extra,
    }),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RESEND_API_KEY", "unit-test");
  m.rpc.mockResolvedValue({
    data: { invoice: structuredClone(invoice), reused: false },
    error: null,
  });
  m.send.mockResolvedValue({ ok: true });
  m.html.mockReturnValue("<html>statement</html>");
  m.xlsx.mockReturnValue(Buffer.from("xlsx"));
  m.update.mockReturnValue({
    eq: () => ({ eq: async () => ({ error: null }) }),
  });
  const agency = {
    id: A,
    name: "Test",
    invoice_email: "accounting@example.test",
    booking_email: "booking@example.test",
  };
  const admin = {
    rpc: m.rpc,
    from: (table: string) => {
      if (table === "agencies") {
        const q = {
          select: () => q,
          eq: () => q,
          maybeSingle: async () => ({ data: agency, error: null }),
        };
        return q;
      }
      return { update: m.update };
    },
  };
  m.auth.mockResolvedValue({ admin, membership: { tenant_id: T } });
});
describe("Statement delivery after atomic generation", () => {
  it("passes arrival criterion and exact agency to database, HTML and Excel use one snapshot", async () => {
    const r = await POST(req());
    expect(r.status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith(
      "create_agency_statement",
      expect.objectContaining({
        p_agency_id: A,
        p_basis: "arrival",
        p_from: "2026-10-25",
        p_to: "2026-10-31",
      }),
    );
    expect(m.html.mock.calls[0][0]).toMatchObject({
      invoiceNumber: "EC-2026-00001",
      totalCents: 26200,
      paidCents: 10000,
    });
    expect(m.xlsx.mock.calls[0][0]).toEqual(m.html.mock.calls[0][0]);
    expect(m.send.mock.calls[0][1]).toMatchObject({
      to: ["accounting@example.test"],
      attachments: [
        {
          filename: "EC-2026-00001.xlsx",
          content: Buffer.from("xlsx").toString("base64"),
        },
      ],
    });
  });
  it("supports departure criterion", async () => {
    await POST(req({ date_basis: "departure" }));
    expect(m.rpc).toHaveBeenCalledWith(
      "create_agency_statement",
      expect.objectContaining({ p_basis: "departure" }),
    );
  });
  it("repeated generation returns same number without another email", async () => {
    m.rpc.mockResolvedValue({ data: { invoice, reused: true } });
    const r = await POST(req());
    expect(await r.json()).toMatchObject({
      reused: true,
      invoice_number: "EC-2026-00001",
    });
    expect(m.send).not.toHaveBeenCalled();
  });
  it("draft does not send or mark sent", async () => {
    const r = await POST(req({ send: false }));
    expect(r.status).toBe(200);
    expect(m.send).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });
  it("provider rejection preserves draft", async () => {
    m.send.mockResolvedValue({ ok: false });
    expect((await POST(req())).status).toBe(502);
    expect(m.update).not.toHaveBeenCalled();
  });
  it("missing price or overlapping booking blocks email", async () => {
    m.rpc.mockResolvedValue({
      error: { message: "STATEMENT_ALREADY_INCLUDED:other" },
    });
    expect((await POST(req())).status).toBe(409);
    expect(m.send).not.toHaveBeenCalled();
  });
  it("invalid period or date basis does not access accounting RPC", async () => {
    expect((await POST(req({ period_from: "2026-11-01" }))).status).toBe(400);
    expect((await POST(req({ date_basis: "invalid" }))).status).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("fully paid statement stays paid when sent", async () => {
    m.rpc.mockResolvedValue({
      data: { invoice: { ...invoice, paid_cents: 26200 }, reused: false },
    });
    await POST(req());
    expect(m.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "paid" }),
    );
  });
});
