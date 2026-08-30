/**
 * FASE 3 — Modulo server CONDIVISO per il dominio GRUPPI PRENOTAZIONE.
 *
 * §2/§28 del prompt FASE 3: la route HTTP (`app/api/ops/booking-groups/route.ts`)
 * e i tool MCP (`lib/mcp/tools/booking-groups/*`) devono chiamare ESATTAMENTE
 * la stessa logica — niente SQL duplicato, niente regole di readiness
 * riscritte, niente seconda copia di `summarizeBookingGroupPax` /
 * `operationalize`. Questo file è quella logica unica.
 *
 * Cosa NON fa (invariato rispetto a FASE 1/2/2.5):
 *  - non tocca `trip_groups` / `assignments` / `tenant_bus_units` /
 *    `bus_line_ferry_config`;
 *  - non crea `tenant_bus_units` / `tenant_bus_line_stops`;
 *  - non inventa dati mancanti (orari/nave/fermate canoniche);
 *  - non rende il Piano del Giorno group-aware.
 *
 * Multi-tenant: ogni funzione riceve `admin` (service role, bypassa RLS) e
 * filtra SEMPRE per `tenant_id`. Ogni FK opzionale è validata contro lo
 * stesso tenant prima della scrittura.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { auditLog } from "@/lib/server/ops-audit";
import { autoAllocateBusService } from "@/lib/server/bus-auto-allocation";
import {
  computeBookingGroupStatusSummary,
  summarizeStopPax,
  evaluateBookingGroupServiceReadiness,
  type BookingGroup,
  type BookingGroupBusReservation,
  type BookingGroupStop,
  type BookingGroupWarningCode,
} from "@/lib/booking-groups";

// ─── contratto comune ─────────────────────────────────────────────────────

export type BgActor = { tenantId: string; userId: string | null; role: string };

export type BgOk<T> = { ok: true; status: number; data: T };
export type BgErr = { ok: false; status: number; error: string };
export type BgResult<T> = BgOk<T> | BgErr;
/**
 * Esito di un'operazione che porta comunque dati strutturati anche quando
 * `ok` è false (parziale / tutto fallito), es. batch passeggeri e
 * operativizzazione. Il ramo `BgErr` resta per gli errori "duri" (404 / input
 * non valido) che non producono dati.
 */
export type BgOutcome<T> = { ok: boolean; status: number; data: T } | BgErr;

const ok = <T>(data: T, status = 200): BgOk<T> => ({ ok: true, status, data });
const err = (status: number, error: string): BgErr => ({ ok: false, status, error });

export function compact<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Verifica che una riga di una tabella parent esista NELLO STESSO tenant. */
export async function tenantRowExists(
  admin: SupabaseClient,
  table: string,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const { data } = await admin.from(table).select("id").eq("tenant_id", tenantId).eq("id", id).maybeSingle();
  return Boolean(data?.id);
}

// ─── lookup gruppo (§18) — mai auto-scelta se ambiguo ──────────────────────

export type BookingGroupMatch = {
  id: string;
  name: string;
  expected_pax: number;
  kind: string;
  status: string;
  service_date: string | null;
};

export type FindBookingGroupsResult = {
  strategy: "id" | "exact_same_date" | "exact" | "partial" | "recent";
  matches: BookingGroupMatch[];
  /** true se >1 match plausibile per una ricerca per nome: il chiamante deve
   *  chiedere disambiguazione, mai scrivere. */
  ambiguous: boolean;
};

const OPEN_STATUSES = new Set(["draft", "to_complete", "stops_defined", "passengers_defined"]);

function slim(g: BookingGroup): BookingGroupMatch {
  return {
    id: g.id,
    name: g.name,
    expected_pax: g.expected_pax,
    kind: g.kind,
    status: g.status,
    service_date: g.service_date ?? null,
  };
}

/**
 * Trova gruppi prenotazione per id oppure per nome (§18). Priorità:
 *  1. id esatto
 *  2. nome esatto (case-insensitive) + stessa `service_date` (se fornita)
 *  3. nome esatto (case-insensitive)
 *  4. nome parziale (substring, case-insensitive)
 *  5. fallback: gruppi recenti ancora aperti
 * Nessun `ilike`: si caricano i gruppi del tenant (cap 200) e si filtra in
 * memoria — semplice, deterministico, testabile con fake admin.
 */
