import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { collapseLinkedBookingPairs, filterBookingsBySearch } from "@/lib/booking-search";
import { ferryPortLabel, findArrivalScheduleForService, findDepartureScheduleForService, type FerryScheduleRow } from "@/lib/ferry-schedule-options";
import { getPickupRuleByRange, normalizeZonaIschia } from "@/lib/departure-pickup-rules";
import { findFerryPickupRule, resolveAgencyLogic, type FerryPickupRule } from "@/lib/ferry-pickup-rules";
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
  "created_at",
].join(", ");

type SearchServiceRow = Partial<Service> & {
  id: string;
  created_at?: string | null;
  hotel_name?: string | null;
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

function phoneNeedles(value: string): string[] {
  const digits = value.replace(/\D/g, "");
  if (!digits) return [];
  const candidates = [digits];
  if (digits.startsWith("39") && digits.length > 6) candidates.push(digits.slice(2));
  if (digits.length > 10) candidates.push(digits.slice(-10));
  return Array.from(new Set(candidates.filter((candidate) => candidate.length >= 4)));
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

async function querySearchCandidates(
  admin: SearchAdminClient,
  tenantId: string,
  input: {
    q: string;
    agency: string;
    limit: number;
    matchedHotelIds: string[];
    matchedAgencyIds: string[];
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
    .filter((service) => service.is_draft !== true);
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

    const { matchedHotels, matchedAgencies } = await loadLookupMatches(auth.admin, tenantId, q, agency);
    const candidateServices = await querySearchCandidates(auth.admin, tenantId, {
      q,
      agency,
      limit,
      matchedHotelIds: matchedHotels.map((hotel) => hotel.id),
      matchedAgencyIds: matchedAgencies.map((agencyRow) => agencyRow.id),
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
    const serviceIds = Array.from(new Set(serviceRows.map((service) => service.id).filter(Boolean)));

    const [hotelsResult, agenciesResult, schedulesResult, ferryPickupRulesResult, busAllocationsResult, busFerryConfigsResult, busStopsResult, busLinesResult, hotelPickupTimesResult] = await Promise.all([
      hotelIds.length
        ? auth.admin.from("hotels").select("id,name,zone").eq("tenant_id", tenantId).in("id", hotelIds)
        : Promise.resolve({ data: [], error: null }),
      agencyIds.length
        ? auth.admin.from("agencies").select("id,name").eq("tenant_id", tenantId).in("id", agencyIds)
        : Promise.resolve({ data: [], error: null }),
      auth.admin.from("ferry_schedules").select("company,departure_port,arrival_port,departure_time,arrival_time,direction,days_of_week,valid_from,valid_to"),
      auth.admin.from("ferry_pickup_rules").select("*"),
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
    ]);

    const error = hotelsResult.error ?? agenciesResult.error ?? schedulesResult.error ?? ferryPickupRulesResult.error ?? busAllocationsResult.error ?? busFerryConfigsResult.error ?? busStopsResult.error ?? busLinesResult.error ?? hotelPickupTimesResult.error ?? null;
    if (error) throw new Error(error.message);

    const hotelNameById = new Map([...(matchedHotels ?? []), ...(hotelsResult.data ?? [])].map((hotel: { id: string; name: string }) => [hotel.id, hotel.name]));
    const hotelZoneById = new Map([...(matchedHotels ?? []), ...(hotelsResult.data ?? [])].map((hotel: { id: string; zone?: string | null }) => [hotel.id, hotel.zone ?? null]));
    const agencyNameById = new Map([...(matchedAgencies ?? []), ...(agenciesResult.data ?? [])].map((item: { id: string; name: string }) => [item.id, item.name]));
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
    const searchable = candidateServices
      .map((service) => ({
        ...service,
        hotel_name: service.hotel_id ? hotelNameById.get(service.hotel_id) ?? null : null,
      }));

    const results = collapseLinkedBookingPairs(
      filterBookingsBySearch(searchable, q, agency, agencyNameById, Math.max(limit * 2, 100))
    ).slice(0, limit)
      .map((r) => {
        const linked = r.linked_service_id
          ? serviceById.get(String(r.linked_service_id))
          : null;
        const arrivalLeg = r.direction === "arrival" ? r : linked?.direction === "arrival" ? linked : r;
        const departureLeg = r.direction === "departure" ? r : linked?.direction === "departure" ? linked : null;
        const schedules = (schedulesResult.data ?? []) as FerryScheduleRow[];
        const ferryPickupRules = (ferryPickupRulesResult.data ?? []) as FerryPickupRule[];
        const joinedName = [r.customer_first_name, r.customer_last_name].filter(Boolean).join(" ").trim();
        const owner = r.billing_party_name ?? (r.agency_id ? agencyNameById.get(r.agency_id) : null) ?? "Privato";
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
          notes: r.notes ?? null,
          linked_service_id: r.linked_service_id ?? null,
          outbound_ferry_departure_time: ferryPickupRule?.departureTime ?? arrivalLeg.time ?? null,
          outbound_ferry_arrival_time: isBus
            ? busArrivalTime
            : ferryPickupRule?.arrivalTime ?? arrivalSchedule?.arrivalTime ?? arrivalLeg.arrival_time ?? null,
          return_pickup_time: isBus
            ? busReturnPickupTime ?? departureLeg?.departure_time ?? null
            : departureLeg?.pickup_time ?? departurePickupRule?.pickup ?? departureLeg?.departure_time ?? null,
          return_ferry_departure_time: departureLeg?.orario_barca ?? departurePickupRule?.boat_t ?? null,
          bus_outward_pickup_point: isBus ? busPickupPoint(arrivalBusAllocation) : null,
          outbound_ferry_company: arrivalSchedule?.company?.toUpperCase() ?? null,
          outbound_ferry_departure_port: arrivalSchedule ? ferryPortLabel(arrivalSchedule.departurePort) : null,
          outbound_ferry_arrival_port: arrivalSchedule ? ferryPortLabel(arrivalSchedule.arrivalPort) : null,
          return_ferry_company: returnSchedule?.company?.toUpperCase() ?? null,
          return_ferry_departure_port: returnSchedule ? ferryPortLabel(returnSchedule.departurePort) : null,
          return_ferry_arrival_port: returnSchedule ? ferryPortLabel(returnSchedule.arrivalPort) : null,
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
