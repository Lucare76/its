import { createClient } from "@supabase/supabase-js";
import { canDriverUseVehicle } from "@/lib/piano-driver-vehicle-eligibility";

const date = "2026-05-07";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) throw new Error("Missing Supabase env.");

const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

function norm(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toUpperCase();
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
    admin
      .from("trip_groups")
      .select("id,date,driver_user_id,driver_profile_id,vehicle_label,vehicle_capacity,status")
      .eq("tenant_id", tenantId)
      .eq("date", date)
      .neq("status", "cancelled"),
  ]);

  for (const [name, result] of Object.entries({ profilesRes, membershipsRes, driverAvailRes, vehiclesRes, vehicleAvailRes, vehicleBlocksRes, groupsRes })) {
    if (result.error) throw new Error(`${name}: ${JSON.stringify(result.error)}`);
  }

  const profileById = new Map((profilesRes.data ?? []).map((profile) => [profile.id, profile]));
  const profileByUserId = new Map((profilesRes.data ?? []).map((profile) => [profile.user_id, profile]));
  const membershipByUserId = new Map((membershipsRes.data ?? []).map((membership) => [membership.user_id, membership]));
  const availableDrivers = (driverAvailRes.data ?? [])
    .filter((row) => row.available !== false)
    .map((row) => {
      const profile = row.driver_profile_id ? profileById.get(row.driver_profile_id) : profileByUserId.get(row.driver_user_id);
      const userId = row.driver_user_id ?? profile?.user_id ?? null;
      const membership = userId ? membershipByUserId.get(userId) : null;
      return {
        driver_profile_id: row.driver_profile_id ?? profile?.id ?? null,
        driver_user_id: userId,
        driver_name: profile?.full_name ?? membership?.full_name ?? row.driver_profile_id ?? row.driver_user_id ?? "SENZA AUTISTA",
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

  const matrix = availableDrivers.map((driver) => ({
    driver: driver.driver_name,
    max_vehicle_capacity: driver.max_vehicle_capacity,
    vehicles: Object.fromEntries(availableVehicles.map((vehicle) => {
      const result = canDriverUseVehicle(driver, vehicle);
      const value = result.allowed
        ? driver.max_vehicle_capacity == null ? "NO_CAPACITY_LIMIT" : "OK"
        : "NO";
      return [vehicle.label, value];
    })),
  }));

  const currentInvalidAssignments = [];
  const vehicleByLabel = new Map(availableVehicles.map((vehicle) => [norm(vehicle.label), vehicle]));
  for (const group of groupsRes.data ?? []) {
    const profile = group.driver_profile_id ? profileById.get(group.driver_profile_id) : null;
    const userId = group.driver_user_id ?? profile?.user_id ?? null;
    const membership = userId ? membershipByUserId.get(userId) : null;
    const vehicle = group.vehicle_label ? vehicleByLabel.get(norm(group.vehicle_label)) : null;
    if (!vehicle || !membership) continue;
    const result = canDriverUseVehicle({ max_vehicle_capacity: membership.max_vehicle_capacity as number | null }, vehicle);
    if (!result.allowed) {
      currentInvalidAssignments.push({
        group_id: group.id,
        driver: profile?.full_name ?? membership.full_name ?? userId,
        vehicle_label: group.vehicle_label,
        vehicle_capacity: vehicle.capacity,
        max_vehicle_capacity: membership.max_vehicle_capacity,
        blocker: result.reason,
      });
    }
  }

  console.log(JSON.stringify({
    projectRef: supabaseUrl.match(/https:\/\/([^.]+)/)?.[1] ?? null,
    tenant: { id: tenantId, name: tenant.name ?? null },
    date,
    availableDrivers,
    availableVehicles,
    matrix,
    currentInvalidAssignments,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});
