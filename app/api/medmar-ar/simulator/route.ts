/**
 * GET /api/medmar-ar/simulator
 * Restituisce i dati storici YTD come base per il simulatore previsionale.
 * Il calcolo degli scenari avviene lato client con i parametri slider.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { type SupabaseClient } from "@supabase/supabase-js";
import {
  aggregateYTD,
  computeReturnUsageProbability,
  computeRecoveryRate,
  buildMonthlyActuals,
  computeAvgMonthlyTickets,
  type SimTicket,
  type SimLeg,
} from "@/lib/medmar-ar/simulator-calc";

export const runtime = "nodejs";

export interface SimulatorBase {
  year: number;
  completed_months: number;
  remaining_months: number;
  remaining_month_names: string[];   // ["2025-05", "2025-06", ...]

  ytd: {
    total_tickets: number;
    total_pax: number;
    total_value_cents: number;
    round_trip_count: number;
    single_outbound_count: number;
    single_return_count: number;
    ar_percentage: number;            // 0–1
    avg_monthly_tickets: number;
    avg_pax_per_ticket: number;
    return_usage_probability: number; // storico: ritorni usati / ritorni totali emessi
    recovery_rate: number;            // legs riassegnate / legs perse+riassegnate
    total_lost_cents: number;
    total_recovered_cents: number;
    net_loss_cents: number;
  };

  monthly_actuals: Array<{
    month: string;
    tickets: number;
    pax: number;
    value_cents: number;
    lost_cents: number;
    recovered_cents: number;
    round_trip_count: number;
  }>;

  prices: {
    round_trip_per_leg: number;
    single_trip_under_12: number;
    single_trip_12_or_more: number;
  };
}

export async function GET(request: NextRequest) {
  try {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor", "autista"]);
  if (auth instanceof NextResponse) return auth;
  const admin = auth.admin as SupabaseClient;
  const tenantId = auth.membership.tenant_id;

  const today = new Date().toISOString().slice(0, 10);
  const year = parseInt(today.slice(0, 4));
  const firstOfYear = `${year}-01-01`;
  const currentMonth = today.slice(0, 7); // "2025-04"

  // ── Biglietti YTD ────────────────────────────────────────────────────────────
  const { data: tickets } = await admin
    .from("medmar_ar_tickets")
    .select("id, travel_date, pax_count, ticket_mode, total_price_cents, unit_price_cents")
    .eq("tenant_id", tenantId)
    .gte("travel_date", firstOfYear)
    .lte("travel_date", today)
    .eq("is_test_data", false);

  const ticketList = (tickets ?? []) as SimTicket[];
  const ticketIds = ticketList.map((t) => t.id);

  let legList: SimLeg[] = [];
  if (ticketIds.length > 0) {
    const { data: legs } = await admin
      .from("medmar_ar_ticket_legs")
      .select("ticket_id, leg_type, price_per_pax_cents, status")
      .eq("tenant_id", tenantId)
      .in("ticket_id", ticketIds);
    legList = (legs ?? []) as SimLeg[];
  }

  // ── Prezzi attivi ────────────────────────────────────────────────────────────
  const { data: priceRows } = await admin
    .from("medmar_ar_prices")
    .select("price_type, price_cents")
    .eq("tenant_id", tenantId)
    .lte("valid_from", today)
    .or(`valid_to.is.null,valid_to.gte.${today}`);

  const prices = {
    round_trip_per_leg: 1025,
    single_trip_under_12: 1370,
    single_trip_12_or_more: 1025,
  };
  for (const row of (priceRows ?? []) as Array<{ price_type: string; price_cents: number }>) {
    if (row.price_type in prices) {
      (prices as Record<string, number>)[row.price_type] = row.price_cents;
    }
  }

  // ── Aggregati YTD ──────────────────────────────────────────────────────────
  const ytdStats = aggregateYTD(ticketList, legList);
  const returnUsageProbability = computeReturnUsageProbability(
    ytdStats.returnLegsUsed,
    ytdStats.returnLegsTotal,
  );
  const recoveryRate = computeRecoveryRate(ytdStats.totalRecovered, ytdStats.totalLost);

  // ── Mesi completati e rimanenti ──────────────────────────────────────────────
  const monthly_actuals = buildMonthlyActuals(ticketList, legList);
  const completedMonths = monthly_actuals.filter((m) => m.month < currentMonth).length;

  const remainingMonthNames: string[] = [];
  for (let m = 1; m <= 12; m++) {
    const monthStr = `${year}-${String(m).padStart(2, "0")}`;
    if (monthStr > currentMonth) remainingMonthNames.push(monthStr);
  }

  const avgMonthlyTickets = computeAvgMonthlyTickets(
    monthly_actuals,
    currentMonth,
    ticketList.length,
  );
  const avgPaxPerTicket = ticketList.length > 0 ? ytdStats.totalPax / ticketList.length : 2;

  const base: SimulatorBase = {
    year,
    completed_months: completedMonths,
    remaining_months: remainingMonthNames.length,
    remaining_month_names: remainingMonthNames,
    ytd: {
      total_tickets: ytdStats.totalTickets,
      total_pax: ytdStats.totalPax,
      total_value_cents: ytdStats.totalValue,
      round_trip_count: ytdStats.roundTripCount,
      single_outbound_count: ytdStats.singleOutCount,
      single_return_count: ytdStats.singleRetCount,
      ar_percentage: ticketList.length > 0 ? ytdStats.roundTripCount / ticketList.length : 0.5,
      avg_monthly_tickets: Math.round(avgMonthlyTickets * 10) / 10,
      avg_pax_per_ticket: Math.round(avgPaxPerTicket * 10) / 10,
      return_usage_probability: Math.round(returnUsageProbability * 100) / 100,
      recovery_rate: Math.round(recoveryRate * 100) / 100,
      total_lost_cents: ytdStats.totalLost,
      total_recovered_cents: ytdStats.totalRecovered,
      net_loss_cents: ytdStats.totalLost - ytdStats.totalRecovered,
    },
    monthly_actuals,
    prices,
  };

  return NextResponse.json({ ok: true, ...base });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}
