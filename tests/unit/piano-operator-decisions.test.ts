import { describe, expect, it } from "vitest";

import {
  buildSuggestionHash,
  insertOperatorDecision,
  loadConfirmedOperatorDecisions,
  revokeOperatorDecision,
  supersedeOverlappingOperatorDecisions,
} from "@/lib/server/piano-operator-decisions";
import type { PricingAuthContext } from "@/lib/server/pricing-auth";

type QueryResult = { data?: unknown; error?: { code?: string; message: string } | null };

function createQueryMock(result: QueryResult, calls: Array<{ op: string; args: unknown[] }>) {
  const query = {
    select: (...args: unknown[]) => {
      calls.push({ op: "select", args });
      return query;
    },
    eq: (...args: unknown[]) => {
      calls.push({ op: "eq", args });
      return query;
    },
    in: (...args: unknown[]) => {
      calls.push({ op: "in", args });
      return query;
    },
    order: (...args: unknown[]) => {
      calls.push({ op: "order", args });
      return Promise.resolve({ data: result.data ?? [], error: result.error ?? null });
    },
    insert: (...args: unknown[]) => {
      calls.push({ op: "insert", args });
      return query;
    },
    update: (...args: unknown[]) => {
      calls.push({ op: "update", args });
      return query;
    },
    single: () => {
      calls.push({ op: "single", args: [] });
      return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
    },
  };
  return query;
}

function auth(result: QueryResult = { data: [] }) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const ctx = {
    admin: {
      from: (table: string) => {
        calls.push({ op: "from", args: [table] });
        return createQueryMock(result, calls);
      },
    },
    user: { id: "user-1", email: "ops@example.com" },
    membership: { tenant_id: "tenant-1", role: "operator", suspended: false },
  } as unknown as PricingAuthContext;

  return { ctx, calls };
}

