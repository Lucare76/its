import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Audit caso 26/010806 MATTIOLI ALESSANDRA — POST /api/pdf/claude-save-draft
 * non persisteva i campi operativi strutturati già disponibili nel parser
 * (arrival_date/time, departure_date/time, meeting_point, transport_code,
 * train_arrival_number/time, train_departure_number/time, service_type_code),
 * a differenza di app/api/email/inbox-approve/route.ts. Questi test coprono
 * la creazione (nessuna prenotazione esistente collegata all'email — qui è
 * sempre il ramo INSERT, non l'update_existing).
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

function mattioliForm(overrides: Partial<FormState> = {}): FormState {
  return {
    cliente_nome: "MATTIOLI ALESSANDRA",
    cliente_cellulare: "3331234567",
    n_pax: "1",
    hotel: "HOTEL DA VERIFICARE",
    data_arrivo: "2026-09-01",
    orario_arrivo: "12:53",
    data_partenza: "2026-09-06",
    orario_partenza: "13:20",
    tipo_servizio: "transfer_station_hotel",
    treno_andata: "ITA 9998",
    treno_ritorno: "ITA 9940",
    citta_partenza: "ROMA TERMINI",
    totale_pratica: "0",
    note: "HOTEL PICKUP ORE 08:00",
    numero_pratica: "26/010806",
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

describe("POST /api/pdf/claude-save-draft — campi operativi strutturati (audit MATTIOLI 26/010806)", () => {
  it("1. transfer_station_hotel (treno/hotel): valorizza tutte le colonne strutturate", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(makeFakeAdmin({ serviceInserts, hotelsSeed: [] }))
    );

    const res = await POST(makeRequest({ form: mattioliForm(), agency: "Aleste Viaggi" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(serviceInserts).toHaveLength(1);
    const row = serviceInserts[0]!;

    expect(row.arrival_date).toBe("2026-09-01");
    expect(row.arrival_time).toBe("12:53");
    expect(row.departure_date).toBe("2026-09-06");
    expect(row.departure_time).toBe("13:20");
    expect(row.meeting_point).toBe("ROMA TERMINI");
    expect(row.transport_code).toBe("ITA 9998 / ITA 9940");
    expect(row.train_arrival_number).toBe("ITA 9998");
    expect(row.train_arrival_time).toBe("12:53");
    expect(row.train_departure_number).toBe("ITA 9940");
    expect(row.train_departure_time).toBe("13:20");
    expect(row.service_type_code).toBe("transfer_station_hotel");

    // notes contiene ancora il marker pratica (fonte del practice_number in
    // lettura, vedi GET /api/ops/services/[id]) e il testo pickup hotel non
    // spostato altrove: nessuna funzione di dominio esiste per estrarlo, non
    // introduciamo un parser regex parallelo.
    expect(row.notes).toContain("[practice:26/010806]");
    expect(row.notes).toContain("HOTEL PICKUP ORE 08:00");
  });

  it("2. nessuna regressione sui campi legacy (date/time/outbound_time/return_time/vessel/notes)", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(makeFakeAdmin({ serviceInserts, hotelsSeed: [] }))
    );

    const res = await POST(makeRequest({ form: mattioliForm(), agency: "Aleste Viaggi" }));
    expect(res.status).toBe(200);
    const row = serviceInserts[0]!;

    expect(row.date).toBe("2026-09-01");
    expect(row.time).toBe("12:53");
    expect(row.outbound_time).toBe("12:53");
    expect(row.return_time).toBe("13:20");
    expect(row.vessel).toBe("ROMA TERMINI");
    expect(typeof row.notes).toBe("string");
    expect((row.notes as string).length).toBeGreaterThan(0);
  });

  it("3. bus_city_hotel: continua a funzionare (service_type_code=bus_line, nessun campo treno)", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(makeFakeAdmin({ serviceInserts, hotelsSeed: [] }))
    );

    const res = await POST(
      makeRequest({
        form: mattioliForm({
          tipo_servizio: "bus_city_hotel",
          citta_partenza: "TORINO CENTRO CITTA SCONOSCIUTA",
          treno_andata: "",
          treno_ritorno: "",
        }),
        agency: "Aleste Viaggi",
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    const row = serviceInserts[0]!;
    expect(row.service_type_code).toBe("bus_line");
    expect(row.train_arrival_number).toBeNull();
    expect(row.train_departure_number).toBeNull();
    expect(row.booking_service_kind).toBe("bus_city_hotel");
  });

  it("4. transfer_port_hotel: applyPickupCalc riusato (parità con inbox-approve), nessuna regex nuova", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(makeFakeAdmin({ serviceInserts, hotelsSeed: [] }))
    );

    const res = await POST(
      makeRequest({
        form: mattioliForm({
          tipo_servizio: "transfer_port_hotel",
          treno_andata: "MEDMAR",
          treno_ritorno: "MEDMAR",
        }),
        agency: "Aleste Viaggi",
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    const row = serviceInserts[0]!;
    expect(row.service_type_code).toBe("transfer_port_hotel");
    // Zona hotel non disponibile nel mock -> pickup_alert esplicito (stesso
    // comportamento fail-safe di applyPickupCalc usato da inbox-approve).
    expect(row.pickup_alert).toEqual(expect.any(String));
  });
});
