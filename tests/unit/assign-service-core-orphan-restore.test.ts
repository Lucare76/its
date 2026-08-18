import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * ITS Data Integrity Sprint 5 — TARGET 3: assignServiceCore() edge case
 * confermato — un assignment "orfano da gruppo" (senza group_id) viene
 * cancellato prima di ricreare gruppo+assignment; se quella ricreazione
 * fallisce (trip_groups.insert o assignments.insert), la riga cancellata
 * viene ora ripristinata (restoreDeletedOrphanAssignment), non lasciata
 * persa. Stesso harness già usato in assign-service-core-decision-metadata
 * (ML Data Collection Sprint 2), esteso con failure injection su
 * trip_groups.insert/assignments.insert.
 */

type Row = Record<string, unknown>;

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVICE_1 = "a1111111-1111-4111-8111-111111111111";
const PROFILE_1 = "p1111111-1111-4111-8111-111111111111";
const PROFILE_2 = "p2222222-2222-4222-8222-222222222222";
const OPERATOR_1 = "u1111111-1111-4111-8111-111111111111";
const TEST_DATE = "2026-08-20";

function createSupabase(
  seed: Partial<Record<"services" | "driver_profiles" | "assignments" | "trip_groups" | "daily_availability_confirmations", Row[]>> = {},
  opts: { tripGroupsInsertError?: string; assignmentsInsertError?: string } = {}
) {
  const tables: Record<string, Row[]> = {
    services: [...(seed.services ?? [])],
    driver_profiles: [...(seed.driver_profiles ?? [])],
    assignments: [...(seed.assignments ?? [])],
    trip_groups: [...(seed.trip_groups ?? [])],
    daily_availability_confirmations: [...(seed.daily_availability_confirmations ?? [])],
    status_events: [],
    driver_assignment_history: [],
  };
  const calls = { assignmentDeletes: 0, assignmentInserts: 0 };

  function makeSelectBuilder(table: string) {
    let filtered = tables[table] ?? [];
    const builder = {
      eq(field: string, value: unknown) { filtered = filtered.filter((r) => r[field] === value); return builder; },
      neq(field: string, value: unknown) { filtered = filtered.filter((r) => r[field] !== value); return builder; },
      in(field: string, values: unknown[]) { filtered = filtered.filter((r) => values.includes(r[field])); return builder; },
      maybeSingle() { return Promise.resolve({ data: filtered[0] ? { ...filtered[0] } : null, error: null }); },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve({ data: filtered.map((r) => ({ ...r })), error: null }).then(resolve); },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      return {
        select() { return makeSelectBuilder(table); },
        delete() {
          const filters: Array<[string, unknown]> = [];
          const builder = {
            eq(field: string, value: unknown) { filters.push([field, value]); return builder; },
            then(resolve: (v: unknown) => unknown) {
              if (table === "assignments") calls.assignmentDeletes += 1;
              const match = (r: Row) => filters.every(([f, v]) => r[f] === v);
              tables[table] = tables[table].filter((r) => !match(r));
              return Promise.resolve({ data: null, error: null }).then(resolve);
            },
          };
          return builder;
        },
        update(payload: Row) {
          const filters: Array<[string, unknown]> = [];
          const builder = {
            eq(field: string, value: unknown) { filters.push([field, value]); return builder; },
            then(resolve: (v: unknown) => unknown) {
              const match = (r: Row) => filters.every(([f, v]) => r[f] === v);
              for (const r of tables[table]) if (match(r)) Object.assign(r, payload);
              return Promise.resolve({ data: null, error: null }).then(resolve);
            },
          };
          return builder;
        },
        insert(row: Row) {
          if (table === "trip_groups") {
            if (opts.tripGroupsInsertError) {
              return { select: () => ({ single: () => Promise.resolve({ data: null, error: { message: opts.tripGroupsInsertError } }) }) };
            }
            const inserted = { id: `grp-${tables.trip_groups.length + 1}`, status: "active", ...row };
            tables.trip_groups.push(inserted);
            return { select: () => ({ single: () => Promise.resolve({ data: inserted, error: null }) }) };
          }
          if (table === "assignments") {
            calls.assignmentInserts += 1;
            if (opts.assignmentsInsertError && calls.assignmentInserts === 1) {
              // Fallisce solo il PRIMO insert (quello del nuovo assignment
              // nel percorso principale) — il ripristino compensating (che
              // avviene DOPO, come reazione all'errore) deve invece riuscire.
              return Promise.resolve({ data: null, error: { message: opts.assignmentsInsertError, code: "OTHER" } });
            }
            const inserted = { id: `asg-${tables.assignments.length + 1}`, ...row };
            tables.assignments.push(inserted);
            return Promise.resolve({ data: inserted, error: null });
          }
          tables[table].push(row);
          return Promise.resolve({ data: row, error: null });
        },
        upsert(row: Row) { tables[table].push(row); return Promise.resolve({ data: null, error: null }); },
      };
    },
  };

  return { admin, tables, calls };
}

