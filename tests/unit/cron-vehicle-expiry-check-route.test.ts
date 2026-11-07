import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Vercel Cron invoca gli endpoint via GET: /api/cron/vehicle-expiry-check
 * deve esporre GET (senza body) oltre a POST (test manuali con today/dry_run),
 * entrambi protetti da Authorization: Bearer <CRON_SECRET>.
 */

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  tables: {} as Record<string, unknown[]>,
}));

vi.mock("@/lib/server/send-email", () => ({
  sendEmail: mocks.sendEmail,
}));
vi.mock("@/lib/server/logo", () => ({
  getLogoDataUri: () => null,
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const result = { data: mocks.tables[table] ?? [], error: null };
      const chain = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
      };
      return chain;
    },
  }),
}));

import { GET, POST } from "@/app/api/cron/vehicle-expiry-check/route";
import { diffDays, getEffectiveExpiry } from "@/lib/vehicle-compliance";

const ROUTE_URL = "http://localhost:3010/api/cron/vehicle-expiry-check";
const AUTH = { authorization: "Bearer test-cron-secret" };
const TODAY = "2026-10-12";
const INSURANCE_EXPIRY = "2026-10-01";
// Le regole di proroga restano in lib/vehicle-compliance: il test non le duplica.
const EFFECTIVE_EXPIRY = getEffectiveExpiry("Assicurazione", INSURANCE_EXPIRY);

function callGet(headers: Record<string, string> = AUTH) {
  return GET(new NextRequest(ROUTE_URL, { method: "GET", headers }));
}

function callPost(body: Record<string, unknown> | null, headers: Record<string, string> = AUTH) {
  return POST(
    new NextRequest(ROUTE_URL, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: body === null ? undefined : JSON.stringify(body),
    })
  );
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T08:00:00Z`));
  process.env.CRON_SECRET = "test-cron-secret";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  mocks.sendEmail.mockResolvedValue({ ok: true });
  mocks.tables = {
    vehicles: [
      {
        id: "veh-1",
        tenant_id: "tenant-1",
        label: "Bus 1",
        plate: "AB123CD",
        habitual_driver_profile_id: null,
        insurance_expiry: null,
        road_tax_expiry: "2027-06-30",
        inspection_expiry: null,
      },
    ],
    // Polizza in scadenza a ridosso di oggi: rientra nella finestra di alert assicurazione
    vehicle_insurances: [{ vehicle_id: "veh-1", expiry_date: INSURANCE_EXPIRY }],
    vehicle_inspections: [],
    vehicle_extinguishers: [],
    driver_profiles: [],
    vehicle_compliance_grace_periods: [],
  };
});

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
});

describe("GET /api/cron/vehicle-expiry-check", () => {
  it("senza Authorization: 401, nessuna email", async () => {
    const res = await callGet({});
    expect(res.status).toBe(401);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("con secret errato: 401", async () => {
    const res = await callGet({ authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("senza CRON_SECRET configurato: 401", async () => {
    delete process.env.CRON_SECRET;
    const res = await callGet({ authorization: "Bearer undefined" });
    expect(res.status).toBe(401);
  });

  it("con CRON_SECRET valido e senza body: esegue il controllo e invia l'email", async () => {
    const res = await callGet();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, sent: true, dry_run: false, today: TODAY, warnings: 1 });
    expect(json.preview[0]).toMatchObject({
      docType: "Assicurazione",
      expiryDate: INSURANCE_EXPIRY,
      effectiveExpiryDate: EFFECTIVE_EXPIRY,
      daysLeft: diffDays(TODAY, EFFECTIVE_EXPIRY),
    });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/cron/vehicle-expiry-check", () => {
  it("senza Authorization: 401", async () => {
    const res = await callPost({ dry_run: true }, {});
    expect(res.status).toBe(401);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("continua a funzionare e rispetta today dal body", async () => {
    const res = await callPost({ today: "2026-10-14" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, sent: true, today: "2026-10-14", warnings: 1 });
    expect(json.preview[0].daysLeft).toBe(diffDays("2026-10-14", EFFECTIVE_EXPIRY));
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("dry_run: true non invia email", async () => {
    const res = await callPost({ dry_run: true });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, sent: false, dry_run: true, warnings: 1, delivery: null });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("senza body: usa la data corrente come GET", async () => {
    const res = await callPost(null);
    expect(res.status).toBe(200);
    expect((await res.json()).today).toBe(TODAY);
  });
});

describe("GET e POST equivalenti", () => {
  it("producono lo stesso risultato a parità di data e dati", async () => {
    const getJson = await (await callGet()).json();
    const postJson = await (await callPost({ today: TODAY })).json();
    expect(getJson).toEqual(postJson);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
    expect(mocks.sendEmail.mock.calls[0]).toEqual(mocks.sendEmail.mock.calls[1]);
  });
});
