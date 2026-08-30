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
import {
  BOOKING_GROUP_KINDS,
  BOOKING_GROUP_STATUSES,
  BOOKING_GROUP_MAX_PAX,
  computeBookingGroupStatusSummary,
  type BookingGroup,
  type BookingGroupBusReservation,
  type BookingGroupStop,
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

const bodySchema = z.discriminatedUnion("action", [
  createGroupSchema,
  updateGroupSchema,
  addStopSchema,
  updateStopSchema,
  deleteStopSchema,
  upsertReservationSchema,
  deleteReservationSchema,
]);

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
      .select("id, pax, direction, date, status")
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
  }>;

  const summary = computeBookingGroupStatusSummary({
    status: (group as BookingGroup).status,
    expectedPax: (group as BookingGroup).expected_pax,
    stopExpectedPax: stopRows.map((s) => s.expected_pax),
    servicePax: serviceRows.map((s) => Number(s.pax ?? 0)),
    busReservationCount: reservationRows.length,
  });

  return {
    group: group as BookingGroup,
    stops: stopRows,
    bus_reservations: reservationRows,
    services: serviceRows,
    summary,
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

  return NextResponse.json({ ok: false, error: "Azione non riconosciuta." }, { status: 400 });
}
