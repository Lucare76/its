import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { summarizeFuelInvoice } from "@/lib/server/fuel-invoice-close";

const mocks = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorize }));
vi.mock("@/lib/server/fuel-invoice-pdf", () => ({ extractFuelInvoiceLines: vi.fn() }));
import { POST } from "@/app/api/ops/fuel-invoice-reconciliation/route";

const DOC = "Fattura ENI 30248070";
const line = (id: string, amount: number, liters: number, fuel: string | null, line_no = 1) =>
  ({ id, line_no, amount, liters, matched_fuel_id: fuel });
const fuel = (id: string, cost: number | null, liters: number | null, extra: Record<string, unknown> = {}) =>
  ({ id, cost, liters, approval_status: "approved", fiscal_document_name: null, fiscal_document_url: null, ...extra });

describe("riepilogo fattura", () => {
  it("tutto collegato e uguale: la fattura torna", () => {
    const summary = summarizeFuelInvoice(
      [line("L1", 150.08, 68.53, "F1"), line("L2", 422.03, 192.71, "F2", 2)],
      [fuel("F1", 150.08, 68.53), fuel("F2", 422.03, 192.71)], DOC);
    expect(summary).toMatchObject({ all_match: true, lines_count: 2, lines_linked: 2,
      invoice_total: 572.11, linked_total: 572.11, unlinked_amount: 0, linked_difference: 0 });
  });

  it("somma in centesimi senza errori di virgola mobile", () => {
    const lines = Array.from({ length: 10 }, (_, i) => line(`L${i}`, 0.1, 1, `F${i}`, i + 1));
    const fuels = Array.from({ length: 10 }, (_, i) => fuel(`F${i}`, 0.1, 1));
    expect(summarizeFuelInvoice(lines, fuels, DOC)).toMatchObject({ invoice_total: 1, linked_total: 1, all_match: true });
  });

  it("tollera 1 centesimo per riga (netto UTA), non 2", () => {
    expect(summarizeFuelInvoice([line("L1", 40.98, 25, "F1")], [fuel("F1", 40.9836, 25)], DOC).all_match).toBe(true);
    const off = summarizeFuelInvoice([line("L1", 40.98, 25, "F1")], [fuel("F1", 40.96, 25)], DOC);
    expect(off.all_match).toBe(false);
    expect(off.lines_with_differences).toEqual([{ line_id: "L1", line_no: 1, amount_difference: 0.02, liters_difference: 0 }]);
  });

  it("riga senza collegamento: non torna e ne conta l'importo", () => {
    const summary = summarizeFuelInvoice([line("L1", 100, 50, "F1"), line("L2", 30.5, 15, null, 2)], [fuel("F1", 100, 50)], DOC);
    expect(summary).toMatchObject({ all_match: false, unlinked_amount: 30.5, invoice_total: 130.5, linked_total: 100,
      unlinked_lines: [{ line_id: "L2", line_no: 2 }] });
  });

  it("litri diversi o importo mancante = differenza", () => {
    expect(summarizeFuelInvoice([line("L1", 100, 50, "F1")], [fuel("F1", 100, 49.9)], DOC).all_match).toBe(false);
    expect(summarizeFuelInvoice([line("L1", 100, 50, "F1")], [fuel("F1", null, 50)], DOC).all_match).toBe(false);
  });

  it("fattura vuota non torna", () => {
    expect(summarizeFuelInvoice([], [], DOC).all_match).toBe(false);
  });

  it("conta i da approvare e i documenti fiscali diversi (non quello della stessa fattura)", () => {
    const summary = summarizeFuelInvoice(
      [line("L1", 10, 5, "F1"), line("L2", 10, 5, "F2", 2), line("L3", 10, 5, "F3", 3)],
      [fuel("F1", 10, 5, { approval_status: "pending" }), fuel("F2", 10, 5, { fiscal_document_name: "Scontrino 12" }),
        fuel("F3", 10, 5, { fiscal_document_name: DOC })], DOC);
    expect(summary.pending_approval).toBe(1);
    expect(summary.document_conflicts).toEqual([{ fuel_id: "F2", fiscal_document_name: "Scontrino 12" }]);
    expect(summary.all_match).toBe(true);
  });
});

