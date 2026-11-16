export type ScheduledVehicleSlot = {
  vehicleId: string;
  from: string | null;
  to: string | null;
};

export type DriverVehicleSchedule = {
  id: string;
  vehicle_slots?: ScheduledVehicleSlot[];
};

function minute(value: string | null): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function vehiclePoolForDriver<T extends { id: string }>(
  vehicles: T[],
  driver: DriverVehicleSchedule,
  drivers: DriverVehicleSchedule[],
  time: string,
): T[] {
  const start = minute(time);
  if (start === null) return [];
  const end = start + 30;
  const slots = driver.vehicle_slots ?? [];
  const reserved = new Set(drivers
    .filter((other) => other.id !== driver.id)
    .flatMap((other) => other.vehicle_slots ?? [])
    .filter((slot) => start < (minute(slot.to) ?? Infinity) && end > (minute(slot.from) ?? 0))
    .map((slot) => slot.vehicleId));
  const ownIds = new Set(slots
    .filter((slot) => start >= (minute(slot.from) ?? 0) && end <= (minute(slot.to) ?? Infinity))
    .map((slot) => slot.vehicleId));
  return vehicles.filter((vehicle) => !reserved.has(vehicle.id) && (!slots.length || ownIds.has(vehicle.id)));
}
