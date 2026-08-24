/**
 * Contestazione prezzo su estratto conto già inviato (agency_invoice_disputes,
 * migration 0246): l'agenzia propone un prezzo diverso su una riga, ITS
 * approva (applica il prezzo a services.agency_quoted_price_cents) o
 * rifiuta (nessuna modifica). Copre: creazione, approvazione, rifiuto,
 * isolamento tra agenzie/tenant.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  authorizeServiceRoleRequest: vi.fn(),
  authorizePricingRequest: vi.fn(),
  sendOperatorInvoiceDisputeNotifyEmail: vi.fn().mockResolvedValue({ status: "sent", error: null }),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizeServiceRoleRequest: mocks.authorizeServiceRoleRequest,
  authorizePricingRequest: mocks.authorizePricingRequest,
}));

vi.mock("@/lib/server/agency-approval-email", () => ({
  sendOperatorInvoiceDisputeNotifyEmail: mocks.sendOperatorInvoiceDisputeNotifyEmail,
}));

import { POST as postDispute, GET as getAgencyDisputes } from "@/app/api/agency/invoice-disputes/route";
import { POST as resolveDispute } from "@/app/api/ops/agency-invoice-disputes/[id]/resolve/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENCY_A = "agency-a";
const AGENCY_B = "agency-b";
const SERVICE_ID = "11111111-1111-4111-8111-111111111111";

type ServiceRow = { id: string; tenant_id: string; agency_id: string | null; agency_quoted_price_cents: number | null };
type DisputeRow = {
  id: string; tenant_id: string; agency_id: string; service_id: string;
  original_price_cents: number; proposed_price_cents: number; agency_note: string | null;
  status: "pending" | "approved" | "rejected"; created_by: string;
  resolved_by: string | null; resolved_at: string | null; resolution_note: string | null;
};

function makeTableBuilder(rows: Array<Record<string, unknown>>) {
  const filters: Record<string, unknown> = {};
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = (col: string, val: unknown) => { filters[col] = val; return builder; };
  builder.order = () => builder;
  builder.limit = () => builder;
  const matching = () => rows.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
  builder.maybeSingle = async () => ({ data: matching()[0] ?? null, error: null });
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: matching(), error: null }).then(resolve);
  return builder;
}

function makeAdmin(store: { services: ServiceRow[]; disputes: DisputeRow[] }) {
  let disputeSeq = 0;
  return {
    from(table: string) {
      if (table === "services") {
        const builder = makeTableBuilder(store.services as unknown as Array<Record<string, unknown>>);
        builder.update = (patch: Record<string, unknown>) => {
          const updateFilters: Record<string, unknown> = {};
          const updateBuilder: Record<string, unknown> = {};
          updateBuilder.eq = (col: string, val: unknown) => { updateFilters[col] = val; return updateBuilder; };
          updateBuilder.then = (resolve: (v: unknown) => unknown) => {
            for (const row of store.services) {
              if (Object.entries(updateFilters).every(([k, v]) => (row as unknown as Record<string, unknown>)[k] === v)) {
                Object.assign(row, patch);
              }
            }
            return Promise.resolve({ data: null, error: null }).then(resolve);
          };
          return updateBuilder;
        };
        return builder;
      }
      if (table === "agency_invoice_disputes") {
        const builder = makeTableBuilder(store.disputes as unknown as Array<Record<string, unknown>>);
        builder.insert = (row: Record<string, unknown>) => {
          const newRow = { id: `dispute-${++disputeSeq}`, resolved_by: null, resolved_at: null, resolution_note: null, ...row } as DisputeRow;
          store.disputes.push(newRow);
          return {
            select: () => ({ single: async () => ({ data: newRow, error: null }) }),
          };
        };
        builder.update = (patch: Record<string, unknown>) => {
          const updateFilters: Record<string, unknown> = {};
          const updateBuilder: Record<string, unknown> = {};
          updateBuilder.eq = (col: string, val: unknown) => { updateFilters[col] = val; return updateBuilder; };
          updateBuilder.then = (resolve: (v: unknown) => unknown) => {
            for (const row of store.disputes) {
              if (Object.entries(updateFilters).every(([k, v]) => (row as unknown as Record<string, unknown>)[k] === v)) {
                Object.assign(row, patch);
              }
            }
            return Promise.resolve({ data: null, error: null }).then(resolve);
          };
          return updateBuilder;
        };
        return builder;
      }
      if (table === "agencies") {
        return makeTableBuilder([{ id: AGENCY_A, name: "ALESTE VIAGGI" }, { id: AGENCY_B, name: "ALTRA AGENZIA" }]);
      }
      throw new Error(`tabella inattesa: ${table}`);
    },
  };
}

function makeStore(): { services: ServiceRow[]; disputes: DisputeRow[] } {
  return {
    services: [{ id: SERVICE_ID, tenant_id: TENANT, agency_id: AGENCY_A, agency_quoted_price_cents: 6600 }],
    disputes: [],
  };
}

function agencyAuth(admin: unknown, agencyId: string) {
  return {
    admin,
    user: { id: "agency-user-1", email: "aleste@example.it" },
    membership: { tenant_id: TENANT, role: "agency" as const, agency_id: agencyId },
  };
}

function opsAuth(admin: unknown) {
  return {
    admin,
    user: { id: "operator-1", email: "operatore@test.it" },
    membership: { tenant_id: TENANT, role: "operator" as const, suspended: false },
  };
}

function postRequest(body: unknown) {
  return new NextRequest("http://localhost:3010/api/agency/invoice-disputes", { method: "POST", body: JSON.stringify(body) });
}

function resolveRequest(id: string, body: unknown) {
  return {
    request: new NextRequest(`http://localhost:3010/api/ops/agency-invoice-disputes/${id}/resolve`, { method: "POST", body: JSON.stringify(body) }),
    params: Promise.resolve({ id }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Contestazione prezzo estratto conto — creazione, approvazione, rifiuto, isolamento", () => {
  it("l'agenzia crea una contestazione pending con original_price_cents preso dal servizio", async () => {
    const store = makeStore();
    const admin = makeAdmin(store);
    mocks.authorizeServiceRoleRequest.mockResolvedValue(agencyAuth(admin, AGENCY_A));

    const res = await postDispute(postRequest({ service_id: SERVICE_ID, proposed_price_cents: 6000, note: "Prezzo troppo alto" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.dispute.original_price_cents).toBe(6600);
    expect(json.dispute.proposed_price_cents).toBe(6000);
    expect(json.dispute.status).toBe("pending");
    expect(store.disputes).toHaveLength(1);

    // ITS deve ricevere un'email con il prezzo originale, quello proposto e
    // la motivazione dell'agenzia — non solo la coda in pagina.
    expect(mocks.sendOperatorInvoiceDisputeNotifyEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendOperatorInvoiceDisputeNotifyEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        agencyName: "ALESTE VIAGGI",
        originalPriceCents: 6600,
        proposedPriceCents: 6000,
        agencyNote: "Prezzo troppo alto",
      })
    );
  });

  it("seconda contestazione sulla stessa pratica mentre una è già pending -> 409, nessuna riga aggiunta", async () => {
    const store = makeStore();
    const admin = makeAdmin(store);
    mocks.authorizeServiceRoleRequest.mockResolvedValue(agencyAuth(admin, AGENCY_A));

    await postDispute(postRequest({ service_id: SERVICE_ID, proposed_price_cents: 6000 }));
    const res = await postDispute(postRequest({ service_id: SERVICE_ID, proposed_price_cents: 5500 }));

    expect(res.status).toBe(409);
    expect(store.disputes).toHaveLength(1);
  });

  it("un'agenzia non può contestare una prenotazione di un'altra agenzia -> 403", async () => {
    const store = makeStore(); // service appartiene ad AGENCY_A
    const admin = makeAdmin(store);
    mocks.authorizeServiceRoleRequest.mockResolvedValue(agencyAuth(admin, AGENCY_B));

    const res = await postDispute(postRequest({ service_id: SERVICE_ID, proposed_price_cents: 6000 }));
    expect(res.status).toBe(403);
    expect(store.disputes).toHaveLength(0);
  });

  it("GET restituisce solo le contestazioni della propria agenzia", async () => {
    const store = makeStore();
    store.disputes.push(
      { id: "d1", tenant_id: TENANT, agency_id: AGENCY_A, service_id: SERVICE_ID, original_price_cents: 6600, proposed_price_cents: 6000, agency_note: null, status: "pending", created_by: "u1", resolved_by: null, resolved_at: null, resolution_note: null },
      { id: "d2", tenant_id: TENANT, agency_id: AGENCY_B, service_id: "other-service", original_price_cents: 1000, proposed_price_cents: 900, agency_note: null, status: "pending", created_by: "u2", resolved_by: null, resolved_at: null, resolution_note: null },
    );
    const admin = makeAdmin(store);
    mocks.authorizeServiceRoleRequest.mockResolvedValue(agencyAuth(admin, AGENCY_A));

    const res = await getAgencyDisputes(new NextRequest("http://localhost:3010/api/agency/invoice-disputes"));
    const json = await res.json();
    expect(json.disputes).toHaveLength(1);
    expect(json.disputes[0].id).toBe("d1");
  });

  it("ITS approva -> services.agency_quoted_price_cents diventa il prezzo proposto, dispute 'approved'", async () => {
    const store = makeStore();
    const admin = makeAdmin(store);
    mocks.authorizeServiceRoleRequest.mockResolvedValue(agencyAuth(admin, AGENCY_A));
    await postDispute(postRequest({ service_id: SERVICE_ID, proposed_price_cents: 6000 }));
    const disputeId = store.disputes[0].id;

    mocks.authorizePricingRequest.mockResolvedValue(opsAuth(admin));
    const { request, params } = resolveRequest(disputeId, { action: "approve" });
    const res = await resolveDispute(request, { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.status).toBe("approved");
    expect(store.services[0].agency_quoted_price_cents).toBe(6000);
    expect(store.disputes[0].status).toBe("approved");
    expect(store.disputes[0].resolved_by).toBe("operator-1");
  });

  it("ITS rifiuta -> services.agency_quoted_price_cents NON cambia, dispute 'rejected'", async () => {
    const store = makeStore();
    const admin = makeAdmin(store);
    mocks.authorizeServiceRoleRequest.mockResolvedValue(agencyAuth(admin, AGENCY_A));
    await postDispute(postRequest({ service_id: SERVICE_ID, proposed_price_cents: 6000 }));
    const disputeId = store.disputes[0].id;

    mocks.authorizePricingRequest.mockResolvedValue(opsAuth(admin));
    const { request, params } = resolveRequest(disputeId, { action: "reject", resolution_note: "Prezzo corretto secondo listino" });
    const res = await resolveDispute(request, { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.status).toBe("rejected");
    expect(store.services[0].agency_quoted_price_cents).toBe(6600); // invariato
    expect(store.disputes[0].status).toBe("rejected");
  });

  it("risolvere due volte la stessa contestazione -> 409 sulla seconda, nessun doppio effetto", async () => {
    const store = makeStore();
    const admin = makeAdmin(store);
    mocks.authorizeServiceRoleRequest.mockResolvedValue(agencyAuth(admin, AGENCY_A));
    await postDispute(postRequest({ service_id: SERVICE_ID, proposed_price_cents: 6000 }));
    const disputeId = store.disputes[0].id;

    mocks.authorizePricingRequest.mockResolvedValue(opsAuth(admin));
    const first = resolveRequest(disputeId, { action: "approve" });
    await resolveDispute(first.request, { params: first.params });
    const second = resolveRequest(disputeId, { action: "reject" });
    const res = await resolveDispute(second.request, { params: second.params });

    expect(res.status).toBe(409);
    expect(store.services[0].agency_quoted_price_cents).toBe(6000); // resta il valore della prima (unica) risoluzione
  });
});
