import { createClient } from "@supabase/supabase-js";
import { buildHybridVehicleBinding } from "@/lib/piano-hybrid-vehicle-binding";
import { canDriverUseVehicle } from "@/lib/piano-driver-vehicle-eligibility";

const date = "2026-05-07";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) throw new Error("Missing Supabase env.");

const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

function norm(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toUpperCase();
}

function minuteFromTime(value: unknown) {
  const match = String(value ?? "").match(/(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function hhmm(value: number | null) {
  if (value == null) return null;
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

async function main() {
  const { data: tenants, error: tenantError } = await admin.from("tenants").select("id,name").limit(50);
  if (tenantError) throw tenantError;
  const tenant = (tenants ?? []).find((candidate) => norm(candidate.name).includes("ISCHIA TRANSFER")) ?? tenants?.[0];
  if (!tenant) throw new Error("No tenant found.");
  const tenantId = tenant.id;

  const [profilesRes, membershipsRes, driverAvailRes, vehiclesRes, vehicleAvailRes, vehicleBlocksRes, groupsRes] = await Promise.all([
    admin.from("driver_profiles").select("id,user_id,full_name,active").eq("tenant_id", tenantId),
    admin.from("memberships").select("user_id,full_name,role,max_vehicle_capacity").eq("tenant_id", tenantId),
    admin.from("driver_daily_availability").select("*").eq("tenant_id", tenantId).eq("date", date),
    admin.from("vehicles").select("id,label,capacity,active").eq("tenant_id", tenantId).order("label"),
    admin.from("vehicle_daily_availability").select("*").eq("tenant_id", tenantId).eq("date", date),
    admin.from("vehicle_time_blocks").select("*").eq("tenant_id", tenantId),
    admin.from("trip_groups").select("id,date,driver_user_id,driver_profile_id,vehicle_label,vehicle_capacity,status").eq("tenant_id", tenantId).eq("date", date).neq("status", "cancelled"),
  ]);
  for (const [name, result] of Object.entries({ profilesRes, membershipsRes, driverAvailRes, vehiclesRes, vehicleAvailRes, vehicleBlocksRes, groupsRes })) {
    if (result.error) throw new Error(`${name}: ${JSON.stringify(result.error)}`);
  }

  const profileById = new Map((profilesRes.data ?? []).map((profile) => [profile.id, profile]));
  const membershipByUserId = new Map((membershipsRes.data ?? []).map((membership) => [membership.user_id, membership]));
  const availableDrivers = (driverAvailRes.data ?? []).filter((row) => row.available !== false).map((row) => {
    const profile = row.driver_profile_id ? profileById.get(row.driver_profile_id) : null;
    const userId = row.driver_user_id ?? profile?.user_id ?? null;
    const membership = userId ? membershipByUserId.get(userId) : null;
    return {
      driver_key: row.driver_profile_id ? `profile:${row.driver_profile_id}` : `user:${userId}`,
      driver_name: profile?.full_name ?? membership?.full_name ?? "SENZA AUTISTA",
      max_vehicle_capacity: (membership?.max_vehicle_capacity as number | null) ?? null,
    };
  });

  const vehicleAvailById = new Map((vehicleAvailRes.data ?? []).map((row) => [row.vehicle_id, row]));
  const vehicleBlocks = (vehicleBlocksRes.data ?? []).filter((block) => {
    const singleDate = String(block.date ?? "").slice(0, 10);
    const from = String(block.blocked_from ?? block.block_from ?? "").slice(0, 10);
    const until = String(block.blocked_until ?? "").slice(0, 10);
    if (singleDate) return singleDate === date;
    return Boolean(from && until && from <= date && until >= date);
  });
  const blockedVehicleIds = new Set(vehicleBlocks.map((block) => block.vehicle_id));
  const availableVehicles = (vehiclesRes.data ?? [])
    .filter((vehicle) => vehicle.active !== false && vehicleAvailById.get(vehicle.id)?.available !== false && !blockedVehicleIds.has(vehicle.id))
    .map((vehicle) => ({ id: vehicle.id, label: vehicle.label, capacity: vehicle.capacity }));

  const groups = groupsRes.data ?? [];
  const groupIds = groups.map((group) => group.id);
  const assignmentsRes = groupIds.length
    ? await admin.from("assignments").select("service_id,group_id").eq("tenant_id", tenantId).in("group_id", groupIds)
    : { data: [], error: null };
  if (assignmentsRes.error) throw assignmentsRes.error;
  const serviceIds = [...new Set((assignmentsRes.data ?? []).map((assignment) => assignment.service_id).filter(Boolean))];
  const servicesRes = serviceIds.length
    ? await admin.from("services").select("id,time,pickup_hotel,pax,direction").eq("tenant_id", tenantId).in("id", serviceIds)
    : { data: [], error: null };
  if (servicesRes.error) throw servicesRes.error;

  const serviceById = new Map((servicesRes.data ?? []).map((service) => [service.id, service]));
  const assignmentsByGroup = new Map<string, NonNullable<typeof assignmentsRes.data>>();
  for (const assignment of assignmentsRes.data ?? []) {
    const list = assignmentsByGroup.get(assignment.group_id ?? "") ?? [];
    list.push(assignment);
    assignmentsByGroup.set(assignment.group_id ?? "", list);
  }

  const trips = groups.map((group) => {
    const services = (assignmentsByGroup.get(group.id) ?? []).map((assignment) => serviceById.get(assignment.service_id)).filter(Boolean);
    const times = services.map((service) => minuteFromTime(service?.pickup_hotel ?? service?.time)).filter((value): value is number => value != null);
    const start = times.length ? Math.min(...times) : null;
    const end = times.length ? Math.max(...times) + 30 : null;
    const driverKey = group.driver_profile_id ? `profile:${group.driver_profile_id}` : group.driver_user_id ? `user:${group.driver_user_id}` : null;
    const driver = availableDrivers.find((item) => item.driver_key === driverKey);
    return {
      group_id: group.id,
      driver_key: driverKey,
      driver_name: driver?.driver_name ?? null,
      start_time: hhmm(start),
      end_time: hhmm(end),
      pax: services.reduce((sum, service) => sum + (Number(service?.pax) || 0), 0),
      current_vehicle_label: group.vehicle_label ?? null,
    };
  }).filter((trip) => trip.driver_key);

  const simulation = buildHybridVehicleBinding({
    drivers: availableDrivers,
    vehicles: availableVehicles,
    trips,
    config: { largeGroupPaxThreshold: 21, minBufferMinutes: 20 },
  });

  const eligibilityMatrix = availableDrivers.map((driver) => ({
    driver: driver.driver_name,
    max_vehicle_capacity: driver.max_vehicle_capacity,
    vehicles: Object.fromEntries(availableVehicles.map((vehicle) => {
      const result = canDriverUseVehicle(driver, vehicle);
      return [vehicle.label, result.allowed ? driver.max_vehicle_capacity == null ? "NO_CAPACITY_LIMIT" : "OK" : "NO"];
    })),
  }));

  console.log(JSON.stringify({
    projectRef: supabaseUrl.match(/https:\/\/([^.]+)/)?.[1] ?? null,
    tenant: { id: tenantId, name: tenant.name ?? null },
    date,
    availableDrivers,
    availableVehicles,
    eligibilityMatrix,
    largeTrips: simulation.trips.filter((trip) => trip.is_large_group),
    largeVehicleUsage: simulation.large_vehicle_usage,
    standardVehicleBindings: simulation.standard_vehicle_bindings,
    summary: simulation.summary,
    conflicts: simulation.conflicts,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});
