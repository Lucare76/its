import { beforeEach, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { autoLinkExactMatches } from "@/lib/server/fuel-invoice-auto-link";

type Call = { table: string; method: string; args: unknown[] };
let calls: Call[];
let openLines: unknown[];
let manual: unknown[];
let updateResult: { data: unknown; error: unknown };

function db() {
  return {
    from(table: string) {
      const query: Record<string, unknown> = {};
      let isUpdate = false; let isLinksQuery = false;
      for (const method of ["select", "eq", "is", "not", "gte", "lte", "limit", "update"]) {
        query[method] = (...args: unknown[]) => {
          calls.push({ table, method, args });
          if (method === "update") isUpdate = true;
          if (method === "not") isLinksQuery = true;
          return query;
        };
      }
      const result = () => table === "vehicle_fuel" ? { data: manual, error: null }
        : isLinksQuery ? { data: [], error: null } : { data: openLines, error: null };
      query.maybeSingle = () => Promise.resolve(isUpdate ? updateResult : result());
      query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve);
      return query;
    },
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  calls = [];
  openLines = [{ id: "L1", fuel_date: "2026-10-19", station: "ANAGNI", liters: 68.53, amount: 150.08, reference: "00944117" }];
  manual = [{ id: "F1", fuel_date: "2026-10-19", station: "ANAGNI", liters: 68.53, cost: 150.08, invoice_supplier: "ENI", approval_status: "approved" }];
  updateResult = { data: { id: "L1" }, error: null };
});

it("considera solo righe libere e mai gestite, del tenant e della fattura", async () => {
  await autoLinkExactMatches(db(), "tenant-a", "imp-1", "ENI", "user-1");
  const lineFilters = calls.filter((call) => call.table === "fuel_invoice_lines").slice(0, 5);
  expect(lineFilters).toEqual(expect.arrayContaining([
    { table: "fuel_invoice_lines", method: "eq", args: ["tenant_id", "tenant-a"] },
    { table: "fuel_invoice_lines", method: "eq", args: ["import_id", "imp-1"] },
    { table: "fuel_invoice_lines", method: "is", args: ["matched_fuel_id", null] },
    { table: "fuel_invoice_lines", method: "is", args: ["match_method", null] },
  ]));
  expect(calls).toContainEqual({ table: "vehicle_fuel", method: "eq", args: ["tenant_id", "tenant-a"] });
  expect(calls).toContainEqual({ table: "vehicle_fuel", method: "eq", args: ["invoice_supplier", "ENI"] });
});

it("collega marcando la riga come automatica, solo se ancora libera", async () => {
  expect(await autoLinkExactMatches(db(), "tenant-a", "imp-1", "ENI", "user-1")).toBe(1);
  const update = calls.find((call) => call.method === "update");
  expect(update?.args[0]).toMatchObject({ matched_fuel_id: "F1", matched_by: "user-1", match_method: "auto" });
  const after = calls.slice(calls.indexOf(update!));
  expect(after).toContainEqual({ table: "fuel_invoice_lines", method: "is", args: ["matched_fuel_id", null] });
  expect(after).toContainEqual({ table: "fuel_invoice_lines", method: "is", args: ["match_method", null] });
});

it("non conta i collegamenti persi per concorrenza o conflitto", async () => {
  updateResult = { data: null, error: null };
  expect(await autoLinkExactMatches(db(), "tenant-a", "imp-1", "ENI", "user-1")).toBe(0);
  updateResult = { data: null, error: { message: "duplicate key" } };
  expect(await autoLinkExactMatches(db(), "tenant-a", "imp-1", "ENI", "user-1")).toBe(0);
});

it("non interroga i rifornimenti se non ci sono righe da collegare", async () => {
  openLines = [];
  expect(await autoLinkExactMatches(db(), "tenant-a", "imp-1", "ENI", "user-1")).toBe(0);
  expect(calls.some((call) => call.table === "vehicle_fuel")).toBe(false);
});
