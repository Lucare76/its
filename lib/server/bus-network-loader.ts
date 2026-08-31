import type { PricingAuthContext } from "@/lib/server/pricing-auth";
import {
  buildArrivalWindowSummary,
  buildBusUnitLoadSummary,
  buildGeographicSuggestions,
  buildStopLoadSummary,
  deriveServiceBusIdentity,
  suggestBusRedistribution,
  type RawBusUnit,
} from "@/lib/server/bus-network";
import { getCustomerFullName } from "@/lib/service-display";
import type { AgencyBookingServiceKind, OperationalServiceType } from "@/lib/types";

type BookingGroupStopLink = {
  id: string;
  stop_id: string | null;
  city?: string | null;
  pickup_point?: string | null;
  direction?: "arrival" | "departure" | string | null;
};

type CatalogStopLink = {
  id: string;
  bus_line_id: string;
  direction?: "arrival" | "departure" | string | null;
  stop_name?: string | null;
  city?: string | null;
  pickup_note?: string | null;
};

function normalizeStopText(value?: string | null) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function resolveCatalogStopForBookingGroupStop(groupStop: BookingGroupStopLink, catalogStops: CatalogStopLink[]) {
  if (groupStop.stop_id) return groupStop.stop_id;
  const city = normalizeStopText(groupStop.city);
  const pickup = normalizeStopText(groupStop.pickup_point);
  if (!city && !pickup) return null;

  const directionMatches = catalogStops.filter((stop) => !groupStop.direction || stop.direction === groupStop.direction);
  const exactPickupMatches = pickup
    ? directionMatches.filter((stop) =>
        normalizeStopText(stop.stop_name) === pickup ||
        normalizeStopText(stop.pickup_note) === pickup,
      )
    : [];
  if (exactPickupMatches.length === 1) return exactPickupMatches[0].id;

  const cityPickupMatches = pickup
    ? directionMatches.filter((stop) => {
        const stopCity = normalizeStopText(stop.city);
        const stopName = normalizeStopText(stop.stop_name);
        const stopNote = normalizeStopText(stop.pickup_note);
        return stopCity === city && (stopName.includes(pickup) || stopNote.includes(pickup));
      })
    : [];
  if (cityPickupMatches.length === 1) return cityPickupMatches[0].id;

  const exactCityMatches = directionMatches.filter((stop) =>
    normalizeStopText(stop.city) === city ||
    normalizeStopText(stop.stop_name) === city,
  );
  return exactCityMatches.length === 1 ? exactCityMatches[0].id : null;
}

/**
 * FASE A.5.1 §C — read-model condiviso di Linea Bus, estratto verbatim da
 * `app/api/ops/bus-network/route.ts` (era una funzione locale non testabile
 * direttamente). Nessun cambio di comportamento: stessa forma, stesse query,
 * stesso ordine — solo spostata qui per essere importata sia dalla route sia
 * dai test.
 */
