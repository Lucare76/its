/**
 * Pure calculation functions for the Medmar A/R simulator.
 * Extracted from the route handler to be independently testable.
 */

export type SimTicket = {
  id: string;
  travel_date: string; // "YYYY-MM-DD"
  pax_count: number;
  ticket_mode: "round_trip" | "single_outbound" | "single_return";
  total_price_cents: number;
  unit_price_cents: number;
};

export type SimLeg = {
  ticket_id: string;
  leg_type: "outbound" | "return";
  price_per_pax_cents: number;
  status: string; // "used" | "available_for_reassignment" | "reassigned" | "lost" | "not_applicable"
};

export type YTDStats = {
  totalTickets: number;
  totalPax: number;
  totalValue: number;
  roundTripCount: number;
  singleOutCount: number;
  singleRetCount: number;
  returnLegsTotal: number;
  returnLegsUsed: number;
  totalLost: number;
  totalRecovered: number;
};

export type MonthActual = {
  month: string; // "YYYY-MM"
  tickets: number;
  pax: number;
  value_cents: number;
  lost_cents: number;
  recovered_cents: number;
  round_trip_count: number;
};

/**
 * Aggregates YTD totals from ticket and leg arrays.
 */
export function aggregateYTD(tickets: SimTicket[], legs: SimLeg[]): YTDStats {
  const ticketById = new Map(tickets.map((t) => [t.id, t]));
  let roundTripCount = 0, singleOutCount = 0, singleRetCount = 0;
  let totalPax = 0, totalValue = 0;

  for (const t of tickets) {
    totalPax += t.pax_count;
    totalValue += t.total_price_cents;
    if (t.ticket_mode === "round_trip") roundTripCount++;
    else if (t.ticket_mode === "single_outbound") singleOutCount++;
    else singleRetCount++;
  }

  let returnLegsTotal = 0, returnLegsUsed = 0;
  let totalLost = 0, totalRecovered = 0;

  for (const l of legs) {
    if (l.leg_type === "return") {
      returnLegsTotal++;
      if (l.status === "used" || l.status === "reassigned") returnLegsUsed++;
    }
    const t = ticketById.get(l.ticket_id);
    if (!t) continue;
    if (l.status === "lost") totalLost += l.price_per_pax_cents * t.pax_count;
    if (l.status === "reassigned") totalRecovered += l.price_per_pax_cents * t.pax_count;
  }

  return {
    totalTickets: tickets.length,
    totalPax,
    totalValue,
    roundTripCount,
    singleOutCount,
    singleRetCount,
    returnLegsTotal,
    returnLegsUsed,
    totalLost,
    totalRecovered,
  };
}

/**
 * Returns the fraction of return legs that were actually used.
 * Defaults to 0.5 (neutral) when no historical data exists.
 */
export function computeReturnUsageProbability(
  returnLegsUsed: number,
  returnLegsTotal: number,
): number {
  return returnLegsTotal > 0 ? returnLegsUsed / returnLegsTotal : 0.5;
}

/**
 * Returns the fraction of lost legs that were recovered via reassignment.
 * Defaults to 0 when no lost/recovered data exists.
 */
export function computeRecoveryRate(totalRecovered: number, totalLost: number): number {
  const sum = totalLost + totalRecovered;
  return sum > 0 ? totalRecovered / sum : 0;
}

/**
 * Builds a sorted array of monthly aggregates from tickets and legs.
 */
export function buildMonthlyActuals(tickets: SimTicket[], legs: SimLeg[]): MonthActual[] {
  const ticketById = new Map(tickets.map((t) => [t.id, t]));
  const monthMap: Record<string, {
    tickets: number; pax: number; value: number;
    lost: number; recovered: number; rt: number;
  }> = {};

  for (const t of tickets) {
    const m = t.travel_date.slice(0, 7);
    if (!monthMap[m]) monthMap[m] = { tickets: 0, pax: 0, value: 0, lost: 0, recovered: 0, rt: 0 };
    monthMap[m].tickets++;
    monthMap[m].pax += t.pax_count;
    monthMap[m].value += t.total_price_cents;
    if (t.ticket_mode === "round_trip") monthMap[m].rt++;
  }

  for (const l of legs) {
    const t = ticketById.get(l.ticket_id);
    if (!t) continue;
    const m = t.travel_date.slice(0, 7);
    if (!monthMap[m]) continue;
    if (l.status === "lost") monthMap[m].lost += l.price_per_pax_cents * t.pax_count;
    if (l.status === "reassigned") monthMap[m].recovered += l.price_per_pax_cents * t.pax_count;
  }

  return Object.entries(monthMap)
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
}

/**
 * Computes the average monthly ticket count over completed months.
 * Falls back to total ticket count when no completed month exists.
 */
export function computeAvgMonthlyTickets(
  monthlyActuals: MonthActual[],
  currentMonth: string, // "YYYY-MM"
  totalTickets: number,
): number {
  const completed = monthlyActuals.filter((m) => m.month < currentMonth);
  if (completed.length === 0) return totalTickets;
  return completed.reduce((s, m) => s + m.tickets, 0) / completed.length;
}

/**
 * Classifies a return-usage probability into a traffic-light signal.
 * Requires at least minSampleSize data points; defaults to "medium" otherwise.
 */
export function classifyReturnProbability(
  probability: number,
  sampleSize: number,
  minSampleSize = 3,
): "high" | "medium" | "low" {
  if (sampleSize < minSampleSize) return "medium";
  return probability > 0.7 ? "high" : probability >= 0.4 ? "medium" : "low";
}
