import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function isoDate(offsetDays: number) {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const TODAY = isoDate(0);
const TOMORROW = isoDate(1);

type Row = Record<string, unknown>;

function b64url(obj: unknown) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

// In-memory fake Supabase admin client covering "hotels" (still queried
// directly by the route for the F-10 guard) and the PATCH RPC
// (public.patch_shuttle_schedule, migration 0276), tracking every
// select/rpc call so tests can prove zero downstream queries/writes happen
// when the id fails validation.
function createFakeSupabase(seed: { hotels?: Row[]; services?: Row[]; assignments?: Row[] } = {}) {
  const hotels = [...(seed.hotels ?? [])];
  const services = [...(seed.services ?? [])];
  const assignments = [...(seed.assignments ?? [])];
  const calls = {
    hotelsSelect: 0,
    delete: 0,
    insert: 0,
    rpcCalls: [] as Array<{ fn: string; params: Row }>,
  };

  function makeSelectBuilder(rows: Row[]) {
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
      limit() {
        return builder;
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  function matchesOldIdentity(row: Row, p: Row) {
    return (
      row.direction === p.p_old_direction &&
      row.time === p.p_old_departure_time &&
      row.customer_name === p.p_old_customer_name &&
      row.vessel === p.p_old_vessel &&
      (row.hotel_id ?? null) === (p.p_old_hotel_id ?? null) &&
      (row.meeting_point ?? null) === (p.p_old_meeting_point ?? null) &&
      (!p.p_old_booking_service_kind || row.booking_service_kind === p.p_old_booking_service_kind)
    );
  }

  const admin = {
    from(table: string) {
      if (table === "hotels") {
        return {
          select() {
            calls.hotelsSelect++;
            return makeSelectBuilder(hotels);
          },
        };
      }
      throw new Error(`Unexpected table in test fake: ${table}`);
    },
    rpc(fn: string, params: Row) {
      calls.rpcCalls.push({ fn, params });
      if (fn !== "patch_shuttle_schedule") throw new Error(`Unexpected rpc in test fake: ${fn}`);

      const matched = services.filter(
        (row) => row.tenant_id === params.p_tenant_id && (row.date as string) >= (params.p_today as string) && matchesOldIdentity(row, params),
      );
      const blockedStatus = matched.some((row) => row.status !== "new");
      const matchedIds = new Set(matched.map((row) => row.id));
      const blockedAssignment = assignments.some((a) => a.tenant_id === params.p_tenant_id && matchedIds.has(a.service_id));
      if (blockedStatus || blockedAssignment) {
        return Promise.resolve({ data: null, error: { message: "SHUTTLE_HAS_OPERATIONAL_SERVICES" } });
      }

      calls.delete++;
      for (const row of matched) {
        const idx = services.indexOf(row);
        if (idx !== -1) services.splice(idx, 1);
      }
      calls.insert++;
      const newRows = (params.p_new_rows as Row[]) ?? [];
      for (const row of newRows) services.push({ id: `svc-${Math.random().toString(36).slice(2)}`, ...row, tenant_id: params.p_tenant_id });

      return Promise.resolve({
        data: [{ deleted_count: matched.length, deleted_date_from: null, deleted_date_to: null, deleted_weekdays: [], inserted_count: newRows.length }],
        error: null,
      });
    },
  };

  return { admin, calls };
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

import { PATCH } from "@/app/api/shuttle-schedules/[id]/route";
import { buildShuttleScheduleId } from "@/lib/shuttle-schedules";

function makePatchRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/shuttle-schedules/x", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}

function callPatch(id: string, body: Record<string, unknown>) {
  return PATCH(makePatchRequest(body), { params: Promise.resolve({ id }) });
}

function validPayload(overrides: Record<string, unknown> = {}) {
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

function assertNoDownstreamCalls(fake: ReturnType<typeof createFakeSupabase>) {
  expect(fake.calls.hotelsSelect).toBe(0);
  expect(fake.calls.rpcCalls).toHaveLength(0);
  expect(fake.calls.delete).toBe(0);
  expect(fake.calls.insert).toBe(0);
}

describe("PATCH /api/shuttle-schedules/[id] — id malformato (F-12 mitigation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. stringa non base64url/JSON → 400, messaggio generico, nessuna query/scrittura", async () => {
    const fake = createFakeSupabase();
    authorizeAs(TENANT_A, fake);

    const res = await callPatch("%%%invalid%%%", validPayload());
    const rawText = await res.clone().text();
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "Identificativo navetta non valido." });
    expect(rawText).not.toContain("SyntaxError");
    expect(rawText).not.toContain("JSON.parse");
    expect(rawText).not.toContain("stack");
    assertNoDownstreamCalls(fake);
  });

  it("2. base64url valido ma JSON non valido → 400, nessuna eccezione propagata", async () => {
    const fake = createFakeSupabase();
    authorizeAs(TENANT_A, fake);

    const id = Buffer.from("not-json-at-all").toString("base64url");
    const res = await callPatch(id, validPayload());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "Identificativo navetta non valido." });
    assertNoDownstreamCalls(fake);
  });

  it("3a. JSON valido ma oggetto vuoto → 400, nessuna query/scrittura", async () => {
    const fake = createFakeSupabase();
    authorizeAs(TENANT_A, fake);

    const res = await callPatch(b64url({}), validPayload());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "Identificativo navetta non valido." });
    assertNoDownstreamCalls(fake);
  });

  it("3b. JSON valido ma è un array → 400, nessuna query/scrittura", async () => {
    const fake = createFakeSupabase();
    authorizeAs(TENANT_A, fake);

    const res = await callPatch(b64url([1, 2, 3]), validPayload());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "Identificativo navetta non valido." });
    assertNoDownstreamCalls(fake);
  });

  it("3c. JSON valido con campi mancanti → 400, nessuna query/scrittura", async () => {
    const fake = createFakeSupabase();
    authorizeAs(TENANT_A, fake);

    const res = await callPatch(b64url({ direction: "departure" }), validPayload());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "Identificativo navetta non valido." });
    assertNoDownstreamCalls(fake);
  });

  it("3d. JSON valido con tipi errati → 400, nessuna query/scrittura", async () => {
    const fake = createFakeSupabase();
    authorizeAs(TENANT_A, fake);

    const res = await callPatch(
      b64url({ direction: 123, departure_time: true, customer_name: null, vessel: [] }),
      validPayload()
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "Identificativo navetta non valido." });
    assertNoDownstreamCalls(fake);
  });

  it("4. payload con campi extra ma struttura minima valida → accettato, nessun comportamento pericoloso", async () => {
    const fake = createFakeSupabase({ services: [], assignments: [] });
    authorizeAs(TENANT_A, fake);

    const id = b64url({
      hotel_id: null,
      booking_service_kind: "navetta",
      customer_name: "Hotel Test",
      direction: "departure",
      departure_time: "09:30",
      meeting_point: null,
      vessel: "Navetta",
      unexpected_extra_field: "should be ignored, not rejected",
    });

    const res = await callPatch(id, validPayload());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("5. id valido: il flusso continua normalmente (200, delete+insert eseguiti)", async () => {
    const fake = createFakeSupabase({ services: [], assignments: [] });
    authorizeAs(TENANT_A, fake);

    const validId = buildShuttleScheduleId({
      hotel_id: null,
      booking_service_kind: "navetta",
      customer_name: "Hotel Test",
      direction: "departure",
      departure_time: "09:30",
      meeting_point: null,
      vessel: "Navetta",
    });

    const res = await callPatch(validId, validPayload());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.delete).toBe(1);
    expect(fake.calls.insert).toBe(1);
  });

  it("6. la risposta non contiene stack trace, testo dell'eccezione originale, o il valore completo dell'id ricevuto", async () => {
    const fake = createFakeSupabase();
    authorizeAs(TENANT_A, fake);

    const maliciousId = "%%%invalid%%%-should-not-leak-back";
    const res = await callPatch(maliciousId, validPayload());
    const rawText = await res.clone().text();

    expect(rawText).not.toContain(maliciousId);
    expect(rawText).not.toContain("Unexpected token");
    expect(rawText).not.toContain("at decodeShuttleScheduleId");
  });

  it("7a. regressione: 401 di autenticazione mancante resta invariato e precede la decodifica dell'id", async () => {
    mocks.authorizeServiceRoleRequest.mockResolvedValue(
      NextResponse.json({ error: "Sessione non valida." }, { status: 401 })
    );

    const res = await callPatch("%%%invalid%%%", validPayload());
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body).toEqual({ error: "Sessione non valida." });
  });

  it("7b. regressione: guard F-01 (409) resta invariato con id valido e corsa operativa", async () => {
    const validId = buildShuttleScheduleId({
      hotel_id: null,
      booking_service_kind: "navetta",
      customer_name: "Hotel Test",
      direction: "departure",
      departure_time: "09:30",
      meeting_point: null,
      vessel: "Navetta",
    });
    const fake = createFakeSupabase({
      services: [
        {
          id: "svc-1",
          tenant_id: TENANT_A,
          date: TOMORROW,
          direction: "departure",
          time: "09:30",
          customer_name: "Hotel Test",
          vessel: "Navetta",
          hotel_id: null,
          meeting_point: null,
          booking_service_kind: "navetta",
          status: "confirmed",
        },
      ],
      assignments: [],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPatch(validId, validPayload());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("SHUTTLE_HAS_OPERATIONAL_SERVICES");
  });

  it("7c. regressione: guard F-10 (400 INVALID_HOTEL_FOR_TENANT) resta invariato con id valido", async () => {
    const validId = buildShuttleScheduleId({
      hotel_id: null,
      booking_service_kind: "navetta",
      customer_name: "Hotel Test",
      direction: "departure",
      departure_time: "09:30",
      meeting_point: null,
      vessel: "Navetta",
    });
    const OTHER_HOTEL = "22222222-2222-4222-8222-222222222222";
    const fake = createFakeSupabase({
      hotels: [{ id: OTHER_HOTEL, tenant_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }],
      services: [],
      assignments: [],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPatch(validId, validPayload({ hotel_id: OTHER_HOTEL }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("INVALID_HOTEL_FOR_TENANT");
  });

  it("8. nessun side effect: con id invalido non vengono invocate query hotels/services/assignments né scritture", async () => {
    const fake = createFakeSupabase();
    authorizeAs(TENANT_A, fake);

    await callPatch(b64url({ direction: "not-a-real-direction" }), validPayload({ hotel_id: "11111111-1111-4111-8111-111111111111" }));

    assertNoDownstreamCalls(fake);
  });
});
