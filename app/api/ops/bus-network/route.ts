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

async function loadBusNetwork(auth: PricingAuthContext) {
  const tenantId = auth.membership.tenant_id;
  const [linesResult, stopsResult, unitsResult, allocationsResult, movesResult, servicesResult, hotelsResult] = await Promise.all([
    auth.admin.from("tenant_bus_lines").select("*").eq("tenant_id", tenantId).order("family_code").order("name"),
    auth.admin.from("tenant_bus_line_stops").select("*").eq("tenant_id", tenantId).order("direction").order("stop_order"),
    auth.admin.from("tenant_bus_units").select("*").eq("tenant_id", tenantId).order("bus_line_id").order("sort_order"),
    auth.admin.from("tenant_bus_allocations").select("*").eq("tenant_id", tenantId),
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
    moves: movesResult.data ?? [],
    services,
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
          await auth.admin.from("tenant_bus_line_stops").upsert(
            defaultStops.map((stop) => ({
              tenant_id: tenantId,
              bus_line_id: line.id,
              direction: stop.direction,
              stop_name: stop.stop_name,
              city: stop.city,
              pickup_note: stop.pickup_note,
              stop_order: stop.stop_order,
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
      const { error } = await auth.admin.from("tenant_bus_line_stops").insert({
        tenant_id: tenantId,
        bus_line_id: parsed.bus_line_id,
        direction: parsed.direction,
        stop_name: parsed.stop_name,
        city: parsed.city,
        pickup_note: parsed.pickup_note ?? null,
        stop_order: parsed.stop_order,
        lat: parsed.lat ?? null,
        lng: parsed.lng ?? null,
        is_manual: true,
        active: true
      });
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
      const units = await auth.admin.from("tenant_bus_units").select("*").eq("tenant_id", tenantId).eq("id", parsed.bus_unit_id).maybeSingle();
      if (units.error || !units.data) throw new Error(units.error?.message ?? "Bus non trovato.");
      if (units.data.status === "closed" || units.data.status === "completed") {
        return NextResponse.json({ ok: false, error: "Bus chiuso o completato: nessuna nuova prenotazione consentita." }, { status: 400 });
      }
      const existingAllocations = await auth.admin.from("tenant_bus_allocations").select("*").eq("tenant_id", tenantId).eq("bus_unit_id", parsed.bus_unit_id);
      if (existingAllocations.error) throw new Error(existingAllocations.error.message);
      const assignedPax = (existingAllocations.data ?? []).reduce((sum: number, item: { pax_assigned: number }) => sum + item.pax_assigned, 0);
      if (assignedPax + parsed.pax_assigned > units.data.capacity) {
        return NextResponse.json({ ok: false, error: "Capienza bus superata." }, { status: 400 });
      }
      const { error } = await auth.admin.from("tenant_bus_allocations").insert({
        tenant_id: tenantId,
        service_id: parsed.service_id,
        bus_line_id: parsed.bus_line_id,
        bus_unit_id: parsed.bus_unit_id,
        stop_id: parsed.stop_id ?? null,
        stop_name: parsed.stop_name,
        direction: parsed.direction,
        pax_assigned: parsed.pax_assigned,
        notes: parsed.notes ?? null,
        created_by_user_id: auth.user.id
      });
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    if (action === "move_allocation") {
      const parsed = moveSchema.parse(body);
      const allocationResult = await auth.admin.from("tenant_bus_allocations").select("*").eq("tenant_id", tenantId).eq("id", parsed.allocation_id).maybeSingle();
      if (allocationResult.error || !allocationResult.data) throw new Error(allocationResult.error?.message ?? "Allocazione non trovata.");
      const targetResult = await auth.admin.from("tenant_bus_units").select("*").eq("tenant_id", tenantId).eq("id", parsed.to_bus_unit_id).maybeSingle();
      if (targetResult.error || !targetResult.data) throw new Error(targetResult.error?.message ?? "Bus destinazione non trovato.");
      if (targetResult.data.status === "closed" || targetResult.data.status === "completed") {
        return NextResponse.json({ ok: false, error: "Bus destinazione chiuso o completato." }, { status: 400 });
      }
      const targetAllocations = await auth.admin.from("tenant_bus_allocations").select("pax_assigned").eq("tenant_id", tenantId).eq("bus_unit_id", parsed.to_bus_unit_id);
      if (targetAllocations.error) throw new Error(targetAllocations.error.message);
      const targetPax = (targetAllocations.data ?? []).reduce((sum: number, item: { pax_assigned: number }) => sum + item.pax_assigned, 0);
      if (targetPax + parsed.pax_moved > targetResult.data.capacity) {
        return NextResponse.json({ ok: false, error: "Capienza bus destinazione superata." }, { status: 400 });
      }
      if (parsed.pax_moved >= allocationResult.data.pax_assigned) {
        const { error: updateError } = await auth.admin.from("tenant_bus_allocations").update({ bus_unit_id: parsed.to_bus_unit_id }).eq("tenant_id", tenantId).eq("id", parsed.allocation_id);
        if (updateError) throw new Error(updateError.message);
      } else {
        const { error: reduceError } = await auth.admin
          .from("tenant_bus_allocations")
          .update({ pax_assigned: allocationResult.data.pax_assigned - parsed.pax_moved })
          .eq("tenant_id", tenantId)
          .eq("id", parsed.allocation_id);
        if (reduceError) throw new Error(reduceError.message);
        const { error: insertError } = await auth.admin.from("tenant_bus_allocations").insert({
          tenant_id: tenantId,
          service_id: allocationResult.data.service_id,
          bus_line_id: allocationResult.data.bus_line_id,
          bus_unit_id: parsed.to_bus_unit_id,
          stop_id: allocationResult.data.stop_id,
          stop_name: allocationResult.data.stop_name,
          direction: allocationResult.data.direction,
          pax_assigned: parsed.pax_moved,
          notes: allocationResult.data.notes,
          created_by_user_id: auth.user.id
        });
        if (insertError) throw new Error(insertError.message);
      }
      const { error: moveError } = await auth.admin.from("tenant_bus_allocation_moves").insert({
        tenant_id: tenantId,
        service_id: allocationResult.data.service_id,
        from_bus_unit_id: allocationResult.data.bus_unit_id,
        to_bus_unit_id: parsed.to_bus_unit_id,
        stop_name: allocationResult.data.stop_name,
        pax_moved: parsed.pax_moved,
        reason: parsed.reason ?? null,
        created_by_user_id: auth.user.id
      });
      if (moveError) throw new Error(moveError.message);
      return NextResponse.json({ ok: true, ...(await loadBusNetwork(auth)) });
    }

    return NextResponse.json({ ok: false, error: "Azione non supportata." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
