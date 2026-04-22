/**
 * GET /api/medmar-ar/simulator
 * Restituisce i dati storici YTD come base per il simulatore previsionale.
 * Il calcolo degli scenari avviene lato client con i parametri slider.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

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
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor", "autista"]);
  if (auth instanceof NextResponse) return auth;
  const { admin, membership } = auth;
  const tenantId = membership.tenant_id;

  const today = new Date().toISOString().slice(0, 10);
  const year = parseInt(today.slice(0, 4));
  const firstOfYear = `${year}-01-01`;
  const currentMonth = today.slice(0, 7); // "2025-04"

  // ── Biglietti YTD ────────────────────────────────────────────────────────────
  const { data: tickets } = await (admin as any)
    .from("medmar_ar_tickets")
    .select("id, travel_date, pax_count, ticket_mode, total_price_cents, unit_price_cents")
    .eq("tenant_id", tenantId)
    .gte("travel_date", firstOfYear)
    .lte("travel_date", today)
    .eq("is_test_data", false);

  const ticketList: any[] = tickets ?? [];
  const ticketIds = ticketList.map((t: any) => t.id);

  let legList: any[] = [];
  if (ticketIds.length > 0) {
    const { data: legs } = await (admin as any)
      .from("medmar_ar_ticket_legs")
      .select("id, ticket_id, leg_type, price_per_pax_cents, status")
      .eq("tenant_id", tenantId)
      .in("ticket_id", ticketIds);
    legList = legs ?? [];
  }

  // ── Prezzi attivi ────────────────────────────────────────────────────────────
  const { data: priceRows } = await (admin as any)
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
  for (const row of priceRows ?? []) {
    (prices as any)[row.price_type] = row.price_cents;
  }

  // ── YTD aggregati ────────────────────────────────────────────────────────────
  let roundTripCount = 0, singleOutCount = 0, singleRetCount = 0;
  let totalPax = 0, totalValue = 0;
  for (const t of ticketList) {
    totalPax += t.pax_count;
    totalValue += t.total_price_cents;
    if (t.ticket_mode === "round_trip") roundTripCount++;
    else if (t.ticket_mode === "single_outbound") singleOutCount++;
    else singleRetCount++;
  }

  // Legs: ritorno usato vs non usato (su A/R)
  let returnLegsTotal = 0, returnLegsUsed = 0;
  let totalLost = 0, totalRecovered = 0;
  const ticketById = new Map(ticketList.map((t: any) => [t.id, t]));

  for (const l of legList) {
    if (l.leg_type === "return") {
      returnLegsTotal++;
      if (l.status === "used" || l.status === "reassigned") returnLegsUsed++;
    }
    const t = ticketById.get(l.ticket_id);
    if (!t) continue;
    if (l.status === "lost") totalLost += l.price_per_pax_cents * t.pax_count;
    if (l.status === "reassigned") totalRecovered += l.price_per_pax_cents * t.pax_count;
  }

  const returnUsageProbability = returnLegsTotal > 0
    ? returnLegsUsed / returnLegsTotal
    : 0.5;

  const lostPlusRecovered = totalLost + totalRecovered;
  const recoveryRate = lostPlusRecovered > 0 ? totalRecovered / lostPlusRecovered : 0;

  // ── Mesi completati e rimanenti ──────────────────────────────────────────────
  // "completato" = mese prima del corrente (il corrente è in corso)
  const monthsWithData = [...new Set(ticketList.map((t: any) => t.travel_date.slice(0, 7)))];
  const completedMonths = monthsWithData.filter((m) => m < currentMonth).length;

  const remainingMonthNames: string[] = [];
  for (let m = 1; m <= 12; m++) {
    const monthStr = `${year}-${String(m).padStart(2, "0")}`;
    if (monthStr > currentMonth) remainingMonthNames.push(monthStr);
  }

  // ── Trend mensile YTD ─────────────────────────────────────────────────────
  const monthMap: Record<string, { tickets: number; pax: number; value: number; lost: number; recovered: number; rt: number }> = {};
  for (const t of ticketList) {
    const m = t.travel_date.slice(0, 7);
    if (!monthMap[m]) monthMap[m] = { tickets: 0, pax: 0, value: 0, lost: 0, recovered: 0, rt: 0 };
    monthMap[m].tickets++;
    monthMap[m].pax += t.pax_count;
    monthMap[m].value += t.total_price_cents;
    if (t.ticket_mode === "round_trip") monthMap[m].rt++;
  }
  for (const l of legList) {
    const t = ticketById.get(l.ticket_id);
    if (!t) continue;
    const m = t.travel_date.slice(0, 7);
    if (!monthMap[m]) continue;
    if (l.status === "lost") monthMap[m].lost += l.price_per_pax_cents * t.pax_count;
    if (l.status === "reassigned") monthMap[m].recovered += l.price_per_pax_cents * t.pax_count;
  }

  const monthly_actuals = Object.entries(monthMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, d]) => ({
      month,
      tickets: d.tickets,
      pax: d.pax,
      value_cents: d.value,
      lost_cents: d.lost,
      recovered_cents: d.recovered,
      round_trip_count: d.rt,
    }));

  const avgMonthlyTickets = completedMonths > 0
    ? monthly_actuals.filter((m) => m.month < currentMonth).reduce((s, m) => s + m.tickets, 0) / completedMonths
    : ticketList.length;

  const avgPaxPerTicket = ticketList.length > 0 ? totalPax / ticketList.length : 2;

  const base: SimulatorBase = {
    year,
    completed_months: completedMonths,
    remaining_months: remainingMonthNames.length,
    remaining_month_names: remainingMonthNames,
    ytd: {
      total_tickets: ticketList.length,
      total_pax: totalPax,
      total_value_cents: totalValue,
      round_trip_count: roundTripCount,
      single_outbound_count: singleOutCount,
      single_return_count: singleRetCount,
      ar_percentage: ticketList.length > 0 ? roundTripCount / ticketList.length : 0.5,
      avg_monthly_tickets: Math.round(avgMonthlyTickets * 10) / 10,
      avg_pax_per_ticket: Math.round(avgPaxPerTicket * 10) / 10,
      return_usage_probability: Math.round(returnUsageProbability * 100) / 100,
      recovery_rate: Math.round(recoveryRate * 100) / 100,
      total_lost_cents: totalLost,
      total_recovered_cents: totalRecovered,
      net_loss_cents: totalLost - totalRecovered,
    },
    monthly_actuals,
    prices,
  };

  return NextResponse.json({ ok: true, ...base });
}
