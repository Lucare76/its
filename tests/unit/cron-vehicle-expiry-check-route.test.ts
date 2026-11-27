import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * /api/cron/vehicle-expiry-check: una email per scadenza (preavviso + giorno),
 * mai ripetuta. GET per Vercel Cron, POST per test manuali (today/dry_run).
 */

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  tables: {} as Record<string, unknown[]>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
}));

vi.mock("@/lib/server/send-email", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const result = { data: mocks.tables[table] ?? [], error: null };
      const chain: Record<string, unknown> = {
        select: () => chain, eq: () => chain, not: () => chain, gte: () => chain,
        insert: (row: Record<string, unknown>) => { mocks.inserts.push({ table, row }); return Promise.resolve({ error: null }); },
        then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
      };
      return chain;
    },
  }),
}));

import { GET, POST } from "@/app/api/cron/vehicle-expiry-check/route";
import { planAlerts, alertKey, type AlertCandidate } from "@/lib/server/vehicle-expiry-alerts";

const ROUTE_URL = "http://localhost:3010/api/cron/vehicle-expiry-check";
const AUTH = { authorization: "Bearer test-cron-secret" };
const TODAY = "2026-10-12";
const callGet = (headers: Record<string, string> = AUTH) => GET(new NextRequest(ROUTE_URL, { method: "GET", headers }));
const callPost = (body: Record<string, unknown>) =>
  POST(new NextRequest(ROUTE_URL, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify(body) }));

const ORIGINAL_ENV = { ...process.env };
const vehicle = (extra: Record<string, unknown> = {}) => ({
  id: "veh-1", tenant_id: "tenant-1", label: "Bus 1", plate: "AB123CD", habitual_driver_profile_id: null,
  insurance_expiry: null, road_tax_expiry: null, inspection_expiry: null, tachograph_enabled: false, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T08:00:00Z`));
  process.env.CRON_SECRET = "test-cron-secret";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  mocks.sendEmail.mockResolvedValue({ ok: true });
  mocks.inserts = [];
  mocks.tables = {
    vehicles: [vehicle()],
    vehicle_insurances: [{ vehicle_id: "veh-1", expiry_date: "2026-10-19" }], // tra 7 giorni
    vehicle_inspections: [], vehicle_extinguishers: [], vehicle_tachographs: [], driver_profiles: [],
    vehicle_compliance_alerts_sent: [],
  };
});

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
});

describe("planAlerts", () => {
  const base: Omit<AlertCandidate, "docType" | "dueDate"> = { tenantId: "t", vehicleId: "v", subjectKey: "v", vehicleLabel: "Bus", plate: null };
  const plan = (docType: AlertCandidate["docType"], dueDate: string, sent = new Set<string>()) => planAlerts([{ ...base, docType, dueDate }], TODAY, sent);

  it("assicurazione: preavviso a 7 giorni, non a 8", () => {
    expect(plan("insurance", "2026-10-19")).toMatchObject([{ stage: "advance", daysLeft: 7 }]);
    expect(plan("insurance", "2026-10-20")).toEqual([]);
  });

  it("collaudo: preavviso a 15 giorni, non a 16", () => {
    expect(plan("inspection", "2026-10-27")).toMatchObject([{ stage: "advance", daysLeft: 15 }]);
    expect(plan("inspection", "2026-10-28")).toEqual([]);
  });

  it("il giorno della scadenza parte l'avviso 'due'", () => {
    expect(plan("insurance", TODAY)).toMatchObject([{ stage: "due", daysLeft: 0 }]);
  });

  it("un avviso già inviato non riparte", () => {
    const sent = new Set([alertKey({ tenantId: "t", subjectKey: "v", docType: "insurance", dueDate: "2026-10-15" }, "advance")]);
    expect(plan("insurance", "2026-10-15", sent)).toEqual([]);
  });

  it("scadenze più vecchie di 30 giorni non generano avvisi", () => {
    expect(plan("road_tax", "2026-09-11")).toEqual([]);
    expect(plan("road_tax", "2026-09-12")).toMatchObject([{ stage: "due" }]);
  });
});

describe("GET /api/cron/vehicle-expiry-check", () => {
  it("senza Authorization o con secret errato: 401", async () => {
    expect((await callGet({})).status).toBe(401);
    expect((await callGet({ authorization: "Bearer wrong" })).status).toBe(401);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("senza CRON_SECRET configurato: 401", async () => {
    delete process.env.CRON_SECRET;
    expect((await callGet({ authorization: "Bearer undefined" })).status).toBe(401);
  });

  it("invia UNA email per la scadenza e la registra", async () => {
    const res = await callGet();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sent: 1, alerts: 1 });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail.mock.calls[0][0].subject).toBe("Assicurazione in scadenza tra 7 giorni — Bus 1 (AB123CD)");
    expect(mocks.inserts).toEqual([{ table: "vehicle_compliance_alerts_sent", row: {
      tenant_id: "tenant-1", vehicle_id: "veh-1", subject_key: "veh-1", doc_type: "insurance", due_date: "2026-10-19", stage: "advance",
    } }]);
  });

  it("già inviato ieri: nessuna email", async () => {
    mocks.tables.vehicle_compliance_alerts_sent = [{ tenant_id: "tenant-1", subject_key: "veh-1", doc_type: "insurance", due_date: "2026-10-19", stage: "advance" }];
    const res = await callGet();
    expect(await res.json()).toMatchObject({ sent: 0, alerts: 0 });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("email separate per assicurazione, seconda rata e collaudo", async () => {
    mocks.tables.vehicle_insurances = [{ vehicle_id: "veh-1", expiry_date: "2026-10-19", payment_frequency: "semiannual", second_installment_date: "2026-10-15" }];
    mocks.tables.vehicle_inspections = [{ vehicle_id: "veh-1", expiry_date: "2026-10-25" }];
    const res = await callGet();
    expect(await res.json()).toMatchObject({ sent: 3 });
    expect(mocks.inserts.map((i) => i.row.doc_type).sort()).toEqual(["inspection", "insurance", "insurance_installment"]);
  });

  it("polizza sospesa: niente avvisi di scadenza assicurazione", async () => {
    mocks.tables.vehicle_insurances = [{ vehicle_id: "veh-1", expiry_date: "2026-10-19", suspended_from: "2026-10-01", suspended_until: "2026-12-01", reactivated_on: null }];
    expect(await (await callGet()).json()).toMatchObject({ sent: 0 });
  });

  it("invio fallito: non registrato, riproverà", async () => {
    mocks.sendEmail.mockResolvedValue({ ok: false, error: "smtp" });
    const res = await callGet();
    expect(res.status).toBe(502);
    expect(mocks.inserts).toEqual([]);
  });

  it("dry_run via POST: nessuna email, anteprima", async () => {
    const res = await callPost({ today: TODAY, dry_run: true });
    expect(await res.json()).toMatchObject({ dry_run: true, alerts: 1, sent: 0 });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.inserts).toEqual([]);
  });
});
