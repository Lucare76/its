export type GlobalPlannerUnit = {
  id: string;
  type: string;
  label: string;
  start: string | null;
  end: string | null;
  pax: number;
  min_vehicle_capacity: number;
  max_vehicle_capacity?: number | null;
  nonsplittable: boolean;
  current_driver_key?: string | null;
  current_vehicle_label?: string | null;
  buffer_minutes?: number | null;
  locked?: boolean;
  protected_from_backtracking?: boolean;
  dense_shuttle?: boolean;
  learned_driver_scores?: Record<string, number> | null;
};

export type GlobalPlannerDriver = {
  key: string;
  name: string;
  max_vehicle_capacity?: number | null;
  available_from?: string | null;
  available_to?: string | null;
};

export type GlobalPlannerVehicle = {
  key: string;
  label: string | null;
  capacity: number | null;
};

export type GlobalPlannerAssignment<TUnit extends GlobalPlannerUnit = GlobalPlannerUnit> = TUnit & {
  proposed_driver_key: string | null;
  proposed_driver_name: string | null;
  proposed_vehicle_label: string | null;
  proposed_vehicle_capacity: number | null;
  assigned: boolean;
  reason: string;
  blocker?: string | null;
  // ML Data Collection Sprint 2: ranking reale (driver_key/score, già ordinato
  // per score crescente = migliore prima) prodotto da chooseCandidate() per
  // questa unit, esposto invece di essere scartato dopo la scelta. Presente
  // solo per assegnazioni dirette (non per esiti da backtracking/non
  // assegnati, dove un ranking analogo non è disponibile) — mai ricostruito
  // a posteriori.
  candidate_scores?: Array<{ driver_key: string; score: number }>;
  backtracking_moves?: Array<{
    unit_id: string;
    unit_label: string;
    from_driver_key: string | null;
    to_driver_key: string | null;
    from_vehicle_label: string | null;
    to_vehicle_label: string | null;
    reason: string;
  }>;
};

export type GlobalPlannerConfig = {
  largeGroupThreshold?: number;
  backtrackingMaxDepth?: number;
  backtrackingLocalWindowMinutes?: number;
  bufferConflictPolicy?: "min" | "max";
};

const DEFAULT_CONFIG: Required<GlobalPlannerConfig> = {
  largeGroupThreshold: 21,
  backtrackingMaxDepth: 3,
  backtrackingLocalWindowMinutes: 75,
  bufferConflictPolicy: "min",
};

function plannerConfig(config?: GlobalPlannerConfig): Required<GlobalPlannerConfig> {
  return { ...DEFAULT_CONFIG, ...config };
}

function norm(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toUpperCase();
}

