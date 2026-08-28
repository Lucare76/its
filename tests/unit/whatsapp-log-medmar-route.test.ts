import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));

vi.mock("@/lib/server/whatsapp", () => ({
  createAdminClient: mocks.createAdminClient,
}));

import { GET } from "@/app/api/ops/whatsapp-log/route";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type QueryResult = { data: unknown[] | null; error: unknown };

function makeQueryBuilder(result: QueryResult, onCall: (method: string, args: unknown[]) => void) {
  const methods = ["select", "eq", "neq", "gte", "lte", "in", "ilike", "order", "limit", "maybeSingle"] as const;
  const builder: Record<string, unknown> = {};
  for (const method of methods) {
    builder[method] = (...args: unknown[]) => {
      onCall(method, args);
      return builder;
    };
  }
  builder.then = (onFulfilled: (v: QueryResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return builder;
}

type CallLog = Array<{ table: string; method: string; args: unknown[] }>;

function makeAdmin(tables: Record<string, unknown[]>, calls: CallLog, errors: Record<string, unknown> = {}) {
  return {
    from(table: string) {
      return makeQueryBuilder(
        { data: (tables[table] ?? []) as unknown[], error: errors[table] ?? null },
        (method, args) => calls.push({ table, method, args }),
      );
    },
  } as never;
}

function authFor(tenantId: string, role: string) {
  return {
    admin: {} as never,
    user: { id: "user-1", email: "op@example.test" },
    membership: { tenant_id: tenantId, role, suspended: false },
  };
}

function makeRequest(query: string) {
  return new NextRequest(`http://localhost:3010/api/ops/whatsapp-log${query}`, { method: "GET" });
}

// One convocation batch, four rows for the same operational day 2026-09-07.
function dayFixture() {
  return {
    medmar_convocation_rows: [
      { id: "r-sent-1", batch_id: "b1", customer_name: "Ada", travel_date: "LUN 07 SET", travel_date_iso: "2026-09-07", route: "R", departure_time: "11:10", passengers: "2", phone_raw: "333", phone_e164: "+39333", status: "inviato", error_message: null, provider_message_id: "wamid.1", sent_at: "2026-09-06T08:00:00.000Z" },
      { id: "r-sent-2", batch_id: "b1", customer_name: "Deo", travel_date: "LUN 07 SET", travel_date_iso: "2026-09-07", route: "R", departure_time: "09:00", passengers: "1", phone_raw: "334", phone_e164: "+39334", status: "inviato", error_message: null, provider_message_id: "wamid.2", sent_at: "2026-09-06T08:01:00.000Z" },
      { id: "r-failed", batch_id: "b1", customer_name: "Bea", travel_date: "LUN 07 SET", travel_date_iso: "2026-09-07", route: "R", departure_time: "10:00", passengers: "3", phone_raw: "335", phone_e164: "+39335", status: "errore", error_message: "[#131049] blocked", provider_message_id: null, sent_at: null },
      { id: "r-pending", batch_id: "b1", customer_name: "Cid", travel_date: "LUN 07 SET", travel_date_iso: "2026-09-07", route: "R", departure_time: "12:00", passengers: "1", phone_raw: "336", phone_e164: "+39336", status: "da_inviare", error_message: null, provider_message_id: null, sent_at: null },
    ],
    medmar_convocation_batches: [{ id: "b1", file_name: "partenze.xlsx", label: "Partenze 07/09" }],
    medmar_convocation_send_logs: [
      { id: "l1", row_id: "r-sent-1", operator_user_id: "op-1", template_name: "partenze_medmar", language_code: "it", variables_json: { "1": "Ada", "2": "LUN 07 SET", "3": "Hotel", "4": "2", "5": "10:00", "6": "11:10" }, status: "sent", provider_message_id: "wamid.1", error_message: null, api_response_json: null, attempt_number: 1, attempted_at: "2026-09-06T08:00:00.000Z" },
      { id: "l2", row_id: "r-sent-2", operator_user_id: "op-1", template_name: "partenze_medmar", language_code: "it", variables_json: { "1": "Deo", "2": "LUN 07 SET", "3": "Hotel", "4": "1", "5": "08:00", "6": "09:00" }, status: "sent", provider_message_id: "wamid.2", error_message: null, api_response_json: null, attempt_number: 1, attempted_at: "2026-09-06T08:01:00.000Z" },
      { id: "l3", row_id: "r-failed", operator_user_id: "op-1", template_name: "partenze_medmar", language_code: "it", variables_json: { "1": "Bea", "2": "LUN 07 SET", "3": "Hotel", "4": "3", "5": "09:00", "6": "10:00" }, status: "failed", provider_message_id: null, error_message: "[#131049] blocked", api_response_json: { error: { code: 131049 } }, attempt_number: 1, attempted_at: "2026-09-06T08:02:00.000Z" },
    ],
    memberships: [{ user_id: "op-1", full_name: "Mario Rossi", email: "mario@example.test" }],
    whatsapp_message_statuses: [
      { wa_message_id: "wamid.1", status: "read", timestamp: "2026-09-06T09:00:00.000Z", created_at: "2026-09-06T09:00:00.000Z" },
    ],
  };
}

describe("GET /api/ops/whatsapp-log?filter=medmar_convocazione", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAdminClient.mockImplementation(() => {
      throw new Error("admin not configured for this test");
    });
  });

  it("propagates the 401 from authorizePricingRequest without touching the DB", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));

    const res = await GET(makeRequest("?filter=medmar_convocazione&date=2026-09-07"));

    expect(res.status).toBe(401);
    expect(mocks.authorizePricingRequest).toHaveBeenCalledWith(
      expect.anything(),
      ["admin", "operator", "supervisor", "assistenza"],
    );
  });

  it("lets a supervisor read the daily Medmar log and returns the summary counts", async () => {
    const calls: CallLog = [];
    mocks.authorizePricingRequest.mockResolvedValue(authFor(TENANT_A, "supervisor"));
    mocks.createAdminClient.mockReturnValue(makeAdmin(dayFixture(), calls));

    const res = await GET(makeRequest("?filter=medmar_convocazione&date=2026-09-07"));
    const json = (await res.json()) as {
      ok: boolean;
      date: string;
      summary: { total: number; sent: number; failed: number; notSent: number; read: number; successRate: number };
      rows: Array<{ row_id: string; template: string | null; operator_name: string | null; error_code: string | null; params: string[] }>;
      failedRows: unknown[];
      notSentRows: unknown[];
    };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.date).toBe("2026-09-07");
    expect(json.summary).toMatchObject({ total: 4, sent: 2, failed: 1, notSent: 1 });
    expect(json.summary.successRate).toBe(50);
    expect(json.summary.read).toBe(1); // wamid.1 has a real 'read' webhook status
    expect(json.failedRows).toHaveLength(1);
    expect(json.notSentRows).toHaveLength(1);

    const failed = json.rows.find((r) => r.row_id === "r-failed");
    expect(failed?.error_code).toBe("131049");
    const sent = json.rows.find((r) => r.row_id === "r-sent-1");
    expect(sent?.template).toBe("partenze_medmar");
    expect(sent?.operator_name).toBe("Mario Rossi");
    expect(sent?.params).toEqual(["Ada", "LUN 07 SET", "Hotel", "2", "10:00", "11:10"]);
  });

  it("scopes every Medmar query by the caller's tenant_id (tenant isolation)", async () => {
    const calls: CallLog = [];
    mocks.authorizePricingRequest.mockResolvedValue(authFor(TENANT_B, "operator"));
    mocks.createAdminClient.mockReturnValue(makeAdmin(dayFixture(), calls));

    await GET(makeRequest("?filter=medmar_convocazione&date=2026-09-07"));

    const tenantCalls = calls.filter((c) => c.method === "eq" && c.args[0] === "tenant_id");
    expect(tenantCalls.length).toBeGreaterThan(0);
    expect(tenantCalls.every((c) => c.args[1] === TENANT_B)).toBe(true);
    expect(tenantCalls.some((c) => c.args[1] === TENANT_A)).toBe(false);

    for (const table of ["medmar_convocation_rows", "medmar_convocation_send_logs", "memberships"]) {
      expect(calls.some((c) => c.table === table && c.method === "eq" && c.args[0] === "tenant_id")).toBe(true);
    }
  });

  it("filters strictly by the operational day via an exact travel_date_iso match", async () => {
    const calls: CallLog = [];
    mocks.authorizePricingRequest.mockResolvedValue(authFor(TENANT_A, "operator"));
    mocks.createAdminClient.mockReturnValue(makeAdmin(dayFixture(), calls));

    await GET(makeRequest("?filter=medmar_convocazione&date=2026-09-07"));

    const dayCall = calls.find((c) => c.table === "medmar_convocation_rows" && c.method === "eq" && c.args[0] === "travel_date_iso");
    expect(dayCall?.args[1]).toBe("2026-09-07");
  });

  it("rejects a non-ISO date param with a 400", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(authFor(TENANT_A, "operator"));
    mocks.createAdminClient.mockReturnValue(makeAdmin({}, []));

    const res = await GET(makeRequest("?filter=medmar_convocazione&date=07-09-2026"));

    expect(res.status).toBe(400);
  });

  it("returns an empty summary (no rows) for a day with no convocations", async () => {
    const calls: CallLog = [];
    mocks.authorizePricingRequest.mockResolvedValue(authFor(TENANT_A, "supervisor"));
    mocks.createAdminClient.mockReturnValue(makeAdmin({ medmar_convocation_rows: [] }, calls));

    const res = await GET(makeRequest("?filter=medmar_convocazione&date=2026-09-07"));
    const json = (await res.json()) as { ok: boolean; summary: { total: number; successRate: number }; rows: unknown[] };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.summary).toMatchObject({ total: 0, successRate: 0 });
    expect(json.rows).toEqual([]);
  });
});