export async function findBookingGroups(
  admin: SupabaseClient,
  tenantId: string,
  params: { id?: string | null; query?: string | null; serviceDate?: string | null },
): Promise<FindBookingGroupsResult> {
  if (params.id) {
    const { data } = await admin
      .from("booking_groups")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("id", params.id)
      .maybeSingle();
    const matches = data ? [slim(data as BookingGroup)] : [];
    return { strategy: "id", matches, ambiguous: false };
  }

  const { data: rows } = await admin
    .from("booking_groups")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(200);
  const groups = ((rows ?? []) as BookingGroup[]).slice();

  const query = (params.query ?? "").trim().toLowerCase();
  if (!query) {
    const recent = groups.filter((g) => OPEN_STATUSES.has(g.status)).slice(0, 10).map(slim);
    return { strategy: "recent", matches: recent, ambiguous: false };
  }

  const exact = groups.filter((g) => g.name.trim().toLowerCase() === query);
  if (exact.length > 0) {
    if (params.serviceDate) {
      const sameDate = exact.filter((g) => g.service_date === params.serviceDate);
      if (sameDate.length > 0) {
        return { strategy: "exact_same_date", matches: sameDate.map(slim), ambiguous: sameDate.length > 1 };
      }
    }
    return { strategy: "exact", matches: exact.map(slim), ambiguous: exact.length > 1 };
  }

  const partial = groups.filter((g) => g.name.trim().toLowerCase().includes(query));
  if (partial.length > 0) {
    return { strategy: "partial", matches: partial.slice(0, 10).map(slim), ambiguous: partial.length > 1 };
  }

  const recent = groups.filter((g) => OPEN_STATUSES.has(g.status)).slice(0, 10).map(slim);
  return { strategy: "recent", matches: recent, ambiguous: false };
}

// ─── detail (spostato invariato dalla route) ──────────────────────────────

