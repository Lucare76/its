import { describe, it, expect } from "vitest";
import { loadMedmarSentSnapshots } from "@/lib/server/medmar-convocation-coverage-source";

type QueryResult = { data: unknown[] | null; error: unknown };

function makeQueryBuilder(result: QueryResult, onCall: (method: string, args: unknown[]) => void) {
  const methods = ["select", "eq", "in", "is", "limit"] as const;
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
      return makeQueryBuilder({ data: tables[table] ?? [], error: null }, (method, args) => calls.push({ table, method, args }));
    },
  } as never;
}

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    service_id: "svc-1",
    phone_e164: "+393331234567",
    customer_name: "Mario Rossi",
    travel_date_iso: "2026-09-07",
    hotel: "Hotel Aurora",
    passengers: "2",
    pickup_time: "09:00",
    departure_time: "11:10",
    provider_message_id: "wamid.1",
    sent_at: "2026-09-06T08:00:00.000Z",
    ...overrides,
  };
}

describe("loadMedmarSentSnapshots", () => {
  it("returns empty maps when no ids are given (no query fired)", async () => {
    const calls: CallLog = [];
    const admin = makeAdmin({}, calls);
    const result = await loadMedmarSentSnapshots(admin as never, TENANT_A, [], []);
    expect(result.byServiceId.size).toBe(0);
    expect(result.byFallbackKey.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("4. delivered webhook status counts as a successful send", async () => {
    const calls: CallLog = [];
    const admin = makeAdmin(
      {
        medmar_convocation_rows: [row({ provider_message_id: "wamid.delivered" })],
        whatsapp_message_statuses: [{ wa_message_id: "wamid.delivered", status: "delivered", timestamp: "2026-09-06T09:00:00.000Z", created_at: "2026-09-06T09:00:00.000Z" }],
      },
      calls,
    );
    const result = await loadMedmarSentSnapshots(admin as never, TENANT_A, ["svc-1"], []);
    expect(result.byServiceId.get("svc-1")).toBeDefined();
  });

  it("5. read webhook status counts as a successful send", async () => {
    const calls: CallLog = [];
    const admin = makeAdmin(
      {
        medmar_convocation_rows: [row({ provider_message_id: "wamid.read" })],
        whatsapp_message_statuses: [{ wa_message_id: "wamid.read", status: "read", timestamp: "2026-09-06T09:00:00.000Z", created_at: "2026-09-06T09:00:00.000Z" }],
      },
      calls,
    );
    const result = await loadMedmarSentSnapshots(admin as never, TENANT_A, ["svc-1"], []);
    expect(result.byServiceId.get("svc-1")).toBeDefined();
  });

  it("3. a webhook status of 'failed' excludes the row — must NOT count as a successful send", async () => {
    const calls: CallLog = [];
    const admin = makeAdmin(
      {
        medmar_convocation_rows: [row({ provider_message_id: "wamid.failed" })],
        whatsapp_message_statuses: [{ wa_message_id: "wamid.failed", status: "failed", timestamp: "2026-09-06T09:00:00.000Z", created_at: "2026-09-06T09:00:00.000Z" }],
      },
      calls,
    );
    const result = await loadMedmarSentSnapshots(admin as never, TENANT_A, ["svc-1"], []);
    expect(result.byServiceId.has("svc-1")).toBe(false);
  });

  it("accepted-but-no-webhook-yet still counts as a successful send (Meta accepted it)", async () => {
    const calls: CallLog = [];
    const admin = makeAdmin(
      { medmar_convocation_rows: [row({ provider_message_id: "wamid.no-webhook-yet" })], whatsapp_message_statuses: [] },
      calls,
    );
    const result = await loadMedmarSentSnapshots(admin as never, TENANT_A, ["svc-1"], []);
    expect(result.byServiceId.has("svc-1")).toBe(true);
  });

  it("14. every query is scoped by tenant_id", async () => {
    const calls: CallLog = [];
    const admin = makeAdmin({ medmar_convocation_rows: [row()], whatsapp_message_statuses: [] }, calls);
    await loadMedmarSentSnapshots(admin as never, TENANT_A, ["svc-1"], ["+393331234567"]);

    const tenantCalls = calls.filter((c) => c.table === "medmar_convocation_rows" && c.method === "eq" && c.args[0] === "tenant_id");
    expect(tenantCalls.length).toBeGreaterThan(0);
    expect(tenantCalls.every((c) => c.args[1] === TENANT_A)).toBe(true);
  });

  it("15. issues a bounded number of queries regardless of row count (no N+1)", async () => {
    const calls: CallLog = [];
    const manyServiceIds = Array.from({ length: 300 }, (_, i) => `svc-${i}`);
    const admin = makeAdmin({ medmar_convocation_rows: [], whatsapp_message_statuses: [] }, calls);
    await loadMedmarSentSnapshots(admin as never, TENANT_A, manyServiceIds, []);

    // One chunk of service_ids (well under the 500-per-chunk limit) -> exactly
    // one medmar_convocation_rows query, not one per service.
    const rowQueries = calls.filter((c) => c.table === "medmar_convocation_rows" && c.method === "select");
    expect(rowQueries).toHaveLength(1);
  });

  it("keeps the most recent snapshot when a service_id has multiple successful sends", async () => {
    const calls: CallLog = [];
    const admin = makeAdmin(
      {
        medmar_convocation_rows: [
          row({ id: "row-old", hotel: "Old Hotel", sent_at: "2026-09-01T08:00:00.000Z", provider_message_id: null }),
          row({ id: "row-new", hotel: "New Hotel", sent_at: "2026-09-06T08:00:00.000Z", provider_message_id: null }),
        ],
      },
      calls,
    );
    const result = await loadMedmarSentSnapshots(admin as never, TENANT_A, ["svc-1"], []);
    expect(result.byServiceId.get("svc-1")?.hotel).toBe("New Hotel");
  });
});
