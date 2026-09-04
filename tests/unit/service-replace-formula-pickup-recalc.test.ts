import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * STEP B — POST /api/ops/services/[id]/replace deve ricalcolare pickup_hotel/
 * pickup_alert per Formula SNAV/MEDMAR diretta quando il FINAL state del
 * replacement (nuovo hotel, nuova agenzia, nuova data) cambia un input
 * pickup-relevant. Il resolver usa SEMPRE il replacement finale, mai i
 * valori del service precedente.
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

import { POST } from "@/app/api/ops/services/[id]/replace/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOTEL_FORIO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HOTEL_ISCHIA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const AGENCY_SOSANDRA = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const AGENCY_ALESTE = "ffffffff-ffff-4fff-8fff-ffffffffffff";

type DirectRuleOverrides = Partial<{
  id: string;
  agency_logic: "aleste" | "sosandra";
  company: "snav" | "medmar";
  hotel_id: string | null;
  zone: string | null;
  departure_time: string;
  pickup_time: string | null;
  embark_port: string | null;
  arrival_port: string;
  valid_from: string | null;
  valid_to: string | null;
  days_of_week: number[] | null;
}>;

function directRule(overrides: DirectRuleOverrides = {}) {
  return {
    id: overrides.id ?? "rule-1",
    agency_logic: overrides.agency_logic ?? "aleste",
    transport_type: "direct",
    direction: "from_ischia",
    boat_type: "aliscafo",
    hotel_id: overrides.hotel_id ?? null,
    zone: overrides.zone ?? "ischia",
    transport_from: null,
    transport_to: null,
    company: overrides.company ?? "snav",
    departure_time: overrides.departure_time ?? "07:10",
    embark_port: overrides.embark_port ?? "casamicciola",
    arrival_port: overrides.arrival_port ?? "napoli_beverello",
    arrival_time: null,
    pickup_time: overrides.pickup_time === undefined ? "06:30" : overrides.pickup_time,
    valid_from: overrides.valid_from ?? null,
    valid_to: overrides.valid_to ?? null,
    days_of_week: overrides.days_of_week ?? null,
  };
}

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    customer_last_name: "Rossi",
    customer_phone: "+39 333 9876543",
    pax: 2,
    hotel_id: HOTEL_ISCHIA,
    arrival_date: "2026-08-25",
    arrival_time: "10:00",
    departure_date: "2026-08-27",
    departure_time: "17:00",
    notes: "",
    ...overrides,
  };
}

function makeRequest(id: string, body: unknown) {
  return {
    request: new NextRequest(`http://localhost:3010/api/ops/services/${id}/replace`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    params: Promise.resolve({ id }),
  };
}

function makeServicesStore(rows: Record<string, Record<string, unknown>>) {
  const store = new Map<string, Record<string, unknown>>(
    Object.entries(rows).map(([id, row]) => [id, { ...row, id }])
  );
  const updateCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];
  return { store, updateCalls };
}

function servicesBuilder(services: ReturnType<typeof makeServicesStore>): Record<string, unknown> {
  let mode: "select" | "update" | null = null;
  let patch: Record<string, unknown> | null = null;
  let filterId: string | undefined;
  const b: Record<string, unknown> = {};
  b.select = () => { mode = "select"; return b; };
  b.update = (p: Record<string, unknown>) => { mode = "update"; patch = p; return b; };
  b.eq = (col: string, value: string) => { if (col === "id") filterId = value; return b; };
  b.maybeSingle = async () => {
    if (mode === "select" && filterId) {
      const row = services.store.get(filterId);
      return { data: row ? { ...row } : null, error: null };
    }
    return { data: null, error: null };
  };
  b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
    if (mode === "update" && filterId && patch) {
      const existing = services.store.get(filterId) ?? { id: filterId };
      services.store.set(filterId, { ...existing, ...patch });
      services.updateCalls.push({ id: filterId, patch });
    }
    return Promise.resolve({ data: null, error: null }).then(resolve, reject);
  };
  return b;
}

