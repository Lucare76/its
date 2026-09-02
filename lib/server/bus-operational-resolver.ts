import type { SupabaseClient } from "@supabase/supabase-js";

export type BusOperationalResolutionSource =
  | "allocation"
  | "bus_city_origin"
  | "service_fields"
  | "unresolved";

export type BusOperationalServiceInput = {
  id: string;
  tenant_id?: string | null;
  direction?: string | null;
  date?: string | null;
  time?: string | null;
  departure_time?: string | null;
  pickup_time?: string | null;
  booking_service_kind?: string | null;
  service_type_code?: string | null;
  bus_city_origin?: string | null;
  transport_code?: string | null;
  vessel?: string | null;
  hotel_id?: string | null;
  meeting_point?: string | null;
  // Obiettivo A (bus_exclusive vince sulla città): per risolvere il gruppo
  // senza una query aggiuntiva per service, serve solo l'id — il kind si
  // legge da context.bookingGroupKindById.
  booking_group_id?: string | null;
};

export type BusOperationalResolution = {
  serviceId: string;
  lineName: string | null;
  familyCode: string | null;
  stopName: string | null;
  stopPickupNote: string | null;
  hotelPickupTime: string | null;
  destinationLabel: string | null;
  resolutionSource: BusOperationalResolutionSource;
};

type BusAllocationDetailRow = {
  service_id: string;
  direction: string | null;
  family_code: string | null;
  line_name: string | null;
  stop_name: string | null;
  stop_city: string | null;
  stop_pickup_note: string | null;
  stop_pickup_time: string | null;
  hotel_pickup_time: string | null;
};

type BusLineRow = {
  id: string;
  family_code: string | null;
  name: string | null;
};

type BusStopRow = {
  id: string;
  bus_line_id: string;
  direction: string | null;
  stop_name: string | null;
  city: string | null;
  pickup_note: string | null;
  pickup_time: string | null;
};

type HotelRow = {
  id: string;
  name: string;
};

type HotelPickupTimeRow = {
  hotel_name: string | null;
  pickup_time_linea_italia: string | null;
  pickup_time_linea_centro: string | null;
  pickup_time_linea_adriatica: string | null;
};

export type BusOperationalResolverContext = {
  allocationsByServiceId: Map<string, BusAllocationDetailRow[]>;
  stops: BusStopRow[];
  lineById: Map<string, BusLineRow>;
  hotelNameById: Map<string, string>;
  hotelPickupTimes: HotelPickupTimeRow[];
  // Obiettivo A: kind del booking_group per service.booking_group_id — mai
  // una query per service, un'unica select su booking_groups a monte.
  bookingGroupKindById: Map<string, string | null>;
};

// Stesso codice/famiglia gia' usato altrove (bus-network-loader.ts,
// booking-groups-service.ts) per la linea "Bus esclusivi gruppi" — non e'
// un dato di business (nome gruppo/bus), e' il codice di sistema stabile
// della linea dedicata ai gruppi esclusivi.
const EXCLUSIVE_GROUP_FAMILY_CODE = "GRUPPI_ESCLUSIVI";

export function normalizeBusOperationalNeedle(value?: string | null) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function cleanOperationalClock(value?: string | null, options?: { allowMidnight?: boolean }) {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^([01]\d|2[0-3]):([0-5]\d)/);
  if (!match) return null;
  const time = `${match[1]}:${match[2]}`;
  if (!options?.allowMidnight && time === "00:00") return null;
  return time;
}

export function isBusOperationalService(service: BusOperationalServiceInput) {
  const source = normalizeBusOperationalNeedle([
    service.booking_service_kind,
    service.service_type_code,
    service.transport_code,
    service.vessel,
    service.bus_city_origin,
  ].filter(Boolean).join(" "));
  return (
    service.booking_service_kind === "bus_city_hotel" ||
    service.service_type_code === "bus_line" ||
    /\b(linea bus|bus line|bus)\b/.test(source)
  );
}

function familyFromText(value?: string | null) {
  const normalized = normalizeBusOperationalNeedle(value);
  if (!normalized) return null;
  if (normalized.includes("italia")) return "ITALIA";
  if (normalized.includes("centro")) return "CENTRO";
  if (normalized.includes("adriatica")) return "ADRIATICA";
  return null;
}

function hotelPickupForFamily(
  hotelName: string | null | undefined,
  familyCode: string | null | undefined,
  rows: HotelPickupTimeRow[]
) {
  const normalizedHotel = normalizeBusOperationalNeedle(hotelName);
  if (!normalizedHotel) return null;
  const row = rows.find((item) => {
    const current = normalizeBusOperationalNeedle(item.hotel_name);
    if (!current) return false;
    return current === normalizedHotel || current.includes(normalizedHotel) || normalizedHotel.includes(current);
  });
  if (!row) return null;
  const family = normalizeBusOperationalNeedle(familyCode);
  if (family === "italia") return cleanOperationalClock(row.pickup_time_linea_italia);
  if (family === "centro") return cleanOperationalClock(row.pickup_time_linea_centro);
  if (family === "adriatica") return cleanOperationalClock(row.pickup_time_linea_adriatica);
  return null;
}

