/**
 * GET /api/ops/piano-giorno/global-planner-preview?date=YYYY-MM-DD
 *
 * Read-only preview del Global Planner.
 * Carica tutti i dati nella route, li passa ad assignGlobalPlanner, e restituisce
 * il piano proposto con summary diagnostico e delta rispetto all'assegnazione corrente.
 * NON scrive DB.
 */
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { listDriverRegistry, type DriverRegistryEntry } from "@/lib/server/driver-registry";
import { loadConfirmedOperatorDecisions } from "@/lib/server/piano-operator-decisions";
import { canDriverCoverInterval } from "@/lib/piano-driver-availability";
import { canDriverUseVehicle } from "@/lib/piano-driver-vehicle-eligibility";
import { resolveAssignableService } from "@/lib/piano-assignable-service";
import { detectExcursionRoundtripClusters } from "@/lib/piano-excursion-roundtrip-cluster";
import {
  assignGlobalPlanner,
  type GlobalPlannerAssignment,
  type GlobalPlannerDriver,
  type GlobalPlannerUnit,
  type GlobalPlannerVehicle,
} from "@/lib/piano-global-planner";
import {
  calculateOperationalDuration,
  isOperationalShuttleLike,
  type OperationalDurationResult,
} from "@/lib/piano-operational-duration";
import { mergeSameStops, type ResolvedServiceForSameStop } from "@/lib/piano-same-stop-merge";

export const runtime = "nodejs";

// ─── Local DB row types ──────────────────────────────────────────────────────

type GroupRow = {
  id: string;
  date: string;
  driver_user_id: string | null;
  driver_profile_id: string | null;
  vehicle_label: string | null;
  vehicle_capacity: number | null;
  status: string | null;
};

type AssignmentRow = {
  id: string;
  service_id: string;
  group_id: string | null;
  driver_user_id: string | null;
  driver_profile_id: string | null;
  vehicle_label: string | null;
};

type ServiceRow = {
  id: string;
  date?: string | null;
  time?: string | null;
  time_from?: string | null;
  time_to?: string | null;
  direction?: string | null;
  customer_name?: string | null;
  pax?: number | null;
  hotel_id?: string | null;
  vessel?: string | null;
  notes?: string | null;
  status?: string | null;
  meeting_point?: string | null;
  place_type?: string | null;
  pickup_hotel?: string | null;
  booking_service_kind?: string | null;
  service_type?: string | null;
  service_type_code?: string | null;
  transport_code?: string | null;
  ferry_details?: Record<string, unknown> | null;
  excursion_details?: Record<string, unknown> | null;
  tour_name?: string | null;
  pickup_time?: string | null;
  arrival_time?: string | null;
  departure_time?: string | null;
  origin_place_type?: string | null;
  destination_place_type?: string | null;
  route_kind?: string | null;
  origin_place_id?: string | null;
  destination_place_id?: string | null;
  origin_label_raw?: string | null;
  destination_label_raw?: string | null;
};

type VehicleRow = {
  id: string;
  label: string | null;
  capacity: number | null;
  active: boolean | null;
};

type AvailabilityRow = {
  driver_profile_id: string | null;
  driver_user_id: string | null;
  available: boolean | null;
  available_from: string | null;
  available_to: string | null;
};

type HotelRow = {
  id: string;
  name: string | null;
  zone: string | null;
};

type UnitType =
  | "giro_singolo"
  | "same_stop"
  | "multi_drop_confirmed"
  | "accorpamento_confirmed"
  | "shuttle_pair"
  | "cluster_escursione_roundtrip"
  | "navetta_speciale";

// RouteUnit extends GlobalPlannerUnit with fields needed for output and diagnostics
type RouteUnit = GlobalPlannerUnit & {
  type: UnitType;
  group_ids: string[];
  service_ids: string[];
  current_driver_name: string | null;
  current_vehicle_capacity: number | null;
  duration_minutes: number;
  duration_reason: string;
  duration_source: OperationalDurationResult["source"] | "fallback";
  duration_warnings: string[];
  pickup: string | null;
  destinations: string[];
  needs_review: boolean;
};

