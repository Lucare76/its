import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/**
 * Fix P1 (audit pre-go-live): app/api/ops/modification-requests/[id]/resolve
 * marcava la modification_request come "approved" PRIMA di verificare
 * l'esito dell'update su services (e nessuno dei due update ne controllava
 * l'errore) — possibile stato incoerente modification_request.approved +
 * services update fallito. Il fix inverte l'ordine (service update prima,
 * con controllo esplicito dell'errore) e verifica anche l'esito dell'update
 * sulla modification_request stessa prima di proseguire con audit/notifiche/email.
 */

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  sendEmail: vi.fn(),
  getOperatorName: vi.fn(),
  recordServiceAuditEvent: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));

vi.mock("@/lib/server/send-email", () => ({
  sendEmail: mocks.sendEmail,
}));

vi.mock("@/lib/server/service-audit-log", () => ({
  getOperatorName: mocks.getOperatorName,
}));

vi.mock("@/lib/server/service-audit-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/service-audit-events")>();
  return { ...actual, recordServiceAuditEvent: mocks.recordServiceAuditEvent };
});

import { POST } from "@/app/api/ops/modification-requests/[id]/resolve/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MR_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AGENCY_USER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type MrRow = {
  id: string;
  status: string;
  service_id: string;
  changes: Record<string, unknown>;
  requested_by_user_id: string | null;
  services: Record<string, unknown> | null;
};

function baseMr(overrides: Partial<MrRow> = {}): MrRow {
  return {
    id: MR_ID,
    status: "pending",
    service_id: SERVICE_ID,
    changes: { pax: 3 },
    requested_by_user_id: AGENCY_USER_ID,
    services: { customer_name: "MARIOTTI SERENA", agency_id: null, agencies: null },
    ...overrides,
  };
}

function makeRequest(body: unknown) {
  return new NextRequest(`http://localhost:3010/api/ops/modification-requests/${MR_ID}/resolve`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function makeFakeAdmin(opts: {
  mr: MrRow | null;
  serviceUpdateError?: { message: string } | null;
  mrUpdateError?: { message: string } | null;
  serviceUpdates: Array<Record<string, unknown>>;
  mrUpdates: Array<Record<string, unknown>>;
  notificationInserts: Array<Record<string, unknown>>;
}) {
  const modificationRequestsBuilder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: opts.mr, error: null });
    b.update = (payload: Record<string, unknown>) => {
      opts.mrUpdates.push(payload);
      return { eq: () => Promise.resolve({ error: opts.mrUpdateError ?? null }) };
    };
    return b;
  };

  const servicesBuilder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    b.update = (payload: Record<string, unknown>) => {
      opts.serviceUpdates.push(payload);
      return { eq: () => ({ eq: () => Promise.resolve({ error: opts.serviceUpdateError ?? null }) }) };
    };
    return b;
  };

  const notificationsBuilder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    b.insert = (payload: Record<string, unknown>) => {
      opts.notificationInserts.push(payload);
      return Promise.resolve({ error: null });
    };
    return b;
  };

  const genericBuilder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "insert"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: null, error: null });
    return b;
  };

  return {
    from(table: string) {
      if (table === "modification_requests") return modificationRequestsBuilder();
      if (table === "services") return servicesBuilder();
      if (table === "notifications") return notificationsBuilder();
      return genericBuilder();
    },
  } as never;
}

function makeAuthContext(admin: unknown) {
  return {
    admin,
    user: { id: "user-1", email: "operatore@test.it" },
    membership: { tenant_id: TENANT, role: "operator", suspended: false },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOperatorName.mockResolvedValue("Operatore Test");
  mocks.recordServiceAuditEvent.mockResolvedValue(undefined);
  mocks.sendEmail.mockResolvedValue({ ok: true });
});

