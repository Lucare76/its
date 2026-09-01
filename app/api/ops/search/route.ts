import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { collapseLinkedBookingPairs, filterBookingsBySearch, phoneNeedles } from "@/lib/booking-search";
import { ferryPortLabel, findArrivalScheduleForService, findDepartureScheduleForService, type FerryScheduleRow } from "@/lib/ferry-schedule-options";
import { getPickupRuleByRange, normalizeZonaIschia } from "@/lib/departure-pickup-rules";
import { findFerryPickupRule, resolveAgencyLogic, type FerryPickupRule } from "@/lib/ferry-pickup-rules";
import { hasRealDepartureLeg } from "@/lib/booking-list-display";
import type { Service } from "@/lib/types";

export const runtime = "nodejs";

type AuthorizedSearchRequest = Exclude<Awaited<ReturnType<typeof authorizePricingRequest>>, NextResponse>;
type SearchAdminClient = AuthorizedSearchRequest["admin"];

// Colonne esplicite: servono a ricerca (.ilike/.or), risposta JSON e ranking
// (lib/booking-search.ts). Confermate esistenti in lib/types.ts (Service) e
// usate altrove nell'app (new-booking, agency/bookings, service-display) —
// ripristinate dopo una regressione che le aveva sostituite con select("*")
// (payload più pesante, non più leggero, a differenza degli altri Sprint).
const SERVICE_SEARCH_COLUMNS = [
  "id",
  "inbound_email_id",
  "is_draft",
  "customer_name",
  "customer_first_name",
  "customer_last_name",
  "customer_email",
  "phone",
  "date",
  "time",
  "status",
  "direction",
  "pax",
  "vessel",
  "booking_service_kind",
  "service_type",
  "service_type_code",
  "arrival_date",
  "arrival_time",
  "train_arrival_time",
  "departure_date",
  "departure_time",
  "train_departure_time",
  "orario_barca",
  "barca_compagnia",
  "porto_bruno",
  "pickup_time",
  "transport_code",
  "train_arrival_number",
  "train_departure_number",
  "bus_city_origin",
  "hotel_id",
  "billing_party_name",
  "agency_id",
  "meeting_point",
  "pickup_hotel",
  "notes",
  "linked_service_id",
  "practice_number",
  // Obiettivo C: necessario per collegare i services trovati via voucher
  // MTS Globe (agency_bookings.source_booking_key) al relativo agency
  // booking, sia per il filtro .in("agency_booking_id", ...) sia per
  // esporlo in risposta.
  "agency_booking_id",
  // Fix B (booking groups): serve sia per far passare i draft di gruppo dal
  // filtro is_draft sotto, sia per risolvere/esporre il nome del gruppo
  // (badge "Gruppo" in risposta).
  "booking_group_id",
  "created_at",
].join(", ");

type SearchServiceRow = Partial<Service> & {
  id: string;
  created_at?: string | null;
  hotel_name?: string | null;
  agency_booking_id?: string | null;
  booking_group_id?: string | null;
  // Fix B: nome del gruppo risolto lato route (join su booking_groups),
  // mai testo libero — solo per il badge "Gruppo" in risposta.
  booking_group_name?: string | null;
  // Obiettivo C: annotazione effimera in-memory, mai persistita — valorizzata
  // solo quando il service è stato trovato tramite match sul Voucher No MTS
  // Globe (agency_bookings.source_booking_key), per farlo sopravvivere al
  // re-filtro testuale di matchesBookingSearch senza duplicare il voucher
  // in una colonna services.
  voucher_no?: string | null;
};

type AgencyBookingMatchRow = { id: string; source_booking_key: string };
type AgencyBookingQueryResult = { data: AgencyBookingMatchRow[] | null; error: { message: string } | null };
type AgencyBookingQueryBuilder = PromiseLike<AgencyBookingQueryResult> & {
  ilike(column: string, pattern: string): AgencyBookingQueryBuilder;
  eq(column: string, value: string): AgencyBookingQueryBuilder;
};

type CancellationLogRow = {
  service_id: string;
  operator_name: string | null;
  operator_email: string | null;
  created_at: string;
  after_data: {
    cancellation_reason?: string | null;
    cancellation_note?: string | null;
    assignments_cleared?: number | null;
  } | null;
};

type BusAllocationDetailRow = {
  service_id: string;
  direction: "arrival" | "departure" | string | null;
  family_code: string | null;
  line_name: string | null;
  stop_name: string | null;
  stop_city: string | null;
  stop_pickup_note: string | null;
  stop_pickup_time: string | null;
  hotel_pickup_time: string | null;
};

type BusFerryConfigRow = {
  bus_line_family_code: string;
  departure_port: string;
  arrival_port: string;
  departure_time: string;
};

type BusLineRow = {
  id: string;
  family_code: string | null;
  name: string | null;
};

type BusStopRow = {
  id: string;
  bus_line_id: string;
  direction: "arrival" | "departure" | string | null;
  stop_name: string | null;
  city: string | null;
  pickup_note: string | null;
  pickup_time: string | null;
};

