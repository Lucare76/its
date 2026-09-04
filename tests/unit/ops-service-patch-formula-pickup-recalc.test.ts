import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * STEP B — PATCH /api/ops/services/[id] deve ricalcolare pickup_hotel/
 * pickup_alert per Formula SNAV/MEDMAR diretta (formula_snav,
 * formula_medmar_napoli, formula_medmar_pozzuoli) quando un edit cambia un
 * input pickup-relevant (hotel, agenzia, orario_barca, data partenza) sulla
 * riga direction=departure — sia direttamente, sia sulla gamba collegata
 * (linked_service_id) quando la propagazione esistente di arrival_date/
 * departure_date la tocca. Nessun ricalcolo per pax/notes/altri kind.
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

import { PATCH } from "@/app/api/ops/services/[id]/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOTEL_FORIO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HOTEL_ISCHIA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

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

function makeRequest(id: string, body: unknown) {
  return {
    request: new NextRequest(`http://localhost:3010/api/ops/services/${id}`, {
      method: "PATCH",
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

function genericBuilder() {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit", "or", "neq", "in", "ilike"]) b[m] = () => b;
  b.maybeSingle = async () => ({ data: null, error: null });
  b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(resolve, reject);
  // service_change_logs.insert(...) — la scrittura del log di audit non è
  // sotto test qui, serve solo a non far crashare logServiceChange.
  b.insert = () => {
    const chain: Record<string, unknown> = {};
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ error: null }).then(resolve, reject);
    return chain;
  };
  return b;
}

function makeFakeAdmin(opts: {
  services: ReturnType<typeof makeServicesStore>;
  directRules?: Array<Record<string, unknown>>;
  ferrySchedules?: Array<Record<string, unknown>>;
  hotelById?: Record<string, { name: string; zone: string | null }>;
  ferryRulesCallCounter?: { count: number };
}) {
  const directRules = opts.directRules ?? [];
  const ferrySchedules = opts.ferrySchedules ?? [];
  const hotelById = opts.hotelById ?? {};
  const counter = opts.ferryRulesCallCounter ?? { count: 0 };
  return {
    from(table: string) {
      if (table === "services") return servicesBuilder(opts.services);
      if (table === "ferry_pickup_rules") return ferryRulesBuilder(directRules, counter);
      if (table === "ferry_schedules") return ferrySchedulesBuilder(ferrySchedules);
      if (table === "hotels") return hotelsBuilder(hotelById);
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

describe("PATCH /api/ops/services/[id] — ricalcolo pickup Formula direct (Step B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // A. caso reale obbligatorio: Forio -> Ischia, MEDMAR Napoli 17:00, 15:15 -> 15:30
  it("A. cambio hotel da zona Forio a zona Ischia ricalcola pickup_hotel (15:15 -> 15:30)", async () => {
    const services = makeServicesStore({
      "svc-1": {
        tenant_id: TENANT,
        booking_service_kind: "formula_medmar_napoli",
        direction: "departure",
        hotel_id: HOTEL_FORIO,
        billing_party_name: "Aleste Turismo",
        orario_barca: "17:00",
        departure_date: "2026-08-27",
        departure_time: "17:00",
        date: "2026-08-27",
        pickup_hotel: "15:15",
        pickup_alert: null,
        linked_service_id: null,
      },
    });
    const directRules = [
      directRule({ id: "forio", company: "medmar", zone: "forio", departure_time: "17:00", pickup_time: "15:15", embark_port: "ischia_porto", arrival_port: "napoli_beverello" }),
      directRule({ id: "ischia", company: "medmar", zone: "ischia", departure_time: "17:00", pickup_time: "15:30", embark_port: "ischia_porto", arrival_port: "napoli_beverello" }),
    ];
    // Corsa reale corrispondente in ferry_schedules, altrimenti il resolver
    // aggiunge un warning "corsa configurata non disponibile" (comportamento
    // legittimo e indipendente da Step B) sopra al pickup_hotel calcolato.
    const ferrySchedules = [{
      company: "medmar", departure_port: "ischia_porto", arrival_port: "napoli_beverello",
      departure_time: "17:00", arrival_time: "18:00", direction: "ischia_to_mainland",
      days_of_week: null, valid_from: null, valid_to: null,
    }];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({
      services, directRules, ferrySchedules,
      hotelById: { [HOTEL_FORIO]: { name: "Hotel Forio", zone: "forio" }, [HOTEL_ISCHIA]: { name: "Hotel Ischia", zone: "ischia" } },
    })));

    const { request, params } = makeRequest("svc-1", { hotel_id: HOTEL_ISCHIA });
    const res = await PATCH(request, { params });
    expect(res.status).toBe(200);

    const call = services.updateCalls.find((c) => c.id === "svc-1");
    expect(call?.patch.pickup_hotel).toBe("15:30");
    expect(call?.patch.pickup_alert ?? null).toBeNull();
  });

  // B. SOSANDRA -> ALESTE su SNAV, stessa zona/orario -> nuova direct rule
  it("B. cambio agenzia SOSANDRA -> ALESTE applica la direct rule ALESTE", async () => {
    const services = makeServicesStore({
      "svc-1": {
        tenant_id: TENANT,
        booking_service_kind: "formula_snav",
        direction: "departure",
        hotel_id: HOTEL_ISCHIA,
        billing_party_name: "Sosandra Viaggi",
        orario_barca: "07:10",
        departure_date: "2026-08-27",
        departure_time: "07:10",
        date: "2026-08-27",
        pickup_hotel: "06:25",
        pickup_alert: null,
        linked_service_id: null,
      },
    });
    const directRules = [
      directRule({ id: "aleste", company: "snav", zone: "ischia", departure_time: "07:10", pickup_time: "06:30", agency_logic: "aleste" }),
      directRule({ id: "sosandra", company: "snav", zone: "ischia", departure_time: "07:10", pickup_time: "06:25", agency_logic: "sosandra" }),
    ];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({
      services, directRules, hotelById: { [HOTEL_ISCHIA]: { name: "Hotel Ischia", zone: "ischia" } },
    })));

    const { request, params } = makeRequest("svc-1", { billing_party_name: "Aleste Turismo" });
    await PATCH(request, { params });

    const call = services.updateCalls.find((c) => c.id === "svc-1");
    expect(call?.patch.pickup_hotel).toBe("06:30");
  });

  // C. orario_barca cambia -> nuovo pickup
  it("C. cambio orario_barca ricalcola pickup_hotel sulla nuova direct rule", async () => {
    const services = makeServicesStore({
      "svc-1": {
        tenant_id: TENANT,
        booking_service_kind: "formula_medmar_napoli",
        direction: "departure",
        hotel_id: HOTEL_ISCHIA,
        billing_party_name: "Aleste Turismo",
        orario_barca: "17:00",
        departure_date: "2026-08-27",
        departure_time: "17:00",
        date: "2026-08-27",
        pickup_hotel: "15:30",
        pickup_alert: null,
        linked_service_id: null,
      },
    });
    const directRules = [
      directRule({ id: "r1700", company: "medmar", zone: "ischia", departure_time: "17:00", pickup_time: "15:30" }),
      directRule({ id: "r1800", company: "medmar", zone: "ischia", departure_time: "18:00", pickup_time: "16:10" }),
    ];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({
      services, directRules, hotelById: { [HOTEL_ISCHIA]: { name: "Hotel Ischia", zone: "ischia" } },
    })));

    const { request, params } = makeRequest("svc-1", { orario_barca: "18:00" });
    await PATCH(request, { params });

    const call = services.updateCalls.find((c) => c.id === "svc-1");
    expect(call?.patch.pickup_hotel).toBe("16:10");
  });

  // D. data attraversa valid_from/valid_to -> regola corretta
  it("D. cambio data che attraversa valid_from/valid_to seleziona la regola corretta", async () => {
    const services = makeServicesStore({
      "svc-1": {
        tenant_id: TENANT,
        booking_service_kind: "formula_medmar_napoli",
        direction: "departure",
        hotel_id: HOTEL_ISCHIA,
        billing_party_name: "Aleste Turismo",
        orario_barca: "17:00",
        departure_date: "2026-08-27",
        departure_time: "17:00",
        date: "2026-08-27",
        pickup_hotel: "15:30",
        pickup_alert: null,
        linked_service_id: null,
      },
    });
    const directRules = [
      directRule({ id: "before", company: "medmar", zone: "ischia", departure_time: "17:00", pickup_time: "15:30", valid_to: "2026-08-31" }),
      directRule({ id: "after", company: "medmar", zone: "ischia", departure_time: "17:00", pickup_time: "15:45", valid_from: "2026-09-01" }),
    ];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({
      services, directRules, hotelById: { [HOTEL_ISCHIA]: { name: "Hotel Ischia", zone: "ischia" } },
    })));

    const { request, params } = makeRequest("svc-1", { departure_date: "2026-09-05" });
    await PATCH(request, { params });

    const call = services.updateCalls.find((c) => c.id === "svc-1");
    expect(call?.patch.pickup_hotel).toBe("15:45");
  });

  // E. DB context presente ma nessuna direct match per la nuova zona -> fallback statico
  it("E. nessuna direct rule per la nuova zona -> fallback statico invariato", async () => {
    const services = makeServicesStore({
      "svc-1": {
        tenant_id: TENANT,
        booking_service_kind: "formula_snav",
        direction: "departure",
        hotel_id: HOTEL_FORIO,
        billing_party_name: "Aleste Turismo",
        orario_barca: "07:10",
        departure_date: "2026-08-27",
        departure_time: "07:10",
        date: "2026-08-27",
        pickup_hotel: "06:20",
        pickup_alert: null,
        linked_service_id: null,
      },
    });
    // Solo la regola per zona forio esiste: dopo lo spostamento in zona ischia
    // nessuna direct rule matcha -> deve cadere sul fallback statico reale
    // (SNAV zona ischia 07:10 -> 06:30, lib/departure-pickup-rules.ts).
    const directRules = [
      directRule({ id: "forio", company: "snav", zone: "forio", departure_time: "07:10", pickup_time: "06:20" }),
    ];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({
      services, directRules,
      hotelById: { [HOTEL_FORIO]: { name: "Hotel Forio", zone: "forio" }, [HOTEL_ISCHIA]: { name: "Hotel Ischia", zone: "ischia" } },
    })));

    const { request, params } = makeRequest("svc-1", { hotel_id: HOTEL_ISCHIA });
    await PATCH(request, { params });

    const call = services.updateCalls.find((c) => c.id === "svc-1");
    expect(call?.patch.pickup_hotel).toBe("06:30");
  });

  // F. solo pax -> pickup invariato, nessuna query ferry_pickup_rules
  it("F. cambio solo pax non ricalcola pickup e non interroga ferry_pickup_rules", async () => {
    const services = makeServicesStore({
      "svc-1": {
        tenant_id: TENANT,
        booking_service_kind: "formula_medmar_napoli",
        direction: "departure",
        hotel_id: HOTEL_ISCHIA,
        billing_party_name: "Aleste Turismo",
        orario_barca: "17:00",
        departure_date: "2026-08-27",
        departure_time: "17:00",
        date: "2026-08-27",
        pickup_hotel: "15:30",
        pickup_alert: null,
        linked_service_id: null,
      },
    });
    const counter = { count: 0 };
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({
      services, directRules: [], hotelById: { [HOTEL_ISCHIA]: { name: "Hotel Ischia", zone: "ischia" } }, ferryRulesCallCounter: counter,
    })));

    const { request, params } = makeRequest("svc-1", { pax: 4 });
    await PATCH(request, { params });

    const call = services.updateCalls.find((c) => c.id === "svc-1");
    expect(call?.patch.pax).toBe(4);
    expect("pickup_hotel" in (call?.patch ?? {})).toBe(false);
    expect(counter.count).toBe(0);
  });

  // G. solo notes -> pickup invariato
  it("G. cambio solo notes non ricalcola pickup", async () => {
    const services = makeServicesStore({
      "svc-1": {
        tenant_id: TENANT,
        booking_service_kind: "formula_medmar_napoli",
        direction: "departure",
        hotel_id: HOTEL_ISCHIA,
        billing_party_name: "Aleste Turismo",
        orario_barca: "17:00",
        departure_date: "2026-08-27",
        departure_time: "17:00",
        date: "2026-08-27",
        pickup_hotel: "15:30",
        pickup_alert: null,
        linked_service_id: null,
      },
    });
    const counter = { count: 0 };
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({
      services, directRules: [], hotelById: { [HOTEL_ISCHIA]: { name: "Hotel Ischia", zone: "ischia" } }, ferryRulesCallCounter: counter,
    })));

    const { request, params } = makeRequest("svc-1", { notes: "Cliente arriva in ritardo" });
    await PATCH(request, { params });

    const call = services.updateCalls.find((c) => c.id === "svc-1");
    expect("pickup_hotel" in (call?.patch ?? {})).toBe(false);
    expect(counter.count).toBe(0);
  });

  // H. linked Formula departure -> pickup ricalcolato sulla gamba collegata
  it("H. propagazione departure_date alla gamba collegata Formula direct ricalcola anche il suo pickup", async () => {
    const services = makeServicesStore({
      "svc-arrival": {
        tenant_id: TENANT,
        booking_service_kind: "formula_medmar_napoli",
        direction: "arrival",
        hotel_id: HOTEL_ISCHIA,
        arrival_date: "2026-08-25",
        date: "2026-08-25",
        linked_service_id: "svc-departure",
      },
      "svc-departure": {
        tenant_id: TENANT,
        booking_service_kind: "formula_medmar_napoli",
        direction: "departure",
        hotel_id: HOTEL_ISCHIA,
        billing_party_name: "Aleste Turismo",
        orario_barca: "17:00",
        departure_date: "2026-08-27",
        departure_time: "17:00",
        date: "2026-08-27",
        pickup_hotel: "15:30",
        pickup_alert: null,
        linked_service_id: "svc-arrival",
      },
    });
    const directRules = [
      directRule({ id: "before", company: "medmar", zone: "ischia", departure_time: "17:00", pickup_time: "15:30", valid_to: "2026-08-31" }),
      directRule({ id: "after", company: "medmar", zone: "ischia", departure_time: "17:00", pickup_time: "15:45", valid_from: "2026-09-01" }),
    ];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({
      services, directRules, hotelById: { [HOTEL_ISCHIA]: { name: "Hotel Ischia", zone: "ischia" } },
    })));

    const { request, params } = makeRequest("svc-arrival", { departure_date: "2026-09-05" });
    await PATCH(request, { params });

    const linkedCall = services.updateCalls.find((c) => c.id === "svc-departure");
    expect(linkedCall?.patch.departure_date).toBe("2026-09-05");
    expect(linkedCall?.patch.pickup_hotel).toBe("15:45");
  });

  // REGRESSION: transfer_train_hotel non viene toccato da Step B
  it("REGRESSION: transfer_train_hotel non attiva alcun ricalcolo pickup su cambio hotel", async () => {
    const services = makeServicesStore({
      "svc-1": {
        tenant_id: TENANT,
        booking_service_kind: "transfer_train_hotel",
        direction: "departure",
        hotel_id: HOTEL_FORIO,
        billing_party_name: "Aleste Turismo",
        departure_date: "2026-08-27",
        departure_time: "14:00",
        date: "2026-08-27",
        pickup_hotel: "11:00",
        pickup_alert: null,
        linked_service_id: null,
      },
    });
    const counter = { count: 0 };
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({
      services, directRules: [], hotelById: { [HOTEL_FORIO]: { name: "Hotel Forio", zone: "forio" }, [HOTEL_ISCHIA]: { name: "Hotel Ischia", zone: "ischia" } }, ferryRulesCallCounter: counter,
    })));

    const { request, params } = makeRequest("svc-1", { hotel_id: HOTEL_ISCHIA });
    await PATCH(request, { params });

    const call = services.updateCalls.find((c) => c.id === "svc-1");
    expect(call?.patch.hotel_id).toBe(HOTEL_ISCHIA);
    expect("pickup_hotel" in (call?.patch ?? {})).toBe(false);
    expect(counter.count).toBe(0);
  });
});
