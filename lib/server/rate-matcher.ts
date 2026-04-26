export type RateRow = {
  agency_id: string;
  booking_service_kind: string;
  price_cents: number | null;
  cost_cents: number | null;
  valid_from: string;
  valid_to: string | null;
};

/**
 * Cerca la tariffa più recente e attiva per agenzia + tipo servizio + data.
 * Priorità: più recente per valid_from tra quelle nel range.
 */
export function findRate(
  rates: RateRow[],
  agencyId: string,
  kind: string,
  serviceDate: string,
): RateRow | null {
  return rates
    .filter(
      (r) =>
        r.agency_id === agencyId &&
        r.booking_service_kind === kind &&
        r.valid_from <= serviceDate &&
        (r.valid_to == null || r.valid_to >= serviceDate),
    )
    .sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0] ?? null;
}
