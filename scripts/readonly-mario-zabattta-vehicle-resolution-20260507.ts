import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { canDriverUseVehicle } from "@/lib/piano-driver-vehicle-eligibility";
import { canDriverCoverInterval } from "@/lib/piano-driver-availability";
import { buildHybridVehicleBinding } from "@/lib/piano-hybrid-vehicle-binding";
import { resolveAssignableService, type AssignableService } from "@/lib/piano-assignable-service";
import { detectShuttlePairs } from "@/lib/piano-shuttle-pair";
import { mergeSameStops, type ResolvedServiceForSameStop } from "@/lib/piano-same-stop-merge";
import { analyzeGiro } from "@/lib/piano-conflict-classifier";
import { listDriverRegistry, normalizeDriverName, type DriverRegistryEntry } from "@/lib/server/driver-registry";

const DATE = "2026-05-07";
const WINDOW_START = "17:00";
const WINDOW_END = "19:30";

type SupabaseAdmin = ReturnType<typeof createClient>;

type TripGroup = {
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

type Service = AssignableService & { date?: string | null; status?: string | null };
type Vehicle = { id: string; label: string | null; capacity: number | null; active: boolean | null };
type Availability = {
  driver_profile_id: string | null;
  driver_user_id: string | null;
  available: boolean | null;
  available_from: string | null;
  available_to: string | null;
};

type GroupPlan = {
  group_id: string;
  driver_key: string | null;
  driver_name: string | null;
  vehicle_label: string | null;
  vehicle_capacity: number | null;
  start_time: string | null;
  end_time: string | null;
  pax: number;
  service_ids: string[];
  customer_names: string[];
  stops: ResolvedServiceForSameStop[];
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

function overlaps(aStart: string | null, aEnd: string | null, bStart: string | null, bEnd: string | null) {
  const as = minutes(aStart);
  const ae = minutes(aEnd);
  const bs = minutes(bStart);
  const be = minutes(bEnd);
  return as != null && ae != null && bs != null && be != null && as < be && ae > bs;
}

function inWindow(plan: Pick<GroupPlan, "start_time" | "end_time">) {
  return overlaps(plan.start_time, plan.end_time, WINDOW_START, WINDOW_END);
}

function vehicleBlockedOnDate(block: Record<string, unknown>) {
  const singleDate = String(block.date ?? "").slice(0, 10);
  if (singleDate) return singleDate === DATE;
  const from = String(block.blocked_from ?? block.block_from ?? "").slice(0, 10);
  const until = String(block.blocked_until ?? block.block_to ?? "").slice(0, 10);
  return Boolean(from && until && from <= DATE && until >= DATE);
}

function driverKey(driver: Pick<DriverRegistryEntry, "id" | "user_id"> | null | undefined) {
  if (!driver) return null;
  return driver.id ? `profile:${driver.id}` : driver.user_id ? `user:${driver.user_id}` : null;
}

function groupDriverKey(group: TripGroup) {
  return group.driver_profile_id ? `profile:${group.driver_profile_id}` : group.driver_user_id ? `user:${group.driver_user_id}` : null;
}

function findMarioZabattta(drivers: DriverRegistryEntry[]) {
  return drivers.find((driver) => {
    const name = normalizeDriverName(driver.full_name).replace(/t{2,}/g, "tt");
    return name.includes("mario zabatta");
  }) ?? null;
}

function driverNameForGroup(group: TripGroup, drivers: DriverRegistryEntry[]) {
  if (group.driver_profile_id) return drivers.find((driver) => driver.id === group.driver_profile_id)?.full_name ?? null;
  if (group.driver_user_id) return drivers.find((driver) => driver.user_id === group.driver_user_id)?.full_name ?? null;
  return null;
}

function missingSchemaColumn(message: string) {
  return message.match(/Could not find the '([^']+)' column/)?.[1]
    ?? message.match(/column (?:public\.)?services\.([a-zA-Z0-9_]+) does not exist/)?.[1]
    ?? message.match(/column "([a-zA-Z0-9_]+)" does not exist/)?.[1]
    ?? null;
}

async function resolveTenant(admin: SupabaseAdmin) {
  const { data, error } = await admin.from("tenants").select("id,name").limit(50);
  if (error) throw error;
  const tenant = (data ?? []).find((row) => norm(row.name).includes("ISCHIA TRANSFER")) ?? data?.[0];
  if (!tenant?.id) throw new Error("Tenant non trovato.");
  return { id: tenant.id as string, name: tenant.name as string | null };
}

async function loadServices(admin: SupabaseAdmin, tenantId: string, ids: string[]) {
  const baseColumns = [
    "id",
    "date",
    "time",
    "time_from",
    "time_to",
    "direction",
    "customer_name",
    "pax",
    "hotel_id",
    "vessel",
    "notes",
    "status",
    "meeting_point",
    "place_type",
    "pickup_hotel",
    "booking_service_kind",
    "service_type",
  ];
  const optionalColumns = [
    "service_type_code",
    "transport_code",
    "orario_barca",
    "porto_bruno",
    "barca_compagnia",
    "ferry_details",
    "excursion_details",
    "tour_name",
    "pickup_time",
    "origin_place_type",
    "destination_place_type",
    "arrival_time",
    "departure_time",
  ];
  let columns = [...baseColumns, ...optionalColumns];
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const result = await admin.from("services").select(columns.join(",")).eq("tenant_id", tenantId).in("id", ids);
    if (!result.error) return (result.data ?? []) as Service[];
    const missing = missingSchemaColumn(result.error.message);
    if (!missing || !columns.includes(missing)) throw result.error;
    columns = columns.filter((column) => column !== missing);
  }
  throw new Error("Impossibile caricare servizi.");
}

