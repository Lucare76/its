import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

// FUNC-01 (group_id=null residuo) — assign-service. La stessa
// validateDriverGeographicBatch usata da departure-bus-assign è chiamata
// anche qui (app/api/ops/assign-service/route.ts) quando driver_user_id è
// presente. Prima del fix, un'assegnazione con group_id=null (come quelle
// scritte da departure-bus-assign, che non usa trip_groups) era invisibile
// a questo controllo anche quando la richiesta arrivava da assign-service:
// un autista già impegnato su un giro bus poteva essere assegnato altrove
// via assign-service senza alcun blocco geografico. Nessun file di test
// dedicato esisteva per la geografia di assign-service: creato qui perché
// la copertura esistente (assign-service-driver-overlap.test.ts) è mirata a
// CONC-02 e isola deliberatamente il caso group_id=null (query trip_groups,
// mai raggiunta da assignment senza gruppo).

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVICE_X = "a1111111-1111-4111-8111-111111111111";
const DRIVER_A = "d1111111-1111-4111-8111-111111111111";
const PROFILE_A = "p1111111-1111-4111-8111-111111111111";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

function createTenantAwareSupabase(
  seed: Partial<Record<
    "services" | "memberships" | "driver_profiles" | "assignments" | "trip_groups" | "daily_availability_confirmations" | "status_events" | "hotels",
    Row[]
  >> = {}
) {
  const tables: Record<string, Row[]> = {
    services: [...(seed.services ?? [])],
    memberships: [...(seed.memberships ?? [])],
    driver_profiles: [...(seed.driver_profiles ?? [])],
    assignments: [...(seed.assignments ?? [])],
    trip_groups: [...(seed.trip_groups ?? [])],
    daily_availability_confirmations: [...(seed.daily_availability_confirmations ?? [])],
    status_events: [...(seed.status_events ?? [])],
    hotels: [...(seed.hotels ?? [])],
    // CONC-07: destinazione dello storico strutturato fire-and-forget scritto
    // dopo l'assegnazione riuscita — deve esistere perché l'insert non crashi.
    driver_assignment_history: [],
  };

  const calls = {
    assignmentsInserted: [] as Row[],
    assignmentsUpdated: 0,
    servicesUpdated: 0,
  };

  function augmentAssignmentRow(row: Row): Row {
    return { ...row, services: tables.services.find((s) => s.id === row.service_id) ?? null };
  }

  function makeSelectBuilder(table: string) {
    if (!(table in tables)) throw new Error(`[fake supabase] tabella non definita: ${table}`);
    let filtered = tables[table];
    const augment = table === "assignments" ? augmentAssignmentRow : undefined;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] === value);
        return builder;
      },
      neq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] !== value);
        return builder;
      },
      in(field: string, values: unknown[]) {
        filtered = filtered.filter((r) => values.includes(r[field]));
        return builder;
      },
      not(field: string, _op: string, value: unknown) {
        filtered = filtered.filter((r) => (r[field] ?? null) !== value);
        return builder;
      },
      maybeSingle() {
        const row = filtered[0] ?? null;
        return Promise.resolve({ data: row ? (augment ? augment(row) : row) : null, error: null });
      },
      then(resolve: (v: { data: Row[] | null; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        const data = augment ? filtered.map(augment) : filtered;
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  function makeMutationBuilder(table: string, op: "delete" | "update", payload?: Row) {
    const rows = tables[table];
    let filtered = rows;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] === value);
        return builder;
      },
      then(resolve: (v: { data: null; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        if (op === "delete") {
          const toRemove = new Set(filtered);
          for (let i = rows.length - 1; i >= 0; i--) {
            if (toRemove.has(rows[i])) rows.splice(i, 1);
          }
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        for (const row of filtered) Object.assign(row, payload);
        if (table === "assignments") calls.assignmentsUpdated += filtered.length;
        if (table === "services") calls.servicesUpdated += filtered.length;
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      return {
        select() {
          return makeSelectBuilder(table);
        },
        delete() {
          return makeMutationBuilder(table, "delete");
        },
        update(payload: Row) {
          return makeMutationBuilder(table, "update", payload);
        },
        insert(row: Row) {
          if (table === "trip_groups") {
            const inserted = { id: `grp-${tables.trip_groups.length + 1}`, status: "active", ...row };
            tables.trip_groups.push(inserted);
            return { select: () => ({ single: () => Promise.resolve({ data: inserted, error: null }) }) };
          }
          if (table === "assignments") {
            const inserted = { id: `asg-${tables.assignments.length + 1}`, ...row };
            tables.assignments.push(inserted);
            calls.assignmentsInserted.push(inserted);
            return Promise.resolve({ data: inserted, error: null });
          }
          tables[table].push(row);
          return Promise.resolve({ data: row, error: null });
        },
        upsert(row: Row) {
          tables[table].push(row);
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };

  return { admin, tables, calls };
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));
vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: mocks.auditLog,
}));

import { POST } from "@/app/api/ops/assign-service/route";

function serviceRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT_A,
    date: TEST_DATE,
    status: "new",
    is_draft: false,
    time: "10:00:00",
    pickup_hotel: null,
    direction: "departure",
    hotel_id: null,
    meeting_point: null,
    arrival_time: null,
    orario_barca: null,
    porto_bruno: null,
    barca_compagnia: null,
    booking_service_kind: null,
    service_type_code: null,
    vessel: null,
    ferry_details: null,
    ...overrides,
  };
}

