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
  computeBookingGroupStatusSummaryByDirection,
  summarizeStopPax,
  evaluateBookingGroupServiceReadiness,
  BOOKING_GROUP_PLACEHOLDER_TIME,
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

// FASE A.5.3 §2 — esportata per riuso deterministico dal resume multi-stop
// dell'orchestratore Mario (stessa normalizzazione dell'idempotenza qui sotto,
// mai una seconda implementazione del match città).
export function normalizeCityKey(value?: string | null): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function isSupportedBookingGroupDate(value?: string | null): boolean {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  return year >= 2020 && year <= 2100;
}

const EXCLUSIVE_GROUP_LINE_CODE = "GRUPPI_ESCLUSIVI";

export type BookingGroupCatalogStopSuggestion = {
  id: string;
  bus_line_id: string | null;
  direction: "arrival" | "departure";
  city: string | null;
  stop_name: string | null;
  pickup_note: string | null;
  pickup_time: string | null;
  label: string;
};

async function getExclusiveGroupLineId(admin: SupabaseClient, tenantId: string): Promise<string | null> {
  const { data } = await admin
    .from("tenant_bus_lines")
    .select("id, code, family_code")
    .eq("tenant_id", tenantId)
    .eq("active", true);
  const line = ((data ?? []) as Array<{ id: string; code?: string | null; family_code?: string | null }>).find(
    (row) => row.code === EXCLUSIVE_GROUP_LINE_CODE || row.family_code === EXCLUSIVE_GROUP_LINE_CODE,
  );
  return line?.id ?? null;
}

/**
 * Risolve la fermata canonica `tenant_bus_line_stops` per città+direzione,
 * SOLO su match esatto (city o stop_name normalizzati) e SOLO se univoco.
 * Nessun fuzzy/substring: un match ambiguo o assente ritorna `null` — mai
 * un'assegnazione indovinata (FASE A.5 §E). Usata sia per pre-risolvere
 * `booking_group_stops.stop_id` sia per l'orario reale del service (§D).
 */
export async function resolveCanonicalBookingGroupStop(
  admin: SupabaseClient,
  tenantId: string,
  city: string,
  direction: "arrival" | "departure",
  pickupPoint?: string | null,
  busLineId?: string | null,
): Promise<{ stopId: string; pickupTime: string | null } | null> {
  const target = normalizeCityKey(city);
  const pickupTarget = normalizeCityKey(pickupPoint);
  if (!target && !pickupTarget) return null;
  const { data } = await admin
    .from("tenant_bus_line_stops")
    .select("id, bus_line_id, city, stop_name, pickup_note, pickup_time")
    .eq("tenant_id", tenantId)
    .eq("direction", direction)
    .eq("active", true);
  const rows = ((data ?? []) as Array<{ id: string; bus_line_id: string | null; city: string | null; stop_name: string | null; pickup_note?: string | null; pickup_time: string | null }>)
    .filter((r) => !busLineId || r.bus_line_id === busLineId);
  const matches = rows.filter((r) => {
    const cityKey = normalizeCityKey(r.city);
    const stopKey = normalizeCityKey(r.stop_name);
    const noteKey = normalizeCityKey(r.pickup_note);
    if (pickupTarget) {
      return (
        stopKey === pickupTarget ||
        noteKey === pickupTarget ||
        (cityKey === target && (stopKey.includes(pickupTarget) || noteKey.includes(pickupTarget)))
      );
    }
    return cityKey === target || stopKey === target;
  });
  if (matches.length !== 1) return null;
  return { stopId: matches[0]!.id, pickupTime: matches[0]!.pickup_time ?? null };
}

