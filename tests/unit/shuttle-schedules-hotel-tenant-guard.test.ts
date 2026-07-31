import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOTEL_A_ID = "11111111-1111-4111-8111-111111111111";
const HOTEL_B_ID = "22222222-2222-4222-8222-222222222222";

function isoDate(offsetDays: number) {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const TODAY = isoDate(0);
const TOMORROW = isoDate(1);

type Row = Record<string, unknown>;

// In-memory fake Supabase admin client covering the three tables involved:
// "hotels" (the new tenant-ownership guard), "services" (F-01 guard + writes),
// and "assignments" (F-01 guard). Filters (.eq/.is/.in/.gte) are applied for
// real against seeded rows, so a passing test proves the actual query
// arguments — not just that some mock resolved truthy.
function createFakeSupabase(
  seed: { hotels?: Row[]; services?: Row[]; assignments?: Row[] } = {}
) {
  const hotels = [...(seed.hotels ?? [])];
  const services = [...(seed.services ?? [])];
  const assignments = [...(seed.assignments ?? [])];
  const calls = {
    hotelsSelect: 0,
    servicesSelect: 0,
    assignmentsSelect: 0,
    delete: 0,
    insert: 0,
  };
  let hotelsSelectError: { message: string } | null = null;
  let servicesSelectError: { message: string } | null = null;

  function makeSelectBuilder(kind: "hotels" | "services" | "assignments", rows: Row[]) {
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
      order() {
        return builder;
      },
      range() {
        return builder;
      },
      then(
        resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown,
        reject?: (e: unknown) => unknown
      ) {
        const error = kind === "hotels" ? hotelsSelectError : kind === "services" ? servicesSelectError : null;
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
      if (table === "hotels") {
        return {
          select(_cols: string) {
            calls.hotelsSelect++;
            return makeSelectBuilder("hotels", hotels);
          },
        };
      }
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
    setHotelsSelectError(message: string) {
      hotelsSelectError = { message };
    },
    setServicesSelectError(message: string) {
      servicesSelectError = { message };
    },
  };
}

const mocks = vi.hoisted(() => ({
  authorizeServiceRoleRequest: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizeServiceRoleRequest: mocks.authorizeServiceRoleRequest,
}));

import { POST } from "@/app/api/shuttle-schedules/route";
import { PATCH } from "@/app/api/shuttle-schedules/[id]/route";
import { buildShuttleScheduleId } from "@/lib/shuttle-schedules";

const SCHEDULE_KEY = {
  hotel_id: HOTEL_A_ID,
  booking_service_kind: "navetta" as const,
  customer_name: "Hotel Test",
  direction: "departure" as const,
  departure_time: "09:30",
  meeting_point: null,
  vessel: "Navetta",
};

const SCHEDULE_ID = buildShuttleScheduleId(SCHEDULE_KEY);

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    hotel_id: HOTEL_A_ID,
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
    ...overrides,
  };
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

function makePostRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/shuttle-schedules", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}

function makePatchRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/shuttle-schedules/x", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}

function callPost(body: Record<string, unknown>) {
  return POST(makePostRequest(body));
}

function callPatch(id: string, body: Record<string, unknown>) {
  return PATCH(makePatchRequest(body), { params: Promise.resolve({ id }) });
}

function authorizeAs(tenantId: string, fake: ReturnType<typeof createFakeSupabase>) {
  mocks.authorizeServiceRoleRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: tenantId, role: "operator", suspended: false },
  });
}

