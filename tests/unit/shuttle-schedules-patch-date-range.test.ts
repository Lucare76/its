import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// Fake Supabase admin client that only tracks whether delete()/insert() on
// "services" were invoked — enough to prove no write happens on invalid input.
function createFakeSupabase() {
  const calls = { delete: 0, insert: 0 };

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
      }
    };
    return builder;
  }

  const admin = {
    from(_table: string) {
      return {
        delete() {
          calls.delete++;
          return makeDeleteBuilder();
        },
        insert(_rows: unknown) {
          calls.insert++;
          return Promise.resolve({ error: null });
        }
      };
    }
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
  valid_from: "2026-08-01",
  valid_to: "2026-08-05",
  days_of_week: [1, 2, 3, 4, 5],
  notes: null
};

describe("PATCH /api/shuttle-schedules/[id] — intervallo valid_from/valid_to (M1.1.3)", () => {
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

  it("valid_from < valid_to (intervallo normale) → 200, delete=1, insert=1", async () => {
    // 2026-08-01 è sabato e 2026-08-02 è domenica: days_of_week viene
    // impostato a null per non dipendere dal giorno della settimana.
    const res = await callPatch(VALID_SCHEDULE_ID, {
      ...VALID_PAYLOAD,
      valid_from: "2026-08-01",
      valid_to: "2026-08-02",
      days_of_week: null
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.delete).toBe(1);
    expect(fake.calls.insert).toBe(1);
  });

  it("valid_from === valid_to (stesso giorno) → 200, delete=1, insert=1 (il controllo è < e non <=)", async () => {
    // 2026-08-01 è sabato: days_of_week viene impostato a null per includere
    // comunque il giorno unico dell'intervallo.
    const res = await callPatch(VALID_SCHEDULE_ID, {
      ...VALID_PAYLOAD,
      valid_from: "2026-08-01",
      valid_to: "2026-08-01",
      days_of_week: null
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.delete).toBe(1);
    expect(fake.calls.insert).toBe(1);
  });

  it("valid_to < valid_from (intervallo invertito) → 400, nessuna scrittura Supabase", async () => {
    const res = await callPatch(VALID_SCHEDULE_ID, {
      ...VALID_PAYLOAD,
      valid_from: "2026-08-02",
      valid_to: "2026-08-01"
    });

    expect(res.status).toBe(400);
    expect(fake.calls.delete).toBe(0);
    expect(fake.calls.insert).toBe(0);
  });

  it("valid_to < valid_from su cambio mese (2026-09-01 → 2026-08-31) → 400, nessuna scrittura Supabase", async () => {
    const res = await callPatch(VALID_SCHEDULE_ID, {
      ...VALID_PAYLOAD,
      valid_from: "2026-09-01",
      valid_to: "2026-08-31"
    });

    expect(res.status).toBe(400);
    expect(fake.calls.delete).toBe(0);
    expect(fake.calls.insert).toBe(0);
  });

  it("valid_to < valid_from su cambio anno (2027-01-01 → 2026-12-31) → 400, nessuna scrittura Supabase", async () => {
    const res = await callPatch(VALID_SCHEDULE_ID, {
      ...VALID_PAYLOAD,
      valid_from: "2027-01-01",
      valid_to: "2026-12-31"
    });

    expect(res.status).toBe(400);
    expect(fake.calls.delete).toBe(0);
    expect(fake.calls.insert).toBe(0);
  });

  it("valid_from < valid_to su cambio mese (2026-08-31 → 2026-09-01) → 200, delete=1, insert=1", async () => {
    // 2026-08-31 è lunedì (1) e 2026-09-01 è martedì (2): entrambi compresi
    // nel days_of_week di default [1,2,3,4,5] del VALID_PAYLOAD.
    const res = await callPatch(VALID_SCHEDULE_ID, {
      ...VALID_PAYLOAD,
      valid_from: "2026-08-31",
      valid_to: "2026-09-01"
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.delete).toBe(1);
    expect(fake.calls.insert).toBe(1);
  });

  it("valid_from < valid_to su cambio anno (2026-12-31 → 2027-01-01) → 200, delete=1, insert=1", async () => {
    // 2026-12-31 è giovedì (4) e 2027-01-01 è venerdì (5): entrambi compresi
    // nel days_of_week di default [1,2,3,4,5] del VALID_PAYLOAD.
    const res = await callPatch(VALID_SCHEDULE_ID, {
      ...VALID_PAYLOAD,
      valid_from: "2026-12-31",
      valid_to: "2027-01-01"
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.delete).toBe(1);
    expect(fake.calls.insert).toBe(1);
  });
});
