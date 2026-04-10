import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

const payloadSchema = z.object({
  pax: z.number().int().min(1).max(60),
  rule_kind: z.enum(["fixed", "per_pax"]),
  internal_cost_cents: z.number().int().min(0),
  public_price_cents: z.number().int().min(0),
  agency_price_cents: z.number().int().min(0).nullable().optional()
});

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = payloadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
  }

  const multiplier = parsed.data.rule_kind === "per_pax" ? parsed.data.pax : 1;
  const internalCostCents = parsed.data.internal_cost_cents * multiplier;
  const publicPriceCents = parsed.data.public_price_cents * multiplier;
  const agencyPriceCents = parsed.data.agency_price_cents === null || parsed.data.agency_price_cents === undefined ? null : parsed.data.agency_price_cents * multiplier;
  const finalPriceCents = agencyPriceCents ?? publicPriceCents;
  const marginCents = finalPriceCents - internalCostCents;
  const marginPct = finalPriceCents === 0 ? 0 : (marginCents / finalPriceCents) * 100;

  return NextResponse.json({
    ok: true,
    result: {
      multiplier,
      internal_cost_cents: internalCostCents,
      public_price_cents: publicPriceCents,
      agency_price_cents: agencyPriceCents,
      final_price_cents: finalPriceCents,
      margin_cents: marginCents,
      margin_pct: Number(marginPct.toFixed(2))
    }
  });
}