function ferryRulesBuilder(rules: Array<Record<string, unknown>>, counter: { count: number }) {
  const b: Record<string, unknown> = {};
  b.select = () => { counter.count += 1; return b; };
  b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve({ data: rules, error: null }).then(resolve, reject);
  return b;
}

function ferrySchedulesBuilder(schedules: Array<Record<string, unknown>>) {
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve({ data: schedules, error: null }).then(resolve, reject);
  return b;
}

function hotelsBuilder(hotelById: Record<string, { name: string; zone: string | null }>) {
  let requestedId: string | undefined;
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = (col: string, value: string) => { if (col === "id") requestedId = value; return b; };
  b.maybeSingle = async () => ({
    data: requestedId && hotelById[requestedId] ? { id: requestedId, ...hotelById[requestedId] } : null,
    error: null,
  });
  return b;
}

function agenciesBuilder(agencyById: Record<string, { name: string }>) {
  let requestedId: string | undefined;
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = (col: string, value: string) => { if (col === "id") requestedId = value; return b; };
  b.maybeSingle = async () => ({
    data: requestedId && agencyById[requestedId] ? { name: agencyById[requestedId].name } : null,
    error: null,
  });
  return b;
}

function genericBuilder() {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit", "or", "neq", "in", "ilike"]) b[m] = () => b;
  b.maybeSingle = async () => ({ data: null, error: null });
  b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(resolve, reject);
  return b;
}

