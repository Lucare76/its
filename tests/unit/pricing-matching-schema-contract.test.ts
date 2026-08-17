import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tryMatchAndApplyPricing } from "@/lib/server/pricing-matching";

/**
 * HARDENING SPRINT 2A — FASE 13. Documents the applicative contract of the
 * 8 schema-drift columns on `services` (import_id, applied_price_list_id,
 * applied_pricing_rule_id, pricing_currency, pricing_apply_mode,
 * pricing_applied_at, pricing_manual_override, pricing_manual_override_reason)
 * plus the `service_pricing` insert payload — via a fully in-memory fake
 * Supabase admin (no live DB needed). Also documents the FASE 12 error
 * logging added this sprint: DB/schema errors on the three previously-silent
 * write paths (inbound_booking_imports insert, service_pricing insert,
 * services update) are now logged (service_id/tenant_id/message only, never
 * source text or agency/customer data) instead of being dropped.
 *
 * Does NOT touch matching/scoring business logic — only documents what gets
 * written once a match/fallback decision has already been made.
 */

type Row = Record<string, unknown>;

function makeReadBuilder(rows: Row[]) {
  let filtered = [...rows];
  const builder = {
    eq(field: string, value: unknown) {
      filtered = filtered.filter((r) => r[field] === value);
      return builder;
    },
    lte(field: string, value: unknown) {
      filtered = filtered.filter((r) => String(r[field]) <= String(value));
      return builder;
    },
    or(_expr: string) {
      return builder;
    },
    order(_field: string, _opts?: unknown) {
      return builder;
    },
    limit(_n: number) {
      return builder;
    },
    then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
    }
  };
  return builder;
}

function createFakePricingAdmin(opts: {
  agencies?: Row[];
  aliases?: Row[];
  routes?: Row[];
  priceLists?: Row[];
  pricingRules?: Row[];
  importInsertError?: { message: string } | null;
  servicePricingInsertError?: { message: string } | null;
  servicesUpdateError?: { message: string } | null;
  importInsertedId?: string;
}) {
  const calls = {
    servicesUpdatePayloads: [] as Row[],
    servicePricingInserts: [] as Row[],
    importInserts: [] as Row[]
  };

  const admin = {
    from(table: string) {
      if (table === "agencies") return { select: () => makeReadBuilder(opts.agencies ?? []) };
      if (table === "agency_aliases") return { select: () => makeReadBuilder(opts.aliases ?? []) };
      if (table === "routes") return { select: () => makeReadBuilder(opts.routes ?? []) };
      if (table === "price_lists") return { select: () => makeReadBuilder(opts.priceLists ?? []) };
      if (table === "pricing_rules") return { select: () => makeReadBuilder(opts.pricingRules ?? []) };
      if (table === "inbound_booking_imports") {
        return {
          insert(payload: Row) {
            calls.importInserts.push(payload);
            return {
              select(_c?: string) {
                return {
                  single() {
                    if (opts.importInsertError) return Promise.resolve({ data: null, error: opts.importInsertError });
                    return Promise.resolve({ data: { id: opts.importInsertedId ?? "import-1" }, error: null });
                  }
                };
              }
            };
          }
        };
      }
      if (table === "service_pricing") {
        return {
          insert(payload: Row) {
            calls.servicePricingInserts.push(payload);
            return Promise.resolve({ data: null, error: opts.servicePricingInsertError ?? null });
          }
        };
      }
      if (table === "services") {
        return {
          update(payload: Row) {
            calls.servicesUpdatePayloads.push(payload);
            const chain = {
              eq() {
                return chain;
              },
              then(resolve: (v: { data: null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
                return Promise.resolve({ data: null, error: opts.servicesUpdateError ?? null }).then(resolve, reject);
              }
            };
            return chain;
          }
        };
      }
      throw new Error(`Unexpected table in fake admin: ${table}`);
    }
  };

  return { admin, calls };
}

const TENANT = "tenant-1";
const SERVICE_ID = "service-1";
const AGENCY_ID = "agency-1";
const ROUTE_ID = "route-1";
const PRICE_LIST_ID = "pricelist-1";
const RULE_ID = "rule-1";

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    inboundEmailId: "email-1",
    serviceId: SERVICE_ID,
    senderEmail: "ops@testagency.it",
    sourceText: "Trasferimento da Napoli a Ischia Porto per due persone",
    serviceType: "transfer" as const,
    direction: "arrival" as const,
    date: "2026-08-20",
    time: "10:00",
    pax: 2,
    ...overrides
  };
}

