import { type SupabaseClient } from "@supabase/supabase-js";

type VehicleCatalogRow = {
  id: string;
  tenant_id: string;
  label: string;
  plate: string | null;
  capacity: number | null;
  vehicle_size: string | null;
  active: boolean;
  habitual_driver_user_id: string | null;
  habitual_driver_profile_id?: string | null;
};

type DriverProfileRow = {
  id: string;
  user_id: string | null;
  full_name: string;
};

type MembershipRow = {
  user_id: string;
  full_name: string;
  role: string;
};

function normalizeName(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export async function loadOperationalVehicles(
  admin: SupabaseClient,
  tenantId: string,
  options?: { activeOnly?: boolean }
): Promise<VehicleCatalogRow[]> {
  const activeOnly = options?.activeOnly ?? true;

  const vehiclesQuery = admin
    .from("vehicles")
    .select("id, tenant_id, label, plate, capacity, vehicle_size, active, habitual_driver_user_id, habitual_driver_profile_id")
    .eq("tenant_id", tenantId)
    .order("label");

  if (activeOnly) {
    vehiclesQuery.eq("active", true);
  }

  const { data: vehicles, error } = await vehiclesQuery;
  if (error) throw new Error(error.message);

  const rows = (vehicles ?? []) as VehicleCatalogRow[];
  const profileIds = rows
    .map((vehicle) => vehicle.habitual_driver_profile_id)
    .filter((profileId): profileId is string => typeof profileId === "string" && profileId.length > 0)
    .filter((profileId) => !vehicleHasUserAssignment(rows, profileId));

  if (profileIds.length === 0) {
    return rows;
  }

  const [profilesResult, membershipsResult] = await Promise.all([
    admin
      .from("driver_profiles")
      .select("id, user_id, full_name")
      .eq("tenant_id", tenantId)
      .in("id", profileIds),
    admin
      .from("memberships")
      .select("user_id, full_name, role")
      .eq("tenant_id", tenantId)
      .eq("role", "driver"),
  ]);

  if (profilesResult.error) throw new Error(profilesResult.error.message);
  if (membershipsResult.error) throw new Error(membershipsResult.error.message);

  const profileById = new Map(
    ((profilesResult.data ?? []) as DriverProfileRow[]).map((profile) => [profile.id, profile])
  );
  const membershipUserIdByProfileId = new Map(
    ((profilesResult.data ?? []) as DriverProfileRow[])
      .filter((profile) => profile.user_id)
      .map((profile) => [profile.id, profile.user_id as string])
  );
  const membershipUserIdByName = new Map<string, string>();
  for (const membership of (membershipsResult.data ?? []) as MembershipRow[]) {
    const key = normalizeName(membership.full_name);
    if (key && !membershipUserIdByName.has(key)) {
      membershipUserIdByName.set(key, membership.user_id);
    }
  }

  return rows.map((vehicle) => {
    if (vehicle.habitual_driver_user_id || !vehicle.habitual_driver_profile_id) return vehicle;
    const profile = profileById.get(vehicle.habitual_driver_profile_id);
    const mappedUserId =
      membershipUserIdByProfileId.get(vehicle.habitual_driver_profile_id) ??
      membershipUserIdByName.get(normalizeName(profile?.full_name));
    return {
      ...vehicle,
      habitual_driver_user_id: mappedUserId ?? null,
    };
  });
}

function vehicleHasUserAssignment(rows: VehicleCatalogRow[], profileId: string) {
  return rows.some((vehicle) => vehicle.habitual_driver_profile_id === profileId && vehicle.habitual_driver_user_id);
}