export async function loadGroupDetail(admin: SupabaseClient, tenantId: string, groupId: string) {
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

// ─── operativizzazione: vista + esecuzione (spostate invariate) ────────────

type OpSvcRow = {
  id: string; is_draft: boolean | null; status: string | null; pax: number | null;
  customer_name: string | null; date: string | null; time: string | null; direction: string | null;
  bus_city_origin: string | null; meeting_point: string | null; hotel_id: string | null;
  booking_service_kind: string | null; booking_group_id: string | null; booking_group_stop_id: string | null;
};

export async function buildOperationalizeView(admin: SupabaseClient, tenantId: string, groupId: string) {
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

export type OperationalizeViewShape = {
  group: BookingGroup;
  expected_pax: number;
  planned_pax: number;
  service_pax: number;
  services_total: number;
  services_ready: number;
  services_blocked: number;
  services_already_operational: number;
  warnings: BookingGroupWarningCode[];
  bus_reservation: (BookingGroupBusReservation & { bus_capacity: number | null }) | null;
  ferry: {
    outbound: { company: string | null; departure_port: string | null; ferry_time: string | null; arrival_port: string | null; expected_arrival_time: string | null };
    return: { company: string | null; departure_port: string | null; ferry_time: string | null; arrival_port: string | null; expected_arrival_time: string | null };
  };
  services: Array<{ service_id: string; customer_name: string | null; pax: number; ready: boolean; already_operational: boolean; missing_fields: string[]; warnings: string[] }>;
};

/** Vista READ dell'operativizzazione — identica alla risposta di
 *  `preview_operationalize_group` della route. */
export async function previewOperationalizeBookingGroup(
  admin: SupabaseClient,
  tenantId: string,
  groupId: string,
): Promise<BgResult<OperationalizeViewShape>> {
  const view = await buildOperationalizeView(admin, tenantId, groupId);
  if (!view) return err(404, "Gruppo non trovato.");
  const plannedPax = view.stops.reduce((n, s) => n + Number(s.expected_pax ?? 0), 0);
  const servicePax = view.svcRows.reduce((n, s) => n + Number(s.pax ?? 0), 0);
  return ok({
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

export type OperationalizeResult = {
  operationalized: Array<{ service_id: string; warnings: BookingGroupWarningCode[] }>;
  blocked: Array<{ service_id: string; missing_fields: string[]; warnings: string[] }>;
  already_operational: string[];
  group_status: string;
};

export async function operationalizeBookingGroup(
  admin: SupabaseClient,
  actor: BgActor,
  input: { bookingGroupId: string; serviceIds?: string[] },
): Promise<BgOutcome<OperationalizeResult>> {
  const { tenantId, userId, role } = actor;
  const view = await buildOperationalizeView(admin, tenantId, input.bookingGroupId);
  if (!view) return err(404, "Gruppo non trovato.");

  const selected = input.serviceIds
    ? new Set(input.serviceIds)
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
    auditLog({ event: "booking_group_service_operationalized", tenantId, userId, role, serviceId: p.service_id, outcome: "operationalized", details: { booking_group_id: input.bookingGroupId, warnings } });
  }

  if (!input.serviceIds) {
    for (const p of view.blocked) blocked.push({ service_id: p.service_id, missing_fields: p.missing_fields, warnings: p.warnings });
  }

  const allDraftServices = view.perService.filter((p) => !p.already_operational);
  const nowAllOperational = allDraftServices.length > 0 && allDraftServices.every((p) => operationalized.some((o) => o.service_id === p.service_id));
  if (nowAllOperational && view.group.status !== "operational" && view.group.status !== "cancelled") {
    await admin.from("booking_groups").update({ status: "operational", updated_at: new Date().toISOString() }).eq("tenant_id", tenantId).eq("id", input.bookingGroupId);
  }

  const status = blocked.length === 0
    ? (operationalized.length === 0 && already_operational.length > 0 ? 200 : operationalized.length > 0 ? 200 : 422)
    : (operationalized.length > 0 ? 207 : 422);

  auditLog({
    event: blocked.length === 0 ? "booking_group_operationalized" : "booking_group_operationalization_partial",
    tenantId, userId, role,
    outcome: status === 207 ? "partial" : status === 422 ? "blocked" : "operationalized",
    details: { booking_group_id: input.bookingGroupId, operationalized: operationalized.length, blocked: blocked.length, already_operational: already_operational.length },
  });

  return {
    ok: status !== 422,
    status,
    data: {
      operationalized,
      blocked,
      already_operational,
      group_status: nowAllOperational ? "operational" : view.group.status,
    },
  };
}

// ─── create group ────────────────────────────────────────────────────────

export type FerryOverrideKey =
  | "outbound_ferry_company" | "outbound_departure_port" | "outbound_ferry_time" | "outbound_arrival_port" | "outbound_expected_arrival_time"
  | "return_ferry_company" | "return_departure_port" | "return_ferry_time" | "return_arrival_port" | "return_expected_arrival_time";

export const FERRY_OVERRIDE_KEYS: readonly FerryOverrideKey[] = [
  "outbound_ferry_company", "outbound_departure_port", "outbound_ferry_time", "outbound_arrival_port", "outbound_expected_arrival_time",
  "return_ferry_company", "return_departure_port", "return_ferry_time", "return_arrival_port", "return_expected_arrival_time",
];

export type CreateBookingGroupInput = {
  name: string;
  expected_pax: number;
  kind?: string;
  status?: string;
  service_date?: string | null;
  contact_name?: string | null;
  contact_phone?: string | null;
  agency_id?: string | null;
  hotel_id?: string | null;
  notes?: string | null;
} & Partial<Record<FerryOverrideKey, string | null>>;

export async function createBookingGroup(
  admin: SupabaseClient,
  actor: BgActor,
  input: CreateBookingGroupInput,
): Promise<BgResult<{ group: BookingGroup }>> {
  const { tenantId, userId, role } = actor;
  if (input.agency_id && !(await tenantRowExists(admin, "agencies", tenantId, input.agency_id))) {
    return err(400, "Agenzia non valida per il tenant.");
  }
  if (input.hotel_id && !(await tenantRowExists(admin, "hotels", tenantId, input.hotel_id))) {
    return err(400, "Hotel non valido per il tenant.");
  }
  const insert = compact({
    ...input,
    tenant_id: tenantId,
    kind: input.kind ?? "other",
    status: input.status ?? "draft",
    created_by_user_id: userId,
  });
  const { data, error } = await admin.from("booking_groups").insert(insert).select("*").single();
  if (error) return err(500, error.message);
  const group = data as BookingGroup;
  auditLog({ event: "booking_group_created", tenantId, userId, role, outcome: "created", details: { id: group.id, name: group.name, expected_pax: group.expected_pax, kind: group.kind } });
  return ok({ group });
}

// ─── patch group (base) + ferry override ─────────────────────────────────

/** Patch generico dei campi del gruppo. Usato sia da `update_group` (route)
 *  sia da `updateBookingGroupFerry` (MCP) — nessuna copia della scrittura. */
export async function patchBookingGroup(
  admin: SupabaseClient,
  actor: BgActor,
  id: string,
  fields: Record<string, unknown>,
  opts: { validateFks?: boolean } = {},
): Promise<BgResult<{ group: BookingGroup }>> {
  const { tenantId } = actor;
  if (!(await tenantRowExists(admin, "booking_groups", tenantId, id))) {
    return err(404, "Gruppo non trovato.");
  }
  if (opts.validateFks) {
    if (fields.agency_id && !(await tenantRowExists(admin, "agencies", tenantId, fields.agency_id as string))) {
      return err(400, "Agenzia non valida per il tenant.");
    }
    if (fields.hotel_id && !(await tenantRowExists(admin, "hotels", tenantId, fields.hotel_id as string))) {
      return err(400, "Hotel non valido per il tenant.");
    }
  }
  const patch = compact({ ...fields, updated_at: new Date().toISOString() });
  if (Object.keys(patch).length === 1) {
    return err(400, "Nessun campo da aggiornare.");
  }
  const { data, error } = await admin
    .from("booking_groups")
    .update(patch)
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .select("*")
    .single();
  if (error) return err(500, error.message);
  return ok({ group: data as BookingGroup });
}

export async function updateBookingGroupFerry(
  admin: SupabaseClient,
  actor: BgActor,
  input: { bookingGroupId: string; ferry: Partial<Record<FerryOverrideKey, string | null>> },
): Promise<BgResult<{ group: BookingGroup }>> {
  const fields: Record<string, unknown> = {};
  for (const key of FERRY_OVERRIDE_KEYS) {
    if (key in input.ferry) fields[key] = input.ferry[key] ?? null;
  }
  if (Object.keys(fields).length === 0) return err(400, "Nessun campo traghetto da aggiornare.");
  const res = await patchBookingGroup(admin, actor, input.bookingGroupId, fields);
  if (res.ok) {
    auditLog({
      event: "booking_group_ferry_updated",
      tenantId: actor.tenantId, userId: actor.userId, role: actor.role,
      outcome: "updated",
      details: { booking_group_id: input.bookingGroupId, fields: Object.keys(fields) },
    });
  }
  return res;
}

// ─── add stop ────────────────────────────────────────────────────────────

export type AddStopInput = {
  bookingGroupId: string;
  city: string;
  pickup_point?: string | null;
  expected_pax: number;
  stop_id?: string | null;
  direction: "arrival" | "departure";
  sort_order?: number;
  notes?: string | null;
};

export async function addBookingGroupStop(
  admin: SupabaseClient,
  actor: BgActor,
  input: AddStopInput,
): Promise<BgResult<{ stop: BookingGroupStop }>> {
  const { tenantId, userId, role } = actor;
  if (!(await tenantRowExists(admin, "booking_groups", tenantId, input.bookingGroupId))) {
    return err(404, "Gruppo non trovato.");
  }
  if (input.stop_id && !(await tenantRowExists(admin, "tenant_bus_line_stops", tenantId, input.stop_id))) {
    return err(400, "Fermata catalogo non valida per il tenant.");
  }
  const insert = compact({
    tenant_id: tenantId,
    booking_group_id: input.bookingGroupId,
    city: input.city,
    pickup_point: input.pickup_point,
    expected_pax: input.expected_pax,
    stop_id: input.stop_id,
    direction: input.direction,
    sort_order: input.sort_order ?? 0,
    notes: input.notes,
  });
  const { data, error } = await admin.from("booking_group_stops").insert(insert).select("*").single();
  if (error) return err(500, error.message);
  auditLog({ event: "booking_group_stop_added", tenantId, userId, role, outcome: "created", details: { booking_group_id: input.bookingGroupId, city: input.city, expected_pax: input.expected_pax, direction: input.direction } });
  return ok({ stop: data as BookingGroupStop });
}

// ─── add passengers (create_group_service / batch unificati) ──────────────

export type PassengerRow = {
  customer_name: string;
  pax: number;
  phone?: string | null;
  hotel_id?: string | null;
  notes?: string | null;
};

export type AddPassengersResult = {
  created: Array<{ id: string; customer_name: string; pax: number }>;
  failed: Array<{ customer_name: string; error: string }>;
  created_count: number;
  failed_count: number;
};

export async function addBookingGroupPassengers(
  admin: SupabaseClient,
  actor: BgActor,
  input: { bookingGroupId: string; bookingGroupStopId: string; passengers: PassengerRow[] },
): Promise<BgOutcome<AddPassengersResult>> {
  const { tenantId, userId, role } = actor;

  const { data: group } = await admin
    .from("booking_groups")
    .select("id, kind, service_date")
    .eq("tenant_id", tenantId)
    .eq("id", input.bookingGroupId)
    .maybeSingle();
  if (!group?.id) return err(404, "Gruppo non trovato.");

  const { data: stop } = await admin
    .from("booking_group_stops")
    .select("id, booking_group_id, city, pickup_point, direction")
    .eq("tenant_id", tenantId)
    .eq("id", input.bookingGroupStopId)
    .maybeSingle();
  if (!stop?.id || stop.booking_group_id !== input.bookingGroupId) {
    return err(404, "Fermata del gruppo non trovata.");
  }

  const serviceDate = (group as { service_date: string | null }).service_date;
  if (!serviceDate) {
    return err(422, "Imposta prima la data del gruppo (service_date) per creare i servizi.");
  }

  const g = group as { kind: string };
  const isBusKind = g.kind === "bus_exclusive" || g.kind === "bus_group";
  const st = stop as { city: string; pickup_point: string | null; direction: string };

  const buildInsert = (row: PassengerRow) => ({
    tenant_id: tenantId,
    booking_group_id: input.bookingGroupId,
    booking_group_stop_id: input.bookingGroupStopId,
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

  const hotelIds = [...new Set(input.passengers.map((r) => r.hotel_id).filter((v): v is string => Boolean(v)))];
  for (const hid of hotelIds) {
    if (!(await tenantRowExists(admin, "hotels", tenantId, hid))) {
      return err(400, `Hotel ${hid} non valido per il tenant.`);
    }
  }

  const created: AddPassengersResult["created"] = [];
  const failed: AddPassengersResult["failed"] = [];
  for (const row of input.passengers) {
    const { data: svc, error } = await admin.from("services").insert(buildInsert(row)).select("id").single();
    if (error || !svc?.id) {
      failed.push({ customer_name: row.customer_name, error: error?.message ?? "insert fallita" });
      continue;
    }
    created.push({ id: svc.id as string, customer_name: row.customer_name, pax: row.pax });
    await admin.from("status_events").insert({ tenant_id: tenantId, service_id: svc.id, status: "needs_review", by_user_id: userId });
    auditLog({
      event: "booking_group_service_created",
      tenantId, userId, role,
      serviceId: svc.id as string, outcome: "created",
      details: { booking_group_id: input.bookingGroupId, booking_group_stop_id: input.bookingGroupStopId, pax: row.pax, city: st.city },
    });
  }

  const status = failed.length === 0 ? 200 : created.length === 0 ? 500 : 207;
  return {
    ok: failed.length === 0,
    status,
    data: { created, failed, created_count: created.length, failed_count: failed.length },
  };
}

// ─── reserve bus (upsert_bus_reservation) ────────────────────────────────

export type ReserveBusInput = {
  bookingGroupId: string;
  busUnitId: string;
  service_date: string;
  reserved_pax: number;
  exclusive?: boolean;
  notes?: string | null;
};

export async function reserveBookingGroupBus(
  admin: SupabaseClient,
  actor: BgActor,
  input: ReserveBusInput,
): Promise<BgResult<{ reservation: BookingGroupBusReservation }>> {
  const { tenantId, userId, role } = actor;
  if (!(await tenantRowExists(admin, "booking_groups", tenantId, input.bookingGroupId))) {
    return err(404, "Gruppo non trovato.");
  }
  if (!(await tenantRowExists(admin, "tenant_bus_units", tenantId, input.busUnitId))) {
    return err(400, "Bus unit non valida per il tenant.");
  }
  const row = compact({
    booking_group_id: input.bookingGroupId,
    bus_unit_id: input.busUnitId,
    service_date: input.service_date,
    reserved_pax: input.reserved_pax,
    tenant_id: tenantId,
    exclusive: input.exclusive ?? false,
    notes: input.notes,
    updated_at: new Date().toISOString(),
  });
  const { data, error } = await admin
    .from("booking_group_bus_reservations")
    .upsert(row, { onConflict: "tenant_id,booking_group_id,bus_unit_id,service_date" })
    .select("*")
    .single();
  if (error) return err(500, error.message);
  auditLog({ event: "booking_group_bus_reservation_changed", tenantId, userId, role, outcome: "upserted", details: { booking_group_id: input.bookingGroupId, bus_unit_id: input.busUnitId, service_date: input.service_date, reserved_pax: input.reserved_pax, exclusive: input.exclusive ?? false } });
  return ok({ reservation: data as BookingGroupBusReservation });
}
