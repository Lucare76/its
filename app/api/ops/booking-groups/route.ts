/**
 * FASE 1/2/2.5 — API GRUPPI PRENOTAZIONE (contenitore commerciale).
 * FASE 3 — la logica di dominio è stata estratta in
 * `lib/server/booking-groups-service.ts`: questa route resta il solo
 * confine HTTP (auth + parse zod + mapping BgResult -> NextResponse) e
 * NON contiene più SQL di dominio duplicato. Gli stessi service function
 * sono chiamati dai tool MCP (`lib/mcp/tools/booking-groups/*`).
 *
 * Multi-tenant: usa `auth.admin` (service role, bypassa RLS) e filtra
 * SEMPRE per `tenant_id` dentro il service module.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";
import { BOOKING_GROUP_KINDS, BOOKING_GROUP_STATUSES, BOOKING_GROUP_MAX_PAX, type BookingGroupStop } from "@/lib/booking-groups";
import {
  compact,
  tenantRowExists,
  loadGroupDetail,
  findBookingGroups,
  createBookingGroup,
  patchBookingGroup,
  addBookingGroupStop,
  resolveCanonicalBookingGroupStop,
  addBookingGroupPassengers,
  removeGroupPassenger,
  reserveBookingGroupBus,
  previewOperationalizeBookingGroup,
  operationalizeBookingGroup,
  autoAssignBookingGroup,
  findAvailableBusesForGroup,
  isSupportedBookingGroupDate,
  suggestBookingGroupCatalogStops,
  type BgActor,
} from "@/lib/server/booking-groups-service";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const isoDate = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => isSupportedBookingGroupDate(value), "Data non valida: usa un anno tra 2020 e 2100.");
const clock = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/);
const paxInt = z.number().int().positive().max(BOOKING_GROUP_MAX_PAX);

const ferryOverrideFields = {
  outbound_ferry_company: z.string().trim().max(120).nullable().optional(),
  outbound_departure_port: z.string().trim().max(120).nullable().optional(),
  outbound_ferry_time: clock.nullable().optional(),
  outbound_arrival_port: z.string().trim().max(120).nullable().optional(),
  outbound_expected_arrival_time: clock.nullable().optional(),
  return_ferry_company: z.string().trim().max(120).nullable().optional(),
  return_departure_port: z.string().trim().max(120).nullable().optional(),
  return_ferry_time: clock.nullable().optional(),
  return_arrival_port: z.string().trim().max(120).nullable().optional(),
  return_expected_arrival_time: clock.nullable().optional(),
};

const createGroupSchema = z.object({
  action: z.literal("create_group"),
  name: z.string().trim().min(1).max(200),
  expected_pax: paxInt,
  kind: z.enum(BOOKING_GROUP_KINDS as unknown as [string, ...string[]]).optional(),
  status: z.enum(BOOKING_GROUP_STATUSES as unknown as [string, ...string[]]).optional(),
  service_date: isoDate.nullable().optional(),
  return_date: isoDate.nullable().optional(),
  returnDate: isoDate.nullable().optional(),
  contact_name: z.string().trim().max(160).nullable().optional(),
  contact_phone: z.string().trim().max(60).nullable().optional(),
  agency_id: z.string().uuid().nullable().optional(),
  hotel_id: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  ...ferryOverrideFields,
});

const updateGroupSchema = z.object({
  action: z.literal("update_group"),
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  expected_pax: paxInt.optional(),
  kind: z.enum(BOOKING_GROUP_KINDS as unknown as [string, ...string[]]).optional(),
  status: z.enum(BOOKING_GROUP_STATUSES as unknown as [string, ...string[]]).optional(),
  service_date: isoDate.nullable().optional(),
  return_date: isoDate.nullable().optional(),
  returnDate: isoDate.nullable().optional(),
  contact_name: z.string().trim().max(160).nullable().optional(),
  contact_phone: z.string().trim().max(60).nullable().optional(),
  agency_id: z.string().uuid().nullable().optional(),
  hotel_id: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  ...ferryOverrideFields,
});

const addStopSchema = z.object({
  action: z.literal("add_stop"),
  booking_group_id: z.string().uuid(),
  city: z.string().trim().min(1).max(160),
  pickup_point: z.string().trim().max(200).nullable().optional(),
  expected_pax: paxInt,
  stop_id: z.string().uuid().nullable().optional(),
  create_catalog_stop: z.boolean().optional(),
  bus_line_id: z.string().uuid().nullable().optional(),
  pickup_time: clock.nullable().optional(),
  direction: z.enum(["arrival", "departure"]),
  sort_order: z.number().int().min(0).max(9999).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const updateStopSchema = z.object({
  action: z.literal("update_stop"),
  id: z.string().uuid(),
  city: z.string().trim().min(1).max(160).optional(),
  pickup_point: z.string().trim().max(200).nullable().optional(),
  expected_pax: paxInt.optional(),
  stop_id: z.string().uuid().nullable().optional(),
  direction: z.enum(["arrival", "departure"]).optional(),
  sort_order: z.number().int().min(0).max(9999).optional(),
  pickup_time: clock.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const deleteStopSchema = z.object({ action: z.literal("delete_stop"), id: z.string().uuid() });

const upsertReservationSchema = z.object({
  action: z.literal("upsert_bus_reservation"),
  booking_group_id: z.string().uuid(),
  bus_unit_id: z.string().uuid(),
  service_date: isoDate,
  reserved_pax: paxInt,
  exclusive: z.boolean().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const deleteReservationSchema = z.object({
  action: z.literal("delete_bus_reservation"),
  id: z.string().uuid(),
});

const passengerRowSchema = z.object({
  customer_name: z.string().trim().min(1).max(200),
  pax: paxInt,
  phone: z.string().trim().max(60).nullable().optional(),
  hotel_id: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const createGroupServiceSchema = z.object({
  action: z.literal("create_group_service"),
  booking_group_id: z.string().uuid(),
  booking_group_stop_id: z.string().uuid(),
  // FASE A.5 §B — override esplicito della data (es. ritorno), altrimenti
  // resta il default group.service_date (invariato).
  service_date: isoDate.optional(),
}).merge(passengerRowSchema);

const createGroupServicesBatchSchema = z.object({
  action: z.literal("create_group_services_batch"),
  booking_group_id: z.string().uuid(),
  booking_group_stop_id: z.string().uuid(),
  service_date: isoDate.optional(),
  passengers: z.array(passengerRowSchema).min(1).max(100),
});

const unlinkGroupServiceSchema = z.object({
  action: z.literal("unlink_group_service"),
  service_id: z.string().uuid(),
});

const removeGroupPassengerSchema = z.object({
  action: z.literal("remove_group_passenger"),
  booking_group_id: z.string().uuid(),
  booking_group_stop_id: z.string().uuid(),
  service_id: z.string().uuid(),
});

const previewOperationalizeSchema = z.object({
  action: z.literal("preview_operationalize_group"),
  booking_group_id: z.string().uuid(),
});

const operationalizeSchema = z.object({
  action: z.literal("operationalize_group"),
  booking_group_id: z.string().uuid(),
  service_ids: z.array(z.string().uuid()).min(1).max(500).optional(),
});

const autoAssignSchema = z.object({
  action: z.literal("auto_assign_group"),
  booking_group_id: z.string().uuid(),
});

const bodySchema = z.discriminatedUnion("action", [
  createGroupSchema,
  updateGroupSchema,
  addStopSchema,
  updateStopSchema,
  deleteStopSchema,
  upsertReservationSchema,
  deleteReservationSchema,
  createGroupServiceSchema,
  createGroupServicesBatchSchema,
  unlinkGroupServiceSchema,
  removeGroupPassengerSchema,
  previewOperationalizeSchema,
  operationalizeSchema,
  autoAssignSchema,
]);

/** Mapping uniforme BgResult/BgOutcome -> NextResponse. Le chiavi di
 *  `res.data` sono spalmate a livello superiore (stessa forma delle risposte
 *  pre-FASE 3). `res.ok` viene propagato tale e quale (207 batch → ok:false). */
