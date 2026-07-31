import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOTEL_A_ID = "11111111-1111-4111-8111-111111111111";
const HOTEL_B_ID = "22222222-2222-4222-8222-222222222222";

const DISTINCTIVE_ERROR =
  "duplicate key value violates unique constraint shuttle_internal_unique_idx";

function isoDate(offsetDays: number) {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const TODAY = isoDate(0);
const TOMORROW = isoDate(1);

type Row = Record<string, unknown>;

// In-memory fake Supabase admin client covering "hotels", "services" and
// "assignments". Filters are applied for real against seeded rows; each
// write/select operation can be independently forced to fail with a
// distinctive Postgres-like error message, so tests prove the route actually
// swallows that specific message rather than merely returning some 500.
function createFakeSupabase(seed: { hotels?: Row[]; services?: Row[]; assignments?: Row[] } = {}) {
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
  let servicesDeleteError: { message: string } | null = null;
  let servicesInsertError: { message: string } | null = null;

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
      then(resolve: (v: { error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve({ error: servicesDeleteError }).then(resolve, reject);
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
            return Promise.resolve({ error: servicesInsertError });
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
    setServicesDeleteError(message: string) {
      servicesDeleteError = { message };
    },
    setServicesInsertError(message: string) {
      servicesInsertError = { message };
    },
  };
}

const mocks = vi.hoisted(() => ({
  authorizeServiceRoleRequest: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizeServiceRoleRequest: mocks.authorizeServiceRoleRequest,
}));

vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: mocks.auditLog,
}));

import { GET, POST } from "@/app/api/shuttle-schedules/route";
import { PATCH, DELETE } from "@/app/api/shuttle-schedules/[id]/route";
import { buildShuttleScheduleId } from "@/lib/shuttle-schedules";

const SCHEDULE_KEY = {
  hotel_id: null as string | null,
  booking_service_kind: "navetta" as const,
  customer_name: "Hotel Test",
  direction: "departure" as const,
  departure_time: "09:30",
  meeting_point: null,
  vessel: "Navetta",
};

const SCHEDULE_ID = buildShuttleScheduleId(SCHEDULE_KEY);

function makeGetRequest() {
  return new NextRequest("http://localhost:3010/api/shuttle-schedules", {
    method: "GET",
    headers: { authorization: "Bearer test-token" },
  });
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

function makeDeleteRequest() {
  return new NextRequest("http://localhost:3010/api/shuttle-schedules/x", {
    method: "DELETE",
    headers: { authorization: "Bearer test-token" },
  });
}

function callGet() {
  return GET(makeGetRequest());
}
function callPost(body: Record<string, unknown>) {
  return POST(makePostRequest(body));
}
function callPatch(id: string, body: Record<string, unknown>) {
  return PATCH(makePatchRequest(body), { params: Promise.resolve({ id }) });
}
function callDelete(id: string) {
  return DELETE(makeDeleteRequest(), { params: Promise.resolve({ id }) });
}

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function authorizeAs(tenantId: string, fake: ReturnType<typeof createFakeSupabase>) {
  mocks.authorizeServiceRoleRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: tenantId, role: "operator", suspended: false },
  });
}

function assertNoLeakage(bodyText: string) {
  expect(bodyText).not.toContain("duplicate key");
  expect(bodyText).not.toContain("unique constraint");
  expect(bodyText).not.toContain("shuttle_internal_unique_idx");
}

function assertNoForbiddenFields(body: Record<string, unknown>) {
  expect(body).not.toHaveProperty("details");
  expect(body).not.toHaveProperty("hint");
  expect(body).not.toHaveProperty("code");
  expect(body).not.toHaveProperty("stack");
}

