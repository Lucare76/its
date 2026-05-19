import { createClient } from "@supabase/supabase-js";

const date = "2026-05-07";
const targetDrivers = new Set(["MARIO", "LEO", "ILARIA", "MARIO ZABATTA", "RICCARDO"]);
const targetVehicles = new Set(["25 BIANCO", "25 NAVARRA", "DUCATO GRIGIO", "DUCATO MAXI", "VITO EXTRA LONG"]);

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  throw new Error("Missing Supabase env.");
}

const admin = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false },
});

function norm(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

function minuteFromTime(value: unknown) {
  const match = String(value ?? "").match(/(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function hhmm(value: number | null) {
  if (value == null || !Number.isFinite(value)) return null;
  const hour = Math.floor(value / 60);
  const minute = value % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

async function main() {
  const { data: tenants, error: tenantError } = await admin.from("tenants").select("id,name").limit(20);
  if (tenantError) throw tenantError;
  let tenant = tenants?.[0] ?? null;
  const productionTenant = (tenants ?? []).find((candidate) => norm(candidate.name).includes("ISCHIA TRANSFER"));
  if (productionTenant) {
    tenant = productionTenant;
  }
  for (const candidate of tenants ?? []) {
    if (productionTenant) break;
    const { data: candidateVehicles, error: candidateVehiclesError } = await admin
      .from("vehicles")
      .select("id,label")
      .eq("tenant_id", candidate.id)
      .in("label", [...targetVehicles]);
    if (candidateVehiclesError) {
      throw new Error(`candidateVehicles ${candidate.id}: ${JSON.stringify(candidateVehiclesError)}`);
    }
    if ((candidateVehicles ?? []).length >= targetVehicles.size) {
      tenant = candidate;
      break;
    }
  }
  const tenantId = tenant?.id;
  if (!tenantId) throw new Error("No tenant found.");

  const [
    driversRes,
    driverAvailRes,
    vehiclesRes,
    vehicleAvailRes,
    vehicleBlocksRes,
    groupsRes,
  ] = await Promise.all([
    admin.from("driver_profiles").select("id,user_id,full_name,active").eq("tenant_id", tenantId),
    admin.from("driver_daily_availability").select("*").eq("tenant_id", tenantId).eq("date", date),
    admin.from("vehicles").select("id,label,capacity,active,blocked_until,blocked_reason").eq("tenant_id", tenantId).order("label"),
    admin.from("vehicle_daily_availability").select("*").eq("tenant_id", tenantId).eq("date", date),
    admin.from("vehicle_time_blocks").select("*").eq("tenant_id", tenantId),
    admin
      .from("trip_groups")
      .select("id,date,driver_user_id,driver_profile_id,vehicle_label,vehicle_capacity,status,notes")
      .eq("tenant_id", tenantId)
      .eq("date", date)
      .neq("status", "cancelled"),
  ]);

  const namedResults = {
    driversRes,
    driverAvailRes,
    vehiclesRes,
    vehicleAvailRes,
    vehicleBlocksRes,
    groupsRes,
  };
  for (const [name, result] of Object.entries(namedResults)) {
    if (result.error) throw new Error(`${name}: ${JSON.stringify(result.error)}`);
  }

  const drivers = driversRes.data ?? [];
  const driverByProfile = new Map(drivers.map((driver) => [driver.id, driver]));
  const driverByUser = new Map(drivers.map((driver) => [driver.user_id, driver]));
  const driverName = (profileId: string | null, userId: string | null) =>
    driverByProfile.get(profileId ?? "")?.full_name ??
    driverByUser.get(userId ?? "")?.full_name ??
    profileId ??
    userId ??
    "SENZA AUTISTA";

  const vehicleAvailById = new Map((vehicleAvailRes.data ?? []).map((row) => [row.vehicle_id, row]));
  const vehicleBlocks = (vehicleBlocksRes.data ?? []).filter((block) => {
    const from = String(block.blocked_from ?? "").slice(0, 10);
    const until = String(block.blocked_until ?? "").slice(0, 10);
    return !from || !until || (from <= date && until >= date);
  });
  const blockedVehicleIds = new Set(vehicleBlocks.map((block) => block.vehicle_id));
  const availableVehicles = (vehiclesRes.data ?? []).filter((vehicle) => {
    const dailyAvailability = vehicleAvailById.get(vehicle.id);
    return vehicle.active !== false && dailyAvailability?.available !== false && !blockedVehicleIds.has(vehicle.id);
  });
  const availableVehicleLabels = new Set(availableVehicles.map((vehicle) => norm(vehicle.label)));
  const vehicleByLabel = new Map((vehiclesRes.data ?? []).map((vehicle) => [norm(vehicle.label), vehicle]));
  const availableDrivers = (driverAvailRes.data ?? [])
    .filter((row) => row.available !== false)
    .map((row) => driverName(row.driver_profile_id ?? null, row.driver_user_id ?? null))
    .filter((name) => targetDrivers.has(norm(name)));

  const groups = groupsRes.data ?? [];
  const groupIds = groups.map((group) => group.id);
  const assignmentsRes = groupIds.length
    ? await admin.from("assignments").select("id,service_id,group_id,driver_user_id,driver_profile_id,vehicle_label").eq("tenant_id", tenantId).in("group_id", groupIds)
    : { data: [], error: null };
  if (assignmentsRes.error) throw assignmentsRes.error;

  const serviceIds = [...new Set((assignmentsRes.data ?? []).map((assignment) => assignment.service_id).filter(Boolean))];
  const servicesRes = serviceIds.length
    ? await admin.from("services").select("id,date,time,pickup_hotel,pax,direction,status,customer_name").eq("tenant_id", tenantId).in("id", serviceIds)
    : { data: [], error: null };
  if (servicesRes.error) throw servicesRes.error;

  const servicesById = new Map((servicesRes.data ?? []).map((service) => [service.id, service]));
  const assignmentsByGroup = new Map<string, NonNullable<typeof assignmentsRes.data>>();
  for (const assignment of assignmentsRes.data ?? []) {
    const list = assignmentsByGroup.get(assignment.group_id ?? "") ?? [];
    list.push(assignment);
    assignmentsByGroup.set(assignment.group_id ?? "", list);
  }

  const driverStats = new Map<string, {
    driver: string;
    vehicles: Map<string, number>;
    groupCount: number;
    maxPax: number;
    unassignedGroups: number;
    intervals: Array<{
      group_id: string;
      start: string | null;
      end: string | null;
      pax: number;
      vehicle_label: string | null;
      capacity: number | null;
    }>;
  }>();
  const vehicleDrivers = new Map<string, Set<string>>();
  const groupDetails: Array<{
    group_id: string;
    driver: string;
    vehicle_label: string | null;
    vehicle_id: string | null;
    vehicle_capacity: number | null;
    pax: number;
    start: string | null;
    end: string | null;
    services: number;
  }> = [];

  for (const group of groups) {
    const assignments = assignmentsByGroup.get(group.id) ?? [];
    const services = assignments.map((assignment) => servicesById.get(assignment.service_id)).filter(Boolean);
    const pax = services.reduce((sum, service) => sum + (Number(service?.pax) || 0), 0);
    const times = services
      .map((service) => minuteFromTime(service?.pickup_hotel ?? service?.time))
      .filter((value): value is number => value != null);
    const start = times.length ? Math.min(...times) : null;
    const end = times.length ? Math.max(...times) + 30 : null;
    const name = driverName(group.driver_profile_id, group.driver_user_id);
    const vehicleLabel = group.vehicle_label ?? assignments.map((assignment) => assignment.vehicle_label).find(Boolean) ?? null;
    const vehicle = vehicleLabel ? vehicleByLabel.get(norm(vehicleLabel)) : null;
    const vehicleCapacity = group.vehicle_capacity ?? vehicle?.capacity ?? null;
    const key = norm(name);
    const stat = driverStats.get(key) ?? {
      driver: name,
      vehicles: new Map<string, number>(),
      groupCount: 0,
      maxPax: 0,
      unassignedGroups: 0,
      intervals: [],
    };

    stat.groupCount += 1;
    stat.maxPax = Math.max(stat.maxPax, pax);
    stat.intervals.push({
      group_id: group.id,
      start: hhmm(start),
      end: hhmm(end),
      pax,
      vehicle_label: vehicleLabel,
      capacity: vehicleCapacity,
    });
    if (vehicleLabel) {
      stat.vehicles.set(vehicleLabel, (stat.vehicles.get(vehicleLabel) ?? 0) + 1);
      const set = vehicleDrivers.get(vehicleLabel) ?? new Set<string>();
      set.add(name);
      vehicleDrivers.set(vehicleLabel, set);
    } else {
      stat.unassignedGroups += 1;
    }
    driverStats.set(key, stat);
    groupDetails.push({
      group_id: group.id,
      driver: name,
      vehicle_label: vehicleLabel,
      vehicle_id: vehicle?.id ?? null,
      vehicle_capacity: vehicleCapacity,
      pax,
      start: hhmm(start),
      end: hhmm(end),
      services: services.length,
    });
  }

  const duplicatedVehicles = [...vehicleDrivers.entries()]
    .filter(([, driversSet]) => driversSet.size > 1)
    .map(([label, driversSet]) => ({ label, drivers: [...driversSet] }));
  const usedVehicles = [...vehicleDrivers.keys()].filter((label) => availableVehicleLabels.has(norm(label)));
  const unusedVehicles = availableVehicles.filter((vehicle) => !usedVehicles.some((label) => norm(label) === norm(vehicle.label)));
  const stats = [...driverStats.values()]
    .filter((stat) => targetDrivers.has(norm(stat.driver)))
    .sort((a, b) => a.driver.localeCompare(b.driver))
    .map((stat) => ({
      driver: stat.driver,
      vehicles: [...stat.vehicles.entries()].map(([label, count]) => ({
        label,
        count,
        capacity: vehicleByLabel.get(norm(label))?.capacity ?? null,
      })),
      groupCount: stat.groupCount,
      maxPax: stat.maxPax,
      unassignedGroups: stat.unassignedGroups,
      intervals: stat.intervals,
    }));

  console.log(JSON.stringify({
    projectRef: supabaseUrl.match(/https:\/\/([^.]+)/)?.[1] ?? null,
    tenant: { id: tenantId, name: tenant?.name ?? null },
    date,
    availableDrivers,
    driverCount: availableDrivers.length,
    availableVehicles: availableVehicles.map((vehicle) => ({
      id: vehicle.id,
      label: vehicle.label,
      capacity: vehicle.capacity,
    })),
    vehicleBlocks: vehicleBlocks.map((block) => ({
      vehicle_id: block.vehicle_id,
      blocked_from: block.blocked_from,
      blocked_until: block.blocked_until,
      reason: block.reason,
    })),
    groupCount: groups.length,
    assignmentCount: (assignmentsRes.data ?? []).length,
    stats,
    duplicatedVehicles,
    usedVehicles,
    unusedVehicles: unusedVehicles.map((vehicle) => ({
      id: vehicle.id,
      label: vehicle.label,
      capacity: vehicle.capacity,
    })),
    groups: groupDetails
      .filter((group) => targetDrivers.has(norm(group.driver)))
      .sort((a, b) => String(a.driver).localeCompare(String(b.driver)) || String(a.start).localeCompare(String(b.start))),
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});
