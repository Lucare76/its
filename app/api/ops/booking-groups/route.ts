/**
 * FASE 1 — API minima GRUPPI PRENOTAZIONE (contenitore commerciale).
 *
 * Copertura: CREATE / list / detail / UPDATE campi base gruppo,
 * ADD/UPDATE/DELETE booking_group_stops, UPSERT/DELETE
 * booking_group_bus_reservations.
 *
 * NON crea services, NON crea tenant_bus_allocations, NON tocca
 * trip_groups / assignments / tenant_bus_units / bus_line_ferry_config,
 * NON propaga i campi ferry override sui services.
 *
 * Multi-tenant: usa `auth.admin` (service role, bypassa RLS) e filtra
 * SEMPRE per `tenant_id`. Ogni FK opzionale (agency_id / hotel_id / stop_id /
 * bus_unit_id) è validata server-side contro lo stesso tenant prima della
 * scrittura — il DB non esprime FK composite (tenant_id, id) sulle tabelle
 * parent esistenti senza modificarne lo schema (vedi report FASE 1 §RLS).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";
import { autoAllocateBusService } from "@/lib/server/bus-auto-allocation";
import {
  BOOKING_GROUP_KINDS,
  BOOKING_GROUP_STATUSES,
  BOOKING_GROUP_MAX_PAX,
  computeBookingGroupStatusSummary,
  summarizeStopPax,
  evaluateBookingGroupServiceReadiness,
  type BookingGroup,
  type BookingGroupBusReservation,
  type BookingGroupStop,
  type BookingGroupWarningCode,
} from "@/lib/booking-groups";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
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
}).merge(passengerRowSchema);

const createGroupServicesBatchSchema = z.object({
  action: z.literal("create_group_services_batch"),
  booking_group_id: z.string().uuid(),
  booking_group_stop_id: z.string().uuid(),
  passengers: z.array(passengerRowSchema).min(1).max(100),
});

const unlinkGroupServiceSchema = z.object({
  action: z.literal("unlink_group_service"),
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
  previewOperationalizeSchema,
  operationalizeSchema,
]);

// ─── FASE 2.5 — operativizzazione ─────────────────────────────────────────

type OpSvcRow = {
  id: string; is_draft: boolean | null; status: string | null; pax: number | null;
  customer_name: string | null; date: string | null; time: string | null; direction: string | null;
  bus_city_origin: string | null; meeting_point: string | null; hotel_id: string | null;
  booking_service_kind: string | null; booking_group_id: string | null; booking_group_stop_id: string | null;
};

async function buildOperationalizeView(admin: SupabaseClient, tenantId: string, groupId: string) {
  const { data: group } = await admin
    .from("booking_groups").select("*").eq("tenant_id", tenantId).eq("id", groupId).maybeSingle();
  if (!group) return null;
  const g = group as BookingGroup;

  const [{ data: stops }, { data: services }, { data: reservations }] = await Promise.all([
    admin.from("booking_group_stops").select("id, city, pickup_point, stop_id, expected_pax").eq("tenant_id", tenantId).eq("booking_group_id", groupId),
    admin.from("services").select("id, is_draft, status, pax, customer_name, date, time, direction, bus_city_origin, meeting_point, hotel_id, booking_service_kind, booking_group_id, booking_group_stop_id").eq("tenant_id", tenantId).eq("booking_group_id", groupId),
    admin.from("booking_group_bus_reservations").select("*").eq("tenant_id", tenantId).eq("booking_group_id", groupId),
  ]);

  const stopRows = (stops ?? []) as Array<{ id: string; city: string; pickup_point: string | null; stop_id: string | null; expected_pax: number }>;
  const svcRows = (services ?? []) as OpSvcRow[];
  const resRows = (reservations ?? []) as BookingGroupBusReservation[];
  const stopById = new Map(stopRows.map((s) => [s.id, s]));

  const groupWarnings: BookingGroupWarningCode[] = [];
  if (!g.outbound_ferry_time && !g.outbound_ferry_company) groupWarnings.push("ferry_outbound_missing");
  if (!g.return_ferry_time && !g.return_ferry_company) groupWarnings.push("ferry_return_missing");

  let reservation: (BookingGroupBusReservation & { bus_capacity: number | null }) | null = null;
  if (g.kind === "bus_exclusive") {
    const forDate = resRows.find((r) => !g.service_date || r.service_date === g.service_date) ?? null;
    if (!forDate) {
      groupWarnings.push("bus_reservation_missing");
    } else {
      const { data: unit } = await admin.from("tenant_bus_units").select("capacity").eq("tenant_id", tenantId).eq("id", forDate.bus_unit_id).maybeSingle();
      const cap = (unit as { capacity: number | null } | null)?.capacity ?? null;
      reservation = { ...forDate, bus_capacity: cap };
      if (forDate.reserved_pax < g.expected_pax) groupWarnings.push("reserved_pax_below_expected");
      if (cap != null && forDate.reserved_pax > cap) groupWarnings.push("reserved_pax_above_capacity");
    }
  }

  const perService = svcRows.map((s) => {
    const stop = s.booking_group_stop_id ? stopById.get(s.booking_group_stop_id) ?? null : null;
    const r = evaluateBookingGroupServiceReadiness(s, { kind: g.kind }, stop);
    return {
      service_id: s.id,
      customer_name: s.customer_name,
      pax: Number(s.pax ?? 0),
      ready: r.ready,
      already_operational: r.alreadyOperational,
      missing_fields: r.missingFields,
      warnings: r.warnings,
    };
  });

  const ready = perService.filter((p) => p.ready);
  const blocked = perService.filter((p) => !p.ready && !p.already_operational);
  const already = perService.filter((p) => p.already_operational);

  return { group: g, stops: stopRows, svcRows, reservation, groupWarnings, perService, ready, blocked, already };
}

// ─── helpers ───────────────────────────────────────────────────────────────

function compact<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Verifica che una riga di una tabella parent esista NELLO STESSO tenant. */
async function tenantRowExists(
  admin: SupabaseClient,
  table: string,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const { data } = await admin.from(table).select("id").eq("tenant_id", tenantId).eq("id", id).maybeSingle();
  return Boolean(data?.id);
}