function makeFakeAdmin(opts: {
  services: ReturnType<typeof makeServicesStore>;
  directRules?: Array<Record<string, unknown>>;
  ferrySchedules?: Array<Record<string, unknown>>;
  hotelById?: Record<string, { name: string; zone: string | null }>;
  agencyById?: Record<string, { name: string }>;
  ferryRulesCallCounter?: { count: number };
}) {
  const directRules = opts.directRules ?? [];
  const ferrySchedules = opts.ferrySchedules ?? [];
  const hotelById = opts.hotelById ?? {};
  const agencyById = opts.agencyById ?? {};
  const counter = opts.ferryRulesCallCounter ?? { count: 0 };
  return {
    from(table: string) {
      if (table === "services") return servicesBuilder(opts.services);
      if (table === "ferry_pickup_rules") return ferryRulesBuilder(directRules, counter);
      if (table === "ferry_schedules") return ferrySchedulesBuilder(ferrySchedules);
      if (table === "hotels") return hotelsBuilder(hotelById);
      if (table === "agencies") return agenciesBuilder(agencyById);
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

describe("POST /api/ops/services/[id]/replace — ricalcolo pickup Formula direct (Step B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // A. replacement Formula con hotel diverso -> pickup corretto
  it("A. replacement con nuovo hotel (Forio -> Ischia) ricalcola pickup_hotel", async () => {
    const services = makeServicesStore({
      "svc-1": {
        tenant_id: TENANT,
        status: "new",
        booking_service_kind: "formula_medmar_napoli",
        direction: "departure",
        hotel_id: HOTEL_FORIO,
        agency_id: null,
        billing_party_name: "Aleste Turismo",
        orario_barca: "17:00",
        departure_date: "2026-08-27",
        departure_time: "17:00",
        date: "2026-08-27",
        pickup_hotel: "15:15",
        pickup_alert: null,
      },
    });
    const directRules = [
      directRule({ id: "forio", company: "medmar", zone: "forio", departure_time: "17:00", pickup_time: "15:15", embark_port: "ischia_porto", arrival_port: "napoli_beverello" }),
      directRule({ id: "ischia", company: "medmar", zone: "ischia", departure_time: "17:00", pickup_time: "15:30", embark_port: "ischia_porto", arrival_port: "napoli_beverello" }),
    ];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({
      services, directRules,
      hotelById: { [HOTEL_FORIO]: { name: "Hotel Forio", zone: "forio" }, [HOTEL_ISCHIA]: { name: "Hotel Ischia", zone: "ischia" } },
    })));

    const { request, params } = makeRequest("svc-1", basePayload({ hotel_id: HOTEL_ISCHIA, departure_time: "17:00" }));
    const res = await POST(request, { params });
    expect(res.status).toBe(200);

    const call = services.updateCalls.find((c) => c.id === "svc-1");
    expect(call?.patch.pickup_hotel).toBe("15:30");
  });

  // B. replacement con agency diversa -> agency_logic corretta
  it("B. replacement con nuova agenzia (Sosandra -> Aleste) applica la direct rule corretta", async () => {
    const services = makeServicesStore({
      "svc-1": {
        tenant_id: TENANT,
        status: "new",
        booking_service_kind: "formula_snav",
        direction: "departure",
        hotel_id: HOTEL_ISCHIA,
        agency_id: AGENCY_SOSANDRA,
        billing_party_name: "Sosandra Viaggi",
        orario_barca: "07:10",
        departure_date: "2026-08-27",
        departure_time: "07:10",
        date: "2026-08-27",
        pickup_hotel: "06:25",
        pickup_alert: null,
      },
    });
    const directRules = [
      directRule({ id: "aleste", company: "snav", zone: "ischia", departure_time: "07:10", pickup_time: "06:30", agency_logic: "aleste" }),
      directRule({ id: "sosandra", company: "snav", zone: "ischia", departure_time: "07:10", pickup_time: "06:25", agency_logic: "sosandra" }),
    ];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({
      services, directRules,
      hotelById: { [HOTEL_ISCHIA]: { name: "Hotel Ischia", zone: "ischia" } },
      agencyById: { [AGENCY_ALESTE]: { name: "Aleste Turismo" } },
    })));

    const { request, params } = makeRequest("svc-1", basePayload({
      hotel_id: HOTEL_ISCHIA, departure_time: "07:10", agency_id: AGENCY_ALESTE,
    }));
    await POST(request, { params });

    const call = services.updateCalls.find((c) => c.id === "svc-1");
    expect(call?.patch.agency_id).toBe(AGENCY_ALESTE);
    expect(call?.patch.pickup_hotel).toBe("06:30");
  });

  // C. replacement senza cambi pickup-relevant -> nessun calcolo inutile
  it("C. replacement identico su hotel/agenzia/data/orario non ricalcola e non interroga ferry_pickup_rules", async () => {
    const services = makeServicesStore({
      "svc-1": {
        tenant_id: TENANT,
        status: "new",
        booking_service_kind: "formula_medmar_napoli",
        direction: "departure",
        hotel_id: HOTEL_ISCHIA,
        agency_id: null,
        billing_party_name: "Aleste Turismo",
        orario_barca: "17:00",
        departure_date: "2026-08-27",
        departure_time: "17:00",
        date: "2026-08-27",
        pickup_hotel: "15:30",
        pickup_alert: null,
      },
    });
    const counter = { count: 0 };
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({
      services, directRules: [], ferryRulesCallCounter: counter,
      hotelById: { [HOTEL_ISCHIA]: { name: "Hotel Ischia", zone: "ischia" } },
    })));

    // Stesso hotel, stessa data/orario di partenza, solo pax/telefono/nome cambiano.
    const { request, params } = makeRequest("svc-1", basePayload({
      hotel_id: HOTEL_ISCHIA, departure_date: "2026-08-27", departure_time: "17:00",
      pax: 3, customer_phone: "+39 333 1112223", customer_last_name: "Verdi",
    }));
    await POST(request, { params });

    const call = services.updateCalls.find((c) => c.id === "svc-1");
    expect("pickup_hotel" in (call?.patch ?? {})).toBe(false);
    expect(counter.count).toBe(0);
  });
});
