import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Test CONC-06 — rivalidazione lock subito prima della persistenza in auto-assign.
 *
 * auto-assign legge una snapshot iniziale di assignments (locked_by_operator incluso),
 * pianifica i giri, e solo alla fine scrive su trip_groups/assignments/services/status_events.
 * Il fix aggiunge una SELECT di rivalidazione tenant-scoped, limitata ai service_id
 * candidati, subito prima di QUALSIASI scrittura di persistenza (trip_groups incluso).
 * Se un servizio risulta ora locked_by_operator=true, o il suo stato di lock è cambiato
 * rispetto alla snapshot iniziale, l'intera operazione viene interrotta con 409 e zero
 * scritture. Un errore nella query di rivalidazione fallisce chiuso con 500.
 *
 * Il mock isola solo i moduli esterni pesanti (registry autisti, impegni mezzo,
 * pattern appresi, storico assegnazioni, planner globale) mantenendo reale tutta
 * la logica interna della route. Uno scenario minimo a un solo servizio/autista/
 * mezzo è sufficiente a raggiungere il punto di persistenza finale.
 */

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVICE_ARRIVAL = "a1111111-1111-4111-8111-111111111111";
const OTHER_SERVICE = "a2222222-2222-4222-8222-222222222222";
const DRIVER_PROFILE = "d1111111-1111-4111-8111-111111111111";
const DRIVER_USER = "u1111111-1111-4111-8111-111111111111";
const VEHICLE_ID = "v1111111-1111-4111-8111-111111111111";
const VEHICLE_LABEL = "Van 8";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;
type SelectResult = { data: Row[] | null; error: { message: string } | null };

/**
 * Fake Supabase in-memory, tenant-aware. Copre solo le tabelle toccate da
 * auto-assign/route.ts. `assignmentsSelectOverrides[i]` sostituisce l'i-esima
 * SELECT (0-based) sulla tabella "assignments": la prima è sempre la snapshot
 * iniziale, la seconda è la rivalidazione CONC-06 subito prima della persistenza.
 */
