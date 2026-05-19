import { canDriverUseVehicle } from "@/lib/piano-driver-vehicle-eligibility";
import { vehicleIntervalsOverlap, vehicleResourceKey, type VehicleTimelineIdentity } from "@/lib/piano-vehicle-timeline";

export type HybridVehicleBindingDriver = {
  driver_key: string;
  driver_name: string | null;
  max_vehicle_capacity?: number | null;
};

export type HybridVehicleBindingVehicle = VehicleTimelineIdentity & {
  capacity?: number | null;
};

export type HybridVehicleBindingTrip = {
  group_id: string;
  driver_key: string | null;
  driver_name?: string | null;
  start_time: string | null;
  end_time?: string | null;
  pax: number;
  current_vehicle_id?: string | null;
  current_vehicle_label?: string | null;
};

export type HybridVehicleBindingConfig = {
  largeGroupPaxThreshold?: number;
  minBufferMinutes?: number;
  preferFixedVehicleForStandardTrips?: boolean;
};

export type HybridVehicleBindingConflict = {
  type:
    | "standard_vehicle_same_day_conflict"
    | "large_vehicle_shared_timeline_conflict"
    | "driver_vehicle_eligibility_blocker"
    | "vehicle_capacity_insufficient"
    | "vehicle_missing"
    | "driver_missing";
  severity: "info" | "warning" | "blocker";
  group_id: string;
  driver_name: string | null;
  vehicle_label: string | null;
  message: string;
};

export type HybridVehicleBindingLargeUsage = {
  vehicle_id: string | null;
  vehicle_label: string | null;
  driver_key: string | null;
  driver_name: string | null;
  group_id: string;
  start_time: string | null;
  end_time: string | null;
  pax: number;
  buffer_from_previous: number | null;
  status: "large_vehicle_shared_timeline_ok" | "large_vehicle_dedicated_ok" | "large_vehicle_shared_timeline_conflict";
};

export type HybridVehicleBindingStandardBinding = {
  driver_key: string;
  driver_name: string | null;
  vehicle_id: string | null;
  vehicle_label: string | null;
  status: "fixed_standard_vehicle_ok" | "standard_vehicle_missing" | "standard_vehicle_conflict";
};

export type HybridVehicleBindingResult = {
  config: Required<HybridVehicleBindingConfig>;
  vehicles: {
    large: HybridVehicleBindingVehicle[];
    standard: HybridVehicleBindingVehicle[];
  };
  trips: Array<HybridVehicleBindingTrip & {
    is_large_group: boolean;
    proposed_vehicle_id: string | null;
    proposed_vehicle_label: string | null;
  }>;
  large_vehicle_usage: HybridVehicleBindingLargeUsage[];
  standard_vehicle_bindings: HybridVehicleBindingStandardBinding[];
  conflicts: HybridVehicleBindingConflict[];
  summary: {
    conflicts_before: number;
    conflicts_after: number;
    overbooking_after: number;
    large_vehicle_shared_ok: number;
    large_vehicle_shared_conflicts: number;
    standard_vehicle_conflicts: number;
    driver_vehicle_eligibility_blockers: number;
  };
};