function pickAllocation(service: BusOperationalServiceInput, context: BusOperationalResolverContext) {
  const rows = context.allocationsByServiceId.get(service.id) ?? [];
  if (rows.length === 0) return null;
  return rows.find((row) => row.direction === "departure") ?? rows[0] ?? null;
}

function findStopFallback(service: BusOperationalServiceInput, context: BusOperationalResolverContext) {
  const city = normalizeBusOperationalNeedle(service.bus_city_origin);
  if (!city) return null;
  const requestedFamily = familyFromText(service.transport_code) ?? familyFromText(service.vessel);
  const requestedTime =
    cleanOperationalClock(service.pickup_time) ??
    cleanOperationalClock(service.departure_time) ??
    cleanOperationalClock(service.time);

  const matches = context.stops.filter((stop) => {
    if (stop.direction !== "departure") return false;
    const line = context.lineById.get(stop.bus_line_id);
    if (requestedFamily && normalizeBusOperationalNeedle(line?.family_code) !== requestedFamily.toLowerCase()) return false;
    const stopName = normalizeBusOperationalNeedle(stop.stop_name);
    const stopCity = normalizeBusOperationalNeedle(stop.city);
    return stopName === city || stopCity === city;
  });
  if (matches.length === 0) return null;

  return (
    matches.find((stop) => cleanOperationalClock(stop.pickup_time) === requestedTime) ??
    matches[0] ??
    null
  );
}

export function resolveBusOperationalService(
  service: BusOperationalServiceInput,
  context: BusOperationalResolverContext
): BusOperationalResolution {
  const empty: BusOperationalResolution = {
    serviceId: service.id,
    lineName: null,
    familyCode: null,
    stopName: null,
    stopPickupNote: null,
    hotelPickupTime: null,
    destinationLabel: null,
    resolutionSource: "unresolved",
  };

  if (!isBusOperationalService(service)) return empty;

  const hotelName = service.hotel_id ? context.hotelNameById.get(service.hotel_id) ?? null : null;
  const allocation = pickAllocation(service, context);
  if (allocation) {
    const hotelPickup =
      cleanOperationalClock(allocation.hotel_pickup_time) ??
      hotelPickupForFamily(hotelName, allocation.family_code, context.hotelPickupTimes);
    const stopName = allocation.stop_name ?? allocation.stop_city ?? null;
    return {
      serviceId: service.id,
      lineName: allocation.line_name,
      familyCode: allocation.family_code,
      stopName,
      stopPickupNote: allocation.stop_pickup_note,
      hotelPickupTime: hotelPickup,
      destinationLabel: stopName,
      resolutionSource: "allocation",
    };
  }

  // Obiettivo A: bus_exclusive vince SEMPRE sulla città — senza
  // un'allocazione reale (unico caso già gestito sopra, dati veri), mai
  // ricadere sul match geografico per città (findStopFallback), che
  // classificherebbe erroneamente Cattolica/Pesaro/Fano/Marotta come Linea
  // Adriatica solo perché quei nomi coincidono con fermate reali di
  // quell'altra linea.
  const groupKind = service.booking_group_id ? context.bookingGroupKindById.get(service.booking_group_id) ?? null : null;
  if (groupKind === "bus_exclusive") {
    const exclusiveLine = Array.from(context.lineById.values())
      .find((line) => line.family_code === EXCLUSIVE_GROUP_FAMILY_CODE);
    const stopName = service.bus_city_origin ?? service.meeting_point ?? null;
    return {
      serviceId: service.id,
      lineName: exclusiveLine?.name ?? "Bus esclusivi gruppi",
      familyCode: EXCLUSIVE_GROUP_FAMILY_CODE,
      stopName,
      stopPickupNote: null,
      hotelPickupTime: null,
      destinationLabel: stopName,
      resolutionSource: "service_fields",
    };
  }

  const stop = findStopFallback(service, context);
  if (stop) {
    const line = context.lineById.get(stop.bus_line_id);
    const familyCode = line?.family_code ?? null;
    const hotelPickup = hotelPickupForFamily(hotelName, familyCode, context.hotelPickupTimes);
    const stopName = stop.stop_name ?? stop.city ?? null;
    return {
      serviceId: service.id,
      lineName: line?.name ?? null,
      familyCode,
      stopName,
      stopPickupNote: stop.pickup_note,
      hotelPickupTime: hotelPickup,
      destinationLabel: stopName,
      resolutionSource: "bus_city_origin",
    };
  }

  const fallbackStop = service.bus_city_origin ?? service.meeting_point ?? null;
  return {
    serviceId: service.id,
    lineName: service.transport_code ?? service.vessel ?? null,
    familyCode: familyFromText(service.transport_code) ?? familyFromText(service.vessel),
    stopName: fallbackStop,
    stopPickupNote: null,
    hotelPickupTime: cleanOperationalClock(service.pickup_time),
    destinationLabel: fallbackStop,
    resolutionSource: fallbackStop ? "service_fields" : "unresolved",
  };
}

