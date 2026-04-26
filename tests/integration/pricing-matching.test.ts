/**
 * Test di integrazione — tryMatchAndApplyPricing
 *
 * Verifica che il motore di matching calcoli e scriva correttamente:
 *  1. Regola fixed: service_pricing creato, final_price_cents corretto
 *  2. Nessun match: service_pricing assente, pricing_apply_mode=fallback
 *  3. Regola per_pax: prezzi scalati per pax
 *  4. Pax fuori range regola: nessuna regola applicata → fallback
 *
 * Ogni describe block fa seed di dati propri e usa agenzie con email univoca
 * in modo che il matching per email (score 100) sia deterministico.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { tryMatchAndApplyPricing } from "@/lib/server/pricing-matching";
import {
  createTestContext,
  seedHotel,
  seedService,
  seedAgency,
  seedRoute,
  seedPriceList,
  seedPricingRule,
  type TestContext,
} from "./helpers/seed";

let ctx: TestContext;
let tablesAvailable = false;
let hotelId: string;

beforeAll(async () => {
  ctx = await createTestContext();

  const checks = await Promise.all([
    ctx.admin.from("agencies").select("id").limit(1),
    ctx.admin.from("routes").select("id").limit(1),
    ctx.admin.from("price_lists").select("id").limit(1),
    ctx.admin.from("pricing_rules").select("id").limit(1),
    ctx.admin.from("service_pricing").select("id").limit(1),
  ]);
  tablesAvailable = checks.every((r) => !r.error);

  if (!tablesAvailable) return;
  hotelId = await seedHotel(ctx.admin, ctx.tenantId);
});

afterAll(async () => {
  await ctx.cleanup();
});

function skip() {
  if (!tablesAvailable) {
    console.warn("SKIP: tabelle pricing non accessibili (supabase db push necessario)");
    return true;
  }
  return false;
}

// ─── 1. Match pieno — regola fixed ──────────────────────────────────────────

describe("tryMatchAndApplyPricing — regola fixed", () => {
  let serviceId: string;

  beforeAll(async () => {
    if (!tablesAvailable) return;

    const agencyId = await seedAgency(ctx.admin, ctx.tenantId, {
      name: "Agenzia Alfa Ischia",
      contact_email: "alfa@agenzia-alfa-ischia.invalid",
    });
    const routeId = await seedRoute(ctx.admin, ctx.tenantId, {
      name: "Tratta Alfa Porto Hotel",
      origin_label: "Ischia Porto",
      destination_label: "Hotel Alfa",
    });
    const plId = await seedPriceList(ctx.admin, ctx.tenantId, {
      is_default: true,
      agency_id: agencyId,
    });
    await seedPricingRule(ctx.admin, ctx.tenantId, plId, routeId, {
      rule_kind: "fixed",
      internal_cost_cents: 2000,
      public_price_cents: 5000,
      agency_price_cents: 4000,
      pax_min: 1,
      pax_max: null,
      priority: 1,
    });
    serviceId = await seedService(ctx.admin, ctx.tenantId, hotelId, {
      pax: 2,
      direction: "arrival",
      date: "2026-06-15",
    });

    await tryMatchAndApplyPricing(ctx.admin, {
      tenantId: ctx.tenantId,
      inboundEmailId: randomUUID(),
      serviceId,
      senderEmail: "alfa@agenzia-alfa-ischia.invalid",
      sourceText: "Tratta Alfa Porto Hotel transfer arrivo",
      serviceType: "transfer",
      direction: "arrival",
      date: "2026-06-15",
      time: "10:00",
      pax: 2,
    });
  });

  it("crea riga service_pricing con apply_mode=auto_rule", async () => {
    if (skip()) return;
    const { data } = await ctx.admin
      .from("service_pricing")
      .select("apply_mode")
      .eq("service_id", serviceId)
      .maybeSingle();

    expect(data, "service_pricing non trovato").not.toBeNull();
    expect(data!.apply_mode).toBe("auto_rule");
  });

  it("final_price_cents = agency_price_cents (4000)", async () => {
    if (skip()) return;
    const { data } = await ctx.admin
      .from("service_pricing")
      .select("final_price_cents, internal_cost_cents, public_price_cents, agency_price_cents")
      .eq("service_id", serviceId)
      .maybeSingle();

    expect(data!.final_price_cents).toBe(4000);
    expect(data!.internal_cost_cents).toBe(2000);
    expect(data!.public_price_cents).toBe(5000);
    expect(data!.agency_price_cents).toBe(4000);
  });

  it("aggiorna services con pricing_apply_mode=auto_rule e final_price_cents=4000", async () => {
    if (skip()) return;
    const { data } = await ctx.admin
      .from("services")
      .select("pricing_apply_mode, final_price_cents")
      .eq("id", serviceId)
      .maybeSingle();

    expect(data!.pricing_apply_mode).toBe("auto_rule");
    expect(data!.final_price_cents).toBe(4000);
  });

  it("margin_cents = final_price - internal_cost = 2000", async () => {
    if (skip()) return;
    const { data } = await ctx.admin
      .from("services")
      .select("margin_cents")
      .eq("id", serviceId)
      .maybeSingle();

    expect(data!.margin_cents).toBe(2000); // 4000 - 2000
  });
});

// ─── 2. Nessun match — fallback ──────────────────────────────────────────────

describe("tryMatchAndApplyPricing — nessun match (fallback)", () => {
  let serviceId: string;

  beforeAll(async () => {
    if (!tablesAvailable) return;

    serviceId = await seedService(ctx.admin, ctx.tenantId, hotelId, {
      pax: 1,
      direction: "arrival",
      date: "2026-06-20",
    });

    await tryMatchAndApplyPricing(ctx.admin, {
      tenantId: ctx.tenantId,
      inboundEmailId: randomUUID(),
      serviceId,
      senderEmail: "nobody@xyzunknown.invalid",
      sourceText: "xxxxxxxxxxx zzz 99999 nessuna corrispondenza",
      serviceType: "transfer",
      direction: "arrival",
      date: "2026-06-20",
      time: "09:00",
      pax: 1,
    });
  });

  it("non crea righe service_pricing", async () => {
    if (skip()) return;
    const { data } = await ctx.admin
      .from("service_pricing")
      .select("id")
      .eq("service_id", serviceId)
      .maybeSingle();

    expect(data).toBeNull();
  });

  it("imposta pricing_apply_mode=fallback sul servizio", async () => {
    if (skip()) return;
    const { data } = await ctx.admin
      .from("services")
      .select("pricing_apply_mode")
      .eq("id", serviceId)
      .maybeSingle();

    expect(data!.pricing_apply_mode).toBe("fallback");
  });
});

// ─── 3. Regola per_pax — moltiplicatore pax ──────────────────────────────────

describe("tryMatchAndApplyPricing — regola per_pax", () => {
  const PAX = 3;
  let serviceId: string;

  beforeAll(async () => {
    if (!tablesAvailable) return;

    const agencyId = await seedAgency(ctx.admin, ctx.tenantId, {
      name: "Agenzia Beta Aeroporto",
      contact_email: "beta@agenzia-beta-aeroporto.invalid",
    });
    const routeId = await seedRoute(ctx.admin, ctx.tenantId, {
      name: "Tratta Beta Aeroporto Hotel",
      origin_label: "Aeroporto Capodichino",
      destination_label: "Hotel Beta",
    });
    const plId = await seedPriceList(ctx.admin, ctx.tenantId, {
      is_default: true,
      agency_id: agencyId,
    });
    await seedPricingRule(ctx.admin, ctx.tenantId, plId, routeId, {
      rule_kind: "per_pax",
      internal_cost_cents: 1000,
      public_price_cents: 2000,
      agency_price_cents: 1800,
      pax_min: 1,
      pax_max: 10,
      priority: 1,
    });
    serviceId = await seedService(ctx.admin, ctx.tenantId, hotelId, {
      pax: PAX,
      direction: "arrival",
      date: "2026-07-01",
    });

    await tryMatchAndApplyPricing(ctx.admin, {
      tenantId: ctx.tenantId,
      inboundEmailId: randomUUID(),
      serviceId,
      senderEmail: "beta@agenzia-beta-aeroporto.invalid",
      sourceText: "Tratta Beta Aeroporto Hotel transfer arrivo",
      serviceType: "transfer",
      direction: "arrival",
      date: "2026-07-01",
      time: "11:00",
      pax: PAX,
    });
  });

  it("scala internal_cost_cents per il numero di pax", async () => {
    if (skip()) return;
    const { data } = await ctx.admin
      .from("service_pricing")
      .select("internal_cost_cents")
      .eq("service_id", serviceId)
      .maybeSingle();

    expect(data, "service_pricing non trovato").not.toBeNull();
    expect(data!.internal_cost_cents).toBe(1000 * PAX); // 3000
  });

  it("scala public_price_cents e final_price_cents per pax", async () => {
    if (skip()) return;
    const { data } = await ctx.admin
      .from("service_pricing")
      .select("public_price_cents, final_price_cents, agency_price_cents")
      .eq("service_id", serviceId)
      .maybeSingle();

    expect(data!.public_price_cents).toBe(2000 * PAX);  // 6000
    expect(data!.agency_price_cents).toBe(1800 * PAX);  // 5400
    expect(data!.final_price_cents).toBe(1800 * PAX);   // 5400
  });

  it("margin_cents = (final_price - internal_cost) × pax", async () => {
    if (skip()) return;
    const { data } = await ctx.admin
      .from("services")
      .select("margin_cents, final_price_cents")
      .eq("id", serviceId)
      .maybeSingle();

    expect(data!.final_price_cents).toBe(1800 * PAX);
    expect(data!.margin_cents).toBe((1800 - 1000) * PAX); // 2400
  });
});

// ─── 4. Pax fuori range della regola ─────────────────────────────────────────

describe("tryMatchAndApplyPricing — pax fuori range regola", () => {
  let serviceId: string;

  beforeAll(async () => {
    if (!tablesAvailable) return;

    const agencyId = await seedAgency(ctx.admin, ctx.tenantId, {
      name: "Agenzia Gamma Forio",
      contact_email: "gamma@agenzia-gamma-forio.invalid",
    });
    const routeId = await seedRoute(ctx.admin, ctx.tenantId, {
      name: "Tratta Gamma Forio Hotel",
      origin_label: "Ischia Porto",
      destination_label: "Hotel Gamma",
    });
    const plId = await seedPriceList(ctx.admin, ctx.tenantId, {
      is_default: true,
      agency_id: agencyId,
    });
    // Regola valida solo per 5–10 pax
    await seedPricingRule(ctx.admin, ctx.tenantId, plId, routeId, {
      rule_kind: "fixed",
      internal_cost_cents: 3000,
      public_price_cents: 6000,
      agency_price_cents: null,
      pax_min: 5,
      pax_max: 10,
      priority: 1,
    });
    serviceId = await seedService(ctx.admin, ctx.tenantId, hotelId, {
      pax: 2, // fuori range [5, 10]
      direction: "arrival",
      date: "2026-08-01",
    });

    await tryMatchAndApplyPricing(ctx.admin, {
      tenantId: ctx.tenantId,
      inboundEmailId: randomUUID(),
      serviceId,
      senderEmail: "gamma@agenzia-gamma-forio.invalid",
      sourceText: "Tratta Gamma Forio Hotel transfer arrivo",
      serviceType: "transfer",
      direction: "arrival",
      date: "2026-08-01",
      time: "14:00",
      pax: 2,
    });
  });

  it("non crea service_pricing quando pax non rientra nel range", async () => {
    if (skip()) return;
    const { data } = await ctx.admin
      .from("service_pricing")
      .select("id")
      .eq("service_id", serviceId)
      .maybeSingle();

    expect(data).toBeNull();
  });

  it("imposta pricing_apply_mode=fallback sul servizio", async () => {
    if (skip()) return;
    const { data } = await ctx.admin
      .from("services")
      .select("pricing_apply_mode")
      .eq("id", serviceId)
      .maybeSingle();

    expect(data!.pricing_apply_mode).toBe("fallback");
  });
});