function baseSeed(overrides: Parameters<typeof createTenantAwareSupabase>[0] = {}) {
  return createTenantAwareSupabase({
    services: [serviceRow(SERVICE_X)],
    daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
    memberships: [{ tenant_id: TENANT_A, user_id: DRIVER_A, role: "driver", suspended: false, full_name: "Mario Rossi" }],
    driver_profiles: [{ id: PROFILE_A, tenant_id: TENANT_A, user_id: null, active: true }],
    ...overrides,
  });
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/ops/assign-service", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}
function callPost(body: Record<string, unknown>) {
  return POST(makeRequest(body));
}

function authorizeAs(fake: ReturnType<typeof createTenantAwareSupabase>, role: string = "operator") {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: TENANT_A, role, suspended: false },
  });
}

describe("FUNC-01 (group_id=null residuo) — assign-service vede le assegnazioni scritte da departure-bus-assign", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("15. assignment precedente con group_id=null (stile departure-bus-assign) genera un conflitto geografico reale in assign-service: 409, zero scritture", async () => {
    const fake = baseSeed({
      assignments: [
        {
          id: "asg-bus",
          tenant_id: TENANT_A,
          service_id: "existing-svc",
          driver_user_id: DRIVER_A,
          group_id: null,
          vehicle_label: "DEP_BUS:1",
        },
      ],
      services: [
        serviceRow(SERVICE_X, { time: "09:05:00", hotel_id: "hotel-1" }),
        serviceRow("existing-svc", { time: "09:00:00", hotel_id: null, meeting_point: "Forio" }),
      ],
      hotels: [{ id: "hotel-1", tenant_id: TENANT_A, zone: "Ischia Porto" }],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    // assign-service inoltra il messaggio euristico di geographicBlockMessage
    // così com'è (comportamento preesistente, invariato da questo fix — a
    // differenza di departure-bus-assign che lo sanifica in un messaggio
    // generico): qui verifichiamo solo che il conflitto sia stato rilevato.
    expect(body.error).toMatch(/ASSEGNAZIONE IMPOSSIBILE/);
    expect(fake.calls.assignmentsInserted).toHaveLength(0);
    expect(fake.calls.assignmentsUpdated).toBe(0);
  });

  it("assignment precedente group_id=null geograficamente compatibile: nessun blocco (200, comportamento invariato)", async () => {
    const fake = baseSeed({
      assignments: [
        { id: "asg-bus", tenant_id: TENANT_A, service_id: "existing-svc", driver_user_id: DRIVER_A, group_id: null, vehicle_label: "DEP_BUS:1" },
      ],
      services: [
        serviceRow(SERVICE_X, { time: "20:00:00", hotel_id: "hotel-1" }),
        serviceRow("existing-svc", { time: "09:00:00", hotel_id: null, meeting_point: "Forio" }),
      ],
      hotels: [{ id: "hotel-1", tenant_id: TENANT_A, zone: "Ischia Porto" }],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.assignmentsInserted).toHaveLength(1);
  });

  it("driver_profile_id senza driver_user_id: FUNC-01 non viene invocato (comportamento invariato, geo si applica solo a driver_user_id)", async () => {
    const fake = baseSeed({
      assignments: [
        { id: "asg-bus", tenant_id: TENANT_A, service_id: "existing-svc", driver_user_id: DRIVER_A, group_id: null, vehicle_label: "DEP_BUS:1" },
      ],
      services: [
        serviceRow(SERVICE_X, { time: "09:05:00", hotel_id: "hotel-1" }),
        serviceRow("existing-svc", { time: "09:00:00", hotel_id: null, meeting_point: "Forio" }),
      ],
      hotels: [{ id: "hotel-1", tenant_id: TENANT_A, zone: "Ischia Porto" }],
    });
    authorizeAs(fake);

    // Nessun conflitto perché l'assegnazione esistente è su DRIVER_A per
    // user_id, mentre qui si assegna solo driver_profile_id (nessun overlap
    // di identificatore, quindi anche la vecchia route sarebbe passata).
    const res = await callPost({ service_id: SERVICE_X, driver_profile_id: PROFILE_A });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });
});
