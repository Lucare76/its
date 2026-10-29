import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), sendEmail: vi.fn(), generateToken: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/server/send-email", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("@/lib/server/agency-action-token", () => ({ generateAgencyActionToken: mocks.generateToken }));
vi.mock("@/lib/server/invoice-pdf", () => ({
  generateInvoiceHtml: () => "<p>Estratto test</p>", buildInvoiceXlsx: () => Buffer.from("xlsx-test"),
}));
vi.mock("@/lib/server/service-list-email", () => ({
  buildServiceListEmailHtml: (data: { targetDate: string }) => `<p>${data.targetDate}</p>`,
}));

import { GET as invoiceGet } from "@/app/api/cron/agency-invoices/route";
import { GET as reminderGet, POST as reminderPost } from "@/app/api/cron/agency-reminders/route";

type Row = Record<string, unknown>;
const TENANT = "tenant-a";
const AGENCY = "agency-a";
function setup(options: { existing?: Row[]; errorTable?: string; insertFails?: boolean; race?: boolean; enabled?: boolean } = {}) {
  const invoices: Row[] = [...(options.existing ?? [])];
  const serviceDates: string[] = [];
  const writes: Row[] = [];
  const agency: Row = {
    id: AGENCY, tenant_id: TENANT, name: "AGENZIA TEST", active: true,
    invoice_email: "luca_renna@hotmail.com", invoice_enabled: options.enabled ?? true,
    invoice_cadence: "monthly", invoice_send_day: 1,
  };
  let barrierCount = 0;
  let release: (() => void) | undefined;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  mocks.createClient.mockReturnValue({
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = [];
      let insert: Row | undefined;
      let patch: Row | undefined;
      const rows = () => table === "tenants" ? [{ id: TENANT }]
        : table === "agencies" ? [agency]
          : table === "agency_invoices" ? invoices
            : table === "hotels" ? [{ id: "hotel-a", name: "Hotel test", tenant_id: TENANT }]
              : [{ id: "service-a", tenant_id: TENANT, is_draft: false, agency_quoted_price_cents: 6600, date: serviceDates.at(-1), customer_name: "CLIENTE TEST", direction: "arrival", hotel_id: "hotel-a", pax: 1 }];
      const matching = () => rows().filter(row => filters.every(filter => filter(row)));
      const error = () => options.errorTable === table ? { message: "Read failed" } : null;
      const query = {
        select: () => query, order: () => query, limit: () => query,
        eq: (key: string, value: unknown) => {
          if (table === "services" && key === "date") serviceDates.push(String(value));
          filters.push(row => row[key] === value); return query;
        },
        ilike: () => query,
        gte: (_key: string, value: string) => { serviceDates.push(value); return query; },
        lte: () => query,
        insert: (row: Row) => { insert = row; return query; },
        update: (row: Row) => { patch = row; return query; },
        maybeSingle: async () => {
          const data = matching()[0] ?? null;
          // Le due letture concorrenti vedono entrambe nessuna riga: la PK,
          // non il controllo preliminare, deve impedire il doppio invio.
          if (options.race && table === "agency_invoices") {
            if (++barrierCount === 2) release?.();
            await barrier;
          }
          return { data, error: error() };
        },
        single: async () => {
          if (options.insertFails) return { data: null, error: { message: "Insert failed", code: "XX000" } };
          if (insert && invoices.some(row => row.id === insert!.id)) return { data: null, error: { code: "23505", message: "Duplicate primary key" } };
          if (insert) { invoices.push(insert); writes.push(insert); }
          return { data: insert ? { id: insert.id } : null, error: null };
        },
        then: (resolve: (value: unknown) => unknown) => {
          if (patch) for (const row of matching()) Object.assign(row, patch);
          return Promise.resolve({ data: error() ? null : matching(), error: error() }).then(resolve);
        },
      };
      return query;
    },
  });
  return { invoices, serviceDates, writes, agency };
}