function buildPlan(args: {
  group: TripGroup;
  assignments: Assignment[];
  servicesById: Map<string, Service>;
  hotels: Array<{ id: string; name: string | null; zone: string | null }>;
  drivers: DriverRegistryEntry[];
  vehicleByLabel: Map<string, Vehicle>;
}): GroupPlan {
  const hotelById = new Map(args.hotels.map((hotel) => [hotel.id, hotel]));
  const services = args.assignments.map((assignment) => args.servicesById.get(assignment.service_id)).filter((service): service is Service => Boolean(service));
  const stops = services.map((service) => {
    const resolution = resolveAssignableService(service, { hotel: service.hotel_id ? hotelById.get(service.hotel_id) ?? null : null });
    return {
      service_id: service.id,
      customer_name: service.customer_name ?? null,
      macro_category: resolution.macro_category,
      pickup_label: resolution.pickup_label,
      pickup_zone: resolution.pickup_zone,
      destination_label: resolution.destination_label,
      destination_zone: resolution.destination_zone,
      operational_time: resolution.operational_time,
      pax: resolution.pax,
      assignable: resolution.assignable,
      needs_review: resolution.needs_review,
    } satisfies ResolvedServiceForSameStop;
  });
  const times = stops.map((stop) => minutes(stop.operational_time)).filter((value): value is number => value != null);
  const start = times.length ? Math.min(...times) : null;
  const end = times.length ? Math.max(...times) + 30 : null;
  const vehicleLabel = args.group.vehicle_label ?? args.assignments.map((assignment) => assignment.vehicle_label).find(Boolean) ?? null;
  const vehicle = vehicleLabel ? args.vehicleByLabel.get(norm(vehicleLabel)) : null;
  return {
    group_id: args.group.id,
    driver_key: groupDriverKey(args.group),
    driver_name: driverNameForGroup(args.group, args.drivers),
    vehicle_label: vehicleLabel,
    vehicle_capacity: args.group.vehicle_capacity ?? vehicle?.capacity ?? null,
    start_time: hhmm(start),
    end_time: hhmm(end),
    pax: stops.reduce((sum, stop) => sum + (Number(stop.pax) || 0), 0),
    service_ids: services.map((service) => service.id).sort(),
    customer_names: [...new Set(services.map((service) => service.customer_name ?? "").filter(Boolean))].sort(),
    stops,
  };
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
    .map((vehicle) => ({ id: vehicle.id, label: vehicle.label, capacity: vehicle.capacity }));
}

function driverAvailabilityFor(driver: DriverRegistryEntry | null, availability: Availability[]) {
  if (!driver) return null;
  return availability.find((row) => row.driver_profile_id === driver.id)
    ?? (driver.user_id ? availability.find((row) => row.driver_user_id === driver.user_id) : null)
    ?? null;
}

function groupHasShuttleCycle(plan: GroupPlan) {
  const stops = mergeSameStops(plan.stops.filter((stop) => stop.assignable && !stop.needs_review));
  return detectShuttlePairs(stops, { enabledHotelNames: ["hotel terme president"], maxDeltaMinutes: 10 }).shuttle_pairs.length > 0;
}

