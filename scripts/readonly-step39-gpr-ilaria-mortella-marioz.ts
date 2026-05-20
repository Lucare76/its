import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { canDriverUseVehicle } from "@/lib/piano-driver-vehicle-eligibility";
import { canDriverCoverInterval } from "@/lib/piano-driver-availability";
import { detectExcursionRoundtripClusters } from "@/lib/piano-excursion-roundtrip-cluster";
import { resolveAssignableService, type AssignableService } from "@/lib/piano-assignable-service";
import { listDriverRegistry, normalizeDriverName, type DriverRegistryEntry } from "@/lib/server/driver-registry";

const DATE = "2026-05-07";
const GPR_GROUP_ID = "71443ef7-f506-464d-b11d-f9eae8c2858a";

type SupabaseAdmin = ReturnType<typeof createClient>;

type TripGroup = {
  id: string;
  date: string;
  driver_user_id: string | null;
  driver_profile_id: string | null;
  vehicle_label: string | null;
  vehicle_capacity: number | null;
  status: string | null;
  updated_at?: string | null;
};

type Assignment = {
  id: string;
  service_id: string;
  group_id: string | null;
  driver_user_id: string | null;
  driver_profile_id: string | null;
  vehicle_label: string | null;
};

type Vehicle = {
  id: string;
  label: string | null;
  capacity: number | null;
  active: boolean | null;
};

type Availability = {
  driver_profile_id: string | null;
  driver_user_id: string | null;
  available: boolean | null;
  available_from: string | null;
  available_to: string | null;
};

type Service = AssignableService & {
  date?: string | null;
  status?: string | null;
};

type GroupPlan = {
  group_id: string;
  driver_name: string | null;
  driver_key: string | null;
  vehicle_label: string | null;
  vehicle_capacity: number | null;
  start: string | null;
  end: string | null;
  pax: number;
  service_ids: string[];
  customer_names: string[];
  labels: string[];
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

function driverKey(driver: Pick<DriverRegistryEntry, "id" | "user_id"> | null | undefined) {
  if (!driver) return null;
  return driver.id ? `profile:${driver.id}` : driver.user_id ? `user:${driver.user_id}` : null;
}

function groupDriverKey(group: TripGroup) {
  return group.driver_profile_id ? `profile:${group.driver_profile_id}` : group.driver_user_id ? `user:${group.driver_user_id}` : null;
}

function findDriver(drivers: DriverRegistryEntry[], name: string) {
  const target = normalizeDriverName(name).replace(/t{2,}/g, "tt");
  return drivers.find((driver) => normalizeDriverName(driver.full_name).replace(/t{2,}/g, "tt") === target)
    ?? drivers.find((driver) => normalizeDriverName(driver.full_name).replace(/t{2,}/g, "tt").includes(target))
    ?? null;
}

function driverName(group: TripGroup, drivers: DriverRegistryEntry[]) {
  if (group.driver_profile_id) return drivers.find((driver) => driver.id === group.driver_profile_id)?.full_name ?? null;
  if (group.driver_user_id) return drivers.find((driver) => driver.user_id === group.driver_user_id)?.full_name ?? null;
  return null;
}

function vehicleBlockedOnDate(block: Record<string, unknown>) {
  const singleDate = String(block.date ?? "").slice(0, 10);
  if (singleDate) return singleDate === DATE;
  const from = String(block.blocked_from ?? block.block_from ?? "").slice(0, 10);
  const until = String(block.blocked_until ?? block.block_to ?? "").slice(0, 10);
  return Boolean(from && until && from <= DATE && until >= DATE);
}

async function resolveTenant(admin: SupabaseAdmin) {
  const { data, error } = await admin.from("tenants").select("id,name").limit(50);
  if (error) throw error;
  const tenant = (data ?? []).find((row) => norm(row.name).includes("ISCHIA TRANSFER")) ?? data?.[0];
  if (!tenant?.id) throw new Error("Tenant non trovato.");
  return { id: tenant.id as string, name: tenant.name as string | null };
}

function missingSchemaColumn(message: string) {
  return message.match(/Could not find the '([^']+)' column/)?.[1]
    ?? message.match(/column (?:public\.)?services\.([a-zA-Z0-9_]+) does not exist/)?.[1]
    ?? message.match(/column "([a-zA-Z0-9_]+)" does not exist/)?.[1]
    ?? null;
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
    "origin_place_id",
    "destination_place_id",
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
  drivers: DriverRegistryEntry[];
  vehicleByLabel: Map<string, Vehicle>;
  hotels: Array<{ id: string; name: string | null; zone: string | null }>;
}): GroupPlan {
  const hotelById = new Map(args.hotels.map((hotel) => [hotel.id, hotel]));
  const services = args.assignments.map((assignment) => args.servicesById.get(assignment.service_id)).filter((service): service is Service => Boolean(service));
  const resolved = services.map((service) => resolveAssignableService(service, { hotel: service.hotel_id ? hotelById.get(service.hotel_id) ?? null : null }));
  const times = resolved.map((row) => minutes(row.operational_time)).filter((value): value is number => value != null);
  const start = times.length ? Math.min(...times) : null;
  const end = times.length ? Math.max(...times) + 30 : null;
  const label = args.group.vehicle_label ?? args.assignments.map((assignment) => assignment.vehicle_label).find(Boolean) ?? null;
  const vehicle = label ? args.vehicleByLabel.get(norm(label)) : null;
  return {
    group_id: args.group.id,
    driver_name: driverName(args.group, args.drivers),
    driver_key: groupDriverKey(args.group),
    vehicle_label: label,
    vehicle_capacity: args.group.vehicle_capacity ?? vehicle?.capacity ?? null,
    start: hhmm(start),
    end: hhmm(end),
    pax: resolved.reduce((sum, row) => sum + (Number(row.pax) || 0), 0),
    service_ids: services.map((service) => service.id).sort(),
    customer_names: [...new Set(services.map((service) => service.customer_name ?? "").filter(Boolean))].sort(),
    labels: resolved.map((row) => `${row.operational_time} ${row.pickup_label} -> ${row.destination_label} (${row.pax} pax)`),
  };
}

