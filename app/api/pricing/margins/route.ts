import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const authHeader = request.headers.get("authorization");
    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json({ error: "Configurazione server mancante." }, { status: 500 });
    }
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Sessione non valida." }, { status: 401 });
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const token = authHeader.slice("Bearer ".length);
    const {
      data: { user },
      error: userError
    } = await admin.auth.getUser(token);
    if (userError || !user) {
      return NextResponse.json({ error: "Sessione non valida." }, { status: 401 });
    }

    const { data: membership, error: membershipError } = await admin
      .from("memberships")
      .select("tenant_id, role")
      .eq("user_id", user.id)
      .maybeSingle();
    if (membershipError || !membership?.tenant_id) {
      return NextResponse.json({ error: "Membership non trovata." }, { status: 403 });
    }
    if (!["admin", "operator"].includes(membership.role)) {
      return NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 });
    }

    const daysRaw = Number(request.nextUrl.searchParams.get("days") ?? "30");
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(180, Math.round(daysRaw)) : 30;
    const fromIso = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000).toISOString();

    const { data: pricingRows, error: pricingError } = await admin
      .from("service_pricing")
      .select("service_id, agency_id, route_id, internal_cost_cents, final_price_cents, margin_cents, currency, created_at")
      .eq("tenant_id", membership.tenant_id)
      .gte("created_at", fromIso)
      .order("created_at", { ascending: false })
      .limit(5000);

    if (pricingError) {
      return NextResponse.json({ error: pricingError.message }, { status: 500 });
    }

    const rows = (pricingRows ?? []) as Array<{
      service_id: string;
      agency_id: string | null;
      route_id: string | null;
      internal_cost_cents: number;
      final_price_cents: number;
      margin_cents: number;
      currency: string;
      created_at: string;
    }>;

    const { data: servicesData, error: servicesError } = await admin
      .from("services")
      .select("id, customer_name, billing_party_name, service_type_code, booking_service_kind, applied_pricing_rule_id, final_price_cents, margin_cents, pricing_manual_override, date, time")
      .eq("tenant_id", membership.tenant_id)
      .gte("date", fromIso.slice(0, 10))
      .order("date", { ascending: false })
      .limit(2000);

    if (servicesError) {
      return NextResponse.json({ error: servicesError.message }, { status: 500 });
    }

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
      {
        totalServices: 0,
        totalRevenueCents: 0,
        totalCostCents: 0,
        totalMarginCents: 0
      }
    );

    const byAgencyMap = new Map<string, { label: string; services: number; revenueCents: number; marginCents: number }>();
    const byRouteMap = new Map<string, { label: string; services: number; revenueCents: number; marginCents: number }>();
    for (const item of rows) {
      const agencyLabel = item.agency_id ? agencyById.get(item.agency_id) ?? item.agency_id : "Senza agenzia";
      const agencyKey = item.agency_id ?? "none";
      const agencyRow = byAgencyMap.get(agencyKey) ?? { label: agencyLabel, services: 0, revenueCents: 0, marginCents: 0 };
      agencyRow.services += 1;
      agencyRow.revenueCents += item.final_price_cents;
      agencyRow.marginCents += item.margin_cents;
      byAgencyMap.set(agencyKey, agencyRow);

      const routeLabel = item.route_id ? routeById.get(item.route_id) ?? item.route_id : "Senza tratta";
      const routeKey = item.route_id ?? "none";
      const routeRow = byRouteMap.get(routeKey) ?? { label: routeLabel, services: 0, revenueCents: 0, marginCents: 0 };
      routeRow.services += 1;
      routeRow.revenueCents += item.final_price_cents;
      routeRow.marginCents += item.margin_cents;
      byRouteMap.set(routeKey, routeRow);
    }

    const byAgency = Array.from(byAgencyMap.values()).sort((a, b) => b.marginCents - a.marginCents).slice(0, 20);
    const byRoute = Array.from(byRouteMap.values()).sort((a, b) => b.marginCents - a.marginCents).slice(0, 20);

    const services = (servicesData ?? []) as Array<{
      id: string;
      customer_name: string;
      billing_party_name: string | null;
      service_type_code: string | null;
      booking_service_kind: string | null;
      applied_pricing_rule_id: string | null;
      final_price_cents: number | null;
      margin_cents: number | null;
      pricing_manual_override: boolean | null;
      date: string;
      time: string;
    }>;

    const alerts = {
      withoutPricing: services.filter((item) => !item.applied_pricing_rule_id && (item.final_price_cents ?? 0) === 0).length,
      lowMargin: services.filter((item) => typeof item.margin_cents === "number" && item.margin_cents > 0 && item.margin_cents <= 1000).length,
      negativeMargin: services.filter((item) => typeof item.margin_cents === "number" && item.margin_cents < 0).length,
      manualOverrides: services.filter((item) => item.pricing_manual_override === true).length
    };

    const attentionRows = services
      .filter((item) => !item.applied_pricing_rule_id || (item.margin_cents ?? 0) <= 1000)
      .slice(0, 30)
      .map((item) => ({
        id: item.id,
        customer_name: item.customer_name,
        billing_party_name: item.billing_party_name,
        service_label: item.service_type_code ?? item.booking_service_kind ?? "N/D",
        date: item.date,
        time: item.time,
        margin_cents: item.margin_cents ?? 0,
        has_pricing_rule: Boolean(item.applied_pricing_rule_id),
        manual_override: item.pricing_manual_override === true
      }));

    return NextResponse.json({
      periodDays: days,
      fromIso,
      summary,
      byAgency,
      byRoute,
      alerts,
      attentionRows
    });
  } catch (error) {
    console.error("Pricing margins endpoint error", error);
    return NextResponse.json({ error: "Errore interno server." }, { status: 500 });
  }
}
