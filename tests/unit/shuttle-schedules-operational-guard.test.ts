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

// In-memory fake Supabase admin client. PATCH/DELETE ora chiamano UNA sola
// RPC transazionale (public.patch_shuttle_schedule / delete_shuttle_schedule,
// migration 0276) invece della vecchia sequenza select(services)+select
// (assignments)+delete+insert: questo fake simula quella RPC applicando GLI
// STESSI filtri (in particolare tenant_id + date >= oggi) contro i dati
// seminati, cosi' i test continuano a provare che il filtro sia quello che
// determina il risultato — non solo che un mock qualunque abbia risposto
// "ok". Su errore forzato (setRpcError) lo store NON viene mutato per
// niente: e' esattamente la garanzia di atomicita' che la RPC reale fornisce
// via transazione Postgres (nessuno stato parziale).
function createFakeSupabase(seed: { services?: Row[]; assignments?: Row[] } = {}) {
  const services = [...(seed.services ?? [])];
  const assignments = [...(seed.assignments ?? [])];
  const calls = {
    delete: 0,
    insert: 0,
    rpcCalls: [] as Array<{ fn: string; params: Row }>,
  };
  let rpcError: { message: string } | null = null;

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
      throw new Error(`Unexpected table in test fake: ${table}`);
    },
    rpc(fn: string, params: Row) {
      calls.rpcCalls.push({ fn, params });
      if (fn !== "patch_shuttle_schedule" && fn !== "delete_shuttle_schedule") {
        throw new Error(`Unexpected rpc in test fake: ${fn}`);
      }
      if (rpcError) return Promise.resolve({ data: null, error: rpcError });

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
      let insertedCount = 0;
      if (fn === "patch_shuttle_schedule") {
        calls.insert++;
        const newRows = (params.p_new_rows as Row[]) ?? [];
        for (const row of newRows) services.push({ id: `svc-${Math.random().toString(36).slice(2)}`, ...row, tenant_id: params.p_tenant_id });
        insertedCount = newRows.length;
      }
      return Promise.resolve({
        data: [{ deleted_count: matched.length, deleted_date_from: null, deleted_date_to: null, deleted_weekdays: [], inserted_count: insertedCount }],
        error: null,
      });
    },
  };

  return {
    admin,
    calls,
    setRpcError(message: string) {
      rpcError = { message };
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

  it("10a. Errore RPC in DELETE → fail closed (nessun delete/insert), operazione non consentita", async () => {
    // Guardia + individuazione righe + delete sono ora UNA sola RPC
    // transazionale (migration 0276): un errore Postgres qualunque durante
    // quella transazione (query interna, vincolo, timeout) fa rollback
    // dell'intera operazione — non e' piu' distinguibile "e' fallita la
    // select su services" da "e' fallita la select su assignments", perche'
    // dal punto di vista del chiamante e' un'unica chiamata RPC che fallisce.
    const fake = createFakeSupabase({ services: [baseService()], assignments: [] });
    fake.setRpcError("connection reset");
    mocks.authorizeServiceRoleRequest.mockResolvedValue({
      admin: fake.admin,
      user: { id: "user-1", email: "op@test.dev" },
      membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
    });

    const res = await callDelete(SCHEDULE_ID);

    expect(res.status).toBe(500);
    expect(fake.calls.delete).toBe(0);
  });

  it("10b. Errore RPC in PATCH → fail closed, nessun delete/insert", async () => {
    const fake = createFakeSupabase({ services: [baseService()], assignments: [] });
    fake.setRpcError("timeout");
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

  it("la guardia operativa e' valutata dentro la stessa chiamata RPC di delete/insert (una sola invocazione, mai due round-trip separati)", async () => {
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

    expect(fake.calls.rpcCalls).toHaveLength(1);
    expect(fake.calls.rpcCalls[0].fn).toBe("delete_shuttle_schedule");
  });
});