function clean(value?: string | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function minutes(value?: string | null) {
  const match = String(value ?? "").match(/(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function formatMinutes(value: number | null) {
  if (value == null || !Number.isFinite(value)) return null;
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function tripInterval(trip: Pick<HybridVehicleBindingTrip, "start_time" | "end_time">) {
  const start = minutes(trip.start_time) ?? 0;
  const end = minutes(trip.end_time) ?? start + 30;
  return { start_min: start, end_min: Math.max(end, start + 30) };
}

function vehicleKey(vehicle: HybridVehicleBindingVehicle) {
  return vehicleResourceKey(vehicle).key ?? clean(vehicle.label);
}

function vehicleMatches(vehicle: HybridVehicleBindingVehicle, trip: HybridVehicleBindingTrip) {
  if (trip.current_vehicle_id && vehicle.id === trip.current_vehicle_id) return true;
  return Boolean(trip.current_vehicle_label && vehicle.label === trip.current_vehicle_label);
}

function driverNameForTrip(trip: HybridVehicleBindingTrip, driver?: HybridVehicleBindingDriver | null) {
  return trip.driver_name ?? driver?.driver_name ?? null;
}

function canUse(driver: HybridVehicleBindingDriver | null | undefined, vehicle: HybridVehicleBindingVehicle) {
  return !driver || canDriverUseVehicle(driver, vehicle).allowed;
}

function hasPaxCapacity(vehicle: HybridVehicleBindingVehicle, pax: number) {
  return vehicle.capacity != null && vehicle.capacity >= pax;
}

export function buildHybridVehicleBinding(args: {
  drivers: HybridVehicleBindingDriver[];
  vehicles: HybridVehicleBindingVehicle[];
  trips: HybridVehicleBindingTrip[];
  config?: HybridVehicleBindingConfig;
}): HybridVehicleBindingResult {
  const config = {
    largeGroupPaxThreshold: args.config?.largeGroupPaxThreshold ?? 21,
    minBufferMinutes: args.config?.minBufferMinutes ?? 20,
    preferFixedVehicleForStandardTrips: args.config?.preferFixedVehicleForStandardTrips ?? true,
  };
  const driversByKey = new Map(args.drivers.map((driver) => [driver.driver_key, driver]));
  const vehicles = args.vehicles
    .filter((vehicle) => vehicleKey(vehicle))
    .sort((a, b) => (a.capacity ?? 0) - (b.capacity ?? 0) || String(a.label ?? "").localeCompare(String(b.label ?? "")));
  const largeVehicles = vehicles.filter((vehicle) => (vehicle.capacity ?? 0) >= config.largeGroupPaxThreshold);
  const standardVehicles = vehicles.filter((vehicle) => (vehicle.capacity ?? 0) < config.largeGroupPaxThreshold);
  const conflicts: HybridVehicleBindingConflict[] = [];
  const largeUsage: HybridVehicleBindingLargeUsage[] = [];
  const standardBindings = new Map<string, HybridVehicleBindingVehicle>();
  const standardVehicleDrivers = new Map<string, string>();
  const largeTimeline = new Map<string, HybridVehicleBindingLargeUsage[]>();
  const vehicleUsageIntervals = new Map<string, Array<{ start_min: number; end_min: number; driver_key: string | null; is_large_group: boolean }>>();
  const assignedTrips: HybridVehicleBindingResult["trips"] = [];

  const currentVehicleDrivers = new Map<string, Set<string | null>>();
  for (const trip of args.trips) {
    if (!trip.current_vehicle_label) continue;
    const set = currentVehicleDrivers.get(trip.current_vehicle_label) ?? new Set<string | null>();
    set.add(trip.driver_key);
    currentVehicleDrivers.set(trip.current_vehicle_label, set);
  }
  const conflictsBefore = Array.from(currentVehicleDrivers.values()).filter((drivers) => drivers.size > 1).length;

  for (const trip of [...args.trips].sort((a, b) => (minutes(a.start_time) ?? 0) - (minutes(b.start_time) ?? 0))) {
    const isLargeGroup = trip.pax >= config.largeGroupPaxThreshold;
    const driver = trip.driver_key ? driversByKey.get(trip.driver_key) : null;
    const driverName = driverNameForTrip(trip, driver);
    const currentVehicle = vehicles.find((vehicle) => vehicleMatches(vehicle, trip)) ?? null;

    if (!driver) {
      conflicts.push({
        type: "driver_missing",
        severity: "blocker",
        group_id: trip.group_id,
        driver_name: driverName,
        vehicle_label: trip.current_vehicle_label ?? null,
        message: "Autista mancante o non disponibile per il giro.",
      });
    }

    const candidatePool = isLargeGroup ? largeVehicles : vehicles;
    const preferredVehicle = currentVehicle && candidatePool.some((vehicle) => vehicleKey(vehicle) === vehicleKey(currentVehicle))
      ? currentVehicle
      : null;
    const candidates = [
      ...(preferredVehicle ? [preferredVehicle] : []),
      ...candidatePool.filter((vehicle) => !preferredVehicle || vehicleKey(vehicle) !== vehicleKey(preferredVehicle)),
    ];

    let chosen: HybridVehicleBindingVehicle | null = null;

    if (isLargeGroup) {
      for (const vehicle of candidates) {
        if (!hasPaxCapacity(vehicle, trip.pax)) continue;
        if (!canUse(driver, vehicle)) continue;
        const key = vehicleKey(vehicle);
        if (!key) continue;
        const interval = tripInterval(trip);
        const timeline = vehicleUsageIntervals.get(key) ?? [];
        const hasConflict = timeline.some((usage) => vehicleIntervalsOverlap(
          usage,
          interval,
          config.minBufferMinutes
        ));
        if (hasConflict) continue;
        chosen = vehicle;
        break;
      }
    } else {
      const bound = trip.driver_key ? standardBindings.get(trip.driver_key) ?? null : null;
      const pool = bound && hasPaxCapacity(bound, trip.pax) ? [bound] : candidates;
      for (const vehicle of pool) {
        if (!hasPaxCapacity(vehicle, trip.pax)) continue;
        if (!canUse(driver, vehicle)) continue;
        const key = vehicleKey(vehicle);
        if (!key) continue;
        const interval = tripInterval(trip);
        if ((vehicle.capacity ?? 0) >= config.largeGroupPaxThreshold) {
          const largeVehicleBusy = (vehicleUsageIntervals.get(key) ?? []).some((usage) => usage.is_large_group && vehicleIntervalsOverlap(usage, interval, config.minBufferMinutes));
          if (largeVehicleBusy) continue;
        }
        const boundDriver = standardVehicleDrivers.get(key);
        if (boundDriver && boundDriver !== trip.driver_key) continue;
        chosen = vehicle;
        break;
      }
    }

    if (!chosen) {
      const anyCapacity = candidatePool.some((vehicle) => hasPaxCapacity(vehicle, trip.pax));
      const anyEligible = candidatePool.some((vehicle) => hasPaxCapacity(vehicle, trip.pax) && canUse(driver, vehicle));
      const type: HybridVehicleBindingConflict["type"] = !anyCapacity
        ? "vehicle_capacity_insufficient"
        : !anyEligible
          ? "driver_vehicle_eligibility_blocker"
          : isLargeGroup
            ? "large_vehicle_shared_timeline_conflict"
            : "standard_vehicle_same_day_conflict";
      conflicts.push({
        type,
        severity: "blocker",
        group_id: trip.group_id,
        driver_name: driverName,
        vehicle_label: trip.current_vehicle_label ?? null,
        message: type === "driver_vehicle_eligibility_blocker"
          ? `Autista ${driverName ?? "selezionato"} non puo guidare un mezzo capiente disponibile.`
          : type === "vehicle_capacity_insufficient"
            ? "Nessun mezzo disponibile con capienza sufficiente."
            : type === "large_vehicle_shared_timeline_conflict"
              ? "Mezzo capiente condiviso non disponibile con buffer sufficiente."
              : "Mezzo standard gia vincolato a un altro autista nella giornata.",
      });
      assignedTrips.push({ ...trip, is_large_group: isLargeGroup, proposed_vehicle_id: null, proposed_vehicle_label: null });
      continue;
    }

    if (isLargeGroup) {
      const key = vehicleKey(chosen)!;
      const interval = tripInterval(trip);
      const previous = (largeTimeline.get(key) ?? [])
        .filter((usage) => (minutes(usage.end_time) ?? 0) <= interval.start_min)
        .sort((a, b) => (minutes(b.end_time) ?? 0) - (minutes(a.end_time) ?? 0))[0] ?? null;
      const buffer = previous ? interval.start_min - (minutes(previous.end_time) ?? interval.start_min) : null;
      const usage: HybridVehicleBindingLargeUsage = {
        vehicle_id: chosen.id ?? null,
        vehicle_label: chosen.label ?? null,
        driver_key: trip.driver_key,
        driver_name: driverName,
        group_id: trip.group_id,
        start_time: formatMinutes(interval.start_min),
        end_time: formatMinutes(interval.end_min),
        pax: trip.pax,
        buffer_from_previous: buffer,
        status: previous ? "large_vehicle_shared_timeline_ok" : "large_vehicle_dedicated_ok",
      };
      largeTimeline.set(key, [...(largeTimeline.get(key) ?? []), usage]);
      vehicleUsageIntervals.set(key, [...(vehicleUsageIntervals.get(key) ?? []), { ...interval, driver_key: trip.driver_key, is_large_group: true }]);
      largeUsage.push(usage);
    } else if (trip.driver_key) {
      const key = vehicleKey(chosen)!;
      const interval = tripInterval(trip);
      standardBindings.set(trip.driver_key, chosen);
      standardVehicleDrivers.set(key, trip.driver_key);
      vehicleUsageIntervals.set(key, [...(vehicleUsageIntervals.get(key) ?? []), { ...interval, driver_key: trip.driver_key, is_large_group: false }]);
    }

    assignedTrips.push({
      ...trip,
      is_large_group: isLargeGroup,
      proposed_vehicle_id: chosen.id ?? null,
      proposed_vehicle_label: chosen.label ?? null,
    });
  }

  const standardBindingRows: HybridVehicleBindingStandardBinding[] = args.drivers.map((driver) => {
    const vehicle = standardBindings.get(driver.driver_key) ?? null;
    return {
      driver_key: driver.driver_key,
      driver_name: driver.driver_name ?? null,
      vehicle_id: vehicle?.id ?? null,
      vehicle_label: vehicle?.label ?? null,
      status: vehicle ? "fixed_standard_vehicle_ok" : "standard_vehicle_missing",
    };
  });

  const overbookingAfter = assignedTrips.filter((trip) => {
    const vehicle = vehicles.find((item) => item.id === trip.proposed_vehicle_id || item.label === trip.proposed_vehicle_label);
    return Boolean(vehicle && vehicle.capacity != null && vehicle.capacity < trip.pax);
  }).length;
  const conflictsAfter = conflicts.filter((conflict) => conflict.severity === "blocker").length;

  return {
    config,
    vehicles: { large: largeVehicles, standard: standardVehicles },
    trips: assignedTrips,
    large_vehicle_usage: largeUsage,
    standard_vehicle_bindings: standardBindingRows,
    conflicts,
    summary: {
      conflicts_before: conflictsBefore,
      conflicts_after: conflictsAfter,
      overbooking_after: overbookingAfter,
      large_vehicle_shared_ok: largeUsage.filter((usage) => usage.status === "large_vehicle_shared_timeline_ok").length,
      large_vehicle_shared_conflicts: conflicts.filter((conflict) => conflict.type === "large_vehicle_shared_timeline_conflict").length,
      standard_vehicle_conflicts: conflicts.filter((conflict) => conflict.type === "standard_vehicle_same_day_conflict").length,
      driver_vehicle_eligibility_blockers: conflicts.filter((conflict) => conflict.type === "driver_vehicle_eligibility_blocker").length,
    },
  };
}
