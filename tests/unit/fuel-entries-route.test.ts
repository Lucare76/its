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
      for (const method of ["select", "eq", "is", "order", "limit", "insert", "update", "delete", "gte", "lte"]) {
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
