import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// Date dinamiche relative a "oggi" reale (todayIsoDate() nella route non è
// mockato): evita che il range hardcoded finisca nel passato col passare
// del tempo, facendo sparire le righe generate da buildRows.
function isoDate(offsetDays: number) {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Fake Supabase admin client: PATCH ora chiama UNA sola RPC transazionale
// (public.patch_shuttle_schedule, migration 0276) invece di select/delete/
// insert separati. Nessun dato preesistente e' seminato -> la guardia
// operativa non trova mai righe da bloccare, cosi' i test originali su
// validazione restano invariati: contano solo se la RPC e' stata invocata
// (delete=1) e se ha ricevuto righe da inserire (insert=1).
function createFakeSupabase() {
  const calls = { delete: 0, insert: 0 };

  const admin = {
    from(table: string) {
      throw new Error(`Unexpected table in test fake: ${table}`);
    },
    rpc(fn: string, params: Record<string, unknown>) {
      if (fn !== "patch_shuttle_schedule") throw new Error(`Unexpected rpc in test fake: ${fn}`);
      calls.delete++;
      const newRows = (params.p_new_rows as unknown[]) ?? [];
      if (newRows.length > 0) calls.insert++;
      return Promise.resolve({
        data: [{ deleted_count: 0, deleted_date_from: null, deleted_date_to: null, deleted_weekdays: [], inserted_count: newRows.length }],
        error: null,
      });
    },
  };

  return { admin, calls };
}

const mocks = vi.hoisted(() => ({
  authorizeServiceRoleRequest: vi.fn()
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizeServiceRoleRequest: mocks.authorizeServiceRoleRequest
}));

import { PATCH } from "@/app/api/shuttle-schedules/[id]/route";
import { buildShuttleScheduleId } from "@/lib/shuttle-schedules";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/shuttle-schedules/x", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body)
  });
}

function callPatch(id: string, body: Record<string, unknown>) {
  return PATCH(makeRequest(body), { params: Promise.resolve({ id }) });
}

const VALID_SCHEDULE_ID = buildShuttleScheduleId({
  hotel_id: null,
  booking_service_kind: "navetta",
  customer_name: "Hotel Test",
  direction: "departure",
  departure_time: "09:30",
  meeting_point: null,
  vessel: "Navetta"
});

const VALID_PAYLOAD = {
  hotel_id: null,
  booking_service_kind: "navetta",
  customer_name: "Hotel Test",
  direction: "departure",
  departure_time: "09:30",
  meeting_point: null,
  vessel: "Navetta",
  valid_from: isoDate(1),
  valid_to: isoDate(7),
  days_of_week: [1, 2, 3, 4, 5],
  notes: null
};

describe("PATCH /api/shuttle-schedules/[id] — valid_to obbligatorio (M1.1.1)", () => {
  let fake: ReturnType<typeof createFakeSupabase>;

  beforeEach(() => {
    vi.clearAllMocks();
    fake = createFakeSupabase();
    mocks.authorizeServiceRoleRequest.mockResolvedValue({
      admin: fake.admin,
      user: { id: "user-a", email: "op@tenant-a.test" },
      membership: { tenant_id: TENANT_A, role: "operator", suspended: false }
    });
  });

  it("valid_to assente → 400, nessuna scrittura Supabase", async () => {
    const { valid_to: _omit, ...payload } = VALID_PAYLOAD;
    const res = await callPatch(VALID_SCHEDULE_ID, payload);

    expect(res.status).toBe(400);
    expect(fake.calls.delete).toBe(0);
    expect(fake.calls.insert).toBe(0);
  });

  it("valid_to: null → 400, nessuna scrittura Supabase", async () => {
    const res = await callPatch(VALID_SCHEDULE_ID, { ...VALID_PAYLOAD, valid_to: null });

    expect(res.status).toBe(400);
    expect(fake.calls.delete).toBe(0);
    expect(fake.calls.insert).toBe(0);
  });

  it('valid_to: "" → 400, nessuna scrittura Supabase', async () => {
    const res = await callPatch(VALID_SCHEDULE_ID, { ...VALID_PAYLOAD, valid_to: "" });

    expect(res.status).toBe(400);
    expect(fake.calls.delete).toBe(0);
    expect(fake.calls.insert).toBe(0);
  });

  it("valid_to non nel formato YYYY-MM-DD → 400, nessuna scrittura Supabase", async () => {
    const res = await callPatch(VALID_SCHEDULE_ID, { ...VALID_PAYLOAD, valid_to: "31-08-2026" });

    expect(res.status).toBe(400);
    expect(fake.calls.delete).toBe(0);
    expect(fake.calls.insert).toBe(0);
  });

  it("valid_to valida → supera la validazione, comportamento preesistente invariato (delete + insert eseguiti, 200 ok)", async () => {
    const res = await callPatch(VALID_SCHEDULE_ID, VALID_PAYLOAD);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.delete).toBe(1);
    expect(fake.calls.insert).toBe(1);
  });

  it("valid_to < valid_from resta bloccato con 400 (comportamento preesistente invariato)", async () => {
    const res = await callPatch(VALID_SCHEDULE_ID, {
      ...VALID_PAYLOAD,
      valid_from: "2026-08-10",
      valid_to: "2026-08-01"
    });

    expect(res.status).toBe(400);
    expect(fake.calls.delete).toBe(0);
    expect(fake.calls.insert).toBe(0);
  });
});
