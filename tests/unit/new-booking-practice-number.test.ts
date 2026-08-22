import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  resolveBookingPracticeNumber: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));

vi.mock("@/lib/server/booking-practice-number", () => ({
  resolveBookingPracticeNumber: mocks.resolveBookingPracticeNumber,
}));

import { POST } from "@/app/api/ops/new-booking/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOTEL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREATED_AT = "2026-08-22T10:00:00.000Z";

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    customer_first_name: "Angela",
    customer_last_name: "Sinisi",
    customer_phone: "3331234567",
    customer_email: "",
    pax: 3,
    hotel_id: HOTEL_ID,
    booking_service_kind: "transfer_port_hotel",
    arrival_date: "2026-08-25",
    arrival_time: "10:00",
    departure_date: "2026-08-28",
    departure_time: "16:00",
    notes: "",
    trip_leg: "outbound_only",
    ...overrides,
  };
}

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost:3010/api/ops/new-booking", { method: "POST", body: JSON.stringify(body) });
}

/**
 * Fake admin generico: qualunque tabella non esplicitamente gestita risponde
 * in modo permissivo/innocuo (mai un throw sincrono, che romperebbe le
 * chiamate "fire and forget" con .catch() nella route reale). Le insert su
 * "services" vengono sempre registrate in `serviceInserts`, cosi' i test
 * possono verificare SE e COSA e' stato scritto.
 */
function makeFakeAdmin(opts: { serviceInserts: Array<Record<string, unknown>>; dailyCount?: number }) {
  const genericBuilder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "gte", "lte", "in", "overlaps", "order", "limit", "ilike"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: null, error: null });
    b.single = async () => ({ data: null, error: null });
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
    b.insert = () => {
      const result = { data: null, error: null };
      const chainable: Record<string, unknown> = { select: () => ({ single: async () => result }) };
      chainable.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
      return chainable;
    };
    b.update = () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) });
    return b;
  };

  const servicesBuilder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "gte", "lte", "in", "overlaps", "order", "limit", "ilike"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: null, error: null }); // readServiceSnapshot: contenuto non rilevante per il flusso CREATED
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null, count: opts.dailyCount ?? 0 }).then(resolve, reject);
    b.insert = (payload: Record<string, unknown>) => {
      opts.serviceInserts.push(payload);
      const id = `svc-${opts.serviceInserts.length}`;
      const result = { data: { id, created_at: CREATED_AT }, error: null };
      return { select: () => ({ single: async () => result }) };
    };
    b.update = () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) });
    return b;
  };

  const hotelsBuilder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: { id: HOTEL_ID, name: "Hotel Test" }, error: null });
    return b;
  };

  const membershipsBuilder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: { full_name: "Mario Rossi" }, error: null });
    return b;
  };

  return {
    from(table: string) {
      if (table === "services") return servicesBuilder();
      if (table === "hotels") return hotelsBuilder();
      if (table === "memberships") return membershipsBuilder();
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

describe("POST /api/ops/new-booking — numero pratica OBBLIGATORIO", () => {
  beforeEach(() => vi.clearAllMocks());

  it("1. RPC numero pratica riuscita -> creazione consentita (200, id restituito)", async () => {
    mocks.resolveBookingPracticeNumber.mockResolvedValue("ITS-2026-1");
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({ serviceInserts })));

    const res = await POST(makeRequest(basePayload()));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.id).toBeDefined();
  });

  it("2. RPC numero pratica fallita (null) -> NESSUN insert su services", async () => {
    mocks.resolveBookingPracticeNumber.mockResolvedValue(null);
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({ serviceInserts })));

    await POST(makeRequest(basePayload()));

    expect(serviceInserts.length).toBe(0);
  });

  it("3. RPC numero pratica fallita -> nessuna response di successo (ok=false, status 500, nessun id)", async () => {
    mocks.resolveBookingPracticeNumber.mockResolvedValue(null);
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({ serviceInserts: [] })));

    const res = await POST(makeRequest(basePayload()));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.ok).not.toBe(true);
    expect(json.id).toBeUndefined();
    expect(typeof json.error).toBe("string");
  });

  it("4. RPC numero pratica fallita -> mai una pratica con practice_number = null (nessun insert, quindi nessun record di alcun tipo)", async () => {
    mocks.resolveBookingPracticeNumber.mockResolvedValue(null);
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({ serviceInserts })));

    await POST(makeRequest(basePayload()));

    expect(serviceInserts.some((row) => row.practice_number === null)).toBe(false);
    expect(serviceInserts.length).toBe(0);
  });

  it("5. A/R (round_trip) -> entrambe le gambe ricevono lo STESSO practice_number", async () => {
    mocks.resolveBookingPracticeNumber.mockResolvedValue("ITS-2026-154");
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({ serviceInserts })));

    const res = await POST(makeRequest(basePayload({ trip_leg: "round_trip" })));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.id_return).toBeDefined();
    expect(serviceInserts.length).toBe(2);
    expect(serviceInserts[0]!.practice_number).toBe("ITS-2026-154");
    expect(serviceInserts[1]!.practice_number).toBe("ITS-2026-154");
    expect(json.booking.practice_number).toBe("ITS-2026-154");
  });

  it("6. one-way (outbound_only) -> una sola gamba, con il proprio practice_number valorizzato", async () => {
    mocks.resolveBookingPracticeNumber.mockResolvedValue("ITS-2026-7");
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({ serviceInserts })));

    const res = await POST(makeRequest(basePayload({ trip_leg: "outbound_only" })));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.id_return).toBeUndefined();
    expect(serviceInserts.length).toBe(1);
    expect(serviceInserts[0]!.practice_number).toBe("ITS-2026-7");
  });

  it("7. limite giornaliero servizi raggiunto -> 422 PRIMA della generazione del numero pratica (nessuna chiamata RPC)", async () => {
    mocks.resolveBookingPracticeNumber.mockResolvedValue("ITS-2026-99");
    const admin = makeFakeAdmin({ serviceInserts: [], dailyCount: 500 });
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(admin));

    const res = await POST(makeRequest(basePayload()));

    expect(res.status).toBe(422);
    expect(mocks.resolveBookingPracticeNumber).not.toHaveBeenCalled();
  });
});
