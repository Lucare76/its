import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { maintenanceInvoicePath, isAllowedInvoiceType } from "@/lib/server/maintenance-invoice";

const mocks = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorize }));
import { GET, POST } from "@/app/api/ops/maintenance-register/route";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";
const ID = "22222222-2222-4222-8222-222222222222";
const VEHICLE = "33333333-3333-4333-8333-333333333333";
const FOLDER = `${TENANT}/maintenance/${ID}`;

type Call = { table: string; method: string; args: unknown[] };
let calls: Call[];
let storageCalls: Array<{ method: string; args: unknown[] }>;
let state: {
  record: Record<string, unknown> | null;
  vehicle: Record<string, unknown> | null;
  listed: Array<{ name: string }>;
  records: unknown[];
};

function admin() {
  return {
    from(table: string) {
      const ops: string[] = [];
      const query: Record<string, unknown> = {};
      for (const method of ["select", "eq", "gte", "lte", "order", "limit", "insert", "update", "delete"]) {
        query[method] = (...args: unknown[]) => { calls.push({ table, method, args }); ops.push(method); return query; };
      }
      const result = () => {
        if (table === "vehicles") return { data: ops.includes("limit") || !ops.includes("eq") ? [] : state.vehicle, error: null };
        if (ops.includes("insert")) return { data: { id: ID }, error: null };
        if (ops.includes("limit") && ops.filter((m) => m === "order").length === 2) return { data: state.records, error: null };
        if (ops.includes("limit")) return { data: { maintenance_date: "2024-03-10" }, error: null };
        return { data: state.record, error: null };
      };
      query.maybeSingle = () => Promise.resolve(result());
      query.single = () => Promise.resolve(result());
      query.then = (ok: (value: unknown) => unknown) => Promise.resolve(
        table === "vehicles" ? { data: [{ id: VEHICLE, label: "Vito", plate: "FE861YD" }], error: null } : result(),
      ).then(ok);
      return query;
    },
    storage: {
      from: () => ({
        createSignedUploadUrl: (path: string) => { storageCalls.push({ method: "createSignedUploadUrl", args: [path] }); return Promise.resolve({ data: { path, token: "tok" }, error: null }); },
        list: (folder: string) => { storageCalls.push({ method: "list", args: [folder] }); return Promise.resolve({ data: state.listed, error: null }); },
        remove: (paths: string[]) => { storageCalls.push({ method: "remove", args: [paths] }); return Promise.resolve({ data: [], error: null }); },
        createSignedUrl: (path: string, seconds: number) => { storageCalls.push({ method: "createSignedUrl", args: [path, seconds] }); return Promise.resolve({ data: { signedUrl: `https://signed/${path}` }, error: null }); },
      }),
    },
  };
}

beforeEach(() => {
  calls = []; storageCalls = [];
  state = { record: { id: ID, invoice_document_path: null }, vehicle: { id: VEHICLE }, listed: [], records: [] };
  mocks.authorize.mockResolvedValue({ admin: admin(), user: { id: "user-1" }, membership: { tenant_id: TENANT, role: "operator" } });
});

const post = (body: unknown) => POST(new NextRequest("https://its.test/api/ops/maintenance-register", { method: "POST", body: JSON.stringify(body) }));
const updates = () => calls.filter((call) => call.table === "vehicle_maintenance" && call.method === "update").map((call) => call.args[0]);

describe("helper fattura manutenzione", () => {
  it("percorso nella cartella del tenant e dell'intervento, nome ripulito", () => {
    expect(maintenanceInvoicePath(TENANT, ID, "../../altro/Fattura Officina n.12 è.pdf", 1700000000000))
      .toBe(`${FOLDER}/1700000000000_._._altro_Fattura_Officina_n.12_e_.pdf`);
    expect(maintenanceInvoicePath(TENANT, ID, "a/b.pdf", 1).startsWith(`${FOLDER}/1_`)).toBe(true);
    expect(maintenanceInvoicePath(TENANT, ID, "a/b.pdf", 1).slice(FOLDER.length + 1)).not.toContain("/");
  });
  it("formati ammessi", () => {
    expect(["application/pdf", "image/jpeg", "IMAGE/PNG", "image/webp"].every(isAllowedInvoiceType)).toBe(true);
    expect(["image/heic", "text/html", "application/zip", ""].some(isAllowedInvoiceType)).toBe(false);
  });
});

describe("filtri targa e anno", () => {
  it("applica anno come intervallo di date e la targa (mezzo)", async () => {
    const res = await GET(new NextRequest(`https://its.test/api/ops/maintenance-register?year=2025&vehicle_id=${VEHICLE}`));
    expect(res.status).toBe(200);
    const list = calls.filter((call) => call.table === "vehicle_maintenance");
    expect(list).toContainEqual({ table: "vehicle_maintenance", method: "gte", args: ["maintenance_date", "2025-01-01"] });
    expect(list).toContainEqual({ table: "vehicle_maintenance", method: "lte", args: ["maintenance_date", "2025-12-31"] });
    expect(list).toContainEqual({ table: "vehicle_maintenance", method: "eq", args: ["vehicle_id", VEHICLE] });
    const body = await res.json();
    const thisYear = new Date().getFullYear();
    expect(body.years[0]).toBe(thisYear);
    expect(body.years.at(-1)).toBe(2024);
  });
  it.each(["?year=1999", "?year=abc", "?vehicle_id=non-uuid"])("rifiuta %s", async (query) => {
    expect((await GET(new NextRequest(`https://its.test/api/ops/maintenance-register${query}`))).status).toBe(400);
  });
  it("segnala l'elenco troncato oltre 250", async () => {
    state.records = Array.from({ length: 251 }, (_, i) => ({ id: `m${i}`, vehicle_id: VEHICLE }));
    const body = await (await GET(new NextRequest("https://its.test/api/ops/maintenance-register"))).json();
    expect(body.truncated).toBe(true);
    expect(body.records).toHaveLength(250);
  });
});

