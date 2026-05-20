import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { canDriverCoverInterval, type DriverAvailabilityWindow } from "@/lib/piano-driver-availability";
import { canDriverUseVehicle } from "@/lib/piano-driver-vehicle-eligibility";
import { resolveAssignableService, type AssignableService } from "@/lib/piano-assignable-service";
import { detectExcursionRoundtripClusters } from "@/lib/piano-excursion-roundtrip-cluster";
import { assignGlobalPlanner, type GlobalPlannerDriver, type GlobalPlannerVehicle } from "@/lib/piano-global-planner";
import { calculateOperationalDuration, isOperationalShuttleLike, type OperationalDurationConfig } from "@/lib/piano-operational-duration";
import { mergeSameStops, type ResolvedServiceForSameStop } from "@/lib/piano-same-stop-merge";
import { listDriverRegistry, type DriverRegistryEntry } from "@/lib/server/driver-registry";
import { loadConfirmedOperatorDecisions } from "@/lib/server/piano-operator-decisions";
import type { PricingAuthContext } from "@/lib/server/pricing-auth";

const DATE = "2026-05-07";
const BUFFER_MINUTES = 5;
const LARGE_PAX = 21;

const READONLY_20260507_DURATION_CONFIG: OperationalDurationConfig = {
  defaultTransferDurationMinutes: 30,
  defaultTransferBufferMinutes: BUFFER_MINUTES,
  defaultShuttleDurationMinutes: 5,
  defaultShuttleBufferMinutes: 0,
  defaultMicroDurationMinutes: 20,
  defaultMicroBufferMinutes: 0,
  microPaxThreshold: 2,
  routeDurations: [
    {
      booking_service_kind: "navetta",
      origin_label: "Hotel President",
      destination_label: "Caffe del Direttore",
      duration_minutes: 10,
      buffer_minutes: 2,
      reason: "route-duration tenant config: navetta breve hotel/punto navetta",
    },
    {
      booking_service_kind: "navetta",
      origin_label: "Caffe del Direttore",
      destination_label: "Hotel President",
      duration_minutes: 10,
      buffer_minutes: 2,
      reason: "route-duration tenant config: navetta breve punto navetta/hotel",
    },
    {
      booking_service_kind: "navetta",
      origin_label: "Hotel San Nicola",
      destination_label: "Citara",
      duration_minutes: 5,
      buffer_minutes: 0,
      reason: "route-duration tenant config: ciclo breve navetta",
    },
    {
      booking_service_kind: "navetta",
      origin_label: "Citara",
      destination_label: "Hotel San Nicola",
      duration_minutes: 5,
      buffer_minutes: 0,
      reason: "route-duration tenant config: ciclo breve navetta",
    },
    {
      booking_service_kind: "navetta",
      origin_label: "Hotel Cristallo",
      destination_label: "Piazza Marina",
      duration_minutes: 10,
      buffer_minutes: 0,
      reason: "route-duration tenant config: navetta breve",
    },
    {
      booking_service_kind: "navetta",
      origin_label: "Piazza Marina",
      destination_label: "Hotel Cristallo",
      duration_minutes: 10,
      buffer_minutes: 0,
      reason: "route-duration tenant config: navetta breve",
    },
    {
      origin_label: "Ischia Porto",
      destination_label: "LA VILLA",
      duration_minutes: 10,
      buffer_minutes: 0,
      reason: "route-duration tenant config: micro-tratta breve",
    },
    {
      origin_label: "LA VILLA",
      destination_label: "Ischia Porto",
      duration_minutes: 10,
      buffer_minutes: 0,
      reason: "route-duration tenant config: micro-tratta breve",
    },
  ],
};

type Admin = ReturnType<typeof createClient>;
type Group = {
  id: string;
  date: string;
  driver_user_id: string | null;
  driver_profile_id: string | null;
  vehicle_label: string | null;
  vehicle_capacity: number | null;
  status: string | null;
};
type Assignment = {
  id: string;
  service_id: string;
  group_id: string | null;
  driver_user_id: string | null;
  driver_profile_id: string | null;
  vehicle_label: string | null;
};
type Service = AssignableService & {
  status?: string | null;
  route_kind?: string | null;
  origin_place_id?: string | null;
  destination_place_id?: string | null;
  origin_label_raw?: string | null;
  destination_label_raw?: string | null;
};
type Vehicle = { id: string; label: string | null; capacity: number | null; active: boolean | null };
type Availability = {
  driver_profile_id: string | null;
  driver_user_id: string | null;
  available: boolean | null;
  available_from: string | null;
  available_to: string | null;
};
type UnitType = "giro_singolo" | "same_stop" | "multi_drop_confirmed" | "accorpamento_confirmed" | "shuttle_pair" | "cluster_escursione_roundtrip" | "navetta_speciale";
type Unit = {
  id: string;
  type: UnitType;
  label: string;
  group_ids: string[];
  service_ids: string[];
  start: string | null;
  end: string | null;
  pax: number;
  nonsplittable: boolean;
  min_vehicle_capacity: number;
  current_driver_key: string | null;
  current_driver_name: string | null;
  current_vehicle_label: string | null;
  current_vehicle_capacity: number | null;
  duration_minutes: number;
  buffer_minutes: number;
  duration_reason: string;
  stops: string[];
  needs_review: boolean;
  locked?: boolean;
  protected_from_backtracking?: boolean;
  dense_shuttle?: boolean;
};
type ProposedAssignment = Unit & {
  proposed_driver_key: string | null;
  proposed_driver_name: string | null;
  proposed_vehicle_label: string | null;
  proposed_vehicle_capacity: number | null;
  reason: string;
  assigned: boolean;
  blocker?: string | null;
};