describe("shuttle-schedules API — error sanitization (F-11 mitigation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. GET: errore Supabase → 500, nessun dettaglio tecnico, messaggio generico, log invocato", async () => {
    const fake = createFakeSupabase({});
    fake.setServicesSelectError(DISTINCTIVE_ERROR);
    authorizeAs(TENANT_A, fake);

    const res = await callGet();
    const rawText = await res.clone().text();
    const body = await res.json();

    expect(res.status).toBe(500);
    assertNoLeakage(rawText);
    assertNoForbiddenFields(body);
    expect(body).toEqual({ error: "Impossibile recuperare le navette." });

    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    const logged = mocks.auditLog.mock.calls[0][0];
    expect(logged.level).toBe("error");
    expect(logged.tenantId).toBe(TENANT_A);
    expect(logged.details.message).toBe(DISTINCTIVE_ERROR);
  });

  it("2. POST: errore durante la scrittura → 500, nessun dettaglio tecnico, log invocato, nessuna scrittura/lettura successiva", async () => {
    const fake = createFakeSupabase({});
    fake.setServicesInsertError(DISTINCTIVE_ERROR);
    authorizeAs(TENANT_A, fake);

    const res = await callPost(basePayload());
    const rawText = await res.clone().text();
    const body = await res.json();

    expect(res.status).toBe(500);
    assertNoLeakage(rawText);
    assertNoForbiddenFields(body);
    expect(body).toEqual({ error: "Impossibile creare la navetta." });

    // No GET(request) fallthrough after a failed insert: no extra services select.
    expect(fake.calls.servicesSelect).toBe(0);
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    const logged = mocks.auditLog.mock.calls[0][0];
    expect(logged.level).toBe("error");
    expect(logged.details.message).toBe(DISTINCTIVE_ERROR);
  });

  it("3. PATCH: errore nel flusso di aggiornamento → 500, nessun dettaglio tecnico, log invocato, nessuna operazione dopo l'errore", async () => {
    const fake = createFakeSupabase({ services: [], assignments: [] });
    fake.setServicesDeleteError(DISTINCTIVE_ERROR);
    authorizeAs(TENANT_A, fake);

    const res = await callPatch(SCHEDULE_ID, basePayload());
    const rawText = await res.clone().text();
    const body = await res.json();

    expect(res.status).toBe(500);
    assertNoLeakage(rawText);
    assertNoForbiddenFields(body);
    expect(body).toEqual({ error: "Impossibile aggiornare la navetta." });

    // Delete failed → insertRows must never run.
    expect(fake.calls.insert).toBe(0);
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    const logged = mocks.auditLog.mock.calls[0][0];
    expect(logged.level).toBe("error");
    expect(logged.details.scheduleId).toBe(SCHEDULE_ID);
    expect(logged.details.message).toBe(DISTINCTIVE_ERROR);
  });

  it("4. DELETE: errore nella cancellazione → 500, nessun dettaglio tecnico, log invocato", async () => {
    const fake = createFakeSupabase({ services: [], assignments: [] });
    fake.setServicesDeleteError(DISTINCTIVE_ERROR);
    authorizeAs(TENANT_A, fake);

    const res = await callDelete(SCHEDULE_ID);
    const rawText = await res.clone().text();
    const body = await res.json();

    expect(res.status).toBe(500);
    assertNoLeakage(rawText);
    assertNoForbiddenFields(body);
    expect(body).toEqual({ error: "Impossibile eliminare la navetta." });

    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    const logged = mocks.auditLog.mock.calls[0][0];
    expect(logged.level).toBe("error");
    expect(logged.details.scheduleId).toBe(SCHEDULE_ID);
    expect(logged.details.message).toBe(DISTINCTIVE_ERROR);
  });

  it("5. Risposte 500 non contengono mai i campi details/hint/code/stack (verifica esplicita su tutti e 4 i percorsi)", async () => {
    const fakeGet = createFakeSupabase({});
    fakeGet.setServicesSelectError(DISTINCTIVE_ERROR);
    authorizeAs(TENANT_A, fakeGet);
    assertNoForbiddenFields(await (await callGet()).json());

    const fakePost = createFakeSupabase({});
    fakePost.setServicesInsertError(DISTINCTIVE_ERROR);
    authorizeAs(TENANT_A, fakePost);
    assertNoForbiddenFields(await (await callPost(basePayload())).json());

    const fakePatch = createFakeSupabase({ services: [], assignments: [] });
    fakePatch.setServicesDeleteError(DISTINCTIVE_ERROR);
    authorizeAs(TENANT_A, fakePatch);
    assertNoForbiddenFields(await (await callPatch(SCHEDULE_ID, basePayload())).json());

    const fakeDelete = createFakeSupabase({ services: [], assignments: [] });
    fakeDelete.setServicesDeleteError(DISTINCTIVE_ERROR);
    authorizeAs(TENANT_A, fakeDelete);
    assertNoForbiddenFields(await (await callDelete(SCHEDULE_ID)).json());
  });

  // --- Regressione: status esistenti invariati ---

  it("regressione: GET con successo resta 200 con schedules", async () => {
    const fake = createFakeSupabase({ services: [] });
    authorizeAs(TENANT_A, fake);

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.schedules)).toBe(true);
  });

  it("regressione: POST con payload non valido resta 400 con messaggio di validazione originale (non generico)", async () => {
    const fake = createFakeSupabase({});
    authorizeAs(TENANT_A, fake);

    const { valid_from: _omit, ...payload } = basePayload();
    const res = await callPost(payload);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).not.toBe("Impossibile creare la navetta.");
    expect(fake.calls.insert).toBe(0);
  });

  it("regressione: PATCH con corsa operativa resta 409 SHUTTLE_HAS_OPERATIONAL_SERVICES", async () => {
    const fake = createFakeSupabase({
      services: [
        {
          id: "svc-1",
          tenant_id: TENANT_A,
          date: TOMORROW,
          direction: SCHEDULE_KEY.direction,
          time: SCHEDULE_KEY.departure_time,
          customer_name: SCHEDULE_KEY.customer_name,
          vessel: SCHEDULE_KEY.vessel,
          hotel_id: SCHEDULE_KEY.hotel_id,
          meeting_point: SCHEDULE_KEY.meeting_point,
          booking_service_kind: SCHEDULE_KEY.booking_service_kind,
          status: "confirmed",
        },
      ],
      assignments: [],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPatch(SCHEDULE_ID, basePayload());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("SHUTTLE_HAS_OPERATIONAL_SERVICES");
    expect(fake.calls.delete).toBe(0);
  });

  it("regressione: PATCH con hotel_id di un altro tenant resta 400 INVALID_HOTEL_FOR_TENANT", async () => {
    const fake = createFakeSupabase({
      hotels: [{ id: HOTEL_B_ID, tenant_id: TENANT_B }],
      services: [],
      assignments: [],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPatch(SCHEDULE_ID, basePayload({ hotel_id: HOTEL_B_ID }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("INVALID_HOTEL_FOR_TENANT");
  });

  it("regressione: POST con hotel_id valido del tenant continua a funzionare (200, insert eseguito)", async () => {
    const fake = createFakeSupabase({ hotels: [{ id: HOTEL_A_ID, tenant_id: TENANT_A }] });
    authorizeAs(TENANT_A, fake);

    const res = await callPost(basePayload({ hotel_id: HOTEL_A_ID }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.insert).toBe(1);
  });
});
