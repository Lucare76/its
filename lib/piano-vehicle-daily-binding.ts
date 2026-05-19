import { vehicleResourceKey, type VehicleTimelineIdentity } from "@/lib/piano-vehicle-timeline";

export type VehicleDailyBindingMode = "fixed_vehicle_per_driver" | "shared_vehicles";

export type VehicleDailyBindingDriver = {
  driver_profile_id?: string | null;
  driver_user_id?: string | null;
  driver_id?: string | null;
  driver_name?: string | null;
};

export type VehicleDailyBindingVehicle = VehicleTimelineIdentity & {
  capacity?: number | null;
};

export type VehicleDailyBindingAssignment = VehicleDailyBindingDriver & VehicleDailyBindingVehicle & {
  group_id?: string | null;
};

export type VehicleDailyBindingConflict = {
  conflict_type: "same_vehicle_different_driver_same_day" | "same_driver_different_vehicle_same_day";
  vehicle_key: string | null;
  vehicle_label: string | null;
  driver_key: string | null;
  other_driver_key: string | null;
  driver_name: string | null;
  other_driver_name: string | null;
  message: string;
  group_id?: string | null;
};

export type VehicleDailyBindingSuggestion = {
  group_id?: string | null;
  driver_key: string;
  driver_name: string | null;
  from_vehicle_label: string | null;
  to_vehicle_id: string | null;
  to_vehicle_label: string | null;
  reason: string;
};

export type VehicleDailyBindingResult = {
  mode: VehicleDailyBindingMode;
  driver_to_vehicle: Map<string, VehicleDailyBindingVehicle>;
  vehicle_to_driver: Map<string, VehicleDailyBindingDriver>;
  conflicts: VehicleDailyBindingConflict[];
  suggestions: VehicleDailyBindingSuggestion[];
  warnings: string[];
  unassigned_drivers: VehicleDailyBindingDriver[];
  unused_vehicles: VehicleDailyBindingVehicle[];
};

