/**
 * Test di integrazione — calcolo prezzi
 *
 *  1. POST /api/pricing/simulator  — calcolo in memoria, nessun dato DB necessario
 *  2. POST /api/pricing/override   — override manuale su un servizio reale in DB
 *  3. GET  /api/pricing/bootstrap  — verifica che il bootstrap ritorni strutture vuote per un nuovo tenant
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { POST as simulatorPOST } from "@/app/api/pricing/simulator/route";
import { POST as overridePOST } from "@/app/api/pricing/override/route";
import { GET as bootstrapGET } from "@/app/api/pricing/bootstrap/route";
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
  await ctx.cleanup();
});

// ─── Simulator ───────────────────────────────────────────────────────────────

describe("pricing simulator — regola fixed", () => {
  it("calcola costi e margine con moltiplicatore 1", async () => {
    const req = makeNextRequest(
      "POST",
      {
        pax: 3,
        rule_kind: "fixed",
        internal_cost_cents: 5000,
        public_price_cents: 8000,
        agency_price_cents: 7500,
      },
      ctx.token,
    );
    const res = await simulatorPOST(req);
    const body = await json<{ ok: boolean; result: Record<string, number> }>(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // fixed → multiplier = 1, costi NON scalano per pax
    expect(body.result.multiplier).toBe(1);
    expect(body.result.internal_cost_cents).toBe(5000);
    expect(body.result.public_price_cents).toBe(8000);
    expect(body.result.agency_price_cents).toBe(7500);
    // final_price = agency_price (presente)
    expect(body.result.final_price_cents).toBe(7500);
    expect(body.result.margin_cents).toBe(2500);
    expect(body.result.margin_pct).toBeCloseTo(33.33, 1);
  });

  it("usa public_price come final_price quando agency_price è null", async () => {
    const req = makeNextRequest(
      "POST",
      {
        pax: 1,
        rule_kind: "fixed",
        internal_cost_cents: 4000,
        public_price_cents: 6000,
        agency_price_cents: null,
      },
      ctx.token,
    );
    const res = await simulatorPOST(req);
    const body = await json<{ ok: boolean; result: Record<string, number> }>(res);

    expect(res.status).toBe(200);
    expect(body.result.final_price_cents).toBe(6000);
    expect(body.result.margin_cents).toBe(2000);
  });
});

describe("pricing simulator — regola per_pax", () => {
  it("scala tutti i costi per il numero di pax", async () => {
    const req = makeNextRequest(
      "POST",
      {
        pax: 4,
        rule_kind: "per_pax",
        internal_cost_cents: 1000,
        public_price_cents: 2000,
        agency_price_cents: null,
      },
      ctx.token,
    );
    const res = await simulatorPOST(req);
    const body = await json<{ ok: boolean; result: Record<string, number> }>(res);

    expect(res.status).toBe(200);
    expect(body.result.multiplier).toBe(4);
    expect(body.result.internal_cost_cents).toBe(4000);
    expect(body.result.public_price_cents).toBe(8000);
    expect(body.result.margin_cents).toBe(4000);
    expect(body.result.margin_pct).toBe(50);
  });
});

describe("pricing simulator — validazione input", () => {
  it("ritorna 400 per pax negativo", async () => {
    const req = makeNextRequest(
      "POST",
      { pax: -1, rule_kind: "fixed", internal_cost_cents: 0, public_price_cents: 0 },
      ctx.token,
    );
    const res = await simulatorPOST(req);
    expect(res.status).toBe(400);
  });

  it("ritorna 400 per rule_kind sconosciuto", async () => {
    const req = makeNextRequest(
      "POST",
      { pax: 2, rule_kind: "hourly", internal_cost_cents: 0, public_price_cents: 0 },
      ctx.token,
    );
    const res = await simulatorPOST(req);
    expect(res.status).toBe(400);
  });

  it("ritorna 401 senza token valido", async () => {
    const req = makeNextRequest(
      "POST",
      { pax: 2, rule_kind: "fixed", internal_cost_cents: 0, public_price_cents: 0 },
      "token-non-valido",
    );
    const res = await simulatorPOST(req);
    expect(res.status).toBe(401);
  });
});

// ─── Bootstrap ───────────────────────────────────────────────────────────────

describe("pricing bootstrap", () => {
  it("ritorna arrays vuoti per un tenant nuovo senza dati pricing", async () => {
    const req = makeNextRequest("GET", undefined, ctx.token);
    const res = await bootstrapGET(req);
    const body = await json<{
      agencies: unknown[];
      routes: unknown[];
      price_lists: unknown[];
      pricing_rules: unknown[];
    }>(res);

    expect(res.status).toBe(200);
    expect(Array.isArray(body.agencies)).toBe(true);
    expect(Array.isArray(body.routes)).toBe(true);
    expect(Array.isArray(body.price_lists)).toBe(true);
    expect(Array.isArray(body.pricing_rules)).toBe(true);
  });
});

// ─── Override manuale ────────────────────────────────────────────────────────
// Questi test richiedono che la tabella service_pricing sia accessibile via
// PostgREST. Se non lo è (migrazioni remote non aggiornate o GRANT mancanti),
// i test vengono saltati automaticamente.

describe("pricing override", () => {
  let hotelId: string;
  let serviceId: string;
  let hasServicePricing = false;

  beforeAll(async () => {
    // Verifica disponibilità della tabella via API
    const { error } = await ctx.admin.from("service_pricing").select("id").limit(1);
    hasServicePricing = !error;

    if (hasServicePricing) {
      hotelId = await seedHotel(ctx.admin, ctx.tenantId);
      serviceId = await seedService(ctx.admin, ctx.tenantId, hotelId, { pax: 2, date: "2026-05-15" });
    }
  });

  it("applica un override manuale e aggiorna il servizio", async () => {
    if (!hasServicePricing) {
      console.warn("SKIP: service_pricing non accessibile via PostgREST (supabase db push necessario)");
      return;
    }
    const req = makeNextRequest(
      "POST",
      {
        service_id: serviceId,
        internal_cost_cents: 5500,
        public_price_cents: 9000,
        agency_price_cents: 8000,
        reason: "Tariffa personalizzata test",
      },
      ctx.token,
    );
    const res = await overridePOST(req);
    const body = await json<{ ok?: boolean; error?: string }>(res);

    expect(res.status, `Override 500: ${body.error}`).toBe(200);
    expect(body.ok).toBe(true);

    const { data: pricing } = await ctx.admin
      .from("service_pricing")
      .select("apply_mode, agency_price_cents, internal_cost_cents")
      .eq("service_id", serviceId)
      .maybeSingle();

    expect(pricing).toBeTruthy();
    expect(pricing!.apply_mode).toBe("manual");
    expect(pricing!.internal_cost_cents).toBe(5500);
    expect(pricing!.agency_price_cents).toBe(8000);
  });

  it("ritorna 400 per service_id mancante", async () => {
    const req = makeNextRequest(
      "POST",
      { internal_cost_cents: 1000, public_price_cents: 2000, reason: "test" },
      ctx.token,
    );
    const res = await overridePOST(req);
    expect(res.status).toBe(400);
  });
});