function request(method = "GET", secret = "test-secret") {
  return new NextRequest("https://ischia-transfer.vercel.app/api/cron/test", { method, headers: { authorization: `Bearer ${secret}` } });
}

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-02-01T08:00:00Z"));
  vi.stubEnv("CRON_SECRET", "test-secret");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key");
  mocks.sendEmail.mockResolvedValue({ ok: true });
  mocks.generateToken.mockReturnValue("cancel-test-token");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("Estratti automatici: calendario e doppie esecuzioni", () => {
  it("copre tutti i 31 giorni di gennaio", async () => {
    const fake = setup();
    const response = await invoiceGet(request());
    expect(response.status).toBe(200);
    expect(fake.invoices[0]).toMatchObject({ period_from: "2026-01-01", period_to: "2026-01-31", status: "sent" });
  });
  it("due esecuzioni successive generano un solo documento e una sola email", async () => {
    const fake = setup();
    await invoiceGet(request());
    const second = await invoiceGet(request());
    expect(await second.json()).toMatchObject({ sent: 0, skipped: 1, failed: 0 });
    expect(fake.invoices).toHaveLength(1);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });
  it("due esecuzioni concorrenti non superano la protezione sulla PK", async () => {
    const fake = setup({ race: true });
    const responses = await Promise.all([invoiceGet(request()), invoiceGet(request())]);
    const bodies = await Promise.all(responses.map(response => response.json()));
    expect(bodies.reduce((sum, body) => sum + body.sent, 0)).toBe(1);
    expect(bodies.reduce((sum, body) => sum + body.skipped, 0)).toBe(1);
    expect(fake.invoices).toHaveLength(1);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });
  it.each(["draft", "sent", "paid"])("un estratto preesistente %s non viene duplicato o reinviato", async status => {
    setup({ existing: [{ id: "manual-id", tenant_id: TENANT, agency_id: AGENCY, period_from: "2026-01-01", period_to: "2026-01-31", status }] });
    expect(await (await invoiceGet(request())).json()).toMatchObject({ sent: 0, skipped: 1 });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
  it("un documento di un altro tenant non blocca l'invio", async () => {
    const fake = setup({ existing: [{ id: "other-id", tenant_id: "other", agency_id: AGENCY, period_from: "2026-01-01", period_to: "2026-01-31" }] });
    expect(await (await invoiceGet(request())).json()).toMatchObject({ sent: 1 });
    expect(fake.invoices).toHaveLength(2);
  });
  it("un invio fallito rimane bozza e non viene ritentato automaticamente creando un doppione", async () => {
    const fake = setup();
    mocks.sendEmail.mockResolvedValue({ ok: false, error: "Network uncertain" });
    expect((await invoiceGet(request())).status).toBe(500);
    expect(fake.invoices[0].status).toBe("draft");
    expect(await (await invoiceGet(request())).json()).toMatchObject({ skipped: 1, sent: 0 });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });
  it.each(["tenants", "agencies", "services", "agency_invoices"])("un errore di lettura %s non produce un falso successo o un invio", async errorTable => {
    setup({ errorTable });
    expect((await invoiceGet(request())).status).toBe(500);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});

describe("Riepiloghi automatici", () => {
  it.each([reminderGet, reminderPost])("GET e POST richiedono il secret", async handler => {
    expect((await handler(request(handler === reminderPost ? "POST" : "GET", "wrong"))).status).toBe(401);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it("il sabato invia il riepilogo del lunedì e l'extra 24 ore della domenica", async () => {
    vi.setSystemTime(new Date("2026-10-31T08:00:00Z"));
    const fake = setup();
    const response = await reminderGet(request());
    expect(await response.json()).toMatchObject({ ok: true, sent: 2, sunday_extra: true, date24h: "2026-11-01", date48h: "2026-11-02" });
    expect(fake.serviceDates).toEqual(["2026-11-02", "2026-11-01"]);
  });
  it("il venerdì non invia per errore l'extra domenicale ai servizi del sabato", async () => {
    vi.setSystemTime(new Date("2026-10-30T08:00:00Z"));
    const fake = setup();
    expect(await (await reminderGet(request())).json()).toMatchObject({ sent: 1, sunday_extra: false });
    expect(fake.serviceDates).toEqual(["2026-11-01"]);
  });
  it.each([{ ok: false, error: "Provider rejected" }, { ok: true, skipped: true }])("invio rifiutato o saltato non viene contato come spedito", async result => {
    setup(); mocks.sendEmail.mockResolvedValue(result);
    const response = await reminderGet(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false, sent: 0, errors: 1 });
  });
  it("rispetta l'invio automatico disabilitato", async () => {
    setup({ enabled: false });
    expect(await (await reminderGet(request())).json()).toMatchObject({ sent: 0, errors: 0 });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
  it.each(["tenants", "agencies", "hotels", "services"])("un errore di lettura %s viene segnalato senza inviare", async errorTable => {
    setup({ errorTable });
    expect((await reminderGet(request())).status).toBe(500);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});