describe("POST /api/ops/modification-requests/[id]/resolve — APPROVE happy path", () => {
  it("service update riesce → la richiesta diventa approved, notifica creata", async () => {
    const serviceUpdates: Array<Record<string, unknown>> = [];
    const mrUpdates: Array<Record<string, unknown>> = [];
    const notificationInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(makeFakeAdmin({ mr: baseMr(), serviceUpdates, mrUpdates, notificationInserts }))
    );

    const res = await POST(makeRequest({ action: "approve" }), { params: Promise.resolve({ id: MR_ID }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(serviceUpdates).toHaveLength(1);
    expect(serviceUpdates[0]).toEqual({ pax: 3 });
    expect(mrUpdates).toHaveLength(1);
    expect(mrUpdates[0]!.status).toBe("approved");
    expect(notificationInserts).toHaveLength(1);
    expect(notificationInserts[0]!.type).toBe("modification_approved");
  });
});

describe("POST /api/ops/modification-requests/[id]/resolve — service update fallisce (fix P1)", () => {
  it("la richiesta NON diventa approved, risposta di errore, nessun side effect di approvazione", async () => {
    const serviceUpdates: Array<Record<string, unknown>> = [];
    const mrUpdates: Array<Record<string, unknown>> = [];
    const notificationInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(
        makeFakeAdmin({
          mr: baseMr(),
          serviceUpdateError: { message: "constraint violation" },
          serviceUpdates,
          mrUpdates,
          notificationInserts,
        })
      )
    );

    const res = await POST(makeRequest({ action: "approve" }), { params: Promise.resolve({ id: MR_ID }) });
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toMatch(/impossibile applicare le modifiche al servizio/i);
    // Il service update è stato tentato (e fallito), ma la modification
    // request non deve MAI essere aggiornata a "approved" in questo caso.
    expect(serviceUpdates).toHaveLength(1);
    expect(mrUpdates).toHaveLength(0);
    expect(notificationInserts).toHaveLength(0);
    expect(mocks.recordServiceAuditEvent).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});

describe("POST /api/ops/modification-requests/[id]/resolve — update della modification request fallisce dopo un service update riuscito", () => {
  it("nessuno stato falsamente 'approved' viene esposto in risposta; il service è già stato modificato (limite noto: serve atomicità DB per chiudere anche questo caso)", async () => {
    const serviceUpdates: Array<Record<string, unknown>> = [];
    const mrUpdates: Array<Record<string, unknown>> = [];
    const notificationInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(
        makeFakeAdmin({
          mr: baseMr(),
          mrUpdateError: { message: "connection reset" },
          serviceUpdates,
          mrUpdates,
          notificationInserts,
        })
      )
    );

    const res = await POST(makeRequest({ action: "approve" }), { params: Promise.resolve({ id: MR_ID }) });
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toMatch(/impossibile registrare l'esito della richiesta/i);
    // Documenta il limite noto (Step 3 del task): il service update è già
    // stato applicato con successo prima che l'update della request fallisse
    // — senza una transazione/RPC atomica, questo scenario resta un residuo
    // di inconsistenza (service modificato, richiesta non passata ad
    // approved) che il solo fix applicativo non può eliminare del tutto.
    expect(serviceUpdates).toHaveLength(1);
    expect(mrUpdates).toHaveLength(1); // tentato, ma fallito (nessuna riga committata con status=approved)
    // Nessun side effect di "approvazione riuscita" deve comunque scattare.
    expect(notificationInserts).toHaveLength(0);
    expect(mocks.recordServiceAuditEvent).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});

describe("POST /api/ops/modification-requests/[id]/resolve — REJECT (nessuna regressione)", () => {
  it("rifiuta senza toccare services, notifica di rifiuto creata", async () => {
    const serviceUpdates: Array<Record<string, unknown>> = [];
    const mrUpdates: Array<Record<string, unknown>> = [];
    const notificationInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(makeFakeAdmin({ mr: baseMr(), serviceUpdates, mrUpdates, notificationInserts }))
    );

    const res = await POST(makeRequest({ action: "reject", notes: "date non disponibili" }), {
      params: Promise.resolve({ id: MR_ID }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(serviceUpdates).toHaveLength(0);
    expect(mrUpdates).toHaveLength(1);
    expect(mrUpdates[0]!.status).toBe("rejected");
    expect(notificationInserts[0]!.type).toBe("modification_rejected");
  });
});

describe("POST /api/ops/modification-requests/[id]/resolve — ruolo non autorizzato (invariato)", () => {
  it("propaga direttamente la risposta 403 di authorizePricingRequest", async () => {
    const forbidden = NextResponse.json({ error: "Non autorizzato." }, { status: 403 });
    mocks.authorizePricingRequest.mockResolvedValue(forbidden);

    const res = await POST(makeRequest({ action: "approve" }), { params: Promise.resolve({ id: MR_ID }) });

    expect(res.status).toBe(403);
  });
});

describe("POST /api/ops/modification-requests/[id]/resolve — cross-tenant (invariato)", () => {
  it("richiesta di un altro tenant → 404 Richiesta non trovata (nessun update tentato)", async () => {
    const serviceUpdates: Array<Record<string, unknown>> = [];
    const mrUpdates: Array<Record<string, unknown>> = [];
    const notificationInserts: Array<Record<string, unknown>> = [];
    // mr === null simula il filtro .eq("tenant_id", tenantId) che non trova
    // nulla per una richiesta appartenente a un tenant diverso.
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(makeFakeAdmin({ mr: null, serviceUpdates, mrUpdates, notificationInserts }))
    );

    const res = await POST(makeRequest({ action: "approve" }), { params: Promise.resolve({ id: MR_ID }) });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toMatch(/non trovata/i);
    expect(serviceUpdates).toHaveLength(0);
    expect(mrUpdates).toHaveLength(0);
  });

  it("richiesta già risolta (status non pending) → 409, nessun update tentato", async () => {
    const serviceUpdates: Array<Record<string, unknown>> = [];
    const mrUpdates: Array<Record<string, unknown>> = [];
    const notificationInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(
        makeFakeAdmin({ mr: baseMr({ status: "approved" }), serviceUpdates, mrUpdates, notificationInserts })
      )
    );

    const res = await POST(makeRequest({ action: "approve" }), { params: Promise.resolve({ id: MR_ID }) });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toMatch(/già risolta/i);
    expect(serviceUpdates).toHaveLength(0);
    expect(mrUpdates).toHaveLength(0);
  });
});
