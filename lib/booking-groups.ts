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
