import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import type { PricingAuthContext } from "@/lib/server/pricing-auth";
import {
  buildArrivalWindowSummary,
  buildBusUnitLoadSummary,
  buildGeographicSuggestions,
  buildStopLoadSummary,
  deriveServiceBusIdentity,
  getDefaultBusNetworkLines,
  getDefaultBusUnitsForFamily,
  getDefaultStopsForLine,
  suggestBusRedistribution,
  type RawBusUnit
} from "@/lib/server/bus-network";
import { findBusStopsByCity, resolveBusStop } from "@/lib/server/bus-lines-catalog";
import { resolveHotelMatch } from "@/lib/server/hotel-matching";
import { geocodeCity, geocodeCityName } from "@/lib/server/geocoding";
import { getCustomerFullName } from "@/lib/service-display";
import type { AgencyBookingServiceKind, OperationalServiceType } from "@/lib/types";
import { validateBusAllocationRequest, validateBusMoveRequest } from "@/lib/server/bus-network-validation";
import { sendBusLowSeatAlertEmail } from "@/lib/server/bus-alert-email";
import { ensureWhatsAppContact } from "@/lib/server/whatsapp/contacts";

// ── Helper geografico per ordinamento fermate Ischia ────────────────────────
const PORTO_ISCHIA = { lat: 40.7427, lng: 13.9567 };
const ZONE_LABELS: Record<string, string> = {
  ischia: "Bus Ischia Porto", barano: "Bus Barano", casamicciola: "Bus Casamicciola",
  lacco: "Bus Lacco Ameno", forio: "Bus Forio", "sant'angelo": "Bus Sant'Angelo", serrara: "Bus Serrara",
};

function sortPassengersByRoute<T extends { hotel_name: string }>(
  passengers: T[],
  coordMap: Map<string, { lat: number; lng: number }>
): Array<T & { stop_order: number }> {
  // Raggruppa per hotel
  const byHotel = new Map<string, T[]>();
  for (const p of passengers) {
    const b = byHotel.get(p.hotel_name) ?? [];
    b.push(p);
    byHotel.set(p.hotel_name, b);
  }
  const withCoords = [...byHotel.keys()].filter(h => coordMap.has(h));
  const noCoords   = [...byHotel.keys()].filter(h => !coordMap.has(h));

  // Nearest-neighbor dal porto Ischia
  const visited = new Set<string>();
  const ordered: string[] = [];
  let cur = PORTO_ISCHIA;
  while (ordered.length < withCoords.length) {
    let best: string | null = null, bestDist = Infinity;
    for (const h of withCoords) {
      if (visited.has(h)) continue;
      const c = coordMap.get(h)!;
      const d = (c.lat - cur.lat) ** 2 + (c.lng - cur.lng) ** 2;
      if (d < bestDist) { bestDist = d; best = h; }
    }
    if (!best) break;
    visited.add(best); ordered.push(best); cur = coordMap.get(best)!;
  }
  ordered.push(...noCoords);

  const result: Array<T & { stop_order: number }> = [];
  let stopIdx = 0;
  for (const hotel of ordered) {
    for (const p of byHotel.get(hotel) ?? []) result.push({ ...p, stop_order: stopIdx });
    stopIdx++;
  }
  return result;
}

async function checkAndAlertLowSeats(
  auth: PricingAuthContext,
  tenantId: string,
  busUnitId: string,
  serviceDate?: string
): Promise<{ busLabel: string; lineName: string; remainingSeats: number; threshold: number } | null> {
  const unitResult = await auth.admin
    .from("tenant_bus_units")
    .select("id,bus_line_id,label,capacity,low_seat_threshold")
    .eq("tenant_id", tenantId)
    .eq("id", busUnitId)
    .maybeSingle();
  if (unitResult.error || !unitResult.data) return null;

  let resolvedDate = serviceDate;
  if (!resolvedDate) {
    const sampleAlloc = await auth.admin
      .from("tenant_bus_allocations")
      .select("service_id")
      .eq("tenant_id", tenantId)
      .eq("bus_unit_id", busUnitId)
      .limit(1)
      .maybeSingle();
    if (sampleAlloc.data?.service_id) {
      const svc = await auth.admin
        .from("services")
        .select("date")
        .eq("id", (sampleAlloc.data as { service_id: string }).service_id)
        .maybeSingle();
      resolvedDate = (svc.data as { date?: string } | null)?.date ?? undefined;
    }
  }

  let allocQuery = auth.admin
    .from("tenant_bus_allocations")
    .select("pax_assigned, services!inner(date)")
    .eq("tenant_id", tenantId)
    .eq("bus_unit_id", busUnitId);
  if (resolvedDate) {
    allocQuery = allocQuery.eq("services.date", resolvedDate);
  }
  const allocResult = await allocQuery;
  if (allocResult.error) return null;

  const unit = unitResult.data as { id: string; bus_line_id: string; label: string; capacity: number; low_seat_threshold: number };
  const totalPax = (allocResult.data ?? []).reduce(
    (sum: number, row: { pax_assigned: number }) => sum + (row.pax_assigned ?? 0),
    0
  );
  const remaining = Math.max(0, unit.capacity - totalPax);
  const threshold = unit.low_seat_threshold ?? 5;

  if (remaining <= threshold) {
    const lineResult = await auth.admin
      .from("tenant_bus_lines")
      .select("name")
      .eq("tenant_id", tenantId)
      .eq("id", unit.bus_line_id)
      .maybeSingle();
    const lineName = (lineResult.data as { name?: string } | null)?.name ?? "Linea bus";
    await sendBusLowSeatAlertEmail({ busLabel: unit.label, lineName, remainingSeats: remaining, threshold });
    return { busLabel: unit.label, lineName, remainingSeats: remaining, threshold };
  }
  return null;
}

export const runtime = "nodejs";

function pickSameStopFirstBus<T extends { id: string; bus_line_id: string; capacity: number; label?: string }>(
  units: T[],
  datePaxMap: Map<string, number>,
  stopBusMap: Map<string, Set<string>>,
  input: {
    lineId: string;
    stopId: string | null;
    pax: number;
    excludedLabels?: Set<string>;
    preferredLabels?: string[];
  }
): T | null {
  const lineUnits = units.filter((unit) =>
    unit.bus_line_id === input.lineId &&
    !input.excludedLabels?.has(unit.label ?? "")
  );
  const hasRoom = (unit: T) => unit.capacity - (datePaxMap.get(unit.id) ?? 0) >= input.pax;

  if (input.stopId) {
    const sameStopBusIds = stopBusMap.get(`${input.lineId}:${input.stopId}`) ?? new Set<string>();
    const sameStop = lineUnits.find((unit) => sameStopBusIds.has(unit.id) && hasRoom(unit));
    if (sameStopBusIds.size > 0) return sameStop ?? null;
  }

  if (input.preferredLabels?.length) {
    const preferred = input.preferredLabels
      .map((label) => lineUnits.find((unit) => unit.label === label && hasRoom(unit)) ?? null)
      .find((unit): unit is T => Boolean(unit));
    if (preferred) return preferred;
  }

  return lineUnits.find(hasRoom) ?? null;
}

const unitUpdateSchema = z.object({
  unit_id: z.string().uuid(),
  capacity: z.number().int().min(1).max(120),
  low_seat_threshold: z.number().int().min(0).max(120),
  minimum_passengers: z.number().int().min(1).max(120).nullable(),
  status: z.enum(["open", "low", "closed", "completed"]),
  close_reason: z.string().max(500).optional().nullable()
});

const updateDriverSchema = z.object({
  unit_id: z.string().uuid(),
  direction: z.enum(["outbound", "return"]).default("outbound"),
  driver_name: z.string().max(120).optional().nullable(),
  driver_phone: z.string().max(60).optional().nullable(),
  travel_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
});

const addUnitSchema = z.object({
  bus_line_id: z.string().uuid(),
  label: z.string().min(2).max(120),
  capacity: z.number().int().min(1).max(120).default(54)
});

const addStopSchema = z.object({
  bus_line_id: z.string().uuid(),
  direction: z.enum(["arrival", "departure"]),
  stop_name: z.string().min(2).max(120),
  city: z.string().min(2).max(120),
  pickup_note: z.string().max(500).optional().nullable(),
  pickup_time: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  stop_order: z.number().int().min(1),
  lat: z.number().optional().nullable(),
  lng: z.number().optional().nullable()
});

const allocateSchema = z.object({
  service_id: z.string().uuid(),
  bus_line_id: z.string().uuid(),
  bus_unit_id: z.string().uuid(),
  direction: z.enum(["arrival", "departure"]),
  stop_name: z.string().min(2).max(120),
  stop_id: z.string().uuid().optional().nullable(),
  pax_assigned: z.number().int().min(1).max(120),
  notes: z.string().max(500).optional().nullable()
});

const moveSchema = z.object({
  allocation_id: z.string().uuid(),
  to_bus_unit_id: z.string().uuid(),
  pax_moved: z.number().int().min(1).max(120),
  reason: z.string().max(500).optional().nullable()
});

const bulkMoveSchema = z.object({
  allocations: z.array(z.object({
    allocation_id: z.string().uuid(),
    pax_moved: z.number().int().min(1).max(120),
  })).min(1).max(50),
  to_bus_unit_id: z.string().uuid(),
  reason: z.string().max(500).optional().nullable()
});

const reorderStopsSchema = z.object({
  bus_line_id: z.string().uuid(),
  direction: z.enum(["arrival", "departure"]),
  stop_ids: z.array(z.string().uuid()).min(1)
});

