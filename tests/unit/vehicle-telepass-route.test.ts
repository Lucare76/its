import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { isTelepassInvoicePathOf, telepassInvoicePath } from "@/lib/server/telepass-invoice";

const mocks = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorize }));
import { GET, POST } from "@/app/api/ops/vehicle-telepass/route";

const TENANT = "00000000-0000-4000-8000-00000000000a";
const VEHICLE = "11111111-1111-4111-8111-111111111111";
const INVOICE = "22222222-2222-4222-8222-222222222222";
const CARD = "33333333-3333-4333-8333-333333333333";

type Call = { table: string; method: string; args: unknown[] };
let calls: Call[];
let rows: Record<string, unknown>;
let errors: Record<string, unknown>;
let rpcCalls: unknown[][];
let listed: { name: string }[];
let removed: string[][];

beforeEach(() => {
  calls = []; rpcCalls = []; removed = []; errors = {}; listed = [];
  rows = {
    vehicles: { id: VEHICLE, decommissioned_at: null },
    vehicle_telepass_invoices: { id: INVOICE, vehicle_id: VEHICLE, document_path: null },
    fuel_cards: { id: CARD },
  };
  const admin = {
    from(table: string) {
      const query: Record<string, unknown> = {};
      for (const method of ["select", "eq", "is", "neq", "lte", "order", "limit", "insert", "update", "delete"]) {
        query[method] = (...args: unknown[]) => { calls.push({ table, method, args }); return query; };
      }
      const result = () => ({ data: rows[table] ?? null, error: errors[table] ?? null });
      query.maybeSingle = () => Promise.resolve(result());
      query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve);
      return query;
    },
    rpc: (...args: unknown[]) => { rpcCalls.push(args); return Promise.resolve({ error: null }); },
    storage: {
      from: () => ({
        createSignedUploadUrl: (path: string) => Promise.resolve({ data: { path, token: "tok" }, error: null }),
        list: () => Promise.resolve({ data: listed, error: null }),
        remove: (paths: string[]) => { removed.push(paths); return Promise.resolve({ error: null }); },
        createSignedUrl: () => Promise.resolve({ data: { signedUrl: "https://signed" }, error: null }),
      }),
    },
  };
  mocks.authorize.mockResolvedValue({ admin, user: { id: "user-1" }, membership: { tenant_id: TENANT, role: "operator" } });
});

const post = (action: string, data: unknown) =>
  POST(new NextRequest("https://its.test/api/ops/vehicle-telepass", { method: "POST", body: JSON.stringify({ action, data }) }));
const written = (table: string, method: "insert" | "update") =>
  calls.find((call) => call.table === table && call.method === method)?.args[0] as Record<string, unknown> | undefined;
const tenantFiltered = (table: string) =>
  calls.some((call) => call.table === table && call.method === "eq" && call.args[0] === "tenant_id" && call.args[1] === TENANT);

describe("percorsi fatture Telepass", () => {
  it("costruisce il percorso nella cartella del tenant e della fattura", () => {
    const path = telepassInvoicePath(TENANT, INVOICE, "fattura ottobre.pdf", 1);
    expect(path).toBe(`${TENANT}/telepass/${INVOICE}/1_fattura_ottobre.pdf`);
    expect(isTelepassInvoicePathOf(path, TENANT, INVOICE)).toBe(true);
  });
  it("rifiuta percorsi di altri tenant, altre fatture o sottocartelle", () => {
    expect(isTelepassInvoicePathOf(`other/telepass/${INVOICE}/x.pdf`, TENANT, INVOICE)).toBe(false);
    expect(isTelepassInvoicePathOf(`${TENANT}/telepass/${VEHICLE}/x.pdf`, TENANT, INVOICE)).toBe(false);
    expect(isTelepassInvoicePathOf(`${TENANT}/telepass/${INVOICE}/a/x.pdf`, TENANT, INVOICE)).toBe(false);
    expect(isTelepassInvoicePathOf(`${TENANT}/telepass/${INVOICE}/`, TENANT, INVOICE)).toBe(false);
  });
});

