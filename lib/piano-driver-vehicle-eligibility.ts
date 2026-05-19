export type DriverVehicleEligibilitySeverity = "ok" | "warning" | "blocker";

export type DriverVehicleEligibilityDriver = {
  max_vehicle_capacity?: number | null;
  driver_name?: string | null;
};

export type DriverVehicleEligibilityVehicle = {
  capacity?: number | null;
  label?: string | null;
};

export type DriverVehicleEligibilityResult = {
  allowed: boolean;
  reason: string | null;
  severity: DriverVehicleEligibilitySeverity;
};

export function canDriverUseVehicle(
  driver: DriverVehicleEligibilityDriver,
  vehicle: DriverVehicleEligibilityVehicle,
  options: { blockUnknownVehicleCapacity?: boolean } = {}
): DriverVehicleEligibilityResult {
  const maxVehicleCapacity = driver.max_vehicle_capacity ?? null;
  const vehicleCapacity = vehicle.capacity ?? null;

  if (maxVehicleCapacity == null) {
    return { allowed: true, reason: null, severity: "ok" };
  }

  if (vehicleCapacity == null) {
    return {
      allowed: options.blockUnknownVehicleCapacity === true ? false : true,
      reason: "Capienza mezzo non disponibile: impossibile verificare limite autista.",
      severity: options.blockUnknownVehicleCapacity === true ? "blocker" : "warning",
    };
  }

  if (vehicleCapacity <= maxVehicleCapacity) {
    return { allowed: true, reason: null, severity: "ok" };
  }

  return {
    allowed: false,
    reason: "Autista non abilitato a guidare questo mezzo.",
    severity: "blocker",
  };
}