export function applyBusOperationalResolution<T extends Record<string, unknown>>(
  service: T,
  resolution: BusOperationalResolution
): T {
  return {
    ...service,
    bus_operational_line_name: resolution.lineName,
    bus_operational_family_code: resolution.familyCode,
    bus_operational_stop_name: resolution.stopName,
    bus_operational_stop_pickup_note: resolution.stopPickupNote,
    bus_operational_hotel_pickup_time: resolution.hotelPickupTime,
    bus_operational_destination_label: resolution.destinationLabel,
    bus_operational_resolution_source: resolution.resolutionSource,
  };
}

export async function enrichServicesWithBusOperationalResolution<T extends Record<string, unknown>>(
  admin: SupabaseClient,
  tenantId: string,
  services: T[]
): Promise<T[]> {
  const busServices = services.filter((service) =>
    isBusOperationalService(service as unknown as BusOperationalServiceInput)
  );
  if (busServices.length === 0) return services;

  const serviceIds = busServices.map((service) => String(service.id)).filter(Boolean);
  const bookingGroupIds = Array.from(new Set(
    busServices
      .map((service) => (service as unknown as BusOperationalServiceInput).booking_group_id)
      .filter((id): id is string => Boolean(id)),
  ));
  const [allocationsResult, linesResult, stopsResult, hotelsResult, pickupTimesResult, bookingGroupsResult] = await Promise.all([
    serviceIds.length > 0
      ? admin
          .from("ops_bus_allocation_details")
          .select("service_id,direction,family_code,line_name,stop_name,stop_city,stop_pickup_note,stop_pickup_time,hotel_pickup_time")
          .eq("tenant_id", tenantId)
          .in("service_id", serviceIds)
      : Promise.resolve({ data: [], error: null }),
    admin
      .from("tenant_bus_lines")
      .select("id,family_code,name")
      .eq("tenant_id", tenantId)
      .eq("active", true),
    admin
      .from("tenant_bus_line_stops")
      .select("id,bus_line_id,direction,stop_name,city,pickup_note,pickup_time")
      .eq("tenant_id", tenantId)
      .eq("active", true),
    admin.from("hotels").select("id,name").eq("tenant_id", tenantId),
    admin
      .from("hotel_pickup_times")
      .select("hotel_name,pickup_time_linea_italia,pickup_time_linea_centro,pickup_time_linea_adriatica"),
    // Obiettivo A: serve solo il kind, per il gate bus_exclusive.
    bookingGroupIds.length > 0
      ? admin.from("booking_groups").select("id,kind").eq("tenant_id", tenantId).in("id", bookingGroupIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const error =
    allocationsResult.error ??
    linesResult.error ??
    stopsResult.error ??
    hotelsResult.error ??
    pickupTimesResult.error ??
    bookingGroupsResult.error;
  if (error) throw new Error(error.message);

  const allocationsByServiceId = new Map<string, BusAllocationDetailRow[]>();
  for (const allocation of (allocationsResult.data ?? []) as BusAllocationDetailRow[]) {
    const rows = allocationsByServiceId.get(allocation.service_id) ?? [];
    rows.push(allocation);
    allocationsByServiceId.set(allocation.service_id, rows);
  }

  const context: BusOperationalResolverContext = {
    allocationsByServiceId,
    stops: (stopsResult.data ?? []) as BusStopRow[],
    lineById: new Map(((linesResult.data ?? []) as BusLineRow[]).map((line) => [line.id, line])),
    hotelNameById: new Map(((hotelsResult.data ?? []) as HotelRow[]).map((hotel) => [hotel.id, hotel.name])),
    hotelPickupTimes: (pickupTimesResult.data ?? []) as HotelPickupTimeRow[],
    bookingGroupKindById: new Map(((bookingGroupsResult.data ?? []) as Array<{ id: string; kind: string | null }>).map((g) => [g.id, g.kind])),
  };

  return services.map((service) => {
    const operationalService = service as unknown as BusOperationalServiceInput;
    if (!isBusOperationalService(operationalService)) return service;
    const resolution = resolveBusOperationalService(operationalService, context);
    return applyBusOperationalResolution(service, resolution);
  });
}
