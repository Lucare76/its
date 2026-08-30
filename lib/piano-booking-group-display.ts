/**
 * FASE 4 — Piano del Giorno GROUP-AWARE (presentazione, non dominio).
 *
 * Helper PURO che aggrega i services del Piano del Giorno appartenenti allo
 * stesso `booking_group_id` in un'unità di visualizzazione ("group_unit"),
 * senza toccare trip_groups / assignments / allocations / planner.
 *
 * Il Piano resta service-driven: questo modulo produce solo un DTO derivato
 * per la UI. Nessuna scrittura, nessuna dipendenza da Supabase.
 *
 * Regole chiave (vedi FASE 4 prompt):
 *  - una stessa booking_group_id genera UNA group_unit per direzione
 *    (arrival / departure) — mai una card ambigua A/R;
 *  - un service con booking_group_id risolto compare SOLO dentro la sua
 *    group_unit, mai anche come riga autonoma;
 *  - un service con booking_group_id che punta a un gruppo inesistente
 *    (FK orfana) degrada a riga normale — fail-safe, non blocca il render;
 *  - i warning sono calcolati ma NON bloccano né correggono nulla.
 */

export type PianoGroupDirection = "arrival" | "departure";

/** Campi minimi richiesti su un service per poterlo aggregare. Il tipo reale
 *  del chiamante (server: righe Supabase; client: `Service` di piano-giorno)
 *  può avere molti più campi: restano intatti su `S` grazie al generic. */
export interface PianoGroupAwareService {
  id: string;
  booking_group_id: string | null | undefined;
  booking_group_stop_id: string | null | undefined;
  direction: PianoGroupDirection;
  pax: number;
  time: string | null | undefined;
  date?: string | null;
}

export interface PianoBookingGroupLike {
  id: string;
  name: string;
  kind: string;
  status: string;
  expected_pax: number;
  service_date: string | null;
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
}

export interface PianoBookingGroupStopLike {
  id: string;
  booking_group_id: string;
  city: string;
  pickup_point: string | null;
  expected_pax: number;
  direction: PianoGroupDirection;
  sort_order: number;
}

export interface PianoBusReservationLike {
  id: string;
  booking_group_id: string;
  bus_unit_id: string;
  service_date: string;
  reserved_pax: number;
  exclusive: boolean;
}

export interface PianoBusUnitLike {
  id: string;
  label: string;
  capacity: number | null;
}

export type PianoGroupWarningCode =
  | "group_pax_incomplete"
  | "group_pax_overbooked"
  | "stop_pax_incomplete"
  | "stop_pax_overbooked"
  | "bus_reservation_missing"
  | "reserved_pax_below_expected"
  | "reserved_pax_above_capacity"
  | "unlinked_group_service"
  | "missing_time";

export interface PianoGroupStopUnit<S> {
  bookingGroupStopId: string | null;
  city: string | null;
  pickupPoint: string | null;
  /** null quando la fermata non è (più) risolvibile: sezione "non associata". */
  expectedPax: number | null;
  servicePax: number;
  serviceCount: number;
  overbooked: boolean;
  incomplete: boolean;
  services: S[];
}

export interface PianoGroupFerrySide {
  company: string | null;
  departurePort: string | null;
  ferryTime: string | null;
  arrivalPort: string | null;
  expectedArrivalTime: string | null;
}

export interface PianoGroupBusReservationView {
  busUnitId: string;
  busLabel: string | null;
  reservedPax: number;
  capacity: number | null;
  exclusive: boolean;
}

export interface PianoBookingGroupUnit<S> {
  type: "booking_group";
  bookingGroupId: string;
  name: string;
  kind: string;
  status: string;
  direction: PianoGroupDirection;
  serviceDate: string;
  expectedPax: number;
  servicePax: number;
  plannedPax: number;
  serviceCount: number;
  /** Numero di fermate RISOLTE (esclude la sezione "non associata"). */
  stopCount: number;
  /** Orario minimo tra i services del gruppo in questa direzione, per l'ordinamento. */
  earliestTime: string | null;
  stops: PianoGroupStopUnit<S>[];
  /** Vista piatta di tutti i services del gruppo (== unione di stops[].services). */
  services: S[];
  busReservation: PianoGroupBusReservationView | null;
  ferry: PianoGroupFerrySide | null;
  warnings: PianoGroupWarningCode[];
}