async function loadGroupDetail(admin: SupabaseClient, tenantId: string, groupId: string) {
  const { data: group } = await admin
    .from("booking_groups")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("id", groupId)
    .maybeSingle();
  if (!group) return null;

  const [{ data: stops }, { data: reservations }, { data: services }] = await Promise.all([
    admin
      .from("booking_group_stops")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("booking_group_id", groupId)
      .order("direction")
      .order("sort_order"),
    admin
      .from("booking_group_bus_reservations")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("booking_group_id", groupId)
      .order("service_date"),
    admin
      .from("services")
      .select("id, pax, direction, date, status, is_draft, customer_name, booking_group_stop_id, bus_city_origin, meeting_point")
      .eq("tenant_id", tenantId)
      .eq("booking_group_id", groupId),
  ]);

  const stopRows = (stops ?? []) as BookingGroupStop[];
  const reservationRows = (reservations ?? []) as BookingGroupBusReservation[];
  const serviceRows = (services ?? []) as Array<{
    id: string;
    pax: number | null;
    direction: string | null;
    date: string | null;
    status: string | null;
    is_draft: boolean | null;
    customer_name: string | null;
    booking_group_stop_id: string | null;
    bus_city_origin: string | null;
    meeting_point: string | null;
  }>;

  const summary = computeBookingGroupStatusSummary({
    status: (group as BookingGroup).status,
    expectedPax: (group as BookingGroup).expected_pax,
    stopExpectedPax: stopRows.map((s) => s.expected_pax),
    servicePax: serviceRows.map((s) => Number(s.pax ?? 0)),
    busReservationCount: reservationRows.length,
  });

  const stop_summaries = stopRows.map((stop) =>
    summarizeStopPax({
      stopId: stop.id,
      expectedPax: stop.expected_pax,
      servicePax: serviceRows.filter((s) => s.booking_group_stop_id === stop.id).map((s) => Number(s.pax ?? 0)),
    }),
  );

  return {
    group: group as BookingGroup,
    stops: stopRows,
    bus_reservations: reservationRows,
    services: serviceRows,
    summary,
    stop_summaries,
  };
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

  const { data: groups, error } = await admin
    .from("booking_groups")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, groups: (groups ?? []) as BookingGroup[] });
}