export async function suggestBookingGroupCatalogStops(
  admin: SupabaseClient,
  tenantId: string,
  input: {
    query?: string | null;
    city?: string | null;
    pickupPoint?: string | null;
    direction?: "arrival" | "departure" | null;
    busLineId?: string | null;
    limit?: number | null;
  },
): Promise<BookingGroupCatalogStopSuggestion[]> {
  const queryKey = normalizeCityKey(input.query);
  const cityKey = normalizeCityKey(input.city);
  const pickupKey = normalizeCityKey(input.pickupPoint);
  const wanted = [queryKey, cityKey, pickupKey].filter(Boolean);
  if (wanted.length === 0) return [];

  let request = admin
    .from("tenant_bus_line_stops")
    .select("id, bus_line_id, direction, city, stop_name, pickup_note, pickup_time")
    .eq("tenant_id", tenantId)
    .eq("active", true);
  if (input.direction) request = request.eq("direction", input.direction);
  if (input.busLineId) request = request.eq("bus_line_id", input.busLineId);

  const { data } = await request.order("city").order("stop_order").limit(500);
  const rows = (data ?? []) as Array<{
    id: string;
    bus_line_id: string | null;
    direction: "arrival" | "departure";
    city: string | null;
    stop_name: string | null;
    pickup_note: string | null;
    pickup_time: string | null;
  }>;

  const scored = rows
    .map((row) => {
      const rowCity = normalizeCityKey(row.city);
      const rowStop = normalizeCityKey(row.stop_name);
      const rowNote = normalizeCityKey(row.pickup_note);
      const haystack = [rowCity, rowStop, rowNote].filter(Boolean).join(" ");
      let score = 0;
      for (const token of wanted) {
        if (rowCity === token) score += 8;
        if (rowStop === token) score += 7;
        if (rowNote === token) score += 6;
        if (haystack.includes(token)) score += 2;
      }
      return { row, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || String(a.row.city ?? a.row.stop_name ?? "").localeCompare(String(b.row.city ?? b.row.stop_name ?? "")));

  return scored.slice(0, Math.max(1, Math.min(input.limit ?? 8, 20))).map(({ row }) => {
    const city = row.city?.trim() || row.stop_name?.trim() || "";
    const point = row.pickup_note?.trim() || (row.stop_name?.trim() && row.stop_name.trim() !== city ? row.stop_name.trim() : "");
    return {
      ...row,
      label: [city, point].filter(Boolean).join(" - ") || "Fermata catalogo",
    };
  });
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
  return_date: string | null;
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
    return_date: g.return_date ?? null,
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
      .select("id, pax, direction, date, status, is_draft, customer_name, booking_group_stop_id, bus_city_origin, meeting_point, phone, notes")
      .eq("tenant_id", tenantId)
      .eq("booking_group_id", groupId),
  ]);

  const stopRows = (stops ?? []) as BookingGroupStop[];
  const stopIds = Array.from(new Set(stopRows.map((stop) => stop.stop_id).filter(Boolean) as string[]));
  const { data: catalogStops } = stopIds.length > 0
    ? await admin
      .from("tenant_bus_line_stops")
      .select("id, pickup_time")
      .eq("tenant_id", tenantId)
      .in("id", stopIds)
    : { data: [] as Array<{ id: string; pickup_time: string | null }> };
  const catalogTimeByStopId = new Map(
    ((catalogStops ?? []) as Array<{ id: string; pickup_time: string | null }>)
      .map((stop) => [stop.id, stop.pickup_time] as const),
  );
  const enrichedStopRows = stopRows.map((stop) => ({
    ...stop,
    catalog_pickup_time: stop.stop_id ? catalogTimeByStopId.get(stop.stop_id) ?? null : null,
  }));
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
    phone: string | null;
    notes: string | null;
  }>;

  // Un service 'cancelled' resta collegato al gruppo/fermata (audit/storico)
  // ma non deve mai contare come pax pianificato/servito: altrimenti un
  // nominativo rimosso via removeGroupPassenger (soft-cancel) continuerebbe
  // a gonfiare i conteggi.
  const activeServiceRows = serviceRows.filter((s) => s.status !== "cancelled");
  // Direzione derivata dalla FERMATA collegata (sempre affidabile, e' quella
  // che definisce andata/ritorno nel dominio), con fallback su
  // services.direction solo per service orfani senza booking_group_stop_id.
  const directionByStopId = new Map(enrichedStopRows.map((s) => [s.id, s.direction] as const));
  const serviceDirection = (s: (typeof activeServiceRows)[number]): string | null =>
    (s.booking_group_stop_id ? directionByStopId.get(s.booking_group_stop_id) : undefined) ?? s.direction ?? null;

  const summary = computeBookingGroupStatusSummaryByDirection({
    status: (group as BookingGroup).status,
    expectedPax: (group as BookingGroup).expected_pax,
    arrivalStopExpectedPax: enrichedStopRows.filter((s) => s.direction === "arrival").map((s) => s.expected_pax),
    departureStopExpectedPax: enrichedStopRows.filter((s) => s.direction === "departure").map((s) => s.expected_pax),
    arrivalServicePax: activeServiceRows.filter((s) => serviceDirection(s) === "arrival").map((s) => Number(s.pax ?? 0)),
    departureServicePax: activeServiceRows.filter((s) => serviceDirection(s) === "departure").map((s) => Number(s.pax ?? 0)),
    busReservationCount: reservationRows.length,
  });

  const stop_summaries = enrichedStopRows.map((stop) =>
    summarizeStopPax({
      stopId: stop.id,
      expectedPax: stop.expected_pax,
      servicePax: activeServiceRows.filter((s) => s.booking_group_stop_id === stop.id).map((s) => Number(s.pax ?? 0)),
    }),
  );

  return {
    group: group as BookingGroup,
    stops: enrichedStopRows,
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

  const stopRows = (stops ?? []) as Array<{ id: string; city: string; pickup_point: string | null; stop_id: string | null; expected_pax: number; direction?: "arrival" | "departure" | null }>;
  const svcRows = (services ?? []) as OpSvcRow[];
  const resRows = (reservations ?? []) as BookingGroupBusReservation[];
  const stopById = new Map(stopRows.map((s) => [s.id, s]));

  for (const s of svcRows) {
    const time = (s.time ?? "").trim();
    if (time && !time.startsWith(BOOKING_GROUP_PLACEHOLDER_TIME)) continue;
    const stop = s.booking_group_stop_id ? stopById.get(s.booking_group_stop_id) ?? null : null;
    const direction = s.direction === "arrival" || s.direction === "departure" ? s.direction : null;
    if (!stop || !direction) continue;
    let pickupTime: string | null = null;
    if (stop.stop_id) {
      const { data: canonicalStop } = await admin
        .from("tenant_bus_line_stops")
        .select("pickup_time")
        .eq("tenant_id", tenantId)
        .eq("id", stop.stop_id)
        .maybeSingle();
      pickupTime = (canonicalStop as { pickup_time: string | null } | null)?.pickup_time ?? null;
    } else {
      const canonical = await resolveCanonicalBookingGroupStop(admin, tenantId, stop.city, direction, stop.pickup_point);
      if (canonical) {
        stop.stop_id = canonical.stopId;
        pickupTime = canonical.pickupTime ?? null;
      }
    }
    if (pickupTime?.trim()) s.time = pickupTime.trim();
  }

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

  return { group: g, stops: stopRows, svcRows, reservation, reservations: resRows, groupWarnings, perService, ready, blocked, already };
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
    const svc = view.svcRows.find((s) => s.id === p.service_id);

    const { error } = await admin
      .from("services")
      .update(compact({ is_draft: false, status: "new", time: svc?.time }))
      .eq("tenant_id", tenantId)
      .eq("id", p.service_id)
      .eq("is_draft", true);
    if (error) { blocked.push({ service_id: p.service_id, missing_fields: [], warnings: [`update_failed: ${error.message}`] }); continue; }

    await admin.from("status_events").insert({ tenant_id: tenantId, service_id: p.service_id, status: "new", by_user_id: userId });

    const warnings: BookingGroupWarningCode[] = [...p.warnings];
    if (svc?.booking_service_kind === "bus_city_hotel" && !warnings.includes("allocation_pending")) {
      // FASE A.5 §P / FASE A.5.1 §15 — un gruppo bus_exclusive non deve MAI
      // finire allocato automaticamente su un bus condiviso
      // (autoAllocateBusService non distingue esclusivo/condiviso). Se esiste
      // una reservation esclusiva per LA DATA DI QUESTO SERVICE (andata e
      // ritorno possono avere reservation diverse, §17), si alloca sul bus
      // predeterminato dalla reservation; altrimenti resta allocation_pending
      // (mezzo dedicato ancora da riservare — mai un fallback su bus condiviso).
      if (view.group.kind === "bus_exclusive") {
        const matchingReservation = view.reservations.find((r) => r.service_date === svc.date && r.exclusive);
        if (matchingReservation) {
          try {
            const alloc = await allocateReservedBookingGroupBusService(admin, {
              tenantId, serviceId: p.service_id, busUnitId: matchingReservation.bus_unit_id, userId: userId ?? "",
            });
            if (!alloc.allocated) warnings.push("allocation_pending");
          } catch {
            warnings.push("allocation_pending");
          }
        } else {
          warnings.push("allocation_pending");
        }
      } else {
        try {
          const alloc = await autoAllocateBusService({ admin, tenantId, serviceId: p.service_id, userId: userId ?? "" });
          if (!alloc || (typeof alloc === "object" && "allocated" in alloc && !alloc.allocated)) warnings.push("allocation_pending");
        } catch {
          warnings.push("allocation_pending");
        }
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
  return_date?: string | null;
  returnDate?: string | null;
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
  const serviceDate = input.service_date ?? null;
  const returnDate = input.return_date ?? input.returnDate ?? null;
  if ((serviceDate && !isSupportedBookingGroupDate(serviceDate)) || (returnDate && !isSupportedBookingGroupDate(returnDate))) {
    return err(400, "Data gruppo non valida: usa un anno tra 2020 e 2100.");
  }
  if (input.kind === "bus_exclusive" && !serviceDate && !returnDate) {
    return err(400, "Per un bus esclusivo inserisci almeno una data tra arrivo e ritorno.");
  }
  if (serviceDate && returnDate && returnDate < serviceDate) {
    return err(400, "La data di ritorno non puo essere precedente alla data di arrivo.");
  }
  if (input.agency_id && !(await tenantRowExists(admin, "agencies", tenantId, input.agency_id))) {
    return err(400, "Agenzia non valida per il tenant.");
  }
  if (input.hotel_id && !(await tenantRowExists(admin, "hotels", tenantId, input.hotel_id))) {
    return err(400, "Hotel non valido per il tenant.");
  }
  const { returnDate: _returnDate, ...dbInput } = input;
  void _returnDate;
  const insert = compact({
    ...dbInput,
    service_date: serviceDate,
    return_date: returnDate,
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
  opts: { validateFks?: boolean; autoAssign?: boolean } = {},
): Promise<BgResult<{ group: BookingGroup }>> {
  const { tenantId } = actor;
  if (!(await tenantRowExists(admin, "booking_groups", tenantId, id))) {
    return err(404, "Gruppo non trovato.");
  }
  const serviceDate = typeof fields.service_date === "string" ? fields.service_date : null;
  const returnDate = typeof fields.return_date === "string" ? fields.return_date : null;
  if ((serviceDate && !isSupportedBookingGroupDate(serviceDate)) || (returnDate && !isSupportedBookingGroupDate(returnDate))) {
    return err(400, "Data gruppo non valida: usa un anno tra 2020 e 2100.");
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
  const group = data as BookingGroup;

  // Propagazione a services draft/needs_review generati dal gruppo (mai a
  // services gia' operativi: is_draft=false resta invariato, coerente con
  // "essere conservativi sugli operativi" — le viste operative devono
  // eventualmente usare fallback in lettura per quelli). Solo se
  // service_date/return_date/hotel_id sono STATI TOCCATI da questo patch
  // (mai una query extra sui patch che non li riguardano, es. solo note).
  const touchesDates = fields.service_date !== undefined || fields.return_date !== undefined;
  const touchesHotel = fields.hotel_id !== undefined;
  if (touchesDates || touchesHotel) {
    const { data: draftServices } = await admin
      .from("services")
      .select("id, direction, date, hotel_id")
      .eq("tenant_id", tenantId)
      .eq("booking_group_id", id)
      .eq("is_draft", true);
    for (const svc of (draftServices ?? []) as Array<{ id: string; direction: string | null; date: string | null; hotel_id: string | null }>) {
      const svcPatch: Record<string, unknown> = {};
      if (touchesDates) {
        // Stessa regola gia' usata in UI (GroupDetail/StopsSection) per
        // scegliere la data di un service in base alla direzione: partenza
        // -> return_date (con fallback su service_date se assente),
        // arrivo -> service_date. Non azzera mai una data esistente.
        const nextDate = svc.direction === "departure" ? (group.return_date ?? group.service_date) : group.service_date;
        if (nextDate && nextDate !== svc.date) {
          svcPatch.date = nextDate;
          // Obiettivo C: arrival_date/departure_date seguono `date` per la
          // stessa direzione, cosi' le viste che leggono quei campi vedono
          // subito la data aggiornata.
          if (svc.direction === "departure") svcPatch.departure_date = nextDate;
          else svcPatch.arrival_date = nextDate;
        }
      }
      // Mai sovrascrivere un hotel gia' impostato sul singolo passeggero
      // (manuale o gia' propagato): solo riempie il vuoto.
      if (touchesHotel && !svc.hotel_id && group.hotel_id) svcPatch.hotel_id = group.hotel_id;
      if (Object.keys(svcPatch).length > 0) {
        await admin.from("services").update(svcPatch).eq("tenant_id", tenantId).eq("id", svc.id);
      }
    }
  }

  // Obiettivo A — "zero click": se le date del gruppo sono cambiate (es. la
  // prima data valida arriva solo ora), prova a riservare/operativizzare da
  // sola (best effort, mai bloccante). Mai chiamata da MCP oggi (nessun tool
  // Mario invoca patchBookingGroup direttamente), ma resta rispettato lo
  // stesso opt-out esplicito di addBookingGroupPassengers per uniformita'.
  if (touchesDates && opts.autoAssign !== false) {
    try {
      await autoAssignBookingGroup(admin, actor, id);
    } catch {
      // best-effort: un fallimento qui non deve mai propagarsi al chiamante.
    }
  }

  return ok({ group });
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
  create_catalog_stop?: boolean;
  bus_line_id?: string | null;
  pickup_time?: string | null;
  direction: "arrival" | "departure";
  sort_order?: number;
  notes?: string | null;
  contact_name?: string | null;
  contact_phone?: string | null;
};

type CreatedCatalogStop = { id: string; pickup_time: string | null };

async function syncPlaceholderTimesForBookingGroupStop(
  admin: SupabaseClient,
  tenantId: string,
  bookingGroupStopId: string,
  pickupTime?: string | null,
) {
  const time = pickupTime?.trim();
  if (!time) return;
  await admin
    .from("services")
    .update({ time, updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("booking_group_stop_id", bookingGroupStopId)
    .eq("time", BOOKING_GROUP_PLACEHOLDER_TIME);
}

async function createManualCatalogStopForBookingGroup(
  admin: SupabaseClient,
  actor: BgActor,
  input: AddStopInput,
): Promise<BgResult<CreatedCatalogStop>> {
  const { tenantId } = actor;
  if (!input.bus_line_id) return err(400, "Se crei una fermata nel catalogo devi scegliere la linea bus.");
  if (!(await tenantRowExists(admin, "tenant_bus_lines", tenantId, input.bus_line_id))) {
    return err(400, "Linea bus non valida per il tenant.");
  }
  const stopName = input.city.trim();
  const pickupNote = input.pickup_point?.trim() || null;
  const { data: existing } = await admin
    .from("tenant_bus_line_stops")
    .select("id, pickup_note, pickup_time")
    .eq("tenant_id", tenantId)
    .eq("bus_line_id", input.bus_line_id)
    .eq("direction", input.direction)
    .eq("stop_name", stopName)
    .eq("active", true)
    .limit(1);
  const found = ((existing ?? []) as Array<{ id: string; pickup_time: string | null; pickup_note?: string | null }>).find(
    (row) => normalizeCityKey(row.pickup_note) === normalizeCityKey(pickupNote),
  );
  if (found?.id) {
    const pickupTime = input.pickup_time?.trim() || found.pickup_time || null;
    if (pickupTime !== found.pickup_time) {
      await admin
        .from("tenant_bus_line_stops")
        .update({ pickup_time: pickupTime, updated_at: new Date().toISOString() })
        .eq("tenant_id", tenantId)
        .eq("id", found.id);
    }
    return ok({ id: found.id, pickup_time: pickupTime });
  }
  const { data: lastStops } = await admin
    .from("tenant_bus_line_stops")
    .select("stop_order")
    .eq("tenant_id", tenantId)
    .eq("bus_line_id", input.bus_line_id)
    .eq("direction", input.direction)
    .order("stop_order", { ascending: false })
    .limit(1);
  const lastOrder = Number(((lastStops ?? [])[0] as { stop_order?: number } | undefined)?.stop_order ?? 0);
  const stopOrder = input.sort_order && input.sort_order > 0 ? input.sort_order : lastOrder + 1;
  const { data, error } = await admin
    .from("tenant_bus_line_stops")
    .insert({
      tenant_id: tenantId,
      bus_line_id: input.bus_line_id,
      direction: input.direction,
      stop_name: stopName,
      city: input.city,
      pickup_note: pickupNote,
      pickup_time: input.pickup_time?.trim() || null,
      stop_order: stopOrder,
      order_index: stopOrder,
      is_manual: true,
      active: true,
    })
    .select("id, pickup_time")
    .single();
  if (error || !data?.id) {
    const isDuplicate = error?.code === "23505" || error?.message?.includes("tenant_bus_line_stops_line_direction_name_pickup_key");
    if (isDuplicate) {
      const canonical = await resolveCanonicalBookingGroupStop(admin, tenantId, input.city, input.direction, pickupNote, input.bus_line_id);
      if (canonical) {
        return ok({ id: canonical.stopId, pickup_time: input.pickup_time?.trim() || canonical.pickupTime || null });
      }
      return err(409, "Fermata gia presente nel catalogo: selezionala dai suggerimenti oppure modifica citta/punto di carico.");
    }
    return err(500, error?.message ?? "Creazione fermata catalogo non riuscita.");
  }
  auditLog({
    event: "booking_group_catalog_stop_created",
    tenantId,
    userId: actor.userId,
    role: actor.role,
    outcome: "created",
    details: { booking_group_id: input.bookingGroupId, bus_line_id: input.bus_line_id, city: input.city, direction: input.direction },
  });
  return ok({ id: data.id as string, pickup_time: (data as { pickup_time: string | null }).pickup_time ?? null });
}

export async function addBookingGroupStop(
  admin: SupabaseClient,
  actor: BgActor,
  input: AddStopInput,
): Promise<BgResult<{ stop: BookingGroupStop }>> {
  const { tenantId, userId, role } = actor;
  const { data: groupRow } = await admin
    .from("booking_groups")
    .select("id, kind")
    .eq("tenant_id", tenantId)
    .eq("id", input.bookingGroupId)
    .maybeSingle();
  if (!groupRow?.id) {
    return err(404, "Gruppo non trovato.");
  }
  const exclusiveLineId = (groupRow as { kind?: string | null }).kind === "bus_exclusive"
    ? await getExclusiveGroupLineId(admin, tenantId)
    : null;
  if ((groupRow as { kind?: string | null }).kind === "bus_exclusive" && input.create_catalog_stop && exclusiveLineId && input.bus_line_id && input.bus_line_id !== exclusiveLineId) {
    return err(400, "Per i gruppi esclusivi la fermata deve stare sulla linea Bus esclusivi gruppi.");
  }
  if ((groupRow as { kind?: string | null }).kind === "bus_exclusive" && input.create_catalog_stop && exclusiveLineId && !input.bus_line_id) {
    input.bus_line_id = exclusiveLineId;
  }
  if (input.stop_id && !(await tenantRowExists(admin, "tenant_bus_line_stops", tenantId, input.stop_id))) {
    return err(400, "Fermata catalogo non valida per il tenant.");
  }
  if (input.pickup_time != null && input.pickup_time.trim() && !/^\d{2}:\d{2}(:\d{2})?$/.test(input.pickup_time.trim())) {
    return err(400, "Orario punto di carico non valido.");
  }
  // FASE A.5 §E — se il chiamante non ha indicato uno stop_id, prova a
  // risolvere la fermata canonica per città+direzione. Match ambiguo/assente
  // → resta undefined (compact() lo omette, come un input.stop_id non
  // fornito), mai un'assegnazione indovinata.
  let stopId: string | undefined = input.stop_id ?? undefined;
  let stopPickupTime: string | null = input.pickup_time?.trim() || null;
  if (!stopId && input.create_catalog_stop) {
    const created = await createManualCatalogStopForBookingGroup(admin, actor, input);
    if (!created.ok) return created;
    stopId = created.data.id;
    stopPickupTime = created.data.pickup_time ?? stopPickupTime;
  }
  if (!stopId) {
    const canonical = await resolveCanonicalBookingGroupStop(admin, tenantId, input.city, input.direction, input.pickup_point, exclusiveLineId);
    if (canonical) {
      stopId = canonical.stopId;
      stopPickupTime = canonical.pickupTime ?? stopPickupTime;
    }
  }

  // FASE A.5.1 §2 — idempotenza: stessa città (normalizzata) + direzione sullo
  // stesso gruppo NON deve mai duplicare la fermata (comando ripetuto,
  // riavvio conversazione dopo scadenza Redis, ecc.). Se la fermata esiste
  // già ma non aveva ancora uno stop_id canonico risolto, lo si arricchisce
  // con un update mirato — mai un secondo insert.
  const targetCity = normalizeCityKey(input.city);
  const targetPickup = normalizeCityKey(input.pickup_point);
  const { data: existingStops } = await admin
    .from("booking_group_stops")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("booking_group_id", input.bookingGroupId)
    .eq("direction", input.direction);
  const existingStop = ((existingStops ?? []) as BookingGroupStop[]).find((s) => {
    if (normalizeCityKey(s.city) !== targetCity) return false;
    if (!targetPickup) return true;
    return normalizeCityKey(s.pickup_point) === targetPickup;
  });
  if (existingStop) {
    if (!existingStop.stop_id && stopId) {
      const { data: enriched, error: enrichError } = await admin
        .from("booking_group_stops")
        .update({ stop_id: stopId, updated_at: new Date().toISOString() })
        .eq("tenant_id", tenantId)
        .eq("id", existingStop.id)
        .select("*")
        .single();
      if (!enrichError && enriched) {
        await syncPlaceholderTimesForBookingGroupStop(admin, tenantId, existingStop.id, stopPickupTime);
        return ok({ stop: enriched as BookingGroupStop });
      }
    }
    await syncPlaceholderTimesForBookingGroupStop(admin, tenantId, existingStop.id, stopPickupTime);
    auditLog({ event: "booking_group_stop_reused", tenantId, userId, role, outcome: "reused", details: { booking_group_id: input.bookingGroupId, city: input.city, direction: input.direction, stop_id: existingStop.id } });
    return ok({ stop: existingStop });
  }

  const insert = compact({
    tenant_id: tenantId,
    booking_group_id: input.bookingGroupId,
    city: input.city,
    pickup_point: input.pickup_point,
    expected_pax: input.expected_pax,
    stop_id: stopId,
    direction: input.direction,
    sort_order: input.sort_order ?? 0,
    notes: input.notes,
    contact_name: input.contact_name,
    contact_phone: input.contact_phone,
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
  input: { bookingGroupId: string; bookingGroupStopId: string; passengers: PassengerRow[]; serviceDate?: string | null; autoAssign?: boolean },
): Promise<BgOutcome<AddPassengersResult>> {
  const { tenantId, userId, role } = actor;

  if (input.serviceDate != null && !isSupportedBookingGroupDate(input.serviceDate)) {
    return err(400, "serviceDate non valida (atteso YYYY-MM-DD).");
  }

  const { data: group } = await admin
    .from("booking_groups")
    .select("id, kind, service_date")
    .eq("tenant_id", tenantId)
    .eq("id", input.bookingGroupId)
    .maybeSingle();
  if (!group?.id) return err(404, "Gruppo non trovato.");

  const { data: stop } = await admin
    .from("booking_group_stops")
    .select("id, booking_group_id, city, pickup_point, direction, stop_id")
    .eq("tenant_id", tenantId)
    .eq("id", input.bookingGroupStopId)
    .maybeSingle();
  if (!stop?.id || stop.booking_group_id !== input.bookingGroupId) {
    return err(404, "Fermata del gruppo non trovata.");
  }

  // FASE A.5 §B — serviceDate esplicito (es. ritorno) vince sulla data del
  // gruppo, che resta il default per l'andata. Nessuna migration: campo
  // opzionale a livello di dominio, non di schema DB.
  const serviceDate = input.serviceDate ?? (group as { service_date: string | null }).service_date;
  if (!serviceDate) {
    return err(422, "Imposta prima la data del gruppo (service_date) oppure passa serviceDate per creare i servizi.");
  }
  if (!isSupportedBookingGroupDate(serviceDate)) {
    return err(400, "serviceDate non valida: usa un anno tra 2020 e 2100.");
  }

  const g = group as { kind: string };
  const isBusKind = g.kind === "bus_exclusive" || g.kind === "bus_group";
  const exclusiveLineId = g.kind === "bus_exclusive" ? await getExclusiveGroupLineId(admin, tenantId) : null;
  const st = stop as { city: string; pickup_point: string | null; direction: "arrival" | "departure"; stop_id: string | null };

  // FASE A.5 §C/§D — orario reale dalla fermata canonica se risolta, mai
  // inventato: se non c'è un pickup_time valido resta il placeholder
  // "00:00", che evaluateBookingGroupServiceReadiness blocca correttamente
  // (missing_time) finché non viene risolto un orario vero.
  let resolvedTime = "00:00";
  let resolvedStopId = st.stop_id;
  if (!resolvedStopId) {
    const canonical = await resolveCanonicalBookingGroupStop(admin, tenantId, st.city, st.direction, st.pickup_point, exclusiveLineId);
    if (canonical) {
      resolvedStopId = canonical.stopId;
      if (canonical.pickupTime?.trim()) resolvedTime = canonical.pickupTime.trim();
      await admin
        .from("booking_group_stops")
        .update({ stop_id: canonical.stopId, updated_at: new Date().toISOString() })
        .eq("tenant_id", tenantId)
        .eq("id", input.bookingGroupStopId);
    }
  }
  if (resolvedStopId && resolvedTime === "00:00") {
    const { data: canonicalStop } = await admin
      .from("tenant_bus_line_stops")
      .select("pickup_time")
      .eq("tenant_id", tenantId)
      .eq("id", resolvedStopId)
      .maybeSingle();
    const pt = (canonicalStop as { pickup_time: string | null } | null)?.pickup_time;
    if (pt && pt.trim()) resolvedTime = pt.trim();
  }

  const buildInsert = (row: PassengerRow) => ({
    tenant_id: tenantId,
    booking_group_id: input.bookingGroupId,
    booking_group_stop_id: input.bookingGroupStopId,
    is_draft: true,
    status: "needs_review" as const,
    date: serviceDate,
    time: resolvedTime,
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
    // Obiettivo C — allineati a `date` fin dalla creazione così le viste che
    // leggono arrival_date/departure_date (non solo `date`) trovano subito il
    // service nel giorno giusto, senza aspettare un patch successivo.
    ...(st.direction === "arrival" ? { arrival_date: serviceDate } : { departure_date: serviceDate }),
    ...(isBusKind ? { booking_service_kind: "bus_city_hotel", service_type_code: "bus_line" } : {}),
  });

  const hotelIds = [...new Set(input.passengers.map((r) => r.hotel_id).filter((v): v is string => Boolean(v)))];
  for (const hid of hotelIds) {
    if (!(await tenantRowExists(admin, "hotels", tenantId, hid))) {
      return err(400, `Hotel ${hid} non valido per il tenant.`);
    }
  }

  // FASE A.5.1 §3 — idempotenza: stesso gruppo+fermata+data+direzione+
  // nominativo (case-insensitive) NON deve mai produrre un secondo service
  // identico (comando Mario ripetuto, o batch reinviato dopo un errore
  // parziale). Il nominativo aggregato usato dal workflow bus
  // ("Gruppo <nome>") rientra qui naturalmente.
  const { data: existingSvcRows } = await admin
    .from("services")
    .select("id, customer_name, pax")
    .eq("tenant_id", tenantId)
    .eq("booking_group_id", input.bookingGroupId)
    .eq("booking_group_stop_id", input.bookingGroupStopId)
    .eq("date", serviceDate)
    .eq("direction", st.direction);
  const existingByName = new Map(
    ((existingSvcRows ?? []) as Array<{ id: string; customer_name: string | null; pax: number | null }>).map((r) => [
      (r.customer_name ?? "").trim().toLowerCase(),
      r,
    ]),
  );

  const created: AddPassengersResult["created"] = [];
  const failed: AddPassengersResult["failed"] = [];
  for (const row of input.passengers) {
    const existing = existingByName.get(row.customer_name.trim().toLowerCase());
    if (existing) {
      created.push({ id: existing.id, customer_name: row.customer_name, pax: Number(existing.pax ?? row.pax) });
      auditLog({
        event: "booking_group_service_reused",
        tenantId, userId, role,
        serviceId: existing.id, outcome: "reused",
        details: { booking_group_id: input.bookingGroupId, booking_group_stop_id: input.bookingGroupStopId, customer_name: row.customer_name },
      });
      continue;
    }
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

  // Obiettivo A — "zero click": appena il gruppo ha almeno un passeggero
  // nuovo, prova a riservare/operativizzare da sola (best effort, mai
  // bloccante — vedi autoAssignBookingGroup). `autoAssign: false` (usato dal
  // tool MCP Mario) preserva il flusso conversazionale esistente invariato.
  if (created.length > 0 && input.autoAssign !== false) {
    try {
      await autoAssignBookingGroup(admin, actor, input.bookingGroupId);
    } catch {
      // best-effort: un fallimento qui non deve mai propagarsi al chiamante.
    }
  }

  const status = failed.length === 0 ? 200 : created.length === 0 ? 500 : 207;
  return {
    ok: failed.length === 0,
    status,
    data: { created, failed, created_count: created.length, failed_count: failed.length },
  };
}

// ─── generate_return_stops_from_arrival (Obiettivo B) ─────────────────────

export type GenerateReturnStopsResult = {
  created_stops: number;
  created_services: number;
  message?: string;
};

/**
 * Azione esplicita, MAI automatica per gruppi storici (prompt "IMPORTANTE":
 * niente copia nascosta per tutti i gruppi esistenti) — genera le fermate di
 * ritorno rispecchiando quelle di andata in ordine INVERSO (Nord->Sud
 * all'andata => Sud->Nord al ritorno), con gli stessi passeggeri/pax,
 * riusando integralmente `addBookingGroupPassengers` per la creazione dei
 * services (stessa idempotenza, stesso readiness gate su orario "00:00" mai
 * inventato, stesso auto-assign best-effort) — nessun secondo motore di
 * creazione services.
 *
 * Precondizioni (tutte richieste, altrimenti blocco esplicito, mai un
 * ritorno inventato):
 *  - return_date valorizzata;
 *  - kind = bus_exclusive;
 *  - esistono fermate arrival con expected_pax > 0;
 *  - NESSUNA fermata departure già esistente (idempotente: se già generate,
 *    no-op con created_stops:0, mai un duplicato).
 */
export async function generateReturnStopsFromArrival(
  admin: SupabaseClient,
  actor: BgActor,
  bookingGroupId: string,
): Promise<BgOutcome<GenerateReturnStopsResult>> {
  const { tenantId, userId, role } = actor;
  const { data: group } = await admin
    .from("booking_groups")
    .select("id, kind, return_date, status")
    .eq("tenant_id", tenantId)
    .eq("id", bookingGroupId)
    .maybeSingle();
  if (!group?.id) return err(404, "Gruppo non trovato.");
  const g = group as { kind: string | null; return_date: string | null; status: string | null };
  if (g.status === "cancelled") return err(422, "Gruppo cancellato: nessun ritorno da generare.");
  if (!g.return_date) return err(422, "return_date mancante: impossibile generare il ritorno.");
  if (g.kind !== "bus_exclusive") return err(422, "Generazione automatica del ritorno disponibile solo per gruppi bus_exclusive.");

  const { data: stopRows } = await admin
    .from("booking_group_stops")
    .select("id, city, pickup_point, direction, expected_pax, notes")
    .eq("tenant_id", tenantId)
    .eq("booking_group_id", bookingGroupId)
    .order("created_at", { ascending: true });
  const stops = (stopRows ?? []) as Array<{ id: string; city: string; pickup_point: string | null; direction: string | null; expected_pax: number | null; notes: string | null }>;
  const arrivalStops = stops.filter((s) => s.direction === "arrival");
  const departureStops = stops.filter((s) => s.direction === "departure");

  if (arrivalStops.length === 0) {
    return err(422, "Nessuna fermata andata da cui generare il ritorno.");
  }
  if (arrivalStops.some((s) => !(Number(s.expected_pax) > 0))) {
    return err(422, "Alcune fermate andata non hanno pax validi: impossibile generare il ritorno.");
  }

  const { data: arrivalServiceRows } = await admin
    .from("services")
    .select("id, customer_name, pax, phone, hotel_id, notes, booking_group_stop_id, status")
    .eq("tenant_id", tenantId)
    .eq("booking_group_id", bookingGroupId)
    .eq("direction", "arrival");
  const activeArrivalServices = ((arrivalServiceRows ?? []) as Array<{
    id: string; customer_name: string; pax: number; phone: string | null; hotel_id: string | null; notes: string | null; booking_group_stop_id: string | null; status: string | null;
  }>).filter((s) => s.status !== "cancelled");
  const servicesByStopId = new Map<string, typeof activeArrivalServices>();
  for (const svc of activeArrivalServices) {
    if (!svc.booking_group_stop_id) continue;
    const list = servicesByStopId.get(svc.booking_group_stop_id) ?? [];
    list.push(svc);
    servicesByStopId.set(svc.booking_group_stop_id, list);
  }

  // Regola Nord<->Sud del prompt: stesse fermate dell'andata, ordine
  // INVERTITO — mai un ordine geografico reinventato, solo il reverse
  // dell'ordine di inserimento andata.
  const reversedArrivalStops = [...arrivalStops].reverse();

  // Obiettivo E (prompt "ALLINEARE TUTTE LE VISTE"): idempotenza PER FERMATA,
  // non più per l'intero ritorno — un ritorno parziale (es. mancava solo
  // MAROTTA per un errore in un run precedente) deve poter essere completato
  // con SOLO la fermata mancante, mai un no-op totale che lascia la card
  // gruppo bloccata a 20/38 pax, e mai un duplicato delle fermate già presenti.
  const departureStopKey = (city: string, pickup: string | null) => `${normalizeCityKey(city)}|${normalizeCityKey(pickup)}`;
  const existingDepartureByKey = new Map(departureStops.map((s) => [departureStopKey(s.city, s.pickup_point), s]));

  let createdStops = 0;
  let createdServices = 0;
  let reusedStops = 0;
  for (const stop of reversedArrivalStops) {
    const key = departureStopKey(stop.city, stop.pickup_point);
    let targetStopId = existingDepartureByKey.get(key)?.id;
    if (!targetStopId) {
      const { data: newStop, error: stopError } = await admin
        .from("booking_group_stops")
        .insert({
          tenant_id: tenantId,
          booking_group_id: bookingGroupId,
          city: stop.city,
          pickup_point: stop.pickup_point,
          direction: "departure",
          expected_pax: stop.expected_pax,
          notes: stop.notes,
        })
        .select("id")
        .single();
      if (stopError || !newStop?.id) continue;
      targetStopId = newStop.id as string;
      createdStops++;
    } else {
      reusedStops++;
    }

    const passengers: PassengerRow[] = (servicesByStopId.get(stop.id) ?? []).map((svc) => ({
      customer_name: svc.customer_name,
      pax: svc.pax,
      phone: svc.phone,
      hotel_id: svc.hotel_id,
      notes: svc.notes,
    }));
    if (passengers.length === 0) continue;

    // addBookingGroupPassengers e' gia' idempotente per nominativo (§3): su
    // una fermata di ritorno gia' esistente e completa non crea nulla di
    // nuovo, su una fermata riusata ma senza services li completa.
    const addResult = await addBookingGroupPassengers(admin, actor, {
      bookingGroupId,
      bookingGroupStopId: targetStopId,
      passengers,
      serviceDate: g.return_date,
    });
    if (addResult.ok) createdServices += addResult.data.created_count;
  }

  if (createdStops === 0 && createdServices === 0 && reusedStops > 0) {
    return ok({ created_stops: 0, created_services: 0, message: "Fermate ritorno già esistenti: nessuna azione." });
  }

  auditLog({
    event: "booking_group_return_stops_generated",
    tenantId, userId, role,
    outcome: "created",
    details: { booking_group_id: bookingGroupId, created_stops: createdStops, created_services: createdServices },
  });

  return ok({ created_stops: createdStops, created_services: createdServices });
}

// ─── remove_group_passenger ───────────────────────────────────────────────
// Elimina UN SOLO passeggero/nominativo (service) da una fermata del gruppo.
// Draft/pre-operativo (is_draft=true, status='needs_review') -> hard delete
// mirato: non ancora una prenotazione reale, nessuna allocazione/assignment
// da pulire. Gia' operativo -> MAI hard delete: riusa la stessa RPC atomica
// gia' usata da POST /api/ops/services/[id]/cancel (cancel_service_practice,
// migration 0245: status='cancelled' + assignments + tenant_bus_allocations +
// bus_ischia_dist_allocations + status_events/ops_audit_events), poi
// scollega dal gruppo (booking_group_id/booking_group_stop_id = null) cosi'
// sparisce dalla lista nominativi di loadGroupDetail.

export type RemoveGroupPassengerInput = {
  bookingGroupId: string;
  bookingGroupStopId: string;
  serviceId: string;
};

export type RemoveGroupPassengerResult = {
  removed: boolean;
  mode: "deleted" | "cancelled" | "already_removed";
  serviceId: string;
};

export async function removeGroupPassenger(
  admin: SupabaseClient,
  actor: BgActor,
  input: RemoveGroupPassengerInput,
): Promise<BgResult<RemoveGroupPassengerResult>> {
  const { tenantId, userId, role } = actor;

  const { data: svc } = await admin
    .from("services")
    .select("id, booking_group_id, booking_group_stop_id, is_draft, status, customer_name, pax")
    .eq("tenant_id", tenantId)
    .eq("id", input.serviceId)
    .maybeSingle();

  // Idempotenza: doppio click o gia' rimosso da un'altra richiesta -> non
  // e' un errore, semplicemente non c'e' piu' nulla da rimuovere.
  if (!svc) {
    return ok({ removed: false, mode: "already_removed", serviceId: input.serviceId });
  }
  const row = svc as {
    id: string; booking_group_id: string | null; booking_group_stop_id: string | null;
    is_draft: boolean | null; status: string | null; customer_name: string | null; pax: number | null;
  };
  if (row.booking_group_id !== input.bookingGroupId) {
    return err(404, "Il passeggero non appartiene a questo gruppo.");
  }
  if (row.booking_group_stop_id !== input.bookingGroupStopId) {
    return err(404, "Il passeggero non appartiene a questa fermata.");
  }

  const isDraft = row.is_draft === true && row.status === "needs_review";

  if (isDraft) {
    const { error } = await admin
      .from("services")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("id", input.serviceId);
    if (error) return err(500, error.message);
    auditLog({
      event: "booking_group_passenger_deleted",
      tenantId, userId, role,
      serviceId: input.serviceId, outcome: "deleted",
      details: { booking_group_id: input.bookingGroupId, booking_group_stop_id: input.bookingGroupStopId, customer_name: row.customer_name, pax: row.pax },
    });
    return ok({ removed: true, mode: "deleted", serviceId: input.serviceId });
  }

  const { error: rpcError } = await admin.rpc("cancel_service_practice", {
    p_service_id: input.serviceId,
    p_tenant_id: tenantId,
    p_scope: "leg",
    p_reason: "Rimosso dal gruppo prenotazione",
    p_note: null,
    p_user_id: userId,
  });
  if (rpcError) return err(500, rpcError.message);

  const { error: unlinkError } = await admin
    .from("services")
    .update({ booking_group_id: null, booking_group_stop_id: null })
    .eq("tenant_id", tenantId)
    .eq("id", input.serviceId);
  if (unlinkError) return err(500, unlinkError.message);

  auditLog({
    event: "booking_group_passenger_cancelled",
    tenantId, userId, role,
    serviceId: input.serviceId, outcome: "cancelled",
    details: { booking_group_id: input.bookingGroupId, booking_group_stop_id: input.bookingGroupStopId, customer_name: row.customer_name, pax: row.pax },
  });
  return ok({ removed: true, mode: "cancelled", serviceId: input.serviceId });
}

// ─── update_group_passenger (Obiettivo D, prompt "FIX MIRATO — GIACOMONI") ─
// Corregge un nominativo/nucleo sbagliato SENZA cancellare e ricreare (mai un
// nuovo service, mai un delete). Per un service draft di gruppo consente
// customer_name/pax/phone/notes; per un service GIA' operativo (is_draft
// false) resta conservativo — mai pax/fermata (romperebbe capienza bus/
// allocazione gia' fatta), solo customer_name/phone/notes.

export type UpdateGroupPassengerInput = {
  bookingGroupId: string;
  bookingGroupStopId: string;
  serviceId: string;
  customer_name?: string;
  pax?: number;
  phone?: string | null;
  notes?: string | null;
};

export type UpdateGroupPassengerResult = {
  updated: boolean;
  serviceId: string;
};

export async function updateGroupPassenger(
  admin: SupabaseClient,
  actor: BgActor,
  input: UpdateGroupPassengerInput,
): Promise<BgResult<UpdateGroupPassengerResult>> {
  const { tenantId, userId, role } = actor;

  const { data: svc } = await admin
    .from("services")
    .select("id, booking_group_id, booking_group_stop_id, is_draft, status, customer_name, pax")
    .eq("tenant_id", tenantId)
    .eq("id", input.serviceId)
    .maybeSingle();
  if (!svc) return err(404, "Passeggero non trovato.");
  const row = svc as {
    id: string; booking_group_id: string | null; booking_group_stop_id: string | null;
    is_draft: boolean | null; status: string | null; customer_name: string | null; pax: number | null;
  };
  if (row.booking_group_id !== input.bookingGroupId) {
    return err(404, "Il passeggero non appartiene a questo gruppo.");
  }
  if (row.booking_group_stop_id !== input.bookingGroupStopId) {
    return err(404, "Il passeggero non appartiene a questa fermata.");
  }
  if (row.status === "cancelled") {
    return err(422, "Passeggero annullato: nessuna modifica possibile.");
  }

  const isDraft = row.is_draft === true;
  if (!isDraft && input.pax != null && input.pax !== row.pax) {
    return err(422, "Il nominativo è già operativo: il numero pax non è modificabile da qui (romperebbe capienza/allocazione bus già fatta).");
  }

  const patch = compact({
    customer_name: input.customer_name?.trim() || undefined,
    pax: isDraft ? input.pax : undefined,
    phone: input.phone !== undefined ? (input.phone ?? "").trim() : undefined,
    notes: input.notes !== undefined ? (input.notes ?? "").trim() : undefined,
    updated_at: new Date().toISOString(),
  });
  if (Object.keys(patch).length <= 1) {
    return err(400, "Nessun campo da aggiornare.");
  }

  const { error } = await admin
    .from("services")
    .update(patch)
    .eq("tenant_id", tenantId)
    .eq("id", input.serviceId);
  if (error) return err(500, error.message);

  auditLog({
    event: "booking_group_passenger_updated",
    tenantId, userId, role,
    serviceId: input.serviceId, outcome: "updated",
    details: { booking_group_id: input.bookingGroupId, booking_group_stop_id: input.bookingGroupStopId, fields: Object.keys(patch).filter((k) => k !== "updated_at") },
  });
  return ok({ updated: true, serviceId: input.serviceId });
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
  // NB: la data di un leg (soprattutto il ritorno) puo' legittimamente non
  // essere mai scritta su booking_groups.return_date — FASE A.5 §B lascia la
  // serviceDate un override puramente a livello di service, senza migration
  // che la rispecchi sul gruppo. Quindi qui NON si puo' validare service_date
  // contro service_date/return_date del gruppo (rotto: bloccherebbe reservation
  // di ritorno legittime). La prevenzione della reservation su data orfana
  // (bug osservato su GIACOMONI: reservation sulla return_date per un gruppo
  // con solo fermate di andata) vive invece in `autoAssignBookingGroup`, che
  // deriva sempre la data corretta da gruppo+fermate prima di riservare.
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

// ─── auto-assign "zero click" (bus_exclusive) ─────────────────────────────

export type AutoAssignBookingGroupResult = {
  attempted: boolean;
  reservations_created: Array<{ service_date: string; bus_unit_id: string; bus_label: string }>;
  blocked: Array<{ service_date: string; reason: string; orphan_conflict?: OrphanReservationConflict }>;
  operationalize?: OperationalizeResult;
};

/**
 * Zero-click per gruppi bus_exclusive (prompt "auto-assegnazione bus
 * network"): appena il gruppo ha date + fermate (quindi pax attesi noti per
 * direzione), sceglie da solo un bus esclusivo libero con capienza
 * sufficiente per ciascuna data richiesta (andata/ritorno possono avere bus
 * diversi), lo riserva e operativizza il gruppo — riusa integralmente
 * `findAvailableBusesForGroup` + `reserveBookingGroupBus` +
 * `operationalizeBookingGroup`, NESSUN nuovo motore di allocazione/SQL.
 * Non tocca mai una reservation già esistente per quella data (una scelta
 * fatta a mano o da un run precedente resta autorevole). Se nessun bus ha
 * capienza libera, o i pax attesi non sono ancora noti, resta bloccato con
 * un motivo esplicito — mai un bus scelto a caso.
 *
 * Pensata per essere chiamata "best effort" da addBookingGroupPassengers e
 * da patchBookingGroup (quando si completano fermate/pax o si sistemano le
 * date): un suo fallimento non deve MAI bloccare l'operazione chiamante.
 */
export async function autoAssignBookingGroup(
  admin: SupabaseClient,
  actor: BgActor,
  bookingGroupId: string,
): Promise<AutoAssignBookingGroupResult> {
  const { tenantId } = actor;
  const result: AutoAssignBookingGroupResult = { attempted: false, reservations_created: [], blocked: [] };

  const { data: group } = await admin
    .from("booking_groups")
    .select("id, kind, status, service_date, return_date, expected_pax")
    .eq("tenant_id", tenantId)
    .eq("id", bookingGroupId)
    .maybeSingle();
  if (!group || group.status === "cancelled") return result;
  const g = group as { kind: string; status: string; service_date: string | null; return_date: string | null; expected_pax: number | null };

  if (g.kind === "bus_exclusive") {
    const { data: stops } = await admin
      .from("booking_group_stops")
      .select("direction")
      .eq("tenant_id", tenantId)
      .eq("booking_group_id", bookingGroupId);
    const directions = new Set(((stops ?? []) as Array<{ direction: string | null }>).map((s) => s.direction));
    const neededDates = [
      ...(directions.has("arrival") && g.service_date ? [g.service_date] : []),
      ...(directions.has("departure") && g.return_date ? [g.return_date] : []),
    ];

    if (neededDates.length > 0) {
      result.attempted = true;
      const { data: existingReservations } = await admin
        .from("booking_group_bus_reservations")
        .select("service_date, exclusive")
        .eq("tenant_id", tenantId)
        .eq("booking_group_id", bookingGroupId);
      const reservedDates = new Set(
        ((existingReservations ?? []) as Array<{ service_date: string; exclusive: boolean | null }>)
          .filter((r) => r.exclusive)
          .map((r) => r.service_date),
      );
      const requiredCapacity = Number(g.expected_pax ?? 0);
      for (const serviceDate of neededDates) {
        if (reservedDates.has(serviceDate)) continue;
        if (requiredCapacity <= 0) {
          result.blocked.push({ service_date: serviceDate, reason: "Pax previsti del gruppo mancanti o a zero." });
          continue;
        }
        const candidates = await findAvailableBusesForGroup(admin, tenantId, {
          serviceDate,
          requiredCapacity,
          exclusiveOnly: true,
        });
        if (candidates.length === 0) {
          const { reason, orphanConflict } = await describeNoExclusiveBusReason(admin, tenantId, serviceDate, requiredCapacity);
          result.blocked.push({ service_date: serviceDate, reason, orphan_conflict: orphanConflict });
          continue;
        }
        // FIX FINALE bus_exclusive (Obiettivo A): con più bus esclusivi
        // ugualmente liberi e capienti non si resta bloccati in attesa di
        // conferma manuale — `findAvailableBusesForGroup` ha già escluso
        // qualunque bus con una reservation exclusive attiva per la data,
        // quindi ogni candidato qui è realmente libero. Si sceglie il primo
        // in ordine deterministico (capacità -> sort_order -> label -> id,
        // vedi findAvailableBusesForGroup) e lo si riserva subito in
        // esclusiva: nessun altro gruppo/servizio potrà più finirci (vedi
        // migration 0269, enforcement lato allocate_bus_service/
        // move_bus_allocation).
        const chosen = candidates[0]!;
        const reserved = await reserveBookingGroupBus(admin, actor, {
          bookingGroupId,
          busUnitId: chosen.id,
          service_date: serviceDate,
          reserved_pax: requiredCapacity,
          exclusive: true,
        });
        if (!reserved.ok) {
          result.blocked.push({ service_date: serviceDate, reason: reserved.error });
          continue;
        }
        result.reservations_created.push({ service_date: serviceDate, bus_unit_id: chosen.id, bus_label: chosen.label });
      }
    }
  }

  try {
    const outcome = await operationalizeBookingGroup(admin, actor, { bookingGroupId });
    if ("data" in outcome) result.operationalize = outcome.data;
  } catch {
    // best effort: un fallimento qui non deve mai propagarsi al chiamante.
  }
  return result;
}

// ─── FASE A.5.1 §20 — reconciliation: stato reale dal DB (fonte di verità) ─

export type OperationalBusGroupNextStep =
  | "create_group"
  | "add_outbound_stop"
  | "add_outbound_service"
  | "add_return_stop"
  | "add_return_service"
  | "reserve_bus"
  | "operationalize"
  | "blocked"
  | "completed";

export type OperationalBusGroupState = {
  groupExists: boolean;
  group: BookingGroup | null;
  arrivalStops: BookingGroupStop[];
  departureStops: BookingGroupStop[];
  /** Fermate arrival/departure che esistono ma non hanno ancora un service collegato. */
  arrivalStopsMissingService: BookingGroupStop[];
  departureStopsMissingService: BookingGroupStop[];
  reservations: BookingGroupBusReservation[];
  allocations: Array<{ service_id: string; bus_unit_id: string }>;
  readiness: OperationalizeViewShape | null;
  nextStep: OperationalBusGroupNextStep;
};

/**
 * FASE A.5.1 §19/§20 — unica fonte di verità sullo stato operativo di un
 * gruppo bus: legge SEMPRE dal DB (mai da Redis/sessione), batch (nessuna
 * query per fermata/service, §24). Usata sia per riprendere un workflow dopo
 * scadenza sessione (§19) sia per decidere se un comando ripetuto deve
 * riusare un gruppo esistente invece di duplicarlo (§1).
 *
 * `expectReturn`/`returnDate`: il chiamante (Mario) sa se il workflow
 * richiede anche un ritorno — questa funzione NON lo indovina dal solo stato
 * DB (un gruppo può legittimamente essere solo andata).
 */
export async function inspectOperationalBusGroupState(
  admin: SupabaseClient,
  tenantId: string,
  bookingGroupId: string,
  opts: { expectReturn?: boolean; returnDate?: string | null } = {},
): Promise<OperationalBusGroupState> {
  const detail = await loadGroupDetail(admin, tenantId, bookingGroupId);
  if (!detail) {
    return {
      groupExists: false, group: null, arrivalStops: [], departureStops: [],
      arrivalStopsMissingService: [], departureStopsMissingService: [],
      reservations: [], allocations: [], readiness: null, nextStep: "create_group",
    };
  }

  const arrivalStops = detail.stops.filter((s) => s.direction === "arrival");
  const departureStops = detail.stops.filter((s) => s.direction === "departure");
  const servicedStopIds = new Set(detail.services.map((s) => s.booking_group_stop_id).filter((v): v is string => Boolean(v)));
  const arrivalStopsMissingService = arrivalStops.filter((s) => !servicedStopIds.has(s.id));
  const departureStopsMissingService = departureStops.filter((s) => !servicedStopIds.has(s.id));

  const readinessRes = await previewOperationalizeBookingGroup(admin, tenantId, bookingGroupId);
  const readiness = readinessRes.ok ? readinessRes.data : null;

  const serviceIds = detail.services.map((s) => s.id);
  let allocations: Array<{ service_id: string; bus_unit_id: string }> = [];
  if (serviceIds.length > 0) {
    const { data } = await admin.from("tenant_bus_allocations").select("service_id, bus_unit_id").eq("tenant_id", tenantId).in("service_id", serviceIds);
    allocations = (data ?? []) as Array<{ service_id: string; bus_unit_id: string }>;
  }

  const expectReturn = Boolean(opts.expectReturn);
  let nextStep: OperationalBusGroupNextStep;
  if (arrivalStops.length === 0) {
    nextStep = "add_outbound_stop";
  } else if (arrivalStopsMissingService.length > 0) {
    nextStep = "add_outbound_service";
  } else if (expectReturn && departureStops.length === 0) {
    nextStep = "add_return_stop";
  } else if (expectReturn && departureStopsMissingService.length > 0) {
    nextStep = "add_return_service";
  } else if (
    detail.group.kind === "bus_exclusive" &&
    [detail.group.service_date, ...(expectReturn && opts.returnDate ? [opts.returnDate] : [])]
      .filter((d): d is string => Boolean(d))
      .some((d) => !detail.bus_reservations.some((r) => r.service_date === d))
  ) {
    // FASE A.5.1 §17 — andata e ritorno possono richiedere reservation
    // separate: manca lo step finché anche solo UNA delle date attese non ha
    // una reservation.
    nextStep = "reserve_bus";
  } else if (readiness && readiness.services_ready > 0) {
    nextStep = "operationalize";
  } else if (readiness && readiness.services_blocked > 0 && readiness.services_ready === 0 && readiness.services_already_operational === 0) {
    nextStep = "blocked";
  } else {
    nextStep = "completed";
  }

  return {
    groupExists: true, group: detail.group, arrivalStops, departureStops,
    arrivalStopsMissingService, departureStopsMissingService,
    reservations: detail.bus_reservations, allocations, readiness, nextStep,
  };
}

// ─── FASE A.5.1 §13 — disponibilità mezzi (READ, tenant-scoped) ───────────

export type AvailableBus = { id: string; label: string; capacity: number; tag: string | null };

/**
 * Bus tenant-scoped compatibili con una prenotazione: capacità sufficiente,
 * non chiusi, non già riservati IN ESCLUSIVA per la stessa data da un altro
 * gruppo. FASE A.5.1 §16 — bus con capacità insufficiente non compaiono mai
 * nell'elenco: Mario non può proporli, a monte, non serve un blocco a valle.
 */
export async function findAvailableBusesForGroup(
  admin: SupabaseClient,
  tenantId: string,
  input: { serviceDate: string; requiredCapacity: number; exclusiveOnly?: boolean },
): Promise<AvailableBus[]> {
  const [{ data: units }, { data: reservations }, { data: exclusiveLines }] = await Promise.all([
    admin.from("tenant_bus_units").select("id, bus_line_id, label, capacity, tag, status, manual_close, active, sort_order").eq("tenant_id", tenantId).eq("active", true),
    admin.from("booking_group_bus_reservations").select("bus_unit_id, exclusive").eq("tenant_id", tenantId).eq("service_date", input.serviceDate),
    input.exclusiveOnly
      ? admin
          .from("tenant_bus_lines")
          .select("id, code, family_code")
          .eq("tenant_id", tenantId)
          .eq("active", true)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const exclusiveLineIds = new Set(
    ((exclusiveLines ?? []) as Array<{ id: string; code?: string | null; family_code?: string | null }>)
      .filter((line) => line.code === EXCLUSIVE_GROUP_LINE_CODE || line.family_code === EXCLUSIVE_GROUP_LINE_CODE)
      .map((line) => line.id),
  );
  const exclusivelyReserved = new Set(
    ((reservations ?? []) as Array<{ bus_unit_id: string; exclusive: boolean | null }>).filter((r) => r.exclusive).map((r) => r.bus_unit_id),
  );
  const rows = (units ?? []) as Array<{ id: string; bus_line_id: string | null; label: string; capacity: number; tag: string | null; status: string | null; manual_close: boolean | null; sort_order: number | null }>;
  return rows
    .filter((u) => !input.exclusiveOnly || (u.bus_line_id && exclusiveLineIds.has(u.bus_line_id)))
    .filter((u) => u.capacity >= input.requiredCapacity)
    .filter((u) => u.status !== "closed" && u.status !== "completed" && !u.manual_close)
    .filter((u) => !exclusivelyReserved.has(u.id))
    .map((u) => ({ id: u.id, label: u.label, capacity: u.capacity, tag: u.tag ?? null, sortOrder: u.sort_order ?? 0 }))
    // Ordinamento stabile e deterministico (Obiettivo A): capacità minima
    // sufficiente prima, poi sort_order del catalogo bus, poi label/id come
    // tiebreak finale — mai un ordine casuale tra candidati altrimenti
    // equivalenti.
    .sort((a, b) => a.capacity - b.capacity || a.sortOrder - b.sortOrder || a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
    .map(({ id, label, capacity, tag }) => ({ id, label, capacity, tag }));
}

// Obiettivo C/D (Prompt "GIACOMONI bus exclusive"): quando un bus altrimenti
// compatibile è bloccato da UN SOLO altro gruppo che ha 0 services attivi
// (l'orfano — mai un dato inventato: 0 services è un fatto verificabile), lo
// segnala come conflitto strutturato così la UI può proporre "Collega
// reservation al gruppo reale" invece di un generico "nessun bus
// disponibile". Mai eseguito automaticamente: solo diagnosi.
export type OrphanReservationConflict = {
  busUnitId: string;
  busLabel: string;
  orphanBookingGroupId: string;
  orphanBookingGroupName: string;
  reservationId: string;
};

// Stessa identica select di findAvailableBusesForGroup, riusata solo per
// diagnosticare il motivo esatto — non introduce un secondo motore di scelta
// bus.
async function describeNoExclusiveBusReason(
  admin: SupabaseClient,
  tenantId: string,
  serviceDate: string,
  requiredCapacity: number,
): Promise<{ reason: string; orphanConflict?: OrphanReservationConflict }> {
  const [{ data: units }, { data: reservations }, { data: exclusiveLines }] = await Promise.all([
    admin.from("tenant_bus_units").select("id, bus_line_id, label, capacity, status, manual_close").eq("tenant_id", tenantId).eq("active", true),
    admin.from("booking_group_bus_reservations").select("id, bus_unit_id, exclusive, booking_group_id").eq("tenant_id", tenantId).eq("service_date", serviceDate),
    admin.from("tenant_bus_lines").select("id, code, family_code").eq("tenant_id", tenantId).eq("active", true),
  ]);
  const exclusiveLineIds = new Set(
    ((exclusiveLines ?? []) as Array<{ id: string; code?: string | null; family_code?: string | null }>)
      .filter((line) => line.code === EXCLUSIVE_GROUP_LINE_CODE || line.family_code === EXCLUSIVE_GROUP_LINE_CODE)
      .map((line) => line.id),
  );
  const capableUnits = ((units ?? []) as Array<{ id: string; bus_line_id: string | null; label: string; capacity: number; status: string | null; manual_close: boolean | null }>)
    .filter((u) => u.bus_line_id && exclusiveLineIds.has(u.bus_line_id))
    .filter((u) => u.capacity >= requiredCapacity)
    .filter((u) => u.status !== "closed" && u.status !== "completed" && !u.manual_close);
  if (capableUnits.length === 0) {
    return { reason: "Nessun bus esclusivo con capienza sufficiente per quella data." };
  }
  const reservationsByUnit = new Map(
    ((reservations ?? []) as Array<{ id: string; bus_unit_id: string; exclusive: boolean | null; booking_group_id: string }>)
      .filter((r) => r.exclusive)
      .map((r) => [r.bus_unit_id, r]),
  );
  const blocked = capableUnits.filter((u) => reservationsByUnit.has(u.id));
  if (blocked.length === 0 || blocked.length !== capableUnits.length) {
    // O nessuno è bloccato da reservation (capienza insufficiente altrove)
    // o solo alcuni lo sono ma resta comunque un candidato libero — non
    // dovrebbe capitare (findAvailableBusesForGroup li avrebbe trovati),
    // messaggio generico invariato per sicurezza.
    return { reason: "Nessun bus esclusivo libero con capienza sufficiente per quella data." };
  }
  const otherGroupIds = Array.from(new Set(blocked.map((u) => reservationsByUnit.get(u.id)!.booking_group_id)));
  const { data: otherGroups } = await admin.from("booking_groups").select("id, name").in("id", otherGroupIds);
  const otherGroupRows = (otherGroups ?? []) as Array<{ id: string; name: string }>;
  const nameById = new Map(otherGroupRows.map((g) => [g.id, g.name]));
  const details = blocked.map((u) => `${u.label} già riservato da ${nameById.get(reservationsByUnit.get(u.id)!.booking_group_id) ?? "un altro gruppo"}`);
  const reason = details.join(" · ");

  // Conflitto orfano riconoscibile in modo sicuro SOLO se: un unico bus
  // bloccante, un unico altro gruppo coinvolto, e quel gruppo ha 0 services
  // attivi (mai un'euristica sul nome — il fatto "0 services" è verificabile
  // e sufficiente da solo).
  if (blocked.length === 1 && otherGroupIds.length === 1) {
    const orphanId = otherGroupIds[0];
    const { count } = await admin
      .from("services")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("booking_group_id", orphanId)
      .neq("status", "cancelled");
    if ((count ?? 0) === 0) {
      const unit = blocked[0];
      const reservation = reservationsByUnit.get(unit.id)!;
      return {
        reason,
        orphanConflict: {
          busUnitId: unit.id,
          busLabel: unit.label,
          orphanBookingGroupId: orphanId,
          orphanBookingGroupName: nameById.get(orphanId) ?? "gruppo orfano",
          reservationId: reservation.id,
        },
      };
    }
  }
  return { reason };
}

function normalizeGroupNameForCompare(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\bgruppo\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export type LinkOrphanReservationResult = {
  linked: boolean;
  autoAssign?: AutoAssignBookingGroupResult;
};

/**
 * Obiettivo C: azione ESPLICITA (mai automatica) — sposta UNA reservation
 * dal gruppo orfano al gruppo reale, solo se tutte le condizioni di
 * sicurezza sono verificate qui stesso (mai fidarsi del solo input
 * dell'operatore). Non tocca services, non tocca il gruppo orfano stesso,
 * non lo cancella — sposta solo `booking_group_bus_reservations.booking_group_id`
 * di UNA riga specifica.
 */
export async function linkOrphanReservationToGroup(
  admin: SupabaseClient,
  actor: BgActor,
  input: { reservationId: string; orphanBookingGroupId: string; realBookingGroupId: string },
): Promise<BgOutcome<LinkOrphanReservationResult>> {
  const { tenantId, userId, role } = actor;

  const { data: reservation } = await admin
    .from("booking_group_bus_reservations")
    .select("id, booking_group_id, bus_unit_id, service_date, exclusive, reserved_pax")
    .eq("tenant_id", tenantId)
    .eq("id", input.reservationId)
    .maybeSingle();
  if (!reservation) return err(404, "Reservation non trovata.");
  if (reservation.booking_group_id !== input.orphanBookingGroupId) {
    return err(409, "La reservation non appartiene più al gruppo orfano indicato: ricontrolla prima di ripetere.");
  }

  const { data: groups } = await admin
    .from("booking_groups")
    .select("id, kind, status")
    .eq("tenant_id", tenantId)
    .in("id", [input.orphanBookingGroupId, input.realBookingGroupId]);
  const groupRows = (groups ?? []) as Array<{ id: string; kind: string | null; status: string | null }>;
  const orphan = groupRows.find((g) => g.id === input.orphanBookingGroupId);
  const real = groupRows.find((g) => g.id === input.realBookingGroupId);
  if (!orphan || !real) return err(404, "Gruppo orfano o gruppo reale non trovato per questo tenant.");
  if (orphan.kind !== "bus_exclusive" || real.kind !== "bus_exclusive") {
    return err(422, "Il collegamento è consentito solo tra gruppi bus_exclusive.");
  }
  if (real.status === "cancelled") return err(422, "Il gruppo reale è cancellato.");

  const { count: orphanServiceCount } = await admin
    .from("services")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("booking_group_id", input.orphanBookingGroupId)
    .neq("status", "cancelled");
  if ((orphanServiceCount ?? 0) > 0) {
    return err(422, "Il gruppo orfano ha services attivi collegati: non è sicuro considerarlo orfano.");
  }

  const { count: realServiceCount } = await admin
    .from("services")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("booking_group_id", input.realBookingGroupId)
    .neq("status", "cancelled");
  if ((realServiceCount ?? 0) === 0) {
    return err(422, "Il gruppo reale non ha services attivi: nulla da assegnare.");
  }

  const { data: nameRows } = await admin
    .from("booking_groups")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .in("id", [input.orphanBookingGroupId, input.realBookingGroupId]);
  const namesById = new Map(((nameRows ?? []) as Array<{ id: string; name: string }>).map((g) => [g.id, g.name]));
  const orphanName = normalizeGroupNameForCompare(namesById.get(input.orphanBookingGroupId) ?? "");
  const realName = normalizeGroupNameForCompare(namesById.get(input.realBookingGroupId) ?? "");
  if (!orphanName || !realName || (orphanName !== realName && !orphanName.includes(realName) && !realName.includes(orphanName))) {
    return err(422, "I nomi dei due gruppi non sono abbastanza simili per collegarli in automatico: verifica manualmente.");
  }

  const { error: updateError } = await admin
    .from("booking_group_bus_reservations")
    .update({ booking_group_id: input.realBookingGroupId, updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", input.reservationId);
  if (updateError) return err(500, updateError.message);

  auditLog({
    event: "booking_group_orphan_reservation_linked",
    tenantId, userId, role,
    outcome: "linked",
    details: { reservation_id: input.reservationId, orphan_booking_group_id: input.orphanBookingGroupId, real_booking_group_id: input.realBookingGroupId, bus_unit_id: reservation.bus_unit_id, service_date: reservation.service_date },
  });

  let autoAssign: AutoAssignBookingGroupResult | undefined;
  try {
    autoAssign = await autoAssignBookingGroup(admin, actor, input.realBookingGroupId);
  } catch {
    // best-effort: il collegamento reservation resta valido anche se questo fallisce.
  }

  return ok({ linked: true, autoAssign });
}

// ─── FASE A.5.1 §15 — allocazione su bus RISERVATO (predeterminato) ───────

export type ReservedAllocationResult =
  | { ok: true; allocated: true; serviceId: string; busUnitId: string; busLabel: string; stopId: string; stopName: string; pax: number }
  | { ok: true; allocated: false; serviceId: string; reason: string };

/**
 * Alloca un service verso un bus_unit_id GIÀ DETERMINATO da una reservation
 * (gruppo bus_exclusive), riusando l'RPC `allocate_bus_service` esistente —
 * NON un nuovo motore di allocazione, NON SQL duplicato. A differenza di
 * `autoAllocateBusService` (che sceglie il primo bus di linea con posto
 * libero) qui il bus è vincolato: se non ha capienza sufficiente o la
 * fermata canonica non è risolvibile, non alloca (mai un fallback silenzioso
 * su un bus diverso da quello riservato).
 */
export async function allocateReservedBookingGroupBusService(
  admin: SupabaseClient,
  params: { tenantId: string; serviceId: string; busUnitId: string; userId: string },
): Promise<ReservedAllocationResult> {
  const { tenantId, serviceId, busUnitId, userId } = params;

  const existingAlloc = await admin.from("tenant_bus_allocations").select("id").eq("tenant_id", tenantId).eq("service_id", serviceId).limit(1);
  if (((existingAlloc.data as unknown[] | null) ?? []).length > 0) {
    return { ok: true, allocated: false, serviceId, reason: "Già allocato" };
  }

  const { data: service } = await admin
    .from("services")
    .select("id, date, direction, pax, bus_city_origin, meeting_point")
    .eq("tenant_id", tenantId)
    .eq("id", serviceId)
    .maybeSingle();
  const svc = service as { date: string | null; direction: "arrival" | "departure" | null; pax: number | null; bus_city_origin: string | null; meeting_point: string | null } | null;
  if (!svc) return { ok: true, allocated: false, serviceId, reason: "Servizio non trovato" };
  if (!svc.date || !svc.direction || !svc.pax || svc.pax <= 0) return { ok: true, allocated: false, serviceId, reason: "Dati bus incompleti" };

  const { data: unit } = await admin.from("tenant_bus_units").select("id, bus_line_id, label, capacity").eq("tenant_id", tenantId).eq("id", busUnitId).maybeSingle();
  const busUnit = unit as { id: string; bus_line_id: string; label: string; capacity: number } | null;
  if (!busUnit) return { ok: true, allocated: false, serviceId, reason: "Bus non trovato" };
  if (busUnit.capacity < svc.pax) return { ok: true, allocated: false, serviceId, reason: "Capacità del bus riservato insufficiente" };

  const canonical = await resolveCanonicalBookingGroupStop(admin, tenantId, svc.bus_city_origin ?? "", svc.direction, svc.meeting_point, busUnit.bus_line_id);
  if (!canonical) return { ok: true, allocated: false, serviceId, reason: `Fermata non risolta per ${svc.bus_city_origin ?? "N/D"}` };

  const { data: stopRow } = await admin.from("tenant_bus_line_stops").select("stop_name").eq("tenant_id", tenantId).eq("id", canonical.stopId).maybeSingle();
  const stopName = (stopRow as { stop_name: string } | null)?.stop_name ?? svc.bus_city_origin ?? "Fermata";

  const allocRpc = await admin.rpc("allocate_bus_service", {
    p_tenant_id: tenantId,
    p_service_id: serviceId,
    p_bus_line_id: busUnit.bus_line_id,
    p_bus_unit_id: busUnit.id,
    p_stop_id: canonical.stopId,
    p_stop_name: stopName,
    p_direction: svc.direction,
    p_pax_assigned: svc.pax,
    p_notes: null,
    p_created_by_user_id: userId,
  });
  if (allocRpc.error) return { ok: true, allocated: false, serviceId, reason: allocRpc.error.message };
  return { ok: true, allocated: true, serviceId, busUnitId: busUnit.id, busLabel: busUnit.label, stopId: canonical.stopId, stopName, pax: svc.pax };
}
