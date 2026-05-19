import { vehicleResourceKey, type VehicleTimelineIdentity } from "@/lib/piano-vehicle-timeline";
import { canDriverUseVehicle } from "@/lib/piano-driver-vehicle-eligibility";

export type VehicleBindingProposalDriver = {
  driver_key: string;
  driver_name: string;
  current_vehicle_labels?: string[];
  max_pax: number;
  group_count?: number;
  max_vehicle_capacity?: number | null;
};

export type VehicleBindingProposalVehicle = VehicleTimelineIdentity & {
  capacity?: number | null;
};

export type VehicleBindingProposalItem = {
  driver_key: string;
  driver_name: string;
  from_vehicle_label: string | null;
  to_vehicle_id: string | null;
  to_vehicle_label: string | null;
  to_vehicle_capacity: number | null;
  max_pax: number;
  change_required: boolean;
  feasible: boolean;
  reason: string | null;
};

export type VehicleBindingConflictSummary = {
  label: string;
  drivers: string[];
};

export type VehicleBindingProposalResult = {
  proposal: VehicleBindingProposalItem[];
  current_conflicts: VehicleBindingConflictSummary[];
  conflicts_after: VehicleBindingConflictSummary[];
  unused_vehicles_before: VehicleBindingProposalVehicle[];
  unused_vehicles_after: VehicleBindingProposalVehicle[];
  drivers_without_vehicle_before: string[];
  drivers_without_vehicle_after: string[];
  overbooking_after: VehicleBindingProposalItem[];
  vehicle_changes_required: number;
};

