export interface BookingSearchRecord {
  customer_name?: string | null;
  phone?: string | null;
  billing_party_name?: string | null;
  agency_id?: string | null;
}

/**
 * Case-insensitive match against name and/or phone, plus an independent
 * agency filter. Phone comparison strips everything but digits (`\D`) on
 * both sides so "+39 333-123 4567" and "3331234567" match — but only when
 * the query itself contains at least one digit, otherwise a letters-only
 * query would normalize to "" and match every phone via `"x".includes("")`.
 */
export function matchesBookingSearch(
  record: BookingSearchRecord,
  searchQuery: string,
  agencyFilter: string,
  agencyNameById: Map<string, string>
): boolean {
  const q = searchQuery.trim().toLowerCase();
  const ag = agencyFilter.trim().toLowerCase();
  const hasQuery = q.length >= 2;
  const hasAgency = ag.length >= 2;
  const qDigits = q.replace(/\D/g, "");

  const matchQuery = !hasQuery
    || (record.customer_name ?? "").toLowerCase().includes(q)
    || (qDigits.length > 0 && (record.phone ?? "").replace(/\D/g, "").includes(qDigits));

  const agencyName = record.billing_party_name
    ?? (record.agency_id ? agencyNameById.get(record.agency_id) : null)
    ?? "";
  const matchAgency = !hasAgency || agencyName.toLowerCase().includes(ag);

  return matchQuery && matchAgency;
}

export function filterBookingsBySearch<T extends BookingSearchRecord>(
  records: T[],
  searchQuery: string,
  agencyFilter: string,
  agencyNameById: Map<string, string>,
  limit = 20
): T[] {
  const hasQuery = searchQuery.trim().length >= 2;
  const hasAgency = agencyFilter.trim().length >= 2;
  if (!hasQuery && !hasAgency) return [];
  return records
    .filter((record) => matchesBookingSearch(record, searchQuery, agencyFilter, agencyNameById))
    .slice(0, limit);
}
