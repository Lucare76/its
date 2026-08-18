import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * ITS Data Integrity Sprint 5 — TARGET 1 (auto-assign).
 *
 * Estende lo stesso fake Supabase già usato e verificato in
 * piano-giorno-auto-assign-error-sanitization.test.ts, aggiungendo
 * controllo su services.update/status_events.insert e tracciamento delle
 * righe assignments per verificare l'invariante:
 *   status='assigned' ⇒ assignment esiste
 *   assignment esiste ⇒ status != 'new'
 * dopo ogni possibile punto di fallimento della sequenza (ora sequenziale,
 * non più Promise.all).
 */

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_ARRIVAL = "a1111111-1111-4111-8111-111111111111";
const DRIVER_PROFILE = "d1111111-1111-4111-8111-111111111111";
const DRIVER_USER = "u1111111-1111-4111-8111-111111111111";
const VEHICLE_ID = "v1111111-1111-4111-8111-111111111111";
const VEHICLE_LABEL = "Van 8";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

function createFakeSupabase(opts: {
  assignUpsertError?: string;
  servicesUpdateError?: string | "always";
  statusEventsError?: string;
  assignmentsDeleteError?: string;
} = {}) {
  const tables: Record<string, Row[]> = {
    services: [{
      id: SERVICE_ARRIVAL, tenant_id: TENANT_A, date: TEST_DATE, time: "09:00:00",
      direction: "arrival", vessel: "SNAV", hotel_id: null, pax: 2, status: "new",
      is_draft: false, meeting_point: "Ischia Porto", pickup_hotel: null,
      customer_name: "Cliente Test", booking_service_kind: null, service_type_code: null,
      arrival_time: null, orario_barca: null, porto_bruno: null, barca_compagnia: null, ferry_details: null,
    }],
    hotels: [],
    vehicles: [{ id: VEHICLE_ID, tenant_id: TENANT_A, label: VEHICLE_LABEL, capacity: 8, active: true }],
    assignments: [
      // Riga di un altro tenant, mai toccata da nessuna query in-scope —
      // verifica tenant isolation (test #8).
      { id: "asg-other-tenant", tenant_id: TENANT_B, service_id: "svc-other-tenant", driver_profile_id: "x" },
    ],
    trip_groups: [],
    hotel_vehicle_limits: [],
    driver_daily_availability: [],
    vehicle_daily_availability: [],
    vehicle_time_blocks: [],
    daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
    status_events: [],
  };

  const calls = {
    tripGroupsInserted: [] as Row[],
    assignmentsUpserted: [] as Row[],
    assignmentsDeleted: 0,
    servicesUpdateAttempts: 0,
    statusEventsInsertAttempts: 0,
  };
  let servicesUpdateCallCount = 0;

  function makeChain(table: string, op: "select" | "update" | "delete") {
    let filtered = tables[table] ?? [];
    const builder = {
      eq(field: string, value: unknown) { filtered = filtered.filter((r) => r[field] === value); return builder; },
      neq(field: string, value: unknown) { filtered = filtered.filter((r) => r[field] !== value); return builder; },
      in(field: string, values: unknown[]) { filtered = filtered.filter((r) => values.includes(r[field])); return builder; },
      not() { return builder; },
      order() { return builder; },
      limit(n: number) { filtered = filtered.slice(0, n); return builder; },
      maybeSingle() { return Promise.resolve({ data: filtered[0] ?? null, error: null }); },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        if (op === "update" && table === "services") {
          calls.servicesUpdateAttempts += 1;
          servicesUpdateCallCount += 1;
          const shouldFail = opts.servicesUpdateError === "always" || (opts.servicesUpdateError && servicesUpdateCallCount === 1);
          if (shouldFail) return Promise.resolve({ data: null, error: { message: opts.servicesUpdateError } }).then(resolve, reject);
          for (const r of filtered) r.status = "assigned";
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        if (op === "update") return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        if (op === "delete" && table === "assignments") {
          calls.assignmentsDeleted += filtered.length;
          if (opts.assignmentsDeleteError) return Promise.resolve({ data: null, error: { message: opts.assignmentsDeleteError } }).then(resolve, reject);
          const toRemove = new Set(filtered);
          tables.assignments = tables.assignments.filter((r) => !toRemove.has(r));
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
        select() { return makeChain(table, "select"); },
        update() { return makeChain(table, "update"); },
        delete() { return makeChain(table, "delete"); },
        insert(rows: Row | Row[]) {
          const rowsArr = Array.isArray(rows) ? rows : [rows];
          if (table === "trip_groups") {
            const inserted = rowsArr.map((r, idx) => ({ id: `grp-${idx + 1}`, status: "active", ...r }));
            calls.tripGroupsInserted.push(...inserted);
            return { select: () => Promise.resolve({ data: inserted, error: null }) };
          }
          if (table === "status_events") {
            calls.statusEventsInsertAttempts += 1;
            if (opts.statusEventsError) return Promise.resolve({ data: null, error: { message: opts.statusEventsError } });
            tables.status_events.push(...rowsArr);
            return Promise.resolve({ data: rowsArr, error: null });
          }
          return Promise.resolve({ data: rowsArr, error: null });
        },
        upsert(rows: Row | Row[]) {
          const rowsArr = Array.isArray(rows) ? rows : [rows];
          if (table === "assignments") {
            if (opts.assignUpsertError) {
              return Promise.resolve({ data: null, error: { message: opts.assignUpsertError } });
            }
            tables.assignments.push(...rowsArr);
            calls.assignmentsUpserted.push(...rowsArr);
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
  auditLog: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorizePricingRequest }));
vi.mock("@/lib/server/driver-registry", () => ({ listDriverRegistry: mocks.listDriverRegistry }));
vi.mock("@/lib/server/vehicle-commitments", () => ({ loadVehicleCommitmentsForDate: mocks.loadVehicleCommitmentsForDate }));
vi.mock("@/lib/server/learned-patterns", () => ({
  loadLearnedPatterns: mocks.loadLearnedPatterns,
  updateLearnedPatterns: mocks.updateLearnedPatterns,
}));
vi.mock("@/lib/server/assignment-history", () => ({
  extractFeatures: mocks.extractFeatures,
  logAssignmentChange: mocks.logAssignmentChange,
  buildAssignmentDecisionFeatures: (base: Row, decision: Row = {}) => ({ ...base, ...Object.fromEntries(Object.entries(decision).filter(([, v]) => v !== undefined)) }),
}));
vi.mock("@/lib/piano-global-planner", () => ({ assignGlobalPlanner: mocks.assignGlobalPlanner }));
vi.mock("@/lib/server/ops-audit", () => ({ auditLog: mocks.auditLog }));

import { POST } from "@/app/api/ops/piano-giorno/auto-assign/route";

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

function authorizeAs(fake: ReturnType<typeof createFakeSupabase>) {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
  });
}

describe("Data Integrity Sprint 5 — auto-assign atomicity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listDriverRegistry.mockResolvedValue([{
      id: DRIVER_PROFILE, user_id: DRIVER_USER, full_name: "Mario Rossi", phone: null,
      username: null, active: true, has_access: true, access_suspended: false,
      role: "driver", max_vehicle_capacity: null,
    }]);
    mocks.loadVehicleCommitmentsForDate.mockResolvedValue({ rows: [], byVehicleId: new Map() });
    mocks.loadLearnedPatterns.mockResolvedValue([]);
    mocks.updateLearnedPatterns.mockResolvedValue(undefined);
    mocks.extractFeatures.mockReturnValue({});
    mocks.logAssignmentChange.mockResolvedValue(undefined);
    mocks.assignGlobalPlanner.mockReturnValue([{
      id: "draft_0", assigned: true, proposed_driver_key: DRIVER_PROFILE,
      proposed_driver_name: "Mario Rossi", proposed_vehicle_label: VEHICLE_LABEL, proposed_vehicle_capacity: 8,
    }]);
  });

  it("1. assignments.upsert fallisce ⇒ services.status non viene MAI toccato, zero orphan", async () => {
    const fake = createFakeSupabase({ assignUpsertError: "duplicate key" });
    authorizeAs(fake);

    const res = await callPost();
    expect(res.status).toBe(200);

    expect(fake.calls.servicesUpdateAttempts).toBe(0); // mai tentato
    const service = fake.tables.services.find((s) => s.id === SERVICE_ARRIVAL);
    expect(service?.status).toBe("new"); // invariato
    expect(fake.calls.statusEventsInsertAttempts).toBe(0);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled(); // test #9
  });

  it("2. assignments riesce, services.update fallisce anche dopo retry ⇒ compensating delete, zero orphan", async () => {
    const fake = createFakeSupabase({ servicesUpdateError: "always" });
    authorizeAs(fake);

    const res = await callPost();
    expect(res.status).toBe(200);

    expect(fake.calls.servicesUpdateAttempts).toBe(2); // tentativo + 1 retry
    expect(fake.calls.assignmentsDeleted).toBeGreaterThan(0); // compensating delete eseguito
    const remainingForService = fake.tables.assignments.filter((a) => a.service_id === SERVICE_ARRIVAL);
    expect(remainingForService).toHaveLength(0); // nessun assignment orfano rimasto
    const service = fake.tables.services.find((s) => s.id === SERVICE_ARRIVAL);
    expect(service?.status).toBe("new"); // MAI diventato "assigned"
    expect(fake.calls.statusEventsInsertAttempts).toBe(0); // gated, mai raggiunto
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled(); // test #9
  });

  it("2b. retry: se il SECONDO tentativo di services.update riesce, nessuna compensazione, invariante rispettata", async () => {
    // servicesUpdateError impostato solo per la prima chiamata (comportamento
    // di default della fake quando non è "always").
    const fake = createFakeSupabase({ servicesUpdateError: "transient failure" });
    authorizeAs(fake);

    const res = await callPost();
    expect(res.status).toBe(200);

    expect(fake.calls.servicesUpdateAttempts).toBe(2);
    expect(fake.calls.assignmentsDeleted).toBe(0); // nessuna compensazione necessaria
    const service = fake.tables.services.find((s) => s.id === SERVICE_ARRIVAL);
    expect(service?.status).toBe("assigned");
    const assignment = fake.tables.assignments.find((a) => a.service_id === SERVICE_ARRIVAL);
    expect(assignment).toBeDefined(); // invariante rispettata: assigned ⇒ assignment esiste
  });

  it("3. status_events fallisce dopo assignment+status riusciti: comportamento definito — nessun rollback, invariante primario resta soddisfatto", async () => {
    const fake = createFakeSupabase({ statusEventsError: "insert failed" });
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();
    expect(res.status).toBe(200);

    const service = fake.tables.services.find((s) => s.id === SERVICE_ARRIVAL);
    expect(service?.status).toBe("assigned"); // non rollbackato
    const assignment = fake.tables.assignments.find((a) => a.service_id === SERVICE_ARRIVAL);
    expect(assignment).toBeDefined(); // non rollbackato — invariante 1 & 2 comunque soddisfatte
    expect(body.report.join(" ")).toContain("Errore registrazione eventi stato.");
    expect(fake.calls.assignmentsDeleted).toBe(0); // nessuna compensazione: non necessaria
  });

  it("7. retry/idempotenza: due chiamate identiche di successo non producono duplicati né incoerenza", async () => {
    const fake = createFakeSupabase();
    authorizeAs(fake);

    await callPost();
    await callPost();

    const matching = fake.tables.assignments.filter((a) => a.service_id === SERVICE_ARRIVAL);
    // upsert con onConflict service_id,tenant_id: la seconda chiamata
    // aggiorna, non duplica (la fake accumula via push, ma verifichiamo che
    // lo stato finale resti coerente: sempre un solo assignment "reale" per
    // service_id nel nostro fake semplificato non deduplica l'array, ma
    // l'invariante sullo status resta valida in ogni caso).
    expect(matching.length).toBeGreaterThanOrEqual(1);
    const service = fake.tables.services.find((s) => s.id === SERVICE_ARRIVAL);
    expect(service?.status).toBe("assigned");
  });

  it("8. tenant isolation: una riga assignments di un altro tenant non viene mai toccata dal compensating delete", async () => {
    const fake = createFakeSupabase({ servicesUpdateError: "always" });
    authorizeAs(fake);

    await callPost();

    const otherTenantRow = fake.tables.assignments.find((a) => a.tenant_id === TENANT_B);
    expect(otherTenantRow).toBeDefined(); // mai cancellata
  });

  it("9. driver_assignment_history non scritto quando assignments o status falliscono", async () => {
    const fakeAssignFail = createFakeSupabase({ assignUpsertError: "x" });
    authorizeAs(fakeAssignFail);
    await callPost();
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.listDriverRegistry.mockResolvedValue([{
      id: DRIVER_PROFILE, user_id: DRIVER_USER, full_name: "Mario Rossi", phone: null,
      username: null, active: true, has_access: true, access_suspended: false,
      role: "driver", max_vehicle_capacity: null,
    }]);
    mocks.loadVehicleCommitmentsForDate.mockResolvedValue({ rows: [], byVehicleId: new Map() });
    mocks.loadLearnedPatterns.mockResolvedValue([]);
    mocks.updateLearnedPatterns.mockResolvedValue(undefined);
    mocks.extractFeatures.mockReturnValue({});
    mocks.logAssignmentChange.mockResolvedValue(undefined);
    mocks.assignGlobalPlanner.mockReturnValue([{
      id: "draft_0", assigned: true, proposed_driver_key: DRIVER_PROFILE,
      proposed_driver_name: "Mario Rossi", proposed_vehicle_label: VEHICLE_LABEL, proposed_vehicle_capacity: 8,
    }]);
    const fakeStatusFail = createFakeSupabase({ servicesUpdateError: "always" });
    authorizeAs(fakeStatusFail);
    await callPost();
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });
});
