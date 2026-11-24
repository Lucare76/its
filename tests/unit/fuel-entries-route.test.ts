import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorize }));
import { GET, POST } from "@/app/api/ops/fuel-entries/route";

type Call = { table: string; method: string; args: unknown[] };
let calls: Call[];
let rows: Record<string, unknown>;

const VEHICLE_ID = "11111111-1111-4111-8111-111111111111";
const FUEL_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  calls = [];
  rows = {
    vehicles: { id: VEHICLE_ID },
    vehicle_fuel: { id: FUEL_ID, submitted_via_qr: true, invoice_supplier: "ENI" },
    fuel_invoice_lines: null,
    driver_profiles: [{ id: "d1", full_name: "Mario Rossi" }],
  };
  const admin = {
    from(table: string) {
      const query: Record<string, unknown> = {};
      for (const method of ["select", "eq", "is", "not", "neq", "order", "limit", "insert", "update", "delete", "gte", "lte"]) {
        query[method] = (...args: unknown[]) => { calls.push({ table, method, args }); return query; };
      }
      const result = () => ({ data: rows[table] ?? null, error: null, count: 0 });
      query.maybeSingle = () => Promise.resolve(result());
      query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve);
      return query;
    },
  };
  mocks.authorize.mockResolvedValue({ admin, user: { id: "user-1" }, membership: { tenant_id: "tenant-a", role: "operator" } });
});

const post = (body: unknown) =>
  POST(new NextRequest("https://its.test/api/ops/fuel-entries", { method: "POST", body: JSON.stringify(body) }));
const written = (method: "insert" | "update") =>
  calls.find((call) => call.table === "vehicle_fuel" && call.method === method)?.args[0] as Record<string, unknown>;

describe("fuel-entries — nome autista", () => {
  it("salva l'autista inserito dall'ufficio in un nuovo rifornimento", async () => {
    const res = await post({ action: "create", data: { vehicle_id: VEHICLE_ID, fuel_date: "2026-11-24", driver_name: "  Mario Rossi " } });
    expect(res.status).toBe(200);
    expect(written("insert")).toMatchObject({ driver_name: "Mario Rossi", tenant_id: "tenant-a", submitted_via_qr: false });
  });

  it("permette all'ufficio di aggiungere l'autista mancante con la modifica", async () => {
    const res = await post({ action: "edit", data: { id: FUEL_ID, vehicle_id: VEHICLE_ID, fuel_date: "2026-11-24", invoice_supplier: "ENI", driver_name: "Luigi Bianchi" } });
    expect(res.status).toBe(200);
    expect(written("update")).toMatchObject({ driver_name: "Luigi Bianchi" });
  });

  it("una modifica senza driver_name non cancella l'autista già salvato", async () => {
    const res = await post({ action: "edit", data: { id: FUEL_ID, vehicle_id: VEHICLE_ID, fuel_date: "2026-11-24", invoice_supplier: "ENI", cost: 50, liters: 25 } });
    expect(res.status).toBe(200);
    expect(written("update")).not.toHaveProperty("driver_name");
    calls = [];
    await post({ action: "edit", data: { id: FUEL_ID, vehicle_id: VEHICLE_ID, fuel_date: "2026-11-24", invoice_supplier: "ENI", driver_name: "" } });
    expect(written("update")).toMatchObject({ driver_name: null });
  });

  it("salva null quando l'autista è vuoto o assente", async () => {
    await post({ action: "create", data: { vehicle_id: VEHICLE_ID, fuel_date: "2026-11-24", driver_name: "   " } });
    expect(written("insert")).toMatchObject({ driver_name: null });
    calls = [];
    await post({ action: "create", data: { vehicle_id: VEHICLE_ID, fuel_date: "2026-11-24" } });
    expect(written("insert")).toMatchObject({ driver_name: null });
  });

  it("restituisce driver_name nei record e la lista autisti attivi del tenant", async () => {
    rows.vehicles = [{ id: VEHICLE_ID, label: "Bus 1" }];
    rows.vehicle_fuel = [{ id: FUEL_ID, vehicle_id: VEHICLE_ID, driver_name: "Mario Rossi" }];
    const res = await GET(new NextRequest("https://its.test/api/ops/fuel-entries"));
    const body = await res.json();
    expect(body.records[0]).toMatchObject({ driver_name: "Mario Rossi" });
    expect(body.drivers).toEqual([{ id: "d1", full_name: "Mario Rossi" }]);
    const fuelSelect = calls.find((call) => call.table === "vehicle_fuel" && call.method === "select" && String(call.args[0]).includes("fuel_date"));
    expect(String(fuelSelect?.args[0])).toContain("driver_name");
    expect(calls).toContainEqual({ table: "driver_profiles", method: "eq", args: ["tenant_id", "tenant-a"] });
    expect(calls).toContainEqual({ table: "driver_profiles", method: "eq", args: ["active", true] });
  });
});

