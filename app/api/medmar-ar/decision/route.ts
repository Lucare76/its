/**
 * GET /api/medmar-ar/decision?route=X&pax=N&date=YYYY-MM-DD&outbound_time=HH:MM
 * Calcola scenari Decision Helper con probabilità storica dal DB
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import {
  type MedmarRoute,
} from "@/lib/medmar-ar/types";
import { buildDecisionHelperSnapshot } from "@/lib/medmar-ar/decision-helper";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor", "autista"]);
  if (auth instanceof NextResponse) return auth;
  const { admin, membership } = auth;
  const tenantId = membership.tenant_id;

  const url = new URL(request.url);
  const route = url.searchParams.get("route") as MedmarRoute | null;
  const paxParam = url.searchParams.get("pax");
  const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
  const outboundTime = url.searchParams.get("outbound_time");

  if (!route || !paxParam) {
    return NextResponse.json({ ok: false, error: "Parametri route e pax obbligatori." }, { status: 400 });
  }
  const pax = parseInt(paxParam, 10);
  if (isNaN(pax) || pax < 1) {
    return NextResponse.json({ ok: false, error: "Numero pax non valido." }, { status: 400 });
  }

  // 1. Recupera prezzi attivi
  const { data: priceRows } = await admin
    .from("medmar_ar_prices")
    .select("price_type, price_cents")
    .eq("tenant_id", tenantId)
    .lte("valid_from", date)
    .or(`valid_to.is.null,valid_to.gte.${date}`)
    .order("valid_from", { ascending: false });

  // 2. Calcola probabilità storica utilizzo ritorno (ultimi 90 gg, stessa tratta + orario)
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Join con ticket per filtrare route e data
  const { data: returnLegs } = await admin
    .from("medmar_ar_ticket_legs")
    .select("status, ticket_id, medmar_ar_tickets!inner(route, travel_date, outbound_time)")
    .eq("tenant_id", tenantId)
    .eq("leg_type", "return")
    .neq("status", "not_applicable")
    .gte("medmar_ar_tickets.travel_date", ninetyDaysAgo)
    .eq("medmar_ar_tickets.route", route);

  // 3. Verifica se ci sono pending groups compatibili con cui raggruppare
  const { data: pendingGroups } = await admin
    .from("medmar_ar_pending_groups")
    .select("id, current_pax_count, target_threshold, outbound_time")
    .eq("tenant_id", tenantId)
    .eq("travel_date", date)
    .eq("route", route)
    .eq("status", "pending");
  const snapshot = buildDecisionHelperSnapshot({
    pax,
    route,
    outboundTime,
    priceRows: (priceRows ?? []) as Array<{ price_type: string; price_cents: number }>,
    historicalReturnLegs: (returnLegs ?? []) as Array<{ status: string; medmar_ar_tickets?: { outbound_time?: string | null } | Array<{ outbound_time?: string | null }> | null }>,
    pendingGroups: (pendingGroups ?? []) as Array<{ id: string; current_pax_count: number; target_threshold: number; outbound_time: string | null }>,
  });

  return NextResponse.json({
    ok: true,
    pax,
    route,
    date,
    outbound_time: outboundTime,
    prices: snapshot.prices,
    return_usage_probability: snapshot.returnUsageProbability,
    historical_sample_size: snapshot.historicalSampleSize,
    can_group: snapshot.canGroup,
    group_target_pax: snapshot.groupTargetPax,
    scenarios: snapshot.scenarios,
    time_signals: snapshot.timeSignals,
    pending_groups: pendingGroups ?? [],
  });
}