type ProposedUnit = GlobalPlannerAssignment<RouteUnit>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function groupDriverKey(group: Pick<GroupRow, "driver_profile_id" | "driver_user_id">) {
  return group.driver_profile_id
    ? `profile:${group.driver_profile_id}`
    : group.driver_user_id
      ? `user:${group.driver_user_id}`
      : null;
}

function driverKey(driver: Pick<DriverRegistryEntry, "id" | "user_id">) {
  return driver.id ? `profile:${driver.id}` : driver.user_id ? `user:${driver.user_id}` : null;
}

function driverNameForGroup(group: GroupRow, drivers: DriverRegistryEntry[]) {
  if (group.driver_profile_id) {
    return drivers.find((d) => d.id === group.driver_profile_id)?.full_name ?? null;
  }
  if (group.driver_user_id) {
    return drivers.find((d) => d.user_id === group.driver_user_id)?.full_name ?? null;
  }
  return null;
}

function availabilityFor(driver: DriverRegistryEntry, availability: AvailabilityRow[]) {
  const row =
    availability.find((a) => a.driver_profile_id === driver.id) ??
    (driver.user_id ? availability.find((a) => a.driver_user_id === driver.user_id) : null) ??
    null;
  return row
    ? { available: row.available, available_from: row.available_from, available_to: row.available_to, blocks: [] }
    : null;
}

function vehicleBlockedOnDate(block: Record<string, unknown>, date: string) {
  const singleDate = String(block.date ?? "").slice(0, 10);
  if (singleDate) return singleDate === date;
  const from = String(block.blocked_from ?? block.block_from ?? "").slice(0, 10);
  const until = String(block.blocked_until ?? block.block_to ?? "").slice(0, 10);
  return Boolean(from && until && from <= date && until >= date);
}

function availableVehicles(args: {
  vehicles: VehicleRow[];
  vehicleAvailability: Array<{ vehicle_id: string | null; available: boolean | null }>;
  blocks: Array<Record<string, unknown>>;
  date: string;
}) {
  const availability = new Map(args.vehicleAvailability.map((row) => [row.vehicle_id, row.available]));
  const blocked = new Set(
    args.blocks.filter((b) => vehicleBlockedOnDate(b, args.date)).map((b) => b.vehicle_id),
  );
  return args.vehicles
    .filter((v) => v.active !== false)
    .filter((v) => availability.get(v.id) !== false)
    .filter((v) => !blocked.has(v.id))
    .sort((a, b) => (a.capacity ?? 999) - (b.capacity ?? 999) || String(a.label).localeCompare(String(b.label)));
}

