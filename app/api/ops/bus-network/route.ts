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
import { findBusStopsByCity } from "@/lib/server/bus-lines-catalog";
import { geocodeCity, geocodeCityName } from "@/lib/server/geocoding";
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

const updateDriverSchema = z.object({
  unit_id: z.string().uuid(),
  driver_name: z.string().max(120).optional().nullable(),
  driver_phone: z.string().max(60).optional().nullable()
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

const reorderStopsSchema = z.object({
  bus_line_id: z.string().uuid(),
  direction: z.enum(["arrival", "departure"]),
  stop_ids: z.array(z.string().uuid()).min(1)
});

async function loadBusNetwork(auth: PricingAuthContext) {
  const tenantId = auth.membership.tenant_id;
  const [linesResult, stopsResult, unitsResult, allocationsResult, allocationDetailsResult, movesResult, servicesResult, hotelsResult, pendingResult] = await Promise.all([
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
    auth.admin.from("bus_import_pending").select("*").eq("tenant_id", tenantId).eq("status", "pending").order("created_at", { ascending: false })
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
    arrival_windows: arrivalWindows,
    pending_passengers: pendingResult.data ?? []
  };
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const payload = await loadBusNetwork(auth);
    return NextResponse.json({ ok: true, user_role: auth.membership.role, ...payload });
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
      const { error } = await auth.admin
        .from("tenant_bus_units")
        .update({
          driver_name: parsed.driver_name ?? null,
          driver_phone: parsed.driver_phone ?? null,
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

      const orderA = (resA.data as { stop_order: number }).stop_order;
      const orderB = (resB.data as { stop_order: number }).stop_order;

      // Aggiorna solo i 2 stop che cambiano — in parallelo (nessun unique constraint su stop_order)
      // .select("id") forza RETURNING e garantisce che le righe siano state effettivamente aggiornate
      const [sw1, sw2] = await Promise.all([
        auth.admin.from("tenant_bus_line_stops").update({ stop_order: orderB, order_index: orderB }).eq("tenant_id", tenantId).eq("id", parsed.stop_id_a).select("id"),
        auth.admin.from("tenant_bus_line_stops").update({ stop_order: orderA, order_index: orderA }).eq("tenant_id", tenantId).eq("id", parsed.stop_id_b).select("id")
      ]);
      if (sw1.error) throw new Error("Swap A: " + sw1.error.message);
      if (sw2.error) throw new Error("Swap B: " + sw2.error.message);
      if (!sw1.data?.length) throw new Error("Fermata A non aggiornata (0 righe) — tenant_id mismatch?");
      if (!sw2.data?.length) throw new Error("Fermata B non aggiornata (0 righe) — tenant_id mismatch?");

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
        direction: z.enum(["arrival", "departure"])
      }).parse(body);

      const { data: stops, error: stopsErr } = await auth.admin
        .from("tenant_bus_line_stops")
        .select("id,stop_name,city,lat,lng")
        .eq("tenant_id", tenantId)
        .eq("bus_line_id", parsed.bus_line_id)
        .eq("direction", parsed.direction)
        .eq("active", true);
      if (stopsErr) throw new Error(stopsErr.message);

      type RawStop = { id: string; stop_name: string; city: string; lat: number | null; lng: number | null };
      const allStops = (stops ?? []) as RawStop[];

      // Geocodifica solo quelle senza coordinate (rispetta rate-limit Nominatim con pausa 1s)
      for (const stop of allStops) {
        if (stop.lat != null) continue;
        const geo = await geocodeCity(stop.city || stop.stop_name);
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
      const sorted = withCoords.sort((a, b) =>
        parsed.direction === "arrival" ? b.lat - a.lat : a.lat - b.lat
      );

      // Aggiorna stop_order
      for (let i = 0; i < sorted.length; i++) {
        await auth.admin.from("tenant_bus_line_stops")
          .update({ stop_order: i + 1, order_index: i + 1 })
          .eq("tenant_id", tenantId).eq("id", sorted[i].id);
      }

      return NextResponse.json({
        ok: true,
        geocoded: withCoords.length,
        skipped: allStops.length - withCoords.length,
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

      for (const svc of services as Array<{ id: string; customer_name: string; pax: number; direction: string; bus_city_origin?: string | null; transport_code?: string | null; time?: string | null; outbound_time?: string | null; service_type_code?: string | null; booking_service_kind?: string | null }>) {
        if (allocatedIds.has(svc.id)) continue;

        const identity = deriveServiceBusIdentity(svc as Parameters<typeof deriveServiceBusIdentity>[0]);
        const line = familyLineByCode.get(identity.family_code ?? "") ?? lineByCode.get(identity.lineCode ?? "");
        if (!line) { skipped.push({ serviceId: svc.id, customerName: svc.customer_name, reason: "Linea non trovata" }); continue; }

        const lineStops = allStops.filter((s) => s.bus_line_id === line.id && s.direction === parsed.direction);
        const reqCity = normCity(svc.bus_city_origin);
        const identCity = normCity(identity.city);
        const aliasCities = findBusStopsByCity(svc.bus_city_origin).map((e) => normCity(e.stop.city));

        let stop = lineStops.find((s) => {
          const sc = normCity(s.city); const sn = normCity(s.stop_name);
          return sc === reqCity || sn === reqCity || sc === identCity || sn === identCity || aliasCities.includes(sc) || aliasCities.includes(sn);
        });

        // Fermata non trovata → crea fermata manuale
        if (!stop && reqCity) {
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

        // Scegli bus con logica geografica
        const buses = busesByLineId.get(line.id) ?? [];
        const reserved = new Set(["ITALIA PUGLIA", "ITALIA PUGLIA 2"]);
        const isPuglia = svc.transport_code === "LINEA_PUGLIA_ITALIA";
        const preferred = isPuglia ? ["ITALIA PUGLIA", "ITALIA PUGLIA 2"] : [];
        let chosenBus: SimUnit | null = null;
        if (preferred.length) {
          chosenBus = preferred.map((lbl) => buses.find((b) => b.label === lbl && b.remaining >= svc.pax) ?? null).find((b): b is SimUnit => b !== null) ?? null;
        } else {
          const eligible = buses.filter((b) => b.remaining >= svc.pax && !reserved.has(b.label));
          // 1. Preferisci bus già assegnato alla stessa fermata (stessa città/area geografica)
          const sameStop = eligible.filter((b) => busStopPrimary.get(b.id) === stop.id).sort((a, b) => a.remaining - b.remaining);
          // 2. Bus ancora senza fermata primaria (inizia nuovo cluster geografico)
          const fresh = eligible.filter((b) => !busStopPrimary.has(b.id)).sort((a, b) => a.remaining - b.remaining);
          // 3. Fallback: qualunque bus con capienza, anche se già ha un'altra fermata primaria
          const other = eligible.filter((b) => busStopPrimary.has(b.id) && busStopPrimary.get(b.id) !== stop.id).sort((a, b) => a.remaining - b.remaining);
          chosenBus = sameStop[0] ?? fresh[0] ?? other[0] ?? null;
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

        // Registra fermata primaria del bus se non ancora impostata
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

      // Carica fermate e bus della linea
      const [stopsRes, unitsRes, allocRes] = await Promise.all([
        auth.admin.from("tenant_bus_line_stops").select("id,stop_name,city,stop_order")
          .eq("tenant_id", tenantId).eq("bus_line_id", parsed.bus_line_id)
          .eq("direction", parsed.direction).eq("active", true).order("stop_order"),
        auth.admin.from("tenant_bus_units").select("id,label,capacity,status")
          .eq("tenant_id", tenantId).eq("bus_line_id", parsed.bus_line_id)
          .not("status", "in", '("closed","completed")').order("sort_order"),
        auth.admin.from("tenant_bus_allocations").select("bus_unit_id,pax_assigned,service_id")
          .eq("tenant_id", tenantId),
      ]);
      if (stopsRes.error) throw new Error(stopsRes.error.message);
      if (unitsRes.error) throw new Error(unitsRes.error.message);
      if (allocRes.error) throw new Error(allocRes.error.message);

      type DBStop = { id: string; stop_name: string; city: string; stop_order: number };
      type DBUnit = { id: string; label: string; capacity: number; status: string };
      const lineStops = (stopsRes.data ?? []) as DBStop[];
      const units = (unitsRes.data ?? []) as DBUnit[];

      // Calcola pax per data per bus
      const datePaxMap = new Map<string, number>();
      for (const a of (allocRes.data ?? []) as Array<{ bus_unit_id: string; pax_assigned: number }>) {
        datePaxMap.set(a.bus_unit_id, (datePaxMap.get(a.bus_unit_id) ?? 0) + a.pax_assigned);
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

      function pickBus(pax: number): DBUnit | null {
        const scored = units
          .map((u) => ({ u, remaining: u.capacity - (datePaxMap.get(u.id) ?? 0) }))
          .filter((x) => x.remaining >= pax)
          .sort((a, b) => a.remaining - b.remaining);
        return scored[0]?.u ?? null;
      }

      let assigned = 0;
      let pending = 0;

      for (const row of parsed.rows) {
        const { stop, fuzzy } = findStop(row.city);

        if (stop && !fuzzy) {
          // Fermata trovata: crea servizio + alloca
          const bus = pickBus(row.pax);
          if (bus) {
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

            datePaxMap.set(bus.id, (datePaxMap.get(bus.id) ?? 0) + row.pax);
            assigned++;
          } else {
            // Nessun bus disponibile → da validare
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

      // Carica tutte le fermate attive del tenant per la direzione richiesta
      const [allStopsRes, allUnitsRes, existingSvcRes] = await Promise.all([
        auth.admin.from("tenant_bus_line_stops").select("id,bus_line_id,stop_name,city,stop_order,pickup_note")
          .eq("tenant_id", tenantId).eq("direction", parsed.direction).eq("active", true).order("stop_order"),
        auth.admin.from("tenant_bus_units").select("id,bus_line_id,label,capacity,status")
          .eq("tenant_id", tenantId).not("status", "in", '("closed","completed")').order("sort_order"),
        auth.admin.from("services").select("id").eq("tenant_id", tenantId).eq("date", parsed.travel_date),
      ]);
      if (allStopsRes.error) throw new Error(allStopsRes.error.message);
      if (allUnitsRes.error) throw new Error(allUnitsRes.error.message);
      if (existingSvcRes.error) throw new Error(existingSvcRes.error.message);

      const existingSvcIds = (existingSvcRes.data ?? []).map((s: { id: string }) => s.id);
      // Se non ci sono servizi per questa data, non ci sono allocazioni → mappa vuota
      let allocData: Array<{ bus_unit_id: string; pax_assigned: number }> = [];
      if (existingSvcIds.length > 0) {
        const allocRes = await auth.admin.from("tenant_bus_allocations").select("bus_unit_id,pax_assigned")
          .eq("tenant_id", tenantId).in("service_id", existingSvcIds);
        if (allocRes.error) throw new Error(allocRes.error.message);
        allocData = (allocRes.data ?? []) as Array<{ bus_unit_id: string; pax_assigned: number }>;
      }

      type DBStop2 = { id: string; bus_line_id: string; stop_name: string; city: string; stop_order: number; pickup_note?: string | null };
      type DBUnit2 = { id: string; bus_line_id: string; label: string; capacity: number; status: string };
      const allLineStops = (allStopsRes.data ?? []) as DBStop2[];
      const allUnits = (allUnitsRes.data ?? []) as DBUnit2[];

      // Mappa pax correnti per bus unit (solo per la data di viaggio)
      const datePaxMap2 = new Map<string, number>();
      for (const a of allocData) {
        datePaxMap2.set(a.bus_unit_id, (datePaxMap2.get(a.bus_unit_id) ?? 0) + a.pax_assigned);
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
        const nc = normCityAuto(city);
        if (!nc || nc.length < 3) return { stop: null, fuzzy: false };
        // Exact: city/stop_name o pickup_note
        const exact = allLineStops.find((s) =>
          normCityAuto(s.city) === nc ||
          normCityAuto(s.stop_name) === nc ||
          (s.pickup_note && normCityAuto(s.pickup_note).includes(nc) && nc.length >= 4)
        );
        if (exact) return { stop: exact, fuzzy: false };
        // Fuzzy: substring + keyword overlap su pickup_note
        const fuzzy = allLineStops.find((s) => {
          const sc = normCityAuto(s.city);
          const sn = normCityAuto(s.stop_name);
          const sp = s.pickup_note ? normCityAuto(s.pickup_note) : "";
          return sc.includes(nc) || nc.includes(sc) ||
            sn.includes(nc) || nc.includes(sn) ||
            (sp && nc.length >= 4 && (sp.includes(nc) || nc.includes(sp) || hasKeywordOverlapAuto(nc, sp)));
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

      function pickBusForLine(lineId: string, pax: number): DBUnit2 | null {
        // Riempie i bus in ordine sequenziale (sort_order): prima riempie completamente il primo, poi passa al secondo
        const lineUnits = [...allUnits.filter((u) => u.bus_line_id === lineId)];
        // allUnits è già ordinato per sort_order (query ordina .order("sort_order"))
        return lineUnits.find((u) => (u.capacity - (datePaxMap2.get(u.id) ?? 0)) >= pax) ?? null;
      }

      let assigned2 = 0;
      let pending2 = 0;

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

        if (stop && !fuzzy) {
          const bus = pickBusForLine(stop.bus_line_id, row.pax);
          if (bus) {
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
              billing_party_name: row.agency ?? null,
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

            datePaxMap2.set(bus.id, (datePaxMap2.get(bus.id) ?? 0) + row.pax);
            assigned2++;
          } else {
            // Nessun bus disponibile sulla linea → da validare
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

      await auth.admin.from("bus_import_pending").update({ status: "approved" }).eq("id", parsed.pending_id);
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "reject_pending") {
      const pendingId = z.string().uuid().parse(body?.pending_id);
      await auth.admin.from("bus_import_pending").update({ status: "rejected" }).eq("tenant_id", tenantId).eq("id", pendingId);
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "transfer_allocation_line") {
      // Solo admin
      if (auth.membership.role !== "admin") {
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

      // Leggi fermata destinazione
      const { data: targetStop } = await auth.admin
        .from("tenant_bus_line_stops")
        .select("stop_name")
        .eq("id", parsed.target_stop_id)
        .single();
      const targetStopName = (targetStop as { stop_name: string } | null)?.stop_name ?? "";

      // Elimina allocazione corrente
      await auth.admin.from("tenant_bus_allocations").delete().eq("tenant_id", tenantId).eq("id", parsed.allocation_id);

      // Crea nuova allocazione sulla linea/bus/fermata di destinazione
      const { error: newAllocErr } = await auth.admin.rpc("allocate_bus_service", {
        p_tenant_id: tenantId,
        p_service_id: a.service_id,
        p_bus_line_id: parsed.target_bus_line_id,
        p_bus_unit_id: parsed.target_bus_unit_id,
        p_stop_id: parsed.target_stop_id,
        p_stop_name: targetStopName,
        p_direction: a.direction as "arrival" | "departure",
        p_pax_assigned: a.pax_assigned,
        p_notes: a.notes ?? null,
        p_created_by_user_id: auth.user.id,
      });
      if (newAllocErr) throw new Error(newAllocErr.message);

      // Traccia nel log movimenti
      await auth.admin.from("tenant_bus_allocation_moves").insert({
        tenant_id: tenantId,
        service_id: a.service_id,
        from_bus_unit_id: a.bus_unit_id,
        to_bus_unit_id: parsed.target_bus_unit_id,
        stop_name: targetStopName,
        pax_moved: a.pax_assigned,
        reason: `Trasferito a linea diversa`,
        created_by_user_id: auth.user.id,
      });

      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    return NextResponse.json({ ok: false, error: "Azione non supportata." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
