/**
 * Test di integrazione — POST /api/services/list
 *
 * Verifica il flusso di listing servizi con filtri:
 *  1. Lista vuota per tenant nuovo
 *  2. Servizio seedato compare nella lista
 *  3. Filtri per data funzionano correttamente
 *  4. Auth: 401 senza token, 403 con tenant_id altrui
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { POST as servicesListPOST } from "@/app/api/services/list/route";
import { makeNextRequest, json } from "./helpers/client";
import {
  createTestContext,
  seedHotel,
  seedService,
  type TestContext,
} from "./helpers/seed";

let ctx: TestContext;
let hotelId: string;
let serviceId: string;

const TEST_DATE = "2026-06-15";

beforeAll(async () => {
  ctx = await createTestContext();
  hotelId = await seedHotel(ctx.admin, ctx.tenantId, { name: "Hotel Excelsior" });
  serviceId = await seedService(ctx.admin, ctx.tenantId, hotelId, {
    date: TEST_DATE,
    time: "10:30",
    direction: "arrival",
    customer_name: "Bianchi Laura",
    pax: 3,
    status: "new",
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("services list — autenticazione", () => {
  it("ritorna 401 senza token", async () => {
    const req = makeNextRequest("POST", { tenant_id: ctx.tenantId }, "token-non-valido");
    const res = await servicesListPOST(req);
    expect(res.status).toBe(401);
  });

  it("ritorna 403 per tenant_id diverso dal proprio", async () => {
    const req = makeNextRequest(
      "POST",
      { tenant_id: "00000000-0000-0000-0000-000000000001" },
      ctx.token,
    );
    const res = await servicesListPOST(req);
    expect(res.status).toBe(403);
  });

  it("ritorna 400 per payload non valido", async () => {
    const req = makeNextRequest("POST", { tenant_id: "not-a-uuid" }, ctx.token);
    const res = await servicesListPOST(req);
    expect(res.status).toBe(400);
  });
});

describe("services list — lista base", () => {
  it("ritorna array services per tenant valido", async () => {
    const req = makeNextRequest("POST", { tenant_id: ctx.tenantId }, ctx.token);
    const res = await servicesListPOST(req);
    const body = await json<{ services: unknown[] }>(res);

    expect(res.status).toBe(200);
    expect(Array.isArray(body.services)).toBe(true);
  });

  it("il servizio seedato compare nella lista", async () => {
    const req = makeNextRequest("POST", { tenant_id: ctx.tenantId }, ctx.token);
    const res = await servicesListPOST(req);
    const body = await json<{ services: Array<{ id: string }> }>(res);

    expect(res.status).toBe(200);
    expect(body.services.some((s) => s.id === serviceId)).toBe(true);
  });
});

describe("services list — filtri data", () => {
  it("filtra per dateFrom e dateTo — ritorna il servizio nella finestra", async () => {
    const req = makeNextRequest(
      "POST",
      { tenant_id: ctx.tenantId, dateFrom: TEST_DATE, dateTo: TEST_DATE },
      ctx.token,
    );
    const res = await servicesListPOST(req);
    const body = await json<{ services: Array<{ id: string; date: string }> }>(res);

    expect(res.status).toBe(200);
    expect(body.services.some((s) => s.id === serviceId)).toBe(true);
    for (const s of body.services) {
      expect(s.date >= TEST_DATE && s.date <= TEST_DATE).toBe(true);
    }
  });

  it("data fuori range — nessun risultato per il servizio", async () => {
    const req = makeNextRequest(
      "POST",
      { tenant_id: ctx.tenantId, dateFrom: "2020-01-01", dateTo: "2020-12-31" },
      ctx.token,
    );
    const res = await servicesListPOST(req);
    const body = await json<{ services: Array<{ id: string }> }>(res);

    expect(res.status).toBe(200);
    expect(body.services.some((s) => s.id === serviceId)).toBe(false);
  });

  it("filtro status — new ritorna il servizio, cancelled no", async () => {
    const reqNew = makeNextRequest(
      "POST",
      { tenant_id: ctx.tenantId, status: ["new"] },
      ctx.token,
    );
    const resNew = await servicesListPOST(reqNew);
    const bodyNew = await json<{ services: Array<{ id: string }> }>(resNew);
    expect(bodyNew.services.some((s) => s.id === serviceId)).toBe(true);

    const reqCancelled = makeNextRequest(
      "POST",
      { tenant_id: ctx.tenantId, status: ["cancelled"] },
      ctx.token,
    );
    const resCancelled = await servicesListPOST(reqCancelled);
    const bodyCancelled = await json<{ services: Array<{ id: string }> }>(resCancelled);
    expect(bodyCancelled.services.some((s) => s.id === serviceId)).toBe(false);
  });
});
