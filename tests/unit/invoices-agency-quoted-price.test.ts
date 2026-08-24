/**
 * Regression: l'Estratto Conto agenzia deve usare il "Prezzo concordato"
 * (services.agency_quoted_price_cents, ora modificabile anche dalla pagina
 * di modifica prenotazione) come importo per riga, non il costo interno
 * (source_total_amount_cents) — quest'ultimo resta solo un fallback per
 * righe che non passano da quel campo. Prima di questo fix il campo
 * concordato non veniva letto affatto: ogni estratto conto mostrava sempre
 * zero, anche quando il prezzo era stato inserito.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  generateInvoiceHtml: vi.fn(() => "<html></html>"),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));

// invoice-pdf.ts carica lib/server/email-layout via require("@/...") a runtime
// (non un import statico): fuori dallo scope di questo test (che verifica
// solo la priorita' agency_quoted_price_cents / source_total_amount_cents
// e numero_pratica nel calcolo degli items, non l'HTML generato), e Vitest
// non risolve quell'alias dentro un require() dinamico. Stub spiabile: cattura
// gli argomenti (items) senza generare HTML reale.
vi.mock("@/lib/server/invoice-pdf", () => ({
  generateInvoiceHtml: mocks.generateInvoiceHtml,
}));

import { POST } from "@/app/api/invoices/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function makeServicesTable(testRows: Array<Record<string, unknown>>) {
  return () => {
    let isBillingNamesQuery = false;
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = () => builder;
    builder.gte = () => builder;
    builder.lte = () => builder;
    builder.order = () => builder;
    builder.in = () => builder;
    builder.ilike = () => builder;
    builder.not = () => {
      isBillingNamesQuery = true;
      return builder;
    };
    builder.then = (resolve: (v: unknown) => unknown) => {
      const data = isBillingNamesQuery ? [] : testRows;
      return Promise.resolve({ data, error: null }).then(resolve);
    };
    return builder;
  };
}

function makeAdmin(testRows: Array<Record<string, unknown>>) {
  const servicesTable = makeServicesTable(testRows);
  return {
    from(table: string) {
      if (table === "services") return servicesTable();
      if (table === "agencies") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: { id: "agency-1", name: "ALESTE VIAGGI", booking_email: "biglietteria@alesteviaggi.it" },
                    error: null,
                  }),
              }),
            }),
          }),
        };
      }
      if (table === "agency_invoices") {
        return {
          insert: () => ({
            select: () => ({
              single: () => Promise.resolve({ data: { id: "invoice-1" }, error: null }),
            }),
          }),
        };
      }
      throw new Error(`tabella inattesa nel fake admin: ${table}`);
    },
  };
}

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost:3010/api/invoices", { method: "POST", body: JSON.stringify(body) });
}

describe("POST /api/invoices — priorita' agency_quoted_price_cents su source_total_amount_cents", () => {
  beforeEach(() => {
    mocks.generateInvoiceHtml.mockClear();
  });

  it("usa il prezzo concordato quando presente, anche se diverso/assente da source_total_amount_cents", async () => {
    const rows = [
      { id: "svc-1", date: "2026-08-18", customer_name: "GERARDO D'ADDIO", billing_party_name: "ALESTE VIAGGI", booking_service_kind: "formula_medmar_napoli", notes: "", agency_quoted_price_cents: 4600, source_total_amount_cents: null, pax: 1 },
      { id: "svc-2", date: "2026-08-23", customer_name: "LUCIANO SENESE", billing_party_name: "ALESTE VIAGGI", booking_service_kind: "formula_medmar_pozzuoli", notes: "", agency_quoted_price_cents: null, source_total_amount_cents: 3000, pax: 1 },
      { id: "svc-3", date: "2026-08-24", customer_name: "ANNAMARIA ESPOSITO", billing_party_name: "ALESTE VIAGGI", booking_service_kind: "formula_medmar_napoli", notes: "", agency_quoted_price_cents: 9200, source_total_amount_cents: 1, pax: 1 },
      { id: "svc-4", date: "2026-08-24", customer_name: "ANNA CARRANO", billing_party_name: "ALESTE VIAGGI", booking_service_kind: "formula_medmar_napoli", notes: "", agency_quoted_price_cents: null, source_total_amount_cents: null, pax: 1 },
    ];
    mocks.authorizePricingRequest.mockResolvedValue({
      admin: makeAdmin(rows),
      user: { id: "user-1", email: "operatore@test.it" },
      membership: { tenant_id: TENANT, role: "operator", suspended: false },
    });

    const res = await POST(makeRequest({
      agency_name: "ALESTE VIAGGI",
      period_from: "2026-08-16",
      period_to: "2026-08-24",
      send: false,
    }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.items_count).toBe(4);
    // 4600 (solo concordato) + 3000 (fallback su source) + 9200 (concordato
    // vince su source=1, MAI 1) + 0 (nessuno dei due) = 16800.
    expect(json.total_cents).toBe(16800);
  });

  it("nessun prezzo concordato ne' source su nessuna riga -> totale zero, nessun errore", async () => {
    const rows = [
      { id: "svc-1", date: "2026-08-18", customer_name: "TEST", billing_party_name: "ALESTE VIAGGI", booking_service_kind: "transfer", notes: "", agency_quoted_price_cents: null, source_total_amount_cents: null, pax: 1 },
    ];
    mocks.authorizePricingRequest.mockResolvedValue({
      admin: makeAdmin(rows),
      user: { id: "user-1", email: "operatore@test.it" },
      membership: { tenant_id: TENANT, role: "operator", suspended: false },
    });

    const res = await POST(makeRequest({
      agency_name: "ALESTE VIAGGI",
      period_from: "2026-08-16",
      period_to: "2026-08-24",
      send: false,
    }));
    const json = await res.json();

    expect(json.ok).toBe(true);
    expect(json.total_cents).toBe(0);
  });

  it("numero_pratica: quello dell'agenzia (dal PDF, tag [practice:XXX] in notes) ha priorita' sul numero ITS", async () => {
    const rows = [
      // Riga arrivata da PDF agenzia: notes porta il tag [practice:XXX] E la
      // riga ha comunque un practice_number ITS valorizzato (capita se poi
      // l'operatore la modifica manualmente) — deve vincere quello agenzia.
      { id: "svc-1", date: "2026-08-18", customer_name: "GERARDO D'ADDIO", billing_party_name: "ALESTE VIAGGI", booking_service_kind: "formula_medmar_napoli", notes: "[practice:AV-2024-001]", agency_quoted_price_cents: 6600, source_total_amount_cents: null, practice_number: "ITS-2026-42", pax: 1 },
      // Riga inserita a mano da ITS: nessun tag agenzia in notes, deve
      // ripiegare sul numero ITS invece di mostrare sempre "—".
      { id: "svc-2", date: "2026-08-23", customer_name: "LUCIANO SENESE", billing_party_name: "ALESTE VIAGGI", booking_service_kind: "formula_medmar_pozzuoli", notes: "", agency_quoted_price_cents: 6000, source_total_amount_cents: null, practice_number: "ITS-2026-43", pax: 1 },
      // Nessuno dei due: resta "—".
      { id: "svc-3", date: "2026-08-24", customer_name: "ANNA CARRANO", billing_party_name: "ALESTE VIAGGI", booking_service_kind: "formula_medmar_napoli", notes: "", agency_quoted_price_cents: 9900, source_total_amount_cents: null, practice_number: null, pax: 1 },
    ];
    mocks.authorizePricingRequest.mockResolvedValue({
      admin: makeAdmin(rows),
      user: { id: "user-1", email: "operatore@test.it" },
      membership: { tenant_id: TENANT, role: "operator", suspended: false },
    });

    await POST(makeRequest({
      agency_name: "ALESTE VIAGGI",
      period_from: "2026-08-16",
      period_to: "2026-08-24",
      send: false,
    }));

    expect(mocks.generateInvoiceHtml).toHaveBeenCalledTimes(1);
    const passedItems = mocks.generateInvoiceHtml.mock.calls[0][0].items as Array<{ numero_pratica: string }>;
    expect(passedItems.map((i) => i.numero_pratica)).toEqual(["AV-2024-001", "ITS-2026-43", "—"]);
  });
});