function groupConflictCount(plan: GroupPlan) {
  const stops = mergeSameStops(plan.stops.filter((stop) => stop.assignable && !stop.needs_review));
  const shuttlePairs = detectShuttlePairs(stops, { enabledHotelNames: ["hotel terme president"], maxDeltaMinutes: 10 });
  const shuttleStopIds = new Set(shuttlePairs.shuttle_pairs.flatMap((pair) => [pair.outbound.stop_id, pair.inbound.stop_id]));
  const remainingStops = stops.filter((stop) => !stop.services.some((service) => shuttleStopIds.has(service.service_id)));
  const syntheticShuttleStops = shuttlePairs.shuttle_pairs.map((pair) => ({
    stop_id: pair.pair_id,
    macro_category: "NAVETTA" as const,
    operational_time: pair.start_time,
    pickup_label: pair.loop_label,
    pickup_zone: null,
    destination_labels: [pair.loop_label],
    destination_zones: [],
    total_pax: 0,
    services: [],
    is_merged: true,
    service_count: pair.outbound.services.length + pair.inbound.services.length,
  }));
  const analysis = analyzeGiro(plan.group_id, plan.driver_name, [...remainingStops, ...syntheticShuttleStops].sort((a, b) => a.operational_time.localeCompare(b.operational_time)));
  return analysis.conflict_count + analysis.overlap_count;
}

function summarizeDiagnostics(args: { plans: GroupPlan[]; drivers: DriverRegistryEntry[]; vehicles: Array<{ id: string; label: string | null; capacity: number | null }> }) {
  const driverByKey = new Map(args.drivers.map((driver) => [driverKey(driver), driver]));
  const availableDrivers = args.drivers.map((driver) => ({
    driver_key: driverKey(driver),
    driver_name: driver.full_name,
    max_vehicle_capacity: driver.max_vehicle_capacity,
  })).filter((driver): driver is { driver_key: string; driver_name: string; max_vehicle_capacity: number | null } => Boolean(driver.driver_key));
  const hybrid = buildHybridVehicleBinding({
    drivers: availableDrivers,
    vehicles: args.vehicles,
    trips: args.plans.map((plan) => ({
      group_id: plan.group_id,
      driver_key: plan.driver_key,
      driver_name: plan.driver_name,
      start_time: plan.start_time,
      end_time: plan.end_time,
      pax: plan.pax,
      current_vehicle_label: plan.vehicle_label,
    })),
    config: {
      largeGroupPaxThreshold: 21,
      minBufferMinutes: 20,
      preferFixedVehicleForStandardTrips: true,
    },
  });
  const invalid = args.plans.filter((plan) => {
    const driver = driverByKey.get(plan.driver_key);
    return !canDriverUseVehicle(driver ?? {}, { label: plan.vehicle_label, capacity: plan.vehicle_capacity }, { blockUnknownVehicleCapacity: true }).allowed;
  });
  return {
    driver_vehicle_eligibility_blockers: invalid.length,
    vehicle_conflict_count: hybrid.summary.standard_vehicle_conflicts + hybrid.summary.large_vehicle_shared_conflicts,
    overbooking: args.plans.filter((plan) => (plan.vehicle_capacity ?? 0) > 0 && plan.pax > (plan.vehicle_capacity ?? 0)).length,
    total_conflicts: args.plans.reduce((sum, plan) => sum + groupConflictCount(plan), 0),
    hybrid_summary: hybrid.summary,
    invalid_driver_vehicle_assignments: invalid.map((plan) => ({
      group_id: plan.group_id,
      driver_name: plan.driver_name,
      vehicle_label: plan.vehicle_label,
      vehicle_capacity: plan.vehicle_capacity,
      pax: plan.pax,
      start_time: plan.start_time,
    })),
  };
}

function vehicleTimeline(vehicleLabel: string | null, plans: GroupPlan[]) {
  return plans
    .filter((plan) => norm(plan.vehicle_label) === norm(vehicleLabel) && inWindow(plan))
    .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)))
    .map((plan) => ({
      time: `${plan.start_time}-${plan.end_time}`,
      driver: plan.driver_name,
      pax: plan.pax,
      group_id: plan.group_id,
      customers: plan.customer_names,
    }));
}

function vehicleAvailableForPlan(vehicleLabel: string | null, plans: GroupPlan[], target: GroupPlan, ignoreGroupIds: Set<string>) {
  return plans
    .filter((plan) => !ignoreGroupIds.has(plan.group_id))
    .filter((plan) => norm(plan.vehicle_label) === norm(vehicleLabel))
    .filter((plan) => overlaps(plan.start_time, plan.end_time, target.start_time, target.end_time))
    .length === 0;
}