function clean(value?: string | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

export function driverDailyBindingKey(driver: VehicleDailyBindingDriver) {
  const profileId = clean(driver.driver_profile_id);
  if (profileId) return `profile:${profileId}`;
  const userId = clean(driver.driver_user_id);
  if (userId) return `user:${userId}`;
  const driverId = clean(driver.driver_id);
  if (driverId) return `driver:${driverId}`;
  return null;
}

function sameDriver(a: VehicleDailyBindingDriver, b: VehicleDailyBindingDriver) {
  const left = driverDailyBindingKey(a);
  const right = driverDailyBindingKey(b);
  return Boolean(left && right && left === right);
}

function publicDriver(driver: VehicleDailyBindingDriver): VehicleDailyBindingDriver {
  return {
    driver_profile_id: driver.driver_profile_id ?? null,
    driver_user_id: driver.driver_user_id ?? null,
    driver_id: driver.driver_id ?? null,
    driver_name: driver.driver_name ?? null,
  };
}

function publicVehicle(vehicle: VehicleDailyBindingVehicle): VehicleDailyBindingVehicle {
  return {
    id: vehicle.id ?? null,
    label: vehicle.label ?? null,
    capacity: vehicle.capacity ?? null,
  };
}

export function buildVehicleDailyBinding(args: {
  drivers: VehicleDailyBindingDriver[];
  vehicles: VehicleDailyBindingVehicle[];
  assignments?: VehicleDailyBindingAssignment[];
  allowSharedVehicles?: boolean;
}): VehicleDailyBindingResult {
  const mode: VehicleDailyBindingMode =
    args.allowSharedVehicles || args.vehicles.length < args.drivers.length
      ? "shared_vehicles"
      : "fixed_vehicle_per_driver";
  const driverToVehicle = new Map<string, VehicleDailyBindingVehicle>();
  const vehicleToDriver = new Map<string, VehicleDailyBindingDriver>();
  const conflicts: VehicleDailyBindingConflict[] = [];
  const suggestions: VehicleDailyBindingSuggestion[] = [];
  const warnings: string[] = [];

  const availableVehicles = args.vehicles
    .map(publicVehicle)
    .filter((vehicle) => vehicleResourceKey(vehicle).key)
    .sort((a, b) => String(a.label ?? "").localeCompare(String(b.label ?? "")));
  const availableByLabel = new Map(
    availableVehicles
      .filter((vehicle) => clean(vehicle.label))
      .map((vehicle) => [clean(vehicle.label)!.toLowerCase(), vehicle])
  );

  for (const assignment of args.assignments ?? []) {
    const driverKey = driverDailyBindingKey(assignment);
    const resolvedVehicle = assignment.id
      ? publicVehicle(assignment)
      : availableByLabel.get(clean(assignment.label)?.toLowerCase() ?? "") ?? publicVehicle(assignment);
    const vehicleInfo = vehicleResourceKey(resolvedVehicle);
    if (vehicleInfo.warning) warnings.push(vehicleInfo.warning);
    if (!driverKey || !vehicleInfo.key) continue;

    const currentDriverVehicle = driverToVehicle.get(driverKey);
    if (currentDriverVehicle) {
      const currentVehicleKey = vehicleResourceKey(currentDriverVehicle).key;
      if (currentVehicleKey && currentVehicleKey !== vehicleInfo.key) {
        conflicts.push({
          conflict_type: "same_driver_different_vehicle_same_day",
          vehicle_key: vehicleInfo.key,
          vehicle_label: resolvedVehicle.label ?? assignment.label ?? null,
          driver_key: driverKey,
          other_driver_key: driverKey,
          driver_name: assignment.driver_name ?? null,
          other_driver_name: assignment.driver_name ?? null,
          message: `Autista ${assignment.driver_name ?? driverKey} assegnato a piu mezzi nella stessa giornata.`,
          group_id: assignment.group_id ?? null,
        });
      }
    } else {
      driverToVehicle.set(driverKey, resolvedVehicle);
    }

    const currentVehicleDriver = vehicleToDriver.get(vehicleInfo.key);
    if (currentVehicleDriver && !sameDriver(currentVehicleDriver, assignment)) {
      const otherDriverKey = driverDailyBindingKey(currentVehicleDriver);
      conflicts.push({
        conflict_type: "same_vehicle_different_driver_same_day",
        vehicle_key: vehicleInfo.key,
        vehicle_label: resolvedVehicle.label ?? assignment.label ?? null,
        driver_key: driverKey,
        other_driver_key: otherDriverKey,
        driver_name: assignment.driver_name ?? null,
        other_driver_name: currentVehicleDriver.driver_name ?? null,
        message: "Mezzo gia assegnato a un altro autista per questa giornata.",
        group_id: assignment.group_id ?? null,
      });
    } else {
      vehicleToDriver.set(vehicleInfo.key, publicDriver(assignment));
    }
  }

  if (mode === "fixed_vehicle_per_driver") {
    for (const driver of args.drivers) {
      const driverKey = driverDailyBindingKey(driver);
      if (!driverKey || driverToVehicle.has(driverKey)) continue;
      const vehicle = availableVehicles.find((candidate) => {
        const key = vehicleResourceKey(candidate).key;
        return key && !vehicleToDriver.has(key);
      });
      if (!vehicle) continue;
      const vehicleKey = vehicleResourceKey(vehicle).key;
      if (!vehicleKey) continue;
      driverToVehicle.set(driverKey, vehicle);
      vehicleToDriver.set(vehicleKey, publicDriver(driver));
    }
  }

  const assignedDriverKeys = new Set(driverToVehicle.keys());
  const assignedVehicleKeys = new Set(vehicleToDriver.keys());
  const unassignedDrivers = args.drivers.filter((driver) => {
    const key = driverDailyBindingKey(driver);
    return Boolean(key && !assignedDriverKeys.has(key));
  });
  const unusedVehicles = availableVehicles.filter((vehicle) => {
    const key = vehicleResourceKey(vehicle).key;
    return Boolean(key && !assignedVehicleKeys.has(key));
  });

  let replacementIndex = 0;
  const suggestedConflictKeys = new Set<string>();
  for (const conflict of conflicts.filter((item) => item.conflict_type === "same_vehicle_different_driver_same_day")) {
    const driverKey = conflict.driver_key;
    const conflictKey = `${conflict.vehicle_key ?? ""}|${driverKey ?? ""}`;
    if (suggestedConflictKeys.has(conflictKey)) continue;
    suggestedConflictKeys.add(conflictKey);
    const replacement = unusedVehicles[replacementIndex];
    if (!driverKey || !replacement) continue;
    replacementIndex += 1;
    suggestions.push({
      group_id: conflict.group_id ?? null,
      driver_key: driverKey,
      driver_name: conflict.driver_name,
      from_vehicle_label: conflict.vehicle_label,
      to_vehicle_id: replacement.id ?? null,
      to_vehicle_label: replacement.label ?? null,
      reason: "Mezzo duplicato tra autisti mentre esiste un mezzo libero disponibile.",
    });
  }

  return {
    mode,
    driver_to_vehicle: driverToVehicle,
    vehicle_to_driver: vehicleToDriver,
    conflicts,
    suggestions,
    warnings: Array.from(new Set(warnings)),
    unassigned_drivers: unassignedDrivers,
    unused_vehicles: unusedVehicles,
  };
}