describe("piano operator decisions", () => {
  it("builds a stable suggestion hash regardless of service id order", () => {
    const first = buildSuggestionHash({
      tenant_id: "tenant-1",
      service_date: "2026-05-07",
      trip_group_id: "group-1",
      action: "ACCORPARE_CON_CONFERMA",
      service_ids: ["rossi", "iori"],
      before_json: [{ stop: "12:15" }, { stop: "12:30" }],
      after_json: { route: "La Villa -> Casamicciola" },
    });
    const second = buildSuggestionHash({
      tenant_id: "tenant-1",
      service_date: "2026-05-07",
      trip_group_id: "group-1",
      action: "ACCORPARE_CON_CONFERMA",
      service_ids: ["iori", "rossi"],
      before_json: [{ stop: "12:15" }, { stop: "12:30" }],
      after_json: { route: "La Villa -> Casamicciola" },
    });

    expect(first).toBe(second);
  });

  it("changes hash when action changes", () => {
    const base = {
      tenant_id: "tenant-1",
      service_date: "2026-05-07",
      trip_group_id: "group-1",
      service_ids: ["iori", "rossi"],
      after_json: { route: "La Villa -> Casamicciola" },
    };

    expect(buildSuggestionHash({ ...base, action: "ACCORPARE_CON_CONFERMA" }))
      .not.toBe(buildSuggestionHash({ ...base, action: "MULTI_DROP" }));
  });

  it("changes hash when after_json changes", () => {
    const base = {
      tenant_id: "tenant-1",
      service_date: "2026-05-07",
      trip_group_id: "group-1",
      action: "ACCORPARE_CON_CONFERMA",
      service_ids: ["iori", "rossi"],
    };

    expect(buildSuggestionHash({ ...base, after_json: { route: "La Villa -> Casamicciola" } }))
      .not.toBe(buildSuggestionHash({ ...base, after_json: { route: "La Villa -> Ischia Porto" } }));
  });

  it("inserts an operator decision without touching services assignments or trip groups", async () => {
    const { ctx, calls } = auth({ data: { id: "decision-1", status: "confirmed" } });
    const result = await insertOperatorDecision(ctx, {
      service_date: "2026-05-07",
      trip_group_id: "group-1",
      decision_type: "accorpamento_confirmed",
      action: "ACCORPARE_CON_CONFERMA",
      service_ids: ["iori", "rossi"],
      payload_json: { route: "La Villa -> Casamicciola" },
      before_json: [{ stop: "12:15" }, { stop: "12:30" }],
      after_json: [{ stop: "12:15-12:30" }],
    });

    expect(result.duplicate).toBe(false);
    expect(result.decision.id).toBe("decision-1");
    expect(calls.map((call) => call.args[0])).toContain("piano_operator_decisions");
    expect(calls.map((call) => call.args[0])).not.toContain("services");
    expect(calls.map((call) => call.args[0])).not.toContain("assignments");
    expect(calls.map((call) => call.args[0])).not.toContain("trip_groups");
  });

  it("handles duplicate confirmation by returning the existing decision", async () => {
    const calls: Array<{ op: string; args: unknown[] }> = [];
    let queryIndex = 0;
    const ctx = {
      admin: {
        from: (table: string) => {
          calls.push({ op: "from", args: [table] });
          queryIndex += 1;
          return createQueryMock(
            queryIndex === 1
              ? { error: { code: "23505", message: "duplicate key value violates unique constraint" } }
              : { data: { id: "existing-decision", status: "confirmed" } },
            calls
          );
        },
      },
      user: { id: "user-1", email: "ops@example.com" },
      membership: { tenant_id: "tenant-1", role: "operator", suspended: false },
    } as unknown as PricingAuthContext;

    const result = await insertOperatorDecision(ctx, {
      service_date: "2026-05-07",
      trip_group_id: "group-1",
      decision_type: "accorpamento_confirmed",
      action: "ACCORPARE_CON_CONFERMA",
      service_ids: ["iori", "rossi"],
      before_json: [],
      after_json: [],
    });

    expect(result.duplicate).toBe(true);
    expect(result.decision.id).toBe("existing-decision");
  });

  it("loads only confirmed decisions for the requested date", async () => {
    const { ctx, calls } = auth({ data: [{ id: "decision-1", status: "confirmed" }] });
    const rows = await loadConfirmedOperatorDecisions(ctx, "2026-05-07");

    expect(rows).toHaveLength(1);
    expect(calls).toEqual(expect.arrayContaining([
      { op: "from", args: ["piano_operator_decisions"] },
      { op: "eq", args: ["tenant_id", "tenant-1"] },
      { op: "eq", args: ["service_date", "2026-05-07"] },
      { op: "eq", args: ["status", "confirmed"] },
    ]));
  });

  it("revokes a confirmed decision without touching services assignments or trip groups", async () => {
    const { ctx, calls } = auth({ data: { id: "decision-1", status: "revoked" } });
    const row = await revokeOperatorDecision(ctx, "decision-1");

    expect(row.status).toBe("revoked");
    expect(calls.map((call) => call.args[0])).toContain("piano_operator_decisions");
    expect(calls.map((call) => call.args[0])).not.toContain("services");
    expect(calls.map((call) => call.args[0])).not.toContain("assignments");
    expect(calls.map((call) => call.args[0])).not.toContain("trip_groups");
    expect(calls).toEqual(expect.arrayContaining([
      { op: "eq", args: ["id", "decision-1"] },
      { op: "eq", args: ["status", "confirmed"] },
    ]));
  });

  it("supersedes a confirmed partial multi-drop when a complete superset is confirmed", async () => {
    const calls: Array<{ op: string; args: unknown[] }> = [];
    let fromCount = 0;
    const partial = {
      id: "partial-riccardo",
      tenant_id: "tenant-1",
      service_date: "2026-05-07",
      trip_group_id: "group-riccardo",
      decision_type: "multi_drop_confirmed",
      action: "MULTI_DROP",
      suggestion_hash: "old-hash",
      status: "confirmed",
      payload_json: {
        multi_drop: {
          pickup_label: "LA VILLA",
          suggested_order: ["Casamicciola", "Ischia Porto"],
          services: [
            { service_id: "catullo" },
            { service_id: "lodi" },
            { service_id: "paoletti" },
          ],
        },
      },
    };
    const superseded = { ...partial, status: "superseded" };
    const ctx = {
      admin: {
        from: (table: string) => {
          calls.push({ op: "from", args: [table] });
          fromCount += 1;
          return createQueryMock(fromCount === 1 ? { data: [partial] } : { data: [superseded] }, calls);
        },
      },
      user: { id: "user-1", email: "ops@example.com" },
      membership: { tenant_id: "tenant-1", role: "operator", suspended: false },
    } as unknown as PricingAuthContext;

    const rows = await supersedeOverlappingOperatorDecisions(ctx, {
      service_date: "2026-05-07",
      trip_group_id: "group-riccardo",
      decision_type: "multi_drop_confirmed",
      action: "MULTI_DROP",
      service_ids: ["catullo", "lodi", "lamantia", "paoletti"],
      payload_json: {
        multi_drop: {
          pickup_label: "LA VILLA",
          suggested_order: ["Casamicciola", "Ischia Porto"],
          services: [
            { service_id: "catullo" },
            { service_id: "lodi" },
            { service_id: "lamantia" },
            { service_id: "paoletti" },
          ],
        },
      },
      before_json: [],
      after_json: [],
      new_decision_id: "complete-riccardo",
      suggestion_hash: "new-hash",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("superseded");
    expect(calls).toEqual(expect.arrayContaining([
      { op: "eq", args: ["action", "MULTI_DROP"] },
      { op: "eq", args: ["status", "confirmed"] },
      { op: "in", args: ["id", ["partial-riccardo"]] },
    ]));
    expect(calls.map((call) => call.args[0])).not.toContain("services");
    expect(calls.map((call) => call.args[0])).not.toContain("assignments");
    expect(calls.map((call) => call.args[0])).not.toContain("trip_groups");
  });
});