function pickVehicle(args: {
  plan: GroupPlan;
  vehicles: Array<{ id: string; label: string | null; capacity: number | null }>;
  plans: GroupPlan[];
  ignoreGroupIds: Set<string>;
  preferred?: string[];
  driver: DriverRegistryEntry | null;
}) {
  const candidates = args.vehicles
    .filter((vehicle) => (vehicle.capacity ?? 0) >= args.plan.pax && (vehicle.capacity ?? 999) <= 16)
    .filter((vehicle) => canDriverUseVehicle(args.driver ?? {}, vehicle, { blockUnknownVehicleCapacity: true }).allowed)
    .filter((vehicle) => vehicleAvailableForPlan(vehicle.label, args.plans, args.plan, args.ignoreGroupIds));
  return candidates.sort((a, b) => {
    const ai = args.preferred?.findIndex((item) => norm(a.label).includes(norm(item))) ?? -1;
    const bi = args.preferred?.findIndex((item) => norm(b.label).includes(norm(item))) ?? -1;
    const ar = ai === -1 ? 999 : ai;
    const br = bi === -1 ? 999 : bi;
    return ar - br || (a.capacity ?? 999) - (b.capacity ?? 999) || String(a.label).localeCompare(String(b.label));
  })[0] ?? null;
}

