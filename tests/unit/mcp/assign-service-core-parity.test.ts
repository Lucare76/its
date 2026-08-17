import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * Parity/regression test richiesto esplicitamente per l'estrazione Sprint 2:
 * dimostra che la route HTTP /api/ops/assign-service e assignServiceCore
 * (usato direttamente da its.assign_driver) producono l'ESATTO stesso esito
 * per lo stesso scenario — perché la route ora e' un adapter sottile che
 * chiama assignServiceCore, non due implementazioni parallele.
 */

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVICE_X = "a1111111-1111-4111-8111-111111111111";
const SERVICE_OTHER = "a1111111-1111-4111-8111-111111111112";
const DRIVER_A = "d1111111-1111-4111-8111-111111111111";
const PROFILE_A = "p1111111-1111-4111-8111-111111111111";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

function createTenantAwareSupabase(
  seed: Partial<Record<
    "services" | "memberships" | "driver_profiles" | "assignments" | "trip_groups" | "daily_availability_confirmations" | "status_events",
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
    driver_assignment_history: [],
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
            return { select() { return { single: () => Promise.resolve({ data: inserted, error: null }) }; } };
          }
          if (table === "assignments") {
            const inserted = { id: `asg-${tables.assignments.length + 1}`, ...row };
            tables.assignments.push(inserted);
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

  return { admin, tables };
}

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
    memberships: [{ tenant_id: TENANT_A, user_id: DRIVER_A, role: "driver", suspended: false }],
    driver_profiles: [{ id: PROFILE_A, tenant_id: TENANT_A, user_id: null, active: true }],
    ...overrides,
  });
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  auditLog: vi.fn(),
}));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorizePricingRequest }));
vi.mock("@/lib/server/ops-audit", () => ({ auditLog: mocks.auditLog }));

import { POST } from "@/app/api/ops/assign-service/route";
import { assignServiceCore } from "@/lib/server/assign-service-core";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/ops/assign-service", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}

function authorizeAs(fake: ReturnType<typeof createTenantAwareSupabase>, role = "operator") {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: TENANT_A, role, suspended: false },
  });
}

describe("parity: route HTTP vs assignServiceCore (stesso core, Sprint 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scenario 'autista libero': route e core producono status/body identici", async () => {
    const fakeForRoute = baseSeed();
    authorizeAs(fakeForRoute);
    const routeRes = await POST(makeRequest({ service_id: SERVICE_X, driver_user_id: DRIVER_A, driver_profile_id: PROFILE_A }));
    const routeBody = await routeRes.json();

    const fakeForCore = baseSeed();
    const coreRes = await assignServiceCore(fakeForCore.admin, {
      tenantId: TENANT_A,
      userId: "user-1",
      serviceId: SERVICE_X,
      driverUserId: DRIVER_A,
      driverProfileId: PROFILE_A,
      action: "assign",
    });

    expect(routeRes.status).toBe(coreRes.status);
    expect(routeBody.ok).toBe(coreRes.body.ok);
    expect(routeRes.status).toBe(200);
    expect(coreRes.status).toBe(200);
  });

  it("scenario 'autista occupato' (DRIVER_OVERLAP): route e core producono lo stesso errore, byte-per-byte", async () => {
    const overlapSeed = {
      trip_groups: [{ id: "grp-other", tenant_id: TENANT_A, date: TEST_DATE, status: "active", driver_user_id: DRIVER_A }],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: SERVICE_OTHER, group_id: "grp-other", driver_user_id: DRIVER_A }],
      services: [serviceRow(SERVICE_X), serviceRow(SERVICE_OTHER, { time: "10:00:00" })],
    };

    const fakeForRoute = baseSeed(overlapSeed);
    authorizeAs(fakeForRoute);
    const routeRes = await POST(makeRequest({ service_id: SERVICE_X, driver_user_id: DRIVER_A }));
    const routeBody = await routeRes.json();

    const fakeForCore = baseSeed(overlapSeed);
    const coreRes = await assignServiceCore(fakeForCore.admin, {
      tenantId: TENANT_A,
      userId: "user-1",
      serviceId: SERVICE_X,
      driverUserId: DRIVER_A,
      action: "assign",
    });

    expect(routeRes.status).toBe(coreRes.status);
    expect(routeBody).toEqual(coreRes.body);
    expect(routeRes.status).toBe(409);
    expect(routeBody.error).toBe("DRIVER_OVERLAP");
  });

  it("scenario 'servizio non assegnabile' (completato): route e core rifiutano identicamente", async () => {
    const notAssignableSeed = { services: [serviceRow(SERVICE_X, { status: "completato" })] };

    const fakeForRoute = baseSeed(notAssignableSeed);
    authorizeAs(fakeForRoute);
    const routeRes = await POST(makeRequest({ service_id: SERVICE_X, driver_user_id: DRIVER_A }));
    const routeBody = await routeRes.json();

    const fakeForCore = baseSeed(notAssignableSeed);
    const coreRes = await assignServiceCore(fakeForCore.admin, {
      tenantId: TENANT_A,
      userId: "user-1",
      serviceId: SERVICE_X,
      driverUserId: DRIVER_A,
      action: "assign",
    });

    expect(routeRes.status).toBe(409);
    expect(routeBody).toEqual({ ok: false, error: "SERVICE_NOT_ASSIGNABLE", message: "Il servizio non può essere assegnato nello stato attuale." });
    expect(coreRes).toEqual({ status: routeRes.status, body: routeBody });
  });
});