function serviceStops(args: {
  services: ServiceRow[];
  hotels: HotelRow[];
}): ResolvedServiceForSameStop[] {
  const hotelById = new Map(args.hotels.map((h) => [h.id, h]));
  return args.services.map((service) => {
    const resolution = resolveAssignableService(service, {
      hotel: service.hotel_id ? (hotelById.get(service.hotel_id) ?? null) : null,
    });
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
  if (isOperationalShuttleLike(stops)) {
    const times = stops
      .map((s) => minutes(s.operational_time))
      .filter((v): v is number => v != null);
    const span = times.length ? Math.max(...times) - Math.min(...times) : 0;
    return stops.length > 1 && span <= 10 ? "shuttle_pair" : "navetta_speciale";
  }
  const merged = mergeSameStops(stops.filter((s) => s.assignable && !s.needs_review));
  if (merged.some((s) => s.is_merged)) return "same_stop";
  return "giro_singolo";
}

function unitDurationMinutes(unit: Pick<RouteUnit, "start" | "end">) {
  const s = minutes(unit.start);
  const e = minutes(unit.end);
  return s == null || e == null ? 30 : Math.max(1, e - s);
}

function buildDurationWarnings(dur: OperationalDurationResult): string[] {
  const warnings = [...dur.warnings];
  if (dur.source !== "route_duration_config") {
    warnings.push(
      `Nessuna route-duration config: durata stimata ${dur.duration_minutes} min da default (${dur.reason}).`,
    );
  }
  return warnings;
}

function makeUnit(args: {
  id: string;
  groupIds: string[];
  services: ServiceRow[];
  stops: ResolvedServiceForSameStop[];
  type: UnitType;
  group: GroupRow | null;
  drivers: DriverRegistryEntry[];
  vehiclesByLabel: Map<string, VehicleRow>;
  confirmedActions: Set<string>;
}): RouteUnit {
  const times = args.stops
    .map((s) => minutes(s.operational_time))
    .filter((v): v is number => v != null);
  const startMin = times.length ? Math.min(...times) : null;
  const pax = args.stops.reduce((sum, s) => sum + (Number(s.pax) || 0), 0);

  // No route-duration config — source will be "unit_type_default" or "service_kind_config"
  const dur = calculateOperationalDuration({
    type: args.type,
    stops: args.stops,
    defaultDurationMinutes: 30,
    defaultBufferMinutes: 5,
    pax,
  });

  const endMin = startMin != null ? startMin + dur.duration_minutes : null;
  const currentVehicle = args.group?.vehicle_label
    ? (args.vehiclesByLabel.get(norm(args.group.vehicle_label)) ?? null)
    : null;
  const customers = [
    ...new Set(
      args.services
        .map((s) => String(s.customer_name ?? "").replace(/\s+/g, " ").trim())
        .filter(Boolean),
    ),
  ];
  const uniqueDestinations = [
    ...new Set(args.stops.map((s) => s.destination_label).filter((d): d is string => Boolean(d))),
  ];

  return {
    id: args.id,
    type: args.type,
    label: customers.length ? customers.join(" / ") : args.type,
    group_ids: args.groupIds,
    service_ids: args.services.map((s) => s.id).sort(),
    start: hhmm(startMin),
    end: hhmm(endMin),
    pax,
    nonsplittable: true,
    min_vehicle_capacity: pax,
    buffer_minutes: dur.buffer_minutes,
    current_driver_key: args.group ? groupDriverKey(args.group) : null,
    current_driver_name: args.group ? driverNameForGroup(args.group, args.drivers) : null,
    current_vehicle_label: args.group?.vehicle_label ?? null,
    current_vehicle_capacity: args.group?.vehicle_capacity ?? currentVehicle?.capacity ?? null,
    duration_minutes: dur.duration_minutes,
    duration_reason: dur.reason,
    duration_source: dur.source === "route_duration_config" ? "route_duration_config" : "fallback",
    duration_warnings: buildDurationWarnings(dur),
    pickup: args.stops[0]?.pickup_label ?? null,
    destinations: uniqueDestinations,
    needs_review: args.stops.some((s) => s.needs_review || !s.assignable),
    locked: args.confirmedActions.size > 0 || args.type === "cluster_escursione_roundtrip",
    protected_from_backtracking: args.type === "cluster_escursione_roundtrip" || pax >= 21,
    dense_shuttle: isOperationalShuttleLike(args.stops),
  };
}

function splitDenseShuttleUnits(args: {
  group: GroupRow;
  groupServices: ServiceRow[];
  stops: ResolvedServiceForSameStop[];
  type: UnitType;
  drivers: DriverRegistryEntry[];
  vehiclesByLabel: Map<string, VehicleRow>;
  confirmedActions: Set<string>;
}): RouteUnit[] | null {
  if (args.type !== "navetta_speciale" || args.confirmedActions.size > 0) return null;
  if (args.stops.length <= 1 || !args.stops.every((s) => isOperationalShuttleLike([s]))) return null;

  const ordered = args.stops
    .map((stop, index) => ({ stop, service: args.groupServices[index] }))
    .filter((item): item is { stop: ResolvedServiceForSameStop; service: ServiceRow } =>
      Boolean(item.service),
    )
    .sort(
      (a, b) =>
        (minutes(a.stop.operational_time) ?? 9999) - (minutes(b.stop.operational_time) ?? 9999),
    );
  if (ordered.length <= 1) return null;

  const span =
    (minutes(ordered[ordered.length - 1]!.stop.operational_time) ?? 0) -
    (minutes(ordered[0]!.stop.operational_time) ?? 0);
  if (span <= 15) return null;

  return ordered.map((item, index) =>
    makeUnit({
      id: `${args.group.id}:navetta-cycle:${index + 1}`,
      groupIds: [args.group.id],
      services: [item.service],
      stops: [item.stop],
      type: "navetta_speciale",
      group: args.group,
      drivers: args.drivers,
      vehiclesByLabel: args.vehiclesByLabel,
      confirmedActions: args.confirmedActions,
    }),
  );
}

function plannerDriver(driver: DriverRegistryEntry, availability: AvailabilityRow[]): GlobalPlannerDriver | null {
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

function plannerVehicle(vehicle: VehicleRow): GlobalPlannerVehicle {
  return { key: norm(vehicle.label ?? vehicle.id), label: vehicle.label, capacity: vehicle.capacity };
}

function overlapsWithBuffer(
  a: Pick<RouteUnit, "start" | "end" | "buffer_minutes">,
  b: Pick<RouteUnit, "start" | "end" | "buffer_minutes">,
) {
  const as = minutes(a.start);
  const ae = minutes(a.end);
  const bs = minutes(b.start);
  const be = minutes(b.end);
  if (as == null || ae == null || bs == null || be == null) return true;
  const buf = Math.min(a.buffer_minutes ?? 5, b.buffer_minutes ?? 5);
  return as < be + buf && ae + buf > bs;
}

function diagnostics(args: {
  plan: ProposedUnit[];
  drivers: DriverRegistryEntry[];
  vehicles: VehicleRow[];
  availability: AvailabilityRow[];
}) {
  const driverByKey = new Map(args.drivers.map((d) => [driverKey(d), d]));
  const vehicleByLabel = new Map(args.vehicles.map((v) => [norm(v.label), v]));
  let driverConflicts = 0;
  let vehicleConflicts = 0;
  let eligibilityBlockers = 0;
  let availabilityBlockers = 0;
  let overbooking = 0;

  const assigned = args.plan.filter((u) => u.assigned);
  for (let i = 0; i < assigned.length; i += 1) {
    const left = assigned[i]!;
    const driver = left.proposed_driver_key ? (driverByKey.get(left.proposed_driver_key) ?? null) : null;
    const vehicle = left.proposed_vehicle_label
      ? (vehicleByLabel.get(norm(left.proposed_vehicle_label)) ?? null)
      : null;

    if (
      !driver ||
      !vehicle ||
      !canDriverUseVehicle(driver, vehicle, { blockUnknownVehicleCapacity: true }).allowed
    ) {
      eligibilityBlockers += 1;
    }
    if (vehicle && left.pax > (vehicle.capacity ?? 0)) overbooking += 1;
    if (
      driver &&
      !canDriverCoverInterval(
        availabilityFor(driver, args.availability),
        { start_time: left.start, end_time: left.end },
        {
          missingAvailability: "blocker",
          missingBounds: "warning",
          defaultDurationMinutes: unitDurationMinutes(left),
        },
      ).allowed
    ) {
      availabilityBlockers += 1;
    }

    for (let j = i + 1; j < assigned.length; j += 1) {
      const right = assigned[j]!;
      if (!overlapsWithBuffer(left, right)) continue;
      if (left.proposed_driver_key && left.proposed_driver_key === right.proposed_driver_key) driverConflicts += 1;
      if (
        norm(left.proposed_vehicle_label) &&
        norm(left.proposed_vehicle_label) === norm(right.proposed_vehicle_label)
      ) {
        vehicleConflicts += 1;
      }
    }
  }

  return {
    total_conflicts: driverConflicts + vehicleConflicts + args.plan.filter((u) => !u.assigned).length,
    driver_conflicts: driverConflicts,
    vehicle_conflicts: vehicleConflicts,
    eligibility_blockers: eligibilityBlockers,
    availability_blockers: availabilityBlockers,
    overbooking,
    needs_review: args.plan.filter((u) => u.needs_review || !u.assigned).length,
  };
}

// Resilient service loading: removes unknown columns until query succeeds
async function loadServices(
  admin: SupabaseClient,
  tenantId: string,
  ids: string[],
): Promise<ServiceRow[]> {
  if (ids.length === 0) return [];
  let columns = [
    "id", "date", "time", "time_from", "time_to", "direction", "customer_name", "pax", "hotel_id",
    "vessel", "notes", "status", "meeting_point", "place_type", "pickup_hotel",
    "booking_service_kind", "service_type", "service_type_code", "transport_code",
    "ferry_details", "excursion_details", "tour_name", "pickup_time", "arrival_time",
    "departure_time", "origin_place_type", "destination_place_type",
    "route_kind", "origin_place_id", "destination_place_id",
    "origin_label_raw", "destination_label_raw",
  ];
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const result = await admin
      .from("services")
      .select(columns.join(","))
      .eq("tenant_id", tenantId)
      .in("id", ids);
    if (!result.error) return (result.data ?? []) as ServiceRow[];
    const message = result.error.message;
    const missing =
      message.match(/Could not find the '([^']+)' column/)?.[1] ??
      message.match(/column (?:public\.)?services\.([a-zA-Z0-9_]+) does not exist/)?.[1] ??
      message.match(/column "([a-zA-Z0-9_]+)" does not exist/)?.[1] ??
      null;
    if (!missing || !columns.includes(missing)) throw result.error;
    columns = columns.filter((c) => c !== missing);
  }
  throw new Error("Impossibile caricare servizi dopo 25 tentativi di schema discovery.");
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const { searchParams } = new URL(request.url);
    const date = searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "Parametro date non valido (atteso YYYY-MM-DD)." }, { status: 400 });
    }

    const tenantId = auth.membership.tenant_id;
    const admin = auth.admin;

    // ── 1. Parallel data loading ──────────────────────────────────────────────

    const [
      driversAll,
      hotelsRes,
      groupsRes,
      assignmentsRes,
      vehiclesRes,
      vehicleAvailRes,
      vehicleBlocksRes,
      driverAvailRes,
      decisions,
    ] = await Promise.all([
      listDriverRegistry(admin, tenantId, { activeOnly: true }),
      admin.from("hotels").select("id,name,zone").eq("tenant_id", tenantId),
      admin
        .from("trip_groups")
        .select("id,date,driver_user_id,driver_profile_id,vehicle_label,vehicle_capacity,status")
        .eq("tenant_id", tenantId)
        .eq("date", date)
        .eq("status", "active"),
      admin
        .from("assignments")
        .select("id,service_id,group_id,driver_user_id,driver_profile_id,vehicle_label")
        .eq("tenant_id", tenantId),
      admin.from("vehicles").select("id,label,capacity,active").eq("tenant_id", tenantId).order("label"),
      admin
        .from("vehicle_daily_availability")
        .select("vehicle_id,available")
        .eq("tenant_id", tenantId)
        .eq("date", date),
      admin.from("vehicle_time_blocks").select("*").eq("tenant_id", tenantId),
      admin
        .from("driver_daily_availability")
        .select("driver_profile_id,driver_user_id,available,available_from,available_to")
        .eq("tenant_id", tenantId)
        .eq("date", date),
      loadConfirmedOperatorDecisions(
        { admin, user: auth.user, membership: auth.membership },
        date,
      ),
    ]);

    const dbErrors = Object.entries({
      hotels: hotelsRes.error,
      trip_groups: groupsRes.error,
      assignments: assignmentsRes.error,
      vehicles: vehiclesRes.error,
      vehicle_daily_availability: vehicleAvailRes.error,
      vehicle_time_blocks: vehicleBlocksRes.error,
      driver_daily_availability: driverAvailRes.error,
    })
      .filter(([, err]) => err)
      .map(([name, err]) => `${name}: ${err!.message}`);
    if (dbErrors.length > 0) {
      return NextResponse.json({ error: dbErrors.join("; ") }, { status: 500 });
    }

    // ── 2. Filter available drivers ───────────────────────────────────────────

    const availability = (driverAvailRes.data ?? []) as AvailabilityRow[];
    const availableDriverKeys = new Set(
      availability
        .filter((row) => row.available !== false)
        .map((row) =>
          row.driver_profile_id
            ? `profile:${row.driver_profile_id}`
            : row.driver_user_id
              ? `user:${row.driver_user_id}`
              : null,
        )
        .filter((k): k is string => k != null),
    );
    const drivers = driversAll.filter((d) => availableDriverKeys.has(driverKey(d) ?? ""));

    const vehicles = availableVehicles({
      vehicles: (vehiclesRes.data ?? []) as VehicleRow[],
      vehicleAvailability: (vehicleAvailRes.data ?? []) as Array<{ vehicle_id: string | null; available: boolean | null }>,
      blocks: (vehicleBlocksRes.data ?? []) as Array<Record<string, unknown>>,
      date,
    });

    // ── 3. Reconstruct operational units ─────────────────────────────────────

    const groups = (groupsRes.data ?? []) as GroupRow[];
    const groupIds = new Set(groups.map((g) => g.id));
    const allAssignments = (assignmentsRes.data ?? []) as AssignmentRow[];
    const assignments = allAssignments.filter((a) => a.group_id && groupIds.has(a.group_id));
    const hotels = (hotelsRes.data ?? []) as HotelRow[];
    const vehiclesByLabel = new Map(
      ((vehiclesRes.data ?? []) as VehicleRow[]).map((v) => [norm(v.label), v]),
    );

    const services = await loadServices(
      admin,
      tenantId,
      [...new Set(assignments.map((a) => a.service_id))],
    );
    const servicesById = new Map(services.map((s) => [s.id, s]));

    const assignmentsByGroup = new Map<string, AssignmentRow[]>();
    for (const a of assignments) {
      if (!a.group_id) continue;
      assignmentsByGroup.set(a.group_id, [...(assignmentsByGroup.get(a.group_id) ?? []), a]);
    }
    const servicesByGroup = new Map<string, ServiceRow[]>();
    for (const group of groups) {
      servicesByGroup.set(
        group.id,
        (assignmentsByGroup.get(group.id) ?? [])
          .map((a) => servicesById.get(a.service_id))
          .filter((s): s is ServiceRow => Boolean(s)),
      );
    }

    // Confirmed operator decisions by group
    const confirmedByGroup = new Map<string, Set<string>>();
    for (const decision of decisions) {
      if (!decision.trip_group_id) continue;
      const set = confirmedByGroup.get(decision.trip_group_id) ?? new Set<string>();
      set.add(decision.action);
      confirmedByGroup.set(decision.trip_group_id, set);
    }

    // Excursion roundtrip clusters (Mortella-style)
    const clusters = detectExcursionRoundtripClusters({ services, hotels });
    const clusterServiceIds = new Set(clusters.flatMap((c) => c.service_ids));
    const clusterGroupIds = new Set(
      assignments
        .filter((a) => clusterServiceIds.has(a.service_id))
        .map((a) => a.group_id)
        .filter((id): id is string => Boolean(id)),
    );

    const units: RouteUnit[] = [];

    // Add cluster units
    for (const cluster of clusters) {
      const cGroupIds = assignments
        .filter((a) => cluster.service_ids.includes(a.service_id) && a.group_id)
        .map((a) => a.group_id!)
        .filter((id) => groupIds.has(id));
      if (cGroupIds.length === 0) continue;
      const uniqueGroupIds = [...new Set(cGroupIds)];
      const clusterServices = services.filter((s) => cluster.service_ids.includes(s.id));
      const unit = makeUnit({
        id: cluster.cluster_id,
        groupIds: uniqueGroupIds,
        services: clusterServices,
        stops: serviceStops({ services: clusterServices, hotels }),
        type: "cluster_escursione_roundtrip",
        group: groups.find((g) => uniqueGroupIds.includes(g.id)) ?? null,
        drivers,
        vehiclesByLabel,
        confirmedActions: new Set(),
      });
      unit.pax = cluster.total_pax;
      unit.min_vehicle_capacity = cluster.total_pax;
      units.push(unit);
    }

    // Add per-group units
    for (const group of groups) {
      if (clusterGroupIds.has(group.id)) continue;
      const groupServices = servicesByGroup.get(group.id) ?? [];
      const stops = serviceStops({ services: groupServices, hotels });
      const confirmedActions = confirmedByGroup.get(group.id) ?? new Set<string>();
      const type = unitTypeFromStops(stops, confirmedActions);

      const splitUnits = splitDenseShuttleUnits({
        group,
        groupServices,
        stops,
        type,
        drivers,
        vehiclesByLabel,
        confirmedActions,
      });
      if (splitUnits) {
        units.push(...splitUnits);
        continue;
      }
      units.push(
        makeUnit({
          id: group.id,
          groupIds: [group.id],
          services: groupServices,
          stops,
          type,
          group,
          drivers,
          vehiclesByLabel,
          confirmedActions,
        }),
      );
    }

    // ── 4. Run global planner ────────────────────────────────────────────────

    const plannerDrivers = drivers
      .map((d) => plannerDriver(d, availability))
      .filter((d): d is GlobalPlannerDriver => d != null);
    const plannerVehicles = vehicles.map(plannerVehicle);

    const proposed = assignGlobalPlanner({
      units,
      drivers: plannerDrivers,
      vehicles: plannerVehicles,
      enableBacktracking: true,
      backtrackingMaxDepth: 3,
      backtrackingLocalWindowMinutes: 75,
    }) as ProposedUnit[];

    // ── 5. Diagnostics ───────────────────────────────────────────────────────

    const diag = diagnostics({
      plan: proposed,
      drivers,
      vehicles: (vehiclesRes.data ?? []) as VehicleRow[],
      availability,
    });

    // ── 6. Build output ──────────────────────────────────────────────────────

    const changes = proposed
      .filter((u) => u.assigned)
      .filter(
        (u) =>
          u.current_driver_key !== u.proposed_driver_key ||
          norm(u.current_vehicle_label) !== norm(u.proposed_vehicle_label),
      )
      .map((u) => ({
        giro: u.label,
        da_autista: u.current_driver_name,
        a_autista: u.proposed_driver_name,
        da_mezzo: u.current_vehicle_label,
        a_mezzo: u.proposed_vehicle_label,
        motivo: u.reason,
      }));

    const blockers = proposed
      .filter((u) => !u.assigned)
      .map((u) => ({
        unit_id: u.id,
        orario: `${u.start ?? "??"}–${u.end ?? "??"}`,
        tipo_operativo: u.type,
        pax: u.pax,
        pickup: u.pickup,
        destinazione: u.destinations.join(" / ") || null,
        motivo_blocker: u.blocker ?? "NO_COMPATIBLE_SLOT",
        warnings: u.duration_warnings,
      }));

    const outputUnits = proposed.map((u) => ({
      unit_id: u.id,
      orario: `${u.start ?? "??"}–${u.end ?? "??"}`,
      tipo_operativo: u.type,
      pax: u.pax,
      pickup: u.pickup,
      destinazione: u.destinations.join(" / ") || null,
      autista_proposto: u.proposed_driver_name,
      mezzo_proposto: u.proposed_vehicle_label,
      motivo: u.assigned ? u.reason : (u.blocker ?? "NO_COMPATIBLE_SLOT"),
      assigned: u.assigned,
      needs_review: u.needs_review,
      duration_source: u.duration_source,
      warnings: u.duration_warnings,
    }));

    return NextResponse.json({
      date,
      summary: {
        total_units: proposed.length,
        assigned_units: proposed.filter((u) => u.assigned).length,
        needs_review: diag.needs_review,
        total_conflicts: diag.total_conflicts,
        driver_conflicts: diag.driver_conflicts,
        vehicle_conflicts: diag.vehicle_conflicts,
        eligibility_blockers: diag.eligibility_blockers,
        availability_blockers: diag.availability_blockers,
        overbooking: diag.overbooking,
      },
      units: outputUnits,
      changes_vs_current: changes,
      ...(blockers.length > 0 ? { operator_required: blockers } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
