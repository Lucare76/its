import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * STEP B — PATCH /api/agency/bookings/[id] deve ricalcolare pickup_hotel/
 * pickup_alert per Formula SNAV/MEDMAR diretta quando l'agenzia modifica
 * hotel_id o la data/orario di partenza sulla riga direction=departure.
 * L'agenzia non può riassegnare agency_id (nessun campo simile nello schema
 * bookingPatchSchema) — i permessi non vengono ampliati da Step B.
 */

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/server/send-email", () => ({
  sendEmail: vi.fn().mockResolvedValue({ ok: true, skipped: true }),
}));

vi.mock("@/lib/server/whatsapp/contacts", () => ({
  ensureWhatsAppContact: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: vi.fn(),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";

import { createClient } from "@supabase/supabase-js";
import { PATCH } from "@/app/api/agency/bookings/[id]/route";

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
    request: new NextRequest(`http://localhost:3010/api/agency/bookings/${id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer test-token" },
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
  let mode: "select" | "update" | "limit" | null = null;
  let patch: Record<string, unknown> | null = null;
  let filterId: string | undefined;
  const b: Record<string, unknown> = {};
  b.select = () => { if (mode !== "update") mode = "select"; return b; };
  b.eq = (col: string, value: string) => { if (col === "id") filterId = value; return b; };
  b.or = () => b;
  b.limit = () => { mode = "limit"; return b; };
  b.update = (p: Record<string, unknown>) => { mode = "update"; patch = p; return b; };
  b.maybeSingle = async () => {
    const row = filterId ? services.store.get(filterId) : undefined;
    return { data: row ? { ...row } : null, error: null };
  };
  b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
    if (mode === "update" && filterId && patch) {
      const existing = services.store.get(filterId) ?? { id: filterId };
      services.store.set(filterId, { ...existing, ...patch });
      services.updateCalls.push({ id: filterId, patch });
    }
    // hasColumn probe (.select(col).limit(1)) resolve senza errore -> colonna esiste
    return Promise.resolve({ data: mode === "limit" ? [] : null, error: null }).then(resolve, reject);
  };
  return b;
}

function membershipsBuilder(membership: Record<string, unknown>) {
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = () => b;
  b.maybeSingle = async () => ({ data: membership, error: null });
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
  return b;
}

function makeFakeAdmin(opts: {
  services: ReturnType<typeof makeServicesStore>;
  membership: Record<string, unknown>;
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
    auth: { getUser: mocks.getUser },
    from(table: string) {
      if (table === "services") return servicesBuilder(opts.services);
      if (table === "memberships") return membershipsBuilder(opts.membership);
      if (table === "ferry_pickup_rules") return ferryRulesBuilder(directRules, counter);
      if (table === "ferry_schedules") return ferrySchedulesBuilder(ferrySchedules);
      if (table === "hotels") return hotelsBuilder(hotelById);
      return genericBuilder();
    },
  };
}

describe("PATCH /api/agency/bookings/[id] — ricalcolo pickup Formula direct (Step B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
  });

  // A. Formula cambia hotel/zona -> pickup aggiornato
  it("A. cambio hotel_id da zona Forio a zona Ischia ricalcola pickup_hotel", async () => {
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
      },
    });
    const directRules = [
      directRule({ id: "forio", company: "medmar", zone: "forio", departure_time: "17:00", pickup_time: "15:15", embark_port: "ischia_porto", arrival_port: "napoli_beverello" }),
      directRule({ id: "ischia", company: "medmar", zone: "ischia", departure_time: "17:00", pickup_time: "15:30", embark_port: "ischia_porto", arrival_port: "napoli_beverello" }),
    ];
    (createClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(makeFakeAdmin({
      services, directRules,
      membership: { tenant_id: TENANT, agency_id: "agency-1", role: "admin" },
      hotelById: { [HOTEL_FORIO]: { name: "Hotel Forio", zone: "forio" }, [HOTEL_ISCHIA]: { name: "Hotel Ischia", zone: "ischia" } },
    }));

    const { request, params } = makeRequest("svc-1", { hotel_id: HOTEL_ISCHIA });
    const res = await PATCH(request, { params });
    expect(res.status).toBe(200);

    const call = services.updateCalls.find((c) => c.id === "svc-1");
    expect(call?.patch.pickup_hotel).toBe("15:30");
  });

  // B. Formula cambia data -> pickup ricalcolato
  it("B. cambio departure_date che attraversa valid_from/valid_to ricalcola pickup_hotel", async () => {
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
      },
    });
    const directRules = [
      directRule({ id: "before", company: "medmar", zone: "ischia", departure_time: "17:00", pickup_time: "15:30", valid_to: "2026-08-31" }),
      directRule({ id: "after", company: "medmar", zone: "ischia", departure_time: "17:00", pickup_time: "15:45", valid_from: "2026-09-01" }),
    ];
    (createClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(makeFakeAdmin({
      services, directRules,
      membership: { tenant_id: TENANT, agency_id: "agency-1", role: "admin" },
      hotelById: { [HOTEL_ISCHIA]: { name: "Hotel Ischia", zone: "ischia" } },
    }));

    const { request, params } = makeRequest("svc-1", { departure_date: "2026-09-05" });
    await PATCH(request, { params });

    const call = services.updateCalls.find((c) => c.id === "svc-1");
    expect(call?.patch.pickup_hotel).toBe("15:45");
  });

  // C. solo pax/note -> nessun ricalcolo
  it("C. cambio solo pax/notes non ricalcola pickup e non interroga ferry_pickup_rules", async () => {
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
      },
    });
    const counter = { count: 0 };
    (createClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(makeFakeAdmin({
      services, directRules: [], ferryRulesCallCounter: counter,
      membership: { tenant_id: TENANT, agency_id: "agency-1", role: "admin" },
      hotelById: { [HOTEL_ISCHIA]: { name: "Hotel Ischia", zone: "ischia" } },
    }));

    const { request, params } = makeRequest("svc-1", { pax: 5, notes: "Nota agenzia" });
    await PATCH(request, { params });

    const call = services.updateCalls.find((c) => c.id === "svc-1");
    expect("pickup_hotel" in (call?.patch ?? {})).toBe(false);
    expect(counter.count).toBe(0);
  });

  // D. l'agenzia non può riassegnare agency_id (nessun campo simile nello schema)
  it("D. agency_id nel payload viene ignorato (nessun campo del genere in bookingPatchSchema)", async () => {
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
      },
    });
    (createClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(makeFakeAdmin({
      services, directRules: [],
      membership: { tenant_id: TENANT, agency_id: "agency-1", role: "admin" },
      hotelById: { [HOTEL_ISCHIA]: { name: "Hotel Ischia", zone: "ischia" } },
    }));

    const { request, params } = makeRequest("svc-1", {
      pax: 2,
      agency_id: "zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz",
    });
    const res = await PATCH(request, { params });
    expect(res.status).toBe(200);

    const call = services.updateCalls.find((c) => c.id === "svc-1");
    expect("agency_id" in (call?.patch ?? {})).toBe(false);
  });
});