describe("allegato fattura", () => {
  it("firma il caricamento solo nella cartella dell'intervento del proprio tenant", async () => {
    const res = await post({ action: "invoice_upload_url", data: { id: ID, file_name: "f.pdf", content_type: "application/pdf", size: 1000 } });
    expect(res.status).toBe(200);
    const path = String(storageCalls.find((call) => call.method === "createSignedUploadUrl")?.args[0]);
    expect(path.startsWith(`${FOLDER}/`)).toBe(true);
  });

  it.each([
    ["formato non ammesso", { content_type: "image/heic" }],
    ["file oltre 10 MB", { size: 10 * 1024 * 1024 + 1 }],
  ])("rifiuta %s", async (_label, change) => {
    const res = await post({ action: "invoice_upload_url", data: { id: ID, file_name: "f.pdf", content_type: "application/pdf", size: 1000, ...change } });
    expect(res.status).toBe(400);
    expect(storageCalls).toEqual([]);
  });

  it("intervento di un altro tenant (non trovato): 404, nessuna firma", async () => {
    state.record = null;
    const res = await post({ action: "invoice_upload_url", data: { id: ID, file_name: "f.pdf", content_type: "application/pdf", size: 1000 } });
    expect(res.status).toBe(404);
    expect(storageCalls).toEqual([]);
  });

  it.each([
    ["di un altro tenant", `${OTHER_TENANT}/maintenance/${ID}/1_f.pdf`],
    ["di un altro intervento", `${TENANT}/maintenance/44444444-4444-4444-8444-444444444444/1_f.pdf`],
    ["in una sottocartella", `${FOLDER}/x/1_f.pdf`],
    ["con risalita", `${FOLDER}/../../${OTHER_TENANT}/doc.pdf`],
  ])("non collega un percorso %s", async (_label, path) => {
    const res = await post({ action: "invoice_attach", data: { id: ID, path, file_name: "f.pdf" } });
    expect(res.status).toBe(400);
    expect(updates()).toEqual([]);
  });

  it("non collega un file che non risulta caricato", async () => {
    state.listed = [{ name: "altro.pdf" }];
    const res = await post({ action: "invoice_attach", data: { id: ID, path: `${FOLDER}/1_f.pdf`, file_name: "f.pdf" } });
    expect(res.status).toBe(409);
    expect(updates()).toEqual([]);
  });

  it("collega il file caricato e, se sostituisce, elimina il precedente", async () => {
    state.record = { id: ID, invoice_document_path: `${FOLDER}/0_vecchia.pdf` };
    state.listed = [{ name: "1_f.pdf" }];
    const res = await post({ action: "invoice_attach", data: { id: ID, path: `${FOLDER}/1_f.pdf`, file_name: "Fattura officina.pdf" } });
    expect(res.status).toBe(200);
    expect(updates()[0]).toMatchObject({ invoice_document_path: `${FOLDER}/1_f.pdf`, invoice_document_name: "Fattura officina.pdf", invoice_uploaded_by: "user-1" });
    expect(storageCalls).toContainEqual({ method: "remove", args: [[`${FOLDER}/0_vecchia.pdf`]] });
  });

  it("apre con un link firmato di 5 minuti; senza fattura 404", async () => {
    state.record = { id: ID, invoice_document_path: `${FOLDER}/1_f.pdf` };
    const body = await (await post({ action: "invoice_open", id: ID })).json();
    expect(body.url).toBe(`https://signed/${FOLDER}/1_f.pdf`);
    expect(storageCalls).toContainEqual({ method: "createSignedUrl", args: [`${FOLDER}/1_f.pdf`, 300] });
    state.record = { id: ID, invoice_document_path: null };
    expect((await post({ action: "invoice_open", id: ID })).status).toBe(404);
  });

  it("rimuove fattura: azzera i campi ed elimina il file", async () => {
    state.record = { id: ID, invoice_document_path: `${FOLDER}/1_f.pdf` };
    expect((await post({ action: "invoice_remove", id: ID })).status).toBe(200);
    expect(updates()[0]).toEqual({ invoice_document_path: null, invoice_document_name: null, invoice_uploaded_at: null, invoice_uploaded_by: null });
    expect(storageCalls).toContainEqual({ method: "remove", args: [[`${FOLDER}/1_f.pdf`]] });
  });

  it("eliminando l'intervento elimina anche la sua fattura", async () => {
    state.record = { id: ID, invoice_document_path: `${FOLDER}/1_f.pdf` };
    expect((await post({ action: "delete", id: ID })).status).toBe(200);
    expect(storageCalls).toContainEqual({ method: "remove", args: [[`${FOLDER}/1_f.pdf`]] });
  });
});

describe("creazione", () => {
  const data = { vehicle_id: VEHICLE, maintenance_date: "2025-06-01", description: "Tagliando" };
  it("restituisce l'id per allegare subito la fattura", async () => {
    const body = await (await post({ action: "create", data })).json();
    expect(body).toEqual({ ok: true, id: ID });
  });
  it("rifiuta un mezzo che non è del proprio tenant", async () => {
    state.vehicle = null;
    const res = await post({ action: "create", data });
    expect(res.status).toBe(404);
    expect(calls.some((call) => call.method === "insert")).toBe(false);
  });
  it("dati non validi: 400 invece di 500", async () => {
    expect((await post({ action: "create", data: { ...data, maintenance_date: "01/06/2025" } })).status).toBe(400);
  });
});