// ---------------------------------------------------------------- API

type Call = { table: string; method: string; args: unknown[] };
let calls: Call[];
let state: {
  invoice: Record<string, unknown> | null;
  lines: unknown[];
  fuels: unknown[];
  flag: { enabled: boolean } | null;
  member: { user_id: string; role: string } | null;
  closeUpdate: unknown;
};

function fakeDb() {
  return {
    from(table: string) {
      const ops: string[] = [];
      const eqColumns: unknown[] = [];
      const query: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "is", "not", "order", "limit", "update", "insert", "upsert"]) {
        query[method] = (...args: unknown[]) => {
          calls.push({ table, method, args }); ops.push(method);
          if (method === "eq") eqColumns.push(args[0]);
          return query;
        };
      }
      const resolve = () => {
        if (table === "fuel_invoice_imports") {
          if (ops.includes("update")) return { data: state.closeUpdate, error: null };
          return { data: state.invoice, error: null };
        }
        if (table === "fuel_invoice_lines") {
          if (ops.includes("update")) return { data: { id: "L1" }, error: null };
          // Lettura di una singola riga (per id) = controllo fattura chiusa prima di link/unlink.
          return { data: eqColumns.includes("id") ? { import_id: IMPORT_ID } : state.lines, error: null };
        }
        if (table === "vehicle_fuel") {
          if (ops.includes("update")) return { data: (state.fuels as Array<{ id: string }>).map((row) => ({ id: row.id })), error: null };
          return { data: state.fuels, error: null };
        }
        if (table === "tenant_user_feature_flags") return { data: ops.includes("upsert") ? null : state.flag, error: null };
        if (table === "memberships") return { data: state.member, error: null };
        return { data: null, error: null };
      };
      query.maybeSingle = () => Promise.resolve(resolve());
      query.single = () => Promise.resolve(resolve());
      query.then = (ok: (value: unknown) => unknown) => Promise.resolve(resolve()).then(ok);
      return query;
    },
  };
}

