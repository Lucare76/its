export type MedmarRoute =
  | "pozzuoli_ischia"
  | "pozzuoli_casamicciola"
  | "napoli_ischia"
  | "napoli_casamicciola"
  | "ischia_pozzuoli"
  | "casamicciola_pozzuoli"
  | "ischia_napoli"
  | "casamicciola_napoli";

export type TicketMode = "round_trip" | "single_outbound" | "single_return";

export type LegStatus =
  | "used"
  | "available_for_reassignment"
  | "reassigned"
  | "lost"
  | "not_applicable";

export type PendingGroupStatus =
  | "pending"
  | "reached_threshold"
  | "expired"
  | "converted_to_ticket";

export type PriceType =
  | "round_trip_per_leg"
  | "single_trip_under_12"
  | "single_trip_12_or_more";

export interface MedmarArPrice {
  id: string;
  tenant_id: string;
  price_type: PriceType;
  price_cents: number;
  valid_from: string;
  valid_to: string | null;
  created_at: string;
}

export interface MedmarArTicket {
  id: string;
  tenant_id: string;
  voucher_number: string;
  travel_date: string;
  route: MedmarRoute;
  pax_count: number;
  ticket_mode: TicketMode;
  outbound_time: string | null;
  return_time: string | null;
  unit_price_cents: number;
  total_price_cents: number;
  issuing_operator_id: string | null;
  notes: string | null;
  created_at: string;
  legs?: MedmarArTicketLeg[];
}

export interface MedmarArTicketLeg {
  id: string;
  tenant_id: string;
  ticket_id: string;
  leg_type: "outbound" | "return";
  leg_time: string | null;
  leg_route: string;
  price_per_pax_cents: number;
  status: LegStatus;
  original_booking_id: string | null;
  reassigned_booking_id: string | null;
  status_changed_at: string | null;
  status_changed_by: string | null;
  created_at: string;
}

export interface MedmarArPendingGroup {
  id: string;
  tenant_id: string;
  travel_date: string;
  route: MedmarRoute;
  outbound_time: string | null;
  current_pax_count: number;
  target_threshold: number;
  booking_ids: string[];
  status: PendingGroupStatus;
  converted_ticket_id: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export const MEDMAR_TIMES_BY_ROUTE: Record<MedmarRoute, string[]> = {
  pozzuoli_ischia: ["07:00", "09:30", "12:30", "15:00", "18:00", "20:30"],
  pozzuoli_casamicciola: ["07:00", "09:30", "12:30", "15:00", "18:00", "20:30"],
  napoli_ischia: ["07:15", "09:45", "13:00", "15:15", "18:15", "20:45"],
  napoli_casamicciola: ["07:15", "09:45", "13:00", "15:15", "18:15", "20:45"],
  ischia_pozzuoli: ["08:10", "11:10", "15:00"],
  casamicciola_pozzuoli: ["06:20", "10:10", "13:35", "16:50"],
  ischia_napoli: ["06:25", "10:35", "17:00"],
  casamicciola_napoli: ["07:10", "09:45", "14:00", "17:40", "20:00"],
};

export const ROUTE_LABELS: Record<MedmarRoute, string> = {
  pozzuoli_ischia: "Pozzuoli → Ischia",
  pozzuoli_casamicciola: "Pozzuoli → Casamicciola",
  napoli_ischia: "Napoli → Ischia",
  napoli_casamicciola: "Napoli → Casamicciola",
  ischia_pozzuoli: "Ischia → Pozzuoli",
  casamicciola_pozzuoli: "Casamicciola → Pozzuoli",
  ischia_napoli: "Ischia → Napoli",
  casamicciola_napoli: "Casamicciola → Napoli",
};

export const TICKET_MODE_LABELS: Record<TicketMode, string> = {
  round_trip: "Andata e Ritorno",
  single_outbound: "Solo Andata",
  single_return: "Solo Ritorno",
};

export const LEG_STATUS_LABELS: Record<LegStatus, string> = {
  used: "Utilizzato",
  available_for_reassignment: "Disponibile per riassegnazione",
  reassigned: "Riassegnato",
  lost: "Perso",
  not_applicable: "N/A",
};

export const DEFAULT_PRICES_CENTS: Record<PriceType, number> = {
  round_trip_per_leg: 1025,
  single_trip_under_12: 1370,
  single_trip_12_or_more: 1025,
};

export function formatEur(cents: number): string {
  return (cents / 100).toLocaleString("it-IT", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
  });
}