function createAutoAssignSupabase(
  seed: Partial<Record<
    | "services" | "hotels" | "vehicles" | "assignments" | "trip_groups"
    | "hotel_vehicle_limits" | "driver_daily_availability" | "vehicle_daily_availability"
    | "vehicle_time_blocks" | "daily_availability_confirmations" | "status_events",
    Row[]
  >> = {},
  options: { assignmentsSelectOverrides?: Array<SelectResult | undefined> } = {}
) {
  const tables: Record<string, Row[]> = {
    services: [...(seed.services ?? [])],
    hotels: [...(seed.hotels ?? [])],
    vehicles: [...(seed.vehicles ?? [])],
    assignments: [...(seed.assignments ?? [])],
    trip_groups: [...(seed.trip_groups ?? [])],
    hotel_vehicle_limits: [...(seed.hotel_vehicle_limits ?? [])],
    driver_daily_availability: [...(seed.driver_daily_availability ?? [])],
    vehicle_daily_availability: [...(seed.vehicle_daily_availability ?? [])],
    vehicle_time_blocks: [...(seed.vehicle_time_blocks ?? [])],
    daily_availability_confirmations: [...(seed.daily_availability_confirmations ?? [])],
    status_events: [...(seed.status_events ?? [])],
  };

  const assignmentsSelectOverrides = options.assignmentsSelectOverrides ?? [];
  let assignmentsSelectCallCount = 0;

  const calls = {
    tripGroupsInserted: [] as Row[],
    assignmentsUpserted: [] as Row[],
    servicesStatusUpdated: [] as string[],
    statusEventsInserted: [] as Row[],
  };

  function makeChain(table: string, op: "select" | "update" | "delete", payload?: Row) {
    if (!(table in tables)) throw new Error(`[fake supabase] tabella non definita: ${table}`);
    let filtered = tables[table]!;
    let override: SelectResult | undefined;
    if (op === "select" && table === "assignments") {
      override = assignmentsSelectOverrides[assignmentsSelectCallCount - 1];
    }

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
      order() {
        return builder;
      },
      limit(n: number) {
        filtered = filtered.slice(0, n);
        return builder;
      },
      maybeSingle() {
        if (override) return Promise.resolve(override);
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      then(resolve: (v: SelectResult) => unknown, reject?: (e: unknown) => unknown) {
        if (override) return Promise.resolve(override).then(resolve, reject);
        if (op === "update") {
          for (const row of filtered) Object.assign(row, payload);
          if (table === "services" && (payload as Row | undefined)?.status === "assigned") {
            calls.servicesStatusUpdated.push(...filtered.map((r) => r.id as string));
          }
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        if (op === "delete") {
          const toRemove = new Set(filtered);
          for (let i = tables[table]!.length - 1; i >= 0; i--) {
            if (toRemove.has(tables[table]![i])) tables[table]!.splice(i, 1);
          }
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      return {
        select(_cols?: string) {
          if (table === "assignments") assignmentsSelectCallCount += 1;
          return makeChain(table, "select");
        },
        update(payload: Row) {
          return makeChain(table, "update", payload);
        },
        delete() {
          return makeChain(table, "delete");
        },
        insert(rows: Row | Row[]) {
          const rowsArr = Array.isArray(rows) ? rows : [rows];
          if (table === "trip_groups") {
            const inserted = rowsArr.map((r, idx) => ({
              id: `grp-${tables.trip_groups!.length + idx + 1}`,
              status: "active",
              ...r,
            }));
            tables.trip_groups!.push(...inserted);
            calls.tripGroupsInserted.push(...inserted);
            return { select: () => Promise.resolve({ data: inserted, error: null }) };
          }
          if (table === "status_events") {
            calls.statusEventsInserted.push(...rowsArr);
            tables.status_events!.push(...rowsArr);
            return Promise.resolve({ data: null, error: null });
          }
          tables[table]!.push(...rowsArr);
          return Promise.resolve({ data: rowsArr, error: null });
        },
        upsert(rows: Row | Row[], _opts?: unknown) {
          const rowsArr = Array.isArray(rows) ? rows : [rows];
          if (table === "assignments") {
            calls.assignmentsUpserted.push(...rowsArr);
            tables.assignments!.push(...rowsArr);
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };

  return { admin, tables, calls };
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  listDriverRegistry: vi.fn(),
  loadVehicleCommitmentsForDate: vi.fn(),
  loadLearnedPatterns: vi.fn(),
  updateLearnedPatterns: vi.fn(),
  extractFeatures: vi.fn(),
  logAssignmentChange: vi.fn(),
  assignGlobalPlanner: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));
vi.mock("@/lib/server/driver-registry", () => ({
  listDriverRegistry: mocks.listDriverRegistry,
}));
vi.mock("@/lib/server/vehicle-commitments", () => ({
  loadVehicleCommitmentsForDate: mocks.loadVehicleCommitmentsForDate,
}));
vi.mock("@/lib/server/learned-patterns", () => ({
  loadLearnedPatterns: mocks.loadLearnedPatterns,
  updateLearnedPatterns: mocks.updateLearnedPatterns,
}));
vi.mock("@/lib/server/assignment-history", () => ({
  extractFeatures: mocks.extractFeatures,
  logAssignmentChange: mocks.logAssignmentChange,
}));
vi.mock("@/lib/piano-global-planner", () => ({
  assignGlobalPlanner: mocks.assignGlobalPlanner,
}));

import { POST } from "@/app/api/ops/piano-giorno/auto-assign/route";

function serviceRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT_A,
    date: TEST_DATE,
    time: "09:00:00",
    direction: "arrival",
    vessel: "SNAV",
    hotel_id: null,
    pax: 2,
    status: "new",
    is_draft: false,
    meeting_point: "Ischia Porto",
    pickup_hotel: null,
    customer_name: "Cliente Test",
    booking_service_kind: null,
    service_type_code: null,
    arrival_time: null,
    orario_barca: null,
    porto_bruno: null,
    barca_compagnia: null,
    ferry_details: null,
    ...overrides,
  };
}

function baseSeed(
  overrides: Parameters<typeof createAutoAssignSupabase>[0] = {},
  options: Parameters<typeof createAutoAssignSupabase>[1] = {}
) {
  return createAutoAssignSupabase(
    {
      services: [serviceRow(SERVICE_ARRIVAL)],
      vehicles: [{ id: VEHICLE_ID, tenant_id: TENANT_A, label: VEHICLE_LABEL, capacity: 8, active: true }],
      daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
      ...overrides,
    },
    options
  );
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/ops/piano-giorno/auto-assign", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}
function callPost(body: Record<string, unknown> = { date: TEST_DATE, mode: "unassigned_only" }) {
  return POST(makeRequest(body));
}

function authorizeAs(fake: ReturnType<typeof createAutoAssignSupabase>, role: string = "operator") {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: TENANT_A, role, suspended: false },
  });
}

function assertZeroWrites(fake: ReturnType<typeof createAutoAssignSupabase>) {
  expect(fake.calls.tripGroupsInserted).toHaveLength(0);
  expect(fake.calls.assignmentsUpserted).toHaveLength(0);
  expect(fake.calls.servicesStatusUpdated).toHaveLength(0);
  expect(fake.calls.statusEventsInserted).toHaveLength(0);
}

describe("CONC-06 — rivalidazione lock in auto-assign", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listDriverRegistry.mockResolvedValue([
      {
        id: DRIVER_PROFILE,
        user_id: DRIVER_USER,
        full_name: "Mario Rossi",
        phone: null,
        username: null,
        active: true,
        has_access: true,
        access_suspended: false,
        role: "driver",
        max_vehicle_capacity: null,
      },
    ]);
    mocks.loadVehicleCommitmentsForDate.mockResolvedValue({ rows: [], byVehicleId: new Map() });
    mocks.loadLearnedPatterns.mockResolvedValue([]);
    mocks.updateLearnedPatterns.mockResolvedValue(undefined);
    mocks.extractFeatures.mockReturnValue({});
    mocks.logAssignmentChange.mockResolvedValue(undefined);
    mocks.assignGlobalPlanner.mockReturnValue([
      {
        id: "draft_0",
        assigned: true,
        proposed_driver_key: DRIVER_PROFILE,
        proposed_driver_name: "Mario Rossi",
        proposed_vehicle_label: VEHICLE_LABEL,
        proposed_vehicle_capacity: 8,
      },
    ]);
  });

  it("1. percorso normale: nessuna modifica rilevata, assegnazione persiste con 200", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.assigned).toBeGreaterThanOrEqual(1);
    expect(body.trips).toBeGreaterThanOrEqual(1);
    expect(fake.calls.tripGroupsInserted).toHaveLength(1);
    expect(fake.calls.assignmentsUpserted).toHaveLength(1);
    expect(fake.calls.servicesStatusUpdated).toContain(SERVICE_ARRIVAL);
    expect(fake.calls.statusEventsInserted).toHaveLength(1);
  });

  it("2. 409 quando la rivalidazione rileva un lock sopravvenuto, zero scritture", async () => {
    const fake = baseSeed(
      {},
      {
        assignmentsSelectOverrides: [
          undefined, // snapshot iniziale: nessun lock
          { data: [{ service_id: SERVICE_ARRIVAL, locked_by_operator: true }], error: null }, // rivalidazione: lock sopravvenuto
        ],
      }
    );
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      ok: false,
      error:
        "L'assegnazione automatica è stata interrotta perché alcuni servizi sono stati modificati durante l'elaborazione. Riprova.",
    });
    assertZeroWrites(fake);
  });

  it("3. 500 se la query di rivalidazione fallisce, fail-closed, zero scritture", async () => {
    const fake = baseSeed(
      {},
      {
        assignmentsSelectOverrides: [
          undefined,
          { data: null, error: { message: "connection to server failed" } },
        ],
      }
    );
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    assertZeroWrites(fake);
  });

  it("4. nessuna regressione: un lock su un altro servizio (fuori dal batch) non blocca l'assegnazione", async () => {
    const fake = baseSeed({
      assignments: [{ service_id: OTHER_SERVICE, tenant_id: TENANT_A, locked_by_operator: true, group_id: null }],
    });
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.tripGroupsInserted).toHaveLength(1);
    expect(fake.calls.assignmentsUpserted).toHaveLength(1);
  });

  it("5. nessuna regressione: gate disponibilità del giorno non confermata resta invariato (nessuna scrittura)", async () => {
    const fake = baseSeed({ daily_availability_confirmations: [] });
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain("Disponibilita del giorno non confermata");
    assertZeroWrites(fake);
  });

  it("9. isolamento tenant: un lock sullo stesso service_id ma su TENANT_B non blocca la rivalidazione di TENANT_A", async () => {
    const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const fake = baseSeed({
      // Riga "gemella" su un altro tenant, stesso service_id, locked=true.
      // La rivalidazione reale filtra .eq("tenant_id", tenantId) prima di
      // .in("service_id", ...): questa riga non deve mai essere osservata
      // dalla query di TENANT_A.
      assignments: [{ service_id: SERVICE_ARRIVAL, tenant_id: TENANT_B, locked_by_operator: true, group_id: null }],
    });
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.tripGroupsInserted).toHaveLength(1);
    expect(fake.calls.assignmentsUpserted).toHaveLength(1);
  });

  it("10. batch vuoto: nessun servizio candidato, la rivalidazione viene saltata e non ci sono scritture né errori", async () => {
    const fake = baseSeed({ services: [] });
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.assigned).toBe(0);
    assertZeroWrites(fake);
  });
});
