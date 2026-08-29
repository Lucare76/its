import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { GeneratedConvocationRow } from "@/lib/medmar-generate-from-services";
import type { CoverageResult } from "@/lib/medmar-convocation-coverage";

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  generateMedmarRowsWithCoverage: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));

vi.mock("@/lib/server/medmar-generate-with-coverage", () => ({
  generateMedmarRowsWithCoverage: mocks.generateMedmarRowsWithCoverage,
}));

import { POST } from "@/app/api/ops/medmar-convocations/create-batch-from-services/route";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Row = GeneratedConvocationRow & CoverageResult;

function genRow(overrides: Partial<Row>): Row {
  return {
    id: "svc-x",
    service_id: "svc-x",
    row_index: 1,
    inviare: true,
    phone_raw: "3331234567",
    phone_e164: "+393331234567",
    customer_name: "Test",
    travel_date: "LUN 07 SET",
    travel_date_iso: "2026-09-07",
    hotel: "Hotel Aurora",
    passengers: "2",
    pickup_time: "09:00",
    departure_time: "11:10",
    generated_message: "msg",
    status: "pronto",
    error_message: null,
    provider_message_id: null,
    sent_at: null,
    coverage_status: "new",
    ...overrides,
  };
}

type CallLog = Array<{ table: string; method: string; args: unknown[] }>;

function makeAdmin(calls: CallLog, batchId = "batch-1") {
  return {
    from(table: string) {
      if (table === "medmar_convocation_batches") {
        return {
          insert: (payload: unknown) => {
            calls.push({ table, method: "insert", args: [payload] });
            return {
              select: () => ({
                single: () => Promise.resolve({ data: { id: batchId }, error: null }),
              }),
            };
          },
          update: (payload: unknown) => {
            calls.push({ table, method: "update", args: [payload] });
            return { eq: (...args: unknown[]) => { calls.push({ table, method: "eq", args }); return Promise.resolve({ data: null, error: null }); } };
          },
        };
      }
      if (table === "medmar_convocation_rows") {
        return {
          insert: (payload: unknown[]) => {
            calls.push({ table, method: "insert", args: [payload] });
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  } as never;
}

function authFor(tenantId: string, admin: unknown) {
  return {
    admin,
    user: { id: "user-1", email: "op@example.test" },
    membership: { tenant_id: tenantId, role: "operator", suspended: false },
  };
}

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost:3010/api/ops/medmar-convocations/create-batch-from-services", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/ops/medmar-convocations/create-batch-from-services", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("propagates 401 without touching generation or the DB", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "no" }, { status: 401 }));
    const res = await POST(makeRequest({ date: "2026-09-07", mode: "new" }));
    expect(res.status).toBe(401);
    expect(mocks.generateMedmarRowsWithCoverage).not.toHaveBeenCalled();
  });

  it("18/19/20/21. mode=new includes only 'new' rows — excludes changed/sent/invalid", async () => {
    const calls: CallLog = [];
    const admin = makeAdmin(calls);
    mocks.authorizePricingRequest.mockResolvedValue(authFor(TENANT_A, admin));
    mocks.generateMedmarRowsWithCoverage.mockResolvedValue({
      rows: [
        genRow({ service_id: "A", coverage_status: "new" }),
        genRow({ service_id: "B", coverage_status: "sent" }),
        genRow({ service_id: "C", coverage_status: "changed" }),
        genRow({ service_id: "D", coverage_status: "invalid", status: "errore" }),
      ],
      summary: { found: 4, new: 1, sent: 1, changed: 1, invalid: 1 },
    });

    const res = await POST(makeRequest({ date: "2026-09-07", mode: "new" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.count).toBe(1);
    const rowsInsertCall = calls.find((c) => c.table === "medmar_convocation_rows" && c.method === "insert");
    const insertedRows = rowsInsertCall!.args[0] as Array<{ service_id: string }>;
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].service_id).toBe("A");
  });

  it("mode=changed includes only 'changed' rows — excludes new/sent/invalid", async () => {
    const calls: CallLog = [];
    const admin = makeAdmin(calls);
    mocks.authorizePricingRequest.mockResolvedValue(authFor(TENANT_A, admin));
    mocks.generateMedmarRowsWithCoverage.mockResolvedValue({
      rows: [
        genRow({ service_id: "A", coverage_status: "new" }),
        genRow({ service_id: "B", coverage_status: "sent" }),
        genRow({ service_id: "C", coverage_status: "changed" }),
      ],
      summary: { found: 3, new: 1, sent: 1, changed: 1, invalid: 0 },
    });

    const res = await POST(makeRequest({ date: "2026-09-07", mode: "changed" }));
    const json = await res.json();

    expect(json.count).toBe(1);
    const rowsInsertCall = calls.find((c) => c.table === "medmar_convocation_rows" && c.method === "insert");
    const insertedRows = rowsInsertCall!.args[0] as Array<{ service_id: string }>;
    expect(insertedRows.map((r) => r.service_id)).toEqual(["C"]);
  });

  it("22/23. saves the full data snapshot and service_id on each inserted row", async () => {
    const calls: CallLog = [];
    const admin = makeAdmin(calls);
    mocks.authorizePricingRequest.mockResolvedValue(authFor(TENANT_A, admin));
    mocks.generateMedmarRowsWithCoverage.mockResolvedValue({
      rows: [genRow({ service_id: "svc-42", coverage_status: "new", customer_name: "Luca", hotel: "Hotel La Villa", passengers: "2", pickup_time: "10:00", departure_time: "11:10" })],
      summary: { found: 1, new: 1, sent: 0, changed: 0, invalid: 0 },
    });

    await POST(makeRequest({ date: "2026-09-07", mode: "new" }));

    const rowsInsertCall = calls.find((c) => c.table === "medmar_convocation_rows" && c.method === "insert");
    const [insertedRow] = rowsInsertCall!.args[0] as Array<Record<string, unknown>>;
    expect(insertedRow).toMatchObject({
      tenant_id: TENANT_A,
      service_id: "svc-42",
      customer_name: "Luca",
      hotel: "Hotel La Villa",
      passengers: "2",
      pickup_time: "10:00",
      departure_time: "11:10",
      status: "da_inviare",
    });
    expect(insertedRow.template_payload).toMatchObject({ "1": "Luca", "3": "Hotel La Villa" });
  });

  it("returns batchId=null and inserts nothing when no row matches the mode", async () => {
    const calls: CallLog = [];
    const admin = makeAdmin(calls);
    mocks.authorizePricingRequest.mockResolvedValue(authFor(TENANT_A, admin));
    mocks.generateMedmarRowsWithCoverage.mockResolvedValue({
      rows: [genRow({ service_id: "A", coverage_status: "sent" })],
      summary: { found: 1, new: 0, sent: 1, changed: 0, invalid: 0 },
    });

    const res = await POST(makeRequest({ date: "2026-09-07", mode: "new" }));
    const json = await res.json();

    expect(json.ok).toBe(true);
    expect(json.batchId).toBeNull();
    expect(calls.some((c) => c.table === "medmar_convocation_batches")).toBe(false);
  });

  it("rejects an invalid date parameter", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(authFor(TENANT_A, makeAdmin([])));
    const res = await POST(makeRequest({ date: "07-09-2026", mode: "new" }));
    expect(res.status).toBe(400);
  });
});
