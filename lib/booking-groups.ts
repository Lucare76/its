/**
 * FASE 1 — Modello GRUPPI PRENOTAZIONE (contenitore commerciale).
 *
 * Tipi + helper PURI. Nessuna dipendenza da `trip_groups` / `assignments`
 * (giro operativo Piano del Giorno) né dal dominio bus operativo
 * (`tenant_bus_allocations`, allocatore). Vedi migration 0263_booking_groups.sql.
 *
 * BookingGroup è deliberatamente DIVERSO da TripGroup:
 *  - BookingGroup  = contenitore commerciale stabile, pre-services, con
 *                    pax previsti / stato progressivo / override nave.
 *  - TripGroup     = giro operativo volatile (driver + vehicle_label + date),
 *                    rigenerato dal planner.
 */

export type BookingGroupKind = "bus_exclusive" | "bus_group" | "multi_service" | "other";

export type BookingGroupStatus =
  | "draft"
  | "to_complete"
  | "stops_defined"
  | "passengers_defined"
  | "operational"
  | "cancelled";

export type BookingGroupDirection = "arrival" | "departure";

export const BOOKING_GROUP_KINDS: readonly BookingGroupKind[] = [
  "bus_exclusive",
  "bus_group",
  "multi_service",
  "other",
] as const;

export const BOOKING_GROUP_STATUSES: readonly BookingGroupStatus[] = [
  "draft",
  "to_complete",
  "stops_defined",
  "passengers_defined",
  "operational",
  "cancelled",
] as const;

export const BOOKING_GROUP_MAX_PAX = 500;

export interface BookingGroup {
  id: string;
  tenant_id: string;
  name: string;
  expected_pax: number;
  kind: BookingGroupKind;
  status: BookingGroupStatus;
  service_date: string | null;
  return_date: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  agency_id: string | null;
  hotel_id: string | null;
  notes: string | null;

  outbound_ferry_company: string | null;
  outbound_departure_port: string | null;
  outbound_ferry_time: string | null;
  outbound_arrival_port: string | null;
  outbound_expected_arrival_time: string | null;