describe("vehicle-telepass API", () => {
  it("GET filtra per tenant e risponde 404 per un mezzo di altri", async () => {
    rows.vehicles = null;
    const res = await GET(new NextRequest(`https://its.test/api/ops/vehicle-telepass?vehicle_id=${VEHICLE}`));
    expect(res.status).toBe(404);
    expect(tenantFiltered("vehicles")).toBe(true);
  });

  it("aggiunge un Telepass al mezzo del tenant", async () => {
    const res = await post("device_add", { vehicle_id: VEHICLE, device_code: "1234 5678", assigned_on: "2026-11-01" });
    expect(res.status).toBe(200);
    expect(written("vehicle_telepass_devices", "insert")).toMatchObject({ tenant_id: TENANT, vehicle_id: VEHICLE, device_code: "1234 5678" });
  });

  it("Telepass già attivo altrove: messaggio chiaro", async () => {
    errors.vehicle_telepass_devices = { code: "23505", message: "duplicate" };
    const res = await post("device_add", { vehicle_id: VEHICLE, device_code: "12345678", assigned_on: "2026-11-01" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/già attivo su questo mezzo/);
  });

  it("terza targa sullo stesso apparato: messaggio chiaro", async () => {
    errors.vehicle_telepass_devices = { code: "P0001", message: "telepass_max_two_plates" };
    const res = await post("device_add", { vehicle_id: VEHICLE, device_code: "12345678", assigned_on: "2026-11-01" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/due targhe/);
  });

  it("niente nuovi Telepass su un mezzo dismesso", async () => {
    rows.vehicles = { id: VEHICLE, decommissioned_at: "2026-10-01" };
    const res = await post("device_add", { vehicle_id: VEHICLE, device_code: "12345678", assigned_on: "2026-11-01" });
    expect(res.status).toBe(409);
  });

  it("crea la fattura e rifiuta un periodo rovesciato", async () => {
    const bad = await post("invoice_create", { vehicle_id: VEHICLE, invoice_number: "F1", invoice_date: "2026-11-01", period_from: "2026-10-31", period_to: "2026-10-01" });
    expect(bad.status).toBe(400);
    rows.vehicle_telepass_invoices = { id: INVOICE };
    const ok = await post("invoice_create", { vehicle_id: VEHICLE, invoice_number: "F1", invoice_date: "2026-11-01", amount: 42.5 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: INVOICE });
    expect(written("vehicle_telepass_invoices", "insert")).toMatchObject({ tenant_id: TENANT, invoice_number: "F1", amount: 42.5 });
  });

  it("link di caricamento solo per PDF/foto e nella cartella della fattura", async () => {
    const exe = await post("invoice_upload_url", { id: INVOICE, file_name: "x.exe", content_type: "application/x-msdownload", size: 10 });
    expect(exe.status).toBe(400);
    const pdf = await post("invoice_upload_url", { id: INVOICE, file_name: "f.pdf", content_type: "application/pdf", size: 10 });
    expect(pdf.status).toBe(200);
    expect((await pdf.json()).path).toMatch(new RegExp(`^${TENANT}/telepass/${INVOICE}/\\d+_f\\.pdf$`));
  });

  it("allega solo un file davvero caricato nella propria cartella", async () => {
    const foreign = await post("invoice_attach", { id: INVOICE, path: `x/telepass/${INVOICE}/1_f.pdf`, file_name: "f.pdf" });
    expect(foreign.status).toBe(400);
    const missing = await post("invoice_attach", { id: INVOICE, path: `${TENANT}/telepass/${INVOICE}/1_f.pdf`, file_name: "f.pdf" });
    expect(missing.status).toBe(409);
    listed = [{ name: "1_f.pdf" }];
    const ok = await post("invoice_attach", { id: INVOICE, path: `${TENANT}/telepass/${INVOICE}/1_f.pdf`, file_name: "f.pdf" });
    expect(ok.status).toBe(200);
    expect(written("vehicle_telepass_invoices", "update")).toMatchObject({ document_path: `${TENANT}/telepass/${INVOICE}/1_f.pdf` });
  });

  it("eliminando la fattura cancella anche il file", async () => {
    rows.vehicle_telepass_invoices = { id: INVOICE, vehicle_id: VEHICLE, document_path: `${TENANT}/telepass/${INVOICE}/1_f.pdf` };
    const res = await post("invoice_delete", { id: INVOICE });
    expect(res.status).toBe(200);
    expect(removed).toEqual([[`${TENANT}/telepass/${INVOICE}/1_f.pdf`]]);
  });

  it("crea una carta e la abbina al mezzo; non accetta il numero completo", async () => {
    const full = await post("card_create", { vehicle_id: VEHICLE, label: "UTA Sprinter", supplier: "UTA", last_four: "1234567812345678" });
    expect(full.status).toBe(400);
    const res = await post("card_create", { vehicle_id: VEHICLE, label: "UTA Sprinter", supplier: "UTA", last_four: "4417" });
    expect(res.status).toBe(200);
    expect(written("fuel_cards", "insert")).toMatchObject({ tenant_id: TENANT, last_four: "4417", supplier: "UTA" });
    expect(rpcCalls[0]).toEqual(["assign_fuel_card_vehicle", { p_tenant_id: TENANT, p_card_id: CARD, p_vehicle_id: VEHICLE, p_actor_id: "user-1" }]);
  });

  it("togliere una carta dal mezzo passa vehicle_id null", async () => {
    const res = await post("card_assign", { card_id: CARD, vehicle_id: null });
    expect(res.status).toBe(200);
    expect(rpcCalls[0]?.[1]).toMatchObject({ p_vehicle_id: null });
  });
});
