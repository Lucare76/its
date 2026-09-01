export interface BookingSearchRecord {
  customer_name?: string | null;
  customer_first_name?: string | null;
  customer_last_name?: string | null;
  customer_display_name?: string | null;
  customer_email?: string | null;
  phone?: string | null;
  phone_e164?: string | null;
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
  service_type?: string | null;
  service_type_code?: string | null;
  bus_city_origin?: string | null;
  meeting_point?: string | null;
  pickup_hotel?: string | null;
  tour_name?: string | null;
  excursion_title?: string | null;
  id?: string | null;
  linked_service_id?: string | null;
  inbound_email_id?: string | null;
  direction?: string | null;
  practice_number?: string | null;
  // Voucher No MTS Globe: mai una colonna services, solo un'annotazione
  // effimera calcolata da app/api/ops/search/route.ts a partire da
  // agency_bookings.source_booking_key — vedi commento lì per il motivo.
  voucher_no?: string | null;
}

export function collapseLinkedBookingPairs<T extends BookingSearchRecord>(records: T[]): T[] {
  const positions = new Map<string, number>();
  const collapsed: T[] = [];
  for (const record of records) {
    const id = String(record.id ?? "");
    const linkedId = String(record.linked_service_id ?? "");
    const inboundEmailId = String(record.inbound_email_id ?? "");
    const key = linkedId ? [id, linkedId].sort().join(":") : inboundEmailId ? `email:${inboundEmailId}` : `single:${id}`;
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, collapsed.length);
      collapsed.push(record);
      continue;
    }
    if (collapsed[position]?.direction === "departure" && record.direction === "arrival") {
      collapsed[position] = record;
    }
  }
  return collapsed;
}

/**
 * Hardening Sprint 2B: shared with app/api/ops/search/route.ts's DB-level
 * phoneFilters (moved here so both stay in sync — see that file's comment
 * for why phone_e164 is intentionally never queried). Strips non-digits and
 * adds a "39"-country-code-stripped variant and a last-10-digit variant, so
 * a query typed as "+39 333 1234567", "393331234567" or "3331234567" all
 * normalize to a candidate set containing whichever bare-local-number form
 * is most likely to be a substring of however `phone` is actually stored.
 */
export function phoneNeedles(value: string): string[] {
  const digits = value.replace(/\D/g, "");
  if (!digits) return [];
  const candidates = [digits];
  if (digits.startsWith("39") && digits.length > 6) candidates.push(digits.slice(2));
  if (digits.length > 10) candidates.push(digits.slice(-10));
  return Array.from(new Set(candidates.filter((candidate) => candidate.length >= 4)));
}

/**
 * Case-insensitive match against name and/or phone, plus an independent
 * agency filter. Phone comparison strips everything but digits (`\D`) on
 * both sides so "+39 333-123 4567" and "3331234567" match — but only when
 * the query itself contains at least one digit, otherwise a letters-only
 * query would normalize to "" and match every phone via `"x".includes("")`.
 * Hardening Sprint 2B: matches against ANY phoneNeedles() candidate of the
 * query (not just the raw digit string), so a query with a country-code
 * prefix (+39/39...) also matches a phone stored WITHOUT one, and vice
 * versa — previously only the direction "query digits are a substring of
 * the stored digits" worked; the reverse (stored phone shorter than the
 * query, e.g. bare local number vs. a +39-prefixed query) silently failed.
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
  const agencyName = record.billing_party_name
    ?? (record.agency_id ? agencyNameById.get(record.agency_id) : null)
    ?? "";
  const bookingOwnerLabel = agencyName || "Privato";
  const fullName = [
    record.customer_first_name,
    record.customer_last_name,
  ].map((value) => String(value ?? "").trim()).filter(Boolean).join(" ");
  const searchableText = [
    record.customer_name,
    fullName,
    record.customer_first_name,
    record.customer_last_name,
    record.customer_display_name,
    record.customer_email,
    bookingOwnerLabel,
    agencyName ? null : "senza agenzia cliente privato privati",
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
    record.service_type,
    record.service_type_code,
    record.bus_city_origin,
    record.meeting_point,
    record.pickup_hotel,
    record.tour_name,
    record.excursion_title,
    record.id,
    record.practice_number,
    record.voucher_no,
  ].map((value) => normalizeText(value)).join(" ");

  const phoneHaystack = `${record.phone ?? ""} ${record.phone_e164 ?? ""}`.replace(/\D/g, "");
  const matchQuery = !hasQuery
    || searchableText.includes(q)
    || phoneNeedles(searchQuery).some((needle) => phoneHaystack.includes(needle));

  const matchAgency = !hasAgency || normalizeText(bookingOwnerLabel).includes(ag);

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
    .map((record, originalIndex) => ({
      record,
      originalIndex,
      relevance: bookingSearchRelevance(record, searchQuery),
    }))
    .sort((left, right) => right.relevance - left.relevance || left.originalIndex - right.originalIndex)
    .map(({ record }) => record)
    .slice(0, limit);
}

function bookingSearchRelevance(record: BookingSearchRecord, searchQuery: string): number {
  const query = normalizeText(searchQuery);
  if (!query) return 0;

  const fullName = normalizeText([
    record.customer_first_name,
    record.customer_last_name,
  ].filter(Boolean).join(" "));
  const names = [
    normalizeText(record.customer_name),
    fullName,
    normalizeText(record.customer_display_name),
    normalizeText(record.customer_first_name),
    normalizeText(record.customer_last_name),
  ].filter(Boolean);

  if (names.some((name) => name === query)) return 500;
  if (names.some((name) => name.startsWith(query))) return 400;
  if (names.some((name) => name.split(/\s+/).some((part) => part.startsWith(query)))) return 350;
  if (names.some((name) => name.includes(query))) return 300;

  const phoneHaystack = `${record.phone ?? ""} ${record.phone_e164 ?? ""}`.replace(/\D/g, "");
  if (phoneNeedles(searchQuery).some((needle) => phoneHaystack.includes(needle))) return 250;
  return 100;
}

function normalizeText(value?: string | null) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}