function toResponse<T extends Record<string, unknown>>(
  res: { ok: boolean; status: number } & ({ data: T } | { error: string }),
): NextResponse {
  if ("error" in res) return NextResponse.json({ ok: false, error: res.error }, { status: res.status });
  return NextResponse.json({ ok: res.ok, ...res.data }, { status: res.status });
}

// ─── GET: list / detail ───────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;
  const admin = auth.admin as SupabaseClient;
  const tenantId = auth.membership.tenant_id;

  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  if (id) {
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
      return NextResponse.json({ ok: false, error: "id non valido." }, { status: 400 });
    }
    const detail = await loadGroupDetail(admin, tenantId, id);
    if (!detail) return NextResponse.json({ ok: false, error: "Gruppo non trovato." }, { status: 404 });
    return NextResponse.json({ ok: true, ...detail });
  }

  const q = url.searchParams.get("q");
  if (url.searchParams.get("catalog") === "bus_lines") {
    const { data, error } = await admin
      .from("tenant_bus_lines")
      .select("id, name, code, family_name, variant_label, active")
      .eq("tenant_id", tenantId)
      .eq("active", true)
      .order("name");
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, lines: data ?? [] });
  }

  if (url.searchParams.get("catalog") === "hotels") {
    const { data, error } = await admin
      .from("hotels")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .order("name");
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, hotels: data ?? [] });
  }

  if (url.searchParams.get("catalog") === "bus_stops") {
    const directionRaw = url.searchParams.get("direction");
    const direction = directionRaw === "arrival" || directionRaw === "departure" ? directionRaw : null;
    const suggestions = await suggestBookingGroupCatalogStops(admin, tenantId, {
      query: url.searchParams.get("q"),
      city: url.searchParams.get("city"),
      pickupPoint: url.searchParams.get("pickup_point"),
      direction,
      busLineId: url.searchParams.get("bus_line_id"),
      limit: 8,
    });
    return NextResponse.json({ ok: true, stops: suggestions });
  }

  const availableForGroup = url.searchParams.get("available_buses_for_group");
  if (availableForGroup) {
    if (!/^[0-9a-fA-F-]{36}$/.test(availableForGroup)) {
      return NextResponse.json({ ok: false, error: "id gruppo non valido." }, { status: 400 });
    }
    const date = url.searchParams.get("service_date");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ ok: false, error: "service_date non valida." }, { status: 400 });
    }
    const requiredCapacity = Number(url.searchParams.get("required_capacity") ?? "0");
    if (!Number.isInteger(requiredCapacity) || requiredCapacity <= 0 || requiredCapacity > BOOKING_GROUP_MAX_PAX) {
      return NextResponse.json({ ok: false, error: "required_capacity non valida." }, { status: 400 });
    }
    const group = await loadGroupDetail(admin, tenantId, availableForGroup);
    if (!group) return NextResponse.json({ ok: false, error: "Gruppo non trovato." }, { status: 404 });
    const buses = await findAvailableBusesForGroup(admin, tenantId, {
      serviceDate: date,
      requiredCapacity,
      exclusiveOnly: group.group.kind === "bus_exclusive",
    });
    return NextResponse.json({ ok: true, buses });
  }

  if (q !== null) {
    const found = await findBookingGroups(admin, tenantId, { query: q });
    return NextResponse.json({ ok: true, ...found });
  }

  const { data: groups, error } = await admin
    .from("booking_groups")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, groups: groups ?? [] });
}

