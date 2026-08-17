import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

/**
 * HARDENING SPRINT 2A.1 — remaining FASE 10 contract checks not covered by
 * tests/unit/pricing-matching-schema-contract.test.ts:
 *  - 8. migration contract: 0234 declares the new collision-free column and
 *       leaves the legacy pricing_confidence column/constraint untouched;
 *  - 7. manual override: app/api/pricing/override writes the new column,
 *       never the legacy one.
 */

describe("migration 0234 — pricing_match_confidence contract", () => {
  const sql = readFileSync(
    new URL("../../supabase/migrations/0234_pricing_schema_drift_fix.sql", import.meta.url),
    "utf8"
  );

  it("8. adds pricing_match_confidence as a nullable integer with an idempotent 0-100 CHECK", () => {
    expect(sql).toMatch(/add column if not exists pricing_match_confidence integer null/);
    expect(sql).toMatch(/services_pricing_match_confidence_valid/);
    expect(sql).toMatch(/pricing_match_confidence >= 0 and pricing_match_confidence <= 100/);
  });

  it("8/9. never attempts to ADD COLUMN, ALTER, or add a CHECK constraint on the legacy pricing_confidence column", () => {
    expect(sql).not.toMatch(/add column if not exists pricing_confidence/);
    expect(sql).not.toMatch(/alter column pricing_confidence/i);
    expect(sql).not.toMatch(/services_pricing_confidence_valid/);
  });

  it("8. every statement is idempotent (IF NOT EXISTS / DO $$ IF NOT EXISTS), no DROP of data or destructive rewrite", () => {
    expect(sql).not.toMatch(/drop\s+column/i);
    expect(sql).not.toMatch(/drop\s+table/i);
    expect(sql).not.toMatch(/alter\s+column\s+\w+\s+type/i);
  });
});

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn()
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest
}));

import { POST } from "@/app/api/pricing/override/route";

type Row = Record<string, unknown>;

function createFakeOverrideAdmin(serviceRow: Row) {
  const servicesUpdatePayloads: Row[] = [];
  const admin = {
    from(table: string) {
      if (table === "services") {
        return {
          select() {
            return {
              eq() {
                return this;
              },
              maybeSingle() {
                return Promise.resolve({ data: serviceRow, error: null });
              }
            };
          },
          update(payload: Row) {
            servicesUpdatePayloads.push(payload);
            return {
              eq() {
                return this;
              },
              then(resolve: (v: { data: null; error: null }) => unknown) {
                return Promise.resolve({ data: null, error: null }).then(resolve);
              }
            };
          }
        };
      }
      if (table === "service_pricing") {
        return {
          insert() {
            return {
              select() {
                return {
                  single() {
                    return Promise.resolve({ data: { id: "pricing-row-1" }, error: null });
                  }
                };
              }
            };
          }
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    }
  };
  return { admin, servicesUpdatePayloads };
}

function req(body: Record<string, unknown>) {
  return new NextRequest("https://example.test/api/pricing/override", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: "Bearer token" },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  mocks.authorizePricingRequest.mockReset();
});

describe("POST /api/pricing/override — 7. manual override writes the collision-free column", () => {
  it("writes pricing_match_confidence: 100, never the legacy pricing_confidence column", async () => {
    const { admin, servicesUpdatePayloads } = createFakeOverrideAdmin({
      id: "51111111-1111-4111-8111-111111111111",
      tenant_id: "tenant-1",
      agency_id: null,
      route_id: null
    });
    mocks.authorizePricingRequest.mockResolvedValue({
      admin,
      user: { id: "user-1" },
      membership: { tenant_id: "tenant-1", role: "operator", suspended: false }
    });

    const res = await POST(
      req({
        service_id: "51111111-1111-4111-8111-111111111111",
        internal_cost_cents: 5000,
        public_price_cents: 8000,
        reason: "Prezzo concordato telefonicamente"
      })
    );

    expect(res.status).toBe(200);
    expect(servicesUpdatePayloads).toHaveLength(1);
    expect(servicesUpdatePayloads[0].pricing_match_confidence).toBe(100);
    expect(servicesUpdatePayloads[0].pricing_manual_override).toBe(true);
    expect("pricing_confidence" in servicesUpdatePayloads[0]).toBe(false);
  });
});
