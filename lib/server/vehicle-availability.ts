export type VehicleManualBlock = {
  id?: string | null;
  label?: string | null;
  blocked_from?: string | null;
  blocked_until?: string | null;
  blocked_reason?: string | null;
  is_blocked_manual?: boolean | null;
};

function dayStart(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function dayEnd(date: string): Date {
  return new Date(`${date}T23:59:59.999Z`);
}

function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map((part) => parseInt(part, 10));
  return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
}

function dateAtMinutes(date: string, minutes: number): Date {
  const start = dayStart(date);
  start.setUTCMinutes(start.getUTCMinutes() + minutes);
  return start;
}

function overlaps(
  blockStart: Date | null,
  blockEnd: Date | null,
  windowStart: Date,
  windowEnd: Date
): boolean {
  const startsBeforeWindowEnds = !blockStart || blockStart < windowEnd;
  const endsAfterWindowStarts = !blockEnd || blockEnd > windowStart;
  return startsBeforeWindowEnds && endsAfterWindowStarts;
}

export function isVehicleManuallyBlockedOnDate(vehicle: VehicleManualBlock, date: string): boolean {
  if (!vehicle.is_blocked_manual && !vehicle.blocked_until) return false;

  const blockStart = vehicle.blocked_from ? new Date(vehicle.blocked_from) : null;
  const blockEnd = vehicle.blocked_until ? new Date(vehicle.blocked_until) : null;
  return overlaps(blockStart, blockEnd, dayStart(date), dayEnd(date));
}

export function isVehicleManuallyBlockedAtTime(
  vehicle: VehicleManualBlock,
  date: string,
  time: string,
  durationMin = 90
): boolean {
  if (!vehicle.is_blocked_manual && !vehicle.blocked_until) return false;

  const tripStart = dateAtMinutes(date, timeToMinutes(time));
  const tripEnd = new Date(tripStart.getTime() + durationMin * 60 * 1000);
  const blockStart = vehicle.blocked_from ? new Date(vehicle.blocked_from) : null;
  const blockEnd = vehicle.blocked_until ? new Date(vehicle.blocked_until) : null;
  return overlaps(blockStart, blockEnd, tripStart, tripEnd);
}

export function manualVehicleBlockMessage(vehicle: VehicleManualBlock): string {
  const reason = vehicle.blocked_reason?.trim();
  return reason ? `Mezzo bloccato in Flotta: ${reason}.` : "Mezzo bloccato in Flotta.";
}