// ─── POST: action-based write ─────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;
  const admin = auth.admin as SupabaseClient;
  const tenantId = auth.membership.tenant_id;
  const userId = auth.user?.id ?? null;

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
    if (body.agency_id && !(await tenantRowExists(admin, "agencies", tenantId, body.agency_id))) {
      return NextResponse.json({ ok: false, error: "Agenzia non valida per il tenant." }, { status: 400 });
    }
    if (body.hotel_id && !(await tenantRowExists(admin, "hotels", tenantId, body.hotel_id))) {
      return NextResponse.json({ ok: false, error: "Hotel non valido per il tenant." }, { status: 400 });
    }
    const { action: _action, ...rest } = body;
    void _action;
    const insert = compact({
      ...rest,
      tenant_id: tenantId,
      kind: rest.kind ?? "other",
      status: rest.status ?? "draft",
      created_by_user_id: userId,
    });
    const { data, error } = await admin.from("booking_groups").insert(insert).select("*").single();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    auditLog({ event: "booking_group_created", tenantId, userId, role: auth.membership.role, outcome: "created", details: { id: (data as BookingGroup).id, name: (data as BookingGroup).name, expected_pax: (data as BookingGroup).expected_pax, kind: (data as BookingGroup).kind } });
    return NextResponse.json({ ok: true, group: data as BookingGroup });
  }

  // ── update_group ──────────────────────────────────────────────────────
  if (body.action === "update_group") {
    if (!(await tenantRowExists(admin, "booking_groups", tenantId, body.id))) {
      return NextResponse.json({ ok: false, error: "Gruppo non trovato." }, { status: 404 });
    }
    if (body.agency_id && !(await tenantRowExists(admin, "agencies", tenantId, body.agency_id))) {
      return NextResponse.json({ ok: false, error: "Agenzia non valida per il tenant." }, { status: 400 });
    }
    if (body.hotel_id && !(await tenantRowExists(admin, "hotels", tenantId, body.hotel_id))) {
      return NextResponse.json({ ok: false, error: "Hotel non valido per il tenant." }, { status: 400 });
    }
    const { action: _action, id, ...rest } = body;
    void _action;
    const patch = compact({ ...rest, updated_at: new Date().toISOString() });
    if (Object.keys(patch).length === 1) {
      return NextResponse.json({ ok: false, error: "Nessun campo da aggiornare." }, { status: 400 });
    }
    const { data, error } = await admin
      .from("booking_groups")
      .update(patch)
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .select("*")
      .single();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, group: data as BookingGroup });
  }

  // ── add_stop ──────────────────────────────────────────────────────────
  if (body.action === "add_stop") {
    if (!(await tenantRowExists(admin, "booking_groups", tenantId, body.booking_group_id))) {
      return NextResponse.json({ ok: false, error: "Gruppo non trovato." }, { status: 404 });
    }
    if (body.stop_id && !(await tenantRowExists(admin, "tenant_bus_line_stops", tenantId, body.stop_id))) {
      return NextResponse.json({ ok: false, error: "Fermata catalogo non valida per il tenant." }, { status: 400 });
    }
    const { action: _action, ...rest } = body;
    void _action;
    const insert = compact({ ...rest, tenant_id: tenantId, sort_order: rest.sort_order ?? 0 });
    const { data, error } = await admin.from("booking_group_stops").insert(insert).select("*").single();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    auditLog({ event: "booking_group_stop_added", tenantId, userId, role: auth.membership.role, outcome: "created", details: { booking_group_id: body.booking_group_id, city: body.city, expected_pax: body.expected_pax, direction: body.direction } });
    return NextResponse.json({ ok: true, stop: data as BookingGroupStop });
  }

  // ── update_stop ───────────────────────────────────────────────────────
  if (body.action === "update_stop") {
    const { data: current } = await admin
      .from("booking_group_stops")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("id", body.id)
      .maybeSingle();
    if (!current?.id) return NextResponse.json({ ok: false, error: "Fermata gruppo non trovata." }, { status: 404 });
    if (body.stop_id && !(await tenantRowExists(admin, "tenant_bus_line_stops", tenantId, body.stop_id))) {
      return NextResponse.json({ ok: false, error: "Fermata catalogo non valida per il tenant." }, { status: 400 });
    }
    const { action: _action, id, ...rest } = body;
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
    return NextResponse.json({ ok: true, stop: data as BookingGroupStop });
  }

  // ── delete_stop ───────────────────────────────────────────────────────
  if (body.action === "delete_stop") {
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
    if (!(await tenantRowExists(admin, "booking_groups", tenantId, body.booking_group_id))) {
      return NextResponse.json({ ok: false, error: "Gruppo non trovato." }, { status: 404 });
    }
    if (!(await tenantRowExists(admin, "tenant_bus_units", tenantId, body.bus_unit_id))) {
      return NextResponse.json({ ok: false, error: "Bus unit non valida per il tenant." }, { status: 400 });
    }
    const { action: _action, ...rest } = body;
    void _action;
    const row = compact({
      ...rest,
      tenant_id: tenantId,
      exclusive: rest.exclusive ?? false,
      updated_at: new Date().toISOString(),
    });
    const { data, error } = await admin
      .from("booking_group_bus_reservations")
      .upsert(row, { onConflict: "tenant_id,booking_group_id,bus_unit_id,service_date" })
      .select("*")
      .single();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    auditLog({ event: "booking_group_bus_reservation_changed", tenantId, userId, role: auth.membership.role, outcome: "upserted", details: { booking_group_id: body.booking_group_id, bus_unit_id: body.bus_unit_id, service_date: body.service_date, reserved_pax: body.reserved_pax, exclusive: body.exclusive ?? false } });
    return NextResponse.json({ ok: true, reservation: data as BookingGroupBusReservation });
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
    const { data: group } = await admin
      .from("booking_groups")
      .select("id, kind, service_date")
      .eq("tenant_id", tenantId)
      .eq("id", body.booking_group_id)
      .maybeSingle();
    if (!group?.id) return NextResponse.json({ ok: false, error: "Gruppo non trovato." }, { status: 404 });

    const { data: stop } = await admin
      .from("booking_group_stops")
      .select("id, booking_group_id, city, pickup_point, direction")
      .eq("tenant_id", tenantId)
      .eq("id", body.booking_group_stop_id)
      .maybeSingle();
    if (!stop?.id || stop.booking_group_id !== body.booking_group_id) {
      return NextResponse.json({ ok: false, error: "Fermata del gruppo non trovata." }, { status: 404 });
    }

    const serviceDate = (group as { service_date: string | null }).service_date;
    if (!serviceDate) {
      return NextResponse.json(
        { ok: false, error: "Imposta prima la data del gruppo (service_date) per creare i servizi." },
        { status: 422 },
      );
    }

    const g = group as { kind: string };
    const isBusKind = g.kind === "bus_exclusive" || g.kind === "bus_group";
    const st = stop as { city: string; pickup_point: string | null; direction: string };

    const buildInsert = (row: { customer_name: string; pax: number; phone?: string | null; hotel_id?: string | null; notes?: string | null }) => ({
      tenant_id: tenantId,
      booking_group_id: body.booking_group_id,
      booking_group_stop_id: body.booking_group_stop_id,
      is_draft: true,
      status: "needs_review" as const,
      date: serviceDate,
      time: "00:00",
      direction: st.direction,
      service_type: "transfer" as const,
      vessel: `Bus da ${st.city}`,
      pax: row.pax,
      customer_name: row.customer_name,
      phone: (row.phone ?? "").trim(),
      hotel_id: row.hotel_id ?? null,
      bus_city_origin: st.city,
      meeting_point: st.pickup_point,
      notes: (row.notes ?? "").trim(),
      ...(isBusKind ? { booking_service_kind: "bus_city_hotel", service_type_code: "bus_line" } : {}),
    });

    const rows = body.action === "create_group_service"
      ? [{ customer_name: body.customer_name, pax: body.pax, phone: body.phone, hotel_id: body.hotel_id, notes: body.notes }]
      : body.passengers;

    // Valida gli hotel_id (una volta, riusando il set)
    const hotelIds = [...new Set(rows.map((r) => r.hotel_id).filter((v): v is string => Boolean(v)))];
    for (const hid of hotelIds) {
      if (!(await tenantRowExists(admin, "hotels", tenantId, hid))) {
        return NextResponse.json({ ok: false, error: `Hotel ${hid} non valido per il tenant.` }, { status: 400 });
      }
    }

    const created: Array<{ id: string; customer_name: string; pax: number }> = [];
    const failed: Array<{ customer_name: string; error: string }> = [];
    for (const row of rows) {
      const { data: svc, error } = await admin.from("services").insert(buildInsert(row)).select("id").single();
      if (error || !svc?.id) {
        failed.push({ customer_name: row.customer_name, error: error?.message ?? "insert fallita" });
        continue;
      }
      created.push({ id: svc.id as string, customer_name: row.customer_name, pax: row.pax });
      await admin.from("status_events").insert({ tenant_id: tenantId, service_id: svc.id, status: "needs_review", by_user_id: userId });
      auditLog({
        event: "booking_group_service_created",
        tenantId, userId, role: auth.membership.role,
        serviceId: svc.id as string, outcome: "created",
        details: { booking_group_id: body.booking_group_id, booking_group_stop_id: body.booking_group_stop_id, pax: row.pax, city: st.city },
      });
    }

    const status = failed.length === 0 ? 200 : created.length === 0 ? 500 : 207;
    return NextResponse.json({ ok: failed.length === 0, created, failed, created_count: created.length, failed_count: failed.length }, { status });
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

  // ── preview_operationalize_group (READ, nessuna scrittura) ────────────
  if (body.action === "preview_operationalize_group") {
    const view = await buildOperationalizeView(admin, tenantId, body.booking_group_id);
    if (!view) return NextResponse.json({ ok: false, error: "Gruppo non trovato." }, { status: 404 });
    const plannedPax = view.stops.reduce((n, s) => n + Number(s.expected_pax ?? 0), 0);
    const servicePax = view.svcRows.reduce((n, s) => n + Number(s.pax ?? 0), 0);
    return NextResponse.json({
      ok: true,
      group: view.group,
      expected_pax: view.group.expected_pax,
      planned_pax: plannedPax,
      service_pax: servicePax,
      services_total: view.perService.length,
      services_ready: view.ready.length,
      services_blocked: view.blocked.length,
      services_already_operational: view.already.length,
      warnings: view.groupWarnings,
      bus_reservation: view.reservation,
      ferry: {
        outbound: { company: view.group.outbound_ferry_company, departure_port: view.group.outbound_departure_port, ferry_time: view.group.outbound_ferry_time, arrival_port: view.group.outbound_arrival_port, expected_arrival_time: view.group.outbound_expected_arrival_time },
        return: { company: view.group.return_ferry_company, departure_port: view.group.return_departure_port, ferry_time: view.group.return_ferry_time, arrival_port: view.group.return_arrival_port, expected_arrival_time: view.group.return_expected_arrival_time },
      },
      services: view.perService,
    });
  }

  // ── operationalize_group (WRITE) ─────────────────────────────────────
  if (body.action === "operationalize_group") {
    const view = await buildOperationalizeView(admin, tenantId, body.booking_group_id);
    if (!view) return NextResponse.json({ ok: false, error: "Gruppo non trovato." }, { status: 404 });

    const selected = body.service_ids
      ? new Set(body.service_ids)
      : new Set(view.ready.map((p) => p.service_id));

    const operationalized: Array<{ service_id: string; warnings: BookingGroupWarningCode[] }> = [];
    const blocked: Array<{ service_id: string; missing_fields: string[]; warnings: string[] }> = [];
    const already_operational: string[] = [];

    for (const p of view.perService) {
      if (!selected.has(p.service_id)) continue;
      if (p.already_operational) { already_operational.push(p.service_id); continue; }
      if (!p.ready) { blocked.push({ service_id: p.service_id, missing_fields: p.missing_fields, warnings: p.warnings }); continue; }

      const { error } = await admin
        .from("services")
        .update({ is_draft: false, status: "new" })
        .eq("tenant_id", tenantId)
        .eq("id", p.service_id)
        .eq("is_draft", true);
      if (error) { blocked.push({ service_id: p.service_id, missing_fields: [], warnings: [`update_failed: ${error.message}`] }); continue; }

      await admin.from("status_events").insert({ tenant_id: tenantId, service_id: p.service_id, status: "new", by_user_id: userId });

      const warnings: BookingGroupWarningCode[] = [...p.warnings];
      const svc = view.svcRows.find((s) => s.id === p.service_id);
      if (svc?.booking_service_kind === "bus_city_hotel" && !warnings.includes("allocation_pending")) {
        try {
          const alloc = await autoAllocateBusService({ admin, tenantId, serviceId: p.service_id, userId: userId ?? "" });
          if (!alloc || (typeof alloc === "object" && "allocated" in alloc && !alloc.allocated)) warnings.push("allocation_pending");
        } catch {
          warnings.push("allocation_pending");
        }
      }
      operationalized.push({ service_id: p.service_id, warnings });
      auditLog({ event: "booking_group_service_operationalized", tenantId, userId, role: auth.membership.role, serviceId: p.service_id, outcome: "operationalized", details: { booking_group_id: body.booking_group_id, warnings } });
    }

    // Default (nessun service_ids): i service non-ready del gruppo sono comunque
    // "blocked" nella risposta, così la chiamata risulta parziale (207).
    if (!body.service_ids) {
      for (const p of view.blocked) blocked.push({ service_id: p.service_id, missing_fields: p.missing_fields, warnings: p.warnings });
    }

    // Stato gruppo: promuovi a operational SOLO se tutti i service del gruppo lo sono.
    const allDraftServices = view.perService.filter((p) => !p.already_operational);
    const nowAllOperational = allDraftServices.length > 0 && allDraftServices.every((p) => operationalized.some((o) => o.service_id === p.service_id));
    if (nowAllOperational && view.group.status !== "operational" && view.group.status !== "cancelled") {
      await admin.from("booking_groups").update({ status: "operational", updated_at: new Date().toISOString() }).eq("tenant_id", tenantId).eq("id", body.booking_group_id);
    }

    const status = blocked.length === 0
      ? (operationalized.length === 0 && already_operational.length > 0 ? 200 : operationalized.length > 0 ? 200 : 422)
      : (operationalized.length > 0 ? 207 : 422);

    auditLog({
      event: blocked.length === 0 ? "booking_group_operationalized" : "booking_group_operationalization_partial",
      tenantId, userId, role: auth.membership.role,
      outcome: status === 207 ? "partial" : status === 422 ? "blocked" : "operationalized",
      details: { booking_group_id: body.booking_group_id, operationalized: operationalized.length, blocked: blocked.length, already_operational: already_operational.length },
    });

    return NextResponse.json({ ok: status !== 422, operationalized, blocked, already_operational, group_status: nowAllOperational ? "operational" : view.group.status }, { status });
  }

  return NextResponse.json({ ok: false, error: "Azione non riconosciuta." }, { status: 400 });
}