describe("fuel-entries — filtro date", () => {
  const get = (query = "") => GET(new NextRequest(`https://its.test/api/ops/fuel-entries${query}`));
  beforeEach(() => {
    rows.vehicles = [];
    rows.vehicle_fuel = [];
  });

  it("applica il periodo sia all'elenco sia ai contatori degli stati", async () => {
    const res = await get("?status=approved&date_from=2026-10-01&date_to=2026-10-31");
    expect(res.status).toBe(200);
    const gte = calls.filter((call) => call.table === "vehicle_fuel" && call.method === "gte");
    const lte = calls.filter((call) => call.table === "vehicle_fuel" && call.method === "lte");
    // 1 elenco + 3 contatori (da approvare, approvati, respinti)
    expect(gte).toHaveLength(4);
    expect(lte).toHaveLength(4);
    expect(gte.every((call) => call.args[0] === "fuel_date" && call.args[1] === "2026-10-01")).toBe(true);
    expect(lte.every((call) => call.args[0] === "fuel_date" && call.args[1] === "2026-10-31")).toBe(true);
  });

  it("senza date non filtra per periodo", async () => {
    await get();
    expect(calls.some((call) => call.method === "gte" || call.method === "lte")).toBe(false);
  });

  it("accetta anche un solo estremo", async () => {
    await get("?date_from=2026-11-01");
    expect(calls.filter((call) => call.method === "gte")).toHaveLength(4);
    expect(calls.some((call) => call.method === "lte")).toBe(false);
  });

  it.each([
    ["?date_from=01/10/2026", "formato non ISO"],
    ["?date_to=2026-13-45", "data inesistente"],
    ["?date_from=2026-11-01&date_to=2026-10-01", "inizio dopo la fine"],
  ])("rifiuta %s (%s)", async (query) => {
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(calls.some((call) => call.table === "vehicle_fuel")).toBe(false);
  });

  it("segnala quando l'elenco supera il limite di 250", async () => {
    rows.vehicle_fuel = Array.from({ length: 251 }, (_, i) => ({ id: `f${i}`, vehicle_id: VEHICLE_ID }));
    const body = await (await get()).json();
    expect(body.truncated).toBe(true);
    expect(body.records).toHaveLength(250);
    rows.vehicle_fuel = Array.from({ length: 250 }, (_, i) => ({ id: `f${i}`, vehicle_id: VEHICLE_ID }));
    expect((await (await get()).json()).truncated).toBe(false);
  });
});

