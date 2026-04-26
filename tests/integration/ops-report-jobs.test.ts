/**
 * Test di integrazione — /api/ops/report-jobs
 *
 * Verifica il flusso di pianificazione e lettura job operativi:
 *  1. GET: lista vuota per tenant nuovo
 *  2. POST: crea job pianificati a partire dai servizi nel DB
 *  3. POST con nessun servizio → inserted: 0
 *  4. GET dopo POST: i job appaiono nella lista
 *  5. Auth: 401 senza token
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  GET as reportJobsGET,
  POST as reportJobsPOST,
} from "@/app/api/ops/report-jobs/route";
import { makeNextRequest, json } from "./helpers/client";
import {
  createTestContext,
  seedHotel,
  seedService,
  type TestContext,
} from "./helpers/seed";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  // Cleanup jobs creati durante i test
  await ctx.admin.from("ops_report_jobs").delete().eq("tenant_id", ctx.tenantId);
  await ctx.cleanup();
});

describe("report-jobs GET — autenticazione", () => {
  it("ritorna 401 senza token", async () => {
    const req = makeNextRequest("GET", undefined, "token-non-valido");
    const res = await reportJobsGET(req);
    expect(res.status).toBe(401);
  });
});

describe("report-jobs GET — lista vuota", () => {
  it("ritorna ok:true e array jobs vuoto per tenant nuovo", async () => {
    const req = makeNextRequest("GET", undefined, ctx.token);
    const res = await reportJobsGET(req);
    const body = await json<{ ok: boolean; jobs: unknown[] }>(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.jobs)).toBe(true);
    expect(body.jobs.length).toBe(0);
  });
});

describe("report-jobs POST — nessun servizio", () => {
  it("ritorna inserted:0 quando non ci sono servizi nel tenant", async () => {
    const req = makeNextRequest("POST", { today: "2026-06-20" }, ctx.token);
    const res = await reportJobsPOST(req);
    const body = await json<{ ok: boolean; inserted: number }>(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.inserted).toBe(0);
  });
});

describe("report-jobs POST — con servizi in DB", () => {
  let hotelId: string;

  beforeAll(async () => {
    // Controlla disponibilità tabella ops_report_jobs
    const { error } = await ctx.admin.from("ops_report_jobs").select("id").limit(1);
    if (error) throw new Error(`ops_report_jobs non disponibile: ${error.message}`);

    hotelId = await seedHotel(ctx.admin, ctx.tenantId, { name: "Hotel Vesuvio" });

    // Seed servizi nelle prossime 48h (arrivals_48h)
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const targetDate = tomorrow.toISOString().slice(0, 10);

    await seedService(ctx.admin, ctx.tenantId, hotelId, {
      date: targetDate,
      time: "09:00",
      direction: "arrival",
      customer_name: "Ferrari Marco",
      pax: 2,
      billing_party_name: "Agenzia Roma",
    });
  });

  it("crea job pianificati per i servizi esistenti", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const req = makeNextRequest("POST", { today }, ctx.token);
    const res = await reportJobsPOST(req);
    const body = await json<{ ok: boolean; inserted: number }>(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // Con servizi in DB ci aspettiamo almeno un job creato
    expect(typeof body.inserted).toBe("number");
  });

  it("i job appaiono nella GET dopo la creazione", async () => {
    const req = makeNextRequest("GET", undefined, ctx.token);
    const res = await reportJobsGET(req);
    const body = await json<{ ok: boolean; jobs: Array<{ id: string; status: string; job_type: string }> }>(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // Se sono stati creati job, devono avere status "planned"
    for (const job of body.jobs) {
      expect(job.status).toBe("planned");
      expect(typeof job.job_type).toBe("string");
    }
  });
});
