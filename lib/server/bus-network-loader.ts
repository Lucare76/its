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

/**
 * FASE A.5.1 §C — read-model condiviso di Linea Bus, estratto verbatim da
 * `app/api/ops/bus-network/route.ts` (era una funzione locale non testabile
 * direttamente). Nessun cambio di comportamento: stessa forma, stesse query,
 * stesso ordine — solo spostata qui per essere importata sia dalla route sia
 * dai test.
 */
export async function loadBusNetwork(auth: PricingAuthContext, date?: string) {
  const tenantId = auth.membership.tenant_id;
  const [linesResult, stopsResult, unitsResult, allocationsResult, allocationDetailsResult, movesResult, servicesResult, hotelsResult, pendingResult, driverDatesResult] = await Promise.all([
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
      .or("service_type_code.eq.bus_line,booking_service_kind.eq.bus_city_hotel")
      .order("date")
      .order("time"),
    auth.admin.from("hotels").select("*").eq("tenant_id", tenantId),
    auth.admin.from("bus_import_pending").select("*").eq("tenant_id", tenantId).eq("status", "pending").order("created_at", { ascending: false }),
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
    pendingResult.error;
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
  const hotels = hotelsResult.data ?? [];
  const hotelsById = new Map<string, { id: string; name: string; zone: string }>(hotels.map((hotel: { id: string; name: string; zone: string }) => [hotel.id, hotel]));

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

  const enrichedServices = services.map((service: {
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
    outbound_time?: string | null;
  }) => {
    const identity = deriveServiceBusIdentity(service);
    const hotel = hotelsById.get(service.hotel_id);
    const hotelFromNotes = service.notes?.match(/Hotel:\s*([^·|\n]+)/)?.[1]?.trim();
    return {
      ...service,
      customer_display_name: getCustomerFullName(service),
      phone_display: service.phone_e164 ?? service.phone ?? "N/D",
      hotel_name: hotel?.name ?? hotelFromNotes ?? "Hotel N/D",
      hotel_zone: hotel?.zone ?? null,
      derived_family_code: identity.family_code,
      derived_family_name: identity.family_name,
      derived_line_code: identity.lineCode,
      derived_line_name: identity.lineName,
      suggested_stop_name: identity.stop_name,
    };
  });

  const unitLoads = buildBusUnitLoadSummary(units, allocations);
  const stopLoads = buildStopLoadSummary(stops, allocations);
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
    allocations,
    allocation_details: allocationDetailsResult.data ?? [],
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