function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    try {
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
        const index = trimmed.indexOf("=");
        process.env[trimmed.slice(0, index).trim()] ??= trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      }
    } catch {
      // optional env file
    }
  }
}

function norm(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toUpperCase();
}

function minutes(value: unknown) {
  const match = String(value ?? "").match(/(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function hhmm(value: number | null) {
  if (value == null) return null;
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function overlapsWithBuffer(a: Pick<Unit, "start" | "end" | "buffer_minutes">, b: Pick<Unit, "start" | "end" | "buffer_minutes">, buffer = Math.min(a.buffer_minutes ?? BUFFER_MINUTES, b.buffer_minutes ?? BUFFER_MINUTES)) {
  const as = minutes(a.start);
  const ae = minutes(a.end);
  const bs = minutes(b.start);
  const be = minutes(b.end);
  if (as == null || ae == null || bs == null || be == null) return true;
  return as < be + buffer && ae + buffer > bs;
}

function unitDurationMinutes(unit: Pick<Unit, "start" | "end">) {
  const start = minutes(unit.start);
  const end = minutes(unit.end);
  return start == null || end == null ? 30 : Math.max(1, end - start);
}

function groupDriverKey(group: Group) {
  return group.driver_profile_id ? `profile:${group.driver_profile_id}` : group.driver_user_id ? `user:${group.driver_user_id}` : null;
}

function driverKey(driver: Pick<DriverRegistryEntry, "id" | "user_id">) {
  return driver.id ? `profile:${driver.id}` : driver.user_id ? `user:${driver.user_id}` : null;
}

function driverNameForGroup(group: Group, drivers: DriverRegistryEntry[]) {
  if (group.driver_profile_id) return drivers.find((driver) => driver.id === group.driver_profile_id)?.full_name ?? null;
  if (group.driver_user_id) return drivers.find((driver) => driver.user_id === group.driver_user_id)?.full_name ?? null;
  return null;
}

function cleanLabel(value: unknown) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

function missingSchemaColumn(message: string) {
  return message.match(/Could not find the '([^']+)' column/)?.[1]
    ?? message.match(/column (?:public\.)?services\.([a-zA-Z0-9_]+) does not exist/)?.[1]
    ?? message.match(/column "([a-zA-Z0-9_]+)" does not exist/)?.[1]
    ?? null;
}

function vehicleBlockedOnDate(block: Record<string, unknown>) {
  const singleDate = String(block.date ?? "").slice(0, 10);
  if (singleDate) return singleDate === DATE;
  const from = String(block.blocked_from ?? block.block_from ?? "").slice(0, 10);
  const until = String(block.blocked_until ?? block.block_to ?? "").slice(0, 10);
  return Boolean(from && until && from <= DATE && until >= DATE);
}

async function resolveTenant(admin: Admin) {
  const { data, error } = await admin.from("tenants").select("id,name").limit(50);
  if (error) throw error;
  const tenant = (data ?? []).find((row) => norm(row.name).includes("ISCHIA TRANSFER")) ?? data?.[0];
  if (!tenant?.id) throw new Error("Tenant non trovato.");
  return { id: tenant.id as string, name: tenant.name as string | null };
}

async function loadServices(admin: Admin, tenantId: string, ids: string[]) {
  let columns = [
    "id", "date", "time", "time_from", "time_to", "direction", "customer_name", "pax", "hotel_id", "vessel",
    "notes", "status", "meeting_point", "place_type", "pickup_hotel", "booking_service_kind", "service_type",
    "service_type_code", "transport_code", "ferry_details", "excursion_details", "tour_name", "pickup_time",
    "arrival_time", "departure_time", "origin_place_type", "destination_place_type",
    "route_kind", "origin_place_id", "destination_place_id", "origin_label_raw", "destination_label_raw",
  ];
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const result = await admin.from("services").select(columns.join(",")).eq("tenant_id", tenantId).in("id", ids);
    if (!result.error) return (result.data ?? []) as Service[];
    const missing = missingSchemaColumn(result.error.message);
    if (!missing || !columns.includes(missing)) throw result.error;
    columns = columns.filter((column) => column !== missing);
  }
  throw new Error("Impossibile caricare servizi.");
}

function availabilityFor(driver: DriverRegistryEntry, availability: Availability[]): DriverAvailabilityWindow | null {
  const row = availability.find((item) => item.driver_profile_id === driver.id)
    ?? (driver.user_id ? availability.find((item) => item.driver_user_id === driver.user_id) : null)
    ?? null;
  return row ? {
    available: row.available,
    available_from: row.available_from,
    available_to: row.available_to,
    blocks: [],
  } : null;
}

function availableVehicles(args: {
  vehicles: Vehicle[];
  vehicleAvailability: Array<{ vehicle_id: string | null; available: boolean | null }>;
  blocks: Array<Record<string, unknown>>;
}) {
  const availability = new Map(args.vehicleAvailability.map((row) => [row.vehicle_id, row.available]));
  const blocked = new Set(args.blocks.filter(vehicleBlockedOnDate).map((block) => block.vehicle_id));
  return args.vehicles
    .filter((vehicle) => vehicle.active !== false)
    .filter((vehicle) => availability.get(vehicle.id) !== false)
    .filter((vehicle) => !blocked.has(vehicle.id))
    .sort((a, b) => (a.capacity ?? 999) - (b.capacity ?? 999) || String(a.label).localeCompare(String(b.label)));
}

function serviceStops(args: {
  services: Service[];
  hotels: Array<{ id: string; name: string | null; zone: string | null }>;
}) {
  const hotelById = new Map(args.hotels.map((hotel) => [hotel.id, hotel]));
  return args.services.map((service) => {
    const resolution = resolveAssignableService(service, { hotel: service.hotel_id ? hotelById.get(service.hotel_id) ?? null : null });
    return {
      service_id: service.id,
      customer_name: service.customer_name ?? null,
      macro_category: resolution.macro_category,
      assignable: resolution.assignable,
      needs_review: resolution.needs_review,
      review_reasons: resolution.review_reasons,
      operational_time: resolution.operational_time,
      pickup_label: resolution.pickup_label,
      pickup_zone: resolution.pickup_zone,
      destination_label: resolution.destination_label,
      destination_zone: resolution.destination_zone,
      pax: resolution.pax,
      booking_service_kind: resolution.booking_service_kind,
      service_type_code: resolution.service_type_code,
      route_kind: service.route_kind ?? null,
      origin_place_id: service.origin_place_id ?? null,
      destination_place_id: service.destination_place_id ?? null,
    } satisfies ResolvedServiceForSameStop;
  });
}

function unitTypeFromStops(stops: ResolvedServiceForSameStop[], confirmedActions: Set<string>): UnitType {
  if (confirmedActions.has("MULTI_DROP")) return "multi_drop_confirmed";
  if (confirmedActions.has("ACCORPARE_CON_CONFERMA")) return "accorpamento_confirmed";
  const merged = mergeSameStops(stops.filter((stop) => stop.assignable && !stop.needs_review));
  if (isOperationalShuttleLike(stops)) {
    const times = stops.map((stop) => minutes(stop.operational_time)).filter((value): value is number => value != null);
    const span = times.length ? Math.max(...times) - Math.min(...times) : 0;
    return stops.length > 1 && span <= 10 ? "shuttle_pair" : "navetta_speciale";
  }
  if (merged.some((stop) => stop.is_merged)) return "same_stop";
  return "giro_singolo";
}

function makeUnit(args: {
  id: string;
  groupIds: string[];
  services: Service[];
  stops: ResolvedServiceForSameStop[];
  type: UnitType;
  group?: Group | null;
  drivers: DriverRegistryEntry[];
  vehiclesByLabel: Map<string, Vehicle>;
  confirmedActions: Set<string>;
}): Unit {
  const times = args.stops.map((stop) => minutes(stop.operational_time)).filter((value): value is number => value != null);
  const start = times.length ? Math.min(...times) : null;
  const pax = args.stops.reduce((sum, stop) => sum + (Number(stop.pax) || 0), 0);
  let operationalDuration = calculateOperationalDuration({
    type: args.type,
    stops: args.stops,
    defaultDurationMinutes: 30,
    defaultBufferMinutes: BUFFER_MINUTES,
    pax,
    config: READONLY_20260507_DURATION_CONFIG,
  });
  const end = times.length ? Math.max(...times) + operationalDuration.duration_minutes : null;
  const currentVehicle = args.group?.vehicle_label ? args.vehiclesByLabel.get(norm(args.group.vehicle_label)) ?? null : null;
  const labels = args.stops.map((stop) => `${stop.operational_time ?? "??"} ${stop.pickup_label ?? "?"} -> ${stop.destination_label ?? "?"}`);
  const customers = [...new Set(args.services.map((service) => cleanLabel(service.customer_name)).filter((value): value is string => Boolean(value)))];
  return {
    id: args.id,
    type: args.type,
    label: customers.length ? customers.join(" / ") : args.type,
    group_ids: args.groupIds,
    service_ids: args.services.map((service) => service.id).sort(),
    start: hhmm(start),
    end: hhmm(end),
    pax,
    nonsplittable: true,
    min_vehicle_capacity: pax,
    current_driver_key: args.group ? groupDriverKey(args.group) : null,
    current_driver_name: args.group ? driverNameForGroup(args.group, args.drivers) : null,
    current_vehicle_label: args.group?.vehicle_label ?? null,
    current_vehicle_capacity: args.group?.vehicle_capacity ?? currentVehicle?.capacity ?? null,
    duration_minutes: operationalDuration.duration_minutes,
    buffer_minutes: operationalDuration.buffer_minutes,
    duration_reason: operationalDuration.reason,
    stops: labels,
    needs_review: args.stops.some((stop) => stop.needs_review || !stop.assignable),
    locked: args.confirmedActions.size > 0 || args.type === "cluster_escursione_roundtrip",
    protected_from_backtracking: args.type === "cluster_escursione_roundtrip" || pax >= LARGE_PAX,
    dense_shuttle: isOperationalShuttleLike(args.stops),
  };
}

function isDenseShuttleStop(stop: ResolvedServiceForSameStop) {
  return isOperationalShuttleLike([stop]);
}

function splitDenseShuttleUnits(args: {
  group: Group;
  groupServices: Service[];
  stops: ResolvedServiceForSameStop[];
  type: UnitType;
  drivers: DriverRegistryEntry[];
  vehiclesByLabel: Map<string, Vehicle>;
  confirmedActions: Set<string>;
}) {
  if (args.type !== "navetta_speciale" || args.confirmedActions.size > 0) return null;
  if (args.stops.length <= 1 || !args.stops.every(isDenseShuttleStop)) return null;

  const ordered = args.stops
    .map((stop, index) => ({ stop, service: args.groupServices[index] }))
    .filter((item): item is { stop: ResolvedServiceForSameStop; service: Service } => Boolean(item.service))
    .sort((a, b) => (minutes(a.stop.operational_time) ?? 9999) - (minutes(b.stop.operational_time) ?? 9999));
  if (ordered.length <= 1) return null;

  const span = (minutes(ordered[ordered.length - 1]!.stop.operational_time) ?? 0) - (minutes(ordered[0]!.stop.operational_time) ?? 0);
  if (span <= 15) return null;

  return ordered.map((item, index) => makeUnit({
    id: `${args.group.id}:navetta-cycle:${index + 1}`,
    groupIds: [args.group.id],
    services: [item.service],
    stops: [item.stop],
    type: "navetta_speciale",
    group: args.group,
    drivers: args.drivers,
    vehiclesByLabel: args.vehiclesByLabel,
    confirmedActions: args.confirmedActions,
  }));
}

function countCandidates(unit: Unit, drivers: DriverRegistryEntry[], vehicles: Vehicle[], availability: Availability[]) {
  let count = 0;
  for (const driver of drivers) {
    const av = canDriverCoverInterval(availabilityFor(driver, availability), { start_time: unit.start, end_time: unit.end }, {
      missingAvailability: "blocker",
      missingBounds: "warning",
      defaultDurationMinutes: unitDurationMinutes(unit),
    });
    if (!av.allowed) continue;
    for (const vehicle of vehicles) {
      if ((vehicle.capacity ?? -1) < unit.min_vehicle_capacity) continue;
      if (!canDriverUseVehicle(driver, vehicle, { blockUnknownVehicleCapacity: true }).allowed) continue;
      count += 1;
    }
  }
  return count;
}

function hardCompatible(unit: Unit, driver: DriverRegistryEntry, vehicle: Vehicle, availability: Availability[]) {
  const av = canDriverCoverInterval(availabilityFor(driver, availability), { start_time: unit.start, end_time: unit.end }, {
    missingAvailability: "blocker",
    missingBounds: "warning",
    defaultDurationMinutes: unitDurationMinutes(unit),
  });
  return av.allowed
    && (vehicle.capacity ?? -1) >= unit.min_vehicle_capacity
    && canDriverUseVehicle(driver, vehicle, { blockUnknownVehicleCapacity: true }).allowed;
}

function timelineConflict(unit: Unit, timeline: ProposedAssignment[]) {
  return timeline.some((assigned) => overlapsWithBuffer(unit, assigned));
}

function legacyAssignGlobally(args: {
  units: Unit[];
  drivers: DriverRegistryEntry[];
  vehicles: Vehicle[];
  availability: Availability[];
}) {
  const driverByKey = new Map(args.drivers.map((driver) => [driverKey(driver), driver]));
  const vehicleByLabel = new Map(args.vehicles.map((vehicle) => [norm(vehicle.label), vehicle]));
  const driverTimeline = new Map<string, ProposedAssignment[]>();
  const vehicleTimeline = new Map<string, ProposedAssignment[]>();
  const ordered = [...args.units].sort((a, b) => {
    const rank = (unit: Unit) =>
      unit.pax >= LARGE_PAX ? 0
        : unit.type === "cluster_escursione_roundtrip" ? 1
          : unit.type === "multi_drop_confirmed" || unit.type === "accorpamento_confirmed" ? 2
            : countCandidates(unit, args.drivers, args.vehicles, args.availability);
    return rank(a) - rank(b)
      || (b.pax - a.pax)
      || (minutes(a.start) ?? 9999) - (minutes(b.start) ?? 9999);
  });
  const result: ProposedAssignment[] = [];
  for (const unit of ordered) {
    const candidates: Array<{ driver: DriverRegistryEntry; vehicle: Vehicle; score: number; reason: string }> = [];
    for (const driver of args.drivers) {
      const dKey = driverKey(driver);
      if (!dKey || timelineConflict(unit, driverTimeline.get(dKey) ?? [])) continue;
      for (const vehicle of args.vehicles) {
        const vKey = norm(vehicle.label);
        if (!vKey || timelineConflict(unit, vehicleTimeline.get(vKey) ?? [])) continue;
        if (!hardCompatible(unit, driver, vehicle, args.availability)) continue;
        let score = 0;
        if (dKey === unit.current_driver_key) score -= 100;
        if (norm(vehicle.label) === norm(unit.current_vehicle_label)) score -= 80;
        score += Math.abs((vehicle.capacity ?? 99) - unit.min_vehicle_capacity);
        if (unit.pax >= LARGE_PAX && (vehicle.capacity ?? 0) >= LARGE_PAX) score -= 20;
        if (unit.pax >= 9 && unit.pax <= 14 && norm(vehicle.label).includes("DUCATO MAXI")) score -= 15;
        candidates.push({
          driver,
          vehicle,
          score,
          reason: dKey === unit.current_driver_key && norm(vehicle.label) === norm(unit.current_vehicle_label)
            ? "mantiene assegnazione attuale valida"
            : "riallineamento globale con vincoli autista/mezzo",
        });
      }
    }
    const chosen = candidates.sort((a, b) => a.score - b.score)[0] ?? null;
    if (!chosen) {
      result.push({
        ...unit,
        proposed_driver_key: null,
        proposed_driver_name: null,
        proposed_vehicle_label: null,
        proposed_vehicle_capacity: null,
        reason: "nessuna combinazione autista/mezzo libera e compatibile",
        assigned: false,
        blocker: "NO_COMPATIBLE_SLOT",
      });
      continue;
    }
    const assigned: ProposedAssignment = {
      ...unit,
      proposed_driver_key: driverKey(chosen.driver),
      proposed_driver_name: chosen.driver.full_name,
      proposed_vehicle_label: chosen.vehicle.label,
      proposed_vehicle_capacity: chosen.vehicle.capacity,
      reason: chosen.reason,
      assigned: true,
      blocker: null,
    };
    result.push(assigned);
    driverTimeline.set(assigned.proposed_driver_key!, [...(driverTimeline.get(assigned.proposed_driver_key!) ?? []), assigned]);
    vehicleTimeline.set(norm(assigned.proposed_vehicle_label), [...(vehicleTimeline.get(norm(assigned.proposed_vehicle_label)) ?? []), assigned]);
  }
  return result.sort((a, b) => (minutes(a.start) ?? 9999) - (minutes(b.start) ?? 9999));
}

function plannerDriver(driver: DriverRegistryEntry, availability: Availability[]): GlobalPlannerDriver | null {
  const key = driverKey(driver);
  const window = availabilityFor(driver, availability);
  if (!key) return null;
  return {
    key,
    name: driver.full_name,
    max_vehicle_capacity: driver.max_vehicle_capacity,
    available_from: window?.available_from ?? null,
    available_to: window?.available_to ?? null,
  };
}

function plannerVehicle(vehicle: Vehicle): GlobalPlannerVehicle {
  return {
    key: norm(vehicle.label ?? vehicle.id),
    label: vehicle.label,
    capacity: vehicle.capacity,
  };
}

function diagnostics(plan: ProposedAssignment[], drivers: DriverRegistryEntry[], vehicles: Vehicle[], availability: Availability[]) {
  const driverByKey = new Map(drivers.map((driver) => [driverKey(driver), driver]));
  const vehicleByLabel = new Map(vehicles.map((vehicle) => [norm(vehicle.label), vehicle]));
  let vehicleConflicts = 0;
  let driverConflicts = 0;
  let eligibility = 0;
  let availabilityBlockers = 0;
  let overbooking = 0;
  const assigned = plan.filter((unit) => unit.assigned);
  for (let i = 0; i < assigned.length; i += 1) {
    const left = assigned[i]!;
    const driver = left.proposed_driver_key ? driverByKey.get(left.proposed_driver_key) ?? null : null;
    const vehicle = left.proposed_vehicle_label ? vehicleByLabel.get(norm(left.proposed_vehicle_label)) ?? null : null;
    if (!driver || !vehicle || !canDriverUseVehicle(driver, vehicle, { blockUnknownVehicleCapacity: true }).allowed) eligibility += 1;
    if (vehicle && left.pax > (vehicle.capacity ?? 0)) overbooking += 1;
    if (driver && !canDriverCoverInterval(availabilityFor(driver, availability), { start_time: left.start, end_time: left.end }, { missingAvailability: "blocker", missingBounds: "warning", defaultDurationMinutes: unitDurationMinutes(left) }).allowed) availabilityBlockers += 1;
    for (let j = i + 1; j < assigned.length; j += 1) {
      const right = assigned[j]!;
      if (!overlapsWithBuffer(left, right)) continue;
      if (left.proposed_driver_key && left.proposed_driver_key === right.proposed_driver_key) driverConflicts += 1;
      if (norm(left.proposed_vehicle_label) && norm(left.proposed_vehicle_label) === norm(right.proposed_vehicle_label)) vehicleConflicts += 1;
    }
  }
  return {
    total_conflicts_after: driverConflicts + vehicleConflicts + plan.filter((unit) => !unit.assigned).length,
    driver_conflicts_after: driverConflicts,
    vehicle_conflicts_after: vehicleConflicts,
    driver_vehicle_eligibility_blockers_after: eligibility,
    driver_availability_blockers_after: availabilityBlockers,
    overbooking_after: overbooking,
    needs_review_after: plan.filter((unit) => unit.needs_review || !unit.assigned).length,
  };
}

function candidateAuditForUnit(args: {
  unit: ProposedAssignment;
  plan: ProposedAssignment[];
  drivers: DriverRegistryEntry[];
  vehicles: Vehicle[];
  availability: Availability[];
}) {
  const assigned = args.plan.filter((unit) => unit.assigned);
  const rows: Array<{
    driver: string;
    vehicle: string | null;
    yes: boolean;
    reason: string;
  }> = [];
  for (const driver of args.drivers) {
    for (const vehicle of args.vehicles) {
      const reasons: string[] = [];
      const availability = canDriverCoverInterval(availabilityFor(driver, args.availability), {
        start_time: args.unit.start,
        end_time: args.unit.end,
      }, { missingAvailability: "blocker", missingBounds: "warning", defaultDurationMinutes: unitDurationMinutes(args.unit) });
      if (!availability.allowed) reasons.push("autista fuori disponibilita");
      if ((vehicle.capacity ?? -1) < args.unit.min_vehicle_capacity) reasons.push("mezzo sotto-capienza");
      if (!canDriverUseVehicle(driver, vehicle, { blockUnknownVehicleCapacity: true }).allowed) reasons.push("mezzo non guidabile");
      const dKey = driverKey(driver);
      const driverOverlap = assigned
        .filter((item) => item.proposed_driver_key === dKey)
        .filter((item) => overlapsWithBuffer(args.unit, item));
      if (driverOverlap.length > 0) {
        reasons.push(`timeline autista occupata: ${driverOverlap.map((item) => `${item.start}-${item.end} ${item.label}`).join("; ")}`);
      }
      const vehicleOverlap = assigned
        .filter((item) => norm(item.proposed_vehicle_label) === norm(vehicle.label))
        .filter((item) => overlapsWithBuffer(args.unit, item));
      if (vehicleOverlap.length > 0) {
        reasons.push(`timeline mezzo occupata: ${vehicleOverlap.map((item) => `${item.start}-${item.end} ${item.label}`).join("; ")}`);
      }
      rows.push({
        driver: driver.full_name,
        vehicle: vehicle.label,
        yes: reasons.length === 0,
        reason: reasons.length === 0 ? "assegnabile in slot corrente" : reasons.join(" | "),
      });
    }
  }
  const positive = rows.filter((row) => row.yes);
  return {
    unit: args.unit.label,
    time: `${args.unit.start}-${args.unit.end}`,
    positive,
    negative_sample: rows.filter((row) => !row.yes).slice(0, 8),
    total_positive_candidates: positive.length,
  };
}

function classifyUnassigned(unit: ProposedAssignment, audit: ReturnType<typeof candidateAuditForUnit>) {
  if (audit.total_positive_candidates > 0) return "planner greedy insufficiente";
  if (unit.type === "shuttle_pair" || unit.type === "navetta_speciale") {
    const longDuration = (minutes(unit.end) ?? 0) - (minutes(unit.start) ?? 0);
    if (longDuration >= 30) return "buffer/durata errata";
    return "navetta modellata male";
  }
  const anyCapacityIssue = audit.negative_sample.some((row) => row.reason.includes("sotto-capienza") || row.reason.includes("non guidabile"));
  const anyTimelineIssue = audit.negative_sample.some((row) => row.reason.includes("timeline"));
  if (anyTimelineIssue && !anyCapacityIssue) return "assegnabile con ordine diverso";
  if (anyTimelineIssue) return "planner greedy insufficiente";
  return "vero blocker";
}

async function main() {
  loadEnv();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Missing Supabase env.");
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const tenant = await resolveTenant(admin);
  const auth = {
    admin,
    user: { id: "readonly-global-planner", email: null },
    membership: { tenant_id: tenant.id, role: "admin", suspended: false },
  } satisfies PricingAuthContext;

  const [driversAll, hotelsRes, groupsRes, assignmentsRes, vehiclesRes, vehicleAvailRes, vehicleBlocksRes, driverAvailRes, decisions] = await Promise.all([
    listDriverRegistry(admin, tenant.id, { activeOnly: true }),
    admin.from("hotels").select("id,name,zone").eq("tenant_id", tenant.id),
    admin.from("trip_groups").select("id,date,driver_user_id,driver_profile_id,vehicle_label,vehicle_capacity,status").eq("tenant_id", tenant.id).eq("date", DATE).eq("status", "active"),
    admin.from("assignments").select("id,service_id,group_id,driver_user_id,driver_profile_id,vehicle_label").eq("tenant_id", tenant.id),
    admin.from("vehicles").select("id,label,capacity,active").eq("tenant_id", tenant.id).order("label"),
    admin.from("vehicle_daily_availability").select("vehicle_id,available").eq("tenant_id", tenant.id).eq("date", DATE),
    admin.from("vehicle_time_blocks").select("*").eq("tenant_id", tenant.id),
    admin.from("driver_daily_availability").select("driver_profile_id,driver_user_id,available,available_from,available_to").eq("tenant_id", tenant.id).eq("date", DATE),
    loadConfirmedOperatorDecisions(auth, DATE),
  ]);
  for (const [name, result] of Object.entries({ hotelsRes, groupsRes, assignmentsRes, vehiclesRes, vehicleAvailRes, vehicleBlocksRes, driverAvailRes })) {
    if (result.error) throw new Error(`${name}: ${result.error.message}`);
  }
  const availability = (driverAvailRes.data ?? []) as Availability[];
  const availableDriverKeys = new Set(availability.filter((row) => row.available !== false).map((row) => row.driver_profile_id ? `profile:${row.driver_profile_id}` : row.driver_user_id ? `user:${row.driver_user_id}` : null).filter(Boolean));
  const drivers = driversAll.filter((driver) => availableDriverKeys.has(driverKey(driver)));
  const vehicles = availableVehicles({
    vehicles: (vehiclesRes.data ?? []) as Vehicle[],
    vehicleAvailability: (vehicleAvailRes.data ?? []) as Array<{ vehicle_id: string | null; available: boolean | null }>,
    blocks: (vehicleBlocksRes.data ?? []) as Array<Record<string, unknown>>,
  });
  const groups = (groupsRes.data ?? []) as Group[];
  const groupIds = new Set(groups.map((group) => group.id));
  const assignments = ((assignmentsRes.data ?? []) as Assignment[]).filter((assignment) => assignment.group_id && groupIds.has(assignment.group_id));
  const services = await loadServices(admin, tenant.id, [...new Set(assignments.map((assignment) => assignment.service_id))]);
  const servicesById = new Map(services.map((service) => [service.id, service]));
  const hotels = (hotelsRes.data ?? []) as Array<{ id: string; name: string | null; zone: string | null }>;
  const vehiclesByLabel = new Map(((vehiclesRes.data ?? []) as Vehicle[]).map((vehicle) => [norm(vehicle.label), vehicle]));
  const assignmentsByGroup = new Map<string, Assignment[]>();
  for (const assignment of assignments) {
    if (!assignment.group_id) continue;
    assignmentsByGroup.set(assignment.group_id, [...(assignmentsByGroup.get(assignment.group_id) ?? []), assignment]);
  }
  const servicesByGroup = new Map<string, Service[]>();
  for (const group of groups) {
    servicesByGroup.set(group.id, (assignmentsByGroup.get(group.id) ?? []).map((assignment) => servicesById.get(assignment.service_id)).filter((service): service is Service => Boolean(service)));
  }
  const clusters = detectExcursionRoundtripClusters({ services, hotels });
  const mortella = clusters.find((cluster) => norm(cluster.label).includes("MORTELLA")) ?? null;
  const mortellaIds = new Set(mortella?.service_ids ?? []);
  const mortellaGroupIds = new Set(assignments.filter((assignment) => mortellaIds.has(assignment.service_id)).map((assignment) => assignment.group_id).filter((id): id is string => Boolean(id)));
  const confirmedByGroup = new Map<string, Set<string>>();
  for (const decision of decisions) {
    if (!decision.trip_group_id) continue;
    const set = confirmedByGroup.get(decision.trip_group_id) ?? new Set<string>();
    set.add(decision.action);
    confirmedByGroup.set(decision.trip_group_id, set);
  }

  const units: Unit[] = [];
  if (mortella && mortellaGroupIds.size > 0) {
    const clusterServices = services.filter((service) => mortellaIds.has(service.id));
    const unit = makeUnit({
      id: mortella.cluster_id,
      groupIds: [...mortellaGroupIds],
      services: clusterServices,
      stops: serviceStops({ services: clusterServices, hotels }),
      type: "cluster_escursione_roundtrip",
      group: groups.find((group) => mortellaGroupIds.has(group.id)) ?? null,
      drivers,
      vehiclesByLabel,
      confirmedActions: new Set(),
    });
    unit.pax = mortella.total_pax;
    unit.min_vehicle_capacity = mortella.total_pax;
    units.push(unit);
  }
  for (const group of groups) {
    if (mortellaGroupIds.has(group.id)) continue;
    const groupServices = servicesByGroup.get(group.id) ?? [];
    const stops = serviceStops({ services: groupServices, hotels });
    const confirmedActions = confirmedByGroup.get(group.id) ?? new Set<string>();
    const type = unitTypeFromStops(stops, confirmedActions);
    const splitShuttleUnits = splitDenseShuttleUnits({
      group,
      groupServices,
      stops,
      type,
      drivers,
      vehiclesByLabel,
      confirmedActions,
    });
    if (splitShuttleUnits) {
      units.push(...splitShuttleUnits);
      continue;
    }
    units.push(makeUnit({
      id: group.id,
      groupIds: [group.id],
      services: groupServices,
      stops,
      type,
      group,
      drivers,
      vehiclesByLabel,
      confirmedActions,
    }));
  }

  const plannerDrivers = drivers.map((driver) => plannerDriver(driver, availability)).filter((driver): driver is GlobalPlannerDriver => Boolean(driver));
  const plannerVehicles = vehicles.map(plannerVehicle);
  const proposedDepth2 = assignGlobalPlanner({
    units,
    drivers: plannerDrivers,
    vehicles: plannerVehicles,
    enableBacktracking: true,
    backtrackingMaxDepth: 2,
    backtrackingLocalWindowMinutes: 45,
  }) as ProposedAssignment[];
  const proposed = assignGlobalPlanner({
    units,
    drivers: plannerDrivers,
    vehicles: plannerVehicles,
    enableBacktracking: true,
    backtrackingMaxDepth: 3,
    backtrackingLocalWindowMinutes: 75,
  }) as ProposedAssignment[];
  const diagDepth2 = diagnostics(proposedDepth2, drivers, vehicles, availability);
  const diag = diagnostics(proposed, drivers, vehicles, availability);
  const changes = proposed
    .filter((unit) => unit.assigned)
    .filter((unit) => unit.current_driver_key !== unit.proposed_driver_key || norm(unit.current_vehicle_label) !== norm(unit.proposed_vehicle_label))
    .map((unit) => ({
      giro: unit.label,
      group_ids: unit.group_ids,
      da_autista: unit.current_driver_name,
      a_autista: unit.proposed_driver_name,
      da_mezzo: unit.current_vehicle_label,
      a_mezzo: unit.proposed_vehicle_label,
      motivo: unit.reason,
    }));
  const unassignedAudits = proposed
    .filter((unit) => !unit.assigned)
    .map((unit) => {
      const audit = candidateAuditForUnit({ unit, plan: proposed, drivers, vehicles, availability });
      return {
        detail: {
          ora: `${unit.start}-${unit.end}`,
          unita: unit.label,
          pax: unit.pax,
          tipo: unit.type,
          pickup_destinazione: unit.stops,
          durata_stimata_min: (minutes(unit.end) ?? 0) - (minutes(unit.start) ?? 0),
          motivo_non_assegnata: unit.blocker,
        },
        candidate_audit: audit,
        classification: classifyUnassigned(unit, audit),
      };
    });
  const unassignedByClassification = Object.entries(Object.groupBy(unassignedAudits, (row) => row.classification))
    .map(([key, value]) => [key, value?.length ?? 0]);

  console.log(JSON.stringify({
    tenant,
    date: DATE,
    config: {
      buffer_minutes: BUFFER_MINUTES,
      backtracking_depth_2: {
        max_depth: 2,
        local_window_minutes: 45,
        needs_review_after: diagDepth2.needs_review_after,
        total_conflicts_after: diagDepth2.total_conflicts_after,
        driver_conflicts_after: diagDepth2.driver_conflicts_after,
        vehicle_conflicts_after: diagDepth2.vehicle_conflicts_after,
      },
      backtracking_depth_3: {
        max_depth: 3,
        local_window_minutes: 75,
      },
      available_drivers: drivers.map((driver) => ({
        name: driver.full_name,
        max_vehicle_capacity: driver.max_vehicle_capacity,
        availability: availabilityFor(driver, availability),
      })),
      available_vehicles: vehicles.map((vehicle) => ({ label: vehicle.label, capacity: vehicle.capacity })),
    },
    reconstructed_units: {
      total: units.length,
      by_type: Object.fromEntries(Object.entries(Object.groupBy(units, (unit) => unit.type)).map(([key, value]) => [key, value?.length ?? 0])),
      sample: units.slice().sort((a, b) => (minutes(a.start) ?? 9999) - (minutes(b.start) ?? 9999)).slice(0, 25).map((unit) => ({
        orario: `${unit.start}-${unit.end}`,
        type: unit.type,
        label: unit.label,
        pax: unit.pax,
        nonsplittable: unit.nonsplittable,
        min_vehicle_capacity: unit.min_vehicle_capacity,
        current_driver: unit.current_driver_name,
        current_vehicle: unit.current_vehicle_label,
      })),
    },
    proposed_plan: proposed.map((unit) => ({
      orario: `${unit.start}-${unit.end}`,
      unita_operativa: unit.label,
      tipo: unit.type,
      pax: unit.pax,
      autista_proposto: unit.proposed_driver_name,
      mezzo_proposto: unit.proposed_vehicle_label,
      motivo: unit.assigned ? unit.reason : unit.blocker,
    })),
    changes,
    conflicts_after: diag,
    blockers: proposed.filter((unit) => !unit.assigned).map((unit) => ({
      orario: `${unit.start}-${unit.end}`,
      unita_operativa: unit.label,
      pax: unit.pax,
      min_vehicle_capacity: unit.min_vehicle_capacity,
      blocker: unit.blocker,
    })),
    unassigned_audit: unassignedAudits,
    unassigned_by_classification: Object.fromEntries(unassignedByClassification),
    evaluation: {
      automatically_resolvable: diag.total_conflicts_after === 0
        && diag.driver_vehicle_eligibility_blockers_after === 0
        && diag.driver_availability_blockers_after === 0
        && diag.overbooking_after === 0,
      changes_required: changes.length,
      real_blockers_remaining: proposed.filter((unit) => !unit.assigned).length,
      false_blockers_from_previous_plan: "eligibility/capacity blockers from current assignments are removed when global reassignment finds compatible slots",
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : JSON.stringify(error, null, 2));
  process.exit(1);
});
