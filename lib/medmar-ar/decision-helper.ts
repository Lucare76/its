import { buildDecisionScenarios, DEFAULT_PRICES_CENTS, MEDMAR_TIMES_BY_ROUTE, type DecisionScenario, type MedmarRoute, type PriceType } from "@/lib/medmar-ar/types";
import { classifyReturnProbability, computeReturnUsageProbability } from "@/lib/medmar-ar/simulator-calc";

export type MedmarPriceRow = {
  price_type: string;
  price_cents: number;
};

export type HistoricalReturnLegRow = {
  status: string;
  medmar_ar_tickets?: { outbound_time?: string | null } | Array<{ outbound_time?: string | null }> | null;
};

export type PendingGroupRow = {
  id: string;
  current_pax_count: number;
  target_threshold: number;
  outbound_time: string | null;
};

export type TimeSignal = {
  time: string;
  probability: number;
  signal: "high" | "medium" | "low";
};

export type DecisionHelperSnapshot = {
  prices: Record<PriceType, number>;
  returnUsageProbability: number;
  historicalSampleSize: number;
  canGroup: boolean;
  groupTargetPax: number;
  scenarios: DecisionScenario[];
  timeSignals: TimeSignal[];
};

function normalizeJoinedTicket(
  joined: HistoricalReturnLegRow["medmar_ar_tickets"],
): { outbound_time?: string | null } | null {
  if (Array.isArray(joined)) return joined[0] ?? null;
  return joined ?? null;
}

function normalizeTime(value: string | null | undefined) {
  return value ? value.slice(0, 5) : null;
}

function resolvePrices(priceRows: MedmarPriceRow[]): Record<PriceType, number> {
  const prices: Record<PriceType, number> = { ...DEFAULT_PRICES_CENTS };
  const seen = new Set<string>();
  for (const row of priceRows) {
    if (!seen.has(row.price_type)) {
      prices[row.price_type as PriceType] = row.price_cents;
      seen.add(row.price_type);
    }
  }
  return prices;
}

function computeProbabilitySnapshot(rows: HistoricalReturnLegRow[]) {
  const historicalSampleSize = rows.length;
  const usedCount = rows.filter((row) => row.status === "used" || row.status === "reassigned").length;
  return {
    historicalSampleSize,
    returnUsageProbability: computeReturnUsageProbability(usedCount, historicalSampleSize),
  };
}

function buildTimeSignals(route: MedmarRoute, historicalReturnLegs: HistoricalReturnLegRow[]): TimeSignal[] {
  return (MEDMAR_TIMES_BY_ROUTE[route] ?? []).map((time) => {
    const matchingRows = historicalReturnLegs.filter((row) => normalizeTime(normalizeJoinedTicket(row.medmar_ar_tickets)?.outbound_time) === time);
    const usedCount = matchingRows.filter((row) => row.status === "used" || row.status === "reassigned").length;
    const probability = computeReturnUsageProbability(usedCount, matchingRows.length);
    return {
      time,
      probability,
      signal: classifyReturnProbability(probability, matchingRows.length),
    };
  });
}

export function buildDecisionHelperSnapshot(input: {
  pax: number;
  route: MedmarRoute;
  outboundTime?: string | null;
  priceRows: MedmarPriceRow[];
  historicalReturnLegs: HistoricalReturnLegRow[];
  pendingGroups: PendingGroupRow[];
}): DecisionHelperSnapshot {
  const prices = resolvePrices(input.priceRows);
  const normalizedOutboundTime = normalizeTime(input.outboundTime);
  const sameOutboundRows = normalizedOutboundTime
    ? input.historicalReturnLegs.filter((row) => normalizeTime(normalizeJoinedTicket(row.medmar_ar_tickets)?.outbound_time) === normalizedOutboundTime)
    : [];
  const probabilitySource = sameOutboundRows.length > 0 ? sameOutboundRows : input.historicalReturnLegs;
  const { historicalSampleSize, returnUsageProbability } = computeProbabilitySnapshot(probabilitySource);

  const existingPendingPax = input.pendingGroups.reduce((sum, group) => sum + group.current_pax_count, 0);
  const totalWithGroup = input.pax + existingPendingPax;
  const canGroup = input.pax >= 8 && input.pax < 12 && totalWithGroup < 12;
  const groupTargetPax = 12;

  return {
    prices,
    returnUsageProbability,
    historicalSampleSize,
    canGroup,
    groupTargetPax,
    scenarios: buildDecisionScenarios(input.pax, prices, returnUsageProbability, canGroup, groupTargetPax),
    timeSignals: buildTimeSignals(input.route, input.historicalReturnLegs),
  };
}
