import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Audit caso 26/010806 MATTIOLI ALESSANDRA — GET /api/ops/services/[id]
 * restituiva un set troppo ridotto di campi (la pratica appariva "vuota"
 * anche quando il record aveva già dati operativi reali) e sovrascriveva
 * sempre arrival_time con l'orario "indicativo" da ferry_schedules, anche
 * quando il dato reale strutturato era già presente. Questi test coprono:
 *  - i campi strutturati aggiunti al SELECT vengono restituiti as-is;
 *  - quando i campi strutturati sono NULL, un read-model fallback (SOLO in
 *    risposta, mai scritto su DB) ricostruisce il valore dai legacy;
 *  - nessuna mutazione DB durante una GET.
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

import { GET } from "@/app/api/ops/services/[id]/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVICE_ID = "11111111-1111-4111-8111-111111111111";

function makeRequest(id: string) {
  return {
    request: new NextRequest(`http://localhost:3010/api/ops/services/${id}`, { method: "GET" }),
    params: Promise.resolve({ id }),
  };
}

/** Query builder generico per tabelle read-only (hotels/agencies/ferry_schedules/service_change_logs). */
function readOnlyListBuilder(data: unknown[] = []) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit", "or", "ilike", "in", "neq"]) b[m] = () => b;
  b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve({ data, error: null }).then(resolve, reject);
  b.insert = () => { throw new Error("unexpected write: insert su tabella read-only durante GET"); };
  b.update = () => { throw new Error("unexpected write: update su tabella read-only durante GET"); };
  b.delete = () => { throw new Error("unexpected write: delete su tabella read-only durante GET"); };
  return b;
}

/** services: distingue la riga da restituire in base all'id filtrato con .eq("id", ...). */
function servicesBuilder(rowsById: Map<string, Record<string, unknown>>) {
  let queriedId: string | null = null;
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = (field: string, value: string) => {
    if (field === "id") queriedId = value;
    return b;
  };
  b.maybeSingle = async () => ({ data: queriedId ? rowsById.get(queriedId) ?? null : null, error: null });
  b.insert = () => { throw new Error("unexpected write: insert su services durante GET"); };
  b.update = () => { throw new Error("unexpected write: update su services durante GET"); };
  b.delete = () => { throw new Error("unexpected write: delete su services durante GET"); };
  return b;
}

function makeAdmin(rowsById: Map<string, Record<string, unknown>>) {
  return {
    from(table: string) {
      if (table === "services") return servicesBuilder(rowsById);
      return readOnlyListBuilder([]);
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

function baseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SERVICE_ID,
    customer_name: "MATTIOLI ALESSANDRA",
    phone: "3331234567",
    pax: 1,
    date: "2026-09-01",
    time: "12:53",
    notes: null,
    hotel_id: null,
    agency_id: null,
    billing_party_name: "Aleste Viaggi",
    agency_quoted_price_cents: null,
    place_type: null,
    meeting_point: null,
    arrival_date: "2026-09-01",
    arrival_time: null,
    departure_date: "2026-09-06",
    departure_time: null,
    orario_barca: null,
    pickup_time: null,
    linked_service_id: null,
    transport_code: null,
    direction: "arrival",
    booking_service_kind: "transfer_train_hotel",
    service_type_code: "transfer_station_hotel",
    internal_notes: null,
    internal_notes_updated_at: null,
    internal_notes_updated_by: null,
    outbound_time: null,
    return_time: null,
    vessel: null,
    train_arrival_number: null,
    train_arrival_time: null,
    train_departure_number: null,
    train_departure_time: null,
    status: "new",
    is_draft: false,
    pickup_hotel: null,
    pickup_alert: null,
    bus_city_origin: null,
    practice_number: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/ops/services/[id] — campi strutturati + fallback read-model (audit MATTIOLI 26/010806)", () => {
  it("4. campi strutturati valorizzati -> restituiti as-is (nessuna sovrascrittura)", async () => {
    const row = baseRow({
      arrival_time: "12:53",
      departure_time: "13:20",
      meeting_point: "ROMA TERMINI",
      transport_code: "ITA 9998 / ITA 9940",
      train_arrival_number: "ITA 9998",
      train_arrival_time: "12:53",
      train_departure_number: "ITA 9940",
      train_departure_time: "13:20",
      notes: "[practice:26/010806] | HOTEL PICKUP ORE 08:00",
    });
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(makeAdmin(new Map([[SERVICE_ID, row]])))
    );

    const { request, params } = makeRequest(SERVICE_ID);
    const res = await GET(request, { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.service.arrival_time).toBe("12:53");
    expect(json.service.departure_time).toBe("13:20");
    expect(json.service.meeting_point).toBe("ROMA TERMINI");
    expect(json.service.transport_code).toBe("ITA 9998 / ITA 9940");
    expect(json.service.train_arrival_number).toBe("ITA 9998");
    expect(json.service.train_departure_number).toBe("ITA 9940");
    expect(json.service.status).toBe("new");
    expect(json.service.is_draft).toBe(false);
    expect(json.service.bus_city_origin).toBeNull();
    // practice_number: marker [practice:XXX] nelle notes ha priorità sulla
    // colonna practice_number (identificativo interno ITS-YYYY-N diverso).
    expect(json.service.practice_number).toBe("26/010806");
  });

  it("5. record legacy (campi strutturati NULL): fallback corretti in risposta, MAI scritti su DB", async () => {
    const row = baseRow({
      arrival_time: null,
      departure_time: null,
      meeting_point: null,
      transport_code: null,
      outbound_time: "12:53",
      return_time: "13:20",
      vessel: "ROMA TERMINI",
      notes: null,
    });
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(makeAdmin(new Map([[SERVICE_ID, row]])))
    );

    const { request, params } = makeRequest(SERVICE_ID);
    const res = await GET(request, { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.service.arrival_time).toBe("12:53");
    expect(json.service.departure_time).toBe("13:20");
    expect(json.service.meeting_point).toBe("ROMA TERMINI");
    // practice_number: nessun marker in notes e colonna NULL -> null (non "—").
    expect(json.service.practice_number).toBeNull();
  });

  it("6. GET non muta il DB (nessuna insert/update/delete su services o tabelle correlate)", async () => {
    const row = baseRow();
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(makeAdmin(new Map([[SERVICE_ID, row]])))
    );

    const { request, params } = makeRequest(SERVICE_ID);
    const res = await GET(request, { params });
    // Se la route avesse tentato una scrittura, i builder mock avrebbero
    // lanciato — arrivare a 200 dimostra che nessuna write path è stata presa.
    expect(res.status).toBe(200);
  });
});