type HotelPickupTimeRow = {
  hotel_name: string | null;
  pickup_time_linea_italia: string | null;
  pickup_time_linea_centro: string | null;
  pickup_time_linea_adriatica: string | null;
};

type SearchQueryResult = { data: SearchServiceRow[] | null; error: { message: string } | null };
type SearchQueryBuilder = PromiseLike<SearchQueryResult> & {
  ilike(column: string, pattern: string): SearchQueryBuilder;
  eq(column: string, value: string): SearchQueryBuilder;
  in(column: string, values: string[]): SearchQueryBuilder;
  is(column: string, value: null): SearchQueryBuilder;
  or(filters: string): SearchQueryBuilder;
};

function cleanTime(value: string | null | undefined): string | null {
  const match = String(value ?? "").match(/^(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : null;
}

function transferTransportType(kind: string | null | undefined): "train" | "flight" | null {
  if (!kind) return null;
  if (kind.includes("train")) return "train";
  if (kind.includes("airport")) return "flight";
  return null;
}

function transferBoatType(kind: string | null | undefined): "traghetto" | "aliscafo" {
  return kind?.endsWith("_aliscafo") ? "aliscafo" : "traghetto";
}

function transferDepartureRuleType(kind: string | null | undefined): string | null {
  const transportType = transferTransportType(kind);
  if (!transportType) return null;
  const prefix = transportType === "train" ? "treno" : "volo";
  return `${prefix}_${transferBoatType(kind)}`;
}

function normalizeNeedle(value: string): string {
  return value.trim().toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function textTokens(value: string): string[] {
  return Array.from(new Set(
    normalizeNeedle(value)
      .split(/[\s,;:/\\|()[\]{}"'`]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
      .slice(0, 5)
  ));
}

function isPrivateNeedle(value: string): boolean {
  const normalized = normalizeNeedle(value);
  return ["privato", "privati", "senza agenzia", "cliente privato"].some((needle) => normalized.includes(needle));
}

function canUsePostgrestOr(value: string): boolean {
  return !/[(),]/.test(value);
}

// services.id è uuid: Postgres non supporta ILIKE (~~*) su uuid, quindi va
// cercato con un'uguaglianza esatta e mai incluso nella lista textFields.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

function isBusBooking(service: Pick<SearchServiceRow, "booking_service_kind" | "service_type_code">) {
  return service.booking_service_kind === "bus_city_hotel" || service.service_type_code === "bus_line";
}

function busPickupPoint(allocation: BusAllocationDetailRow | null | undefined) {
  const stop = allocation?.stop_name?.trim() || allocation?.stop_city?.trim() || "";
  const note = allocation?.stop_pickup_note?.trim() || "";
  if (stop && note && !stop.toLowerCase().includes(note.toLowerCase())) return `${stop} - ${note}`;
  return stop || note || null;
}

function busFerryArrivalTime(
  allocation: BusAllocationDetailRow | null | undefined,
  configs: BusFerryConfigRow[],
  schedules: FerryScheduleRow[]
) {
  const family = allocation?.family_code?.trim().toLowerCase();
  if (!family) return null;
  const config = configs.find((item) => item.bus_line_family_code?.trim().toLowerCase() === family);
  if (!config) return null;
  const departureTime = cleanTime(config.departure_time);
  const schedule = schedules.find((row) =>
    row.direction === "mainland_to_ischia" &&
    row.departure_port === config.departure_port &&
    row.arrival_port === config.arrival_port &&
    cleanTime(row.departure_time) === departureTime
  );
  return cleanTime(schedule?.arrival_time) ?? null;
}

function busAllocationKey(row: BusAllocationDetailRow) {
  return [
    row.service_id,
    row.direction ?? "",
    row.family_code ?? "",
    row.stop_name ?? "",
    row.stop_pickup_time ?? "",
    row.hotel_pickup_time ?? "",
  ].join("|");
}

function findBusStopFallback(
  service: SearchServiceRow,
  direction: "arrival" | "departure",
  stops: BusStopRow[],
  lineById: Map<string, BusLineRow>
): BusAllocationDetailRow | null {
  const city = normalizeNeedle(String(service.bus_city_origin ?? ""));
  if (!city) return null;
  const serviceTime = cleanTime(direction === "arrival" ? service.arrival_time ?? service.time : service.departure_time ?? service.time);
  const matches = stops.filter((stop) => {
    if (stop.direction !== direction) return false;
    const stopName = normalizeNeedle(String(stop.stop_name ?? ""));
    const stopCity = normalizeNeedle(String(stop.city ?? ""));
    return stopName === city || stopCity === city;
  });
  const stop =
    matches.find((item) => cleanTime(item.pickup_time) === serviceTime) ??
    matches[0] ??
    null;
  if (!stop) return null;
  const line = lineById.get(stop.bus_line_id);
  return {
    service_id: service.id,
    direction,
    family_code: line?.family_code ?? null,
    line_name: line?.name ?? null,
    stop_name: stop.stop_name,
    stop_city: stop.city,
    stop_pickup_note: stop.pickup_note,
    stop_pickup_time: stop.pickup_time,
    hotel_pickup_time: null,
  };
}

function hotelPickupForFamily(
  hotelName: string | null | undefined,
  familyCode: string | null | undefined,
  rows: HotelPickupTimeRow[]
) {
  const normalizedHotel = normalizeNeedle(String(hotelName ?? ""));
  if (!normalizedHotel) return null;
  const row = rows.find((item) => normalizeNeedle(String(item.hotel_name ?? "")) === normalizedHotel);
  if (!row) return null;
  const family = normalizeNeedle(String(familyCode ?? ""));
  if (family === "italia") return cleanTime(row.pickup_time_linea_italia);
  if (family === "centro") return cleanTime(row.pickup_time_linea_centro);
  if (family === "adriatica") return cleanTime(row.pickup_time_linea_adriatica);
  return null;
}

function serviceTypeNeedles(value: string): Array<"transfer" | "bus_tour"> {
  const normalized = normalizeNeedle(value);
  const needles: Array<"transfer" | "bus_tour"> = [];
  if (normalized.includes("transfer")) needles.push("transfer");
  if (normalized.includes("bus") || normalized.includes("tour")) needles.push("bus_tour");
  return Array.from(new Set(needles));
}

function sortSearchRows(rows: SearchServiceRow[]): SearchServiceRow[] {
  return [...rows].sort((a, b) => {
    const created = String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
    return created !== 0 ? created : String(a.id ?? "").localeCompare(String(b.id ?? ""));
  });
}

function mergeSearchRows(rows: SearchServiceRow[][]): SearchServiceRow[] {
  const byId = new Map<string, SearchServiceRow>();
  for (const batch of rows) {
    for (const row of batch) {
      if (row?.id && !byId.has(row.id)) byId.set(row.id, row);
    }
  }
  return sortSearchRows([...byId.values()]);
}

async function loadLookupMatches(
  admin: SearchAdminClient,
  tenantId: string,
  q: string,
  agency: string
) {
  const hotelPattern = `%${q}%`;
  const agencyNeedle = agency || q;
  const agencyPattern = `%${agencyNeedle}%`;
  const [hotelsResult, agenciesResult] = await Promise.all([
    q
      ? admin.from("hotels").select("id,name,zone").eq("tenant_id", tenantId).ilike("name", hotelPattern).limit(100)
      : Promise.resolve({ data: [], error: null }),
    agencyNeedle
      ? admin.from("agencies").select("id,name").eq("tenant_id", tenantId).ilike("name", agencyPattern).limit(100)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const error = hotelsResult.error ?? agenciesResult.error ?? null;
  if (error) throw new Error(error.message);
  return {
    matchedHotels: (hotelsResult.data ?? []) as Array<{ id: string; name: string; zone?: string | null }>,
    matchedAgencies: (agenciesResult.data ?? []) as Array<{ id: string; name: string }>,
  };
}

// Obiettivo C: il Voucher No MTS Globe non vive in services.practice_number,
// ma in agency_bookings.source_booking_key = "mts_globe:<voucherNo>". Cerca
// SOLO in questa colonna (mai in source_payload JSONB, non serve), sempre
// scoped al tenant. Preferisce l'exact match "mts_globe:<q>" e il prefix
// "mts_globe:<q>%"; il partial "%<q>%" è un fallback controllato (solo per
// query di almeno 4 caratteri, come i needle telefono in booking-search.ts)
// per non generare scan troppo ampi su query cortissime.
async function queryVoucherMatches(
  admin: SearchAdminClient,
  tenantId: string,
  q: string
): Promise<AgencyBookingMatchRow[]> {
  if (!q) return [];
  const exactKey = `mts_globe:${q}`;
  const prefixPattern = `mts_globe:${q}%`;
  const partialPattern = q.length >= 4 ? `%${q}%` : null;

  const baseQuery = () =>
    admin
      .from("agency_bookings")
      .select("id, source_booking_key")
      .eq("tenant_id", tenantId)
      .eq("source", "mts_globe")
      .limit(50) as unknown as AgencyBookingQueryBuilder;

  const batches: Array<PromiseLike<AgencyBookingQueryResult>> = [
    baseQuery().eq("source_booking_key", exactKey),
    baseQuery().ilike("source_booking_key", prefixPattern),
  ];
  if (partialPattern) batches.push(baseQuery().ilike("source_booking_key", partialPattern));

  const results = await Promise.all(batches);
  const error = results.find((result) => result.error)?.error ?? null;
  if (error) throw new Error(error.message);
  const byId = new Map<string, AgencyBookingMatchRow>();
  for (const result of results) {
    for (const row of result.data ?? []) {
      if (row?.id && !byId.has(row.id)) byId.set(row.id, row);
    }
  }
  return [...byId.values()];
}

async function querySearchCandidates(
  admin: SearchAdminClient,
  tenantId: string,
  input: {
    q: string;
    agency: string;
    limit: number;
    matchedHotelIds: string[];
    matchedAgencyIds: string[];
    matchedAgencyBookingIds: string[];
  }
): Promise<SearchServiceRow[]> {
  const perQueryLimit = Math.min(Math.max(input.limit * 8, 160), 500);
  const batches: Array<PromiseLike<SearchQueryResult>> = [];
  const run = (apply: (query: SearchQueryBuilder) => SearchQueryBuilder) => {
    const query = admin
      .from("services")
      .select(SERVICE_SEARCH_COLUMNS)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(perQueryLimit) as unknown as SearchQueryBuilder;
    batches.push(apply(query));
  };

  if (input.q) {
    const pattern = `%${input.q}%`;
    // `id` (uuid) è deliberatamente escluso da questa lista e cercato sotto
    // con .eq(), non con ILIKE (Postgres non supporta ILIKE su uuid).
    const textFields = [
      "customer_name",
      "customer_first_name",
      "customer_last_name",
      "customer_email",
      "billing_party_name",
      "vessel",
      "notes",
      "transport_code",
      "train_arrival_number",
      "train_departure_number",
      "booking_service_kind",
      "service_type_code",
      "bus_city_origin",
      "meeting_point",
      "pickup_hotel",
      // Obiettivo B: practice_number è text (verificato via
      // information_schema.columns), quindi va cercato con lo stesso pattern
      // ILIKE degli altri campi testuali — nessun cast/confronto numerico
      // necessario.
      "practice_number",
    ];
    if (canUsePostgrestOr(input.q)) {
      run((query) => query.or(textFields.map((field) => `${field}.ilike.${pattern}`).join(",")));
    } else {
      for (const field of textFields) run((query) => query.ilike(field, pattern));
    }
    for (const token of textTokens(input.q)) {
      const tokenPattern = `%${token}%`;
      run((query) => query.or([
        `customer_name.ilike.${tokenPattern}`,
        `customer_first_name.ilike.${tokenPattern}`,
        `customer_last_name.ilike.${tokenPattern}`,
      ].join(",")));
    }
    // Hardening Sprint 2B: `phone` only, deliberately — services.phone_e164
    // is confirmed absent on the real DB (information_schema.columns check),
    // so filtering on it would fail with PostgREST 42703. phoneNeedles()
    // already strips all non-digits from the query and generates the "39"
    // -stripped / last-10-digit variants, so an E.164-formatted query
    // (+39 333 1234567), a bare-digit query (393331234567/3331234567) or a
    // spaced query (333 123 4567) all normalize to the same needle(s) and
    // match phone regardless of which of those formats phone itself is
    // stored in — no phone_e164 column is needed for this to work.
    const phoneFilters = phoneNeedles(input.q).flatMap((needle) => [
      `phone.ilike.%${needle}%`,
    ]);
    if (phoneFilters.length) {
      run((query) => query.or(phoneFilters.join(",")));
    }
    if (isUuid(input.q)) run((query) => query.eq("id", input.q));
    for (const serviceType of serviceTypeNeedles(input.q)) {
      run((query) => query.eq("service_type", serviceType));
    }
    if (input.matchedHotelIds.length) run((query) => query.in("hotel_id", input.matchedHotelIds));
    if (input.matchedAgencyIds.length) run((query) => query.in("agency_id", input.matchedAgencyIds));
    // Obiettivo C: services collegati agli agency_bookings MTS Globe trovati
    // via Voucher No (queryVoucherMatches), tramite services.agency_booking_id.
    if (input.matchedAgencyBookingIds.length) run((query) => query.in("agency_booking_id", input.matchedAgencyBookingIds));
    if (isPrivateNeedle(input.q)) {
      run((query) => query.is("agency_id", null).is("billing_party_name", null));
      run((query) => query.ilike("billing_party_name", "%privato%"));
    }
  }

  if (input.agency) {
    run((query) => query.ilike("billing_party_name", `%${input.agency}%`));
    if (input.matchedAgencyIds.length) run((query) => query.in("agency_id", input.matchedAgencyIds));
    if (isPrivateNeedle(input.agency)) {
      run((query) => query.is("agency_id", null).is("billing_party_name", null));
      run((query) => query.ilike("billing_party_name", "%privato%"));
    }
  }

  if (!batches.length) return [];
  const results = await Promise.all(batches);
  const error = results.find((result) => result.error)?.error ?? null;
  if (error) throw new Error(error.message);
  return mergeSearchRows(results.map((result) => (result.data ?? []) as SearchServiceRow[]))
    // Fix B: i passeggeri creati da Booking Groups nascono is_draft=true/
    // status='needs_review' finche' non vengono operativizzati (vedi
    // lib/server/booking-groups-service.ts) — sono prenotazioni reali e
    // gestite attivamente, non "rumore" come i draft da parsing email non
    // ancora revisionati (che restano esclusi). Un service con
    // booking_group_id passa quindi il filtro anche da draft.
    .filter((service) => service.is_draft !== true || Boolean(service.booking_group_id));
}

async function loadRowsByIds(
  admin: SearchAdminClient,
  tenantId: string,
  ids: string[]
): Promise<SearchServiceRow[]> {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (!uniqueIds.length) return [];
  const { data, error } = await admin
    .from("services")
    .select(SERVICE_SEARCH_COLUMNS)
    .eq("tenant_id", tenantId)
    .in("id", uniqueIds);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as SearchServiceRow[];
}

export async function GET(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;

    const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
    const agency = (req.nextUrl.searchParams.get("agency") ?? "").trim();
    if (q.length < 1 && agency.length < 1) return NextResponse.json({ ok: true, results: [] });

    const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? "30"), 100);

    const [{ matchedHotels, matchedAgencies }, matchedAgencyBookings] = await Promise.all([
      loadLookupMatches(auth.admin, tenantId, q, agency),
      queryVoucherMatches(auth.admin, tenantId, q),
    ]);
    const voucherByAgencyBookingId = new Map(
      matchedAgencyBookings.map((booking) => [booking.id, booking.source_booking_key.replace(/^mts_globe:/, "")])
    );
    const candidateServices = await querySearchCandidates(auth.admin, tenantId, {
      q,
      agency,
      limit,
      matchedHotelIds: matchedHotels.map((hotel) => hotel.id),
      matchedAgencyIds: matchedAgencies.map((agencyRow) => agencyRow.id),
      matchedAgencyBookingIds: matchedAgencyBookings.map((booking) => booking.id),
    });

    const linkedServices = await loadRowsByIds(
      auth.admin,
      tenantId,
      candidateServices.map((service) => String(service.linked_service_id ?? "")).filter(Boolean)
    );
    const serviceRows = mergeSearchRows([candidateServices, linkedServices]);
    const hotelIds = Array.from(new Set([
      ...matchedHotels.map((hotel) => hotel.id),
      ...serviceRows.map((service) => String(service.hotel_id ?? "")).filter(Boolean),
    ]));
    const agencyIds = Array.from(new Set([
      ...matchedAgencies.map((agencyRow) => agencyRow.id),
      ...serviceRows.map((service) => String(service.agency_id ?? "")).filter(Boolean),
    ]));
    // Fix B: gruppi prenotazione dei services trovati, per il badge "Gruppo".
    const bookingGroupIds = Array.from(new Set(
      serviceRows.map((service) => String(service.booking_group_id ?? "")).filter(Boolean)
    ));
    const serviceIds = Array.from(new Set(serviceRows.map((service) => service.id).filter(Boolean)));

    const [hotelsResult, agenciesResult, bookingGroupsResult, schedulesResult, ferryPickupRulesResult, busAllocationsResult, busFerryConfigsResult, busStopsResult, busLinesResult, hotelPickupTimesResult, cancellationLogsResult] = await Promise.all([
      hotelIds.length
        ? auth.admin.from("hotels").select("id,name,zone").eq("tenant_id", tenantId).in("id", hotelIds)
        : Promise.resolve({ data: [], error: null }),
      agencyIds.length
        ? auth.admin.from("agencies").select("id,name").eq("tenant_id", tenantId).in("id", agencyIds)
        : Promise.resolve({ data: [], error: null }),
      bookingGroupIds.length
        ? auth.admin.from("booking_groups").select("id,name").eq("tenant_id", tenantId).in("id", bookingGroupIds)
        : Promise.resolve({ data: [], error: null }),
      auth.admin.from("ferry_schedules").select("company,departure_port,arrival_port,departure_time,arrival_time,direction,days_of_week,valid_from,valid_to"),
      // Usato solo per arrivalLeg (vedi sotto) -> solo regole ARRIVO (to_ischia), mai PARTENZA.
      auth.admin.from("ferry_pickup_rules").select("*").eq("direction", "to_ischia"),
      serviceIds.length
        ? auth.admin
          .from("ops_bus_allocation_details")
          .select("service_id,direction,family_code,line_name,stop_name,stop_city,stop_pickup_note,stop_pickup_time,hotel_pickup_time")
          .eq("tenant_id", tenantId)
          .in("service_id", serviceIds)
        : Promise.resolve({ data: [], error: null }),
      auth.admin
        .from("bus_line_ferry_config")
        .select("bus_line_family_code,departure_port,arrival_port,departure_time")
        .eq("tenant_id", tenantId),
      auth.admin
        .from("tenant_bus_line_stops")
        .select("id,bus_line_id,direction,stop_name,city,pickup_note,pickup_time")
        .eq("tenant_id", tenantId),
      auth.admin
        .from("tenant_bus_lines")
        .select("id,family_code,name")
        .eq("tenant_id", tenantId)
        .eq("active", true),
      auth.admin
        .from("hotel_pickup_times")
        .select("hotel_name,pickup_time_linea_italia,pickup_time_linea_centro,pickup_time_linea_adriatica"),
      serviceIds.length
        ? auth.admin
          .from("service_change_logs")
          .select("service_id,operator_name,operator_email,created_at,after_data")
          .eq("tenant_id", tenantId)
          .eq("action", "CANCELLED")
          .in("service_id", serviceIds)
          .order("created_at", { ascending: false })
        : Promise.resolve({ data: [], error: null }),
    ]);

    const error = hotelsResult.error ?? agenciesResult.error ?? bookingGroupsResult.error ?? schedulesResult.error ?? ferryPickupRulesResult.error ?? busAllocationsResult.error ?? busFerryConfigsResult.error ?? busStopsResult.error ?? busLinesResult.error ?? hotelPickupTimesResult.error ?? cancellationLogsResult.error ?? null;
    if (error) throw new Error(error.message);

    const hotelNameById = new Map([...(matchedHotels ?? []), ...(hotelsResult.data ?? [])].map((hotel: { id: string; name: string }) => [hotel.id, hotel.name]));
    const hotelZoneById = new Map([...(matchedHotels ?? []), ...(hotelsResult.data ?? [])].map((hotel: { id: string; zone?: string | null }) => [hotel.id, hotel.zone ?? null]));
    const agencyNameById = new Map([...(matchedAgencies ?? []), ...(agenciesResult.data ?? [])].map((item: { id: string; name: string }) => [item.id, item.name]));
    const bookingGroupNameById = new Map((bookingGroupsResult.data ?? []).map((group: { id: string; name: string }) => [group.id, group.name]));
    const busAllocationsByServiceId = new Map<string, BusAllocationDetailRow[]>();
    for (const allocation of (busAllocationsResult.data ?? []) as BusAllocationDetailRow[]) {
      const rows = busAllocationsByServiceId.get(allocation.service_id) ?? [];
      rows.push(allocation);
      busAllocationsByServiceId.set(allocation.service_id, rows);
    }
    const busFerryConfigs = (busFerryConfigsResult.data ?? []) as BusFerryConfigRow[];
    const busStops = (busStopsResult.data ?? []) as BusStopRow[];
    const busLineById = new Map(((busLinesResult.data ?? []) as BusLineRow[]).map((line) => [line.id, line]));
    const hotelPickupTimes = (hotelPickupTimesResult.data ?? []) as HotelPickupTimeRow[];
    const serviceById = new Map(serviceRows.map((service) => [service.id, service]));
    const cancellationLogByServiceId = new Map<string, CancellationLogRow>();
    for (const log of (cancellationLogsResult.data ?? []) as CancellationLogRow[]) {
      if (log.service_id && !cancellationLogByServiceId.has(log.service_id)) {
        cancellationLogByServiceId.set(log.service_id, log);
      }
    }
    const searchable = candidateServices
      .map((service) => ({
        ...service,
        hotel_name: service.hotel_id ? hotelNameById.get(service.hotel_id) ?? null : null,
        // Obiettivo C: annotazione in-memory (mai scritta su services) così
        // matchesBookingSearch (lib/booking-search.ts) trova il voucher nel
        // testo cercabile anche se nessun campo services lo contiene.
        voucher_no: service.agency_booking_id ? voucherByAgencyBookingId.get(service.agency_booking_id) ?? null : null,
      }));

    const results = collapseLinkedBookingPairs(
      filterBookingsBySearch(searchable, q, agency, agencyNameById, Math.max(limit * 2, 100))
    ).slice(0, limit)
      .map((r) => {
        const linked = r.linked_service_id
          ? serviceById.get(String(r.linked_service_id))
          : null;
        const arrivalLeg = r.direction === "arrival" ? r : linked?.direction === "arrival" ? linked : r;
        // Riga combinata reale (caso MATTIOLI 26/010806): direction='arrival'
        // ma la stessa riga porta anche un dato di partenza treno strutturato
        // (train_departure_time/number), non una gamba A/R separata via
        // linked_service_id. hasRealDepartureLeg (stesso helper del fix
        // display in lib/booking-list-display.ts) richiede il segnale forte
        // per non riattivare il bug BIRAGO (departure_date/departure_time
        // residui generici, mai train_departure_*, restano non trattati come
        // gamba reale).
        const departureLeg = r.direction === "departure" ? r
          : linked?.direction === "departure" ? linked
          : r.direction === "arrival" && hasRealDepartureLeg(r) ? r
          : null;
        const schedules = (schedulesResult.data ?? []) as FerryScheduleRow[];
        const ferryPickupRules = (ferryPickupRulesResult.data ?? []) as FerryPickupRule[];
        const joinedName = [r.customer_first_name, r.customer_last_name].filter(Boolean).join(" ").trim();
        const owner = r.billing_party_name ?? (r.agency_id ? agencyNameById.get(r.agency_id) : null) ?? "Privato";
        const cancellationLog = cancellationLogByServiceId.get(r.id) ?? null;
        const hotelZone = r.hotel_id ? hotelZoneById.get(r.hotel_id) ?? null : null;
        const transportType = transferTransportType(arrivalLeg.booking_service_kind);
        const ruleTransportTime = cleanTime(arrivalLeg.train_arrival_time) ?? cleanTime(arrivalLeg.arrival_time) ?? cleanTime(arrivalLeg.time);
        const arrivalLegDate = arrivalLeg.arrival_date ?? arrivalLeg.date ?? "";
        const ferryPickupRule = transportType && ruleTransportTime
          ? findFerryPickupRule(
            ferryPickupRules,
            resolveAgencyLogic(owner),
            transportType,
            transferBoatType(arrivalLeg.booking_service_kind),
            ruleTransportTime,
            arrivalLegDate
          )
          : null;
        const arrivalSchedule = findArrivalScheduleForService(
          schedules,
          arrivalLegDate,
          arrivalLeg.time ?? null,
          arrivalLeg.booking_service_kind ?? null
        );
        const returnFerryDepartureTime = departureLeg?.orario_barca ?? r.orario_barca ?? departureLeg?.departure_time ?? r.departure_time ?? null;
        const returnLegDate = departureLeg?.departure_date ?? r.departure_date ?? r.date ?? "";
        const returnSchedule = findDepartureScheduleForService(
          schedules,
          returnLegDate,
          returnFerryDepartureTime,
          departureLeg?.booking_service_kind ?? r.booking_service_kind ?? null
        );
        const departureRuleType = transferDepartureRuleType(departureLeg?.booking_service_kind);
        const departureTransportTime = cleanTime(departureLeg?.train_departure_time) ?? cleanTime(departureLeg?.departure_time) ?? cleanTime(departureLeg?.time);
        const departurePickupRule = departureRuleType && departureTransportTime
          ? getPickupRuleByRange(owner, departureRuleType, departureTransportTime, normalizeZonaIschia(hotelZone))
          : null;
        const isBus =
          isBusBooking(r) ||
          isBusBooking(arrivalLeg) ||
          (departureLeg ? isBusBooking(departureLeg) : false);
        const arrivalBusFallback = isBus
          ? findBusStopFallback(arrivalLeg, "arrival", busStops, busLineById) ?? findBusStopFallback(r, "arrival", busStops, busLineById)
          : null;
        const departureBusFallback = isBus
          ? findBusStopFallback(departureLeg ?? r, "departure", busStops, busLineById) ?? findBusStopFallback(r, "departure", busStops, busLineById)
          : null;
        const busRows = [
          ...(busAllocationsByServiceId.get(arrivalLeg.id) ?? []),
          ...(departureLeg?.id ? busAllocationsByServiceId.get(departureLeg.id) ?? [] : []),
          ...(busAllocationsByServiceId.get(r.id) ?? []),
          ...(arrivalBusFallback ? [arrivalBusFallback] : []),
          ...(departureBusFallback ? [departureBusFallback] : []),
        ];
        const busAllocations = Array.from(new Map(busRows.map((row) => [busAllocationKey(row), row])).values());
        const arrivalBusAllocation = busAllocations.find((row) => row.direction === "arrival") ?? busAllocations[0] ?? null;
        const departureBusAllocation =
          busAllocations.find((row) => row.direction === "departure") ??
          busAllocations.find((row) => Boolean(row.hotel_pickup_time)) ??
          null;
        const busFamily = departureBusAllocation?.family_code ?? arrivalBusAllocation?.family_code ?? null;
        const busOutwardPickupTime =
          cleanTime(arrivalBusAllocation?.stop_pickup_time) ??
          cleanTime(arrivalLeg.train_arrival_time) ??
          cleanTime(arrivalLeg.arrival_time);
        const busArrivalTime = busFerryArrivalTime(arrivalBusAllocation, busFerryConfigs, schedules);
        const busReturnPickupTime =
          cleanTime(departureBusAllocation?.hotel_pickup_time) ??
          hotelPickupForFamily(r.hotel_id ? hotelNameById.get(r.hotel_id) : null, busFamily, hotelPickupTimes) ??
          cleanTime(departureLeg?.pickup_time) ??
          cleanTime(r.pickup_time);
        return {
          id: r.id,
          inbound_email_id: r.inbound_email_id ?? null,
          customer_name: r.customer_name?.trim() || joinedName || "Cliente N/D",
          customer_first_name: r.customer_first_name ?? null,
          customer_last_name: r.customer_last_name ?? null,
          customer_email: r.customer_email ?? null,
          phone: r.phone ?? null,
          phone_e164: r.phone_e164 ?? null,
          date: r.date,
          time: r.time,
          status: r.status,
          direction: r.direction,
          pax: r.pax,
          vessel: r.vessel ?? null,
          booking_service_kind: r.booking_service_kind ?? null,
          service_type: r.service_type ?? null,
          service_type_code: r.service_type_code ?? null,
          arrival_date: r.arrival_date ?? null,
          arrival_time: r.arrival_time ?? null,
          train_arrival_time: isBus ? busOutwardPickupTime ?? r.train_arrival_time ?? null : r.train_arrival_time ?? null,
          departure_date: r.departure_date ?? null,
          departure_time: r.departure_time ?? null,
          train_departure_time: r.train_departure_time ?? null,
          orario_barca: r.orario_barca ?? null,
          transport_code: r.transport_code ?? null,
          bus_city_origin: r.bus_city_origin ?? null,
          hotel_id: r.hotel_id ?? null,
          hotel_name: r.hotel_name ?? null,
          billing_party_name: r.billing_party_name ?? null,
          agency_id: r.agency_id ?? null,
          owner_label: owner,
          meeting_point: r.meeting_point ?? null,
          // Selezionato ma mai inoltrato prima: calcolato da calcPickupTime solo per
          // partenze treno/aereo (0106_pickup_calc_fields.sql), quindi spesso null per
          // i transfer porto-hotel importati — bookingListTransportTimes lo usa come
          // fallback dedicato, MAI come sostituto di return_pickup_time già esistente.
          pickup_hotel: departureLeg?.pickup_hotel ?? r.pickup_hotel ?? null,
          notes: r.notes ?? null,
          linked_service_id: r.linked_service_id ?? null,
          practice_number: r.practice_number ?? null,
          agency_booking_id: r.agency_booking_id ?? null,
          booking_group_id: r.booking_group_id ?? null,
          booking_group_name: r.booking_group_id ? bookingGroupNameById.get(r.booking_group_id) ?? null : null,
          outbound_ferry_departure_time: ferryPickupRule?.departureTime ?? arrivalLeg.time ?? null,
          outbound_ferry_arrival_time: isBus
            ? busArrivalTime
            : ferryPickupRule?.arrivalTime ?? arrivalSchedule?.arrivalTime ?? arrivalLeg.arrival_time ?? null,
          return_pickup_time: isBus
            ? busReturnPickupTime ?? departureLeg?.departure_time ?? null
            : departureLeg?.pickup_time ?? departurePickupRule?.pickup ?? departureLeg?.departure_time ?? null,
          return_ferry_departure_time: departureLeg?.orario_barca ?? departurePickupRule?.boat_t ?? null,
          bus_outward_pickup_point: isBus ? busPickupPoint(arrivalBusAllocation) : null,
          // Compagnia/porto ARRIVO: preferisce SEMPRE ferryPickupRule (stessa
          // regola canonica ferry_pickup_rules già usata per l'orario sopra —
          // mai una compagnia inventata) e ricade su arrivalSchedule (motore
          // commerciale ferry_schedules, legacy) solo quando nessuna regola
          // ferry_pickup_rules è applicabile (kind non treno/volo, o nessun
          // match) — comportamento invariato per quei casi.
          outbound_ferry_company: ferryPickupRule?.company?.toUpperCase() ?? arrivalSchedule?.company?.toUpperCase() ?? null,
          outbound_ferry_departure_port: arrivalSchedule ? ferryPortLabel(arrivalSchedule.departurePort) : null,
          outbound_ferry_arrival_port: ferryPickupRule ? ferryPortLabel(ferryPickupRule.arrivalPort) : arrivalSchedule ? ferryPortLabel(arrivalSchedule.arrivalPort) : null,
          // Compagnia/porto PARTENZA: preferisce i valori GIÀ CALCOLATI E
          // SALVATI sulla gamba di partenza (barca_compagnia/porto_bruno,
          // scritti da applyPickupCalc — stessa fonte canonica di un servizio
          // di partenza normale, valida anche per un record combinato
          // direction='arrival' con partenza reale nella stessa riga, es.
          // MATTIOLI 26/010806). returnSchedule (ferry_schedules, legacy)
          // resta un fallback per righe più vecchie mai passate da
          // applyPickupCalc.
          return_ferry_company: (departureLeg?.barca_compagnia ?? r.barca_compagnia)?.toUpperCase()
            ?? returnSchedule?.company?.toUpperCase() ?? null,
          return_ferry_departure_port: (departureLeg?.porto_bruno ?? r.porto_bruno)
            ? ferryPortLabel((departureLeg?.porto_bruno ?? r.porto_bruno) as string)
            : returnSchedule ? ferryPortLabel(returnSchedule.departurePort) : null,
          return_ferry_arrival_port: returnSchedule ? ferryPortLabel(returnSchedule.arrivalPort) : null,
          cancellation: cancellationLog ? {
            cancelled_at: cancellationLog.created_at,
            operator_name: cancellationLog.operator_name ?? cancellationLog.operator_email ?? null,
            reason: cancellationLog.after_data?.cancellation_reason ?? null,
            note: cancellationLog.after_data?.cancellation_note ?? null,
          } : null,
        };
      });

    return NextResponse.json({ ok: true, results });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore" },
      { status: 500 }
    );
  }
}
