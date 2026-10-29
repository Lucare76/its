import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  authorizeServiceRoleRequest: vi.fn(),
  authorizePricingRequest: vi.fn(),
  verifyAgencyActionToken: vi.fn(),
  sendOperatorInvoiceBatchDisputeNotifyEmail: vi.fn(),
  sendOperatorInvoiceApprovedNotifyEmail: vi.fn(),
  sendAgencyInvoiceDisputeResolvedEmail: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/server/pricing-auth", () => ({
  authorizeServiceRoleRequest: mocks.authorizeServiceRoleRequest,
  authorizePricingRequest: mocks.authorizePricingRequest,
}));
vi.mock("@/lib/server/agency-action-token", () => ({ verifyAgencyActionToken: mocks.verifyAgencyActionToken }));
vi.mock("@/lib/server/agency-approval-email", () => ({
  sendOperatorInvoiceBatchDisputeNotifyEmail: mocks.sendOperatorInvoiceBatchDisputeNotifyEmail,
  sendOperatorInvoiceApprovedNotifyEmail: mocks.sendOperatorInvoiceApprovedNotifyEmail,
  sendAgencyInvoiceDisputeResolvedEmail: mocks.sendAgencyInvoiceDisputeResolvedEmail,
}));
vi.mock("@/lib/server/ops-audit", () => ({ auditLog: vi.fn() }));

import { POST as tokenReview } from "@/app/api/agency/statement-token/route";
import { POST as sessionReview } from "@/app/api/agency/invoices/[id]/review/route";
import { POST as resolveDispute } from "@/app/api/ops/agency-invoice-disputes/[id]/resolve/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENCY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INVOICE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SERVICE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DISPUTE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
type Row = Record<string, unknown>;

function setup(snapshotPrice: unknown = 12000) {
  const service: Row = {
    id: SERVICE, tenant_id: TENANT, agency_id: AGENCY,
    agency_quoted_price_cents: null, source_total_amount_cents: 12000,
    date: "2026-10-11", customer_name: "CLIENTE TEST",
  };
  const invoice: Row = {
    id: INVOICE, tenant_id: TENANT, agency_id: AGENCY,
    agency_name: "AGENZIA TEST", period_from: "2026-10-01", period_to: "2026-10-15",
    agency_review_status: "pending", total_cents: snapshotPrice,
    invoice_data: [{ service_id: SERVICE, importo_cents: snapshotPrice }],
  };
  const tables: Record<string, Row[]> = { services: [service], agency_invoices: [invoice], agency_invoice_disputes: [] };
  const writes: Array<{ table: string; patch: Row }> = [];
  const admin = {
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = [];
      let patch: Row | undefined;
      const match = () => tables[table].filter(row => filters.every(filter => filter(row)));
      const result = () => {
        if (patch) for (const row of match()) Object.assign(row, patch);
        return { data: match(), error: null };
      };
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { filters.push(row => row[key] === value); return query; },
        in: (key: string, values: unknown[]) => { filters.push(row => values.includes(row[key])); return query; },
        maybeSingle: async () => ({ data: match()[0] ?? null, error: null }),
        update: (values: Row) => { patch = values; writes.push({ table, patch: values }); return query; },
        insert: (rows: Row[]) => { tables[table].push(...rows.map(row => ({ id: DISPUTE, ...row }))); return query; },
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
      };
      return query;
    },
  };
  mocks.createClient.mockReturnValue(admin);
  mocks.authorizeServiceRoleRequest.mockResolvedValue({ admin, user: { id: "agency-user" }, membership: { tenant_id: TENANT, agency_id: AGENCY, role: "agency" } });
  mocks.authorizePricingRequest.mockResolvedValue({ admin, user: { id: "operator-user" }, membership: { tenant_id: TENANT, role: "operator" } });
  return { service, invoice, tables, writes };
}

