import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import type { InvoiceData } from "@/lib/server/invoice-pdf";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), sendEmail: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/server/send-email", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("@/lib/server/invoice-pdf", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/server/invoice-pdf")>(),
  generateInvoiceHtml: (data: InvoiceData) => `<a href="${data.reviewUrl}">${data.totalCents}</a>`,
}));
vi.mock("@/lib/server/agency-action-token", () => ({ generateAgencyActionToken: () => "test-token" }));

import { GET, POST } from "@/app/api/cron/agency-invoices/route";

const TENANT = "tenant-test";
function setup(insertError = false, updateError = false, serviceFields: Record<string, unknown> = {}) {
  const invoice = { status: "draft" };
  const inserts: Array<Record<string, unknown>> = [];
  const filters: Array<[string, unknown]> = [];
  const update = vi.fn();
  mocks.createClient.mockReturnValue({
    from(table: string) {
      let values: Record<string, unknown> | undefined;
      const query = {
        select: () => query, limit: () => query,
        maybeSingle: async () => ({ data: null, error: null }),
        eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
        ilike: () => query, gte: () => query, lte: () => query, order: () => query,
        insert: (row: Record<string, unknown>) => { inserts.push(row); return query; },
        update: (row: Record<string, unknown>) => { update(row); values = row; return query; },
        single: async () => ({ data: insertError ? null : { id: "invoice-test" }, error: insertError ? { message: "Insert failed" } : null }),
        then: (resolve: (value: unknown) => unknown) => {
          if (values && !updateError) Object.assign(invoice, values);
          const data = table === "tenants" ? [{ id: TENANT }]
            : table === "agencies" ? [{ id: "agency-test", name: "AGENZIA TEST", invoice_email: "luca_renna@hotmail.com", invoice_cadence: "weekly", invoice_send_day: 4 }]
              : table === "services" ? [{ id: "service-test", date: "2026-10-25", customer_name: "CLIENTE TEST", notes: "[practice:TEST-001]", agency_quoted_price_cents: 6600, source_total_amount_cents: 9999, ...serviceFields }]
                : null;
          return Promise.resolve({ data, error: values && updateError ? { message: "Update failed" } : null }).then(resolve);
        },
      };
      return query;
    },
  });
  return { invoice, inserts, filters, update };
}

function request(method = "GET", secret = "test-secret") {
  return new NextRequest("https://ischia-transfer.vercel.app/api/cron/agency-invoices", {
    method, headers: { authorization: `Bearer ${secret}` },
  });
}

describe("Estratti conto automatici: GET autenticato, Excel e conferma invio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-29T08:00:00Z"));
    vi.stubEnv("CRON_SECRET", "test-secret");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key");
    mocks.sendEmail.mockResolvedValue({ ok: true });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("GET senza secret valido non accede ai dati e non invia", async () => {
    expect((await GET(request("GET", "wrong"))).status).toBe(401);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it.each([GET, POST])("GET e POST inviano HTML e XLSX coerenti, poi segnano inviato", async (handler) => {
    const fake = setup();
    const response = await handler(request(handler === POST ? "POST" : "GET"));
    expect(await response.json()).toMatchObject({ ok: true, sent: 1, failed: 0 });
    expect(fake.inserts[0]).toMatchObject({ status: "draft", total_cents: 6600, services_count: 1 });
    expect(fake.inserts[0]).not.toHaveProperty("sent_at");
    const payload = mocks.sendEmail.mock.calls[0][0];
    expect(payload.to).toBe("luca_renna@hotmail.com");
    expect(payload.html).toContain("agency-estratto-conto?token=test-token");
    expect(payload.attachments[0].filename).toMatch(/\.xlsx$/);
    const workbook = XLSX.read(Buffer.from(payload.attachments[0].content, "base64"), { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets["Estratto conto"], { header: 1 }) as unknown[][];
    expect(rows[1][0]).toBe("TEST-001");
    expect(rows[1][4]).toBe(66);
    expect(rows[2][4]).toBe(66);
    expect(fake.invoice.status).toBe("sent");
    expect(fake.filters).toContainEqual(["tenant_id", TENANT]);
  });

  it("anche il cron salva la formula importata e la include nell'Excel", async () => {
    const fake = setup(false, false, { booking_service_kind: "transfer_port_hotel", include_ferry_tickets: true, ferry_details: { carrier_company: "MEDMAR" } });
    expect((await GET(request())).status).toBe(200);
    expect((fake.inserts[0].invoice_data as Record<string, unknown>[])[0]).toMatchObject({ tipo_servizio: "transfer_port_hotel", descrizione_servizio: "Formula MEDMAR", importo_cents: 6600 });
    const attachment = mocks.sendEmail.mock.calls[0][0].attachments[0];
    const book = XLSX.read(Buffer.from(attachment.content, "base64"), { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json(book.Sheets["Estratto conto"], { header: 1 }) as unknown[][];
    expect(rows[1].slice(3)).toEqual(["Formula MEDMAR", 66]);
  });

  it.each([{ ok: false, error: "Provider rejected" }, { ok: true, skipped: true }])("invio fallito o saltato lascia la bozza", async (result) => {
    const fake = setup();
    mocks.sendEmail.mockResolvedValue(result);
    const response = await GET(request());
    expect(await response.json()).toMatchObject({ ok: false, sent: 0, failed: 1 });
    expect(fake.update).not.toHaveBeenCalled();
    expect(fake.invoice.status).toBe("draft");
  });

  it("un errore di inserimento non invia un documento inesistente", async () => {
    setup(true);
    const response = await GET(request());
    expect(await response.json()).toMatchObject({ ok: false, sent: 0, failed: 1 });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("un errore nel salvataggio dello stato non viene contato come successo", async () => {
    setup(false, true);
    const response = await GET(request());
    expect(await response.json()).toMatchObject({ ok: false, sent: 0, failed: 1 });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });
});