const mocks = vi.hoisted(() => ({ logAssignmentChange: vi.fn(), updateLearnedPatterns: vi.fn(), auditLog: vi.fn() }));
vi.mock("@/lib/server/learned-patterns", () => ({ updateLearnedPatterns: mocks.updateLearnedPatterns }));
vi.mock("@/lib/server/ops-audit", () => ({ auditLog: mocks.auditLog }));
vi.mock("@/lib/server/assignment-history", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/assignment-history")>("@/lib/server/assignment-history");
  return { ...actual, logAssignmentChange: mocks.logAssignmentChange };
});

import { assignServiceCore } from "@/lib/server/assign-service-core";

function serviceRow(overrides: Row = {}): Row {
  return {
    id: SERVICE_1, tenant_id: TENANT_A, date: TEST_DATE, status: "assigned", is_draft: false,
    time: "10:00:00", pickup_hotel: null, direction: "departure", hotel_id: null,
    meeting_point: "Ischia Porto", booking_service_kind: null, service_type_code: null,
    vessel: "SNAV", barca_compagnia: null, pax: 2, ...overrides,
  };
}

describe("Data Integrity Sprint 5 — assignServiceCore orphan-from-group edge case (TARGET 3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logAssignmentChange.mockResolvedValue(undefined);
    mocks.updateLearnedPatterns.mockResolvedValue({ upserted: 0 });
  });

  // Assignment pre-esistente SENZA group_id — lo scenario edge-case
  // esplicitamente descritto nella richiesta.
  const orphanAssignment = {
    id: "asg-orphan", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: null,
    driver_user_id: null, driver_profile_id: PROFILE_1, vehicle_label: "Van 8",
  };

  it("6a. reinserimento (trip_groups.insert) fallisce dopo la cancellazione dell'assignment orfano ⇒ viene ripristinato, nessun orphan", async () => {
    const fake = createSupabase(
      {
        services: [serviceRow()],
        driver_profiles: [{ id: PROFILE_1, tenant_id: TENANT_A, active: true }, { id: PROFILE_2, tenant_id: TENANT_A, active: true }],
        assignments: [orphanAssignment],
        daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
      },
      { tripGroupsInsertError: "simulated trip_groups insert failure" }
    );

    const res = await assignServiceCore(fake.admin as never, {
      tenantId: TENANT_A, userId: OPERATOR_1, serviceId: SERVICE_1, driverProfileId: PROFILE_2, vehicleLabel: "Van 8",
    });

    expect(res.status).toBe(500);
    expect(fake.calls.assignmentDeletes).toBe(1); // l'assignment orfano è stato cancellato
    const restored = fake.tables.assignments.find((a) => a.id === "asg-orphan" || (a.service_id === SERVICE_1 && a.driver_profile_id === PROFILE_1));
    expect(restored).toBeDefined(); // ripristinato dopo il fallimento
    expect(restored?.driver_profile_id).toBe(PROFILE_1); // dati originali preservati
  });

  it("6b. reinserimento (assignments.insert) fallisce dopo la cancellazione dell'assignment orfano ⇒ viene ripristinato, nessun orphan", async () => {
    const fake = createSupabase(
      {
        services: [serviceRow()],
        driver_profiles: [{ id: PROFILE_1, tenant_id: TENANT_A, active: true }, { id: PROFILE_2, tenant_id: TENANT_A, active: true }],
        assignments: [orphanAssignment],
        daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
      },
      { assignmentsInsertError: "simulated assignments insert failure" }
    );

    const res = await assignServiceCore(fake.admin as never, {
      tenantId: TENANT_A, userId: OPERATOR_1, serviceId: SERVICE_1, driverProfileId: PROFILE_2, vehicleLabel: "Van 8",
    });

    expect(res.status).toBe(500);
    expect(fake.calls.assignmentDeletes).toBe(1);
    const restored = fake.tables.assignments.find((a) => a.driver_profile_id === PROFILE_1);
    expect(restored).toBeDefined(); // ripristinato
  });

  it("6c. percorso di successo (nessun errore): nessun ripristino necessario, nuovo assignment con driver aggiornato", async () => {
    const fake = createSupabase({
      services: [serviceRow()],
      driver_profiles: [{ id: PROFILE_1, tenant_id: TENANT_A, active: true }, { id: PROFILE_2, tenant_id: TENANT_A, active: true }],
      assignments: [orphanAssignment],
      daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
    });

    const res = await assignServiceCore(fake.admin as never, {
      tenantId: TENANT_A, userId: OPERATOR_1, serviceId: SERVICE_1, driverProfileId: PROFILE_2, vehicleLabel: "Van 8",
    });

    expect(res.status).toBe(200);
    const rows = fake.tables.assignments.filter((a) => a.service_id === SERVICE_1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.driver_profile_id).toBe(PROFILE_2); // nuovo, non l'orfano ripristinato
  });
});