export interface DecisionScenario {
  mode: TicketMode | "pending_group";
  label: string;
  totalCents: number;
  perPaxCents: number;
  riskLevel: "none" | "low" | "medium" | "high";
  badge: string;
  details: string[];
  recommended: boolean;
}

export function buildDecisionScenarios(
  paxCount: number,
  prices: Record<PriceType, number>,
  returnUsageProbability: number,
  canGroup: boolean,
  groupTargetPax: number
): DecisionScenario[] {
  const scenarios: DecisionScenario[] = [];

  if (paxCount >= 12) {
    const total = prices.single_trip_12_or_more * paxCount;
    scenarios.push({
      mode: "single_outbound",
      label: "Singola tratta (>=12 pax)",
      totalCents: total,
      perPaxCents: prices.single_trip_12_or_more,
      riskLevel: "none",
      badge: "Unica disponibile",
      details: [
        `${paxCount} pax x ${formatEur(prices.single_trip_12_or_more)} = ${formatEur(total)}`,
        "Tariffa scontata gruppo",
      ],
      recommended: true,
    });
    return scenarios;
  }

  const singleTotal = prices.single_trip_under_12 * paxCount;
  scenarios.push({
    mode: "single_outbound",
    label: "Solo Andata",
    totalCents: singleTotal,
    perPaxCents: prices.single_trip_under_12,
    riskLevel: "none",
    badge: "Sicuro",
    details: [
      `${paxCount} pax x ${formatEur(prices.single_trip_under_12)} = ${formatEur(singleTotal)}`,
      "Nessun rischio spreco",
      "Costa di piu a tratta rispetto all'A/R",
    ],
    recommended: false,
  });

  const arPerLeg = prices.round_trip_per_leg;
  const arTotal = arPerLeg * 2 * paxCount;
  const arExpectedCost =
    arTotal * returnUsageProbability +
    (arPerLeg * paxCount + prices.single_trip_under_12 * paxCount) * (1 - returnUsageProbability);

  let riskLevel: DecisionScenario["riskLevel"] = "low";
  let badge = "Conveniente";
  if (returnUsageProbability > 0.66) {
    riskLevel = "low";
    badge = "Conveniente";
  } else if (returnUsageProbability > 0.4) {
    riskLevel = "medium";
    badge = "Rischio medio";
  } else {
    riskLevel = "high";
    badge = "Alto rischio spreco";
  }

  const wastedCents = arPerLeg * paxCount;
  scenarios.push({
    mode: "round_trip",
    label: "A/R Medmar",
    totalCents: arTotal,
    perPaxCents: arPerLeg * 2,
    riskLevel,
    badge,
    details: [
      `${paxCount} pax x ${formatEur(arPerLeg * 2)} = ${formatEur(arTotal)}`,
      `Prob. ritorno usato: ${Math.round(returnUsageProbability * 100)}%`,
      `Se ritorno usato: ${formatEur(arTotal)} totale`,
      `Se ritorno NON usato: perdita ${formatEur(wastedCents)}`,
      `Costo atteso: ${formatEur(Math.round(arExpectedCost))}`,
    ],
    recommended: false,
  });

  if (canGroup) {
    const groupTotal = prices.single_trip_12_or_more * groupTargetPax;
    const savingVsSingle = singleTotal - (groupTotal * paxCount / groupTargetPax);
    scenarios.push({
      mode: "pending_group",
      label: "Aspetta per raggruppare",
      totalCents: groupTotal,
      perPaxCents: prices.single_trip_12_or_more,
      riskLevel: "none",
      badge: "Opportunita",
      details: [
        `Con ${groupTargetPax} pax totali: ${formatEur(prices.single_trip_12_or_more)}/pax`,
        `Risparmio stimato vs singola: ${formatEur(Math.max(0, Math.round(savingVsSingle)))}`,
        "Richiede raccolta pax aggiuntivi",
      ],
      recommended: false,
    });
  }

  const bestScenario = arExpectedCost < singleTotal ? scenarios[1] : scenarios[0];
  if (canGroup && scenarios[2]) {
    const groupSaving = singleTotal - prices.single_trip_12_or_more * paxCount;
    if (groupSaving > 200) scenarios[2].recommended = true;
    else bestScenario.recommended = true;
  } else {
    bestScenario.recommended = true;
  }

  return scenarios;
}