// ─── POST: action-based write ─────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;
  const admin = auth.admin as SupabaseClient;
  const tenantId = auth.membership.tenant_id;
  const userId = auth.user?.id ?? null;
  const actor: BgActor = { tenantId, userId, role: auth.membership.role };

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? "Payload non valido." },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // ── create_group ──────────────────────────────────────────────────────
  if (body.action === "create_group") {
    const { action: _action, ...rest } = body;
    void _action;
    return toResponse(await createBookingGroup(admin, actor, rest));
  }

  // ── update_group (patch generico, FK validate) ───────────────────────
  if (body.action === "update_group") {
    if (body.status === "cancelled") {
      const { data: linkedServices } = await admin
        .from("services")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("booking_group_id", body.id);
      const serviceIds = ((linkedServices ?? []) as Array<{ id: string }>).map((service) => service.id);
      if (serviceIds.length > 0) {
        const { error: allocationError } = await admin
          .from("tenant_bus_allocations")
          .delete()
          .eq("tenant_id", tenantId)
          .in("service_id", serviceIds);
        if (allocationError) return NextResponse.json({ ok: false, error: allocationError.message }, { status: 500 });

        const { error: servicesError } = await admin
          .from("services")
          .update({ status: "cancelled", booking_group_id: null, booking_group_stop_id: null })
          .eq("tenant_id", tenantId)
          .in("id", serviceIds);
        if (servicesError) return NextResponse.json({ ok: false, error: servicesError.message }, { status: 500 });
      }
    }
    const { action: _action, id, returnDate, ...rest } = body;
    void _action;
    const patch = { ...rest, ...(returnDate !== undefined ? { return_date: returnDate } : {}) };
    return toResponse(await patchBookingGroup(admin, actor, id, patch, { validateFks: true }));
  }

  // ── add_stop ──────────────────────────────────────────────────────────
  if (body.action === "add_stop") {
    const { action: _a, booking_group_id, ...rest } = body;
    void _a;
    return toResponse(await addBookingGroupStop(admin, actor, { bookingGroupId: booking_group_id, ...rest }));
  }

  // ── update_stop (non esposto a MCP: resta inline) ────────────────────
  if (body.action === "update_stop") {
    const { data: current } = await admin
      .from("booking_group_stops")
      .select("id, city, pickup_point, stop_id")
      .eq("tenant_id", tenantId)
      .eq("id", body.id)
      .maybeSingle();
    if (!current?.id) return NextResponse.json({ ok: false, error: "Fermata gruppo non trovata." }, { status: 404 });
    if (body.stop_id && !(await tenantRowExists(admin, "tenant_bus_line_stops", tenantId, body.stop_id))) {
      return NextResponse.json({ ok: false, error: "Fermata catalogo non valida per il tenant." }, { status: 400 });
    }
    const { action: _action, id, pickup_time, ...rest } = body;
    void _action;
    const patch = compact({ ...rest, updated_at: new Date().toISOString() });
    const { data, error } = await admin
      .from("booking_group_stops")
      .update(patch)
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .select("*")
      .single();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    const updatedStop = data as BookingGroupStop;
    if (current.stop_id) {
      const catalogPatch = compact({
        city: updatedStop.city,
        stop_name: updatedStop.city,
        pickup_note: updatedStop.pickup_point,
        pickup_time: pickup_time ?? undefined,
        direction: updatedStop.direction,
        updated_at: new Date().toISOString(),
      });
      const { error: catalogError } = await admin
        .from("tenant_bus_line_stops")
        .update(catalogPatch)
        .eq("tenant_id", tenantId)
        .eq("id", current.stop_id);
      if (catalogError) {
        const isDuplicate = catalogError.code === "23505" || catalogError.message?.includes("tenant_bus_line_stops_line_direction_name_pickup_key");
        if (!isDuplicate) return NextResponse.json({ ok: false, error: catalogError.message }, { status: 500 });
        // La combinazione citta/punto di carico coincide gia con un'altra
        // fermata canonica esistente (es. stesso pickup_point riusato su piu
        // citta della stessa linea/direzione): riusala invece di rompere il
        // salvataggio con l'errore DB grezzo.
        const { data: currentCatalog } = await admin
          .from("tenant_bus_line_stops")
          .select("bus_line_id")
          .eq("tenant_id", tenantId)
          .eq("id", current.stop_id)
          .maybeSingle();
        const busLineId = (currentCatalog as { bus_line_id?: string | null } | null)?.bus_line_id ?? null;
        const canonical = await resolveCanonicalBookingGroupStop(admin, tenantId, updatedStop.city, updatedStop.direction, updatedStop.pickup_point, busLineId);
        if (!canonical || canonical.stopId === current.stop_id) {
          return NextResponse.json({ ok: false, error: "Fermata gia presente nel catalogo con questa combinazione citta/punto di carico: modifica citta o punto di carico." }, { status: 409 });
        }
        const { error: relinkError } = await admin
          .from("booking_group_stops")
          .update({ stop_id: canonical.stopId, updated_at: new Date().toISOString() })
          .eq("tenant_id", tenantId)
          .eq("id", id);
        if (relinkError) return NextResponse.json({ ok: false, error: relinkError.message }, { status: 500 });
        updatedStop.stop_id = canonical.stopId;
        if (pickup_time !== undefined && (pickup_time ?? null) !== canonical.pickupTime) {
          await admin
            .from("tenant_bus_line_stops")
            .update({ pickup_time: pickup_time ?? null, updated_at: new Date().toISOString() })
            .eq("tenant_id", tenantId)
            .eq("id", canonical.stopId);
        }
      }
    }
    const nextDefaultName = updatedStop.pickup_point ? `${updatedStop.city} - ${updatedStop.pickup_point}` : updatedStop.city;
    const { data: linkedServices, error: linkedServicesError } = await admin
      .from("services")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("booking_group_stop_id", id);
    if (linkedServicesError) return NextResponse.json({ ok: false, error: linkedServicesError.message }, { status: 500 });

    const serviceIds = ((linkedServices ?? []) as Array<{ id: string }>).map((service) => service.id);
    const { error: servicesError } = await admin
      .from("services")
      .update({
        bus_city_origin: updatedStop.city,
        customer_name: nextDefaultName,
      })
      .eq("tenant_id", tenantId)
      .eq("booking_group_stop_id", id);
    if (servicesError) return NextResponse.json({ ok: false, error: servicesError.message }, { status: 500 });
    if (serviceIds.length > 0) {
      const { error: allocationsError } = await admin
        .from("tenant_bus_allocations")
        .update({ stop_name: nextDefaultName })
        .eq("tenant_id", tenantId)
        .in("service_id", serviceIds);
      if (allocationsError) return NextResponse.json({ ok: false, error: allocationsError.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, stop: updatedStop });
  }

  // ── delete_stop ───────────────────────────────────────────────────────
  if (body.action === "delete_stop") {
    const { data: linkedServices } = await admin
      .from("services")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("booking_group_stop_id", body.id);
    const serviceIds = ((linkedServices ?? []) as Array<{ id: string }>).map((service) => service.id);
    if (serviceIds.length > 0) {
      const { error: allocationError } = await admin
        .from("tenant_bus_allocations")
        .delete()
        .eq("tenant_id", tenantId)
        .in("service_id", serviceIds);
      if (allocationError) return NextResponse.json({ ok: false, error: allocationError.message }, { status: 500 });

      const { error: servicesError } = await admin
        .from("services")
        .update({ status: "cancelled", booking_group_id: null, booking_group_stop_id: null })
        .eq("tenant_id", tenantId)
        .in("id", serviceIds);
      if (servicesError) return NextResponse.json({ ok: false, error: servicesError.message }, { status: 500 });
    }
    const { error } = await admin
      .from("booking_group_stops")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("id", body.id);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, deleted: body.id });
  }

  // ── upsert_bus_reservation ────────────────────────────────────────────
  if (body.action === "upsert_bus_reservation") {
    return toResponse(await reserveBookingGroupBus(admin, actor, {
      bookingGroupId: body.booking_group_id,
      busUnitId: body.bus_unit_id,
      service_date: body.service_date,
      reserved_pax: body.reserved_pax,
      exclusive: body.exclusive,
      notes: body.notes,
    }));
  }

  // ── delete_bus_reservation ────────────────────────────────────────────
  if (body.action === "delete_bus_reservation") {
    const { error } = await admin
      .from("booking_group_bus_reservations")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("id", body.id);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, deleted: body.id });
  }

  // ── create_group_service / batch ─────────────────────────────────────
  if (body.action === "create_group_service" || body.action === "create_group_services_batch") {
    const passengers = body.action === "create_group_service"
      ? [{ customer_name: body.customer_name, pax: body.pax, phone: body.phone, hotel_id: body.hotel_id, notes: body.notes }]
      : body.passengers;
    return toResponse(await addBookingGroupPassengers(admin, actor, {
      bookingGroupId: body.booking_group_id,
      bookingGroupStopId: body.booking_group_stop_id,
      passengers,
      serviceDate: body.service_date,
    }));
  }

  // ── unlink_group_service ──────────────────────────────────────────────
  if (body.action === "unlink_group_service") {
    const { data: svc } = await admin
      .from("services")
      .select("id, booking_group_id")
      .eq("tenant_id", tenantId)
      .eq("id", body.service_id)
      .maybeSingle();
    if (!svc?.id) return NextResponse.json({ ok: false, error: "Servizio non trovato." }, { status: 404 });
    const { error } = await admin
      .from("services")
      .update({ booking_group_id: null, booking_group_stop_id: null })
      .eq("tenant_id", tenantId)
      .eq("id", body.service_id);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    auditLog({ event: "booking_group_service_unlinked", tenantId, userId, role: auth.membership.role, serviceId: body.service_id, outcome: "unlinked" });
    return NextResponse.json({ ok: true, unlinked: body.service_id });
  }

  // ── remove_group_passenger — elimina UN nominativo dalla fermata ───────
  // Draft/needs_review: hard delete mirato. Gia' operativo: soft-cancel via
  // la stessa RPC di /api/ops/services/[id]/cancel + scollegamento dal
  // gruppo. Validazioni (tenant/gruppo/fermata) dentro il service module.
  if (body.action === "remove_group_passenger") {
    return toResponse(await removeGroupPassenger(admin, actor, {
      bookingGroupId: body.booking_group_id,
      bookingGroupStopId: body.booking_group_stop_id,
      serviceId: body.service_id,
    }));
  }

  // ── preview_operationalize_group (READ, nessuna scrittura) ────────────
  if (body.action === "preview_operationalize_group") {
    return toResponse(await previewOperationalizeBookingGroup(admin, tenantId, body.booking_group_id));
  }

  // ── operationalize_group (WRITE) ─────────────────────────────────────
  if (body.action === "operationalize_group") {
    return toResponse(await operationalizeBookingGroup(admin, actor, {
      bookingGroupId: body.booking_group_id,
      serviceIds: body.service_ids,
    }));
  }

  // ── auto_assign_group (WRITE) — Obiettivo A "zero click" ──────────────
  // Un solo click per la UI umana al posto di "riserva bus" +
  // "operativizza" separati: sceglie un bus esclusivo libero SOLO se non
  // ambiguo (un solo candidato compatibile), riserva e operativizza.
  // Mai chiamata da Mario/MCP: la conversazione guidata di Mario resta
  // quella esistente (propone il bus, chiede conferma), invariata.
  if (body.action === "auto_assign_group") {
    const result = await autoAssignBookingGroup(admin, actor, body.booking_group_id);
    return NextResponse.json({ ok: true, ...result });
  }

  return NextResponse.json({ ok: false, error: "Azione non riconosciuta." }, { status: 400 });
}