describe("fuel-entries — Q8, contanti e rimborso all'autista", () => {
  const CASH = { id: FUEL_ID, invoice_supplier: "CONTANTI", cost: 50, approval_status: "approved", reimbursed_at: null };
  const setRole = async (role: string) => {
    const base = await mocks.authorize();
    mocks.authorize.mockResolvedValue({ ...base, membership: { ...base.membership, role } });
  };

  it("accetta Q8 e CONTANTI come pagamento, rifiuta valori sconosciuti", async () => {
    for (const supplier of ["Q8", "CONTANTI"]) {
      calls = [];
      const res = await post({ action: "create", data: { vehicle_id: VEHICLE_ID, fuel_date: "2026-11-24", invoice_supplier: supplier, cost: 40 } });
      expect(res.status).toBe(200);
      expect(written("insert")).toMatchObject({ invoice_supplier: supplier });
    }
    rows.vehicle_fuel = { id: FUEL_ID, invoice_supplier: null, cost: 40, submitted_via_qr: false };
    const assigned = await post({ action: "assign_supplier", data: { id: FUEL_ID, invoice_supplier: "CONTANTI" } });
    expect(assigned.status).toBe(200);
    const bad = await post({ action: "assign_supplier", data: { id: FUEL_ID, invoice_supplier: "SHELL" } });
    expect(bad.status).toBe(400);
  });

  it("segna rimborsato un rifornimento in contanti (admin/operatore)", async () => {
    rows.vehicle_fuel = { ...CASH };
    const res = await post({ action: "reimburse", data: { id: FUEL_ID, note: "bonifico 25/11" } });
    expect(res.status).toBe(200);
    expect(written("update")).toMatchObject({ reimbursed_by: "user-1", reimbursement_note: "bonifico 25/11" });
    expect(typeof written("update").reimbursed_at).toBe("string");
    expect(calls).toContainEqual({ table: "vehicle_fuel", method: "is", args: ["reimbursed_at", null] });
  });

  it.each([
    ["non è in contanti", { invoice_supplier: "ENI" }, 409],
    ["è respinto", { approval_status: "rejected" }, 409],
    ["non ha importo", { cost: null }, 409],
  ])("non rimborsa se %s", async (_label, change, status) => {
    rows.vehicle_fuel = { ...CASH, ...change };
    expect((await post({ action: "reimburse", data: { id: FUEL_ID } })).status).toBe(status);
    expect(written("update")).toBeUndefined();
  });

  it("supervisore non rimborsa; solo admin annulla un rimborso", async () => {
    rows.vehicle_fuel = { ...CASH };
    await setRole("supervisor");
    expect((await post({ action: "reimburse", data: { id: FUEL_ID } })).status).toBe(403);
    rows.vehicle_fuel = { ...CASH, reimbursed_at: "2026-11-24T10:00:00Z" };
    await setRole("operator");
    expect((await post({ action: "unreimburse", data: { id: FUEL_ID } })).status).toBe(403);
    await setRole("admin");
    calls = [];
    expect((await post({ action: "unreimburse", data: { id: FUEL_ID } })).status).toBe(200);
    expect(written("update")).toMatchObject({ reimbursed_at: null, reimbursed_by: null, reimbursement_note: null });
  });

  it("un contante già rimborsato non può cambiare metodo di pagamento", async () => {
    rows.vehicle_fuel = { ...CASH, submitted_via_qr: false, reimbursed_at: "2026-11-24T10:00:00Z" };
    const res = await post({ action: "edit", data: { id: FUEL_ID, vehicle_id: VEHICLE_ID, fuel_date: "2026-11-24", invoice_supplier: "ENI" } });
    expect(res.status).toBe(409);
    expect(written("update")).toBeUndefined();
  });

  it("GET: riepilogo contanti da rimborsare per autista, in centesimi", async () => {
    rows.vehicles = [];
    rows.vehicle_fuel = [
      { cost: 0.1, driver_name: "Mario Rossi" }, { cost: 0.2, driver_name: "Mario Rossi" },
      { cost: 30, driver_name: "Luigi Bianchi" }, { cost: null, driver_name: null },
    ];
    const body = await (await GET(new NextRequest("https://its.test/api/ops/fuel-entries"))).json();
    expect(body.cash_to_reimburse).toEqual({
      count: 4, total: 30.3, missing_amount: 1,
      by_driver: [
        { driver_name: "Luigi Bianchi", count: 1, total: 30 },
        { driver_name: "Mario Rossi", count: 2, total: 0.3 },
        { driver_name: "Autista non indicato", count: 1, total: 0 },
      ],
    });
  });

  it("GET reimbursement=pending filtra solo i contanti non rimborsati e non respinti", async () => {
    rows.vehicles = []; rows.vehicle_fuel = [];
    await GET(new NextRequest("https://its.test/api/ops/fuel-entries?reimbursement=pending"));
    const listCalls = calls.filter((call) => call.table === "vehicle_fuel");
    expect(listCalls).toContainEqual({ table: "vehicle_fuel", method: "eq", args: ["invoice_supplier", "CONTANTI"] });
    expect(listCalls).toContainEqual({ table: "vehicle_fuel", method: "neq", args: ["approval_status", "rejected"] });
  });

  it("vista contanti da rimborsare: ignora stato e periodo (altrimenti un contante approvato sparisce)", async () => {
    rows.vehicles = []; rows.vehicle_fuel = [];
    await GET(new NextRequest("https://its.test/api/ops/fuel-entries?reimbursement=pending&status=pending&date_from=2026-11-01&date_to=2026-11-30"));
    const first = calls.findIndex((call) => call.table === "vehicle_fuel" && call.method === "select");
    const next = calls.findIndex((call, index) => index > first && call.table === "vehicle_fuel" && call.method === "select");
    const listCalls = calls.slice(first, next);
    expect(listCalls).toContainEqual({ table: "vehicle_fuel", method: "eq", args: ["invoice_supplier", "CONTANTI"] });
    expect(listCalls).not.toContainEqual({ table: "vehicle_fuel", method: "eq", args: ["approval_status", "pending"] });
    expect(listCalls.some((call) => call.method === "gte" || call.method === "lte")).toBe(false);
  });
});