export async function loadBusNetwork(auth: PricingAuthContext, date?: string) {
  const tenantId = auth.membership.tenant_id;
  const [linesResult, stopsResult, unitsResult, allocationsResult, allocationDetailsResult, movesResult, servicesResult, hotelsResult, pendingResult, bookingGroupStopsResult, bookingGroupsResult, driverDatesResult] = await Promise.all([
    auth.admin.from("tenant_bus_lines").select("*").eq("tenant_id", tenantId).order("family_code").order("name"),
    auth.admin.from("tenant_bus_line_stops").select("*").eq("tenant_id", tenantId).order("direction").order("order_index").order("stop_order"),
    auth.admin.from("tenant_bus_units").select("*").eq("tenant_id", tenantId).order("bus_line_id").order("sort_order"),
    auth.admin.from("tenant_bus_allocations").select("*").eq("tenant_id", tenantId),
    auth.admin.from("ops_bus_allocation_details").select("*").eq("tenant_id", tenantId),
    auth.admin.from("tenant_bus_allocation_moves").select("*").eq("tenant_id", tenantId).order("created_at", { ascending: false }).limit(80),
    auth.admin
      .from("services")
      .select("*")
      .eq("tenant_id", tenantId)
      .or("service_type_code.eq.bus_line,booking_service_kind.eq.bus_city_hotel,booking_group_id.not.is.null")
      .order("date")
      .order("time"),
    auth.admin.from("hotels").select("*").eq("tenant_id", tenantId),
    auth.admin.from("bus_import_pending").select("*").eq("tenant_id", tenantId).eq("status", "pending").order("created_at", { ascending: false }),
    auth.admin.from("booking_group_stops").select("id, stop_id, city, pickup_point, direction").eq("tenant_id", tenantId),
    auth.admin
      .from("booking_groups")
      .select("id, name, kind, status, contact_name, contact_phone, outbound_ferry_company, outbound_departure_port, outbound_ferry_time, outbound_arrival_port, return_ferry_company, return_departure_port, return_ferry_time, return_arrival_port")
      .eq("tenant_id", tenantId),
    date
      ? auth.admin.from("bus_unit_driver_dates").select("*").eq("tenant_id", tenantId).eq("travel_date", date)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const error =
    linesResult.error ||
    stopsResult.error ||
    unitsResult.error ||
    allocationsResult.error ||
    allocationDetailsResult.error ||
    movesResult.error ||
    servicesResult.error ||
    hotelsResult.error ||
    pendingResult.error ||
    bookingGroupStopsResult.error ||
    bookingGroupsResult.error;
  if (error) {
    throw new Error(error.message);
  }

  // Merge driver assignments per-date: sovrascrive i campi driver sull'unità
  const driverByUnit = new Map<string, { driver_name_outbound: string | null; driver_phone_outbound: string | null; driver_name_return: string | null; driver_phone_return: string | null }>(
    (driverDatesResult.data ?? []).map((d: { unit_id: string; driver_name_outbound: string | null; driver_phone_outbound: string | null; driver_name_return: string | null; driver_phone_return: string | null }) => [d.unit_id, d]),
  );

  const lines = linesResult.data ?? [];
  const stops = stopsResult.data ?? [];
  const allocations = allocationsResult.data ?? [];
  const services = servicesResult.data ?? [];
  const exclusiveGroupLineIds = new Set(
    ((lines ?? []) as Array<{ id: string; code?: string | null; family_code?: string | null }>)
      .filter((line) => line.code === "GRUPPI_ESCLUSIVI" || line.family_code === "GRUPPI_ESCLUSIVI")
      .map((line) => line.id),
  );
  const hotels = hotelsResult.data ?? [];
  const hotelsById = new Map<string, { id: string; name: string; zone: string }>(hotels.map((hotel: { id: string; name: string; zone: string }) => [hotel.id, hotel]));
  const bookingGroupKindById = new Map(
    ((bookingGroupsResult.data ?? []) as Array<{ id: string; kind: string | null }>).map((group) => [group.id, group.kind]),
  );
  const bookingGroupNameById = new Map(
    ((bookingGroupsResult.data ?? []) as Array<{ id: string; name: string | null }>).map((group) => [group.id, group.name]),
  );
  const bookingGroupContactById = new Map(
    ((bookingGroupsResult.data ?? []) as Array<{ id: string; contact_name: string | null; contact_phone: string | null }>).map((group) => [
      group.id,
      { contact_name: group.contact_name, contact_phone: group.contact_phone },
    ]),
  );
  const bookingGroupFerryById = new Map(
    ((bookingGroupsResult.data ?? []) as Array<{
      id: string;
      outbound_ferry_company: string | null;
      outbound_departure_port: string | null;
      outbound_ferry_time: string | null;
      outbound_arrival_port: string | null;
      return_ferry_company: string | null;
      return_departure_port: string | null;
      return_ferry_time: string | null;
      return_arrival_port: string | null;
    }>).map((group) => [
      group.id,
      {
        outbound_ferry_company: group.outbound_ferry_company,
        outbound_departure_port: group.outbound_departure_port,
        outbound_ferry_time: group.outbound_ferry_time,
        outbound_arrival_port: group.outbound_arrival_port,
        return_ferry_company: group.return_ferry_company,
        return_departure_port: group.return_departure_port,
        return_ferry_time: group.return_ferry_time,
        return_arrival_port: group.return_arrival_port,
      },
    ]),
  );
  const cancelledBookingGroupIds = new Set(
    ((bookingGroupsResult.data ?? []) as Array<{ id: string; status: string | null }>)
      .filter((group) => group.status === "cancelled")
      .map((group) => group.id),
  );
  const catalogStopRows = stops as CatalogStopLink[];
  const bookingGroupStopCatalogById = new Map(
    (bookingGroupStopsResult.data ?? []).map((stop: BookingGroupStopLink) => [
      stop.id,
      resolveCatalogStopForBookingGroupStop(stop, catalogStopRows),
    ]),
  );

  // Applica driver per-data alle unità (sovrascrive i campi statici con quelli del giorno)
  const units = (unitsResult.data ?? []).map((u: Record<string, unknown>) => {
    const dayDriver = driverByUnit.get(u.id as string);
    return {
      ...u,
      driver_name_outbound: dayDriver?.driver_name_outbound ?? null,
      driver_phone_outbound: dayDriver?.driver_phone_outbound ?? null,
      driver_name_return: dayDriver?.driver_name_return ?? null,
      driver_phone_return: dayDriver?.driver_phone_return ?? null,
    };
  }) as unknown as RawBusUnit[];

  const activeServices = services.filter((service: { status?: string | null; booking_group_id?: string | null }) =>
    service.status !== "cancelled" &&
    (!service.booking_group_id || !cancelledBookingGroupIds.has(service.booking_group_id)),
  );
  const inactiveServiceIds = new Set(
    services
      .filter((service: { id: string; status?: string | null; booking_group_id?: string | null }) =>
        service.status === "cancelled" ||
        Boolean(service.booking_group_id && cancelledBookingGroupIds.has(service.booking_group_id)),
      )
      .map((service: { id: string }) => service.id),
  );

  const enrichedServices = activeServices.map((service: {
    id: string;
    customer_name: string;
    customer_first_name?: string | null;
    customer_last_name?: string | null;
    date: string;
    time: string;
    pax: number;
    direction: "arrival" | "departure";
    bus_city_origin?: string | null;
    transport_code?: string | null;
    phone?: string | undefined;
    phone_e164?: string | null | undefined;
    hotel_id: string;
    meeting_point?: string | null;
    notes?: string;
    booking_service_kind?: AgencyBookingServiceKind | null | undefined;
    service_type_code?: OperationalServiceType | null | undefined;
    booking_group_id?: string | null;
    booking_group_stop_id?: string | null;
    outbound_time?: string | null;
  }) => {
    const identity = deriveServiceBusIdentity(service);
    const hotel = hotelsById.get(service.hotel_id);
    const hotelFromNotes = service.notes?.match(/Hotel:\s*([^·|\n]+)/)?.[1]?.trim();
    const bookingGroupContact = service.booking_group_id ? bookingGroupContactById.get(service.booking_group_id) : null;
    const bookingGroupFerry = service.booking_group_id ? bookingGroupFerryById.get(service.booking_group_id) : null;
    return {
      ...service,
      customer_display_name: getCustomerFullName(service),
      phone_display: service.phone_e164 ?? service.phone ?? "N/D",
      booking_group_contact_name: bookingGroupContact?.contact_name ?? null,
      booking_group_contact_phone: bookingGroupContact?.contact_phone ?? null,
      booking_group_outbound_ferry_company: bookingGroupFerry?.outbound_ferry_company ?? null,
      booking_group_outbound_departure_port: bookingGroupFerry?.outbound_departure_port ?? null,
      booking_group_outbound_ferry_time: bookingGroupFerry?.outbound_ferry_time ?? null,
      booking_group_outbound_arrival_port: bookingGroupFerry?.outbound_arrival_port ?? null,
      booking_group_return_ferry_company: bookingGroupFerry?.return_ferry_company ?? null,
      booking_group_return_departure_port: bookingGroupFerry?.return_departure_port ?? null,
      booking_group_return_ferry_time: bookingGroupFerry?.return_ferry_time ?? null,
      booking_group_return_arrival_port: bookingGroupFerry?.return_arrival_port ?? null,
      hotel_name: hotel?.name ?? hotelFromNotes ?? "Hotel N/D",
      hotel_zone: hotel?.zone ?? null,
      derived_family_code: identity.family_code,
      derived_family_name: identity.family_name,
      derived_line_code: identity.lineCode,
      derived_line_name: identity.lineName,
      suggested_stop_name: identity.stop_name,
      booking_group_kind: service.booking_group_id ? bookingGroupKindById.get(service.booking_group_id) ?? null : null,
      booking_group_name: service.booking_group_id ? bookingGroupNameById.get(service.booking_group_id) ?? null : null,
      booking_group_catalog_stop_id: service.booking_group_stop_id ? bookingGroupStopCatalogById.get(service.booking_group_stop_id) ?? null : null,
    };
  });

  const enrichedServiceById = new Map(
    enrichedServices.map((service: { id: string; booking_group_kind?: string | null }) => [service.id, service]),
  );
  const shouldExposeAllocation = (allocation: { service_id: string; bus_line_id?: string | null }) => {
    if (inactiveServiceIds.has(allocation.service_id)) return false;
    const service = enrichedServiceById.get(allocation.service_id);
    if (service?.booking_group_kind === "bus_exclusive") {
      return Boolean(allocation.bus_line_id && exclusiveGroupLineIds.has(allocation.bus_line_id));
    }
    return true;
  };
  const visibleAllocations = allocations.filter((allocation: { service_id: string; bus_line_id?: string | null }) => shouldExposeAllocation(allocation));
  const visibleAllocationDetails = (allocationDetailsResult.data ?? []).filter((allocation: { service_id: string; bus_line_id?: string | null }) => shouldExposeAllocation(allocation));

  const unitLoads = buildBusUnitLoadSummary(units, visibleAllocations);
  const stopLoads = buildStopLoadSummary(stops, visibleAllocations);
  const suggestions = buildGeographicSuggestions({ services, hotels, stops });
  const redistribution = suggestBusRedistribution(units, allocations);
  const arrivalWindows = buildArrivalWindowSummary(
    services.filter((service: { booking_service_kind?: string | null; service_type_code?: string | null }) =>
      service.booking_service_kind === "transfer_port_hotel" ||
      service.booking_service_kind === "transfer_train_hotel" ||
      service.booking_service_kind === "transfer_airport_hotel" ||
      service.service_type_code === "transfer_port_hotel",
    ),
  );

  // Bus di distribuzione (smistamento Ischia + Pozzuoli)
  const [distBusesResult, distAllocResult, distVehiclesResult, distDriversResult, ferryConfigResult] = await Promise.all([
    auth.admin.from("bus_ischia_dist_buses").select("*").eq("tenant_id", tenantId).order("sort_order").order("zone"),
    auth.admin.from("bus_ischia_dist_allocations").select("*").eq("tenant_id", tenantId),
    auth.admin.from("vehicles").select("id, label, plate, capacity").eq("tenant_id", tenantId).order("label"),
    auth.admin.from("driver_profiles").select("id, full_name, phone").eq("tenant_id", tenantId).eq("active", true).order("full_name"),
    auth.admin.from("bus_line_ferry_config").select("*").eq("tenant_id", tenantId).order("sort_order"),
  ]);

  const allDistBuses = (distBusesResult.data ?? []) as Array<Record<string, unknown>>;

  return {
    lines,
    stops,
    units,
    allocations: visibleAllocations,
    allocation_details: visibleAllocationDetails,
    moves: movesResult.data ?? [],
    services: enrichedServices,
    unit_loads: unitLoads,
    stop_loads: stopLoads,
    geographic_suggestions: suggestions,
    redistribution_suggestions: redistribution,
    arrival_windows: arrivalWindows,
    pending_passengers: pendingResult.data ?? [],
    ischia_dist_buses: allDistBuses.filter((b) => !b.section || b.section === "ischia"),
    pozzuoli_dist_buses: allDistBuses.filter((b) => b.section === "pozzuoli"),
    ischia_dist_allocations: distAllocResult.data ?? [],
    ischia_dist_vehicles: distVehiclesResult.data ?? [],
    ischia_dist_drivers: distDriversResult.data ?? [],
    hotels_list: hotelsResult.data ?? [],
    bus_line_ferry_config: ferryConfigResult.data ?? [],
  };
}
