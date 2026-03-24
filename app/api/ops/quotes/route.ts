import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import type { PricingAuthContext } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

const quoteSchema = z.object({
  service_kind: z.string().min(2).max(120),
  route_label: z.string().min(2).max(200),
  price_cents: z.number().int().min(0),
  currency: z.string().length(3).default("EUR"),
  passenger_count: z.number().int().min(1).max(120).nullable(),
  valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  notes: z.string().max(2000).nullable(),
  waypoints: z.array(z.string().min(2).max(120)).max(20)
});

async function loadQuotes(auth: PricingAuthContext) {
  const tenantId = auth.membership.tenant_id;
  const [quotesResult, waypointsResult, flagsResult] = await Promise.all([
    auth.admin.from("quotes").select("*").eq("tenant_id", tenantId).order("created_at", { ascending: false }),
    auth.admin.from("quote_waypoints").select("*").eq("tenant_id", tenantId).order("sort_order"),
    auth.admin.from("tenant_user_feature_flags").select("*").eq("tenant_id", tenantId).eq("feature_code", "quotes_access")
  ]);
  const error = quotesResult.error || waypointsResult.error || flagsResult.error;
  if (error) throw new Error(error.message);
  return {
    quotes: quotesResult.data ?? [],
    waypoints: waypointsResult.data ?? [],
    quote_users: flagsResult.data ?? []
  };
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    return NextResponse.json({ ok: true, ...(await loadQuotes(auth)) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;
    const body = await request.json().catch(() => null);
    const action = String(body?.action ?? "create_quote");

    if (action === "create_quote") {
      const parsed = quoteSchema.parse(body);
      const insertResult = await auth.admin
        .from("quotes")
        .insert({
          tenant_id: tenantId,
          created_by_user_id: auth.user.id,
          owner_label: "owen",
          service_kind: parsed.service_kind,
          route_label: parsed.route_label,
          price_cents: parsed.price_cents,
          currency: parsed.currency.toUpperCase(),
          passenger_count: parsed.passenger_count ?? null,
          valid_until: parsed.valid_until ?? null,
          notes: parsed.notes ?? null
        })
        .select("id")
        .single();
      if (insertResult.error || !insertResult.data?.id) throw new Error(insertResult.error?.message ?? "Preventivo non creato.");
      if (parsed.waypoints.length > 0) {
        const { error: waypointError } = await auth.admin.from("quote_waypoints").insert(
          parsed.waypoints.map((label, index) => ({
            tenant_id: tenantId,
            quote_id: insertResult.data.id,
            label,
            sort_order: index + 1
          }))
        );
        if (waypointError) throw new Error(waypointError.message);
      }
    }

    if (action === "grant_owen_access") {
      const userId = String(body?.user_id ?? "");
      if (auth.membership.role !== "admin") {
        return NextResponse.json({ ok: false, error: "Solo admin puo assegnare Owen." }, { status: 403 });
      }
      const { error } = await auth.admin.from("tenant_user_feature_flags").upsert(
        {
          tenant_id: tenantId,
          user_id: userId,
          feature_code: "quotes_access",
          enabled: true
        },
        { onConflict: "tenant_id,user_id,feature_code" }
      );
      if (error) throw new Error(error.message);
    }

    return NextResponse.json({ ok: true, ...(await loadQuotes(auth)) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
