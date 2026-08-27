import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

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

function makeFakeAdmin(opts: { serviceInserts: Array<Record<string, unknown>> }) {
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
    b.maybeSingle = async () => ({ data: null, error: null });
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
    b.insert = (payload: Record<string, unknown>) => {
      opts.serviceInserts.push(payload);
      const id = `svc-${opts.serviceInserts.length}`;
      const result = { data: { id, created_at: "2026-08-22T10:00:00.000Z" }, error: null };
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

const FORBIDDEN_PATTERNS = [/Formula/i, /Infant/i, /Bambini/i, /Adulti/i];

describe("POST /api/ops/new-booking — notes non contiene testo Formula/pax breakdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveBookingPracticeNumber.mockResolvedValue("ITS-2026-1");
  });

  it("Formula MEDMAR Napoli con pax breakdown -> notes resta vuota, breakdown solo in ferry_details", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({ serviceInserts })));

    await POST(makeRequest(basePayload({
      booking_service_kind: "formula_medmar_napoli",
      notes: "",
      medmar_infant_count: 1,
      medmar_child_count: 0,
      medmar_adult_count: 3,
    })));

    expect(serviceInserts.length).toBe(1);
    const notes = String(serviceInserts[0]!.notes ?? "");
    for (const pattern of FORBIDDEN_PATTERNS) expect(notes).not.toMatch(pattern);
    expect((serviceInserts[0]!.ferry_details as Record<string, unknown>).medmar_adult_count).toBe(3);
  });

  it("Formula MEDMAR Pozzuoli con pax breakdown -> notes resta vuota", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({ serviceInserts })));

    await POST(makeRequest(basePayload({
      booking_service_kind: "formula_medmar_pozzuoli",
      notes: "",
      medmar_infant_count: 0,
      medmar_child_count: 2,
      medmar_adult_count: 2,
    })));

    const notes = String(serviceInserts[0]!.notes ?? "");
    for (const pattern of FORBIDDEN_PATTERNS) expect(notes).not.toMatch(pattern);
  });

  it("Formula SNAV con pax breakdown -> notes resta vuota", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({ serviceInserts })));

    await POST(makeRequest(basePayload({
      booking_service_kind: "formula_snav",
      notes: "",
      medmar_infant_count: 0,
      medmar_child_count: 0,
      medmar_adult_count: 2,
    })));

    const notes = String(serviceInserts[0]!.notes ?? "");
    for (const pattern of FORBIDDEN_PATTERNS) expect(notes).not.toMatch(pattern);
  });

  it("nota libera scritta davvero dall'operatore viene preservata integralmente", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({ serviceInserts })));

    await POST(makeRequest(basePayload({
      booking_service_kind: "formula_medmar_napoli",
      notes: "Cliente su sedia a rotelle, avvisare autista",
      medmar_infant_count: 0,
      medmar_child_count: 0,
      medmar_adult_count: 2,
    })));

    expect(serviceInserts[0]!.notes).toBe("Cliente su sedia a rotelle, avvisare autista");
  });

  it("nota libera che contiene volutamente la parola 'Adulti' non viene censurata", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({ serviceInserts })));

    await POST(makeRequest(basePayload({
      booking_service_kind: "transfer_port_hotel",
      notes: "Gruppo di soli Adulti, nessun bagaglio extra",
    })));

    expect(serviceInserts[0]!.notes).toBe("Gruppo di soli Adulti, nessun bagaglio extra");
  });
});
