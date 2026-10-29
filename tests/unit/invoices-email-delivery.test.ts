import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import type { InvoiceData } from "@/lib/server/invoice-pdf";

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  resendFetch: vi.fn(),
  generateInvoiceHtml: vi.fn((data: InvoiceData) => `<a href="${data.reviewUrl}">Vedi estratto conto</a>`),
}));

vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorizePricingRequest }));
vi.mock("@/lib/server/send-email", () => ({
  getVerifiedFromEmail: () => "noreply@ischiatransferservice.it",
  resendFetch: mocks.resendFetch,
}));
vi.mock("@/lib/server/invoice-pdf", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/server/invoice-pdf")>(),
  generateInvoiceHtml: mocks.generateInvoiceHtml,
}));
vi.mock("@/lib/server/agency-action-token", () => ({ generateAgencyActionToken: () => "test-review-token" }));

import { POST } from "@/app/api/invoices/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEST_EMAIL = "luca_renna@hotmail.com";

function fakeAdmin(email: string | null = TEST_EMAIL, updateError: { message: string } | null = null, invoiceEmail?: string) {
  const insert = vi.fn();
  const update = vi.fn();
  const filters: Array<[string, unknown]> = [];
  const invoice = { status: "draft" };
  return {
    insert, update, filters, invoice,
    admin: {
      from(table: string) {
        if (table === "agencies") {
          const query = {
            select: () => query,
            eq: () => query,
            maybeSingle: async () => ({ data: { id: "agency-1", booking_email: email, invoice_email: invoiceEmail }, error: null }),
          };
          return query;
        }
        if (table === "services") {
          let namesOnly = false;
          const query = {
            select: () => query, eq: () => query, gte: () => query, lte: () => query,
            order: () => query, in: () => query, ilike: () => query,
            not: () => { namesOnly = true; return query; },
            then: (resolve: (value: unknown) => unknown) => Promise.resolve({
              data: namesOnly ? [] : [{
                id: "service-1", date: "2026-10-10", customer_name: "CLIENTE DI PROVA",
                notes: "[practice:TEST-001]", agency_quoted_price_cents: 6600,
                source_total_amount_cents: 9999, booking_service_kind: "transfer",
              }], error: null,
            }).then(resolve),
          };
          return query;
        }
        if (table === "agency_invoices") {
          return {
            insert: (values: Record<string, unknown>) => {
              insert(values);
              return { select: () => ({ single: async () => ({ data: { id: "invoice-1" }, error: null }) }) };
            },
            update: (values: Record<string, unknown>) => {
              update(values);
              const query = {
                eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
                then: (resolve: (value: unknown) => unknown) => {
                  if (!updateError) Object.assign(invoice, values);
                  return Promise.resolve({ error: updateError }).then(resolve);
                },
              };
              return query;
            },
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      },
    },
  };
}

function request(send = true) {
  return new NextRequest("https://ischia-transfer.vercel.app/api/invoices", {
    method: "POST",
    body: JSON.stringify({ agency_name: "AGENZIA DI PROVA", period_from: "2026-10-01", period_to: "2026-10-15", send }),
  });
}

function authorize(fake: ReturnType<typeof fakeAdmin>) {
  mocks.authorizePricingRequest.mockResolvedValue({ admin: fake.admin, membership: { tenant_id: TENANT } });
}

describe("Primo invio estratto conto: HTML, Excel e stato di invio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("RESEND_API_KEY", "test-key-no-network");
    mocks.resendFetch.mockResolvedValue(new Response('{"id":"message-1"}', { status: 200 }));
  });
  afterEach(() => vi.unstubAllEnvs());

  it("un rifiuto del provider non marca inviato e restituisce la bozza da reinviare", async () => {
    const fake = fakeAdmin();
    authorize(fake);
    mocks.resendFetch.mockResolvedValue(new Response("rejected", { status: 422 }));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, invoice_id: "invoice-1" });
    expect(fake.insert).toHaveBeenCalledTimes(1);
    expect(fake.update).not.toHaveBeenCalled();
    expect(fake.invoice.status).toBe("draft");
  });

  it("invia HTML con link operativo e un vero Excel coerente con righe e totale", async () => {
    const fake = fakeAdmin();
    authorize(fake);
    const response = await POST(request());
    expect(response.status).toBe(200);
    const payload = mocks.resendFetch.mock.calls[0][1];
    expect(payload.to).toEqual([TEST_EMAIL]);
    expect(payload.html).toContain("/agency-estratto-conto?token=test-review-token");
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].filename).toMatch(/\.xlsx$/);
    const workbook = XLSX.read(Buffer.from(payload.attachments[0].content, "base64"), { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets["Estratto conto"], { header: 1 });
    expect(rows).toEqual([
      ["Numero pratica", "Cliente", "Data servizio", "Tipo servizio", "Importo EUR"],
      ["TEST-001", "CLIENTE DI PROVA", "10/10/2026", "transfer", 66],
      ["", "", "", "Totale", 66],
    ]);
    const htmlData = mocks.generateInvoiceHtml.mock.calls[0][0];
    expect(htmlData.items[0].importo_cents).toBe(6600);
    expect(htmlData.totalCents).toBe(6600);
    expect(fake.invoice.status).toBe("sent");
    expect(fake.filters).toContainEqual(["tenant_id", TENANT]);
  });

  it("senza configurazione di invio non crea una bozza dichiarando successo", async () => {
    const fake = fakeAdmin();
    authorize(fake);
    vi.stubEnv("RESEND_API_KEY", "");
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect((await response.json()).ok).toBe(false);
    expect(fake.insert).not.toHaveBeenCalled();
    expect(mocks.resendFetch).not.toHaveBeenCalled();
  });

  it("rispetta l'indirizzo dedicato agli estratti conto anche quando quello prenotazioni è diverso", async () => {
    authorize(fakeAdmin("prenotazioni@example.com", null, TEST_EMAIL));
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.resendFetch.mock.calls[0][1].to).toEqual([TEST_EMAIL]);
  });

  it("senza destinatario segnala l'errore prima di creare o inviare", async () => {
    const fake = fakeAdmin(null);
    authorize(fake);
    const response = await POST(request());
    expect(response.status).toBe(400);
    expect(fake.insert).not.toHaveBeenCalled();
    expect(mocks.resendFetch).not.toHaveBeenCalled();
  });

  it("la sola generazione della bozza funziona anche senza configurazione email", async () => {
    const fake = fakeAdmin(null);
    authorize(fake);
    vi.stubEnv("RESEND_API_KEY", "");
    const response = await POST(request(false));
    expect(response.status).toBe(200);
    expect(fake.invoice.status).toBe("draft");
    expect(mocks.resendFetch).not.toHaveBeenCalled();
  });

  it("un errore di rete lascia la bozza e non marca inviato", async () => {
    const fake = fakeAdmin();
    authorize(fake);
    mocks.resendFetch.mockRejectedValue(new Error("Network error"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(fake.update).not.toHaveBeenCalled();
    expect(fake.invoice.status).toBe("draft");
  });

  it("se l'email è accettata ma il salvataggio dello stato fallisce, avverte prima di un reinvio", async () => {
    const fake = fakeAdmin(TEST_EMAIL, { message: "DB unavailable" });
    authorize(fake);
    const response = await POST(request());
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toMatchObject({ ok: false, invoice_id: "invoice-1" });
    expect(body.error).toContain("Verifica prima di reinviare");
    expect(mocks.resendFetch).toHaveBeenCalledTimes(1);
  });
});