async function review(via: "token" | "session", serviceId = SERVICE) {
  const body = { token: "test-token", action: "dispute", corrections: [{ service_id: serviceId, proposed_price_cents: 11000, note: "Verifica importo" }] };
  const request = new NextRequest("https://ischia-transfer.vercel.app/api/agency/statement-token", { method: "POST", body: JSON.stringify(body) });
  return via === "token" ? tokenReview(request) : sessionReview(request, { params: Promise.resolve({ id: INVOICE }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key");
  mocks.verifyAgencyActionToken.mockReturnValue({ act: "invoice_review", tid: TENANT, aid: AGENCY, iid: INVOICE });
  mocks.sendOperatorInvoiceBatchDisputeNotifyEmail.mockResolvedValue({ status: "sent" });
  mocks.sendAgencyInvoiceDisputeResolvedEmail.mockResolvedValue({ status: "sent" });
});
afterEach(() => vi.unstubAllEnvs());

describe.each(["token", "session"] as const)("Contestazione prezzo importato tramite %s", via => {
  it("accetta l'importo dell'estratto anche senza prezzo concordato e lascia invariato il servizio", async () => {
    const fake = setup();
    const response = await review(via);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, agency_review_status: "disputed" });
    expect(fake.tables.agency_invoice_disputes).toEqual([expect.objectContaining({
      original_price_cents: 12000, proposed_price_cents: 11000,
      tenant_id: TENANT, agency_id: AGENCY, agency_invoice_id: INVOICE, status: "pending",
    })]);
    expect(fake.service.agency_quoted_price_cents).toBeNull();
    expect(fake.service.source_total_amount_cents).toBe(12000);
    expect(fake.writes.filter(write => write.table === "services")).toHaveLength(0);
    expect(mocks.sendOperatorInvoiceBatchDisputeNotifyEmail).toHaveBeenCalledWith(expect.objectContaining({
      corrections: [expect.objectContaining({ originalPriceCents: 12000, proposedPriceCents: 11000 })],
    }));
  });

  it("usa l'importo inviato nell'estratto anche se il prezzo attuale del servizio è cambiato", async () => {
    const fake = setup(12000);
    fake.service.agency_quoted_price_cents = 14000;
    fake.service.source_total_amount_cents = 15000;
    expect((await review(via)).status).toBe(200);
    expect(fake.tables.agency_invoice_disputes[0].original_price_cents).toBe(12000);
    expect(fake.service.agency_quoted_price_cents).toBe(14000);
    expect(mocks.sendOperatorInvoiceBatchDisputeNotifyEmail).toHaveBeenCalledWith(expect.objectContaining({
      corrections: [expect.objectContaining({ originalPriceCents: 12000 })],
    }));
  });

  it("ammette anche una riga con importo zero", async () => {
    const fake = setup(0);
    expect((await review(via)).status).toBe(200);
    expect(fake.tables.agency_invoice_disputes[0].original_price_cents).toBe(0);
  });

  it.each([null, undefined, "12000", -1, 12.5])("rifiuta un importo originale non valido (%s) senza scritture o notifiche", async price => {
    const fake = setup(price);
    // undefined deve rappresentare un campo realmente mancante, non il default del fixture.
    if (price === undefined) fake.invoice.invoice_data = [{ service_id: SERVICE }];
    expect((await review(via)).status).toBe(422);
    expect(fake.tables.agency_invoice_disputes).toHaveLength(0);
    expect(fake.writes).toHaveLength(0);
    expect(mocks.sendOperatorInvoiceBatchDisputeNotifyEmail).not.toHaveBeenCalled();
  });

  it.each(["tenant_id", "agency_id"])("non legge un estratto di un altro %s", async key => {
    const fake = setup();
    fake.invoice[key] = "other";
    expect((await review(via)).status).toBe(404);
    expect(fake.tables.agency_invoice_disputes).toHaveLength(0);
  });

  it("non accetta una pratica assente dall'estratto", async () => {
    const fake = setup();
    expect((await review(via, "ffffffff-ffff-4fff-8fff-ffffffffffff")).status).toBe(403);
    expect(fake.tables.agency_invoice_disputes).toHaveLength(0);
  });

  it("non accetta un servizio che ora appartiene a un'altra agenzia", async () => {
    const fake = setup();
    fake.service.agency_id = "other";
    expect((await review(via)).status).toBe(404);
    expect(fake.tables.agency_invoice_disputes).toHaveLength(0);
  });

  it("non accetta un servizio di un altro tenant", async () => {
    const fake = setup();
    fake.service.tenant_id = "other";
    expect((await review(via)).status).toBe(404);
    expect(fake.tables.agency_invoice_disputes).toHaveLength(0);
  });

  it("non crea una seconda revisione dello stesso estratto", async () => {
    const fake = setup();
    fake.invoice.agency_review_status = "disputed";
    expect((await review(via)).status).toBe(409);
    expect(fake.tables.agency_invoice_disputes).toHaveLength(0);
  });

  it.each(["approve", "reject"] as const)("solo la decisione ITS %s può applicare il prezzo proposto", async action => {
    const fake = setup();
    expect((await review(via)).status).toBe(200);
    expect(fake.service.agency_quoted_price_cents).toBeNull();
    const request = new NextRequest("https://ischia-transfer.vercel.app/api/ops/agency-invoice-disputes/test/resolve", {
      method: "POST", body: JSON.stringify({ action }),
    });
    const response = await resolveDispute(request, { params: Promise.resolve({ id: DISPUTE }) });
    expect(response.status).toBe(200);
    expect(fake.service.agency_quoted_price_cents).toBe(action === "approve" ? 11000 : null);
    expect(fake.service.source_total_amount_cents).toBe(12000);
    expect(fake.tables.agency_invoice_disputes[0].status).toBe(action === "approve" ? "approved" : "rejected");
  });
});

it("token invalido resta bloccato prima di accedere ai dati", async () => {
  mocks.verifyAgencyActionToken.mockReturnValue(null);
  expect((await review("token")).status).toBe(400);
  expect(mocks.createClient).not.toHaveBeenCalled();
});

it("la sessione non autorizzata resta bloccata", async () => {
  mocks.authorizeServiceRoleRequest.mockResolvedValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
  expect((await review("session")).status).toBe(401);
});