function availableVehicleLabels(args: {
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

function conflictsForDriver(driver: DriverRegistryEntry | null, intervals: Array<GroupPlan & { ignore?: boolean }>, proposed: { start: string | null; end: string | null }) {
  const key = driverKey(driver);
  return intervals.filter((plan) => !plan.ignore && plan.driver_key === key && overlaps(plan.start, plan.end, proposed.start, proposed.end));
}

function conflictsForVehicle(label: string | null, intervals: Array<GroupPlan & { ignore?: boolean }>, proposed: { start: string | null; end: string | null }) {
  return intervals.filter((plan) => !plan.ignore && norm(plan.vehicle_label) === norm(label) && overlaps(plan.start, plan.end, proposed.start, proposed.end));
}

function planCanMoveToDriver(args: {
  plan: GroupPlan;
  driver: DriverRegistryEntry;
  vehicle: { label: string | null; capacity: number | null };
  intervals: GroupPlan[];
  availability: Availability[];
  excludedGroupIds: Set<string>;
}) {
  const driverAvailable = canDriverCoverInterval(driverAvailabilityFor(args.driver, args.availability), {
    start_time: args.plan.start,
    end_time: args.plan.end,
  }, { missingAvailability: "blocker", missingBounds: "warning" });
  const eligible = canDriverUseVehicle(args.driver, args.vehicle, { blockUnknownVehicleCapacity: true });
  const capacityOk = (args.vehicle.capacity ?? 0) >= args.plan.pax;
  const driverConflicts = conflictsForDriver(args.driver, args.intervals.map((interval) => ({
    ...interval,
    ignore: args.excludedGroupIds.has(interval.group_id) || interval.group_id === args.plan.group_id,
  })), args.plan);
  return {
    ok: driverAvailable.allowed && eligible.allowed && capacityOk && driverConflicts.length === 0,
    driver_available: driverAvailable.allowed,
    eligible: eligible.allowed,
    capacity_ok: capacityOk,
    conflicts: driverConflicts.map((conflict) => `${conflict.start} ${conflict.customer_names.join("/") || conflict.group_id}`),
  };
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
    admin.from("hotels").select("id,name,zone,lat,lng").eq("tenant_id", tenant.id),
    admin.from("trip_groups").select("id,date,driver_user_id,driver_profile_id,vehicle_label,vehicle_capacity,status,updated_at").eq("tenant_id", tenant.id).eq("date", DATE).eq("status", "active"),
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
  const vehicleByLabel = new Map(vehicles.map((vehicle) => [norm(vehicle.label), vehicle]));
  const availability = (driverAvailRes.data ?? []) as Availability[];
  const availableVehicles = availableVehicleLabels({
    vehicles,
    vehicleAvailability: (vehicleAvailRes.data ?? []) as Array<{ vehicle_id: string | null; available: boolean | null }>,
    blocks: (vehicleBlocksRes.data ?? []) as Array<Record<string, unknown>>,
  });
  const activeSmallVehicles = availableVehicles.filter((vehicle) => (vehicle.capacity ?? 0) >= 5 && (vehicle.capacity ?? 999) <= 16);

  const assignmentsByGroup = new Map<string, Assignment[]>();
  for (const assignment of assignments) {
    if (!assignment.group_id) continue;
    assignmentsByGroup.set(assignment.group_id, [...(assignmentsByGroup.get(assignment.group_id) ?? []), assignment]);
  }
  const plans = groups.map((group) => buildPlan({
    group,
    assignments: assignmentsByGroup.get(group.id) ?? [],
    servicesById,
    drivers,
    vehicleByLabel,
    hotels,
  }));

  const gpr = plans.find((plan) => plan.group_id === GPR_GROUP_ID) ?? null;
  const clusters = detectExcursionRoundtripClusters({ services, hotels });
  const mortella = clusters.find((cluster) => norm(cluster.label).includes("MORTELLA")) ?? null;
  const mortellaServiceIds = new Set(mortella?.service_ids ?? []);
  const mortellaPlans = plans.filter((plan) => plan.service_ids.some((id) => mortellaServiceIds.has(id)));
  const mortellaStart = mortella?.start_time ?? null;
  const mortellaEnd = mortella?.end_time ? hhmm((minutes(mortella.end_time) ?? 0) + 30) : null;
  const mortellaPax = mortella?.total_pax ?? 0;

  const ilaria = findDriver(drivers, "ILARIA");
  const marioZ = findDriver(drivers, "MARIO ZABATTA");
  const mario = findDriver(drivers, "MARIO");
  const riccardo = findDriver(drivers, "RICCARDO");
  const vehicle25 = vehicleByLabel.get("25 BIANCO") ?? null;
  const chosenSmallVehicle = activeSmallVehicles.find((vehicle) => norm(vehicle.label).includes("VITO"))
    ?? activeSmallVehicles[0]
    ?? null;

  const gprInterval = { start: gpr?.start ?? "15:00", end: gpr?.end ?? "15:30" };
  const mortellaInterval = { start: mortellaStart, end: mortellaEnd };
  const baseIntervalsForA = plans.map((plan) => ({
    ...plan,
    ignore: plan.group_id === GPR_GROUP_ID || plan.service_ids.some((id) => mortellaServiceIds.has(id)),
  }));
  const ilariaEligibility = canDriverUseVehicle(ilaria ?? {}, vehicle25 ?? {}, { blockUnknownVehicleCapacity: true });
  const ilariaAvailable = canDriverCoverInterval(driverAvailabilityFor(ilaria, availability), {
    start_time: gprInterval.start,
    end_time: gprInterval.end,
  }, { missingAvailability: "blocker", missingBounds: "warning" });
  const ilariaConflicts = conflictsForDriver(ilaria, baseIntervalsForA, gprInterval);
  const gprVehicleConflicts = conflictsForVehicle("25 BIANCO", baseIntervalsForA, gprInterval);

  const marioZEligibility = canDriverUseVehicle(marioZ ?? {}, chosenSmallVehicle ?? {}, { blockUnknownVehicleCapacity: true });
  const marioZAvailable = canDriverCoverInterval(driverAvailabilityFor(marioZ, availability), {
    start_time: mortellaInterval.start,
    end_time: mortellaInterval.end,
  }, { missingAvailability: "blocker", missingBounds: "warning" });
  const marioZConflicts = conflictsForDriver(marioZ, baseIntervalsForA, mortellaInterval);
  const smallVehicleConflicts = conflictsForVehicle(chosenSmallVehicle?.label ?? null, baseIntervalsForA, mortellaInterval);

  const alternativeDrivers = drivers.filter((driver) => ![driverKey(ilaria), driverKey(marioZ)].includes(driverKey(driver)));
  const conflictRelocation = marioZConflicts.map((conflict) => {
    const vehicle = conflict.vehicle_label ? vehicleByLabel.get(norm(conflict.vehicle_label)) : null;
    const candidateDrivers = alternativeDrivers
      .map((driver) => ({
        driver,
        result: planCanMoveToDriver({
          plan: conflict,
          driver,
          vehicle: { label: conflict.vehicle_label, capacity: conflict.vehicle_capacity ?? vehicle?.capacity ?? null },
          intervals: plans,
          availability,
          excludedGroupIds: new Set([GPR_GROUP_ID, ...mortellaPlans.map((plan) => plan.group_id)]),
        }),
      }))
      .filter((candidate) => candidate.result.ok)
      .map((candidate) => candidate.driver.full_name);
    const candidateVehicles = activeSmallVehicles
      .filter((candidate) => (candidate.capacity ?? 0) >= conflict.pax)
      .filter((candidate) => canDriverUseVehicle(marioZ ?? {}, candidate, { blockUnknownVehicleCapacity: true }).allowed)
      .filter((candidate) => conflictsForVehicle(candidate.label, plans.map((plan) => ({
        ...plan,
        ignore: plan.group_id === conflict.group_id || plan.group_id === GPR_GROUP_ID || mortellaPlans.some((m) => m.group_id === plan.group_id),
      })), conflict).length === 0)
      .map((candidate) => candidate.label);
    return {
      giro: conflict.customer_names.join(" / ") || conflict.group_id,
      group_id: conflict.group_id,
      ora: `${conflict.start}-${conflict.end}`,
      pax: conflict.pax,
      mezzo_attuale: conflict.vehicle_label,
      puo_andare_ad_altro_autista: candidateDrivers.length > 0,
      autisti_candidati: candidateDrivers.slice(0, 5),
      puo_andare_ad_altro_mezzo: candidateVehicles.length > 0,
      mezzi_candidati: candidateVehicles.slice(0, 5),
      esito: candidateDrivers.length > 0 || candidateVehicles.length > 0 ? "ricollocabile" : "non ricollocabile senza ulteriore intervento",
    };
  });

  const scenarioAOk = ilariaEligibility.allowed
    && ilariaAvailable.allowed
    && ilariaConflicts.length === 0
    && (vehicle25?.capacity ?? 0) >= (gpr?.pax ?? 21)
    && gprVehicleConflicts.length === 0
    && marioZEligibility.allowed
    && marioZAvailable.allowed
    && (chosenSmallVehicle?.capacity ?? 0) >= mortellaPax
    && smallVehicleConflicts.length === 0
    && (marioZConflicts.length === 0 || conflictRelocation.every((row) => row.esito === "ricollocabile"));

  const scenarioB = {
    gpr_to_mario_eligibility: canDriverUseVehicle(mario ?? {}, vehicle25 ?? {}, { blockUnknownVehicleCapacity: true }).allowed,
    driver_conflicts: conflictsForDriver(mario, plans.map((plan) => ({ ...plan, ignore: plan.group_id === GPR_GROUP_ID })), gprInterval).length,
    vehicle_conflicts: conflictsForVehicle("25 BIANCO", plans.map((plan) => ({ ...plan, ignore: plan.group_id === GPR_GROUP_ID })), gprInterval).length,
  };
  const scenarioC = {
    riccardo_can_drive_25: canDriverUseVehicle(riccardo ?? {}, vehicle25 ?? {}, { blockUnknownVehicleCapacity: true }).allowed,
  };

  console.log(JSON.stringify({
    tenant,
    date: DATE,
    current_gpr_state: gpr,
    drivers: {
      riccardo: riccardo ? { id: riccardo.id, name: riccardo.full_name, max_vehicle_capacity: riccardo.max_vehicle_capacity } : null,
      ilaria: ilaria ? { id: ilaria.id, name: ilaria.full_name, max_vehicle_capacity: ilaria.max_vehicle_capacity } : null,
      mario: mario ? { id: mario.id, name: mario.full_name, max_vehicle_capacity: mario.max_vehicle_capacity } : null,
      mario_zabattta: marioZ ? { id: marioZ.id, name: marioZ.full_name, max_vehicle_capacity: marioZ.max_vehicle_capacity } : null,
    },
    cluster_mortella: mortella ? {
      label: mortella.label,
      total_pax: mortella.total_pax,
      start_time: mortella.start_time,
      end_time: mortella.end_time,
      outbound_route: mortella.outbound_route,
      return_route: mortella.return_route,
      outbound_services: mortella.outbound_services,
      return_services: mortella.return_services,
      current_groups: mortellaPlans,
    } : null,
    simulation_a_gpr_ilaria_mortella_marioz: {
      gpr_to_ilaria: {
        vehicle: vehicle25 ? { label: vehicle25.label, capacity: vehicle25.capacity } : null,
        ilaria_can_drive_25: ilariaEligibility.allowed,
        ilaria_available: ilariaAvailable.allowed,
        ilaria_availability_reason: ilariaAvailable.reason,
        ilaria_availability_window: driverAvailabilityFor(ilaria, availability),
        ilaria_conflicts: ilariaConflicts.map((plan) => `${plan.start} ${plan.customer_names.join("/") || plan.group_id}`),
        vehicle_conflicts: gprVehicleConflicts.map((plan) => `${plan.start} ${plan.driver_name} ${plan.customer_names.join("/") || plan.group_id}`),
        overbooking: Math.max(0, (gpr?.pax ?? 21) - (vehicle25?.capacity ?? 0)),
      },
      mortella_to_mario_zabattta: {
        vehicle: chosenSmallVehicle,
        mario_zabattta_can_drive_small_vehicle: marioZEligibility.allowed,
        mario_zabattta_available: marioZAvailable.allowed,
        mario_zabattta_availability_reason: marioZAvailable.reason,
        mario_zabattta_availability_window: driverAvailabilityFor(marioZ, availability),
        vehicle_available: Boolean(chosenSmallVehicle),
        capacity_ok: (chosenSmallVehicle?.capacity ?? 0) >= mortellaPax,
        mario_zabattta_conflicts: marioZConflicts,
        vehicle_conflicts: smallVehicleConflicts.map((plan) => `${plan.start} ${plan.driver_name} ${plan.customer_names.join("/") || plan.group_id}`),
        overbooking: Math.max(0, mortellaPax - (chosenSmallVehicle?.capacity ?? 0)),
      },
      overall_ok_without_micro_moves: marioZConflicts.length === 0 && ilariaConflicts.length === 0 && gprVehicleConflicts.length === 0 && smallVehicleConflicts.length === 0,
      overall_ok_with_micro_moves: scenarioAOk,
    },
    mario_zabattta_conflicting_groups_to_move: conflictRelocation,
    scenario_comparison: [
      {
        scenario: "A) GPR a Ilaria + Mortella a Mario Zabattta",
        cambi_richiesti: 2 + conflictRelocation.length,
        conflitti_residui: scenarioAOk ? 0 : ilariaConflicts.length + gprVehicleConflicts.length + smallVehicleConflicts.length + conflictRelocation.filter((row) => row.esito !== "ricollocabile").length,
        mezzi_compatibili: Boolean(vehicle25 && chosenSmallVehicle && ilariaEligibility.allowed && marioZEligibility.allowed),
        esito: scenarioAOk ? "fattibile, ma richiede micro-spostamenti" : "non chiusa in modo semplice",
      },
      {
        scenario: "B) GPR a Mario",
        cambi_richiesti: 1,
        conflitti_residui: scenarioB.driver_conflicts + scenarioB.vehicle_conflicts + (scenarioB.gpr_to_mario_eligibility ? 0 : 1),
        mezzi_compatibili: scenarioB.gpr_to_mario_eligibility,
        esito: scenarioB.gpr_to_mario_eligibility && scenarioB.driver_conflicts === 0 && scenarioB.vehicle_conflicts === 0 ? "fattibile semplice" : "non pulito",
      },
      {
        scenario: "C) lasciare GPR a Riccardo",
        cambi_richiesti: 0,
        conflitti_residui: scenarioC.riccardo_can_drive_25 ? 0 : 1,
        mezzi_compatibili: scenarioC.riccardo_can_drive_25,
        esito: scenarioC.riccardo_can_drive_25 ? "fattibile" : "non valido: Riccardo max 16",
      },
      {
        scenario: "D) split GPR",
        cambi_richiesti: "n/d",
        conflitti_residui: "n/d",
        mezzi_compatibili: false,
        esito: "da escludere: gruppo non splittabile",
      },
      {
        scenario: "E) intervento operatore",
        cambi_richiesti: "manuale",
        conflitti_residui: "dipende",
        mezzi_compatibili: true,
        esito: scenarioAOk || (scenarioB.gpr_to_mario_eligibility && scenarioB.driver_conflicts === 0 && scenarioB.vehicle_conflicts === 0) ? "non necessario per GPR" : "necessario",
      },
    ],
    recommendation: scenarioAOk
      ? "ROTAZIONE_GPR_ILARIA_MORTELLA_MARIOZ"
      : scenarioB.gpr_to_mario_eligibility && scenarioB.driver_conflicts === 0 && scenarioB.vehicle_conflicts === 0
        ? "GPR_A_MARIO"
        : "SERVE_INTERVENTO_OPERATORE",
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : JSON.stringify(error, null, 2));
  process.exit(1);
});