async function main() {
  loadEnv();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceKey) throw new Error("Missing Supabase env.");

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const tenant = await resolveTenant(admin);
  const [drivers, hotelsRes, groupsRes, assignmentsRes, vehiclesRes, vehicleAvailRes, vehicleBlocksRes, driverAvailRes] = await Promise.all([
    listDriverRegistry(admin, tenant.id, { activeOnly: true }),
    admin.from("hotels").select("id,name,zone").eq("tenant_id", tenant.id),
    admin.from("trip_groups").select("id,date,driver_user_id,driver_profile_id,vehicle_label,vehicle_capacity,status").eq("tenant_id", tenant.id).eq("date", DATE).eq("status", "active"),
    admin.from("assignments").select("id,service_id,group_id,driver_user_id,driver_profile_id,vehicle_label").eq("tenant_id", tenant.id),
    admin.from("vehicles").select("id,label,capacity,active").eq("tenant_id", tenant.id).order("label"),
    admin.from("vehicle_daily_availability").select("vehicle_id,available").eq("tenant_id", tenant.id).eq("date", DATE),
    admin.from("vehicle_time_blocks").select("*").eq("tenant_id", tenant.id),
    admin.from("driver_daily_availability").select("driver_profile_id,driver_user_id,available,available_from,available_to").eq("tenant_id", tenant.id).eq("date", DATE),
  ]);
  for (const [name, result] of Object.entries({ hotelsRes, groupsRes, assignmentsRes, vehiclesRes, vehicleAvailRes, vehicleBlocksRes, driverAvailRes })) {
    if (result.error) throw new Error(`${name}: ${result.error.message}`);
  }

  const groups = (groupsRes.data ?? []) as TripGroup[];
  const groupIds = new Set(groups.map((group) => group.id));
  const assignments = ((assignmentsRes.data ?? []) as Assignment[]).filter((assignment) => assignment.group_id && groupIds.has(assignment.group_id));
  const services = await loadServices(admin, tenant.id, [...new Set(assignments.map((assignment) => assignment.service_id))]);
  const servicesById = new Map(services.map((service) => [service.id, service]));
  const hotels = (hotelsRes.data ?? []) as Array<{ id: string; name: string | null; zone: string | null }>;
  const vehicles = (vehiclesRes.data ?? []) as Vehicle[];
  const available = availableVehicles({
    vehicles,
    vehicleAvailability: (vehicleAvailRes.data ?? []) as Array<{ vehicle_id: string | null; available: boolean | null }>,
    blocks: (vehicleBlocksRes.data ?? []) as Array<Record<string, unknown>>,
  });
  const vehicleByLabel = new Map(vehicles.map((vehicle) => [norm(vehicle.label), vehicle]));
  const assignmentsByGroup = new Map<string, Assignment[]>();
  for (const assignment of assignments) {
    if (!assignment.group_id) continue;
    assignmentsByGroup.set(assignment.group_id, [...(assignmentsByGroup.get(assignment.group_id) ?? []), assignment]);
  }
  const plans = groups.map((group) => buildPlan({
    group,
    assignments: assignmentsByGroup.get(group.id) ?? [],
    servicesById,
    hotels,
    drivers,
    vehicleByLabel,
  }));
  const marioZ = findMarioZabattta(drivers);
  const marioKey = driverKey(marioZ);
  const availability = (driverAvailRes.data ?? []) as Availability[];
  const marioGroups = plans
    .filter((plan) => plan.driver_key === marioKey)
    .filter((plan) => ["17:25", "18:30", "19:00"].includes(plan.start_time ?? ""))
    .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
  const targetIds = new Set(marioGroups.map((plan) => plan.group_id));

  const vehicleRows = available.map((vehicle) => {
    const timeline = vehicleTimeline(vehicle.label, plans);
    return {
      mezzo: vehicle.label,
      capienza: vehicle.capacity,
      disponibile_17_1930: timeline.length === 0 ? "libero" : "occupato/parziale",
      guidabile_mario_zabattta: canDriverUseVehicle(marioZ ?? {}, vehicle, { blockUnknownVehicleCapacity: true }).allowed,
      timeline,
    };
  });

  const before = summarizeDiagnostics({ plans, drivers, vehicles: available });
  const simulatedPlans = plans.map((plan) => ({ ...plan }));
  const simulationRows = [];
  for (const plan of marioGroups) {
    const ignoredForThisPlan = new Set([plan.group_id]);
    const selected = pickVehicle({
      plan,
      vehicles: available,
      plans: simulatedPlans,
      ignoreGroupIds: ignoredForThisPlan,
      preferred: plan.pax >= 9 ? ["DUCATO MAXI", "DUCATO GRIGIO", "TRASPORTER", "VITO"] : ["VITO EXTRA LONG", "TRASPORTER", "DUCATO MAXI", "DUCATO GRIGIO"],
      driver: marioZ,
    });
    const index = simulatedPlans.findIndex((item) => item.group_id === plan.group_id);
    if (selected && index >= 0) {
      simulatedPlans[index] = {
        ...simulatedPlans[index],
        vehicle_label: selected.label,
        vehicle_capacity: selected.capacity,
      };
    }
    simulationRows.push({
      group_id: plan.group_id,
      orario: `${plan.start_time}-${plan.end_time}`,
      pax: plan.pax,
      mezzo_attuale: plan.vehicle_label,
      mezzo_proposto: selected?.label ?? null,
      capienza_proposta: selected?.capacity ?? null,
      compatibili: available
        .filter((vehicle) => (vehicle.capacity ?? 0) >= plan.pax && (vehicle.capacity ?? 999) <= 16)
        .filter((vehicle) => canDriverUseVehicle(marioZ ?? {}, vehicle, { blockUnknownVehicleCapacity: true }).allowed)
        .filter((vehicle) => vehicleAvailableForPlan(vehicle.label, simulatedPlans, plan, ignoredForThisPlan))
        .map((vehicle) => `${vehicle.label} (${vehicle.capacity})`),
      navetta_ciclo_compatibile: groupHasShuttleCycle(plan),
      esito: selected ? "riallineabile" : "nessun mezzo compatibile disponibile",
    });
  }
  const after = summarizeDiagnostics({ plans: simulatedPlans, drivers, vehicles: available });

  console.log(JSON.stringify({
    tenant,
    date: DATE,
    mario_zabattta: marioZ ? {
      id: marioZ.id,
      name: marioZ.full_name,
      max_vehicle_capacity: marioZ.max_vehicle_capacity,
      availability: driverAvailabilityFor(marioZ, availability),
    } : null,
    mezzi_disponibili: vehicleRows,
    giri_mario_zabattta: marioGroups.map((plan) => ({
      group_id: plan.group_id,
      orario: `${plan.start_time}-${plan.end_time}`,
      pax: plan.pax,
      mezzo_attuale: plan.vehicle_label,
      capienza_attuale: plan.vehicle_capacity,
      clienti: plan.customer_names,
      servizi: plan.stops.map((stop) => `${stop.operational_time} ${stop.pickup_label} -> ${stop.destination_label} (${stop.pax} pax)`),
      navetta_ciclo_compatibile: groupHasShuttleCycle(plan),
      conflitti_interni: groupConflictCount(plan),
    })),
    simulazione: simulationRows,
    diagnostica: {
      prima: before,
      dopo: after,
      delta: {
        driver_vehicle_eligibility_blockers: after.driver_vehicle_eligibility_blockers - before.driver_vehicle_eligibility_blockers,
        vehicle_conflict_count: after.vehicle_conflict_count - before.vehicle_conflict_count,
        overbooking: after.overbooking - before.overbooking,
        total_conflicts: after.total_conflicts - before.total_conflicts,
      },
      remaining_blockers: after.invalid_driver_vehicle_assignments,
    },
    decisione: after.invalid_driver_vehicle_assignments.some((item) => item.driver_name && norm(item.driver_name).includes("MARIO ZABAT"))
      ? "SERVE_MEZZO_9_16_DISPONIBILE_PER_MARIO_ZABATTTA_17_25"
      : "PREPARARE_APPLY_CONTROLLATO_SOLO_MARIO_ZABATTTA",
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : JSON.stringify(error, null, 2));
  process.exit(1);
});
