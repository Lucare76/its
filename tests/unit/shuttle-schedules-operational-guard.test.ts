import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function isoDate(offsetDays: number) {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const TODAY = isoDate(0);
const YESTERDAY = isoDate(-1);
const TOMORROW = isoDate(1);

type Row = Record<string, unknown>;

// In-memory fake Supabase admin client. Unlike a client that always returns a
// fixed payload, this one actually applies .eq()/.is()/.in()/.gte() as row
// filters against seeded data, so tests prove the guard's query filters (in
// particular tenant_id) are what determines the result — not just that some
// mock resolved truthy.
function createFakeSupabase(seed: { services?: Row[]; assignments?: Row[] } = {}) {
  const services = [...(seed.services ?? [])];
  const assignments = [...(seed.assignments ?? [])];
  const calls = {
    delete: 0,
    insert: 0,
    servicesSelect: 0,
    assignmentsSelect: 0,
  };
  let servicesSelectError: { message: string } | null = null;
  let assignmentsSelectError: { message: string } | null = null;

  function makeSelectBuilder(table: "services" | "assignments", rows: Row[]) {
    let filtered = rows;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      is(field: string, value: null) {
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      in(field: string, values: unknown[]) {
        filtered = filtered.filter((row) => values.includes(row[field]));
        return builder;
      },
      gte(field: string, value: unknown) {
        filtered = filtered.filter((row) => (row[field] as string) >= (value as string));
        return builder;
      },
      limit(_count: number) {
        return builder;
      },
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        const error = table === "services" ? servicesSelectError : assignmentsSelectError;
        const result = error ? { data: null, error } : { data: filtered, error: null };
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return builder;
  }

  function makeDeleteBuilder() {
    const builder = {
      eq() {
        return builder;
      },
      gte() {
        return builder;
      },
      is() {
        return builder;
      },
      then(resolve: (v: { error: null }) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve({ error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      if (table === "services") {
        return {
          select(_cols: string) {
            calls.servicesSelect++;
            return makeSelectBuilder("services", services);
          },
          delete() {
            calls.delete++;
            return makeDeleteBuilder();
          },
          insert(_rows: unknown) {
            calls.insert++;
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "assignments") {
        return {
          select(_cols: string) {
            calls.assignmentsSelect++;
            return makeSelectBuilder("assignments", assignments);
          },
        };
      }
      throw new Error(`Unexpected table in test fake: ${table}`);
    },
  };

  return {
    admin,
    calls,
    setServicesSelectError(message: string) {
      servicesSelectError = { message };
    },
    setAssignmentsSelectError(message: string) {
      assignmentsSelectError = { message };
    },
  };
}

const mocks = vi.hoisted(() => ({
  authorizeServiceRoleRequest: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizeServiceRoleRequest: mocks.authorizeServiceRoleRequest,
}));

import { PATCH, DELETE } from "@/app/api/shuttle-schedules/[id]/route";
import { buildShuttleScheduleId } from "@/lib/shuttle-schedules";

const SCHEDULE_KEY = {
  hotel_id: null,
  booking_service_kind: "navetta" as const,
  customer_name: "Hotel Test",
  direction: "departure" as const,
  departure_time: "09:30",
  meeting_point: null,
  vessel: "Navetta",
};

const SCHEDULE_ID = buildShuttleScheduleId(SCHEDULE_KEY);

const VALID_PATCH_PAYLOAD = {
  hotel_id: null,
  booking_service_kind: "navetta",
  customer_name: "Hotel Test",
  direction: "departure",
  departure_time: "09:30",
  meeting_point: null,
  vessel: "Navetta",
  valid_from: TODAY,
  valid_to: TOMORROW,
  days_of_week: null,
  notes: null,
};

function makePatchRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/shuttle-schedules/x", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}

function makeDeleteRequest() {
  return new NextRequest("http://localhost:3010/api/shuttle-schedules/x", {
    method: "DELETE",
    headers: { authorization: "Bearer test-token" },
  });
}

function callPatch(id: string, body: Record<string, unknown>) {
  return PATCH(makePatchRequest(body), { params: Promise.resolve({ id }) });
}

function callDelete(id: string) {
  return DELETE(makeDeleteRequest(), { params: Promise.resolve({ id }) });
}

function baseService(overrides: Row = {}): Row {
  return {
    id: `svc-${Math.random().toString(36).slice(2)}`,
    tenant_id: TENANT_A,
    date: TOMORROW,
    direction: SCHEDULE_KEY.direction,
    time: SCHEDULE_KEY.departure_time,
    customer_name: SCHEDULE_KEY.customer_name,
    vessel: SCHEDULE_KEY.vessel,
    hotel_id: SCHEDULE_KEY.hotel_id,
    meeting_point: SCHEDULE_KEY.meeting_point,
    booking_service_kind: SCHEDULE_KEY.booking_service_kind,
    status: "new",
    ...overrides,
  };
}

describe("PATCH/DELETE /api/shuttle-schedules/[id] — operational guard (F-01 mitigation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. PATCH senza corse operative procede normalmente (200, delete+insert eseguiti)", async () => {
    const fake = createFakeSupabase({ services: [baseService()], assignments: [] });
    mocks.authorizeServiceRoleRequest.mockResolvedValue({
      admin: fake.admin,
      user: { id: "user-1", email: "op@test.dev" },
      membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
    });

    const res = await callPatch(SCHEDULE_ID, VALID_PATCH_PAYLOAD);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.delete).toBe(1);
    expect(fake.calls.insert).toBe(1);
  });

  it("2. PATCH con corsa futura assegnata (assignments) → 409, nessun delete/insert", async () => {
    const service = baseService();
    const fake = createFakeSupabase({
      services: [service],
      assignments: [{ id: "a1", tenant_id: TENANT_A, service_id: service.id }],
    });
    mocks.authorizeServiceRoleRequest.mockResolvedValue({
      admin: fake.admin,
      user: { id: "user-1", email: "op@test.dev" },
      membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
    });

    const res = await callPatch(SCHEDULE_ID, VALID_PATCH_PAYLOAD);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("SHUTTLE_HAS_OPERATIONAL_SERVICES");
    expect(fake.calls.delete).toBe(0);
    expect(fake.calls.insert).toBe(0);
  });

  it("3. PATCH con corsa futura status != new → 409, nessun delete/insert", async () => {
    const fake = createFakeSupabase({
      services: [baseService({ status: "confirmed" })],
      assignments: [],
    });
    mocks.authorizeServiceRoleRequest.mockResolvedValue({
      admin: fake.admin,
      user: { id: "user-1", email: "op@test.dev" },
      membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
    });

    const res = await callPatch(SCHEDULE_ID, VALID_PATCH_PAYLOAD);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("SHUTTLE_HAS_OPERATIONAL_SERVICES");
    expect(fake.calls.delete).toBe(0);
    expect(fake.calls.insert).toBe(0);
  });

  it("4. DELETE senza corse operative procede normalmente (200, delete eseguito)", async () => {
    const fake = createFakeSupabase({ services: [baseService()], assignments: [] });
    mocks.authorizeServiceRoleRequest.mockResolvedValue({
      admin: fake.admin,
      user: { id: "user-1", email: "op@test.dev" },
      membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
    });

    const res = await callDelete(SCHEDULE_ID);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.delete).toBe(1);
  });

  it("5. DELETE con corsa futura assegnata (assignments) → 409, nessun delete", async () => {
    const service = baseService();
    const fake = createFakeSupabase({
      services: [service],
      assignments: [{ id: "a1", tenant_id: TENANT_A, service_id: service.id }],
    });
    mocks.authorizeServiceRoleRequest.mockResolvedValue({
      admin: fake.admin,
      user: { id: "user-1", email: "op@test.dev" },
      membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
    });

    const res = await callDelete(SCHEDULE_ID);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("SHUTTLE_HAS_OPERATIONAL_SERVICES");
    expect(fake.calls.delete).toBe(0);
  });

  it("6. DELETE con corsa futura status != new → 409, nessun delete", async () => {
    const fake = createFakeSupabase({
      services: [baseService({ status: "in_progress" })],
      assignments: [],
    });
    mocks.authorizeServiceRoleRequest.mockResolvedValue({
      admin: fake.admin,
      user: { id: "user-1", email: "op@test.dev" },
      membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
    });

    const res = await callDelete(SCHEDULE_ID);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("SHUTTLE_HAS_OPERATIONAL_SERVICES");
    expect(fake.calls.delete).toBe(0);
  });

  it("7. Corsa del giorno corrente con assignment blocca l'operazione (date >= oggi inclusiva)", async () => {
    const service = baseService({ date: TODAY });
    const fake = createFakeSupabase({
      services: [service],
      assignments: [{ id: "a1", tenant_id: TENANT_A, service_id: service.id }],
    });
    mocks.authorizeServiceRoleRequest.mockResolvedValue({
      admin: fake.admin,
      user: { id: "user-1", email: "op@test.dev" },
      membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
    });

    const res = await callDelete(SCHEDULE_ID);

    expect(res.status).toBe(409);
    expect(fake.calls.delete).toBe(0);
  });

  it("8. Corsa passata con assignment NON blocca (esclusa dal filtro date >= oggi)", async () => {
    const pastService = baseService({ date: YESTERDAY });
    const fake = createFakeSupabase({
      services: [pastService],
      assignments: [{ id: "a1", tenant_id: TENANT_A, service_id: pastService.id }],
    });
    mocks.authorizeServiceRoleRequest.mockResolvedValue({
      admin: fake.admin,
      user: { id: "user-1", email: "op@test.dev" },
      membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
    });

    const res = await callDelete(SCHEDULE_ID);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.delete).toBe(1);
  });

  it("9. Tenant isolation: assignments/servizi operativi di un altro tenant non influenzano il tenant autenticato", async () => {
    // Seed operational data (assignment + non-new status) that matches the same
    // schedule key but belongs entirely to TENANT_B. The request is authenticated
    // as TENANT_A and must NOT be blocked by TENANT_B's data.
    const tenantBService = baseService({ tenant_id: TENANT_B, status: "confirmed" });
    const tenantAService = baseService({ tenant_id: TENANT_A, status: "new" });
    const fake = createFakeSupabase({
      services: [tenantBService, tenantAService],
      assignments: [{ id: "a1", tenant_id: TENANT_B, service_id: tenantBService.id }],
    });
    mocks.authorizeServiceRoleRequest.mockResolvedValue({
      admin: fake.admin,
      user: { id: "user-1", email: "op@test.dev" },
      membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
    });

    const res = await callDelete(SCHEDULE_ID);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.delete).toBe(1);
  });

  it("10a. Errore Supabase sulla query services → fail closed (nessun delete/insert), operazione non consentita", async () => {
    const fake = createFakeSupabase({ services: [baseService()], assignments: [] });
    fake.setServicesSelectError("connection reset");
    mocks.authorizeServiceRoleRequest.mockResolvedValue({
      admin: fake.admin,
      user: { id: "user-1", email: "op@test.dev" },
      membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
    });

    const res = await callDelete(SCHEDULE_ID);

    expect(res.status).toBe(500);
    expect(fake.calls.delete).toBe(0);
  });

  it("10b. Errore Supabase sulla query assignments → fail closed (nessun delete/insert), operazione non consentita", async () => {
    const fake = createFakeSupabase({ services: [baseService()], assignments: [] });
    fake.setAssignmentsSelectError("connection reset");
    mocks.authorizeServiceRoleRequest.mockResolvedValue({
      admin: fake.admin,
      user: { id: "user-1", email: "op@test.dev" },
      membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
    });

    const res = await callDelete(SCHEDULE_ID);

    expect(res.status).toBe(500);
    expect(fake.calls.delete).toBe(0);
  });

  it("10c. Errore Supabase sulla query services in PATCH → fail closed, nessun delete/insert", async () => {
    const fake = createFakeSupabase({ services: [baseService()], assignments: [] });
    fake.setServicesSelectError("timeout");
    mocks.authorizeServiceRoleRequest.mockResolvedValue({
      admin: fake.admin,
      user: { id: "user-1", email: "op@test.dev" },
      membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
    });

    const res = await callPatch(SCHEDULE_ID, VALID_PATCH_PAYLOAD);

    expect(res.status).toBe(500);
    expect(fake.calls.delete).toBe(0);
    expect(fake.calls.insert).toBe(0);
  });

  it("il guard interroga davvero services e assignments (nessun falso positivo da mock inerte)", async () => {
    const service = baseService();
    const fake = createFakeSupabase({
      services: [service],
      assignments: [{ id: "a1", tenant_id: TENANT_A, service_id: service.id }],
    });
    mocks.authorizeServiceRoleRequest.mockResolvedValue({
      admin: fake.admin,
      user: { id: "user-1", email: "op@test.dev" },
      membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
    });

    await callDelete(SCHEDULE_ID);

    expect(fake.calls.servicesSelect).toBeGreaterThan(0);
    expect(fake.calls.assignmentsSelect).toBeGreaterThan(0);
  });
});
