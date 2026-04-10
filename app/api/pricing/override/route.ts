import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

type OverrideServiceRow = {
  id: string;
  tenant_id: string;
  agency_id: string | null;
  route_id: string | null;
};

const payloadSchema = z.object({
  service_id: z.string().uuid(),
  internal_cost_cents: z.number().int().min(0),
  public_price_cents: z.number().int().min(0),
  agency_price_cents: z.number().int().min(0).nullable().optional(),
  final_price_cents: z.number().int().min(0).nullable().optional(),
  reason: z.string().min(2).max(500)
});

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const { admin, user, membership } = auth;

    const body = (await request.json().catch(() => null)) as unknown;
    const parsed = payloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
    }

    const { data: serviceData, error: serviceError } = await admin
      .from("services")
      .select("id, tenant_id, agency_id, route_id")
      .eq("id", parsed.data.service_id)
      .eq("tenant_id", membership.tenant_id)
      .maybeSingle();
    const service = (serviceData ?? null) as OverrideServiceRow | null;
    if (serviceError || !service) {
      return NextResponse.json({ error: "Servizio non trovato." }, { status: 404 });
    }

    const internal = parsed.data.internal_cost_cents;
    const publicPrice = parsed.data.public_price_cents;
    const agencyPrice = parsed.data.agency_price_cents ?? null;
    const finalPrice = parsed.data.final_price_cents ?? agencyPrice ?? publicPrice;
    const margin = finalPrice - internal;

    const pricingInsert = {
      tenant_id: membership.tenant_id,
      service_id: service.id,
      agency_id: service.agency_id ?? null,
      route_id: service.route_id ?? null,
      currency: "EUR",
      internal_cost_cents: internal,
      public_price_cents: publicPrice,
      agency_price_cents: agencyPrice,
      final_price_cents: finalPrice,
      apply_mode: "manual",
      confidence: 100,
      manual_override: true,
      manual_override_reason: parsed.data.reason,
      snapshot_json: {
        source: "manual-override-api",
        reason: parsed.data.reason
      },
      created_by_user_id: user.id
    };

    const { data: pricingRow, error: pricingError } = await (admin
      .from("service_pricing") as any)
      .insert(pricingInsert)
      .select("id, service_id, final_price_cents, margin_cents, apply_mode, manual_override")
      .single();
    if (pricingError) {
      return NextResponse.json({ error: pricingError.message }, { status: 500 });
    }

    const { error: updateError } = await (admin
      .from("services") as any)
      .update({
        internal_cost_cents: internal,
        public_price_cents: publicPrice,
        agency_price_cents: agencyPrice,
        final_price_cents: finalPrice,
        margin_cents: margin,
        pricing_apply_mode: "manual",
        pricing_confidence: 100,
        pricing_manual_override: true,
        pricing_manual_override_reason: parsed.data.reason,
        pricing_applied_at: new Date().toISOString()
      })
      .eq("id", service.id)
      .eq("tenant_id", membership.tenant_id);
    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, pricing: pricingRow });
  } catch (error) {
    console.error("Pricing override endpoint error", error);
    return NextResponse.json({ error: "Errore interno server." }, { status: 500 });
  }
}
