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
  suggestBusRedistribution
} from "@/lib/server/bus-network";
import { getCustomerFullName } from "@/lib/service-display";
import type { AgencyBookingServiceKind, OperationalServiceType } from "@/lib/types";
import { validateBusAllocationRequest, validateBusMoveRequest } from "@/lib/server/bus-network-validation";
import { sendBusLowSeatAlertEmail } from "@/lib/server/bus-alert-email";

async function checkAndAlertLowSeats(
  auth: PricingAuthContext,
  tenantId: string,
  busUnitId: string
): Promise<{ busLabel: string; lineName: string; remainingSeats: number; threshold: number } | null> {
  const [unitResult, allocResult] = await Promise.all([
    auth.admin
      .from("tenant_bus_units")
      .select("id,bus_line_id,label,capacity,low_seat_threshold")
      .eq("tenant_id", tenantId)
      .eq("id", busUnitId)
      .maybeSingle(),
    auth.admin
      .from("tenant_bus_allocations")
      .select("pax_assigned")
      .eq("tenant_id", tenantId)
      .eq("bus_unit_id", busUnitId)
  ]);
  if (unitResult.error || allocResult.error || !unitResult.data) return null;

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

const unitUpdateSchema = z.object({
  unit_id: z.string().uuid(),
  capacity: z.number().int().min(1).max(120),
  low_seat_threshold: z.number().int().min(0).max(120),
  minimum_passengers: z.number().int().min(1).max(120).nullable(),
  status: z.enum(["open", "low", "closed", "completed"]),
  close_reason: z.string().max(500).optional().nullable()
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

const reorderStopsSchema = z.object({
  bus_line_id: z.string().uuid(),
  direction: z.enum(["arrival", "departure"]),
  stop_ids: z.array(z.string().uuid()).min(1)
});

async function loadBusNetwork(auth: PricingAuthContext) {
  const tenantId = auth.membership.tenant_id;
  const [linesResult, stopsResult, unitsResult, allocationsResult, allocationDetailsResult, movesResult, servicesResult, hotelsResult] = await Promise.all([
    auth.admin.from("tenant_bus_lines").select("*").eq("tenant_id", tenantId).order("family_code").order("name"),
    auth.admin.from("tenant_bus_line_stops").select("*").eq("tenant_id", tenantId).order("direction").order("order_index").order("stop_order"),
    auth.admin.from("tenant_bus_units").select("*").eq("tenant_id", tenantId).order("bus_line_id").order("sort_order"),
    auth.admin.from("tenant_bus_allocations").select("*").eq("tenant_id", tenantId),
    auth.admin.from("ops_bus_allocation_details").select("*"),
    auth.admin.from("tenant_bus_allocation_moves").select("*").eq("tenant_id", tenantId).order("created_at", { ascending: false }).limit(80),
    auth.admin
      .from("services")
      .select("*")
      .eq("tenant_id", tenantId)
      .or("service_type_code.eq.bus_line,booking_service_kind.eq.bus_city_hotel")
      .order("date")
      .order("time"),
    auth.admin.from("hotels").select("*").eq("tenant_id", tenantId)
  ]);

  const error =
    linesResult.error ||
    stopsResult.error ||
    unitsResult.error ||
    allocationsResult.error ||
    allocationDetailsResult.error ||
    movesResult.error ||
    servicesResult.error ||
    hotelsResult.error;
  if (error) {
    throw new Error(error.message);
  }

  const lines = linesResult.data ?? [];
  const stops = stopsResult.data ?? [];
  const units = unitsResult.data ?? [];
  const allocations = allocationsResult.data ?? [];
  const services = servicesResult.data ?? [];
  const hotels = hotelsResult.data ?? [];
  const hotelsById = new Map<string, { id: string; name: string }>(hotels.map((hotel: { id: string; name: string }) => [hotel.id, hotel]));

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
    booking_service_kind?: AgencyBookingServiceKind | null | undefined;
    service_type_code?: OperationalServiceType | null | undefined;
    outbound_time?: string | null;
  }) => {
    const identity = deriveServiceBusIdentity(service);
    const hotel = hotelsById.get(service.hotel_id);
    return {
      ...service,
      customer_display_name: getCustomerFullName(service),
      phone_display: service.phone_e164 ?? service.phone ?? "N/D",
      hotel_name: hotel?.name ?? "Hotel N/D",
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
    arrival_windows: arrivalWindows
  };
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const payload = await loadBusNetwork(auth);
    return NextResponse.json({ ok: true, ...payload });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
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

    if (action === "allocate_service") {
      const parsed = allocateSchema.parse(body);
      if (!parsed.stop_id) {
        return NextResponse.json({ ok: false, error: "Fermata obbligatoria per allocare il servizio." }, { status: 400 });
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

    return NextResponse.json({ ok: false, error: "Azione non supportata." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
