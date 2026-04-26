/**
 * GET /api/medmar-ar/insights
 * Leve strategiche avanzate: raccomandazioni prioritizzate basate sui dati storici YTD.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { ROUTE_LABELS, type MedmarRoute } from "@/lib/medmar-ar/types";
import { type SupabaseClient } from "@supabase/supabase-js";

type InsightTicketRow = {
  id: string;
  travel_date: string;
  route: string;
  pax_count: number;
  ticket_mode: "round_trip" | "single_outbound" | "single_return";
  total_price_cents: number;
  unit_price_cents: number;
  issuing_operator_id: string | null;
  created_at: string | null;
  outbound_time: string | null;
};

type InsightLegRow = {
  id: string;
  ticket_id: string;
  leg_type: "outbound" | "return";
  price_per_pax_cents: number;
  status: string;
  created_at: string | null;
};

export const runtime = "nodejs";

export type InsightPriority = "high" | "medium" | "low";
export type InsightType =
  | "mix_optimization"
  | "route_focus"
  | "operator_training"
  | "timing_window"
  | "grouping_opportunity"
  | "pricing_review"
  | "recovery_gap";

export interface StrategicInsight {
  id: string;
  type: InsightType;
  priority: InsightPriority;
  title: string;
  description: string;
  action: string;
  impact_cents: number;        // risparmio/recupero stimato annualizzato
  data: Record<string, unknown>; // dati specifici per l'insight
}

export interface InsightsResponse {
  ok: boolean;
  generated_at: string;
  insights: StrategicInsight[];
  summary: {
    total_potential_savings_cents: number;
    high_priority_count: number;
    breakeven_probability: number;  // soglia per cui AR conviene
    current_probability: number;
  };
}

export async function GET(request: NextRequest) {
  try {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor", "autista"]);
  if (auth instanceof NextResponse) return auth;
  const admin = auth.admin as SupabaseClient;
  const { membership } = auth;
  const tenantId = membership.tenant_id;

  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const firstOfYear = `${year}-01-01`;
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // ── Dati YTD ─────────────────────────────────────────────────────────────────
  const { data: tickets } = await admin
    .from("medmar_ar_tickets")
    .select("id, travel_date, route, pax_count, ticket_mode, total_price_cents, unit_price_cents, issuing_operator_id, created_at, outbound_time")
    .eq("tenant_id", tenantId)
    .gte("travel_date", firstOfYear)
    .lte("travel_date", today)
    .eq("is_test_data", false);

  const ticketList = (tickets ?? []) as InsightTicketRow[];
  if (ticketList.length === 0) {
    return NextResponse.json({
      ok: true,
      generated_at: new Date().toISOString(),
      insights: [],
      summary: { total_potential_savings_cents: 0, high_priority_count: 0, breakeven_probability: 0.34, current_probability: 0.5 },
    } satisfies InsightsResponse);
  }

  const ticketIds = ticketList.map((t) => t.id);
  const { data: legs } = await admin
    .from("medmar_ar_ticket_legs")
    .select("id, ticket_id, leg_type, price_per_pax_cents, status, created_at")
    .eq("tenant_id", tenantId)
    .in("ticket_id", ticketIds);
  const legList = (legs ?? []) as InsightLegRow[];

  // ── Prezzi attivi ─────────────────────────────────────────────────────────────
  const { data: priceRows } = await admin
    .from("medmar_ar_prices")
    .select("price_type, price_cents")
    .eq("tenant_id", tenantId)
    .lte("valid_from", today)
    .or(`valid_to.is.null,valid_to.gte.${today}`);

  const prices = { round_trip_per_leg: 1025, single_trip_under_12: 1370, single_trip_12_or_more: 1025 };
  for (const row of (priceRows ?? []) as Array<{ price_type: string; price_cents: number }>) {
    (prices as Record<string, number>)[row.price_type] = row.price_cents;
  }

  // ── Operatori ─────────────────────────────────────────────────────────────────
  const operatorIds = [...new Set(ticketList.map((t) => t.issuing_operator_id).filter(Boolean))] as string[];
  let operatorNames: Record<string, string> = {};
  if (operatorIds.length > 0) {
    const { data: members } = await admin
      .from("memberships")
      .select("user_id, full_name")
      .eq("tenant_id", tenantId)
      .in("user_id", operatorIds);
    for (const m of (members ?? []) as Array<{ user_id: string; full_name: string | null }>) {
      operatorNames[m.user_id] = m.full_name ?? m.user_id;
    }
  }

  // ── Aggregati base ────────────────────────────────────────────────────────────
  const ticketById = new Map(ticketList.map((t) => [t.id, t]));

  let totalLost = 0, totalRecovered = 0;
  let returnLegsTotal = 0, returnLegsUsed = 0;
  const routeStats: Record<string, { tickets: number; pax: number; value: number; lost: number; arCount: number; returnLegs: number; returnUsed: number }> = {};
  const opStats: Record<string, { tickets: number; arCount: number; lost: number; returnLegs: number; returnUsed: number }> = {};
  const monthlyArCounts: Record<string, number> = {};
  const monthlyTickets: Record<string, number> = {};

  for (const t of ticketList) {
    const r = t.route as string;
    if (!routeStats[r]) routeStats[r] = { tickets: 0, pax: 0, value: 0, lost: 0, arCount: 0, returnLegs: 0, returnUsed: 0 };
    routeStats[r].tickets++;
    routeStats[r].pax += t.pax_count;
    routeStats[r].value += t.total_price_cents;
    if (t.ticket_mode === "round_trip") routeStats[r].arCount++;

    const oid = t.issuing_operator_id ?? "unknown";
    if (!opStats[oid]) opStats[oid] = { tickets: 0, arCount: 0, lost: 0, returnLegs: 0, returnUsed: 0 };
    opStats[oid].tickets++;
    if (t.ticket_mode === "round_trip") opStats[oid].arCount++;

    const m = t.travel_date.slice(0, 7);
    monthlyTickets[m] = (monthlyTickets[m] ?? 0) + 1;
    if (t.ticket_mode === "round_trip") monthlyArCounts[m] = (monthlyArCounts[m] ?? 0) + 1;
  }

  for (const l of legList) {
    const t = ticketById.get(l.ticket_id);
    if (!t) continue;
    const r = t.route as string;
    const oid = t.issuing_operator_id ?? "unknown";

    if (l.leg_type === "return") {
      returnLegsTotal++;
      if (l.status === "used" || l.status === "reassigned") {
        returnLegsUsed++;
        routeStats[r] && routeStats[r].returnUsed++;
        opStats[oid] && opStats[oid].returnUsed++;
      }
      routeStats[r] && routeStats[r].returnLegs++;
      opStats[oid] && opStats[oid].returnLegs++;
    }
    if (l.status === "lost") {
      const lost = l.price_per_pax_cents * t.pax_count;
      totalLost += lost;
      routeStats[r] && (routeStats[r].lost += lost);
      opStats[oid] && (opStats[oid].lost += lost);
    }
    if (l.status === "reassigned") totalRecovered += l.price_per_pax_cents * t.pax_count;
  }

  const globalReturnProb = returnLegsTotal > 0 ? returnLegsUsed / returnLegsTotal : 0.5;

  // Break-even probability: arLeg + arLeg*p = single → p = (single - arLeg)/arLeg
  const breakEvenProb = (prices.single_trip_under_12 - prices.round_trip_per_leg) / prices.round_trip_per_leg;
  const arCount = ticketList.filter((t) => t.ticket_mode === "round_trip").length;
  const arPct = ticketList.length > 0 ? arCount / ticketList.length : 0;

  const insights: StrategicInsight[] = [];

  // ── INSIGHT 1: Mix A/R ottimale ────────────────────────────────────────────
  if (globalReturnProb < breakEvenProb - 0.05 && arPct > 0.3) {
    const excessArTickets = Math.round((arPct - 0.2) * ticketList.length);
    const lossPerExcessTicket = Math.round((prices.single_trip_under_12 - prices.round_trip_per_leg * (1 + globalReturnProb)) * 2);
    const estimatedSavings = Math.max(0, excessArTickets * lossPerExcessTicket);
    insights.push({
      id: "mix_01",
      type: "mix_optimization",
      priority: "high",
      title: "Ridurre la quota di biglietti A/R",
      description: `La probabilità storica di utilizzo del ritorno è ${Math.round(globalReturnProb * 100)}%, sotto il break-even del ${Math.round(breakEvenProb * 100)}%. Con il ${Math.round(arPct * 100)}% di A/R emessi, stai accumulando perdite sistematiche sulla tratta di ritorno.`,
      action: `Ridurre la quota A/R al ~20% dei biglietti emessi (attuale: ${Math.round(arPct * 100)}%). Favorire "Solo Andata" quando la probabilità di ritorno è incerta.`,
      impact_cents: estimatedSavings,
      data: { current_ar_pct: arPct, breakeven_prob: breakEvenProb, current_prob: globalReturnProb },
    });
  } else if (globalReturnProb > breakEvenProb + 0.1 && arPct < 0.5) {
    const potentialArTickets = Math.round((0.6 - arPct) * ticketList.length);
    const savingPerTicket = Math.round(prices.single_trip_under_12 - prices.round_trip_per_leg * (1 + globalReturnProb));
    const estimatedSavings = Math.max(0, potentialArTickets * Math.abs(savingPerTicket));
    insights.push({
      id: "mix_02",
      type: "mix_optimization",
      priority: "medium",
      title: "Aumentare la quota di biglietti A/R",
      description: `La probabilità storica di utilizzo del ritorno è ${Math.round(globalReturnProb * 100)}%, sopra il break-even del ${Math.round(breakEvenProb * 100)}%. L'A/R è conveniente ma viene emesso solo nel ${Math.round(arPct * 100)}% dei casi.`,
      action: `Aumentare la quota A/R al ~60% dei biglietti emessi (attuale: ${Math.round(arPct * 100)}%). Proporre sistematicamente l'A/R quando la data di ritorno è nota.`,
      impact_cents: estimatedSavings,
      data: { current_ar_pct: arPct, breakeven_prob: breakEvenProb, current_prob: globalReturnProb },
    });
  }

  // ── INSIGHT 2: Tratte con alto tasso di perdita ───────────────────────────
  const routesSortedByLoss = Object.entries(routeStats)
    .filter(([, d]) => d.tickets >= 3 && d.lost > 0)
    .sort(([, a], [, b]) => (b.lost / b.value) - (a.lost / a.value));

  if (routesSortedByLoss.length > 0) {
    const [worstRoute, worstData] = routesSortedByLoss[0];
    const lossPct = worstData.value > 0 ? Math.round((worstData.lost / worstData.value) * 100) : 0;
    if (lossPct > 10) {
      insights.push({
        id: "route_01",
        type: "route_focus",
        priority: lossPct > 20 ? "high" : "medium",
        title: `Tratta critica: ${ROUTE_LABELS[worstRoute as MedmarRoute] ?? worstRoute}`,
        description: `Questa tratta registra il ${lossPct}% del valore emesso come perdita (${Math.round(worstData.lost / 100)} € persi su ${Math.round(worstData.value / 100)} € emessi). Probabilità ritorno: ${worstData.returnLegs > 0 ? Math.round((worstData.returnUsed / worstData.returnLegs) * 100) : "N/A"}%.`,
        action: `Valutare se emettere solo biglietti singoli su questa tratta o rafforzare il matching con prenotazioni esistenti prima dell'emissione.`,
        impact_cents: worstData.lost,
        data: { route: worstRoute, loss_pct: lossPct, lost_cents: worstData.lost, tickets: worstData.tickets },
      });
    }
  }

  // ── INSIGHT 3: Operatori con alto tasso A/R + bassa prob. ritorno ──────────
  const opEntries = Object.entries(opStats)
    .filter(([, d]) => d.tickets >= 5 && d.arCount >= 3);

  const opWithHighLoss = opEntries
    .map(([oid, d]) => ({
      oid,
      name: operatorNames[oid] ?? oid,
      arPct: d.arCount / d.tickets,
      returnProb: d.returnLegs > 0 ? d.returnUsed / d.returnLegs : 0.5,
      lostCents: d.lost,
    }))
    .filter((op) => op.arPct > 0.5 && op.returnProb < breakEvenProb)
    .sort((a, b) => b.lostCents - a.lostCents);

  if (opWithHighLoss.length > 0) {
    const top = opWithHighLoss[0];
    insights.push({
      id: "op_01",
      type: "operator_training",
      priority: "medium",
      title: `Formazione operatore: ${top.name}`,
      description: `${top.name} emette il ${Math.round(top.arPct * 100)}% dei biglietti come A/R con probabilità ritorno del ${Math.round(top.returnProb * 100)}% (break-even: ${Math.round(breakEvenProb * 100)}%). Ha generato ${Math.round(top.lostCents / 100)} € di perdite.`,
      action: `Condividere con ${top.name} il decision helper economico e impostare un alert se la probabilità stimata di ritorno è sotto il ${Math.round(breakEvenProb * 100)}%.`,
      impact_cents: top.lostCents,
      data: { operator_id: top.oid, operator_name: top.name, ar_pct: top.arPct, return_prob: top.returnProb },
    });
  }

  // ── INSIGHT 4: Recovery gap (legs perse senza tentativo di recupero) ───────
  const lostLegs = legList.filter((l) => l.status === "lost").length;
  const recoveredLegs = legList.filter((l) => l.status === "reassigned").length;
  const totalArLegs = legList.filter((l) => l.leg_type === "return").length;
  const recoveryRate = lostLegs + recoveredLegs > 0 ? recoveredLegs / (lostLegs + recoveredLegs) : 0;

  if (lostLegs > 5 && recoveryRate < 0.3) {
    const potentialRecovery = Math.round(totalLost * 0.4);
    insights.push({
      id: "recovery_01",
      type: "recovery_gap",
      priority: "high",
      title: "Gap nel processo di recupero tratte",
      description: `Solo il ${Math.round(recoveryRate * 100)}% delle tratte disponibili per riassegnazione viene effettivamente recuperato. ${lostLegs} tratte risultano perse definitivamente per ${Math.round(totalLost / 100)} €.`,
      action: `Attivare il controllo quotidiano del tab "Recupero" e assegnare un operatore responsabile del matching. Ogni giorno con tratte in scadenza senza match è valore perso.`,
      impact_cents: potentialRecovery,
      data: { lost_legs: lostLegs, recovered_legs: recoveredLegs, recovery_rate: recoveryRate, total_lost_cents: totalLost },
    });
  }

  // ── INSIGHT 5: Finestra temporale ottimale ─────────────────────────────────
  // Analizza biglietti emessi con >7gg di anticipo vs ≤7gg
  const recentTickets = ticketList.filter((t) => {
    const daysAhead = (new Date(t.travel_date).getTime() - new Date(t.created_at ?? t.travel_date).getTime()) / (1000 * 60 * 60 * 24);
    return daysAhead <= 7 && t.ticket_mode === "round_trip";
  });
  const earlyTickets = ticketList.filter((t) => {
    const daysAhead = (new Date(t.travel_date).getTime() - new Date(t.created_at ?? t.travel_date).getTime()) / (1000 * 60 * 60 * 24);
    return daysAhead > 7 && t.ticket_mode === "round_trip";
  });

  if (earlyTickets.length >= 3 && earlyTickets.length > recentTickets.length * 0.5) {
    const earlyIds = new Set(earlyTickets.map((t) => t.id));
    const earlyReturnLegs = legList.filter((l) => earlyIds.has(l.ticket_id) && l.leg_type === "return");
    const earlyReturnUsed = earlyReturnLegs.filter((l) => l.status === "used" || l.status === "reassigned").length;
    const earlyReturnProb = earlyReturnLegs.length > 0 ? earlyReturnUsed / earlyReturnLegs.length : 0.5;

    if (earlyReturnProb < globalReturnProb - 0.1) {
      const lossFromEarly = earlyReturnLegs
        .filter((l) => l.status === "lost")
        .reduce((s, l) => {
          const t = ticketById.get(l.ticket_id);
          return s + l.price_per_pax_cents * (t?.pax_count ?? 1);
        }, 0);
      insights.push({
        id: "timing_01",
        type: "timing_window",
        priority: "medium",
        title: "Emissione anticipata aumenta il rischio A/R",
        description: `I biglietti A/R emessi con >7 giorni di anticipo hanno una probabilità ritorno del ${Math.round(earlyReturnProb * 100)}%, contro il ${Math.round(globalReturnProb * 100)}% medio globale. ${earlyTickets.length} biglietti in questa categoria, con ${Math.round(lossFromEarly / 100)} € di perdite.`,
        action: `Preferire l'emissione A/R entro 7 giorni dal viaggio quando possibile. Se l'emissione anticipata è obbligatoria, considerare il biglietto singolo e riemettere il ritorno separatamente.`,
        impact_cents: lossFromEarly,
        data: { early_tickets: earlyTickets.length, early_return_prob: earlyReturnProb, global_return_prob: globalReturnProb },
      });
    }
  }

  // ── INSIGHT 6: Opportunità di raggruppamento non sfruttate ─────────────────
  const smallArTickets = ticketList.filter((t) => t.ticket_mode === "round_trip" && t.pax_count < 12);
  const sameRouteDateGroups: Record<string, number> = {};
  for (const t of smallArTickets) {
    const key = `${t.travel_date}|${t.route}|${t.outbound_time ?? ""}`;
    sameRouteDateGroups[key] = (sameRouteDateGroups[key] ?? 0) + t.pax_count;
  }
  const missedGroupings = Object.entries(sameRouteDateGroups).filter(([, pax]) => pax >= 12);

  if (missedGroupings.length > 0) {
    const potentialSaving = missedGroupings.reduce((s, [, pax]) => {
      return s + (prices.single_trip_under_12 - prices.single_trip_12_or_more) * pax;
    }, 0);
    insights.push({
      id: "group_01",
      type: "grouping_opportunity",
      priority: "medium",
      title: `${missedGroupings.length} occasion${missedGroupings.length === 1 ? "e" : "i"} di raggruppamento non sfruttate`,
      description: `In ${missedGroupings.length} combinazioni data/tratta i pax totali raggiungevano o superavano 12 ma sono stati emessi biglietti A/R individuali invece di attendere il raggruppamento per la tariffa scontata.`,
      action: `Usare il tab "Gruppi in attesa" per aggregare pax sulle stesse date/tratte. Con ≥12 pax la tariffa scende a ${(prices.single_trip_12_or_more / 100).toFixed(2)} € vs ${(prices.single_trip_under_12 / 100).toFixed(2)} € per singola.`,
      impact_cents: Math.max(0, Math.round(potentialSaving)),
      data: { missed_groupings: missedGroupings.length, combined_pax: Object.values(sameRouteDateGroups).reduce((s, v) => s + v, 0) },
    });
  }

  // ── Ordina per priorità + impatto ──────────────────────────────────────────
  const priorityOrder: Record<InsightPriority, number> = { high: 0, medium: 1, low: 2 };
  insights.sort((a, b) => {
    const pd = priorityOrder[a.priority] - priorityOrder[b.priority];
    return pd !== 0 ? pd : b.impact_cents - a.impact_cents;
  });

  const totalSavings = insights.reduce((s, i) => s + i.impact_cents, 0);

  return NextResponse.json({
    ok: true,
    generated_at: new Date().toISOString(),
    insights,
    summary: {
      total_potential_savings_cents: totalSavings,
      high_priority_count: insights.filter((i) => i.priority === "high").length,
      breakeven_probability: Math.round(breakEvenProb * 100) / 100,
      current_probability: Math.round(globalReturnProb * 100) / 100,
    },
  } satisfies InsightsResponse);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}