export function plannerMinutes(value: unknown) {
  const match = String(value ?? "").match(/(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function interval(unit: Pick<GlobalPlannerUnit, "start" | "end">) {
  const start = plannerMinutes(unit.start);
  const end = plannerMinutes(unit.end);
  return start == null || end == null ? null : { start, end };
}

function inDriverAvailability(unit: GlobalPlannerUnit, driver: GlobalPlannerDriver) {
  const unitInterval = interval(unit);
  const from = plannerMinutes(driver.available_from);
  const to = plannerMinutes(driver.available_to);
  if (!unitInterval || from == null || to == null) return true;
  return unitInterval.start >= from && unitInterval.start <= to;
}

function driverCanUseVehicle(driver: GlobalPlannerDriver, vehicle: GlobalPlannerVehicle) {
  return driver.max_vehicle_capacity == null || (vehicle.capacity ?? 0) <= driver.max_vehicle_capacity;
}

function hardCompatible(unit: GlobalPlannerUnit, driver: GlobalPlannerDriver, vehicle: GlobalPlannerVehicle) {
  return inDriverAvailability(unit, driver)
    && (vehicle.capacity ?? -1) >= unit.min_vehicle_capacity
    && (unit.max_vehicle_capacity == null || (vehicle.capacity ?? 0) <= unit.max_vehicle_capacity)
    && driverCanUseVehicle(driver, vehicle);
}

function overlap(a: GlobalPlannerUnit, b: GlobalPlannerUnit, config?: GlobalPlannerConfig) {
  const left = interval(a);
  const right = interval(b);
  if (!left || !right) return true;
  const resolved = plannerConfig(config);
  const buffer = resolved.bufferConflictPolicy === "max"
    ? Math.max(a.buffer_minutes ?? 5, b.buffer_minutes ?? 5)
    : Math.min(a.buffer_minutes ?? 5, b.buffer_minutes ?? 5);
  return left.start < right.end + buffer && left.end + buffer > right.start;
}

function nearby(a: GlobalPlannerUnit, b: GlobalPlannerUnit, windowMinutes: number) {
  const left = interval(a);
  const right = interval(b);
  if (!left || !right) return false;
  return Math.abs(left.start - right.start) <= windowMinutes || Math.abs(left.end - right.end) <= windowMinutes;
}

function assignmentPriority(unit: GlobalPlannerUnit, candidateCount: number, config?: GlobalPlannerConfig) {
  const resolved = plannerConfig(config);
  if (unit.pax >= resolved.largeGroupThreshold) return 0;
  if (unit.type === "cluster_escursione_roundtrip") return 1;
  if (unit.type === "multi_drop_confirmed" || unit.type === "accorpamento_confirmed") return 2;
  if (candidateCount <= 2) return 3;
  if (unit.dense_shuttle || unit.type === "shuttle_pair" || unit.type === "navetta_speciale") return 5;
  if (unit.pax >= 9) return 6;
  return 7;
}

function unitWeight(unit: GlobalPlannerUnit, config?: GlobalPlannerConfig) {
  const resolved = plannerConfig(config);
  if (unit.locked || unit.protected_from_backtracking) return 1000;
  if (unit.type === "cluster_escursione_roundtrip") return 500;
  if (unit.pax >= resolved.largeGroupThreshold) return 450;
  if (unit.nonsplittable && unit.pax >= 9) return 260;
  if (unit.nonsplittable) return 180;
  return unit.pax;
}

function candidateCount(unit: GlobalPlannerUnit, drivers: GlobalPlannerDriver[], vehicles: GlobalPlannerVehicle[]) {
  let count = 0;
  for (const driver of drivers) {
    for (const vehicle of vehicles) {
      if (hardCompatible(unit, driver, vehicle)) count += 1;
    }
  }
  return count;
}

function conflictsFor(
  unit: GlobalPlannerUnit,
  driverKey: string,
  vehicleKey: string,
  assignments: GlobalPlannerAssignment[],
  config?: GlobalPlannerConfig
) {
  return assignments.filter((assigned) => assigned.assigned && overlap(unit, assigned, config) && (
    assigned.proposed_driver_key === driverKey || norm(assigned.proposed_vehicle_label) === vehicleKey
  ));
}

function chooseCandidate<TUnit extends GlobalPlannerUnit>(
  unit: TUnit,
  drivers: GlobalPlannerDriver[],
  vehicles: GlobalPlannerVehicle[],
  assignments: GlobalPlannerAssignment<TUnit>[],
  config?: GlobalPlannerConfig
) {
  const candidates: Array<{ driver: GlobalPlannerDriver; vehicle: GlobalPlannerVehicle; score: number }> = [];
  for (const driver of drivers) {
    for (const vehicle of vehicles) {
      if (!hardCompatible(unit, driver, vehicle)) continue;
      const vehicleKey = norm(vehicle.label ?? vehicle.key);
      if (conflictsFor(unit, driver.key, vehicleKey, assignments, config).length > 0) continue;
      let score = Math.abs((vehicle.capacity ?? 99) - unit.min_vehicle_capacity);
      if (driver.key === unit.current_driver_key) score -= 100;
      if (norm(vehicle.label) === norm(unit.current_vehicle_label)) score -= 80;
      if (unit.pax >= 9 && unit.pax <= 14 && norm(vehicle.label).includes("DUCATO MAXI")) score -= 15;
      const existingLoad = assignments.filter((a) => a.assigned && a.proposed_driver_key === driver.key).length;
      score += existingLoad * 3;
      score += unit.learned_driver_scores?.[driver.key] ?? 0;
      candidates.push({ driver, vehicle, score });
    }
  }
  const ranked = candidates.sort((a, b) => a.score - b.score);
  return ranked.length > 0 ? { ...ranked[0]!, ranked } : null;
}

function tryLocalBacktrack<TUnit extends GlobalPlannerUnit>(
  unit: TUnit,
  drivers: GlobalPlannerDriver[],
  vehicles: GlobalPlannerVehicle[],
  assignments: GlobalPlannerAssignment<TUnit>[],
  depth: number,
  localWindowMinutes: number,
  config?: GlobalPlannerConfig
) {
  const resolved = plannerConfig(config);
  for (const driver of drivers) {
    for (const vehicle of vehicles) {
      if (!hardCompatible(unit, driver, vehicle)) continue;
      const vehicleKey = norm(vehicle.label ?? vehicle.key);
      const conflicts = conflictsFor(unit, driver.key, vehicleKey, assignments, resolved)
        .filter((item) => !item.locked && nearby(unit, item, localWindowMinutes))
        .sort((a, b) => unitWeight(a, resolved) - unitWeight(b, resolved));
      if (conflicts.length === 0 || conflicts.length > depth) continue;
      if (conflicts.some((conflict) =>
        conflict.locked
        || conflict.protected_from_backtracking
        || conflict.type === "cluster_escursione_roundtrip"
        || conflict.pax >= resolved.largeGroupThreshold
      )) continue;

      const reserved: GlobalPlannerAssignment<TUnit> = {
        ...unit,
        proposed_driver_key: driver.key,
        proposed_driver_name: driver.name,
        proposed_vehicle_label: vehicle.label,
        proposed_vehicle_capacity: vehicle.capacity,
        assigned: true,
        reason: "slot riservato per backtracking locale",
        blocker: null,
      };
      const remaining = [...assignments.filter((item) => !conflicts.includes(item)), reserved];
      const moved: GlobalPlannerAssignment<TUnit>[] = [];
      let ok = true;
      for (const conflict of conflicts) {
        const reassigned = chooseCandidate(conflict, drivers, vehicles, [...remaining, ...moved], resolved);
        if (!reassigned) {
          ok = false;
          break;
        }
        moved.push({
          ...conflict,
          proposed_driver_key: reassigned.driver.key,
          proposed_driver_name: reassigned.driver.name,
          proposed_vehicle_label: reassigned.vehicle.label,
          proposed_vehicle_capacity: reassigned.vehicle.capacity,
          assigned: true,
          reason: "spostato da backtracking locale per liberare unita piu vincolante",
          blocker: null,
        } as GlobalPlannerAssignment<TUnit>);
      }
      if (!ok) continue;
      const candidatePlan = [...remaining, ...moved];
      if (conflictsFor(reserved, reserved.proposed_driver_key!, norm(reserved.proposed_vehicle_label), candidatePlan.filter((item) => item.id !== reserved.id), resolved).length > 0) continue;
      if (moved.some((move, index) => conflictsFor(move, move.proposed_driver_key!, norm(move.proposed_vehicle_label), candidatePlan.filter((_, itemIndex) => itemIndex !== index + remaining.length), resolved).length > 0)) continue;
      return {
        driver,
        vehicle,
        conflicts,
        moved,
      };
    }
  }
  return null;
}

export function orderGlobalPlannerUnits<TUnit extends GlobalPlannerUnit>(
  units: TUnit[],
  drivers: GlobalPlannerDriver[],
  vehicles: GlobalPlannerVehicle[],
  config?: GlobalPlannerConfig
) {
  const resolved = plannerConfig(config);
  return [...units].sort((a, b) => {
    const rankA = assignmentPriority(a, candidateCount(a, drivers, vehicles), resolved);
    const rankB = assignmentPriority(b, candidateCount(b, drivers, vehicles), resolved);
    return rankA - rankB
      || candidateCount(a, drivers, vehicles) - candidateCount(b, drivers, vehicles)
      || b.pax - a.pax
      || (plannerMinutes(a.start) ?? 9999) - (plannerMinutes(b.start) ?? 9999);
  });
}

export function assignGlobalPlanner<TUnit extends GlobalPlannerUnit>(args: {
  units: TUnit[];
  drivers: GlobalPlannerDriver[];
  vehicles: GlobalPlannerVehicle[];
  enableBacktracking?: boolean;
  backtrackingMaxDepth?: number;
  backtrackingLocalWindowMinutes?: number;
  config?: GlobalPlannerConfig;
}) {
  const resolved = plannerConfig({
    ...args.config,
    backtrackingMaxDepth: args.backtrackingMaxDepth ?? args.config?.backtrackingMaxDepth,
    backtrackingLocalWindowMinutes: args.backtrackingLocalWindowMinutes ?? args.config?.backtrackingLocalWindowMinutes,
  });
  const assignments: GlobalPlannerAssignment<TUnit>[] = [];
  for (const unit of orderGlobalPlannerUnits(args.units, args.drivers, args.vehicles, resolved)) {
    const chosen = chooseCandidate(unit, args.drivers, args.vehicles, assignments, resolved);
    if (chosen) {
      assignments.push({
        ...unit,
        proposed_driver_key: chosen.driver.key,
        proposed_driver_name: chosen.driver.name,
        proposed_vehicle_label: chosen.vehicle.label,
        proposed_vehicle_capacity: chosen.vehicle.capacity,
        reason: "riallineamento globale con vincoli autista/mezzo",
        assigned: true,
        blocker: null,
        candidate_scores: chosen.ranked.map((c) => ({ driver_key: c.driver.key, score: c.score })),
      });
      continue;
    }

    const backtracked = args.enableBacktracking
      ? tryLocalBacktrack(
          unit,
          args.drivers,
          args.vehicles,
          assignments,
          resolved.backtrackingMaxDepth,
          resolved.backtrackingLocalWindowMinutes,
          resolved
        )
      : null;
    if (backtracked) {
      const conflictIds = new Set(backtracked.conflicts.map((conflict) => conflict.id));
      for (let index = assignments.length - 1; index >= 0; index -= 1) {
        if (conflictIds.has(assignments[index]!.id)) assignments.splice(index, 1);
      }
      assignments.push(...backtracked.moved);
      assignments.push({
        ...unit,
        proposed_driver_key: backtracked.driver.key,
        proposed_driver_name: backtracked.driver.name,
        proposed_vehicle_label: backtracked.vehicle.label,
        proposed_vehicle_capacity: backtracked.vehicle.capacity,
        reason: "inserita con backtracking locale",
        assigned: true,
        blocker: null,
        backtracking_moves: backtracked.moved.map((move, index) => ({
          unit_id: move.id,
          unit_label: move.label,
          from_driver_key: backtracked.conflicts[index]?.proposed_driver_key ?? null,
          to_driver_key: move.proposed_driver_key,
          from_vehicle_label: backtracked.conflicts[index]?.proposed_vehicle_label ?? null,
          to_vehicle_label: move.proposed_vehicle_label,
          reason: move.reason,
        })),
      });
      continue;
    }

    assignments.push({
      ...unit,
      proposed_driver_key: null,
      proposed_driver_name: null,
      proposed_vehicle_label: null,
      proposed_vehicle_capacity: null,
      reason: "nessuna combinazione autista/mezzo libera e compatibile",
      assigned: false,
      blocker: "NO_COMPATIBLE_SLOT",
    });
  }
  return assignments.sort((a, b) => (plannerMinutes(a.start) ?? 9999) - (plannerMinutes(b.start) ?? 9999));
}