  return_ferry_company: string | null;
  return_departure_port: string | null;
  return_ferry_time: string | null;
  return_arrival_port: string | null;
  return_expected_arrival_time: string | null;

  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface BookingGroupStop {
  id: string;
  tenant_id: string;
  booking_group_id: string;
  city: string;
  pickup_point: string | null;
  expected_pax: number;
  stop_id: string | null;
  direction: BookingGroupDirection;
  sort_order: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface BookingGroupBusReservation {
  id: string;
  tenant_id: string;
  booking_group_id: string;
  bus_unit_id: string;
  service_date: string;
  reserved_pax: number;
  exclusive: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Domain helpers (puri, fail-safe: NON correggono automaticamente) ────────

export interface BookingGroupPaxSummary {
  expectedPax: number;
  /** Somma booking_group_stops.expected_pax. */
  plannedPax: number;
  /** expectedPax - plannedPax (può essere negativo se overbooked sulle fermate). */
  unplannedPax: number;
  /** Somma dei pax dei services collegati. */
  servicePax: number;
  /** expectedPax - servicePax (può essere negativo). */
  remainingServicePax: number;
  /** true se plannedPax > expectedPax OPPURE servicePax > expectedPax. */
  overbooked: boolean;
}

function toNonNegativeInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Deriva il quadro pax del gruppo. NON persiste nulla e NON corregge:
 * se plannedPax > expectedPax (o servicePax > expectedPax) segnala solo
 * `overbooked = true`.
 */
export function summarizeBookingGroupPax(input: {
  expectedPax: number;
  stopExpectedPax: number[];
  servicePax: number[];
}): BookingGroupPaxSummary {
  const expectedPax = toNonNegativeInt(input.expectedPax);
  const plannedPax = (input.stopExpectedPax ?? []).reduce((sum, v) => sum + toNonNegativeInt(v), 0);
  const servicePax = (input.servicePax ?? []).reduce((sum, v) => sum + toNonNegativeInt(v), 0);
  return {
    expectedPax,
    plannedPax,
    unplannedPax: expectedPax - plannedPax,
    servicePax,
    remainingServicePax: expectedPax - servicePax,
    overbooked: plannedPax > expectedPax || servicePax > expectedPax,
  };
}

export interface BookingGroupStatusSummary {
  status: BookingGroupStatus;
  hasStops: boolean;
  hasServices: boolean;
  hasBusReservation: boolean;
  pax: BookingGroupPaxSummary;
  /** Stato "suggerito" in base ai dati presenti — NON applicato automaticamente
   *  in FASE 1 (le transizioni restano manuali). */
  suggestedStatus: BookingGroupStatus;
}

/**
 * Riepilogo di stato + suggerimento non vincolante. In FASE 1 le transizioni
 * NON sono automatizzate: l'operatore resta libero di salvare gruppi incompleti
 * e di scegliere lo stato.
 */
export function computeBookingGroupStatusSummary(input: {
  status: BookingGroupStatus;
  expectedPax: number;
  stopExpectedPax: number[];
  servicePax: number[];
  busReservationCount: number;
}): BookingGroupStatusSummary {
  const pax = summarizeBookingGroupPax({
    expectedPax: input.expectedPax,
    stopExpectedPax: input.stopExpectedPax,
    servicePax: input.servicePax,
  });
  const hasStops = (input.stopExpectedPax ?? []).length > 0;
  const hasServices = (input.servicePax ?? []).length > 0;
  const hasBusReservation = toNonNegativeInt(input.busReservationCount) > 0;

  let suggestedStatus: BookingGroupStatus = input.status;
  if (input.status !== "cancelled") {
    if (hasServices) suggestedStatus = "passengers_defined";
    else if (hasStops) suggestedStatus = "stops_defined";
    else suggestedStatus = input.status === "draft" ? "draft" : "to_complete";
  }

  return { status: input.status, hasStops, hasServices, hasBusReservation, pax, suggestedStatus };
}

// ─── FASE 2.5 — operativizzazione: codici stabili + readiness helper ────────

export type BookingGroupMissingField =
  | "missing_date"
  | "missing_time"
  | "missing_direction"
  | "missing_city"
  | "missing_pickup_point"
  | "missing_hotel"
  | "missing_customer_name"
  | "missing_booking_group_id"
  | "missing_booking_group_stop_id"
  | "invalid_pax";

export type BookingGroupWarningCode =
  | "bus_reservation_missing"
  | "reserved_pax_below_expected"
  | "reserved_pax_above_capacity"
  | "ferry_outbound_missing"
  | "ferry_return_missing"
  | "allocation_pending";

/** Orario placeholder usato alla creazione dei service di gruppo (non operativo). */
export const BOOKING_GROUP_PLACEHOLDER_TIME = "00:00";

export interface BookingGroupServiceReadiness {
  ready: boolean;
  missingFields: BookingGroupMissingField[];
  warnings: BookingGroupWarningCode[];
  alreadyOperational: boolean;
}

type ReadinessService = {
  booking_group_id?: string | null;
  booking_group_stop_id?: string | null;
  date?: string | null;
  time?: string | null;
  direction?: string | null;
  pax?: number | null;
  customer_name?: string | null;
  bus_city_origin?: string | null;
  meeting_point?: string | null;
  hotel_id?: string | null;
  booking_service_kind?: string | null;
  is_draft?: boolean | null;
  status?: string | null;
};
type ReadinessGroup = { kind?: string | null };
type ReadinessStop = { pickup_point?: string | null; stop_id?: string | null };

function nonEmpty(v: unknown): boolean {
  return typeof v === "string" ? v.trim().length > 0 : v != null;
}

/**
 * Valuta se un service di gruppo può diventare operativo. PURO, nessuna
 * scrittura, nessun dato inventato. Blocchi = missingFields; segnalazioni
 * non bloccanti = warnings.
 *
 * Regole coerenti col dominio bus esistente:
 *  - `time === "00:00"` è placeholder → NON operativo (nessun resolver canonico
 *    deriva l'orario dal solo booking_group_stop).
 *  - per kind bus l'hotel NON è richiesto (services.hotel_id è nullable per
 *    bus_city_hotel, migration 0060); per altri kind sì.
 *  - `stop_id` non risolto → il service può comunque entrare nel Piano del
 *    Giorno → warning `allocation_pending`, NON un blocco.
 */
export function evaluateBookingGroupServiceReadiness(
  service: ReadinessService,
  group: ReadinessGroup,
  stop: ReadinessStop | null,
): BookingGroupServiceReadiness {
  const alreadyOperational = service.is_draft === false;
  const missing: BookingGroupMissingField[] = [];
  const warnings: BookingGroupWarningCode[] = [];

  const isBusKind = group.kind === "bus_exclusive" || group.kind === "bus_group";

  if (!nonEmpty(service.booking_group_id)) missing.push("missing_booking_group_id");
  if (!nonEmpty(service.booking_group_stop_id)) missing.push("missing_booking_group_stop_id");
  if (!nonEmpty(service.customer_name)) missing.push("missing_customer_name");
  if (!(Number(service.pax) > 0)) missing.push("invalid_pax");
  if (!nonEmpty(service.date)) missing.push("missing_date");
  if (!nonEmpty(service.direction)) missing.push("missing_direction");

  const time = (service.time ?? "").trim();
  if (!time || time.startsWith(BOOKING_GROUP_PLACEHOLDER_TIME)) missing.push("missing_time");

  if (isBusKind) {
    if (!nonEmpty(service.bus_city_origin)) missing.push("missing_city");
    if (stop && nonEmpty(stop.pickup_point) && !nonEmpty(service.meeting_point)) missing.push("missing_pickup_point");
    if (!stop || !nonEmpty(stop.stop_id)) warnings.push("allocation_pending");
  } else {
    if (!nonEmpty(service.hotel_id)) missing.push("missing_hotel");
  }

  return { ready: missing.length === 0 && !alreadyOperational, missingFields: missing, warnings, alreadyOperational };
}

export interface BookingGroupStopPaxSummary {
  stopId: string;
  expectedPax: number;
  /** Somma dei pax dei services collegati a QUESTA fermata (via booking_group_stop_id). */
  servicePax: number;
  /** expectedPax - servicePax (può essere negativo). */
  remainingServicePax: number;
  serviceCount: number;
  /** true se servicePax > expectedPax sulla fermata. */
  overbooked: boolean;
}

/**
 * Quadro pax per singola fermata: previsti vs già trasformati in services.
 * Fail-safe: NON corregge, segnala solo `overbooked`.
 */
export function summarizeStopPax(input: {
  stopId: string;
  expectedPax: number;
  servicePax: number[];
}): BookingGroupStopPaxSummary {
  const expectedPax = toNonNegativeInt(input.expectedPax);
  const list = input.servicePax ?? [];
  const servicePax = list.reduce((sum, v) => sum + toNonNegativeInt(v), 0);
  return {
    stopId: input.stopId,
    expectedPax,
    servicePax,
    remainingServicePax: expectedPax - servicePax,
    serviceCount: list.length,
    overbooked: servicePax > expectedPax,
  };
}