export interface PianoServiceDisplayUnit<S> {
  type: "service";
  service: S;
}

export type PianoDisplayUnit<S> = PianoBookingGroupUnit<S> | PianoServiceDisplayUnit<S>;

export interface BuildPianoDisplayUnitsInput<S extends PianoGroupAwareService> {
  services: S[];
  bookingGroups: PianoBookingGroupLike[];
  stops: PianoBookingGroupStopLike[];
  reservations: PianoBusReservationLike[];
  busUnits: PianoBusUnitLike[];
}

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isPlaceholderTime(time: string | null | undefined): boolean {
  const t = (time ?? "").trim();
  return !t || t.startsWith("00:00");
}

function buildGroupUnit<S extends PianoGroupAwareService>(
  group: PianoBookingGroupLike,
  direction: PianoGroupDirection,
  services: S[],
  stopsById: Map<string, PianoBookingGroupStopLike>,
  reservations: PianoBusReservationLike[],
  busUnitsById: Map<string, PianoBusUnitLike>,
): PianoBookingGroupUnit<S> {
  const stopBuckets = new Map<string | null, S[]>();
  for (const svc of services) {
    const stopId = svc.booking_group_stop_id && stopsById.has(svc.booking_group_stop_id)
      ? svc.booking_group_stop_id
      : null;
    const arr = stopBuckets.get(stopId) ?? [];
    arr.push(svc);
    stopBuckets.set(stopId, arr);
  }

  const stops: PianoGroupStopUnit<S>[] = [];
  for (const [stopId, svcs] of stopBuckets.entries()) {
    const stopDef = stopId ? (stopsById.get(stopId) ?? null) : null;
    const servicePax = svcs.reduce((n, s) => n + toNum(s.pax), 0);
    const expectedPax = stopDef ? stopDef.expected_pax : null;
    stops.push({
      bookingGroupStopId: stopId,
      city: stopDef?.city ?? null,
      pickupPoint: stopDef?.pickup_point ?? null,
      expectedPax,
      servicePax,
      serviceCount: svcs.length,
      overbooked: expectedPax != null && servicePax > expectedPax,
      incomplete: expectedPax != null && servicePax < expectedPax,
      services: svcs,
    });
  }
  stops.sort((a, b) => {
    if (a.bookingGroupStopId === null && b.bookingGroupStopId === null) return 0;
    if (a.bookingGroupStopId === null) return 1;
    if (b.bookingGroupStopId === null) return -1;
    const sa = stopsById.get(a.bookingGroupStopId)?.sort_order ?? 0;
    const sb = stopsById.get(b.bookingGroupStopId)?.sort_order ?? 0;
    return sa - sb;
  });

  const servicePax = services.reduce((n, s) => n + toNum(s.pax), 0);
  const plannedPax = Array.from(stopsById.values())
    .filter((s) => s.booking_group_id === group.id && s.direction === direction)
    .reduce((n, s) => n + toNum(s.expected_pax), 0);

  const warningSet = new Set<PianoGroupWarningCode>();
  if (servicePax < group.expected_pax) warningSet.add("group_pax_incomplete");
  if (servicePax > group.expected_pax) warningSet.add("group_pax_overbooked");
  for (const stop of stops) {
    if (stop.incomplete) warningSet.add("stop_pax_incomplete");
    if (stop.overbooked) warningSet.add("stop_pax_overbooked");
  }
  if (stops.some((s) => s.bookingGroupStopId === null)) warningSet.add("unlinked_group_service");
  if (services.some((s) => isPlaceholderTime(s.time))) warningSet.add("missing_time");

  let busReservation: PianoGroupBusReservationView | null = null;
  if (group.kind === "bus_exclusive") {
    const forDate = reservations.find((r) => !group.service_date || r.service_date === group.service_date)
      ?? reservations[0]
      ?? null;
    if (!forDate) {
      warningSet.add("bus_reservation_missing");
    } else {
      const bus = busUnitsById.get(forDate.bus_unit_id) ?? null;
      busReservation = {
        busUnitId: forDate.bus_unit_id,
        busLabel: bus?.label ?? null,
        reservedPax: forDate.reserved_pax,
        capacity: bus?.capacity ?? null,
        exclusive: forDate.exclusive,
      };
      if (forDate.reserved_pax < group.expected_pax) warningSet.add("reserved_pax_below_expected");
      if (bus?.capacity != null && forDate.reserved_pax > bus.capacity) warningSet.add("reserved_pax_above_capacity");
    }
  }

  const ferry: PianoGroupFerrySide | null = direction === "arrival"
    ? (group.outbound_ferry_company || group.outbound_ferry_time
      ? {
        company: group.outbound_ferry_company,
        departurePort: group.outbound_departure_port,
        ferryTime: group.outbound_ferry_time,
        arrivalPort: group.outbound_arrival_port,
        expectedArrivalTime: group.outbound_expected_arrival_time,
      }
      : null)
    : (group.return_ferry_company || group.return_ferry_time
      ? {
        company: group.return_ferry_company,
        departurePort: group.return_departure_port,
        ferryTime: group.return_ferry_time,
        arrivalPort: group.return_arrival_port,
        expectedArrivalTime: group.return_expected_arrival_time,
      }
      : null);

  let earliestTime: string | null = null;
  for (const svc of services) {
    const t = (svc.time ?? "").trim();
    if (!t) continue;
    if (earliestTime == null || t < earliestTime) earliestTime = t;
  }

  return {
    type: "booking_group",
    bookingGroupId: group.id,
    name: group.name,
    kind: group.kind,
    status: group.status,
    direction,
    serviceDate: group.service_date ?? services[0]?.date ?? "",
    expectedPax: group.expected_pax,
    servicePax,
    plannedPax,
    serviceCount: services.length,
    stopCount: stops.filter((s) => s.bookingGroupStopId !== null).length,
    earliestTime,
    stops,
    services,
    busReservation,
    ferry,
    warnings: Array.from(warningSet),
  };
}

