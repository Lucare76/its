import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * PARTE 3 (audit 26/010806): la risposta 409 di POST /api/pdf/claude-save-draft
 * include ora incoming_ferry_meta — una preview canonica della connessione
 * marittima della NUOVA prenotazione, calcolata server-side con lo stesso
 * helper di GET /api/ops/services/[id] (lib/server/ferry-connection-lookup.ts).
 * Nessuna logica di dominio nel client: qui testiamo solo che la route la
 * calcoli e la includa, riusando la stessa fonte canonica.
 */

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  auditLog: vi.fn(),
  buildDuplicateProbe: vi.fn((probe: unknown) => probe),
  lookupBookingDuplicates: vi.fn(),
  hydrateDuplicateMatches: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));

vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: mocks.auditLog,
  auditLogAwaited: vi.fn(),
}));

vi.mock("@/lib/server/agency-pdf-import", () => ({
  buildDuplicateProbe: mocks.buildDuplicateProbe,
  lookupBookingDuplicates: mocks.lookupBookingDuplicates,
  hydrateDuplicateMatches: mocks.hydrateDuplicateMatches,
}));

import { POST } from "@/app/api/pdf/claude-save-draft/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function mattioliForm(overrides: Record<string, unknown> = {}) {
  return {
    cliente_nome: "MATTIOLI ALESSANDRA",
    cliente_cellulare: "3475489819",
    n_pax: "3",
    hotel: "VILLA TERESA",
    data_arrivo: "2026-09-01",
    orario_arrivo: "12:53",
    data_partenza: "2026-09-06",
    orario_partenza: "13:20",
    tipo_servizio: "transfer_station_hotel",
    treno_andata: "ITA 9998",
    treno_ritorno: "ITA 9940",
    citta_partenza: "ROMA TERMINI",
    totale_pratica: "168",
    note: "",
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

const MEDMAR_RULE = {
  agency_logic: "aleste", transport_type: "train", direction: "from_ischia", boat_type: "traghetto",
  hotel_id: null, zone: "forio", transport_from: "13:20", transport_to: "16:30",
  company: "medmar", departure_time: "10:10", embark_port: "casamicciola", arrival_port: "pozzuoli",
  arrival_time: null, pickup_time: "08:30", valid_from: null, valid_to: null, days_of_week: null,
};
const ALILAURO_SCHEDULE = {
  id: "sched-alilauro-1320", company: "alilauro", departure_port: "ischia_porto", arrival_port: "napoli_beverello",
  departure_time: "13:20:00", arrival_time: "14:05:00", direction: "ischia_to_mainland",
  days_of_week: null, valid_from: null, valid_to: null,
};

function makeFakeAdmin() {
  const readOnly = (data: unknown[], singleData: unknown = null) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit", "ilike", "in", "neq"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: singleData, error: null });
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data, error: null }).then(resolve, reject);
    return b;
  };
  return {
    from(table: string) {
      if (table === "ferry_pickup_rules") return readOnly([MEDMAR_RULE]);
      if (table === "ferry_schedules") return readOnly([ALILAURO_SCHEDULE]);
      if (table === "hotels") return readOnly([], { zone: "forio" });
      return readOnly([]);
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

describe("POST /api/pdf/claude-save-draft — incoming_ferry_meta nella risposta 409 (audit MATTIOLI 26/010806)", () => {
  it("5. duplicato rilevato -> risposta 409 include incoming_ferry_meta calcolato con lo stesso helper canonico (MEDMAR, non ALILAURO)", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin()));
    mocks.lookupBookingDuplicates.mockResolvedValue({
      certain_service_id: null,
      matches: [{ service_id: "svc-existing-1", match_reason: "practice_number" }],
    });
    mocks.hydrateDuplicateMatches.mockResolvedValue([
      { service_id: "svc-existing-1", hotel_id: "hotel-villa-teresa", customer_name: "MATTIOLI ALESSANDRA" },
    ]);

    const res = await POST(makeRequest({ form: mattioliForm(), agency: "Aleste Viaggi" }));
    expect(res.status).toBe(409);
    const json = await res.json();

    expect(json.duplicate).toBe(true);
    expect(json.incoming_ferry_meta).toBeDefined();
    expect(json.incoming_ferry_meta.return).not.toBeNull();
    expect(json.incoming_ferry_meta.return.company).toBe("MEDMAR");
    expect(json.incoming_ferry_meta.return.company).not.toBe("ALILAURO");
  });

  it("nessuna regola canonica -> incoming_ferry_meta.return è null (undetermined), mai un valore inventato", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext({
        from(table: string) {
          const readOnly = (data: unknown[], singleData: unknown = null) => {
            const b: Record<string, unknown> = {};
            for (const m of ["select", "eq", "order", "limit", "ilike", "in", "neq"]) b[m] = () => b;
            b.maybeSingle = async () => ({ data: singleData, error: null });
            b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve);
            return b;
          };
          if (table === "ferry_pickup_rules") return readOnly([]); // nessuna regola
          if (table === "ferry_schedules") return readOnly([ALILAURO_SCHEDULE]);
          if (table === "hotels") return readOnly([], { zone: "forio" });
          return readOnly([]);
        },
      })
    );
    mocks.lookupBookingDuplicates.mockResolvedValue({
      certain_service_id: null,
      matches: [{ service_id: "svc-existing-1", match_reason: "practice_number" }],
    });
    mocks.hydrateDuplicateMatches.mockResolvedValue([
      { service_id: "svc-existing-1", hotel_id: "hotel-villa-teresa", customer_name: "MATTIOLI ALESSANDRA" },
    ]);

    const res = await POST(makeRequest({ form: mattioliForm(), agency: "Aleste Viaggi" }));
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.incoming_ferry_meta.return).toBeNull();
  });
});