function matchedFixture() {
  return {
    agencies: [{ id: AGENCY_ID, tenant_id: TENANT, name: "Test Agency", active: true, contact_email: "ops@testagency.it", contact_emails: [], booking_emails: [], sender_domains: [] }],
    aliases: [],
    routes: [{ id: ROUTE_ID, tenant_id: TENANT, name: "Napoli-Ischia", origin_label: "Napoli", destination_label: "Ischia Porto", active: true }],
    priceLists: [{ id: PRICE_LIST_ID, tenant_id: TENANT, currency: "EUR", is_default: true, valid_from: "2020-01-01", valid_to: null, active: true, agency_id: null }],
    pricingRules: [
      {
        id: RULE_ID,
        tenant_id: TENANT,
        active: true,
        price_list_id: PRICE_LIST_ID,
        route_id: ROUTE_ID,
        agency_id: null,
        service_type: null,
        direction: null,
        pax_min: 1,
        pax_max: null,
        rule_kind: "fixed",
        internal_cost_cents: 5000,
        public_price_cents: 8000,
        agency_price_cents: null,
        priority: 100,
        vehicle_type: null,
        time_from: null,
        time_to: null,
        season_from: null,
        season_to: null,
        needs_manual_review: false
      }
    ]
  };
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe("tryMatchAndApplyPricing — matched rule path", () => {
  it("1/4/5/6. writes exactly the expected services.update contract when a rule matches", async () => {
    const { admin, calls } = createFakePricingAdmin(matchedFixture());
    await tryMatchAndApplyPricing(admin as never, baseInput());

    expect(calls.servicesUpdatePayloads).toHaveLength(1);
    const payload = calls.servicesUpdatePayloads[0];

    expect(payload).toMatchObject({
      agency_id: AGENCY_ID,
      route_id: ROUTE_ID,
      import_id: "import-1",
      applied_price_list_id: PRICE_LIST_ID,
      applied_pricing_rule_id: RULE_ID,
      pricing_currency: "EUR",
      internal_cost_cents: 5000,
      public_price_cents: 8000,
      final_price_cents: 8000,
      margin_cents: 3000,
      pricing_apply_mode: "auto_rule",
      pricing_manual_override: false
    });
    expect(typeof payload.pricing_applied_at).toBe("string");
    expect(typeof payload.pricing_match_confidence).toBe("number");
    expect(payload.pricing_confidence).toBeUndefined();
  });

  it("1. writes the expected service_pricing insert contract", async () => {
    const { admin, calls } = createFakePricingAdmin(matchedFixture());
    await tryMatchAndApplyPricing(admin as never, baseInput());

    expect(calls.servicePricingInserts).toHaveLength(1);
    expect(calls.servicePricingInserts[0]).toMatchObject({
      tenant_id: TENANT,
      service_id: SERVICE_ID,
      price_list_id: PRICE_LIST_ID,
      pricing_rule_id: RULE_ID,
      agency_id: AGENCY_ID,
      route_id: ROUTE_ID,
      currency: "EUR",
      apply_mode: "auto_rule",
      manual_override: false
    });
  });

  it("3. never sets pricing_manual_override to true on the automatic matching path", async () => {
    const { admin, calls } = createFakePricingAdmin(matchedFixture());
    await tryMatchAndApplyPricing(admin as never, baseInput());
    expect(calls.servicesUpdatePayloads[0].pricing_manual_override).toBe(false);
  });
});

describe("tryMatchAndApplyPricing — fallback path", () => {
  it("2/4. no rule found -> pricing_apply_mode 'fallback', only the fallback field set is written, no service_pricing insert", async () => {
    const { admin, calls } = createFakePricingAdmin({ agencies: [], aliases: [], routes: [], priceLists: [], pricingRules: [] });
    await tryMatchAndApplyPricing(admin as never, baseInput({ senderEmail: null, sourceText: "nessuna corrispondenza possibile" }));

    expect(calls.servicePricingInserts).toHaveLength(0);
    expect(calls.servicesUpdatePayloads).toHaveLength(1);
    const payload = calls.servicesUpdatePayloads[0];
    expect(payload).toMatchObject({
      agency_id: null,
      route_id: null,
      import_id: "import-1",
      pricing_apply_mode: "fallback"
    });
    // Fallback branch never sets these — only the matched-rule branch does.
    expect(payload.applied_price_list_id).toBeUndefined();
    expect(payload.applied_pricing_rule_id).toBeUndefined();
    expect(payload.pricing_currency).toBeUndefined();
    expect(payload.pricing_manual_override).toBeUndefined();
    // Hardening Sprint 2A.1: writes the new, collision-free column — never
    // the legacy text low/medium/high pricing_confidence column. Zero
    // confidence here (no signal at all) legitimately resolves to `null`
    // via the pre-existing, unchanged `matchConfidence || null` formula —
    // see the dedicated score-boundary tests below for that exact case.
    expect("pricing_match_confidence" in payload).toBe(true);
    expect(payload.pricing_confidence).toBeUndefined();
  });

  it("2. null/legacy input accepted: empty agencies/routes/rules never throws", async () => {
    const { admin } = createFakePricingAdmin({});
    await expect(tryMatchAndApplyPricing(admin as never, baseInput())).resolves.toBeUndefined();
  });
});

describe("tryMatchAndApplyPricing — HARDENING SPRINT 2A.1: pricing_match_confidence score boundaries", () => {
  it("1. score 0 (no agency/route signal at all): pre-existing `matchConfidence || null` formula (unchanged) stores null, not 0", async () => {
    const { admin, calls } = createFakePricingAdmin({ agencies: [], aliases: [], routes: [], priceLists: [], pricingRules: [] });
    await tryMatchAndApplyPricing(admin as never, baseInput({ senderEmail: null, sourceText: "zzz completamente estraneo zzz" }));
    expect(calls.servicesUpdatePayloads[0].pricing_match_confidence).toBeNull();
  });

  it("2. score 100 (exact email match + full route match): stored as the integer 100", async () => {
    const { admin, calls } = createFakePricingAdmin(matchedFixture());
    await tryMatchAndApplyPricing(admin as never, baseInput());
    expect(calls.servicesUpdatePayloads[0].pricing_match_confidence).toBe(100);
  });

  it("3. intermediate score: a weak, token-overlap-only route match (no email, no port-hint/intent keywords) stores a value strictly between 0 and 100", async () => {
    const fixture = matchedFixture();
    // No agency at all (agencyScore stays 0). The route name shares only one
    // token ("villa") with the source text, and the source text avoids every
    // port-hint/intent keyword (napoli/porto/stazione/aeroporto/bus/...), so
    // neither byPoints nor byPortHints nor routeIntentBoost contribute —
    // only scoreTokenOverlap via byNameTokens drives the score.
    const weakRoute = { id: ROUTE_ID, tenant_id: TENANT, name: "Stazione Villa", origin_label: "Stazione Centrale", destination_label: "Villa Bianca", active: true };
    const { admin, calls } = createFakePricingAdmin({ ...fixture, agencies: [], routes: [weakRoute] });
    await tryMatchAndApplyPricing(admin as never, baseInput({ senderEmail: "unrelated@nowhere.test", sourceText: "Trasferimento per due persone verso villa" }));
    const score = calls.servicesUpdatePayloads[0].pricing_match_confidence as number;
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });
});

describe("tryMatchAndApplyPricing — HARDENING SPRINT 2A.1: legacy pricing_confidence is never touched", () => {
  it("4/9. the update payload never contains the legacy `pricing_confidence` key, in either branch — a pre-existing legacy value (e.g. 'high') is never overwritten or read", async () => {
    const matched = createFakePricingAdmin(matchedFixture());
    await tryMatchAndApplyPricing(matched.admin as never, baseInput());
    expect("pricing_confidence" in matched.calls.servicesUpdatePayloads[0]).toBe(false);

    const fallback = createFakePricingAdmin({ pricingRules: [] });
    await tryMatchAndApplyPricing(fallback.admin as never, baseInput({ senderEmail: null, sourceText: "x" }));
    expect("pricing_confidence" in fallback.calls.servicesUpdatePayloads[0]).toBe(false);
  });
});

describe("tryMatchAndApplyPricing — 6. import_id propagation", () => {
  it("propagates the inbound_booking_imports insert id into both the matched and fallback services.update payloads", async () => {
    const matched = createFakePricingAdmin({ ...matchedFixture(), importInsertedId: "import-xyz" });
    await tryMatchAndApplyPricing(matched.admin as never, baseInput());
    expect(matched.calls.servicesUpdatePayloads[0].import_id).toBe("import-xyz");

    const fallback = createFakePricingAdmin({ pricingRules: [], importInsertedId: "import-abc" });
    await tryMatchAndApplyPricing(fallback.admin as never, baseInput({ senderEmail: null, sourceText: "x" }));
    expect(fallback.calls.servicesUpdatePayloads[0].import_id).toBe("import-abc");
  });
});

describe("tryMatchAndApplyPricing — 7. errors are logged, never thrown, never leak PII", () => {
  it("inbound_booking_imports insert error -> logged with service_id/tenant_id/message only, function still resolves", async () => {
    const { admin } = createFakePricingAdmin({ pricingRules: [], importInsertError: { message: 'column "match_quality" does not exist' } });
    await expect(tryMatchAndApplyPricing(admin as never, baseInput())).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalled();
    const logged = JSON.stringify(consoleErrorSpy.mock.calls);
    expect(logged).toContain(SERVICE_ID);
    expect(logged).toContain(TENANT);
    expect(logged).toContain("match_quality");
    expect(logged).not.toContain("Napoli");
    expect(logged).not.toContain("ops@testagency.it");
  });

  it("service_pricing insert error (matched path) -> logged without leaking snapshot/source data", async () => {
    const { admin } = createFakePricingAdmin({ ...matchedFixture(), servicePricingInsertError: { message: "relation \"service_pricing\" does not exist" } });
    await expect(tryMatchAndApplyPricing(admin as never, baseInput())).resolves.toBeUndefined();

    const logged = JSON.stringify(consoleErrorSpy.mock.calls);
    expect(logged).toContain("service_pricing");
    expect(logged).not.toContain("Napoli");
  });

  it("final services.update error (matched path) -> logged, function still resolves without throwing", async () => {
    const { admin } = createFakePricingAdmin({ ...matchedFixture(), servicesUpdateError: { message: 'column "applied_price_list_id" does not exist' } });
    await expect(tryMatchAndApplyPricing(admin as never, baseInput())).resolves.toBeUndefined();

    const logged = JSON.stringify(consoleErrorSpy.mock.calls);
    expect(logged).toContain("applied_price_list_id");
    expect(logged).toContain(SERVICE_ID);
  });

  it("fallback services.update error -> logged, function still resolves without throwing", async () => {
    const { admin } = createFakePricingAdmin({ pricingRules: [], servicesUpdateError: { message: 'column "pricing_apply_mode" does not exist' } });
    await expect(tryMatchAndApplyPricing(admin as never, baseInput({ senderEmail: null, sourceText: "x" }))).resolves.toBeUndefined();

    const logged = JSON.stringify(consoleErrorSpy.mock.calls);
    expect(logged).toContain("pricing_apply_mode");
  });
});