async function loadBusNetwork(auth: PricingAuthContext, date?: string) {
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
      : Promise.resolve({ data: [], error: null })
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
    (driverDatesResult.data ?? []).map((d: { unit_id: string; driver_name_outbound: string | null; driver_phone_outbound: string | null; driver_name_return: string | null; driver_phone_return: string | null }) => [d.unit_id, d])
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
      suggested_stop_name: identity.stop_name
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
      service.service_type_code === "transfer_port_hotel"
    )
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

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;
    const date = new URL(request.url).searchParams.get("date") ?? undefined;
    const payload = await loadBusNetwork(auth, date);
    return NextResponse.json({ ok: true, user_role: auth.membership.role, ...payload });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;
    const body = await request.json().catch(() => null);
    const action = String(body?.action ?? "");
    const tenantId = auth.membership.tenant_id;

    if (action === "bootstrap_defaults") {
      const lines = getDefaultBusNetworkLines();
      await auth.admin.from("tenant_bus_lines").upsert(
        lines.map((line) => ({
          tenant_id: tenantId,
          code: line.code,
          name: line.name,
          family_code: line.family_code,
          family_name: line.family_name,
          variant_label: line.variant_label,
          default_capacity: line.default_capacity,
          alert_threshold: line.alert_threshold,
          active: true
        })),
        { onConflict: "tenant_id,code" }
      );
      const lineRows = await auth.admin.from("tenant_bus_lines").select("*").eq("tenant_id", tenantId);
      if (lineRows.error) throw new Error(lineRows.error.message);

      for (const line of lineRows.data ?? []) {
        const defaultStops = getDefaultStopsForLine(line.code);
        if (defaultStops.length > 0) {
          const existingStops = await auth.admin
            .from("tenant_bus_line_stops")
            .select("id,is_manual")
            .eq("tenant_id", tenantId)
            .eq("bus_line_id", line.id);
          if (existingStops.error) throw new Error(existingStops.error.message);

          const autoStopIds = (existingStops.data ?? [])
            .filter((stop: { id: string; is_manual: boolean }) => !stop.is_manual)
            .map((stop: { id: string }) => stop.id);

          if (autoStopIds.length > 0) {
            const { error: deleteStopsError } = await auth.admin
              .from("tenant_bus_line_stops")
              .delete()
              .eq("tenant_id", tenantId)
              .in("id", autoStopIds);
            if (deleteStopsError) throw new Error(deleteStopsError.message);
          }

          await auth.admin.from("tenant_bus_line_stops").upsert(
            defaultStops.map((stop) => ({
              tenant_id: tenantId,
              bus_line_id: line.id,
              direction: stop.direction,
              stop_name: stop.stop_name,
              city: stop.city,
              pickup_note: stop.pickup_note,
              pickup_time: stop.pickup_time ?? null,
              stop_order: stop.stop_order,
              order_index: stop.stop_order,
              lat: stop.lat,
              lng: stop.lng,
              is_manual: stop.is_manual,
              active: true
            })),
            { onConflict: "bus_line_id,direction,stop_name" }
          );
        }
        const existingUnits = await auth.admin.from("tenant_bus_units").select("id").eq("tenant_id", tenantId).eq("bus_line_id", line.id);
        if (existingUnits.error) throw new Error(existingUnits.error.message);
        if ((existingUnits.data ?? []).length === 0) {
          const units = getDefaultBusUnitsForFamily(line.id, line.family_code);
          await auth.admin.from("tenant_bus_units").insert(units.map((unit) => ({ ...unit, tenant_id: tenantId })));
        }
      }

      const payload = await loadBusNetwork(auth);
      return NextResponse.json({ ok: true, ...payload });
    }

    if (action === "add_unit") {
      const parsed = addUnitSchema.parse(body);
      const { error } = await auth.admin.from("tenant_bus_units").insert({
        tenant_id: tenantId,
        bus_line_id: parsed.bus_line_id,
        label: parsed.label,
        capacity: parsed.capacity,
        low_seat_threshold: 5,
        minimum_passengers: null,
        status: "open",
        manual_close: false,
        close_reason: null,
        sort_order: 99,
        active: true
      });
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "add_stop") {
      const parsed = addStopSchema.parse(body);
      const departureOrder = Number(body?.departure_stop_order ?? parsed.stop_order);
      if (!Number.isInteger(departureOrder) || departureOrder < 1) {
        return NextResponse.json({ ok: false, error: "Ordine ritorno non valido." }, { status: 400 });
      }
      const { error } = await auth.admin.from("tenant_bus_line_stops").insert([
        {
          tenant_id: tenantId,
          bus_line_id: parsed.bus_line_id,
          direction: "arrival",
          stop_name: parsed.stop_name,
          city: parsed.city,
          pickup_note: parsed.pickup_note ?? null,
          pickup_time: parsed.pickup_time ?? null,
          stop_order: parsed.stop_order,
          order_index: parsed.stop_order,
          lat: parsed.lat ?? null,
          lng: parsed.lng ?? null,
          is_manual: true,
          active: true
        },
        {
          tenant_id: tenantId,
          bus_line_id: parsed.bus_line_id,
          direction: "departure",
          stop_name: parsed.stop_name,
          city: parsed.city,
          pickup_note: parsed.pickup_note ?? null,
          pickup_time: parsed.pickup_time ?? null,
          stop_order: departureOrder,
          order_index: departureOrder,
          lat: parsed.lat ?? null,
          lng: parsed.lng ?? null,
          is_manual: true,
          active: true
        }
      ]);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "update_unit") {
      const parsed = unitUpdateSchema.parse(body);
      const { error } = await auth.admin
        .from("tenant_bus_units")
        .update({
          capacity: parsed.capacity,
          low_seat_threshold: parsed.low_seat_threshold,
          minimum_passengers: parsed.minimum_passengers,
          status: parsed.status,
          manual_close: parsed.status === "closed",
          close_reason: parsed.close_reason ?? null,
          updated_at: new Date().toISOString()
        })
        .eq("tenant_id", tenantId)
        .eq("id", parsed.unit_id);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "update_capacity") {
      const parsed = z.object({ unit_id: z.string().uuid(), capacity: z.number().int().min(1).max(300) }).parse(body);
      const { error } = await auth.admin.from("tenant_bus_units")
        .update({ capacity: parsed.capacity, updated_at: new Date().toISOString() })
        .eq("tenant_id", tenantId).eq("id", parsed.unit_id);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "update_pax") {
      const parsed = z.object({ allocation_id: z.string().uuid(), pax_assigned: z.number().int().min(1).max(120) }).parse(body);
      const { error } = await auth.admin.from("tenant_bus_allocations")
        .update({ pax_assigned: parsed.pax_assigned })
        .eq("tenant_id", tenantId).eq("id", parsed.allocation_id);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "update_hotel") {
      const parsed = z.object({ service_id: z.string().uuid(), hotel_id: z.string().uuid() }).parse(body);
      const { error } = await auth.admin.from("services")
        .update({ hotel_id: parsed.hotel_id })
        .eq("tenant_id", tenantId).eq("id", parsed.service_id);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "update_phone") {
      const parsed = z.object({ service_id: z.string().uuid(), phone: z.string().max(30).trim().nullable() }).parse(body);
      const { error } = await auth.admin.from("services")
        .update({ phone: parsed.phone || null })
        .eq("tenant_id", tenantId).eq("id", parsed.service_id);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "update_label") {
      const parsed = z.object({ unit_id: z.string().uuid(), label: z.string().min(1).max(120).trim() }).parse(body);
      const { error } = await auth.admin.from("tenant_bus_units")
        .update({ label: parsed.label, updated_at: new Date().toISOString() })
        .eq("tenant_id", tenantId).eq("id", parsed.unit_id);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "update_driver") {
      const parsed = updateDriverSchema.parse(body);
      const isReturn = parsed.direction === "return";
      // Upsert autista nella tabella per-data (non modifica tenant_bus_units)
      const { error } = await auth.admin
        .from("bus_unit_driver_dates")
        .upsert({
          tenant_id: tenantId,
          unit_id: parsed.unit_id,
          travel_date: parsed.travel_date,
          ...(isReturn
            ? { driver_name_return: parsed.driver_name ?? null, driver_phone_return: parsed.driver_phone ?? null }
            : { driver_name_outbound: parsed.driver_name ?? null, driver_phone_outbound: parsed.driver_phone ?? null }),
          updated_at: new Date().toISOString()
        }, { onConflict: "tenant_id,unit_id,travel_date" });
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth, parsed.travel_date)) });
    }

    if (action === "update_tag") {
      const parsed = z.object({
        unit_id: z.string().uuid(),
        tag: z.enum(["esclusivo", "gruppi"]).nullable(),
      }).parse(body);
      const { error } = await auth.admin.from("tenant_bus_units")
        .update({ tag: parsed.tag, updated_at: new Date().toISOString() })
        .eq("tenant_id", tenantId).eq("id", parsed.unit_id);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "update_group_name") {
      const parsed = z.object({
        unit_id: z.string().uuid(),
        group_name: z.string().max(120).nullable(),
      }).parse(body);
      const { error } = await auth.admin.from("tenant_bus_units")
        .update({ group_name: parsed.group_name, updated_at: new Date().toISOString() })
        .eq("tenant_id", tenantId).eq("id", parsed.unit_id);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "update_service_city") {
      const parsed = z.object({
        service_id: z.string().uuid(),
        bus_city_origin: z.string().trim().min(1).max(200),
      }).parse(body);
      const { error } = await auth.admin.from("services")
        .update({ bus_city_origin: parsed.bus_city_origin.toUpperCase() })
        .eq("tenant_id", tenantId)
        .eq("id", parsed.service_id);
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "allocate_service") {
      const parsed = allocateSchema.parse(body);
      if (!parsed.stop_id) {
        return NextResponse.json({ ok: false, error: "Fermata obbligatoria per allocare il servizio." }, { status: 400 });
      }

      // Blocca aggiunta su bus esclusivo
      const { data: targetUnit } = await auth.admin.from("tenant_bus_units")
        .select("tag").eq("id", parsed.bus_unit_id).eq("tenant_id", tenantId).single();
      if (targetUnit?.tag === "esclusivo") {
        return NextResponse.json({ ok: false, error: "Bus esclusivo: non è possibile aggiungere altri passeggeri." }, { status: 400 });
      }

      await validateBusAllocationRequest(auth, {
        tenantId,
        serviceId: parsed.service_id,
        busLineId: parsed.bus_line_id,
        busUnitId: parsed.bus_unit_id,
        stopId: parsed.stop_id,
        stopName: parsed.stop_name,
        direction: parsed.direction
      });

      const { error } = await auth.admin.rpc("allocate_bus_service", {
        p_tenant_id: tenantId,
        p_service_id: parsed.service_id,
        p_bus_line_id: parsed.bus_line_id,
        p_bus_unit_id: parsed.bus_unit_id,
        p_stop_id: parsed.stop_id,
        p_stop_name: parsed.stop_name,
        p_direction: parsed.direction,
        p_pax_assigned: parsed.pax_assigned,
        p_notes: parsed.notes ?? null,
        p_created_by_user_id: auth.user.id
      });
      if (error) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
      }
      const [networkPayload, allocateAlert] = await Promise.all([
        loadBusNetwork(auth),
        checkAndAlertLowSeats(auth, tenantId, parsed.bus_unit_id)
      ]);
      return NextResponse.json({ ok: true, ...networkPayload, low_seat_alert: allocateAlert });
    }

    if (action === "move_allocation") {
      const parsed = moveSchema.parse(body);
      await validateBusMoveRequest(auth, {
        tenantId,
        allocationId: parsed.allocation_id,
        toBusUnitId: parsed.to_bus_unit_id,
        paxMoved: parsed.pax_moved
      });

      const { error } = await auth.admin.rpc("move_bus_allocation", {
        p_tenant_id: tenantId,
        p_allocation_id: parsed.allocation_id,
        p_to_bus_unit_id: parsed.to_bus_unit_id,
        p_pax_moved: parsed.pax_moved,
        p_reason: parsed.reason ?? null,
        p_created_by_user_id: auth.user.id
      });
      if (error) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
      }
      const [networkPayload, moveAlert] = await Promise.all([
        loadBusNetwork(auth),
        checkAndAlertLowSeats(auth, tenantId, parsed.to_bus_unit_id)
      ]);
      return NextResponse.json({ ok: true, ...networkPayload, low_seat_alert: moveAlert });
    }

    if (action === "move_allocations_bulk") {
      const parsed = bulkMoveSchema.parse(body);
      const errors: string[] = [];
      for (const item of parsed.allocations) {
        const { error } = await auth.admin.rpc("move_bus_allocation", {
          p_tenant_id: tenantId,
          p_allocation_id: item.allocation_id,
          p_to_bus_unit_id: parsed.to_bus_unit_id,
          p_pax_moved: item.pax_moved,
          p_reason: parsed.reason ?? null,
          p_created_by_user_id: auth.user.id
        });
        if (error) errors.push(error.message);
      }
      if (errors.length === parsed.allocations.length) {
        return NextResponse.json({ ok: false, error: errors[0] }, { status: 400 });
      }
      const [networkPayload, moveAlert] = await Promise.all([
        loadBusNetwork(auth),
        checkAndAlertLowSeats(auth, tenantId, parsed.to_bus_unit_id)
      ]);
      return NextResponse.json({
        ok: true,
        ...networkPayload,
        low_seat_alert: moveAlert,
        ...(errors.length > 0 ? { partial_errors: errors } : {})
      });
    }

    if (action === "delete_allocation") {
      const allocationId = z.string().uuid().parse(body?.allocation_id);
      // Verify ownership before deleting
      const { data: alloc, error: fetchErr } = await auth.admin
        .from("tenant_bus_allocations")
        .select("id, bus_unit_id")
        .eq("tenant_id", tenantId)
        .eq("id", allocationId)
        .maybeSingle();
      if (fetchErr || !alloc) {
        return NextResponse.json({ ok: false, error: "Allocazione non trovata." }, { status: 404 });
      }
      const { error: delErr } = await auth.admin
        .from("tenant_bus_allocations")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("id", allocationId);
      if (delErr) throw new Error(delErr.message);
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "update_line_name") {
      const schema = z.object({
        line_id: z.string().uuid(),
        name: z.string().min(1).max(200).trim(),
      });
      const parsed = schema.parse(body);
      const { error } = await auth.admin
        .from("tenant_bus_lines")
        .update({ name: parsed.name })
        .eq("id", parsed.line_id)
        .eq("tenant_id", tenantId);
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "reset_line_date") {
      const resetSchema = z.object({
        bus_line_id: z.string().uuid(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        direction: z.enum(["arrival", "departure"])
      });
      const parsed = resetSchema.parse(body);

      // 1. Find all allocation_ids + service_ids for this line/date/direction
      const { data: details, error: detailsErr } = await auth.admin
        .from("ops_bus_allocation_details")
        .select("allocation_id, service_id")
        .eq("tenant_id", tenantId)
        .eq("bus_line_id", parsed.bus_line_id)
        .eq("service_date", parsed.date)
        .eq("direction", parsed.direction);
      if (detailsErr) throw new Error(detailsErr.message);

      const allocationIds = (details ?? []).map((d: { allocation_id: string }) => d.allocation_id);
      const serviceIds = [...new Set((details ?? []).map((d: { service_id: string }) => d.service_id))];

      // 2. Delete allocations first (FK references services)
      if (allocationIds.length > 0) {
        const { error: delAllocErr } = await auth.admin
          .from("tenant_bus_allocations")
          .delete()
          .eq("tenant_id", tenantId)
          .in("id", allocationIds);
        if (delAllocErr) throw new Error(delAllocErr.message);
      }

      // 3. Delete the services that were allocated to this line/date/direction
      if (serviceIds.length > 0) {
        const { error: delSvcErr } = await auth.admin
          .from("services")
          .delete()
          .eq("tenant_id", tenantId)
          .in("id", serviceIds);
        if (delSvcErr) throw new Error(delSvcErr.message);
      }

      // 3b. Delete unallocated services that belong to this line family by derived identity
      const { data: unallocatedSvcs } = await auth.admin
        .from("services")
        .select("id, bus_city_origin, transport_code, time, service_type_code, booking_service_kind")
        .eq("tenant_id", tenantId)
        .eq("date", parsed.date)
        .eq("direction", parsed.direction)
        .or("service_type_code.eq.bus_line,booking_service_kind.eq.bus_city_hotel");
      if (unallocatedSvcs && unallocatedSvcs.length > 0) {
        const { data: lineRow } = await auth.admin.from("tenant_bus_lines").select("family_code").eq("id", parsed.bus_line_id).single();
        const targetFamily = (lineRow as { family_code: string } | null)?.family_code;
        if (targetFamily) {
          const orphanIds = (unallocatedSvcs as Array<{ id: string; bus_city_origin?: string | null; transport_code?: string | null; time?: string; service_type_code?: string | null; booking_service_kind?: string | null }>)
            .filter(s => {
              if (serviceIds.includes(s.id)) return false;
              const identity = deriveServiceBusIdentity(s as Parameters<typeof deriveServiceBusIdentity>[0]);
              return identity.family_code === targetFamily;
            })
            .map(s => s.id);
          if (orphanIds.length > 0) {
            await auth.admin.from("services").delete().eq("tenant_id", tenantId).in("id", orphanIds);
            serviceIds.push(...orphanIds);
          }
        }
      }

      // 4. Delete pending passengers for this line/date/direction
      await auth.admin
        .from("bus_import_pending")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("bus_line_id", parsed.bus_line_id)
        .eq("travel_date", parsed.date)
        .eq("direction", parsed.direction);

      return NextResponse.json({
        ok: true,
        deleted_allocations: allocationIds.length,
        deleted_services: serviceIds.length,
        ...(await loadBusNetwork(auth))
      });
    }

    if (action === "reorder_stops") {
      const parsed = reorderStopsSchema.parse(body);
      const { error } = await auth.admin.rpc("reorder_bus_line_stops", {
        p_tenant_id: tenantId,
        p_bus_line_id: parsed.bus_line_id,
        p_direction: parsed.direction,
        p_stop_ids: parsed.stop_ids
      });
      if (error) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
      }
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    // Scambia l'ordine di due fermate (usato dalle frecce ↑↓ nel client)
    if (action === "swap_stops") {
      const parsed = z.object({
        stop_id_a: z.string().uuid(),
        stop_id_b: z.string().uuid()
      }).parse(body);

      // Leggi entrambe le fermate con stop_order correnti
      const [resA, resB] = await Promise.all([
        auth.admin.from("tenant_bus_line_stops").select("id,stop_order").eq("tenant_id", tenantId).eq("id", parsed.stop_id_a).single(),
        auth.admin.from("tenant_bus_line_stops").select("id,stop_order").eq("tenant_id", tenantId).eq("id", parsed.stop_id_b).single()
      ]);
      if (resA.error || !resA.data) throw new Error("Fermata A non trovata: " + (resA.error?.message ?? "id non presente"));
      if (resB.error || !resB.data) throw new Error("Fermata B non trovata: " + (resB.error?.message ?? "id non presente"));

      // Leggi tutti gli stop della stessa linea+direzione per riscrivere in blocco
      const refRes = await auth.admin.from("tenant_bus_line_stops")
        .select("id,bus_line_id,direction")
        .eq("tenant_id", tenantId).eq("id", parsed.stop_id_a).single();
      if (refRes.error || !refRes.data) throw new Error("Fermata A non trovata");
      const { bus_line_id, direction: stopDir } = refRes.data as { bus_line_id: string; direction: string };

      const allStopsRes = await auth.admin.from("tenant_bus_line_stops")
        .select("id,stop_order")
        .eq("tenant_id", tenantId).eq("bus_line_id", bus_line_id).eq("direction", stopDir)
        .order("stop_order");
      if (allStopsRes.error) throw new Error(allStopsRes.error.message);

      type StopRow = { id: string; stop_order: number };
      const allStops = (allStopsRes.data ?? []) as StopRow[];
      const idxA = allStops.findIndex((s) => s.id === parsed.stop_id_a);
      const idxB = allStops.findIndex((s) => s.id === parsed.stop_id_b);
      if (idxA < 0 || idxB < 0) throw new Error("Fermate non trovate nell'elenco");

      const reordered = [...allStops];
      [reordered[idxA], reordered[idxB]] = [reordered[idxB], reordered[idxA]];

      // Aggiorna tutti in parallelo con stop_order sequenziale (1,2,3,...) — evita stale reads
      const results = await Promise.all(
        reordered.map((s, i) =>
          auth.admin.from("tenant_bus_line_stops")
            .update({ stop_order: i + 1, order_index: i + 1 })
            .eq("tenant_id", tenantId).eq("id", s.id)
        )
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) throw new Error(failed.error.message);

      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    // Aggiorna il nome di una fermata esistente
    if (action === "update_stop_name") {
      const parsed = z.object({
        stop_id: z.string().uuid(),
        stop_name: z.string().min(1).max(200)
      }).parse(body);
      const upper = parsed.stop_name.trim().toUpperCase();
      const { error } = await auth.admin.from("tenant_bus_line_stops")
        .update({ stop_name: upper, city: upper })
        .eq("tenant_id", tenantId).eq("id", parsed.stop_id);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    // Aggiorna l'orario di partenza di una fermata esistente
    if (action === "update_stop_time") {
      const parsed = z.object({
        stop_id: z.string().uuid(),
        pickup_time: z.string().regex(/^\d{2}:\d{2}$/).nullable()
      }).parse(body);
      const { error } = await auth.admin.from("tenant_bus_line_stops")
        .update({ pickup_time: parsed.pickup_time })
        .eq("tenant_id", tenantId).eq("id", parsed.stop_id);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    // Riordina fermate in base al pickup_time (orario crescente)
    if (action === "sort_stops_by_time") {
      const parsed = z.object({
        bus_line_id: z.string().uuid(),
        direction: z.enum(["arrival", "departure"])
      }).parse(body);

      const { data: stops, error: stopsErr } = await auth.admin
        .from("tenant_bus_line_stops")
        .select("id,pickup_time")
        .eq("tenant_id", tenantId)
        .eq("bus_line_id", parsed.bus_line_id)
        .eq("direction", parsed.direction)
        .eq("active", true);
      if (stopsErr) throw new Error(stopsErr.message);

      type TimeStop = { id: string; pickup_time: string | null };
      const withTime = ((stops ?? []) as TimeStop[]).filter((s) => s.pickup_time);
      const withoutTime = ((stops ?? []) as TimeStop[]).filter((s) => !s.pickup_time);

      // Ordina per orario crescente (le fermate senza orario vanno in fondo)
      withTime.sort((a, b) => (a.pickup_time ?? "").localeCompare(b.pickup_time ?? ""));
      const ordered = [...withTime, ...withoutTime];

      for (let i = 0; i < ordered.length; i++) {
        await auth.admin.from("tenant_bus_line_stops")
          .update({ stop_order: i + 1, order_index: i + 1 })
          .eq("tenant_id", tenantId).eq("id", ordered[i].id);
      }

      return NextResponse.json({ ok: true, sorted: ordered.length, ...(await loadBusNetwork(auth)) });
    }

    // Geocodifica fermate senza coordinate e le riordina per latitudine (nord→sud andata, inverso ritorno)
    if (action === "geo_sort_stops") {
      const parsed = z.object({
        bus_line_id: z.string().uuid(),
        direction: z.enum(["arrival", "departure"]),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }).parse(body);

      // Se è passata una data, carica solo le fermate con allocazioni in quella data
      let stopIds: string[] | null = null;
      if (parsed.date) {
        const { data: services } = await auth.admin
          .from("services")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("date", parsed.date)
          .eq("direction", parsed.direction);
        const serviceIds = (services ?? []).map((s: { id: string }) => s.id);
        if (serviceIds.length > 0) {
          const { data: allocs } = await auth.admin
            .from("tenant_bus_allocations")
            .select("stop_id")
            .eq("tenant_id", tenantId)
            .eq("bus_line_id", parsed.bus_line_id)
            .in("service_id", serviceIds)
            .not("stop_id", "is", null);
          type AllocRow = { stop_id: string | null };
          const ids: string[] = [...new Set((allocs as AllocRow[] ?? []).map((a) => a.stop_id).filter((x): x is string => !!x))];
          if (ids.length > 0) stopIds = ids;
        }
      }

      let stopsQuery = auth.admin
        .from("tenant_bus_line_stops")
        .select("id,stop_name,city,lat,lng")
        .eq("tenant_id", tenantId)
        .eq("bus_line_id", parsed.bus_line_id)
        .eq("direction", parsed.direction)
        .eq("active", true);
      if (stopIds) stopsQuery = stopsQuery.in("id", stopIds);

      const { data: stops, error: stopsErr } = await stopsQuery;
      if (stopsErr) throw new Error(stopsErr.message);

      type RawStop = { id: string; stop_name: string; city: string; lat: number | null; lng: number | null };
      const allStops = (stops ?? []) as RawStop[];

      // Geocodifica solo quelle senza coordinate (rispetta rate-limit Nominatim con pausa 1s)
      for (const stop of allStops) {
        if (stop.lat != null) continue;
        // Pulisce il nome fermata rimuovendo prefissi orario tipo "05:30 " e testo dopo trattino
        const rawQuery = stop.city?.trim() || stop.stop_name;
        const cleanQuery = rawQuery.replace(/^\d{1,2}:\d{2}\s+/, "").replace(/\s*[-–—]+\s*.+$/, "").trim() || rawQuery;
        const geo = await geocodeCity(cleanQuery);
        if (!geo) continue;
        await auth.admin.from("tenant_bus_line_stops")
          .update({ lat: geo.lat, lng: geo.lng })
          .eq("tenant_id", tenantId).eq("id", stop.id);
        stop.lat = geo.lat;
        stop.lng = geo.lng;
        // Pausa 1 secondo per non superare il rate-limit Nominatim
        await new Promise((r) => setTimeout(r, 1000));
      }

      // Ordina per latitudine: andata = nord→sud (lat desc), ritorno = sud→nord (lat asc)
      const withCoords = allStops.filter((s): s is RawStop & { lat: number } => s.lat != null);
      const withoutCoords = allStops.filter((s) => s.lat == null);
      const sorted = [...withCoords].sort((a, b) =>
        parsed.direction === "arrival" ? b.lat - a.lat : a.lat - b.lat
      );

      // Aggiorna stop_order: geocodificate per prime, senza coordinate in fondo
      const allOrdered = [...sorted, ...withoutCoords];
      for (let i = 0; i < allOrdered.length; i++) {
        await auth.admin.from("tenant_bus_line_stops")
          .update({ stop_order: i + 1, order_index: i + 1 })
          .eq("tenant_id", tenantId).eq("id", allOrdered[i].id);
      }

      return NextResponse.json({
        ok: true,
        geocoded: withCoords.length,
        skipped: withoutCoords.length,
        skipped_names: withoutCoords.map((s) => s.stop_name).join(", "),
        ...(await loadBusNetwork(auth))
      });
    }

    if (action === "auto_assign_date") {
      const autoSchema = z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        direction: z.enum(["arrival", "departure"])
      });
      const parsed = autoSchema.parse(body);

      // Carica dati necessari
      const [svcRes, linesRes, stopsRes, unitsRes, allocRes] = await Promise.all([
        auth.admin.from("services").select("id,customer_name,customer_first_name,customer_last_name,pax,direction,bus_city_origin,transport_code,time,outbound_time,service_type_code,booking_service_kind")
          .eq("tenant_id", tenantId).eq("date", parsed.date).eq("direction", parsed.direction)
          .or("service_type_code.eq.bus_line,booking_service_kind.eq.bus_city_hotel")
          .order("time"),
        auth.admin.from("tenant_bus_lines").select("id,code,name,family_code").eq("tenant_id", tenantId),
        auth.admin.from("tenant_bus_line_stops").select("id,bus_line_id,direction,stop_name,city,stop_order").eq("tenant_id", tenantId).eq("active", true),
        auth.admin.from("tenant_bus_units").select("id,bus_line_id,label,capacity,status,sort_order").eq("tenant_id", tenantId).eq("active", true).order("sort_order"),
        auth.admin.from("tenant_bus_allocations").select("id,service_id,bus_unit_id,pax_assigned").eq("tenant_id", tenantId)
      ]);
      if (svcRes.error) throw new Error(svcRes.error.message);
      if (linesRes.error) throw new Error(linesRes.error.message);
      if (stopsRes.error) throw new Error(stopsRes.error.message);
      if (unitsRes.error) throw new Error(unitsRes.error.message);
      if (allocRes.error) throw new Error(allocRes.error.message);

      function normCity(v?: string | null) {
        return String(v ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
      }

      const services = svcRes.data ?? [];
      const lines = linesRes.data ?? [];
      const allStops = [...(stopsRes.data ?? [])] as Array<{ id: string; bus_line_id: string; direction: string; stop_name: string; city: string; stop_order: number }>;
      const units = unitsRes.data ?? [];
      const allocatedIds = new Set((allocRes.data ?? []).map((a: { service_id: string }) => a.service_id));

      // Capienza per data
      const datePax = new Map<string, number>();
      for (const a of (allocRes.data ?? []) as Array<{ bus_unit_id: string; pax_assigned: number }>) {
        datePax.set(a.bus_unit_id, (datePax.get(a.bus_unit_id) ?? 0) + a.pax_assigned);
      }

      type AutoLine = { id: string; code: string; name: string; family_code: string };
      const typedLines = lines as AutoLine[];
      const lineByCode = new Map<string, AutoLine>(typedLines.map((l) => [l.code, l]));
      const familyLineByCode = new Map<string, AutoLine>(typedLines.map((l) => [l.family_code, l]));

      // Bus per linea ordinati per posti rimanenti (fill del più vuoto prima, ma dedicati Puglia preservati)
      type SimUnit = { id: string; label: string; bus_line_id: string; capacity: number; remaining: number };
      const busesByLineId = new Map<string, SimUnit[]>();
      for (const u of units as Array<{ id: string; label: string; bus_line_id: string; capacity: number; status: string }>) {
        if (u.status === "closed" || u.status === "completed") continue;
        const list = busesByLineId.get(u.bus_line_id) ?? [];
        list.push({ id: u.id, label: u.label, bus_line_id: u.bus_line_id, capacity: u.capacity, remaining: Math.max(0, u.capacity - (datePax.get(u.id) ?? 0)) });
        busesByLineId.set(u.bus_line_id, list);
      }

      const assigned: Array<{ serviceId: string; customerName: string; busUnitId: string; busLabel: string; stopId: string | null; stopName: string; pax: number }> = [];
      const skipped: Array<{ serviceId: string; customerName: string; reason: string }> = [];
      const createdStopKeys = new Set<string>();
      // Logica geografica: mappa busId → stopId primaria già assegnata al bus.
      // Permette di raggruppare passeggeri della stessa fermata sullo stesso bus.
      const busStopPrimary = new Map<string, string>(); // busId → stopId

      type SvcRow = { id: string; customer_name: string; pax: number; direction: string; bus_city_origin?: string | null; transport_code?: string | null; time?: string | null; outbound_time?: string | null; service_type_code?: string | null; booking_service_kind?: string | null };
      const sortedServices = [...(services as SvcRow[])].sort((a, b) => {
        const ca = normCity(a.bus_city_origin); const cb = normCity(b.bus_city_origin);
        if (ca !== cb) return ca.localeCompare(cb);
        return (b.pax ?? 0) - (a.pax ?? 0);
      });
      for (const svc of sortedServices) {
        if (allocatedIds.has(svc.id)) continue;

        const identity = deriveServiceBusIdentity(svc as Parameters<typeof deriveServiceBusIdentity>[0]);
        const line = familyLineByCode.get(identity.family_code ?? "") ?? lineByCode.get(identity.lineCode ?? "");
        if (!line) { skipped.push({ serviceId: svc.id, customerName: svc.customer_name, reason: "Linea non trovata" }); continue; }

        const lineStops = allStops.filter((s) => s.bus_line_id === line.id && s.direction === parsed.direction);
        const reqCity = normCity(svc.bus_city_origin);
        const expandedCity = normCity((svc.bus_city_origin ?? "").replace(/\bp\.\s*/gi, "ponte ").replace(/\bs\.\s*/gi, "santa ").replace(/\bc\.\s*/gi, "citta "));
        const identCity = normCity(identity.city);
        const aliasCities = findBusStopsByCity(svc.bus_city_origin).map((e) => normCity(e.stop.city));

        let stop = lineStops.find((s) => {
          const sc = normCity(s.city); const sn = normCity(s.stop_name);
          return sc === reqCity || sn === reqCity || sc === expandedCity || sn === expandedCity ||
            sc === identCity || sn === identCity || aliasCities.includes(sc) || aliasCities.includes(sn) ||
            sn.includes(reqCity) || reqCity.includes(sn) || sc.includes(reqCity) || reqCity.includes(sc);
        });

        // Fermata non trovata → crea fermata manuale solo se non appartiene a un'altra linea
        if (!stop && reqCity) {
          const catalogMatch = resolveBusStop(svc.bus_city_origin);
          if (catalogMatch && catalogMatch.familyCode !== line.family_code) {
            skipped.push({ serviceId: svc.id, customerName: svc.customer_name, reason: `${svc.bus_city_origin ?? "?"} appartiene a ${catalogMatch.familyName}, non a ${line.name}` });
            continue;
          }
          const cityName = (svc.bus_city_origin ?? "").trim().toUpperCase() || "SCONOSCIUTA";
          const stopKey = `${line.id}:${parsed.direction}:${cityName}`;
          if (!createdStopKeys.has(stopKey)) {
            const maxOrder = lineStops.reduce((mx, s) => Math.max(mx, s.stop_order ?? 0), 0);
            const { data: newStop, error: stopErr } = await auth.admin
              .from("tenant_bus_line_stops")
              .insert({ tenant_id: tenantId, bus_line_id: line.id, direction: parsed.direction, stop_name: cityName, city: svc.bus_city_origin?.trim() ?? cityName, stop_order: maxOrder + 1, order_index: maxOrder + 1, is_manual: true, active: true })
              .select("id,bus_line_id,direction,stop_name,city,stop_order").single();
            if (stopErr || !newStop) { skipped.push({ serviceId: svc.id, customerName: svc.customer_name, reason: `Creazione fermata ${cityName} fallita` }); continue; }
            allStops.push(newStop as typeof allStops[0]);
            stop = newStop as typeof allStops[0];
            createdStopKeys.add(stopKey);
          } else {
            stop = allStops.find((s) => s.bus_line_id === line.id && s.direction === parsed.direction && s.stop_name === cityName);
          }
        }

        if (!stop) { skipped.push({ serviceId: svc.id, customerName: svc.customer_name, reason: `Fermata non trovata per ${svc.bus_city_origin ?? "N/D"}` }); continue; }

        // Scegli bus: riempimento sequenziale dal primo all'ultimo, stessa fermata sullo stesso bus
        const buses = busesByLineId.get(line.id) ?? [];
        const reserved = new Set(["ITALIA PUGLIA", "ITALIA PUGLIA 2"]);
        const isPuglia = svc.transport_code === "LINEA_PUGLIA_ITALIA";
        const preferred = isPuglia ? ["ITALIA PUGLIA", "ITALIA PUGLIA 2"] : [];
        let chosenBus: SimUnit | null = null;
        if (preferred.length) {
          chosenBus = preferred.map((lbl) => buses.find((b) => b.label === lbl && b.remaining >= svc.pax) ?? null).find((b): b is SimUnit => b !== null) ?? null;
        } else {
          const nonReserved = buses.filter((b) => !reserved.has(b.label));
          // 1. Bus che ha già la stessa fermata e ha posto
          const sameStop = nonReserved.find((b) => busStopPrimary.get(b.id) === stop.id && b.remaining >= svc.pax);
          if (sameStop) {
            chosenBus = sameStop;
          } else {
            // 2. Primo bus in ordine con posto (riempimento sequenziale)
            chosenBus = nonReserved.find((b) => b.remaining >= svc.pax) ?? null;
          }
        }
        if (!chosenBus) { skipped.push({ serviceId: svc.id, customerName: svc.customer_name, reason: "Nessun bus disponibile" }); continue; }

        const { error: allocErr } = await auth.admin.rpc("allocate_bus_service", {
          p_tenant_id: tenantId,
          p_service_id: svc.id,
          p_bus_line_id: line.id,
          p_bus_unit_id: chosenBus.id,
          p_stop_id: stop.id.startsWith("new-") ? null : stop.id,
          p_stop_name: stop.stop_name,
          p_direction: parsed.direction,
          p_pax_assigned: svc.pax,
          p_notes: null,
          p_created_by_user_id: auth.user.id
        });
        if (allocErr) { skipped.push({ serviceId: svc.id, customerName: svc.customer_name, reason: allocErr.message }); continue; }

        if (!busStopPrimary.has(chosenBus.id)) busStopPrimary.set(chosenBus.id, stop.id);
        chosenBus.remaining -= svc.pax;
        datePax.set(chosenBus.id, (datePax.get(chosenBus.id) ?? 0) + svc.pax);
        assigned.push({ serviceId: svc.id, customerName: svc.customer_name, busUnitId: chosenBus.id, busLabel: chosenBus.label, stopId: stop.id, stopName: stop.stop_name, pax: svc.pax });
      }

      return NextResponse.json({
        ok: true,
        assigned: assigned.length,
        skipped: skipped.length,
        skipped_detail: skipped,
        ...(await loadBusNetwork(auth))
      });
    }

    if (action === "import_excel_line") {
      const importSchema = z.object({
        bus_line_id: z.string().uuid(),
        direction: z.enum(["arrival", "departure"]),
        travel_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        rows: z.array(z.object({
          name: z.string().max(200),
          phone: z.string().max(100).optional().nullable(),
          email: z.string().max(200).optional().nullable(),
          city: z.string().max(200),
          pax: z.number().int().min(1).max(120),
          notes: z.string().max(500).optional().nullable(),
        })).min(1).max(500),
      });
      const parsed = importSchema.parse(body);

      function normCity(v?: string | null) {
        return String(v ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
      }

      const existingServicesRes = await auth.admin
        .from("services")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("date", parsed.travel_date)
        .eq("direction", parsed.direction);
      if (existingServicesRes.error) throw new Error(existingServicesRes.error.message);
      const existingServiceIds = (existingServicesRes.data ?? []).map((service: { id: string }) => service.id);

      // Carica fermate e bus della linea
      const [stopsRes, unitsRes, allocRes] = await Promise.all([
        auth.admin.from("tenant_bus_line_stops").select("id,stop_name,city,stop_order")
          .eq("tenant_id", tenantId).eq("bus_line_id", parsed.bus_line_id)
          .eq("direction", parsed.direction).eq("active", true).order("stop_order"),
        auth.admin.from("tenant_bus_units").select("id,label,capacity,status")
          .eq("tenant_id", tenantId).eq("bus_line_id", parsed.bus_line_id)
          .not("status", "in", '("closed","completed")').order("sort_order"),
        existingServiceIds.length > 0
          ? auth.admin.from("tenant_bus_allocations").select("bus_line_id,bus_unit_id,stop_id,pax_assigned,service_id")
            .eq("tenant_id", tenantId).in("service_id", existingServiceIds)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (stopsRes.error) throw new Error(stopsRes.error.message);
      if (unitsRes.error) throw new Error(unitsRes.error.message);
      if (allocRes.error) throw new Error(allocRes.error.message);

      type DBStop = { id: string; stop_name: string; city: string; stop_order: number };
      type DBUnit = { id: string; bus_line_id: string; label: string; capacity: number; status: string };
      const lineStops = (stopsRes.data ?? []) as DBStop[];
      const units = (unitsRes.data ?? []).map((unit: Omit<DBUnit, "bus_line_id">) => ({ ...unit, bus_line_id: parsed.bus_line_id })) as DBUnit[];

      // Calcola pax per data per bus
      const datePaxMap = new Map<string, number>();
      const stopBusMap = new Map<string, Set<string>>();
      for (const a of (allocRes.data ?? []) as Array<{ bus_line_id: string; bus_unit_id: string; stop_id: string | null; pax_assigned: number }>) {
        datePaxMap.set(a.bus_unit_id, (datePaxMap.get(a.bus_unit_id) ?? 0) + a.pax_assigned);
        if (a.stop_id) {
          const key = `${a.bus_line_id}:${a.stop_id}`;
          const busIds = stopBusMap.get(key) ?? new Set<string>();
          busIds.add(a.bus_unit_id);
          stopBusMap.set(key, busIds);
        }
      }

      function findStop(city: string): { stop: DBStop | null; fuzzy: boolean } {
        const nc = normCity(city);
        if (!nc) return { stop: null, fuzzy: false };
        const exact = lineStops.find((s) => normCity(s.city) === nc || normCity(s.stop_name) === nc);
        if (exact) return { stop: exact, fuzzy: false };
        const fuzzy = lineStops.find((s) => {
          const sc = normCity(s.city); const sn = normCity(s.stop_name);
          return sc.includes(nc) || nc.includes(sc) || sn.includes(nc) || nc.includes(sn);
        });
        return { stop: fuzzy ?? null, fuzzy: !!fuzzy };
      }

      function pickBus(pax: number, stopId: string | null): DBUnit | null {
        return pickSameStopFirstBus(units, datePaxMap, stopBusMap, {
          lineId: parsed.bus_line_id,
          stopId,
          pax,
        });
      }

      let assigned = 0;
      let pending = 0;

      const resolvedRows: Array<{ row: (typeof parsed.rows)[number]; stop: DBStop | null; fuzzy: boolean }> = parsed.rows.map((row) => {
        const { stop, fuzzy } = findStop(row.city);
        return { row, stop, fuzzy };
      });
      const rowsByStop = new Map<string, Array<{ row: (typeof parsed.rows)[number]; stop: DBStop }>>();

      for (const item of resolvedRows) {
        const { row, stop, fuzzy } = item;
        if (stop && !fuzzy) {
          const key = `${parsed.bus_line_id}:${stop.id}`;
          const list = rowsByStop.get(key) ?? [];
          list.push({ row, stop });
          rowsByStop.set(key, list);
        } else {
          // Fermata non trovata o parziale → da validare
          await auth.admin.from("bus_import_pending").insert({
            tenant_id: tenantId,
            bus_line_id: parsed.bus_line_id,
            direction: parsed.direction,
            travel_date: parsed.travel_date,
            passenger_name: row.name,
            passenger_phone: row.phone ?? null,
            passenger_email: row.email ?? null,
            city_original: row.city,
            pax: row.pax,
            notes: row.notes ?? null,
            geo_suggested_stop: stop?.stop_name ?? null,
          });
          pending++;
        }
      }

      const groupedRows = Array.from(rowsByStop.values())
        .sort((a, b) => b.reduce((sum, item) => sum + item.row.pax, 0) - a.reduce((sum, item) => sum + item.row.pax, 0));

      for (const group of groupedRows) {
        const stop = group[0].stop;
        const groupPax = group.reduce((sum, item) => sum + item.row.pax, 0);
        const bus = pickBus(groupPax, stop.id);
        if (bus) {
          for (const { row } of group) {
            const { data: svc, error: svcErr } = await auth.admin.from("services").insert({
              tenant_id: tenantId,
              customer_name: row.name,
              phone: row.phone ?? "",
              direction: parsed.direction,
              date: parsed.travel_date,
              time: "00:00",
              vessel: "Linea bus",
              pax: row.pax,
              bus_city_origin: row.city,
              booking_service_kind: "bus_city_hotel",
              status: "new",
            }).select("id").single();
            if (svcErr || !svc) { pending++; continue; }

            const { error: allocErr } = await auth.admin.rpc("allocate_bus_service", {
              p_tenant_id: tenantId,
              p_service_id: svc.id,
              p_bus_line_id: parsed.bus_line_id,
              p_bus_unit_id: bus.id,
              p_stop_id: stop.id,
              p_stop_name: stop.stop_name,
              p_direction: parsed.direction,
              p_pax_assigned: row.pax,
              p_notes: row.notes ?? null,
              p_created_by_user_id: auth.user.id,
            });
            if (allocErr) { pending++; continue; }

            ensureWhatsAppContact(auth.admin, {
              tenantId,
              phone: row.phone,
              profileName: row.name,
            }).catch((contactError) => console.error("WhatsApp contact creation failed:", contactError));

            datePaxMap.set(bus.id, (datePaxMap.get(bus.id) ?? 0) + row.pax);
            const stopKey = `${parsed.bus_line_id}:${stop.id}`;
            const busIds = stopBusMap.get(stopKey) ?? new Set<string>();
            busIds.add(bus.id);
            stopBusMap.set(stopKey, busIds);
            assigned++;
          }
        } else {
          // Nessun bus disponibile per l'intero gruppo fermata → da validare
          for (const { row } of group) {
            await auth.admin.from("bus_import_pending").insert({
              tenant_id: tenantId,
              bus_line_id: parsed.bus_line_id,
              direction: parsed.direction,
              travel_date: parsed.travel_date,
              passenger_name: row.name,
              passenger_phone: row.phone ?? null,
              passenger_email: row.email ?? null,
              city_original: row.city,
              pax: row.pax,
              notes: row.notes ?? null,
              geo_suggested_stop: stop.stop_name,
            });
            pending++;
          }
        }
      }

      return NextResponse.json({ ok: true, assigned, pending, ...(await loadBusNetwork(auth)) });
    }

    if (action === "import_excel_auto") {
      const importSchema = z.object({
        direction: z.enum(["arrival", "departure"]),
        travel_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        rows: z.array(z.object({
          name: z.string().max(200),
          phone: z.string().max(100).optional().nullable(),
          city: z.string().max(200),
          pax: z.number().int().min(1).max(120),
          notes: z.string().max(500).optional().nullable(),
          hotel: z.string().max(200).optional().nullable(),
          agency: z.string().max(200).optional().nullable(),
          stop_id: z.string().uuid().optional().nullable(),       // assegnato manualmente nel preview
          bus_line_id: z.string().uuid().optional().nullable(),   // assegnato manualmente nel preview
        })).min(1).max(500),
      });
      const parsed = importSchema.parse(body);

      function normCityAuto(v?: string | null) {
        return String(v ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
      }

      function expandBusImportAbbreviations(value?: string | null) {
        return String(value ?? "")
          .replace(/\bp\.\s*/gi, "ponte ")
          .replace(/\bs\.\s*/gi, "santa ")
          .replace(/\bc\.\s*/gi, "citta ")
          .replace(/\bv\.\s*/gi, "via ")
          .trim();
      }

      // Carica tutte le fermate attive del tenant per la direzione richiesta
      const [allStopsRes, allUnitsRes, existingSvcRes, hotelsRes] = await Promise.all([
        auth.admin.from("tenant_bus_line_stops").select("id,bus_line_id,stop_name,city,stop_order,pickup_note")
          .eq("tenant_id", tenantId).eq("direction", parsed.direction).eq("active", true).order("stop_order"),
        auth.admin.from("tenant_bus_units").select("id,bus_line_id,label,capacity,status")
          .eq("tenant_id", tenantId).not("status", "in", '("closed","completed")').order("sort_order"),
        auth.admin.from("services").select("id").eq("tenant_id", tenantId).eq("date", parsed.travel_date),
        auth.admin.from("hotels").select("id,name,zone").eq("tenant_id", tenantId),
      ]);
      if (allStopsRes.error) throw new Error(allStopsRes.error.message);
      if (allUnitsRes.error) throw new Error(allUnitsRes.error.message);
      if (existingSvcRes.error) throw new Error(existingSvcRes.error.message);
      const importHotels = (hotelsRes.data ?? []) as Array<{ id: string; name: string; zone: string | null }>;

      const [pickupTimesRes, linesRes] = await Promise.all([
        auth.admin.from("hotel_pickup_times").select("hotel_name, pickup_time_linea_italia, pickup_time_linea_centro, pickup_time_linea_adriatica"),
        auth.admin.from("tenant_bus_lines").select("id, family_code").eq("tenant_id", tenantId),
      ]);
      const pickupTimesMap = new Map<string, { italia: string; centro: string; adriatica: string }>();
      for (const row of (pickupTimesRes.data ?? []) as Array<{ hotel_name: string; pickup_time_linea_italia: string; pickup_time_linea_centro: string; pickup_time_linea_adriatica: string }>) {
        pickupTimesMap.set(row.hotel_name.toUpperCase().trim(), { italia: row.pickup_time_linea_italia, centro: row.pickup_time_linea_centro, adriatica: row.pickup_time_linea_adriatica });
      }
      const allLinesById = new Map((linesRes.data ?? []).map((l: { id: string; family_code: string }) => [l.id, l]));
      function resolvePickupTime(hotelName: string | null | undefined, lineId: string): string {
        if (!hotelName) return "00:00";
        const entry = pickupTimesMap.get(hotelName.toUpperCase().trim());
        if (!entry) return "00:00";
        const family = (allLinesById.get(lineId)?.family_code ?? "").toLowerCase();
        if (family === "italia") return entry.italia?.slice(0, 5) ?? "00:00";
        if (family === "centro") return entry.centro?.slice(0, 5) ?? "00:00";
        if (family === "adriatica") return entry.adriatica?.slice(0, 5) ?? "00:00";
        return "00:00";
      }

      const existingSvcIds = (existingSvcRes.data ?? []).map((s: { id: string }) => s.id);
      // Se non ci sono servizi per questa data, non ci sono allocazioni → mappa vuota
      let allocData: Array<{ bus_line_id: string; bus_unit_id: string; stop_id: string | null; pax_assigned: number }> = [];
      if (existingSvcIds.length > 0) {
        const allocRes = await auth.admin.from("tenant_bus_allocations").select("bus_line_id,bus_unit_id,stop_id,pax_assigned")
          .eq("tenant_id", tenantId).in("service_id", existingSvcIds);
        if (allocRes.error) throw new Error(allocRes.error.message);
        allocData = (allocRes.data ?? []) as Array<{ bus_line_id: string; bus_unit_id: string; stop_id: string | null; pax_assigned: number }>;
      }

      type DBStop2 = { id: string; bus_line_id: string; stop_name: string; city: string; stop_order: number; pickup_note?: string | null };
      type DBUnit2 = { id: string; bus_line_id: string; label: string; capacity: number; status: string };
      const allLineStops = (allStopsRes.data ?? []) as DBStop2[];
      const allUnits = (allUnitsRes.data ?? []) as DBUnit2[];

      // Mappa pax correnti per bus unit (solo per la data di viaggio)
      const datePaxMap2 = new Map<string, number>();
      const stopBusMap2 = new Map<string, Set<string>>();
      for (const a of allocData) {
        datePaxMap2.set(a.bus_unit_id, (datePaxMap2.get(a.bus_unit_id) ?? 0) + a.pax_assigned);
        if (a.stop_id) {
          const key = `${a.bus_line_id}:${a.stop_id}`;
          const busIds = stopBusMap2.get(key) ?? new Set<string>();
          busIds.add(a.bus_unit_id);
          stopBusMap2.set(key, busIds);
        }
      }

      const STOP_WORDS_AUTO = new Set([
        "di", "del", "della", "delle", "dei", "da", "al", "no", "il", "la", "le", "lo", "e",
        "via", "zona", "area", "nord", "sud", "est", "ovest", "nuovo", "nuova", "san", "santa",
        "fermata", "piazzale", "parcheggio", "casello", "stazione", "terminal", "largo", "uscita",
        "distributore", "autostrada", "autostradale", "superstrada", "rotonda", "svincolo",
        "mercato", "centro", "commerciale", "servizio",
      ]);
      function hasKeywordOverlapAuto(a: string, b: string): boolean {
        const words = (s: string) => s.split(/\s+/).filter((w) => w.length >= 4 && !STOP_WORDS_AUTO.has(w));
        const wa = words(a); const wb = words(b);
        return wa.some((x) => wb.some((y) =>
          x === y ||
          (x.length >= 5 && y.length >= 5 && (x.includes(y) || y.includes(x)))
        ));
      }

      function findStopAuto(city: string): { stop: DBStop2 | null; fuzzy: boolean } {
        const candidates = Array.from(new Set([
          normCityAuto(city),
          normCityAuto(expandBusImportAbbreviations(city)),
        ].filter((candidate) => candidate.length >= 3)));
        if (candidates.length === 0) return { stop: null, fuzzy: false };

        // Exact/high-confidence: city/stop_name match, abbreviation expansion, or
        // stringhe tipo "S.MARIA DEGLI ANGELI HOTEL ANTONELLI" che contengono
        // fermata + dettaglio punto carico. Queste non devono finire in pending.
        const exact = allLineStops.find((s) => {
          const sc = normCityAuto(s.city);
          const sn = normCityAuto(s.stop_name);
          const sp = s.pickup_note ? normCityAuto(s.pickup_note) : "";
          return candidates.some((candidate) =>
            candidate === sc ||
            candidate === sn ||
            (candidate.includes(sc) && sc.length >= 5) ||
            (candidate.includes(sn) && sn.length >= 5) ||
            (sp && candidate.includes(sp) && (candidate.includes(sc) || candidate.includes(sn)))
          );
        });
        if (exact) return { stop: exact, fuzzy: false };

        // Fuzzy residuale: solo suggerimento, resta da validare.
        const fuzzy = allLineStops.find((s) => {
          const sc = normCityAuto(s.city);
          const sn = normCityAuto(s.stop_name);
          const sp = s.pickup_note ? normCityAuto(s.pickup_note) : "";
          return candidates.some((candidate) =>
            sc.includes(candidate) || candidate.includes(sc) ||
            sn.includes(candidate) || candidate.includes(sn) ||
            (sp && (sp.includes(candidate) || candidate.includes(sp) || hasKeywordOverlapAuto(candidate, sp)))
          );
        });
        return { stop: fuzzy ?? null, fuzzy: !!fuzzy };
      }

      // Cache geocoding per evitare chiamate duplicate sulla stessa città
      const geocodingCache = new Map<string, DBStop2 | null>();

      async function findStopAutoWithGeo(city: string): Promise<{ stop: DBStop2 | null; fuzzy: boolean }> {
        const sync = findStopAuto(city);
        if (sync.stop) return sync;

        const cacheKey = normCityAuto(city);
        if (geocodingCache.has(cacheKey)) {
          const cached = geocodingCache.get(cacheKey) ?? null;
          return { stop: cached, fuzzy: true };
        }

        // Chiama Nominatim per ottenere il nome della città/comune
        const candidates = await geocodeCityName(city);
        // Rispetta il rate limit di Nominatim (1 req/sec)
        await new Promise((r) => setTimeout(r, 1100));

        for (const candidate of candidates) {
          const retry = findStopAuto(candidate);
          if (retry.stop) {
            geocodingCache.set(cacheKey, retry.stop);
            return { stop: retry.stop, fuzzy: true };
          }
        }

        geocodingCache.set(cacheKey, null);
        return { stop: null, fuzzy: false };
      }

      function pickBusForLine(lineId: string, stopId: string | null, pax: number): DBUnit2 | null {
        return pickSameStopFirstBus(allUnits, datePaxMap2, stopBusMap2, {
          lineId,
          stopId,
          pax,
        });
      }

      let assigned2 = 0;
      let pending2 = 0;

      const resolvedRows2: Array<{ row: (typeof parsed.rows)[number]; stop: DBStop2 | null; fuzzy: boolean }> = [];
      for (const row of parsed.rows) {
        // Se il client ha già assegnato manualmente la fermata, usala direttamente
        let resolvedStop: DBStop2 | null = null;
        let resolvedFuzzy = false;
        if (row.stop_id && row.bus_line_id) {
          resolvedStop = allLineStops.find((s) => s.id === row.stop_id) ?? null;
          if (!resolvedStop) {
            console.warn(`[import_excel_auto] stop_id ${row.stop_id} non trovato in allLineStops (inattivo?) per "${row.name}" (${row.city})`);
          }
          resolvedFuzzy = false;
        }
        if (!resolvedStop) {
          const found = await findStopAutoWithGeo(row.city);
          resolvedStop = found.stop;
          resolvedFuzzy = found.fuzzy;
        }
        const stop = resolvedStop;
        const fuzzy = resolvedFuzzy;

        resolvedRows2.push({ row, stop, fuzzy });
      }

      const rowsByStop2 = new Map<string, Array<{ row: (typeof parsed.rows)[number]; stop: DBStop2 }>>();
      for (const item of resolvedRows2) {
        const { row, stop, fuzzy } = item;
        if (stop && !fuzzy) {
          const key = `${stop.bus_line_id}:${stop.id}`;
          const list = rowsByStop2.get(key) ?? [];
          list.push({ row, stop });
          rowsByStop2.set(key, list);
        } else {
          // Fermata non trovata → da validare (bus_line_id = primo bus disponibile del tenant come fallback)
          const firstLine = allUnits[0]?.bus_line_id ?? null;
          if (firstLine) {
            await auth.admin.from("bus_import_pending").insert({
              tenant_id: tenantId,
              bus_line_id: firstLine,
              direction: parsed.direction,
              travel_date: parsed.travel_date,
              passenger_name: row.name,
              passenger_phone: row.phone ?? null,
              city_original: row.city,
              pax: row.pax,
              notes: row.notes ?? null,
              geo_suggested_stop: stop?.stop_name ?? null,
            });
          }
          pending2++;
        }
      }

      const groupedRows2 = Array.from(rowsByStop2.values())
        .sort((a, b) => b.reduce((sum, item) => sum + item.row.pax, 0) - a.reduce((sum, item) => sum + item.row.pax, 0));

      for (const group of groupedRows2) {
        const stop = group[0].stop;
        const groupPax = group.reduce((sum, item) => sum + item.row.pax, 0);
        const bus = pickBusForLine(stop.bus_line_id, stop.id, groupPax);
        if (bus) {
          for (const { row } of group) {
            const pickupTime = parsed.direction === "departure" ? resolvePickupTime(row.hotel, stop.bus_line_id) : "00:00";
            const { data: svc, error: svcErr } = await auth.admin.from("services").insert({
              tenant_id: tenantId,
              customer_name: row.name,
              phone: row.phone ?? "",
              direction: parsed.direction,
              date: parsed.travel_date,
              time: pickupTime,
              pickup_time: parsed.direction === "departure" ? pickupTime : null,
              vessel: "Linea bus",
              pax: row.pax,
              bus_city_origin: row.city,
              booking_service_kind: "bus_city_hotel",
              status: "new",
              billing_party_name: row.agency ?? null,
              hotel_id: row.hotel ? (resolveHotelMatch(importHotels, row.hotel, null) ?? undefined) : undefined,
            }).select("id").single();
            if (svcErr || !svc) {
              console.error(`[import_excel_auto] insert services fallita per "${row.name}" (${row.city}): ${svcErr?.message}`);
              pending2++; continue;
            }

            const { error: allocErr } = await auth.admin.rpc("allocate_bus_service", {
              p_tenant_id: tenantId,
              p_service_id: svc.id,
              p_bus_line_id: stop.bus_line_id,
              p_bus_unit_id: bus.id,
              p_stop_id: stop.id,
              p_stop_name: stop.stop_name,
              p_direction: parsed.direction,
              p_pax_assigned: row.pax,
              p_notes: row.hotel ? `Hotel: ${row.hotel}` : (row.notes ?? null),
              p_created_by_user_id: auth.user.id,
            });
            if (allocErr) {
              console.error(`[import_excel_auto] allocate_bus_service fallita per "${row.name}" (${row.city}): ${allocErr.message}`);
              // Elimina il servizio orfano e metti il passeggero in pending
              await auth.admin.from("services").delete().eq("id", svc.id);
              await auth.admin.from("bus_import_pending").insert({
                tenant_id: tenantId,
                bus_line_id: stop.bus_line_id,
                direction: parsed.direction,
                travel_date: parsed.travel_date,
                passenger_name: row.name,
                passenger_phone: row.phone ?? null,
                city_original: row.city,
                pax: row.pax,
                notes: (row.notes ? row.notes + " | " : "") + `Errore: ${allocErr.message}`,
                geo_suggested_stop: stop.stop_name,
              });
              pending2++;
              continue;
            }

            ensureWhatsAppContact(auth.admin, {
              tenantId,
              phone: row.phone,
              profileName: row.name,
            }).catch((contactError) => console.error("WhatsApp contact creation failed:", contactError));

            datePaxMap2.set(bus.id, (datePaxMap2.get(bus.id) ?? 0) + row.pax);
            const stopKey = `${stop.bus_line_id}:${stop.id}`;
            const busIds = stopBusMap2.get(stopKey) ?? new Set<string>();
            busIds.add(bus.id);
            stopBusMap2.set(stopKey, busIds);
            assigned2++;
          }
        } else {
          // Nessun bus disponibile per l'intero gruppo fermata → da validare
          for (const { row } of group) {
            await auth.admin.from("bus_import_pending").insert({
              tenant_id: tenantId,
              bus_line_id: stop.bus_line_id,
              direction: parsed.direction,
              travel_date: parsed.travel_date,
              passenger_name: row.name,
              passenger_phone: row.phone ?? null,
              city_original: row.city,
              pax: row.pax,
              notes: row.notes ?? null,
              geo_suggested_stop: stop.stop_name,
            });
            pending2++;
          }
        }
      }

      return NextResponse.json({ ok: true, assigned: assigned2, pending: pending2, ...(await loadBusNetwork(auth)) });
    }

    if (action === "approve_pending") {
      const approveSchema = z.object({
        pending_id: z.string().uuid(),
        bus_unit_id: z.string().uuid(),
        stop_id: z.string().uuid(),
        travel_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      });
      const parsed = approveSchema.parse(body);

      const { data: pend, error: pendErr } = await auth.admin
        .from("bus_import_pending")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("id", parsed.pending_id)
        .eq("status", "pending")
        .single();
      if (pendErr || !pend) return NextResponse.json({ ok: false, error: "Record non trovato." }, { status: 404 });

      const pRow = pend as { bus_line_id: string; direction: string; passenger_name: string; passenger_phone: string | null; city_original: string; pax: number; notes: string | null };

      const { data: stop } = await auth.admin.from("tenant_bus_line_stops").select("stop_name").eq("id", parsed.stop_id).single();

      const { data: svc, error: svcErr } = await auth.admin.from("services").insert({
        tenant_id: tenantId,
        customer_name: pRow.passenger_name,
        phone: pRow.passenger_phone ?? "",
        direction: pRow.direction,
        date: parsed.travel_date,
        time: "00:00",
        vessel: "Linea bus",
        pax: pRow.pax,
        bus_city_origin: pRow.city_original,
        booking_service_kind: "bus_city_hotel",
        status: "confirmed",
      }).select("id").single();
      if (svcErr || !svc) throw new Error(svcErr?.message ?? "Errore creazione servizio.");

      const { error: allocErr } = await auth.admin.rpc("allocate_bus_service", {
        p_tenant_id: tenantId,
        p_service_id: (svc as { id: string }).id,
        p_bus_line_id: pRow.bus_line_id,
        p_bus_unit_id: parsed.bus_unit_id,
        p_stop_id: parsed.stop_id,
        p_stop_name: (stop as { stop_name: string } | null)?.stop_name ?? pRow.city_original,
        p_direction: pRow.direction as "arrival" | "departure",
        p_pax_assigned: pRow.pax,
        p_notes: pRow.notes,
        p_created_by_user_id: auth.user.id,
      });
      if (allocErr) throw new Error(allocErr.message);

      ensureWhatsAppContact(auth.admin, {
        tenantId,
        phone: pRow.passenger_phone,
        profileName: pRow.passenger_name,
      }).catch((contactError) => console.error("WhatsApp contact creation failed:", contactError));

      await auth.admin.from("bus_import_pending").update({ status: "approved" }).eq("id", parsed.pending_id);
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "reject_pending") {
      const pendingId = z.string().uuid().parse(body?.pending_id);
      await auth.admin.from("bus_import_pending").update({ status: "rejected" }).eq("tenant_id", tenantId).eq("id", pendingId);
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "clear_pending") {
      const parsed = z.object({ date: z.string(), bus_line_id: z.string().uuid().optional(), direction: z.enum(["arrival", "departure"]).optional() }).parse(body);
      // Leggi gli ID da cancellare poi cancellali
      let selectQ = auth.admin.from("bus_import_pending").select("id").eq("tenant_id", tenantId).eq("travel_date", parsed.date).eq("status", "pending");
      if (parsed.bus_line_id) selectQ = selectQ.eq("bus_line_id", parsed.bus_line_id);
      if (parsed.direction) selectQ = selectQ.eq("direction", parsed.direction);
      const { data: toDelete } = await selectQ;
      const ids = (toDelete ?? []).map((r: { id: string }) => r.id);
      if (ids.length > 0) {
        await auth.admin.from("bus_import_pending").delete().eq("tenant_id", tenantId).in("id", ids);
      }
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "create_stop_for_transfer") {
      if (!["admin", "supervisor", "operator"].includes(auth.membership.role)) {
        return NextResponse.json({ ok: false, error: "Non autorizzato." }, { status: 403 });
      }
      const parsed = z.object({
        bus_line_id: z.string().uuid(),
        stop_name: z.string().trim().min(1).max(200),
        direction: z.enum(["arrival", "departure"]),
      }).parse(body);

      const cityName = parsed.stop_name.toUpperCase();

      const existing = await auth.admin.from("tenant_bus_line_stops")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("bus_line_id", parsed.bus_line_id)
        .eq("direction", parsed.direction)
        .ilike("stop_name", cityName)
        .maybeSingle();
      if (existing.data) {
        return NextResponse.json({ ok: true, stop_id: existing.data.id, ...(await loadBusNetwork(auth)) });
      }

      const { data: lineStops } = await auth.admin.from("tenant_bus_line_stops")
        .select("id,stop_name,city,lat,lng,stop_order")
        .eq("tenant_id", tenantId)
        .eq("bus_line_id", parsed.bus_line_id)
        .eq("direction", parsed.direction)
        .eq("active", true)
        .order("stop_order");
      type GeoStop = { id: string; stop_name: string; city: string; lat: number | null; lng: number | null; stop_order: number };
      const stops = (lineStops ?? []) as GeoStop[];

      const geo = await geocodeCity(cityName);
      let insertOrder = (stops.length > 0 ? Math.max(...stops.map(s => s.stop_order)) : 0) + 1;

      if (geo) {
        const withCoords = stops.filter(s => s.lat != null) as Array<GeoStop & { lat: number; lng: number }>;
        if (withCoords.length > 0) {
          const sorted = [...withCoords].sort((a, b) =>
            parsed.direction === "arrival" ? b.lat - a.lat : a.lat - b.lat
          );
          let insertAfterIdx = sorted.length;
          for (let i = 0; i < sorted.length; i++) {
            const cmp = parsed.direction === "arrival"
              ? geo.lat > sorted[i].lat
              : geo.lat < sorted[i].lat;
            if (cmp) { insertAfterIdx = i; break; }
          }
          if (insertAfterIdx === 0) {
            insertOrder = Math.max(1, sorted[0].stop_order - 1);
          } else if (insertAfterIdx >= sorted.length) {
            insertOrder = sorted[sorted.length - 1].stop_order + 1;
          } else {
            insertOrder = sorted[insertAfterIdx - 1].stop_order + 1;
            for (const s of stops) {
              if (s.stop_order >= insertOrder) {
                await auth.admin.from("tenant_bus_line_stops")
                  .update({ stop_order: s.stop_order + 1, order_index: s.stop_order + 1 })
                  .eq("tenant_id", tenantId).eq("id", s.id);
              }
            }
          }
        }
      }

      const { data: newStop, error: stopErr } = await auth.admin.from("tenant_bus_line_stops")
        .insert({
          tenant_id: tenantId,
          bus_line_id: parsed.bus_line_id,
          direction: parsed.direction,
          stop_name: cityName,
          city: cityName,
          stop_order: insertOrder,
          order_index: insertOrder,
          lat: geo?.lat ?? null,
          lng: geo?.lng ?? null,
          is_manual: true,
          active: true,
        })
        .select("id")
        .single();
      if (stopErr || !newStop) {
        return NextResponse.json({ ok: false, error: stopErr?.message ?? "Errore creazione fermata." }, { status: 400 });
      }

      return NextResponse.json({ ok: true, stop_id: (newStop as { id: string }).id, ...(await loadBusNetwork(auth)) });
    }

    if (action === "transfer_allocation_line") {
      if (!["admin", "supervisor", "operator"].includes(auth.membership.role)) {
        return NextResponse.json({ ok: false, error: "Non autorizzato." }, { status: 403 });
      }
      const schema = z.object({
        allocation_id: z.string().uuid(),
        target_bus_line_id: z.string().uuid(),
        target_bus_unit_id: z.string().uuid(),
        target_stop_id: z.string().uuid(),
      });
      const parsed = schema.parse(body);

      // Leggi allocazione corrente
      const { data: alloc, error: allocReadErr } = await auth.admin
        .from("tenant_bus_allocations")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("id", parsed.allocation_id)
        .single();
      if (allocReadErr || !alloc) return NextResponse.json({ ok: false, error: "Allocazione non trovata." }, { status: 404 });

      const a = alloc as { id: string; service_id: string; bus_line_id: string; bus_unit_id: string; direction: string; pax_assigned: number; notes?: string | null };

      // Leggi fermata e bus destinazione prima di toccare l'allocazione corrente.
      const [{ data: targetStop, error: targetStopErr }, { data: targetUnit, error: targetUnitErr }] = await Promise.all([
        auth.admin
          .from("tenant_bus_line_stops")
          .select("id,bus_line_id,direction,stop_name,active")
          .eq("tenant_id", tenantId)
          .eq("id", parsed.target_stop_id)
          .single(),
        auth.admin
          .from("tenant_bus_units")
          .select("id,bus_line_id,label,capacity,status")
          .eq("tenant_id", tenantId)
          .eq("id", parsed.target_bus_unit_id)
          .single()
      ]);
      if (targetStopErr || !targetStop) return NextResponse.json({ ok: false, error: "Fermata destinazione non trovata." }, { status: 404 });
      if (targetUnitErr || !targetUnit) return NextResponse.json({ ok: false, error: "Bus destinazione non trovato." }, { status: 404 });

      const stopRow = targetStop as { id: string; bus_line_id: string; direction: string; stop_name: string; active: boolean };
      let unitRow = targetUnit as { id: string; bus_line_id: string; capacity: number; status: string; label?: string };
      if (!stopRow.active || stopRow.bus_line_id !== parsed.target_bus_line_id || stopRow.direction !== a.direction) {
        return NextResponse.json({ ok: false, error: "Fermata destinazione non coerente con linea/direzione." }, { status: 400 });
      }
      if (unitRow.bus_line_id !== parsed.target_bus_line_id || unitRow.status === "closed" || unitRow.status === "completed") {
        return NextResponse.json({ ok: false, error: "Bus destinazione non coerente o chiuso." }, { status: 400 });
      }

      const { data: serviceRow, error: serviceErr } = await auth.admin
        .from("services")
        .select("date,direction")
        .eq("tenant_id", tenantId)
        .eq("id", a.service_id)
        .single();
      if (serviceErr || !serviceRow) return NextResponse.json({ ok: false, error: "Servizio allocazione non trovato." }, { status: 404 });

      const sameDateServices = await auth.admin
        .from("services")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("date", (serviceRow as { date: string }).date)
        .eq("direction", (serviceRow as { direction: string }).direction);
      if (sameDateServices.error) throw new Error(sameDateServices.error.message);
      const sameDateServiceIds = (sameDateServices.data ?? []).map((row: { id: string }) => row.id);

      let targetLineAllocations: Array<{ id: string; bus_line_id: string; bus_unit_id: string; stop_id: string | null; pax_assigned: number | null }> = [];
      if (sameDateServiceIds.length > 0) {
        const { data, error } = await auth.admin
          .from("tenant_bus_allocations")
          .select("id,bus_line_id,bus_unit_id,stop_id,pax_assigned")
          .eq("tenant_id", tenantId)
          .eq("bus_line_id", parsed.target_bus_line_id)
          .in("service_id", sameDateServiceIds);
        if (error) throw new Error(error.message);
        targetLineAllocations = data ?? [];
      }

      const { data: targetLineUnits, error: targetLineUnitsErr } = await auth.admin
        .from("tenant_bus_units")
        .select("id,bus_line_id,label,capacity,status")
        .eq("tenant_id", tenantId)
        .eq("bus_line_id", parsed.target_bus_line_id)
        .order("sort_order");
      if (targetLineUnitsErr) throw new Error(targetLineUnitsErr.message);

      const targetDatePax = new Map<string, number>();
      const targetStopBusMap = new Map<string, Set<string>>();
      for (const allocation of targetLineAllocations) {
        if (allocation.id === a.id) continue;
        targetDatePax.set(allocation.bus_unit_id, (targetDatePax.get(allocation.bus_unit_id) ?? 0) + Number(allocation.pax_assigned ?? 0));
        if (allocation.stop_id) {
          const key = `${allocation.bus_line_id}:${allocation.stop_id}`;
          const busIds = targetStopBusMap.get(key) ?? new Set<string>();
          busIds.add(allocation.bus_unit_id);
          targetStopBusMap.set(key, busIds);
        }
      }

      const effectiveUnit = pickSameStopFirstBus(
        ((targetLineUnits ?? []) as Array<{ id: string; bus_line_id: string; label: string; capacity: number; status: string }>)
          .filter((unit) => unit.status !== "closed" && unit.status !== "completed"),
        targetDatePax,
        targetStopBusMap,
        {
          lineId: parsed.target_bus_line_id,
          stopId: parsed.target_stop_id,
          pax: a.pax_assigned,
          preferredLabels: unitRow.label ? [unitRow.label] : undefined,
        }
      );
      const targetStopBusIds = targetStopBusMap.get(`${parsed.target_bus_line_id}:${parsed.target_stop_id}`) ?? new Set<string>();
      if (!effectiveUnit && targetStopBusIds.size > 0) {
        return NextResponse.json({ ok: false, error: "Fermata gia' presente su un bus senza capienza: spostamento bloccato per non spezzare la fermata." }, { status: 400 });
      }
      if (effectiveUnit) unitRow = effectiveUnit;

      const targetBusPax = targetDatePax.get(unitRow.id) ?? 0;
      if (targetBusPax + a.pax_assigned > unitRow.capacity) {
        return NextResponse.json({ ok: false, error: "Capienza bus destinazione superata." }, { status: 400 });
      }

      const targetStopName = stopRow.stop_name;
      const { error: updateAllocErr } = await auth.admin
        .from("tenant_bus_allocations")
        .update({
          bus_line_id: parsed.target_bus_line_id,
          bus_unit_id: unitRow.id,
          stop_id: parsed.target_stop_id,
          stop_name: targetStopName,
        })
        .eq("tenant_id", tenantId)
        .eq("id", parsed.allocation_id);
      if (updateAllocErr) throw new Error(updateAllocErr.message);

      await auth.admin
        .from("services")
        .update({ bus_city_origin: targetStopName })
        .eq("tenant_id", tenantId)
        .eq("id", a.service_id);

      // Traccia nel log movimenti
      await auth.admin.from("tenant_bus_allocation_moves").insert({
        tenant_id: tenantId,
        service_id: a.service_id,
        from_bus_unit_id: a.bus_unit_id,
        to_bus_unit_id: unitRow.id,
        stop_name: targetStopName,
        pax_moved: a.pax_assigned,
        reason: `Trasferito a linea diversa`,
        created_by_user_id: auth.user.id,
      });

      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    // ── Distribuzione Ischia ────────────────────────────────────────────────

    if (action === "smista_ischia") {
      const schema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
      const parsed = schema.parse(body);
      const BUS_CAPACITY = 50;

      // ── Step 1: tutti i servizi linea bus in arrivo ─────────────────────────
      const { data: rawServices, error: lsErr } = await auth.admin
        .from("services")
        .select("id, customer_name, customer_first_name, customer_last_name, pax, hotel_id, meeting_point")
        .eq("tenant_id", tenantId).eq("direction", "arrival").eq("date", parsed.date)
        .or("service_type_code.eq.bus_line,booking_service_kind.eq.bus_city_hotel");
      if (lsErr) throw new Error(`Errore lettura passeggeri: ${lsErr.message}`);
      if (!rawServices?.length)
        return NextResponse.json({ ok: false, error: `Nessun passeggero linea bus in arrivo per il ${parsed.date}.` }, { status: 400 });

      const serviceIds = (rawServices as Array<{ id: string }>).map(s => s.id);

      // ── Step 2: dati ausiliari in parallelo ─────────────────────────────────
      const [
        { data: allocDetails },
        { data: allHotels },
        { data: exclusiveAllocs },
        { data: exclusiveUnits },
        { data: lineAllocations },
        { data: busUnitsForLines },
        { data: linesMeta },
        { data: ferryConfigs },
      ] = await Promise.all([
        auth.admin.from("ops_bus_allocation_details").select("service_id, hotel_name")
          .eq("tenant_id", tenantId).eq("direction", "arrival").eq("service_date", parsed.date),
        auth.admin.from("hotels").select("id, name, zone, lat, lng").eq("tenant_id", tenantId),
        auth.admin.from("tenant_bus_allocations").select("service_id, bus_unit_id")
          .eq("tenant_id", tenantId).eq("direction", "arrival").in("service_id", serviceIds),
        auth.admin.from("tenant_bus_units").select("id, label").eq("tenant_id", tenantId).eq("tag", "esclusivo"),
        auth.admin.from("tenant_bus_allocations").select("service_id, bus_unit_id")
          .eq("tenant_id", tenantId).eq("direction", "arrival").in("service_id", serviceIds),
        auth.admin.from("tenant_bus_units").select("id, bus_line_id").eq("tenant_id", tenantId),
        // Mappa line_id → family_code per ordinamento per orario traghetto
        auth.admin.from("tenant_bus_lines").select("id, family_code").eq("tenant_id", tenantId),
        auth.admin.from("bus_line_ferry_config").select("bus_line_family_code, departure_time, sort_order").eq("tenant_id", tenantId),
      ]);

      // ── Step 3: lookup hotel name + zona ───────────────────────────────────
      type HotelRow = { id: string; name: string; zone: string; lat: number | null; lng: number | null };
      const hotelList = (allHotels ?? []) as HotelRow[];
      const hotelsById = new Map(hotelList.map(h => [h.id, h]));
      const hotelNameFromAlloc = new Map<string, string>();
      for (const a of (allocDetails ?? []) as Array<{ service_id: string; hotel_name: string | null }>)
        if (a.hotel_name && !hotelNameFromAlloc.has(a.service_id)) hotelNameFromAlloc.set(a.service_id, a.hotel_name);

      const findHotel = (name: string): HotelRow | null => {
        if (!name || name === "Hotel N/D") return null;
        const n = name.toLowerCase().trim();
        return hotelList.find(h => h.name.toLowerCase().trim() === n)
          ?? hotelList.find(h => { const hay = h.name.toLowerCase().trim(); return hay.includes(n) || n.includes(hay); })
          ?? null;
      };

      // ── Step 4b: mappa service_id → bus_line_id ────────────────────────────
      // Ogni servizio è allocato a un bus unit; il bus unit ha un bus_line_id
      const unitToLine = new Map<string, string>();
      for (const u of (busUnitsForLines ?? []) as Array<{ id: string; bus_line_id: string }>) {
        if (u.bus_line_id) unitToLine.set(u.id, u.bus_line_id);
      }
      const serviceToLineId = new Map<string, string>();
      for (const a of (lineAllocations ?? []) as Array<{ service_id: string; bus_unit_id: string }>) {
        const lineId = unitToLine.get(a.bus_unit_id);
        if (lineId) serviceToLineId.set(a.service_id, lineId);
      }

      if (serviceToLineId.size === 0) {
        return NextResponse.json({
          ok: false,
          error: "Non ci sono ancora passeggeri allocati sulle linee bus per questa data. Prima assegna i passeggeri alle linee, poi esegui Smistamento Ischia."
        }, { status: 400 });
      }

      type Svc = { service_id: string; customer_name: string; pax_assigned: number; hotel_name: string; hotel_zone: string; bus_line_id: string | null };
      const enriched: Svc[] = (rawServices as Array<{ id: string; customer_name: string | null; customer_first_name: string | null; customer_last_name: string | null; pax: number; hotel_id: string | null; meeting_point: string | null }>).map(s => {
        const hotelFromId = s.hotel_id ? hotelsById.get(s.hotel_id) : null;
        const fullName = [s.customer_first_name, s.customer_last_name].filter(Boolean).join(" ") || s.customer_name || "Cliente N/D";
        const hotelName = hotelNameFromAlloc.get(s.id) ?? hotelFromId?.name ?? s.meeting_point ?? "Hotel N/D";
        const matchedHotel = hotelFromId ?? findHotel(hotelName);
        return { service_id: s.id, customer_name: fullName, pax_assigned: s.pax, hotel_name: hotelName, hotel_zone: matchedHotel?.zone ?? "ischia", bus_line_id: serviceToLineId.get(s.id) ?? null };
      });

      // ── Step 4: coordinate per nearest-neighbor ─────────────────────────────
      const coordMap = new Map<string, { lat: number; lng: number }>();
      for (const svc of enriched) {
        if (coordMap.has(svc.hotel_name)) continue;
        const h = findHotel(svc.hotel_name);
        if (h?.lat && h?.lng) coordMap.set(svc.hotel_name, { lat: h.lat, lng: h.lng });
      }

      // ── Step 5: separa passeggeri ESCLUSIVI da quelli regolari ─────────────
      const exclusiveUnitIds = new Set((exclusiveUnits ?? []).map((u: { id: string }) => u.id));
      const exclusiveServiceIds = new Set(
        (exclusiveAllocs ?? [])
          .filter((a: { bus_unit_id: string }) => exclusiveUnitIds.has(a.bus_unit_id))
          .map((a: { service_id: string }) => a.service_id)
      );
      // Raggruppa i passeggeri esclusivi per bus_unit_id
      const exclusiveByUnit = new Map<string, { label: string; passengers: Svc[] }>();
      for (const alloc of (exclusiveAllocs ?? []) as Array<{ service_id: string; bus_unit_id: string }>) {
        if (!exclusiveUnitIds.has(alloc.bus_unit_id)) continue;
        const unitLabel = (exclusiveUnits ?? []).find((u: { id: string; label: string }) => u.id === alloc.bus_unit_id)?.label ?? "Esclusivo";
        const svc = enriched.find(e => e.service_id === alloc.service_id);
        if (!svc) continue;
        const bucket = exclusiveByUnit.get(alloc.bus_unit_id) ?? { label: unitLabel, passengers: [] as Svc[] };
        bucket.passengers.push(svc);
        exclusiveByUnit.set(alloc.bus_unit_id, bucket);
      }
      const regularServices = enriched.filter(s => !exclusiveServiceIds.has(s.service_id));

      // ── Step 6: raggruppa regolari per zona ────────────────────────────────
      const byZone = new Map<string, Svc[]>();
      for (const svc of regularServices) {
        const b = byZone.get(svc.hotel_zone) ?? []; b.push(svc); byZone.set(svc.hotel_zone, b);
      }

      // ── Step 7: elimina bus esistenti e ricrea ─────────────────────────────
      const { error: delErr } = await auth.admin.from("bus_ischia_dist_buses")
        .delete().eq("tenant_id", tenantId).eq("date", parsed.date);
      if (delErr) throw new Error(`Errore pulizia bus esistenti: ${delErr.message}`);

      // Helper: crea bus + alloca passeggeri con stop_order geografico
      const createDistBus = async (label: string, zone: string, passengers: Svc[], so: number, busLineId: string | null = null) => {
        const sorted = sortPassengersByRoute(passengers, coordMap);
        const { data: nb, error: be } = await auth.admin.from("bus_ischia_dist_buses").insert({
          tenant_id: tenantId, date: parsed.date, bus_line_id: busLineId,
          label, zone, capacity: BUS_CAPACITY, sort_order: so,
        }).select("id").single();
        if (be) throw new Error(`Errore creazione bus ${label}: ${be.message}`);
        if (nb?.id) {
          const rows = sorted.map(p => ({
            tenant_id: tenantId, dist_bus_id: nb.id, service_id: p.service_id,
            pax_assigned: p.pax_assigned, customer_name: p.customer_name,
            hotel_name: p.hotel_name, hotel_zone: zone, stop_order: p.stop_order,
          }));
          const { error: ae } = await auth.admin.from("bus_ischia_dist_allocations").insert(rows);
          if (ae) throw new Error(`Errore allocazione ${label}: ${ae.message}`);
        }
      };

      let sortOrder = 0;
      // Bus esclusivi (uno per ogni bus unit esclusivo)
      for (const [, { label, passengers }] of exclusiveByUnit.entries()) {
        if (!passengers.length) continue;
        const zone = passengers[0].hotel_zone;
        const lineId = passengers[0].bus_line_id ?? null;
        await createDistBus(`⭐ ${label}`, zone, passengers, sortOrder++, lineId);
      }

      // Mappa line_id → orario traghetto per ordinamento cronologico
      const lineFamilyMap = new Map<string, string>(
        ((linesMeta ?? []) as Array<{ id: string; family_code: string }>)
          .map(l => [l.id, l.family_code.toLowerCase()])
      );
      const ferryTimeByFamily = new Map<string, string>(
        ((ferryConfigs ?? []) as Array<{ bus_line_family_code: string; departure_time: string; sort_order: number }>)
          .map(c => [c.bus_line_family_code.toLowerCase(), c.departure_time])
      );
      const ferryOrderByFamily = new Map<string, number>(
        ((ferryConfigs ?? []) as Array<{ bus_line_family_code: string; sort_order: number }>)
          .map(c => [c.bus_line_family_code.toLowerCase(), c.sort_order])
      );
      const lineOrder = (lineId: string | null): number => {
        if (!lineId) return 999;
        const fc = lineFamilyMap.get(lineId);
        return (fc ? ferryOrderByFamily.get(fc) : undefined) ?? 999;
      };

      // Bus regolari: raggruppa prima per linea, poi per zona
      const byLine = new Map<string | null, Svc[]>();
      for (const svc of regularServices) {
        const key = svc.bus_line_id ?? null;
        const b = byLine.get(key) ?? []; b.push(svc); byLine.set(key, b);
      }

      // Ordina i gruppi linea per orario traghetto (centro 12:00 → adriatica 13:30 → italia 18:30)
      const sortedByLine = [...byLine.entries()].sort(([a], [b]) => lineOrder(a) - lineOrder(b));

      for (const [lineId, lineSvcs] of sortedByLine) {
        // Raggruppa per zona all'interno della linea
        const byZoneLine = new Map<string, Svc[]>();
        for (const svc of lineSvcs) {
          const b = byZoneLine.get(svc.hotel_zone) ?? []; b.push(svc); byZoneLine.set(svc.hotel_zone, b);
        }
        for (const [zone, passengers] of byZoneLine.entries()) {
          const baseLabel = ZONE_LABELS[zone] ?? `Bus ${zone}`;
          const chunks: Svc[][] = [];
          let cur: Svc[] = [], curPax = 0;
          for (const p of passengers) {
            if (curPax + p.pax_assigned > BUS_CAPACITY && cur.length > 0) { chunks.push(cur); cur = []; curPax = 0; }
            cur.push(p); curPax += p.pax_assigned;
          }
          if (cur.length > 0) chunks.push(cur);
          for (let i = 0; i < chunks.length; i++) {
            await createDistBus(chunks.length > 1 ? `${baseLabel} ${i + 1}` : baseLabel, zone, chunks[i], sortOrder++, lineId);
          }
        }
      }

      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "move_dist") {
      // Sposta un passeggero da un bus distribuzione a un altro
      const schema = z.object({
        allocation_id: z.string().uuid(),
        to_dist_bus_id: z.string().uuid(),
      });
      const parsed = schema.parse(body);

      // Blocca spostamento su bus esclusivo (label inizia con ⭐)
      const { data: targetBus } = await auth.admin.from("bus_ischia_dist_buses")
        .select("label").eq("id", parsed.to_dist_bus_id).eq("tenant_id", tenantId).single();
      if (targetBus?.label?.startsWith("⭐")) {
        return NextResponse.json({ ok: false, error: "Bus esclusivo: non è possibile aggiungere altri passeggeri." }, { status: 400 });
      }

      await auth.admin.from("bus_ischia_dist_allocations")
        .update({ dist_bus_id: parsed.to_dist_bus_id })
        .eq("id", parsed.allocation_id)
        .eq("tenant_id", tenantId);
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "reorder_dist_alloc") {
      // Riordina lo stop_order di un passeggero dentro lo stesso bus di distribuzione.
      // before_allocation_id = inserisci PRIMA di questa; null = sposta in fondo.
      const schema = z.object({
        allocation_id: z.string().uuid(),
        before_allocation_id: z.string().uuid().nullable(),
      });
      const parsed = schema.parse(body);

      // Recupera bus del passeggero trascinato
      const { data: moved } = await auth.admin
        .from("bus_ischia_dist_allocations")
        .select("dist_bus_id")
        .eq("id", parsed.allocation_id)
        .eq("tenant_id", tenantId)
        .single();
      if (!moved) return NextResponse.json({ ok: false, error: "Allocazione non trovata." }, { status: 404 });

      // Carica tutte le allocazioni del bus, ordinate per stop_order corrente
      const { data: allAllocs } = await auth.admin
        .from("bus_ischia_dist_allocations")
        .select("id, stop_order")
        .eq("dist_bus_id", moved.dist_bus_id)
        .eq("tenant_id", tenantId)
        .order("stop_order");

      if (!allAllocs?.length) return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });

      // Ricostruisce la lista spostando l'elemento nella nuova posizione
      type AllocRow = { id: string; stop_order: number };
      const list = allAllocs as AllocRow[];
      const filtered = list.filter((a) => a.id !== parsed.allocation_id);
      const draggedItem = list.find((a) => a.id === parsed.allocation_id);
      if (!draggedItem) return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });

      let newList: AllocRow[];
      if (parsed.before_allocation_id === null) {
        newList = [...filtered, draggedItem];
      } else {
        const insertIdx = filtered.findIndex((a) => a.id === parsed.before_allocation_id);
        if (insertIdx === -1) {
          newList = [...filtered, draggedItem];
        } else {
          newList = [...filtered.slice(0, insertIdx), draggedItem, ...filtered.slice(insertIdx)];
        }
      }

      // Aggiorna stop_order in batch
      await Promise.all(
        newList.map((a, idx) =>
          auth.admin
            .from("bus_ischia_dist_allocations")
            .update({ stop_order: idx })
            .eq("id", a.id)
            .eq("tenant_id", tenantId)
        )
      );

      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "add_dist_bus") {
      const schema = z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        label: z.string().min(2).max(120),
        zone: z.string().min(2).max(60),
        capacity: z.number().int().min(1).max(120).default(50),
        section: z.enum(["ischia", "pozzuoli"]).default("ischia"),
      });
      const parsed = schema.parse(body);
      await auth.admin.from("bus_ischia_dist_buses").insert({ tenant_id: tenantId, bus_line_id: null, ...parsed });
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "clone_dist_bus") {
      const dist_bus_id = z.string().uuid().parse(body?.dist_bus_id);
      const { data: orig, error: origErr } = await auth.admin
        .from("bus_ischia_dist_buses").select("*")
        .eq("id", dist_bus_id).eq("tenant_id", tenantId).single();
      if (origErr || !orig) return NextResponse.json({ ok: false, error: "Bus non trovato" }, { status: 404 });
      const { id: _id, created_at: _ca, ...fields } = orig as Record<string, unknown>;
      await auth.admin.from("bus_ischia_dist_buses").insert({
        ...fields,
        tenant_id: tenantId,
        sort_order: ((fields.sort_order as number) ?? 0) + 1,
      });
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "update_dist_bus") {
      const schema = z.object({
        dist_bus_id: z.string().uuid(),
        label: z.string().min(2).max(120).optional(),
        driver_name: z.string().max(120).optional().nullable(),
        driver_phone: z.string().max(60).optional().nullable(),
        driver_profile_id: z.string().uuid().optional().nullable(),
        vehicle_id: z.string().uuid().optional().nullable(),
        capacity: z.number().int().min(1).max(200).optional(),
      });
      const { dist_bus_id, ...patch } = schema.parse(body);

      // Se viene selezionato un veicolo, auto-fill capienza e label
      if (patch.vehicle_id) {
        const { data: veh } = await auth.admin.from("vehicles").select("capacity, label").eq("id", patch.vehicle_id).maybeSingle();
        if (veh) {
          if (!patch.capacity) patch.capacity = veh.capacity ?? 50;
          if (!patch.label) patch.label = veh.label;
        }
      }

      await auth.admin.from("bus_ischia_dist_buses").update(patch).eq("id", dist_bus_id).eq("tenant_id", tenantId);

      // ── Overflow: se nuova capacità < pax presenti, sposta l'eccesso ──────
      if (patch.capacity) {
        const { data: thisBus } = await auth.admin.from("bus_ischia_dist_buses")
          .select("zone, date, sort_order").eq("id", dist_bus_id).single();
        const { data: allocs } = await auth.admin.from("bus_ischia_dist_allocations")
          .select("id, pax_assigned").eq("dist_bus_id", dist_bus_id).eq("tenant_id", tenantId).order("stop_order");
        if (thisBus && allocs) {
          let used = 0; const overflow: string[] = [];
          for (const a of allocs as Array<{ id: string; pax_assigned: number }>) {
            used += a.pax_assigned;
            if (used > patch.capacity) overflow.push(a.id);
          }
          if (overflow.length > 0) {
            // Cerca un altro bus della stessa zona con spazio
            const { data: siblings } = await auth.admin
              .from("bus_ischia_dist_buses")
              .select("id, capacity, bus_ischia_dist_allocations(pax_assigned)")
              .eq("tenant_id", tenantId).eq("date", thisBus.date).eq("zone", thisBus.zone)
              .neq("id", dist_bus_id);
            let targetId: string | null = null;
            for (const sib of (siblings ?? []) as Array<{ id: string; capacity: number; bus_ischia_dist_allocations: Array<{ pax_assigned: number }> }>) {
              const usedSib = sib.bus_ischia_dist_allocations.reduce((s, a) => s + a.pax_assigned, 0);
              if (usedSib < sib.capacity) { targetId = sib.id; break; }
            }
            if (!targetId) {
              // Crea un nuovo bus overflow
              const { data: nb } = await auth.admin.from("bus_ischia_dist_buses").insert({
                tenant_id: tenantId, date: thisBus.date, bus_line_id: null,
                label: `${ZONE_LABELS[thisBus.zone] ?? `Bus ${thisBus.zone}`} (overflow)`,
                zone: thisBus.zone, capacity: 50, sort_order: (thisBus.sort_order ?? 0) + 1,
              }).select("id").single();
              targetId = nb?.id ?? null;
            }
            if (targetId) {
              await auth.admin.from("bus_ischia_dist_allocations")
                .update({ dist_bus_id: targetId }).in("id", overflow).eq("tenant_id", tenantId);
            }
          }
        }
      }

      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "set_service_hotel") {
      // Aggiorna il nome hotel di un passeggero nello smistamento.
      // Se hotel_id è fornito: collega l'hotel esistente al servizio.
      // Se new_hotel è fornito: crea l'hotel nel DB, poi collega.
      const schema = z.object({
        allocation_id: z.string().uuid(),
        hotel_id: z.string().uuid().optional().nullable(),
        new_hotel: z.object({
          name: z.string().min(2).max(200),
          address: z.string().min(2).max(300),
          zone: z.string().min(2).max(60),
          lat: z.number().optional().default(40.7427),
          lng: z.number().optional().default(13.9567),
        }).optional().nullable(),
      });
      const p = schema.parse(body);

      // Recupera l'allocation per trovare il service_id
      const { data: alloc } = await auth.admin.from("bus_ischia_dist_allocations")
        .select("service_id").eq("id", p.allocation_id).eq("tenant_id", tenantId).single();
      if (!alloc) return NextResponse.json({ ok: false, error: "Allocazione non trovata." }, { status: 404 });

      let finalHotelId: string | null = p.hotel_id ?? null;
      let finalHotelName: string | null = null;
      let finalHotelZone: string | null = null;

      if (p.new_hotel) {
        // Crea il nuovo hotel
        const { data: created, error: hErr } = await auth.admin.from("hotels").insert({
          tenant_id: tenantId,
          name: p.new_hotel.name.toUpperCase().trim(),
          address: p.new_hotel.address,
          zone: p.new_hotel.zone,
          lat: p.new_hotel.lat,
          lng: p.new_hotel.lng,
        }).select("id, name, zone").single();
        if (hErr || !created) throw new Error(hErr?.message ?? "Errore creazione hotel");
        finalHotelId = created.id;
        finalHotelName = created.name;
        finalHotelZone = created.zone;
      } else if (finalHotelId) {
        const { data: h } = await auth.admin.from("hotels").select("name, zone").eq("id", finalHotelId).single();
        finalHotelName = h?.name ?? null;
        finalHotelZone = h?.zone ?? null;
      }

      // Aggiorna hotel_id sul servizio
      if (finalHotelId) {
        await auth.admin.from("services").update({ hotel_id: finalHotelId })
          .eq("id", (alloc as { service_id: string }).service_id).eq("tenant_id", tenantId);
      }
      // Aggiorna hotel_name e hotel_zone sull'allocation
      if (finalHotelName) {
        await auth.admin.from("bus_ischia_dist_allocations")
          .update({ hotel_name: finalHotelName, hotel_zone: finalHotelZone ?? "ischia" })
          .eq("id", p.allocation_id).eq("tenant_id", tenantId);
      }

      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "create_driver_profile") {
      // Crea un nuovo autista nel registro e lo assegna al bus distribuzione
      const schema = z.object({
        full_name: z.string().min(2).max(200),
        phone: z.string().max(60).optional().nullable(),
        dist_bus_id: z.string().uuid().optional().nullable(),
      });
      const { full_name, phone, dist_bus_id } = schema.parse(body);
      const { data: newDriver, error: dErr } = await auth.admin
        .from("driver_profiles")
        .insert({ tenant_id: tenantId, full_name, phone: phone ?? null, active: true })
        .select("id").single();
      if (dErr || !newDriver) throw new Error(dErr?.message ?? "Errore creazione autista");

      if (dist_bus_id) {
        await auth.admin.from("bus_ischia_dist_buses")
          .update({ driver_profile_id: newDriver.id, driver_name: full_name, driver_phone: phone ?? null })
          .eq("id", dist_bus_id).eq("tenant_id", tenantId);
      }
      return NextResponse.json({ ok: true, driver_id: newDriver.id, ...(await loadBusNetwork(auth)) });
    }

    if (action === "remove_dist_bus") {
      const dist_bus_id = z.string().uuid().parse(body?.dist_bus_id);
      await auth.admin.from("bus_ischia_dist_buses").delete().eq("id", dist_bus_id).eq("tenant_id", tenantId);
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "create_hotel") {
      const schema = z.object({
        name: z.string().min(2).max(200),
        address: z.string().min(2).max(300),
        city: z.string().min(2).max(100),
      });
      const p = schema.parse(body);
      const { data: created, error: hErr } = await auth.admin.from("hotels").insert({
        tenant_id: tenantId,
        name: p.name.toUpperCase().trim(),
        address: `${p.address}, ${p.city}`,
        zone: "ischia",
        lat: 40.7427,
        lng: 13.9567,
      }).select("id, name, zone").single();
      if (hErr || !created) throw new Error(hErr?.message ?? "Errore creazione hotel");
      return NextResponse.json({ ok: true, hotel: created });
    }

    return NextResponse.json({ ok: false, error: "Azione non supportata." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
