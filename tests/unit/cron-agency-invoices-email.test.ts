import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({
  client: vi.fn(),
  send: vi.fn(),
  create: vi.fn(),
  data: vi.fn(),
  html: vi.fn(),
  xlsx: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: m.client }));
vi.mock("@/lib/server/send-email", () => ({ sendEmail: m.send }));
vi.mock("@/lib/server/agency-statements", () => ({
  createStatement: m.create,
  statementData: m.data,
}));
vi.mock("@/lib/server/invoice-pdf", () => ({
  generateInvoiceHtml: m.html,
  buildInvoiceXlsx: m.xlsx,
}));
vi.mock("@/lib/server/agency-action-token", () => ({
  generateAgencyActionToken: () => "token",
}));
import { POST, GET } from "@/app/api/cron/agency-invoices/route";
const invoice = {
  id: "doc",
  invoice_number: "EC-2026-00001",
  paid_cents: 0,
  waived_cents: 0,
  total_cents: 10000,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T08:00:00Z"));
  for (const k of [
    "CRON_SECRET",
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ])
    vi.stubEnv(k, "unit-test");
  const admin = {
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        update: (v: unknown) => {
          m.update(v);
          return q;
        },
        then: (resolve: (x: unknown) => unknown) =>
          Promise.resolve({
            data:
              table === "tenants"
                ? [{ id: "tenant" }]
                : table === "agencies"
                  ? [
                      {
                        id: "agency",
                        name: "Test",
                        invoice_email: "accounting@example.test",
                        invoice_cadence: "monthly",
                      },
                    ]
                  : [],
            error: null,
          }).then(resolve),
      };
      return q;
    },
  };
  m.client.mockReturnValue(admin);
  m.create.mockResolvedValue({ invoice, reused: false });
  m.data.mockReturnValue({
    items: [],
    totalCents: 10000,
    invoiceNumber: "EC-2026-00001",
  });
  m.html.mockReturnValue("<html/>");
  m.xlsx.mockReturnValue(Buffer.from("xlsx"));
  m.send.mockResolvedValue({ ok: true });
});
function req(auth = true) {
  return new NextRequest("https://example.test/api/cron/agency-invoices", {
    headers: auth ? { authorization: "Bearer unit-test" } : {},
  });
}
it("rejects unauthenticated cron with no accounting or email action", async () => {
  expect((await POST(req(false))).status).toBe(401);
  expect(m.create).not.toHaveBeenCalled();
  expect(m.send).not.toHaveBeenCalled();
});
it("uses shared atomic generation for previous month by arrival date", async () => {
  expect((await GET(req())).status).toBe(200);
  expect(m.create).toHaveBeenCalledWith(
    expect.anything(),
    "tenant",
    "agency",
    "2026-10-01",
    "2026-10-31",
    "arrival",
  );
  expect(m.send).toHaveBeenCalledWith(
    expect.objectContaining({
      to: "accounting@example.test",
      attachments: [
        expect.objectContaining({
          content: Buffer.from("xlsx").toString("base64"),
        }),
      ],
    }),
  );
});
it("existing document is skipped, never sent again", async () => {
  m.create.mockResolvedValue({ invoice, reused: true });
  expect((await POST(req())).status).toBe(200);
  expect(m.send).not.toHaveBeenCalled();
});
it("empty period is skipped", async () => {
  m.create.mockRejectedValue(new Error("STATEMENT_NO_SERVICES"));
  expect((await POST(req())).status).toBe(200);
  expect(m.send).not.toHaveBeenCalled();
});
it("overlap or generation error blocks email and reports failure", async () => {
  m.create.mockRejectedValue(new Error("STATEMENT_ALREADY_INCLUDED:other"));
  expect((await POST(req())).status).toBe(500);
  expect(m.send).not.toHaveBeenCalled();
});
it("provider skip is not marked as sent", async () => {
  m.send.mockResolvedValue({ ok: true, skipped: true });
  expect((await POST(req())).status).toBe(500);
  expect(m.update).not.toHaveBeenCalled();
});
it("provider failure preserves draft", async () => {
  m.send.mockResolvedValue({ ok: false });
  expect((await POST(req())).status).toBe(500);
  expect(m.update).not.toHaveBeenCalled();
});
