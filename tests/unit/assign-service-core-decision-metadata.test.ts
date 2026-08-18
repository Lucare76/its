import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * ML Data Collection Sprint 2 — FASE 7/8: assignServiceCore() propaga
 * opzionalmente source/proposalId/candidateSnapshot/chosenRank verso
 * logAssignmentChange(), e calcola wasOverride internamente (non richiede
 * input dal chiamante). Le chiamate esistenti che non passano questi campi
 * (route HTTP invariata) continuano a produrre lo stesso comportamento.
 */

type Row = Record<string, unknown>;

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVICE_1 = "a1111111-1111-4111-8111-111111111111";
const PROFILE_1 = "p1111111-1111-4111-8111-111111111111";
const PROFILE_2 = "p2222222-2222-4222-8222-222222222222";
const OPERATOR_1 = "u1111111-1111-4111-8111-111111111111";
const TEST_DATE = "2026-08-20";

function createSupabase(seed: Partial<Record<"services" | "driver_profiles" | "assignments" | "trip_groups" | "daily_availability_confirmations", Row[]>> = {}) {
  const tables: Record<string, Row[]> = {
    services: [...(seed.services ?? [])],
    driver_profiles: [...(seed.driver_profiles ?? [])],
    assignments: [...(seed.assignments ?? [])],
    trip_groups: [...(seed.trip_groups ?? [])],
    daily_availability_confirmations: [...(seed.daily_availability_confirmations ?? [])],
    status_events: [],
    driver_assignment_history: [],
  };

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
            const inserted = { id: `grp-${tables.trip_groups.length + 1}`, status: "active", ...row };
            tables.trip_groups.push(inserted);
            return { select: () => ({ single: () => Promise.resolve({ data: inserted, error: null }) }) };
          }
          if (table === "assignments") {
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

  return { admin, tables };
}

const mocks = vi.hoisted(() => ({ logAssignmentChange: vi.fn(), updateLearnedPatterns: vi.fn() }));
vi.mock("@/lib/server/learned-patterns", () => ({ updateLearnedPatterns: mocks.updateLearnedPatterns }));
vi.mock("@/lib/server/assignment-history", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/assignment-history")>("@/lib/server/assignment-history");
  return { ...actual, logAssignmentChange: mocks.logAssignmentChange };
});

import { assignServiceCore } from "@/lib/server/assign-service-core";

function serviceRow(overrides: Row = {}): Row {
  return {
    id: SERVICE_1, tenant_id: TENANT_A, date: TEST_DATE, status: "new", is_draft: false,
    time: "10:00:00", pickup_hotel: null, direction: "departure", hotel_id: null,
    meeting_point: "Ischia Porto", booking_service_kind: null, service_type_code: null,
    vessel: "SNAV", barca_compagnia: null, pax: 2, ...overrides,
  };
}

function baseSeed(overrides: Parameters<typeof createSupabase>[0] = {}) {
  return createSupabase({
    daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
    driver_profiles: [
      { id: PROFILE_1, tenant_id: TENANT_A, active: true },
      { id: PROFILE_2, tenant_id: TENANT_A, active: true },
    ],
    ...overrides,
  });
}

async function lastEntry(): Promise<Row> {
  await new Promise((resolve) => setImmediate(resolve));
  const calls = mocks.logAssignmentChange.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const entries = calls[calls.length - 1]![1] as Row[];
  return entries[0]!;
}

describe("assignServiceCore — decision metadata v2 (ML Data Collection Sprint 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logAssignmentChange.mockResolvedValue(undefined);
    mocks.updateLearnedPatterns.mockResolvedValue({ upserted: 0 });
  });

  it("7. nessun source passato: default riusa assignment_source esistente (manual_assign_service)", async () => {
    const fake = baseSeed({ services: [serviceRow()] });
    await assignServiceCore(fake.admin as never, {
      tenantId: TENANT_A, userId: OPERATOR_1, serviceId: SERVICE_1, driverProfileId: PROFILE_1, vehicleLabel: "Van 8",
    });
    const entry = await lastEntry();
    expect((entry.features as Row).source).toBe("manual_assign_service");
  });

  it("8. source passato dal chiamante (es. MCP) sovrascrive il default", async () => {
    const fake = baseSeed({ services: [serviceRow()] });
    await assignServiceCore(fake.admin as never, {
      tenantId: TENANT_A, userId: OPERATOR_1, serviceId: SERVICE_1, driverProfileId: PROFILE_1, vehicleLabel: "Van 8",
      source: "mcp",
    });
    const entry = await lastEntry();
    expect((entry.features as Row).source).toBe("mcp");
  });

  it("6. nessuna assegnazione precedente (fresh assign): was_override = false", async () => {
    const fake = baseSeed({ services: [serviceRow()] });
    await assignServiceCore(fake.admin as never, {
      tenantId: TENANT_A, userId: OPERATOR_1, serviceId: SERVICE_1, driverProfileId: PROFILE_1, vehicleLabel: "Van 8",
    });
    const entry = await lastEntry();
    expect((entry.features as Row).was_override).toBe(false);
  });

  it("8. driver diverso da quello precedente: was_override = true (override reale)", async () => {
    const fake = baseSeed({
      services: [serviceRow({ status: "assigned" })],
      trip_groups: [{ id: "grp-1", tenant_id: TENANT_A, driver_profile_id: PROFILE_1, vehicle_label: "Van 8" }],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: "grp-1", driver_profile_id: PROFILE_1, vehicle_label: "Van 8" }],
    });
    await assignServiceCore(fake.admin as never, {
      tenantId: TENANT_A, userId: OPERATOR_1, serviceId: SERVICE_1, driverProfileId: PROFILE_2, vehicleLabel: "Van 8",
    });
    const entry = await lastEntry();
    expect((entry.features as Row).was_override).toBe(true);
  });

  it("11. proposalId/chosenRank/candidateSnapshot propagati fino a features quando forniti", async () => {
    const fake = baseSeed({ services: [serviceRow()] });
    const candidateSnapshot = [
      { driver_profile_id: PROFILE_1, score: 1, rank: 1, hard_ok: true as const },
      { driver_profile_id: PROFILE_2, score: 5, rank: 2, hard_ok: true as const },
    ];
    await assignServiceCore(fake.admin as never, {
      tenantId: TENANT_A, userId: OPERATOR_1, serviceId: SERVICE_1, driverProfileId: PROFILE_1, vehicleLabel: "Van 8",
      proposalId: "prop-123", chosenRank: 1, candidateSnapshot,
    });
    const entry = await lastEntry();
    const features = entry.features as Row;
    expect(features.proposal_id).toBe("prop-123");
    expect(features.chosen_rank).toBe(1);
    expect(features.candidates).toEqual(candidateSnapshot);
    expect(features.candidate_count).toBe(2);
  });

  it("chiamata invariata (nessun campo v2 passato): comportamento pre-Sprint-2 preservato, proposal_id null", async () => {
    const fake = baseSeed({ services: [serviceRow()] });
    const res = await assignServiceCore(fake.admin as never, {
      tenantId: TENANT_A, userId: OPERATOR_1, serviceId: SERVICE_1, driverProfileId: PROFILE_1, vehicleLabel: "Van 8",
    });
    expect(res.status).toBe(200);
    const entry = await lastEntry();
    const features = entry.features as Row;
    expect(features.proposal_id).toBeNull();
    expect(features.candidates).toBeNull();
    expect(features.candidate_count).toBeNull();
    expect(features.chosen_rank).toBeNull();
  });
});
