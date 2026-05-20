import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { canDriverCoverInterval } from "@/lib/piano-driver-availability";
import { canDriverUseVehicle } from "@/lib/piano-driver-vehicle-eligibility";
import { resolveAssignableService, type AssignableService } from "@/lib/piano-assignable-service";
import { listDriverRegistry, normalizeDriverName, type DriverRegistryEntry } from "@/lib/server/driver-registry";

const DATE = "2026-05-07";
const TARGET_GROUP_ID = "b933fd53-b478-4a02-ae4a-480952232ef3";
const WINDOW_START = "16:00";
const WINDOW_END = "18:30";

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
type Service = AssignableService & { status?: string | null };
type Vehicle = { id: string; label: string | null; capacity: number | null; active: boolean | null };
type Availability = {
  driver_profile_id: string | null;
  driver_user_id: string | null;
  available: boolean | null;
  available_from: string | null;
  available_to: string | null;
};
type Plan = {
  group_id: string;
  driver_key: string | null;
  driver_name: string | null;
  vehicle_label: string | null;
  vehicle_capacity: number | null;
  start: string | null;
  end: string | null;
  pax: number;
  customers: string[];
  services: string[];
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
      // optional
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

function gapBetween(left: Pick<Plan, "start" | "end">, right: Pick<Plan, "start" | "end">) {
  const leftEnd = minutes(left.end);
  const rightStart = minutes(right.start);
  if (leftEnd == null || rightStart == null) return null;
  return rightStart - leftEnd;
}

function driverKey(driver: Pick<DriverRegistryEntry, "id" | "user_id"> | null | undefined) {
  if (!driver) return null;
  return driver.id ? `profile:${driver.id}` : driver.user_id ? `user:${driver.user_id}` : null;
}

function groupDriverKey(group: Group) {
  return group.driver_profile_id ? `profile:${group.driver_profile_id}` : group.driver_user_id ? `user:${group.driver_user_id}` : null;
}

function findDriver(drivers: DriverRegistryEntry[], name: string) {
  const target = normalizeDriverName(name).replace(/t{2,}/g, "tt");
  return drivers.find((driver) => normalizeDriverName(driver.full_name).replace(/t{2,}/g, "tt").includes(target)) ?? null;
}

function driverNameForGroup(group: Group, drivers: DriverRegistryEntry[]) {
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

async function tenant(admin: Admin) {
  const { data, error } = await admin.from("tenants").select("id,name").limit(50);
  if (error) throw error;
  const row = (data ?? []).find((item) => norm(item.name).includes("ISCHIA TRANSFER")) ?? data?.[0];
  if (!row?.id) throw new Error("Tenant non trovato.");
  return { id: row.id as string, name: row.name as string | null };
}

function missingSchemaColumn(message: string) {
  return message.match(/Could not find the '([^']+)' column/)?.[1]
    ?? message.match(/column (?:public\.)?services\.([a-zA-Z0-9_]+) does not exist/)?.[1]
    ?? message.match(/column "([a-zA-Z0-9_]+)" does not exist/)?.[1]
    ?? null;
}

async function loadServices(admin: Admin, tenantId: string, ids: string[]) {
  let columns = [
    "id", "date", "time", "time_from", "time_to", "direction", "customer_name", "pax", "hotel_id", "vessel",
    "notes", "status", "meeting_point", "place_type", "pickup_hotel", "booking_service_kind", "service_type",
    "service_type_code", "transport_code", "ferry_details", "excursion_details", "tour_name", "pickup_time",
    "arrival_time", "departure_time",
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

function buildPlan(args: {
  group: Group;
  assignments: Assignment[];
  servicesById: Map<string, Service>;
  hotels: Array<{ id: string; name: string | null; zone: string | null }>;
  drivers: DriverRegistryEntry[];
  vehiclesByLabel: Map<string, Vehicle>;
}): Plan {
  const hotelById = new Map(args.hotels.map((hotel) => [hotel.id, hotel]));
  const services = args.assignments.map((assignment) => args.servicesById.get(assignment.service_id)).filter((service): service is Service => Boolean(service));
  const resolved = services.map((service) => resolveAssignableService(service, { hotel: service.hotel_id ? hotelById.get(service.hotel_id) ?? null : null }));
  const times = resolved.map((row) => minutes(row.operational_time)).filter((value): value is number => value != null);
  const start = times.length ? Math.min(...times) : null;
  const end = times.length ? Math.max(...times) + 30 : null;
  const vehicleLabel = args.group.vehicle_label ?? args.assignments.map((assignment) => assignment.vehicle_label).find(Boolean) ?? null;
  const vehicle = vehicleLabel ? args.vehiclesByLabel.get(norm(vehicleLabel)) : null;
  return {
    group_id: args.group.id,
    driver_key: groupDriverKey(args.group),
    driver_name: driverNameForGroup(args.group, args.drivers),
    vehicle_label: vehicleLabel,
    vehicle_capacity: args.group.vehicle_capacity ?? vehicle?.capacity ?? null,
    start: hhmm(start),
    end: hhmm(end),
    pax: resolved.reduce((sum, row) => sum + (Number(row.pax) || 0), 0),
    customers: [...new Set(services.map((service) => service.customer_name ?? "").filter(Boolean))].sort(),
    services: resolved.map((row) => `${row.operational_time} ${row.pickup_label} -> ${row.destination_label} (${row.pax} pax)`),
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
    .filter((vehicle) => !blocked.has(vehicle.id));
}

function availabilityFor(driver: DriverRegistryEntry | null, availability: Availability[]) {
  if (!driver) return null;
  return availability.find((row) => row.driver_profile_id === driver.id)
    ?? (driver.user_id ? availability.find((row) => row.driver_user_id === driver.user_id) : null)
    ?? null;
}

function formatTimeline(plan: Plan) {
  return {
    group_id: plan.group_id,
    orario: `${plan.start}-${plan.end}`,
    autista: plan.driver_name,
    mezzo: plan.vehicle_label,
    capienza: plan.vehicle_capacity,
    pax: plan.pax,
    clienti: plan.customers,
    servizi: plan.services,
  };
}

function vehicleFreeFor(target: Plan, vehicleLabel: string, plans: Plan[], ignoreIds = new Set<string>()) {
  return plans.filter((plan) => !ignoreIds.has(plan.group_id))
    .filter((plan) => norm(plan.vehicle_label) === norm(vehicleLabel))
    .filter((plan) => overlaps(plan.start, plan.end, target.start, target.end));
}

function driverFreeFor(target: Plan, driver: DriverRegistryEntry | null, plans: Plan[], ignoreIds = new Set<string>()) {
  const key = driverKey(driver);
  return plans.filter((plan) => !ignoreIds.has(plan.group_id))
    .filter((plan) => plan.driver_key === key)
    .filter((plan) => overlaps(plan.start, plan.end, target.start, target.end));
}

function diagnosticsForMarioZ(marioZ: DriverRegistryEntry | null, plans: Plan[]) {
  return plans.filter((plan) => plan.driver_key === driverKey(marioZ))
    .filter((plan) => !canDriverUseVehicle(marioZ ?? {}, { label: plan.vehicle_label, capacity: plan.vehicle_capacity }, { blockUnknownVehicleCapacity: true }).allowed)
    .map((plan) => ({
      group_id: plan.group_id,
      orario: `${plan.start}-${plan.end}`,
      pax: plan.pax,
      mezzo: plan.vehicle_label,
      capienza: plan.vehicle_capacity,
    }));
}

async function main() {
  loadEnv();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Missing Supabase env.");

  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const t = await tenant(admin);
  const [drivers, hotelsRes, groupsRes, assignmentsRes, vehiclesRes, vehicleAvailRes, vehicleBlocksRes, driverAvailRes] = await Promise.all([
    listDriverRegistry(admin, t.id, { activeOnly: true }),
    admin.from("hotels").select("id,name,zone").eq("tenant_id", t.id),
    admin.from("trip_groups").select("id,date,driver_user_id,driver_profile_id,vehicle_label,vehicle_capacity,status").eq("tenant_id", t.id).eq("date", DATE).eq("status", "active"),
    admin.from("assignments").select("id,service_id,group_id,driver_user_id,driver_profile_id,vehicle_label").eq("tenant_id", t.id),
    admin.from("vehicles").select("id,label,capacity,active").eq("tenant_id", t.id).order("label"),
    admin.from("vehicle_daily_availability").select("vehicle_id,available").eq("tenant_id", t.id).eq("date", DATE),
    admin.from("vehicle_time_blocks").select("*").eq("tenant_id", t.id),
    admin.from("driver_daily_availability").select("driver_profile_id,driver_user_id,available,available_from,available_to").eq("tenant_id", t.id).eq("date", DATE),
  ]);
  for (const [name, result] of Object.entries({ hotelsRes, groupsRes, assignmentsRes, vehiclesRes, vehicleAvailRes, vehicleBlocksRes, driverAvailRes })) {
    if (result.error) throw new Error(`${name}: ${result.error.message}`);
  }

  const groups = (groupsRes.data ?? []) as Group[];
  const groupIds = new Set(groups.map((group) => group.id));
  const assignments = ((assignmentsRes.data ?? []) as Assignment[]).filter((assignment) => assignment.group_id && groupIds.has(assignment.group_id));
  const services = await loadServices(admin, t.id, [...new Set(assignments.map((assignment) => assignment.service_id))]);
  const vehicles = (vehiclesRes.data ?? []) as Vehicle[];
  const available = availableVehicles({
    vehicles,
    vehicleAvailability: (vehicleAvailRes.data ?? []) as Array<{ vehicle_id: string | null; available: boolean | null }>,
    blocks: (vehicleBlocksRes.data ?? []) as Array<Record<string, unknown>>,
  });
  const vehiclesByLabel = new Map(vehicles.map((vehicle) => [norm(vehicle.label), vehicle]));
  const servicesById = new Map(services.map((service) => [service.id, service]));
  const assignmentsByGroup = new Map<string, Assignment[]>();
  for (const assignment of assignments) {
    if (!assignment.group_id) continue;
    assignmentsByGroup.set(assignment.group_id, [...(assignmentsByGroup.get(assignment.group_id) ?? []), assignment]);
  }
  const plans = groups.map((group) => buildPlan({
    group,
    assignments: assignmentsByGroup.get(group.id) ?? [],
    servicesById,
    hotels: (hotelsRes.data ?? []) as Array<{ id: string; name: string | null; zone: string | null }>,
    drivers,
    vehiclesByLabel,
  }));

  const leo = findDriver(drivers, "LEO");
  const marioZ = findDriver(drivers, "MARIO ZABATTA");
  const ducatoMaxi = vehiclesByLabel.get("DUCATO MAXI") ?? null;
  const target = plans.find((plan) => plan.group_id === TARGET_GROUP_ID);
  if (!target) throw new Error("Giro 17:25 Mario Zabattta non trovato.");
  const availability = (driverAvailRes.data ?? []) as Availability[];
  const ignoreTarget = new Set([target.group_id]);

  const leoPlans = plans
    .filter((plan) => plan.driver_key === driverKey(leo))
    .filter((plan) => overlaps(plan.start, plan.end, WINDOW_START, WINDOW_END))
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const ducatoTimeline = plans
    .filter((plan) => norm(plan.vehicle_label) === "DUCATO MAXI")
    .filter((plan) => overlaps(plan.start, plan.end, WINDOW_START, WINDOW_END))
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const leoBefore = leoPlans.filter((plan) => (minutes(plan.end) ?? 0) <= (minutes(target.start) ?? 0)).at(-1) ?? null;
  const leoAfter = leoPlans.find((plan) => (minutes(plan.start) ?? 9999) >= (minutes(target.end) ?? 0)) ?? null;
  const ducatoBefore = ducatoTimeline.filter((plan) => (minutes(plan.end) ?? 0) <= (minutes(target.start) ?? 0)).at(-1) ?? null;
  const ducatoAfter = ducatoTimeline.find((plan) => (minutes(plan.start) ?? 9999) >= (minutes(target.end) ?? 0)) ?? null;

  const leoAvailability = canDriverCoverInterval(availabilityFor(leo, availability), {
    start_time: target.start,
    end_time: target.end,
  }, { missingAvailability: "blocker", missingBounds: "warning" });
  const leoEligibility = canDriverUseVehicle(leo ?? {}, ducatoMaxi ?? {}, { blockUnknownVehicleCapacity: true });
  const vehicleCapacityOk = (ducatoMaxi?.capacity ?? 0) >= target.pax;
  const leoOverlaps = driverFreeFor(target, leo, plans, ignoreTarget);
  const ducatoOverlaps = vehicleFreeFor(target, "DUCATO MAXI", plans, ignoreTarget);

  const simulatedPlans = plans.map((plan) => plan.group_id === target.group_id
    ? {
        ...plan,
        driver_key: driverKey(leo),
        driver_name: leo?.full_name ?? null,
        vehicle_label: "DUCATO MAXI",
        vehicle_capacity: ducatoMaxi?.capacity ?? null,
      }
    : { ...plan });
  const smallMarioPlans = simulatedPlans
    .filter((plan) => plan.driver_key === driverKey(marioZ))
    .filter((plan) => ["18:30", "19:00"].includes(plan.start ?? ""))
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const smallVehicles = available.filter((vehicle) =>
    (vehicle.capacity ?? 0) >= 2
    && (vehicle.capacity ?? 999) <= 16
    && canDriverUseVehicle(marioZ ?? {}, vehicle, { blockUnknownVehicleCapacity: true }).allowed
  );
  const smallSolutions = smallMarioPlans.map((plan) => {
    const compatible = smallVehicles
      .filter((vehicle) => vehicleFreeFor(plan, vehicle.label ?? "", simulatedPlans, new Set([plan.group_id])).length === 0)
      .map((vehicle) => `${vehicle.label} (${vehicle.capacity})`);
    return {
      group_id: plan.group_id,
      orario: `${plan.start}-${plan.end}`,
      pax: plan.pax,
      mezzo_attuale: plan.vehicle_label,
      mezzi_compatibili_disponibili: compatible,
      esito: compatible.length > 0 ? "riallineabile" : "nessun mezzo <=16 disponibile",
    };
  });

  console.log(JSON.stringify({
    tenant: t,
    date: DATE,
    target: formatTimeline(target),
    leo: leo ? {
      id: leo.id,
      name: leo.full_name,
      max_vehicle_capacity: leo.max_vehicle_capacity,
      availability: availabilityFor(leo, availability),
    } : null,
    timeline_leo: {
      giri_16_1830: leoPlans.map(formatTimeline),
      buffer_prima_min: leoBefore ? gapBetween(leoBefore, target) : null,
      buffer_dopo_min: leoAfter ? gapBetween(target, leoAfter) : null,
      overlap_con_target: leoOverlaps.map(formatTimeline),
    },
    timeline_ducato_maxi: {
      mezzo: ducatoMaxi,
      disponibile_db: available.some((vehicle) => norm(vehicle.label) === "DUCATO MAXI"),
      giri_16_1830: ducatoTimeline.map((plan) => ({
        ...formatTimeline(plan),
        puo_essere_liberato: "non valutabile automaticamente senza spostare un giro esistente",
      })),
      buffer_prima_min: ducatoBefore ? gapBetween(ducatoBefore, target) : null,
      buffer_dopo_min: ducatoAfter ? gapBetween(target, ducatoAfter) : null,
      overlap_con_target: ducatoOverlaps.map(formatTimeline),
    },
    simulazione_1725_a_leo_ducato_maxi: {
      leo_disponibile: leoAvailability.allowed,
      leo_disponibilita_reason: leoAvailability.reason,
      leo_puo_guidare_ducato_maxi: leoEligibility.allowed,
      ducato_maxi_capiente: vehicleCapacityOk,
      nessun_overlap_leo: leoOverlaps.length === 0,
      nessun_overlap_mezzo: ducatoOverlaps.length === 0,
      overbooking: Math.max(0, target.pax - (ducatoMaxi?.capacity ?? 0)),
      eligibility_blocker: leoEligibility.allowed ? 0 : 1,
      blockers: [
        !leoAvailability.allowed ? "Leo non disponibile in fascia." : null,
        !leoEligibility.allowed ? "Leo non puo guidare Ducato Maxi." : null,
        !vehicleCapacityOk ? "Ducato Maxi non capiente." : null,
        leoOverlaps.length > 0 ? "Overlap timeline Leo." : null,
        ducatoOverlaps.length > 0 ? "Overlap timeline Ducato Maxi." : null,
      ].filter(Boolean),
    },
    effetto_su_mario_zabattta: {
      blockers_prima: diagnosticsForMarioZ(marioZ, plans),
      blockers_dopo_spostamento_1725: diagnosticsForMarioZ(marioZ, simulatedPlans),
      giri_piccoli: smallSolutions,
    },
    decisione: leoAvailability.allowed
      && leoEligibility.allowed
      && vehicleCapacityOk
      && leoOverlaps.length === 0
      && ducatoOverlaps.length === 0
      ? "SPOSTARE_GIRO_17_25_A_LEO_CON_DUCATO_MAXI"
      : "NON_PULITA",
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : JSON.stringify(error, null, 2));
  process.exit(1);
});