/**
 * Costruisce le display unit del Piano del Giorno: una per ogni
 * (booking_group_id, direction) presente tra i services, più una per ogni
 * service "normale" (senza gruppo, o con gruppo non risolvibile).
 *
 * L'ordine dell'array in output preserva la prima posizione in cui compare
 * ciascun gruppo/servizio nell'array `services` in ingresso (tipicamente già
 * ordinato per `time` dalla query Piano del Giorno) — la group_unit occupa
 * quindi la posizione che avrebbe il suo primo service.
 *
 * O(n) rispetto al numero di services: nessun nested scan gruppo×service.
 */
export function buildPianoDisplayUnits<S extends PianoGroupAwareService>(
  input: BuildPianoDisplayUnitsInput<S>,
): PianoDisplayUnit<S>[] {
  const groupsById = new Map(input.bookingGroups.map((g) => [g.id, g]));
  const stopsById = new Map(input.stops.map((s) => [s.id, s]));
  const busUnitsById = new Map(input.busUnits.map((b) => [b.id, b]));
  const reservationsByGroup = new Map<string, PianoBusReservationLike[]>();
  for (const r of input.reservations) {
    const arr = reservationsByGroup.get(r.booking_group_id) ?? [];
    arr.push(r);
    reservationsByGroup.set(r.booking_group_id, arr);
  }

  const buckets = new Map<string, S[]>();
  const order: Array<{ kind: "group"; key: string } | { kind: "service"; service: S }> = [];

  for (const svc of input.services) {
    const gid = svc.booking_group_id;
    if (gid && groupsById.has(gid)) {
      const key = `${gid}::${svc.direction}`;
      const arr = buckets.get(key);
      if (arr) {
        arr.push(svc);
      } else {
        buckets.set(key, [svc]);
        order.push({ kind: "group", key });
      }
    } else {
      order.push({ kind: "service", service: svc });
    }
  }

  const units: PianoDisplayUnit<S>[] = [];
  for (const item of order) {
    if (item.kind === "service") {
      units.push({ type: "service", service: item.service });
      continue;
    }
    const sepIndex = item.key.lastIndexOf("::");
    const groupId = item.key.slice(0, sepIndex);
    const direction = item.key.slice(sepIndex + 2) as PianoGroupDirection;
    const group = groupsById.get(groupId);
    const groupServices = buckets.get(item.key);
    if (!group || !groupServices) continue;
    units.push(buildGroupUnit(group, direction, groupServices, stopsById, reservationsByGroup.get(groupId) ?? [], busUnitsById));
  }
  return units;
}
