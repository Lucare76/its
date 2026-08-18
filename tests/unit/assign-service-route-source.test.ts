import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * ML Data Collection Sprint 3 — chiusura bypass P0-1/P0-2.
 *
 * bus-tours e map ora chiamano POST /api/ops/assign-service con un campo
 * "source" opzionale ("bus_tours"/"map"). Questi test verificano che:
 * - source valido viene propagato fino a driver_assignment_history.features;
 * - source non in whitelist viene ignorato (mai un valore libero dal client
 *   dentro il dataset ML);
 * - i chiamanti esistenti che non passano source restano invariati;
 * - la history viene comunque generata (stesso comportamento del core,
 *   invariato — assign-service-core-decision-metadata.test.ts copre già
 *   was_override/fresh-assign in dettaglio, qui si verifica solo il
 *   nuovo campo source e che il path resti quello canonico).
 */

type Row = Record<string, unknown>;

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVICE_1 = "a1111111-1111-4111-8111-111111111111";
const PROFILE_1 = "p1111111-1111-4111-8111-111111111111";
const OPERATOR_1 = "u1111111-1111-4111-8111-111111111111";
const TEST_DATE = "2026-08-25";

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
        delete() { return { eq: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }) }; },
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

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  logAssignmentChange: vi.fn(),
  updateLearnedPatterns: vi.fn(),
}));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorizePricingRequest }));
vi.mock("@/lib/server/learned-patterns", () => ({ updateLearnedPatterns: mocks.updateLearnedPatterns }));
vi.mock("@/lib/server/assignment-history", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/assignment-history")>("@/lib/server/assignment-history");
  return { ...actual, logAssignmentChange: mocks.logAssignmentChange };
});

import { POST } from "@/app/api/ops/assign-service/route";

function serviceRow(overrides: Row = {}): Row {
  return {
    id: SERVICE_1, tenant_id: TENANT_A, date: TEST_DATE, status: "new", is_draft: false,
    time: "10:00:00", pickup_hotel: null, direction: "departure", hotel_id: null,
    meeting_point: "Ischia Porto", booking_service_kind: null, service_type_code: null,
    vessel: "SNAV", barca_compagnia: null, pax: 2, ...overrides,
  };
}

function baseSeed() {
  return createSupabase({
    daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
    driver_profiles: [{ id: PROFILE_1, tenant_id: TENANT_A, active: true }],
    services: [serviceRow()],
  });
}

function authorizeAs(fake: ReturnType<typeof createSupabase>) {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: OPERATOR_1, email: `${OPERATOR_1}@test.dev` },
    membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
  });
}

function callPost(body: Record<string, unknown>) {
  const request = new NextRequest("http://localhost:3010/api/ops/assign-service", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
  return POST(request);
}

async function lastFeatures(): Promise<Row> {
  await new Promise((resolve) => setImmediate(resolve));
  const calls = mocks.logAssignmentChange.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const entries = calls[calls.length - 1]![1] as Row[];
  return entries[0]!.features as Row;
}

describe("POST /api/ops/assign-service — source forwarding (ML Data Collection Sprint 3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logAssignmentChange.mockResolvedValue(undefined);
    mocks.updateLearnedPatterns.mockResolvedValue({ upserted: 0 });
  });

  it("1. source=bus_tours viene propagato fino a features.source", async () => {
    const fake = baseSeed();
    authorizeAs(fake);
    const res = await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1, vehicle_label: "Bus 1", source: "bus_tours" });
    expect(res.status).toBe(200);
    const features = await lastFeatures();
    expect(features.source).toBe("bus_tours");
  });

  it("2. source=map viene propagato fino a features.source", async () => {
    const fake = baseSeed();
    authorizeAs(fake);
    await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1, vehicle_label: "CAR", source: "map" });
    const features = await lastFeatures();
    expect(features.source).toBe("map");
  });

  it("3. nessun source passato: comportamento invariato, default del core (manual_assign_service)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);
    await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 8" });
    const features = await lastFeatures();
    expect(features.source).toBe("manual_assign_service");
  });

  it("4. source non whitelisted viene ignorato, non finisce nel dataset ML", async () => {
    const fake = baseSeed();
    authorizeAs(fake);
    await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 8", source: "qualcosa_di_arbitrario" });
    const features = await lastFeatures();
    expect(features.source).toBe("manual_assign_service");
    expect(features.source).not.toBe("qualcosa_di_arbitrario");
  });

  it("5. history generata (driver_assignment_history) per bus-tours/map esattamente come per gli altri chiamanti del core", async () => {
    const fake = baseSeed();
    authorizeAs(fake);
    const res = await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1, vehicle_label: "Bus 1", source: "bus_tours" });
    expect(res.status).toBe(200);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
  });

  it("6. nessuna PII nel payload features quando source e' bus_tours/map", async () => {
    const fake = baseSeed();
    authorizeAs(fake);
    await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1, vehicle_label: "Bus 1", source: "bus_tours" });
    const features = await lastFeatures();
    const text = JSON.stringify(features).toLowerCase();
    expect(text).not.toMatch(/customer_name|phone|email|notes|passenger_name|address/);
  });
});
