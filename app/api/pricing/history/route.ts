import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const { admin, membership } = auth;

    const daysRaw = Number(request.nextUrl.searchParams.get("days") ?? "30");
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(365, Math.round(daysRaw)) : 30;
    const agencyId = request.nextUrl.searchParams.get("agency_id") || null;
    const routeId = request.nextUrl.searchParams.get("route_id") || null;
    const fromIso = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000).toISOString();

    let query = admin
      .from("service_pricing")
      .select("id, created_at, service_id, agency_id, route_id, internal_cost_cents, public_price_cents, agency_price_cents, final_price_cents, margin_cents, apply_mode, confidence, manual_override")
      .eq("tenant_id", membership.tenant_id)
      .gte("created_at", fromIso)
      .order("created_at", { ascending: false })
      .limit(5000);

    if (agencyId) query = query.eq("agency_id", agencyId);
    if (routeId) query = query.eq("route_id", routeId);

    const { data: pricingRows, error: pricingError } = await query;
    if (pricingError) return NextResponse.json({ error: pricingError.message }, { status: 500 });

    const rows = (pricingRows ?? []) as Array<{
      id: string;
      created_at: string;
      service_id: string;
      agency_id: string | null;
      route_id: string | null;
      internal_cost_cents: number;
      public_price_cents: number;
      agency_price_cents: number | null;
      final_price_cents: number;
      margin_cents: number;
      apply_mode: string;
      confidence: number | null;
      manual_override: boolean;
    }>;

    const agencyIds = Array.from(new Set(rows.map((item) => item.agency_id).filter(Boolean))) as string[];
    const routeIds = Array.from(new Set(rows.map((item) => item.route_id).filter(Boolean))) as string[];

    const [{ data: agencies }, { data: routes }] = await Promise.all([
      agencyIds.length ? admin.from("agencies").select("id,name").in("id", agencyIds) : Promise.resolve({ data: [] }),
      routeIds.length ? admin.from("routes").select("id,name").in("id", routeIds) : Promise.resolve({ data: [] })
    ]);

    const agencyById = new Map(((agencies ?? []) as Array<{ id: string; name: string }>).map((item) => [item.id, item.name]));
    const routeById = new Map(((routes ?? []) as Array<{ id: string; name: string }>).map((item) => [item.id, item.name]));

    const summary = rows.reduce(
      (acc, item) => {
        acc.totalServices += 1;
        acc.totalRevenueCents += item.final_price_cents;
        acc.totalCostCents += item.internal_cost_cents;
        acc.totalMarginCents += item.margin_cents;
        return acc;
      },
      { totalServices: 0, totalRevenueCents: 0, totalCostCents: 0, totalMarginCents: 0 }
    );

    return NextResponse.json({
      periodDays: days,
      fromIso,
      summary,
      rows: rows.map((row) => ({
        ...row,
        agency_label: row.agency_id ? agencyById.get(row.agency_id) ?? row.agency_id : "Senza agenzia",
        route_label: row.route_id ? routeById.get(row.route_id) ?? row.route_id : "Senza tratta"
      }))
    });
  } catch (error) {
    console.error("Pricing history endpoint error", error);
    return NextResponse.json({ error: "Errore interno server." }, { status: 500 });
  }
}

