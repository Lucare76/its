import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Parità audit canale PDF ↔ canale email per la risoluzione duplicati.
 *
 * Il flusso email (app/api/email/inbox-approve) scrive già
 *   event: "inbox_duplicate_resolution", outcome: "create_new"
 * quando l'operatore sceglie "Aggiungi come nuova" su un possibile duplicato.
 * Questo test verifica che POST /api/pdf/claude-save-draft faccia lo stesso
 * (stesso sistema audit, `channel: "pdf_upload"`), creando comunque il nuovo
 * service.
 */

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));

vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: mocks.auditLog,
  auditLogAwaited: vi.fn(),
}));

import { POST } from "@/app/api/pdf/claude-save-draft/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type FormState = {
  cliente_nome: string;
  cliente_cellulare: string;
  n_pax: string;
  hotel: string;
  data_arrivo: string;
  orario_arrivo: string;
  data_partenza: string;
  orario_partenza: string;
  tipo_servizio: string;
  treno_andata: string;
  treno_ritorno: string;
  citta_partenza: string;
  totale_pratica: string;
  note: string;
  numero_pratica: string;
  agenzia: string;
};

function mariottiForm(overrides: Partial<FormState> = {}): FormState {
  return {
    cliente_nome: "MARIOTTI SERENA",
    cliente_cellulare: "3289126048",
    n_pax: "2",
    hotel: "ISOLA VERDE HOTEL & THERMAL SPA",
    data_arrivo: "2026-09-06",
    orario_arrivo: "12:38",
    data_partenza: "2026-09-13",
    orario_partenza: "13:18",
    tipo_servizio: "transfer_station_hotel",
    treno_andata: "ITA 8903",
    treno_ritorno: "ITA 9940",
    citta_partenza: "FIRENZE",
    totale_pratica: "112.00",
    note: "",
    numero_pratica: "26/011405",
    agenzia: "Aleste Viaggi",
    ...overrides,
  };
}

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost:3010/api/pdf/claude-save-draft", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function makeFakeAdmin(opts: {
  serviceInserts: Array<Record<string, unknown>>;
  hotelsSeed?: Array<{ id: string; name: string }>;
}) {
  const genericBuilder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit", "ilike", "in", "neq"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: null, error: null });
    b.single = async () => ({ data: null, error: null });
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve, reject);
    b.update = () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) });
    b.insert = () => ({ select: () => ({ single: async () => ({ data: { id: "generic-1" }, error: null }) }) });
    return b;
  };

  const servicesBuilder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit", "ilike", "in"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: null, error: null });
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve, reject);
    b.update = () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) });
    b.insert = (payload: Record<string, unknown>) => {
      opts.serviceInserts.push(payload);
      return { select: () => ({ single: async () => ({ data: { id: "svc-new-1" }, error: null }) }) };
    };
    return b;
  };

  const inboundBuilder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) b[m] = () => b;
    b.single = async () => ({ data: { id: "inbound-1", parsed_json: {} }, error: null });
    b.maybeSingle = async () => ({ data: { id: "inbound-1", parsed_json: {} }, error: null });
    b.insert = () => ({ select: () => ({ single: async () => ({ data: { id: "inbound-1" }, error: null }) }) });
    b.update = () => ({ eq: () => Promise.resolve({ error: null }) });
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve, reject);
    return b;
  };

  const hotelsBuilder = (): Record<string, unknown> => {
    const seed = opts.hotelsSeed ?? [];
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.limit = () => b;
    b.maybeSingle = async () => ({ data: null, error: null });
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: seed, error: null }).then(resolve, reject);
    b.insert = () => ({ select: () => ({ single: async () => ({ data: { id: "hotel-new" }, error: null }) }) });
    return b;
  };

  const aliasesBuilder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "limit"]) b[m] = () => b;
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve, reject);
    b.insert = () => Promise.resolve({ data: null, error: null });
    return b;
  };

  return {
    from(table: string) {
      if (table === "services") return servicesBuilder();
      if (table === "inbound_emails") return inboundBuilder();
      if (table === "hotels") return hotelsBuilder();
      if (table === "hotel_aliases") return aliasesBuilder();
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
});

describe("POST /api/pdf/claude-save-draft — audit 'Aggiungi come nuova' (parità con inbox-approve)", () => {
  it("action:create_new su possibile duplicato: crea il nuovo service ED emette l'audit inbox_duplicate_resolution/create_new con channel pdf_upload", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(
        makeFakeAdmin({
          serviceInserts,
          hotelsSeed: [{ id: "hotel-1", name: "ISOLA VERDE HOTEL & THERMAL SPA" }],
        })
      )
    );

    const res = await POST(
      makeRequest({
        form: mariottiForm(),
        agency: "Aleste Viaggi",
        action: "create_new",
        existing_service_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      })
    );
    const json = await res.json();

    // 1+3. nuovo service creato
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(serviceInserts).toHaveLength(1);
    expect(json.draft_service_id).toBe("svc-new-1");

    // 4. audit emesso esattamente una volta, sistema esistente, valori attesi
    const dupCalls = mocks.auditLog.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((p) => p.event === "inbox_duplicate_resolution");
    expect(dupCalls).toHaveLength(1);
    const payload = dupCalls[0]!;
    expect(payload.outcome).toBe("create_new");
    expect(payload.duplicate).toBe(true);
    expect(payload.serviceId).toBe("svc-new-1");
    expect(payload.details).toMatchObject({
      channel: "pdf_upload",
      existing_service_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });
  });

  it("force:true (alias): stesso audit create_new/pdf_upload", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(
        makeFakeAdmin({
          serviceInserts,
          hotelsSeed: [{ id: "hotel-1", name: "ISOLA VERDE HOTEL & THERMAL SPA" }],
        })
      )
    );

    const res = await POST(makeRequest({ form: mariottiForm(), agency: "Aleste Viaggi", force: true }));
    await res.json();

    expect(res.status).toBe(200);
    expect(serviceInserts).toHaveLength(1);
    const dupCalls = mocks.auditLog.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((p) => p.event === "inbox_duplicate_resolution" && p.outcome === "create_new");
    expect(dupCalls).toHaveLength(1);
    expect(dupCalls[0]!.details).toMatchObject({ channel: "pdf_upload", existing_service_id: null });
  });

  it("salvataggio normale (senza force/action): NESSUN audit inbox_duplicate_resolution", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(
        makeFakeAdmin({
          serviceInserts,
          hotelsSeed: [{ id: "hotel-1", name: "ISOLA VERDE HOTEL & THERMAL SPA" }],
        })
      )
    );

    const res = await POST(makeRequest({ form: mariottiForm(), agency: "Aleste Viaggi" }));
    expect(res.status).toBe(200);
    expect(serviceInserts).toHaveLength(1);
    const dupCalls = mocks.auditLog.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((p) => p.event === "inbox_duplicate_resolution");
    expect(dupCalls).toHaveLength(0);
  });
});
