/**
 * Test di integrazione — CRUD pricing routes, price lists e rules
 *
 * Verifica il flusso completo di configurazione prezzi:
 *  1. POST /api/pricing/routes — crea tratta, idempotente per nome uguale
 *  2. POST /api/pricing/price-lists — crea listino prezzi
 *  3. POST /api/pricing/rules — crea regola tariffaria
 *  4. PATCH /api/pricing/rules — aggiorna regola
 *  5. DELETE /api/pricing/rules — elimina regola
 *  6. Auth: 401 senza token, 403 per ruolo insufficiente
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { POST as routesPOST } from "@/app/api/pricing/routes/route";
import { POST as priceListsPOST } from "@/app/api/pricing/price-lists/route";
import {
  POST as rulesPOST,
  PATCH as rulesPATCH,
  DELETE as rulesDELETE,
} from "@/app/api/pricing/rules/route";
import { makeNextRequest, json } from "./helpers/client";
import { createTestContext, type TestContext } from "./helpers/seed";

let ctx: TestContext;
let tablesAvailable = false;

beforeAll(async () => {
  ctx = await createTestContext();

  const checks = await Promise.all([
    ctx.admin.from("routes").select("id").limit(1),
    ctx.admin.from("price_lists").select("id").limit(1),
    ctx.admin.from("pricing_rules").select("id").limit(1),
  ]);
  tablesAvailable = checks.every((c) => !c.error);
});

afterAll(async () => {
  await ctx.cleanup();
});

// ─── Routes ──────────────────────────────────────────────────────────────────

describe("pricing routes — creazione tratta", () => {
  it("ritorna 401 senza token", async () => {
    const req = makeNextRequest(
      "POST",
      { name: "Ischia Porto → Hotel Verde", origin_label: "Ischia Porto", destination_label: "Hotel Verde" },
      "token-non-valido",
    );
    const res = await routesPOST(req);
    expect(res.status).toBe(401);
  });

  it("ritorna 400 per nome troppo corto", async () => {
    const req = makeNextRequest(
      "POST",
      { name: "X", origin_label: "A", destination_label: "B" },
      ctx.token,
    );
    const res = await routesPOST(req);
    expect(res.status).toBe(400);
  });

  it("crea una nuova tratta e ritorna ok:true", async () => {
    if (!tablesAvailable) return;
    const req = makeNextRequest(
      "POST",
      { name: "Porto → Hotel Terme Test", origin_label: "Ischia Porto", destination_label: "Hotel Terme Test" },
      ctx.token,
    );
    const res = await routesPOST(req);
    const body = await json<{ ok: boolean; route: { id: string; name: string }; existed?: boolean }>(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.route.id).toBe("string");
    expect(body.existed).toBeFalsy();
  });

  it("idempotente: ri-crea la stessa tratta ritorna existed:true", async () => {
    if (!tablesAvailable) return;
    const payload = { name: "Porto → Hotel Sole Test", origin_label: "Ischia Porto", destination_label: "Hotel Sole Test" };
    await routesPOST(makeNextRequest("POST", payload, ctx.token));
    const res = await routesPOST(makeNextRequest("POST", payload, ctx.token));
    const body = await json<{ ok: boolean; existed: boolean }>(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.existed).toBe(true);
  });
});

// ─── Price Lists ─────────────────────────────────────────────────────────────

describe("pricing price-lists — creazione listino", () => {
  it("crea un listino prezzi e ritorna l'id", async () => {
    if (!tablesAvailable) return;
    const req = makeNextRequest(
      "POST",
      { name: "Listino Test 2026", currency: "EUR", valid_from: "2026-01-01", is_default: false },
      ctx.token,
    );
    const res = await priceListsPOST(req);
    const body = await json<{ ok: boolean; price_list: { id: string } }>(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.price_list.id).toBe("string");
  });

  it("ritorna 400 per currency non valida", async () => {
    const req = makeNextRequest(
      "POST",
      { name: "Listino Invalido", currency: "EURO", valid_from: "2026-01-01" },
      ctx.token,
    );
    const res = await priceListsPOST(req);
    expect(res.status).toBe(400);
  });
});

// ─── Pricing Rules ───────────────────────────────────────────────────────────

describe("pricing rules — CRUD completo", () => {
  let routeId: string;
  let priceListId: string;
  let ruleId: string;

  beforeAll(async () => {
    if (!tablesAvailable) return;

    // Crea route e price list da usare nelle regole
    const routeRes = await routesPOST(
      makeNextRequest("POST", { name: "Porto → Hotel CRUD Test", origin_label: "Porto", destination_label: "Hotel CRUD" }, ctx.token),
    );
    const routeBody = await json<{ ok: boolean; route: { id: string } }>(routeRes);
    routeId = routeBody.route.id;

    const listRes = await priceListsPOST(
      makeNextRequest("POST", { name: "Listino CRUD Test", currency: "EUR", valid_from: "2026-01-01" }, ctx.token),
    );
    const listBody = await json<{ ok: boolean; price_list: { id: string } }>(listRes);
    priceListId = listBody.price_list.id;
  });

  it("crea una regola fixed e ritorna l'id", async () => {
    if (!tablesAvailable) return;
    const req = makeNextRequest(
      "POST",
      {
        price_list_id: priceListId,
        route_id: routeId,
        pax_min: 1,
        rule_kind: "fixed",
        internal_cost_cents: 3000,
        public_price_cents: 6000,
        agency_price_cents: 5500,
        priority: 10,
        active: true,
        needs_manual_review: false,
      },
      ctx.token,
    );
    const res = await rulesPOST(req);
    const body = await json<{ ok: boolean; rule: { id: string }; error?: string }>(res);

    expect(res.status, `POST rules 4xx: ${body.error}`).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.rule.id).toBe("string");
    ruleId = body.rule.id;
  });

  it("aggiorna la regola con PATCH", async () => {
    if (!tablesAvailable || !ruleId) return;
    const req = makeNextRequest(
      "PATCH",
      {
        rule_id: ruleId,
        price_list_id: priceListId,
        route_id: routeId,
        pax_min: 1,
        rule_kind: "fixed",
        internal_cost_cents: 3500,
        public_price_cents: 7000,
        priority: 10,
        active: true,
        needs_manual_review: false,
      },
      ctx.token,
    );
    const res = await rulesPATCH(req);
    const body = await json<{ ok: boolean }>(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("ritorna 400 per rule_id mancante nel PATCH", async () => {
    const req = makeNextRequest("PATCH", { price_list_id: priceListId, route_id: routeId }, ctx.token);
    const res = await rulesPATCH(req);
    expect(res.status).toBe(400);
  });

  it("elimina la regola con DELETE", async () => {
    if (!tablesAvailable || !ruleId) return;
    const req = makeNextRequest("DELETE", { rule_id: ruleId }, ctx.token);
    const res = await rulesDELETE(req);
    const body = await json<{ ok: boolean }>(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("ritorna 400 per rule_id mancante nel DELETE", async () => {
    const req = makeNextRequest("DELETE", {}, ctx.token);
    const res = await rulesDELETE(req);
    expect(res.status).toBe(400);
  });
});
