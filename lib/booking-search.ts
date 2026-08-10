export interface BookingSearchRecord {
  customer_name?: string | null;
  phone?: string | null;
  billing_party_name?: string | null;
  agency_id?: string | null;
  hotel_name?: string | null;
  hotel_id?: string | null;
  vessel?: string | null;
  notes?: string | null;
  transport_code?: string | null;
  transport_code_return?: string | null;
  transport_reference_outward?: string | null;
  transport_reference_return?: string | null;
  train_arrival_number?: string | null;
  train_departure_number?: string | null;
  booking_service_kind?: string | null;
  service_type_code?: string | null;
  id?: string | null;
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
  const q = normalizeText(searchQuery);
  const ag = normalizeText(agencyFilter);
  const hasQuery = q.length >= 1;
  const hasAgency = ag.length >= 1;
  const qDigits = q.replace(/\D/g, "");
  const searchableText = [
    record.customer_name,
    record.hotel_name,
    record.vessel,
    record.notes,
    record.transport_code,
    record.transport_code_return,
    record.transport_reference_outward,
    record.transport_reference_return,
    record.train_arrival_number,
    record.train_departure_number,
    record.booking_service_kind,
    record.service_type_code,
    record.id,
  ].map((value) => normalizeText(value)).join(" ");

  const matchQuery = !hasQuery
    || searchableText.includes(q)
    || (qDigits.length > 0 && (record.phone ?? "").replace(/\D/g, "").includes(qDigits));

  const agencyName = record.billing_party_name
    ?? (record.agency_id ? agencyNameById.get(record.agency_id) : null)
    ?? "";
  const matchAgency = !hasAgency || normalizeText(agencyName).includes(ag);

  return matchQuery && matchAgency;
}

export function filterBookingsBySearch<T extends BookingSearchRecord>(
  records: T[],
  searchQuery: string,
  agencyFilter: string,
  agencyNameById: Map<string, string>,
  limit = 20
): T[] {
  const hasQuery = searchQuery.trim().length >= 1;
  const hasAgency = agencyFilter.trim().length >= 1;
  if (!hasQuery && !hasAgency) return [];
  return records
    .filter((record) => matchesBookingSearch(record, searchQuery, agencyFilter, agencyNameById))
    .slice(0, limit);
}

function normalizeText(value?: string | null) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}
