import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const [agencies, routes, priceLists, pricingRules] = await Promise.all([
      auth.admin.from("agencies").select("*").eq("tenant_id", auth.membership.tenant_id).order("name"),
      auth.admin.from("routes").select("*").eq("tenant_id", auth.membership.tenant_id).order("name"),
      auth.admin.from("price_lists").select("*").eq("tenant_id", auth.membership.tenant_id).order("valid_from", { ascending: false }),
      auth.admin.from("pricing_rules").select("*").eq("tenant_id", auth.membership.tenant_id).order("priority")
    ]);

    const error = agencies.error ?? routes.error ?? priceLists.error ?? pricingRules.error;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      tenant_id: auth.membership.tenant_id,
      agencies: agencies.data ?? [],
      routes: routes.data ?? [],
      price_lists: priceLists.data ?? [],
      pricing_rules: pricingRules.data ?? []
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Errore interno server." },
      { status: 500 }
    );
  }
}