describe("POST/PATCH /api/shuttle-schedules — hotel tenant guard (F-10 mitigation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. POST con hotel_id del tenant autenticato procede normalmente (insert eseguito)", async () => {
    const fake = createFakeSupabase({ hotels: [{ id: HOTEL_A_ID, tenant_id: TENANT_A }] });
    authorizeAs(TENANT_A, fake);

    const res = await callPost(basePayload({ hotel_id: HOTEL_A_ID }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.hotelsSelect).toBe(1);
    expect(fake.calls.insert).toBe(1);
  });

  it("2. POST con hotel_id di un altro tenant → 400, nessun insert", async () => {
    const fake = createFakeSupabase({ hotels: [{ id: HOTEL_B_ID, tenant_id: TENANT_B }] });
    authorizeAs(TENANT_A, fake);

    const res = await callPost(basePayload({ hotel_id: HOTEL_B_ID }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("INVALID_HOTEL_FOR_TENANT");
    expect(fake.calls.insert).toBe(0);
  });

  it("3. POST con hotel_id null → nessuna query hotels, comportamento invariato", async () => {
    const fake = createFakeSupabase({});
    authorizeAs(TENANT_A, fake);

    const res = await callPost(basePayload({ hotel_id: null }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.hotelsSelect).toBe(0);
    expect(fake.calls.insert).toBe(1);
  });

  it("4. POST senza hotel_id (omesso) → nessuna query hotels, comportamento invariato", async () => {
    const fake = createFakeSupabase({});
    authorizeAs(TENANT_A, fake);

    const { hotel_id: _omit, ...payload } = basePayload();
    const res = await callPost(payload);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.hotelsSelect).toBe(0);
    expect(fake.calls.insert).toBe(1);
  });

  it("5. PATCH con hotel_id del tenant autenticato procede normalmente e passa anche il guard F-01 (delete+insert)", async () => {
    const fake = createFakeSupabase({
      hotels: [{ id: HOTEL_A_ID, tenant_id: TENANT_A }],
      services: [baseService()],
      assignments: [],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPatch(SCHEDULE_ID, basePayload({ hotel_id: HOTEL_A_ID }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.hotelsSelect).toBe(1);
    expect(fake.calls.delete).toBe(1);
    expect(fake.calls.insert).toBe(1);
  });

  it("6. PATCH con hotel_id di un altro tenant → 400, nessun delete/insert, guard F-01 mai raggiunto", async () => {
    const fake = createFakeSupabase({
      hotels: [{ id: HOTEL_B_ID, tenant_id: TENANT_B }],
      services: [baseService()],
      assignments: [{ id: "a1", tenant_id: TENANT_A, service_id: "irrelevant" }],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPatch(SCHEDULE_ID, basePayload({ hotel_id: HOTEL_B_ID }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("INVALID_HOTEL_FOR_TENANT");
    expect(fake.calls.delete).toBe(0);
    expect(fake.calls.insert).toBe(0);
    // Proves ordering: the F-01 guard's own reads never ran because the hotel
    // check short-circuited the handler first.
    expect(fake.calls.servicesSelect).toBe(0);
    expect(fake.calls.assignmentsSelect).toBe(0);
  });

  it("7. PATCH con hotel_id null → nessuna query hotels, comportamento invariato (delete+insert normali)", async () => {
    const fake = createFakeSupabase({
      services: [baseService()],
      assignments: [],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPatch(SCHEDULE_ID, basePayload({ hotel_id: null }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.hotelsSelect).toBe(0);
    expect(fake.calls.delete).toBe(1);
    expect(fake.calls.insert).toBe(1);
  });

  it("8. Errore Supabase sulla query hotels in POST → fail closed, nessun insert", async () => {
    const fake = createFakeSupabase({ hotels: [{ id: HOTEL_A_ID, tenant_id: TENANT_A }] });
    fake.setHotelsSelectError("connection reset");
    authorizeAs(TENANT_A, fake);

    const res = await callPost(basePayload({ hotel_id: HOTEL_A_ID }));

    expect(res.status).toBe(500);
    expect(fake.calls.insert).toBe(0);
  });

  it("9. Errore Supabase sulla query hotels in PATCH → fail closed, nessun delete/insert, guard F-01 mai raggiunto", async () => {
    const fake = createFakeSupabase({
      hotels: [{ id: HOTEL_A_ID, tenant_id: TENANT_A }],
      services: [baseService()],
      assignments: [],
    });
    fake.setHotelsSelectError("timeout");
    authorizeAs(TENANT_A, fake);

    const res = await callPatch(SCHEDULE_ID, basePayload({ hotel_id: HOTEL_A_ID }));

    expect(res.status).toBe(500);
    expect(fake.calls.delete).toBe(0);
    expect(fake.calls.insert).toBe(0);
    expect(fake.calls.servicesSelect).toBe(0);
    expect(fake.calls.assignmentsSelect).toBe(0);
  });

  it("10a. Tenant isolation reale nel fake: tenant A non può usare un hotel esistente solo per tenant B", async () => {
    const fake = createFakeSupabase({
      hotels: [
        { id: HOTEL_A_ID, tenant_id: TENANT_A },
        { id: HOTEL_B_ID, tenant_id: TENANT_B },
      ],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPost(basePayload({ hotel_id: HOTEL_B_ID }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("INVALID_HOTEL_FOR_TENANT");
  });

  it("10b. Tenant isolation reale nel fake: tenant A può usare il proprio hotel anche quando coesiste un hotel omonimo di tenant B", async () => {
    const fake = createFakeSupabase({
      hotels: [
        { id: HOTEL_A_ID, tenant_id: TENANT_A },
        { id: HOTEL_B_ID, tenant_id: TENANT_B },
      ],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPost(basePayload({ hotel_id: HOTEL_A_ID }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("11. Verifica ordine: nel PATCH il tenantId usato dal guard hotel proviene da auth.membership.tenant_id, non dal payload", async () => {
    // Even though the request body carries no tenant identifier at all (there is
    // none to smuggle in patchSchema), this asserts the guard call uses the
    // authenticated tenant by proving a hotel owned by the authenticated tenant
    // succeeds while the same hotel id fails once membership switches tenant.
    const fakeA = createFakeSupabase({
      hotels: [{ id: HOTEL_A_ID, tenant_id: TENANT_A }],
      services: [baseService()],
      assignments: [],
    });
    authorizeAs(TENANT_A, fakeA);
    const resA = await callPatch(SCHEDULE_ID, basePayload({ hotel_id: HOTEL_A_ID }));
    expect(resA.status).toBe(200);

    const fakeB = createFakeSupabase({
      hotels: [{ id: HOTEL_A_ID, tenant_id: TENANT_A }],
      services: [baseService({ tenant_id: TENANT_B })],
      assignments: [],
    });
    authorizeAs(TENANT_B, fakeB);
    const resB = await callPatch(SCHEDULE_ID, basePayload({ hotel_id: HOTEL_A_ID }));
    const bodyB = await resB.json();

    expect(resB.status).toBe(400);
    expect(bodyB.error).toBe("INVALID_HOTEL_FOR_TENANT");
  });
});