function clean(value?: string | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function norm(value?: string | null) {
  return clean(value)?.toUpperCase() ?? "";
}

function uniqueLabels(labels?: string[]) {
  return Array.from(new Set((labels ?? []).map(clean).filter((value): value is string => Boolean(value))));
}

function primaryCurrentVehicle(labels?: string[]) {
  return uniqueLabels(labels)[0] ?? null;
}

function conflictSummary(drivers: VehicleBindingProposalDriver[], labelForDriver: (driver: VehicleBindingProposalDriver) => string | null) {
  const byVehicle = new Map<string, { label: string; drivers: string[] }>();
  for (const driver of drivers) {
    const label = labelForDriver(driver);
    if (!label) continue;
    const key = norm(label);
    const item = byVehicle.get(key) ?? { label, drivers: [] };
    item.drivers.push(driver.driver_name);
    byVehicle.set(key, item);
  }
  return [...byVehicle.values()].filter((item) => new Set(item.drivers).size > 1);
}

function vehicleKey(vehicle: VehicleBindingProposalVehicle) {
  return vehicleResourceKey(vehicle).key ?? norm(vehicle.label);
}

function hasCapacity(vehicle: VehicleBindingProposalVehicle, maxPax: number) {
  return vehicle.capacity == null || vehicle.capacity >= maxPax;
}

function driverCanUseVehicle(driver: VehicleBindingProposalDriver, vehicle: VehicleBindingProposalVehicle) {
  return canDriverUseVehicle(driver, vehicle).allowed;
}

function scoreCandidate(args: {
  drivers: VehicleBindingProposalDriver[];
  assignment: Array<VehicleBindingProposalVehicle | null>;
  currentConflictLabels: Set<string>;
}) {
  let unassigned = 0;
  let changes = 0;
  let movedFromNonConflictingVehicle = 0;
  let keptConflictingVehicle = 0;

  args.drivers.forEach((driver, index) => {
    const vehicle = args.assignment[index] ?? null;
    const current = primaryCurrentVehicle(driver.current_vehicle_labels);
    if (!vehicle) {
      unassigned += 1;
      changes += current ? 1 : 0;
      return;
    }
    const targetLabel = clean(vehicle.label);
    if (current && norm(current) !== norm(targetLabel)) {
      changes += 1;
      if (!args.currentConflictLabels.has(norm(current))) movedFromNonConflictingVehicle += 1;
    }
    if (current && norm(current) === norm(targetLabel) && args.currentConflictLabels.has(norm(current))) {
      keptConflictingVehicle += 1;
    }
  });

  return [
    unassigned,
    movedFromNonConflictingVehicle,
    changes,
    -keptConflictingVehicle,
  ];
}

function compareScore(left: number[], right: number[]) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function proposeVehicleDailyRealignment(args: {
  drivers: VehicleBindingProposalDriver[];
  vehicles: VehicleBindingProposalVehicle[];
}): VehicleBindingProposalResult {
  const drivers = [...args.drivers].sort((a, b) => a.driver_name.localeCompare(b.driver_name));
  const vehicles = [...args.vehicles]
    .filter((vehicle) => vehicleKey(vehicle))
    .sort((a, b) => String(a.label ?? "").localeCompare(String(b.label ?? "")));
  const currentConflicts = conflictSummary(drivers, (driver) => primaryCurrentVehicle(driver.current_vehicle_labels));
  const currentConflictLabels = new Set(currentConflicts.map((conflict) => norm(conflict.label)));
  const currentUsedLabels = new Set(drivers.flatMap((driver) => uniqueLabels(driver.current_vehicle_labels)).map(norm));
  const unusedVehiclesBefore = vehicles.filter((vehicle) => !currentUsedLabels.has(norm(vehicle.label)));

  let bestAssignment: Array<VehicleBindingProposalVehicle | null> = [];
  let bestScore: number[] | null = null;
  const usedVehicleKeys = new Set<string>();
  const currentAssignment: Array<VehicleBindingProposalVehicle | null> = [];

  function search(index: number) {
    if (index >= drivers.length) {
      const candidateScore = scoreCandidate({ drivers, assignment: currentAssignment, currentConflictLabels });
      if (!bestScore || compareScore(candidateScore, bestScore) < 0) {
        bestScore = candidateScore;
        bestAssignment = [...currentAssignment];
      }
      return;
    }

    const driver = drivers[index]!;
    const currentLabels = uniqueLabels(driver.current_vehicle_labels);
    const candidateVehicles = [
      ...vehicles.filter((vehicle) => currentLabels.some((label) => norm(label) === norm(vehicle.label))),
      ...vehicles.filter((vehicle) => !currentLabels.some((label) => norm(label) === norm(vehicle.label))),
    ].filter((vehicle, index, list) => list.findIndex((item) => vehicleKey(item) === vehicleKey(vehicle)) === index);

    for (const vehicle of candidateVehicles) {
      const key = vehicleKey(vehicle);
      if (!key || usedVehicleKeys.has(key) || !hasCapacity(vehicle, driver.max_pax) || !driverCanUseVehicle(driver, vehicle)) continue;
      usedVehicleKeys.add(key);
      currentAssignment[index] = vehicle;
      search(index + 1);
      currentAssignment[index] = null;
      usedVehicleKeys.delete(key);
    }

    currentAssignment[index] = null;
    search(index + 1);
    currentAssignment[index] = null;
  }

  search(0);

  const proposal = drivers.map((driver, index): VehicleBindingProposalItem => {
    const current = primaryCurrentVehicle(driver.current_vehicle_labels);
    const vehicle = bestAssignment[index] ?? null;
    if (!vehicle) {
      return {
        driver_key: driver.driver_key,
        driver_name: driver.driver_name,
        from_vehicle_label: current,
        to_vehicle_id: null,
        to_vehicle_label: null,
        to_vehicle_capacity: null,
        max_pax: driver.max_pax,
        change_required: Boolean(current),
        feasible: false,
        reason: "Nessun mezzo libero con capienza sufficiente.",
      };
    }
    const targetLabel = clean(vehicle.label);
    return {
      driver_key: driver.driver_key,
      driver_name: driver.driver_name,
      from_vehicle_label: current,
      to_vehicle_id: vehicle.id ?? null,
      to_vehicle_label: targetLabel,
      to_vehicle_capacity: vehicle.capacity ?? null,
      max_pax: driver.max_pax,
      change_required: Boolean(current && norm(current) !== norm(targetLabel)),
      feasible: true,
      reason: null,
    };
  });

  const assignedLabels = new Set(proposal.map((item) => norm(item.to_vehicle_label)).filter(Boolean));
  const conflictsAfter = conflictSummary(
    proposal.map((item) => ({
      driver_key: item.driver_key,
      driver_name: item.driver_name,
      current_vehicle_labels: item.to_vehicle_label ? [item.to_vehicle_label] : [],
      max_pax: item.max_pax,
    })),
    (driver) => primaryCurrentVehicle(driver.current_vehicle_labels)
  );

  return {
    proposal,
    current_conflicts: currentConflicts,
    conflicts_after: conflictsAfter,
    unused_vehicles_before: unusedVehiclesBefore,
    unused_vehicles_after: vehicles.filter((vehicle) => !assignedLabels.has(norm(vehicle.label))),
    drivers_without_vehicle_before: drivers
      .filter((driver) => uniqueLabels(driver.current_vehicle_labels).length === 0)
      .map((driver) => driver.driver_name),
    drivers_without_vehicle_after: proposal.filter((item) => !item.to_vehicle_label).map((item) => item.driver_name),
    overbooking_after: proposal.filter((item) => item.to_vehicle_capacity != null && item.to_vehicle_capacity < item.max_pax),
    vehicle_changes_required: proposal.filter((item) => item.change_required).length,
  };
}