function as(role: string) {
  mocks.authorize.mockResolvedValue({ admin: fakeDb(), user: { id: "user-1" }, membership: { tenant_id: "tenant-a", role } });
}
const post = (body: unknown) => POST(new NextRequest("https://its.test/api/ops/fuel-invoice-reconciliation", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const IMPORT_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const LINE_ID = "55555555-5555-4555-8555-555555555555";
const FUEL_ID = "66666666-6666-4666-8666-666666666666";
const updatesOf = (table: string) => calls.filter((call) => call.table === table && call.method === "update").map((call) => call.args[0]);

beforeEach(() => {
  calls = [];
  state = {
    invoice: { id: IMPORT_ID, supplier: "ENI", invoice_number: "30248070", status: "open" },
    lines: [line("L1", 150.08, 68.53, "F1")],
    fuels: [fuel("F1", 150.08, 68.53)],
    flag: null,
    member: { user_id: USER_ID, role: "operator" },
    closeUpdate: { id: IMPORT_ID },
  };
});

describe("chiusura fattura", () => {
  it("admin chiude una fattura che torna e scrive il documento fiscale", async () => {
    as("admin");
    const res = await post({ action: "close", import_id: IMPORT_ID });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, outcome: "ok", documents_written: 1 });
    expect(updatesOf("fuel_invoice_imports")[0]).toMatchObject({ status: "closed", close_outcome: "ok", closed_by: "user-1" });
    expect(calls).toContainEqual({ table: "fuel_invoice_imports", method: "eq", args: ["status", "open"] });
    expect(updatesOf("vehicle_fuel")[0]).toEqual({ fiscal_document_name: DOC, last_edited_by: "user-1" });
    const review = calls.find((call) => call.table === "fuel_invoice_reviews" && call.method === "insert")?.args[0];
    expect(review).toMatchObject({ event: "closed", outcome: "ok", invoice_total: 150.08, linked_total: 150.08 });
  });

  it("non sovrascrive un documento fiscale già presente", async () => {
    as("admin");
    state.fuels = [fuel("F1", 150.08, 68.53, { fiscal_document_name: "Scontrino 12" })];
    const body = await (await post({ action: "close", import_id: IMPORT_ID })).json();
    expect(body).toMatchObject({ ok: true, documents_written: 0, document_conflicts: 1 });
    expect(updatesOf("vehicle_fuel")).toEqual([]);
  });

  it("se non torna serve la nota, e con la nota chiude 'con note'", async () => {
    as("admin");
    state.lines = [line("L1", 150.08, 68.53, "F1"), line("L2", 20, 10, null, 2)];
    const refused = await post({ action: "close", import_id: IMPORT_ID });
    expect(refused.status).toBe(400);
    expect(updatesOf("fuel_invoice_imports")).toEqual([]);
    calls = [];
    const res = await post({ action: "close", import_id: IMPORT_ID, note: "riga 2 contestata a ENI" });
    expect(res.status).toBe(200);
    expect(updatesOf("fuel_invoice_imports")[0]).toMatchObject({ close_outcome: "with_notes", close_note: "riga 2 contestata a ENI" });
  });

  it("operatore: chiude solo se abilitato", async () => {
    as("operator");
    expect((await post({ action: "close", import_id: IMPORT_ID })).status).toBe(403);
    state.flag = { enabled: true };
    expect((await post({ action: "close", import_id: IMPORT_ID })).status).toBe(200);
  });

  it("supervisore non può chiudere", async () => {
    as("supervisor");
    state.flag = { enabled: true };
    expect((await post({ action: "close", import_id: IMPORT_ID })).status).toBe(403);
  });

  it("fattura già chiusa: 409", async () => {
    as("admin");
    state.invoice = { ...state.invoice, status: "closed" };
    expect((await post({ action: "close", import_id: IMPORT_ID })).status).toBe(409);
  });
});

describe("riapertura e permessi", () => {
  it("solo admin riapre, con motivo", async () => {
    state.invoice = { ...state.invoice, status: "closed" };
    as("operator");
    state.flag = { enabled: true };
    expect((await post({ action: "reopen", import_id: IMPORT_ID, reason: "nota di credito ENI" })).status).toBe(403);
    as("admin");
    expect((await post({ action: "reopen", import_id: IMPORT_ID, reason: "no" })).status).toBe(400);
    const res = await post({ action: "reopen", import_id: IMPORT_ID, reason: "nota di credito ENI" });
    expect(res.status).toBe(200);
    expect(updatesOf("fuel_invoice_imports")[0]).toMatchObject({ status: "open", close_outcome: null, close_note: null });
    expect(calls.find((call) => call.table === "fuel_invoice_reviews" && call.method === "insert")?.args[0])
      .toMatchObject({ event: "reopened", note: "nota di credito ENI" });
  });

  it("solo admin abilita gli operatori, e solo operatori", async () => {
    as("operator");
    expect((await post({ action: "set_closer", user_id: USER_ID, enabled: true })).status).toBe(403);
    as("admin");
    expect((await post({ action: "set_closer", user_id: USER_ID, enabled: true })).status).toBe(200);
    expect(calls.find((call) => call.method === "upsert")?.args[0])
      .toEqual({ tenant_id: "tenant-a", user_id: USER_ID, feature_code: "fuel_invoice_close", enabled: true });
    state.member = { user_id: USER_ID, role: "supervisor" };
    expect((await post({ action: "set_closer", user_id: USER_ID, enabled: true })).status).toBe(400);
  });

  it("non collega né scollega righe di una fattura chiusa", async () => {
    as("admin");
    state.invoice = { ...state.invoice, status: "closed" };
    expect((await post({ action: "unlink", line_id: LINE_ID })).status).toBe(409);
    expect((await post({ action: "link", line_id: LINE_ID, fuel_id: FUEL_ID })).status).toBe(409);
    expect(updatesOf("fuel_invoice_lines")).toEqual([]);
  });
});
