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

function makeAdmin(tables: Record<string, unknown[]>, calls: CallLog) {
  return {
    from(table: string) {
      return makeQueryBuilder(
        { data: (tables[table] ?? []) as unknown[], error: null },
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

// 4 rows for departure day 2026-08-30: 2 sent, 1 failed, 1 pronto (forgotten).
function dayFixture() {
  return {
    snav_convocation_rows: [
      { id: "r-sent-1", batch_id: "b1", inviare: true, customer_name: "Ada", departure_date_label: "DOM 30 AGO", departure_date: "2026-08-30", hotel: "H1", passengers: "2", pickup_time: "16:40", vessel_time: "17:40", phone_raw: "333", phone_e164: "+39333", status: "inviato", error_message: null, provider_message_id: "wamid.1", sent_at: "2026-08-29T09:00:00.000Z" },
      { id: "r-sent-2", batch_id: "b1", inviare: true, customer_name: "Deo", departure_date_label: "DOM 30 AGO", departure_date: "2026-08-30", hotel: "H2", passengers: "1", pickup_time: "15:00", vessel_time: "16:00", phone_raw: "334", phone_e164: "+39334", status: "inviato", error_message: null, provider_message_id: "wamid.2", sent_at: "2026-08-29T09:01:00.000Z" },
      { id: "r-failed", batch_id: "b1", inviare: true, customer_name: "Bea", departure_date_label: "DOM 30 AGO", departure_date: "2026-08-30", hotel: "H3", passengers: "3", pickup_time: "10:00", vessel_time: "11:00", phone_raw: "335", phone_e164: "+39335", status: "errore", error_message: "[#131049] blocked", provider_message_id: null, sent_at: null },
      { id: "r-pending", batch_id: "b1", inviare: true, customer_name: "Cid", departure_date_label: "DOM 30 AGO", departure_date: "2026-08-30", hotel: "H4", passengers: "1", pickup_time: "12:00", vessel_time: "13:00", phone_raw: "336", phone_e164: "+39336", status: "pronto", error_message: null, provider_message_id: null, sent_at: null },
    ],
    snav_convocation_batches: [{ id: "b1", file_name: "snav.xlsx", label: "SNAV 30/08" }],
    snav_convocation_send_logs: [
      { id: "l1", row_id: "r-sent-1", operator_user_id: "op-1", template_name: "partenze_snav", language_code: "it", variables_json: { "1": "Ada", "2": "DOM 30 AGO", "3": "H1", "4": "2", "5": "16:40", "6": "17:40" }, status: "sent", provider_message_id: "wamid.1", error_message: null, api_response_json: null, attempt_number: 1, attempted_at: "2026-08-29T09:00:00.000Z" },
      { id: "l2", row_id: "r-sent-2", operator_user_id: "op-1", template_name: "partenze_snav", language_code: "it", variables_json: { "1": "Deo", "2": "DOM 30 AGO", "3": "H2", "4": "1", "5": "15:00", "6": "16:00" }, status: "sent", provider_message_id: "wamid.2", error_message: null, api_response_json: null, attempt_number: 1, attempted_at: "2026-08-29T09:01:00.000Z" },
      { id: "l3", row_id: "r-failed", operator_user_id: "op-1", template_name: "partenze_snav", language_code: "it", variables_json: { "1": "Bea", "2": "DOM 30 AGO", "3": "H3", "4": "3", "5": "10:00", "6": "11:00" }, status: "failed", provider_message_id: null, error_message: "[#131049] blocked", api_response_json: { error: { code: 131049 } }, attempt_number: 1, attempted_at: "2026-08-29T09:02:00.000Z" },
    ],
    memberships: [{ user_id: "op-1", full_name: "Mario Rossi", email: "mario@example.test" }],
    whatsapp_message_statuses: [
      { wa_message_id: "wamid.1", status: "read", timestamp: "2026-08-29T10:00:00.000Z", created_at: "2026-08-29T10:00:00.000Z" },
    ],
  };
}

describe("GET /api/ops/whatsapp-log?filter=snav_convocazione", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAdminClient.mockImplementation(() => {
      throw new Error("admin not configured for this test");
    });
  });

  it("propagates the 401 from authorizePricingRequest without touching the DB", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "no" }, { status: 401 }));
    const res = await GET(makeRequest("?filter=snav_convocazione&date=2026-08-30"));
    expect(res.status).toBe(401);
    expect(mocks.authorizePricingRequest).toHaveBeenCalledWith(
      expect.anything(),
      ["admin", "operator", "supervisor", "assistenza"],
    );
  });

  it("lets a supervisor read the daily SNAV log with summary + previste-vs-inviate", async () => {
    const calls: CallLog = [];
    mocks.authorizePricingRequest.mockResolvedValue(authFor(TENANT_A, "supervisor"));
    mocks.createAdminClient.mockReturnValue(makeAdmin(dayFixture(), calls));

    const res = await GET(makeRequest("?filter=snav_convocazione&date=2026-08-30"));
    const json = (await res.json()) as {
      ok: boolean;
      date: string;
      summary: { total: number; expected: number; sent: number; failed: number; notSent: number; missing: number; read: number; readRate: number };
      rows: Array<{ row_id: string; template: string | null; operator_name: string | null; error_code: string | null; params: string[]; vessel_time: string }>;
    };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.date).toBe("2026-08-30");
    expect(json.summary).toMatchObject({ total: 4, sent: 2, failed: 1, notSent: 1, expected: 4, missing: 2 });
    expect(json.summary.read).toBe(1);
    expect(json.summary.readRate).toBe(50);

    const sent = json.rows.find((r) => r.row_id === "r-sent-1");
    expect(sent?.template).toBe("partenze_snav");
    expect(sent?.operator_name).toBe("Mario Rossi");
    expect(sent?.params).toEqual(["Ada", "DOM 30 AGO", "H1", "2", "16:40", "17:40"]);
    const failed = json.rows.find((r) => r.row_id === "r-failed");
    expect(failed?.error_code).toBe("131049");
  });

  it("an operator can also read it", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(authFor(TENANT_A, "operator"));
    mocks.createAdminClient.mockReturnValue(makeAdmin(dayFixture(), []));
    const res = await GET(makeRequest("?filter=snav_convocazione&date=2026-08-30"));
    expect(res.status).toBe(200);
  });

  it("scopes every SNAV query by the caller's tenant_id (tenant isolation)", async () => {
    const calls: CallLog = [];
    mocks.authorizePricingRequest.mockResolvedValue(authFor(TENANT_B, "operator"));
    mocks.createAdminClient.mockReturnValue(makeAdmin(dayFixture(), calls));

    await GET(makeRequest("?filter=snav_convocazione&date=2026-08-30"));

    const tenantCalls = calls.filter((c) => c.method === "eq" && c.args[0] === "tenant_id");
    expect(tenantCalls.length).toBeGreaterThan(0);
    expect(tenantCalls.every((c) => c.args[1] === TENANT_B)).toBe(true);
    expect(tenantCalls.some((c) => c.args[1] === TENANT_A)).toBe(false);
    for (const table of ["snav_convocation_rows", "snav_convocation_send_logs", "memberships"]) {
      expect(calls.some((c) => c.table === table && c.method === "eq" && c.args[0] === "tenant_id")).toBe(true);
    }
  });

  it("filters by the SNAV departure day via an exact departure_date match", async () => {
    const calls: CallLog = [];
    mocks.authorizePricingRequest.mockResolvedValue(authFor(TENANT_A, "operator"));
    mocks.createAdminClient.mockReturnValue(makeAdmin(dayFixture(), calls));

    await GET(makeRequest("?filter=snav_convocazione&date=2026-08-30"));

    const dayCall = calls.find((c) => c.table === "snav_convocation_rows" && c.method === "eq" && c.args[0] === "departure_date");
    expect(dayCall?.args[1]).toBe("2026-08-30");
  });

  it("rejects a non-ISO date param with 400", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(authFor(TENANT_A, "operator"));
    mocks.createAdminClient.mockReturnValue(makeAdmin({}, []));
    const res = await GET(makeRequest("?filter=snav_convocazione&date=30-08-2026"));
    expect(res.status).toBe(400);
  });

  it("returns an empty summary for a day with no convocations", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(authFor(TENANT_A, "supervisor"));
    mocks.createAdminClient.mockReturnValue(makeAdmin({ snav_convocation_rows: [] }, []));
    const res = await GET(makeRequest("?filter=snav_convocazione&date=2026-08-30"));
    const json = (await res.json()) as { ok: boolean; summary: { total: number; missing: number; readRate: number }; rows: unknown[] };
    expect(res.status).toBe(200);
    expect(json.summary).toMatchObject({ total: 0, missing: 0, readRate: 0 });
    expect(json.rows).toEqual([]);
  });
});
