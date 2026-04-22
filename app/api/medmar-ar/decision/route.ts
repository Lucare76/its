/**
 * GET /api/medmar-ar/decision?route=X&pax=N&date=YYYY-MM-DD&outbound_time=HH:MM
 * Calcola scenari Decision Helper con probabilità storica dal DB
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import {
  buildDecisionScenarios,
  DEFAULT_PRICES_CENTS,
  type MedmarRoute,
  type PriceType,
} from "@/lib/medmar-ar/types";

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

  const prices: Record<PriceType, number> = { ...DEFAULT_PRICES_CENTS };
  const seen = new Set<string>();
  for (const row of priceRows ?? []) {
    if (!seen.has(row.price_type)) {
      prices[row.price_type as PriceType] = row.price_cents;
      seen.add(row.price_type);
    }
  }

  // 2. Calcola probabilità storica utilizzo ritorno (ultimi 90 gg, stessa tratta + orario)
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let returnUsageProbability = 0.5; // default neutro
  let historicalSampleSize = 0;

  const legQuery = admin
    .from("medmar_ar_ticket_legs")
    .select("status, leg_time")
    .eq("tenant_id", tenantId)
    .eq("leg_type", "return")
    .neq("status", "not_applicable");

  // Join con ticket per filtrare route e data
  const { data: returnLegs } = await admin
    .from("medmar_ar_ticket_legs")
    .select("status, ticket_id, medmar_ar_tickets!inner(route, travel_date, outbound_time)")
    .eq("tenant_id", tenantId)
    .eq("leg_type", "return")
    .neq("status", "not_applicable")
    .gte("medmar_ar_tickets.travel_date", ninetyDaysAgo)
    .eq("medmar_ar_tickets.route", route);

  void legQuery; // usato solo per tipo

  if (returnLegs && returnLegs.length > 0) {
    historicalSampleSize = returnLegs.length;
    const usedCount = returnLegs.filter((l) => l.status === "used" || l.status === "reassigned").length;
    returnUsageProbability = usedCount / historicalSampleSize;
  }

  // 3. Verifica se ci sono pending groups compatibili con cui raggruppare
  const { data: pendingGroups } = await admin
    .from("medmar_ar_pending_groups")
    .select("id, current_pax_count, target_threshold, outbound_time")
    .eq("tenant_id", tenantId)
    .eq("travel_date", date)
    .eq("route", route)
    .eq("status", "pending");

  const existingPendingPax = (pendingGroups ?? []).reduce(
    (sum, g) => sum + g.current_pax_count, 0
  );
  const totalWithGroup = pax + existingPendingPax;
  const canGroup = pax >= 8 && pax < 12 && totalWithGroup < 12;
  const groupTargetPax = 12;

  // 4. Costruisci scenari
  const scenarios = buildDecisionScenarios(
    pax,
    prices,
    returnUsageProbability,
    canGroup,
    groupTargetPax
  );

  // 5. Semafori probabilità per ogni orario disponibile
  const allTimes = (await import("@/lib/medmar-ar/types")).MEDMAR_TIMES_BY_ROUTE[route] ?? [];
  const timeSignals: Array<{ time: string; probability: number; signal: "high" | "medium" | "low" }> = [];

  for (const t of allTimes) {
    const { data: tLegs } = await admin
      .from("medmar_ar_ticket_legs")
      .select("status, medmar_ar_tickets!inner(route, travel_date, outbound_time)")
      .eq("tenant_id", tenantId)
      .eq("leg_type", "return")
      .neq("status", "not_applicable")
      .gte("medmar_ar_tickets.travel_date", ninetyDaysAgo)
      .eq("medmar_ar_tickets.route", route)
      .eq("medmar_ar_tickets.outbound_time", t);

    let prob = 0.5;
    if (tLegs && tLegs.length >= 3) {
      prob = tLegs.filter((l) => l.status === "used" || l.status === "reassigned").length / tLegs.length;
    }
    timeSignals.push({
      time: t,
      probability: prob,
      signal: prob > 0.7 ? "high" : prob >= 0.4 ? "medium" : "low",
    });
  }

  return NextResponse.json({
    ok: true,
    pax,
    route,
    date,
    outbound_time: outboundTime,
    prices,
    return_usage_probability: returnUsageProbability,
    historical_sample_size: historicalSampleSize,
    can_group: canGroup,
    group_target_pax: groupTargetPax,
    scenarios,
    time_signals: timeSignals,
    pending_groups: pendingGroups ?? [],
  });
}
