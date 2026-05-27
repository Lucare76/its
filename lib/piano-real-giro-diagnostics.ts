import {
  resolveAssignableService,
  type AssignableServiceResolution,
} from "@/lib/piano-assignable-service";
import { analyzeGiro, type GiroAnalysis } from "@/lib/piano-conflict-classifier";
import { buildResolutionPreview } from "@/lib/piano-conflict-resolution-preview";
import { generateConflictResolutionSuggestions, type ConflictResolutionSuggestion } from "@/lib/piano-conflict-resolution-suggestions";
import { mergeSameStops, type MergedStop, type ResolvedServiceForSameStop } from "@/lib/piano-same-stop-merge";
import { detectShuttlePairs, type ShuttlePairGroup } from "@/lib/piano-shuttle-pair";
import { buildSuggestionHash, type PianoOperatorDecisionRow } from "@/lib/server/piano-operator-decisions";
import { driverDailyBindingKey, type VehicleDailyBindingDriver } from "@/lib/piano-vehicle-daily-binding";
import { canDriverUseVehicle } from "@/lib/piano-driver-vehicle-eligibility";
import { buildHybridVehicleBinding, type HybridVehicleBindingConflict, type HybridVehicleBindingLargeUsage } from "@/lib/piano-hybrid-vehicle-binding";
import { detectExcursionRoundtripClusters, type ExcursionRoundtripCluster } from "@/lib/piano-excursion-roundtrip-cluster";
import { canDriverCoverInterval, type DriverAvailabilityWindow } from "@/lib/piano-driver-availability";
import type {
  AutoAssignPreviewAssignment,
  AutoAssignPreviewHotel,
  AutoAssignPreviewService,
  AutoAssignPreviewServiceRow,
  AutoAssignPreviewTripGroup,
} from "@/lib/piano-assignable-preview";

export type RealGiroDiagnosticStatus = "OK" | "WARNING" | "NOT_OPERATIONAL";

export type RealGiroDiagnosticAssignment = AutoAssignPreviewAssignment & {
  group_id: string;
};

export type RealGiroDiagnosticTripGroup = AutoAssignPreviewTripGroup & {
  date?: string | null;
  driver_user_id?: string | null;
  driver_profile_id?: string | null;
  vehicle_label?: string | null;
  vehicle_capacity?: number | null;
};

export type RealGiroDiagnosticDriver = VehicleDailyBindingDriver & {
  max_vehicle_capacity?: number | null;
  availability?: DriverAvailabilityWindow | null;
};

export type RealGiroOperatorDecision = {
  id: string;
  type: "driver_vehicle_eligibility_blocker" | "vehicle_not_drivable_warning";
  severity: "blocker" | "warning";
  title: string;
  message: string;
  group_ids: string[];
  driver_name: string | null;
  vehicle_label: string | null;
  pax: number;
  reasons: string[];
  suggested_actions: string[];
  required_vehicle_capacity?: { min: number; max: number } | null;
  compatible_available_vehicles?: Array<{ label: string; capacity: number | null }>;
};

export type RealGiroDiagnosticGroup = {
  group_id: string;
  driver_key: string | null;
  driver_name: string | null;
  vehicle_label: string | null;
  services_count: number;
  pax: number;
  start_time: string | null;
  end_time: string | null;
  stops_count: number;
  same_stop_count: number;
  shuttle_pair_count: number;
  needs_review_count: number;
  conflict_count: number;
  warning_count: number;
  status: RealGiroDiagnosticStatus;
  stops: MergedStop[];
  shuttle_pairs: Array<{
    pair_id: string;
    start_time: string;
    end_time: string;
    loop_label: string;
    outbound_service_ids: string[];
    inbound_service_ids: string[];
    explanation: string[];
  }>;
  transitions: GiroAnalysis["transitions"];
  needs_review: AutoAssignPreviewServiceRow[];
  worst_conflict: GiroAnalysis["worst_conflict"];
};

export type RealGiroDiagnosticsResult = {
  ok: true;
  date: string;
  summary: {
    total_groups: number;
    total_services: number;
    groups_ok: number;
    groups_with_warnings: number;
    groups_with_conflicts: number;
    total_conflicts: number;
    total_warnings: number;
    total_needs_review: number;
    total_same_stop_groups: number;
    total_shuttle_pairs: number;
    president_shuttle_pairs_count: number;
    overlaps_removed_by_shuttle_pair: number;
    vehicle_conflict_count: number;
  };
  groups: RealGiroDiagnosticGroup[];
  excursion_roundtrip_clusters: ExcursionRoundtripCluster[];
  operator_required_decisions: RealGiroOperatorDecision[];
  vehicle_diagnostics: {
    available_vehicles: Array<{ id: string | null; label: string; capacity: number | null }>;
    used_vehicles: string[];
    unused_vehicles: string[];
    duplicated_vehicles: string[];
    warnings: string[];
    mode: "fixed_vehicle_per_driver" | "shared_vehicles";
    driver_vehicle_bindings: Array<{ driver_key: string; driver_name: string | null; vehicle_label: string | null }>;
    drivers_without_vehicle: Array<{ driver_key: string; driver_name: string | null }>;
    vehicles_assigned_to_multiple_drivers: Array<{ vehicle_label: string | null; drivers: Array<string | null> }>;
    driver_vehicle_eligibility: Array<{ driver_key: string; driver_name: string | null; max_vehicle_capacity: number | null; vehicles: Array<{ vehicle_label: string; vehicle_capacity: number | null; status: "OK" | "NO_CAPACITY_LIMIT" | "NO" }> }>;
    invalid_driver_vehicle_assignments: Array<{ group_id: string; driver_name: string | null; vehicle_label: string | null; message: string }>;
    daily_binding_conflicts: Array<{ type: string; message: string; vehicle_label: string | null; driver_name: string | null; other_driver_name: string | null }>;
    suggestions: Array<{ driver_name: string | null; from_vehicle_label: string | null; to_vehicle_label: string | null; reason: string }>;
    vehicle_binding: {
      changes_needed: number;
      conflicts_after: number;
      overbooking_after: number;
      driver_vehicle_eligibility_blockers: number;
      driver_availability_blockers: number;
      large_vehicle_shared_timeline_ok: HybridVehicleBindingLargeUsage[];
      large_vehicle_usage: HybridVehicleBindingLargeUsage[];
      vehicle_binding_conflicts: HybridVehicleBindingConflict[];
      vehicle_binding_warnings: HybridVehicleBindingConflict[];
      vehicle_binding_info: HybridVehicleBindingConflict[];
      standard_vehicle_same_day_conflict: HybridVehicleBindingConflict[];
      large_vehicle_shared_timeline_conflict: HybridVehicleBindingConflict[];
      vehicle_capacity_insufficient: HybridVehicleBindingConflict[];
      driver_vehicle_eligibility_blocker: HybridVehicleBindingConflict[];
    };
    conflicts: Array<{
      vehicle_label: string;
      first_group_id: string;
      second_group_id: string;
      first_driver_name: string | null;
      second_driver_name: string | null;
      first_interval: string;
      second_interval: string;
      message: string;
    }>;
  };
  resolution_suggestions: ConflictResolutionSuggestion[];
};

export type RealGiroConfirmedDecision = Pick<
  PianoOperatorDecisionRow,
  | "id"
  | "tenant_id"
  | "service_date"
  | "trip_group_id"
  | "suggestion_hash"
  | "confirmed_by"
  | "confirmed_at"
  | "status"
> & Partial<Pick<
  PianoOperatorDecisionRow,
  | "decision_type"
  | "action"
  | "payload_json"
  | "before_json"
  | "after_json"
>>;

const LARGE_GROUP_PAX_THRESHOLD = 21;
const MIN_BUFFER_MINUTES = 20;

type MultiDropMergedStop = MergedStop & {
  multi_drop?: true;
};

function confidenceScore(resolution: AssignableServiceResolution) {
  const severe = resolution.macro_category === "DA_VERIFICARE"
    || resolution.review_reasons.some((reason) =>
      reason.includes("non determinat")
      || reason.includes("mancante")
      || reason.includes("non valido")
    );
  if (resolution.needs_review) return severe ? 39 : 69;
  if (resolution.soft_preferences.length > 0) return 88;
  return 100;
}

function serviceRow(
  service: AutoAssignPreviewService,
  resolution: AssignableServiceResolution
): AutoAssignPreviewServiceRow {
  return {
    service_id: service.id,
    customer_name: service.customer_name ?? null,
    macro_category: resolution.macro_category,
    assignable: resolution.assignable && !resolution.needs_review && confidenceScore(resolution) >= 80,
    needs_review: resolution.needs_review,
    review_reasons: resolution.review_reasons,
    is_locked: false,
    already_assigned: true,
    already_assigned_unlocked: false,
    confidence_score: confidenceScore(resolution),
    operational_time: resolution.operational_time,
    pickup_label: resolution.pickup_label,
    pickup_type: resolution.pickup_type,
    pickup_zone: resolution.pickup_zone,
    destination_label: resolution.destination_label,
    destination_type: resolution.destination_type,
    destination_zone: resolution.destination_zone,
    pax: resolution.pax,
    capacity_required: resolution.capacity_required,
    booking_service_kind: resolution.booking_service_kind,
    service_type_code: resolution.service_type_code,
    connection_label: resolution.connection_label,
    ferry_company: resolution.ferry_company,
    ferry_departure_time: resolution.ferry_departure_time,
    ferry_arrival_time: resolution.ferry_arrival_time,
    port_departure: resolution.port_departure,
    port_arrival: resolution.port_arrival,
    soft_preferences: resolution.soft_preferences,
    hard_constraints: resolution.hard_constraints,
  };
}

function rowToSameStopService(row: AutoAssignPreviewServiceRow): ResolvedServiceForSameStop {
  return {
    service_id: row.service_id,
    customer_name: row.customer_name,
    macro_category: row.macro_category,
    assignable: row.assignable,
    needs_review: row.needs_review,
    review_reasons: row.review_reasons,
    operational_time: row.operational_time,
    pickup_label: row.pickup_label,
    pickup_zone: row.pickup_zone,
    destination_label: row.destination_label,
    destination_zone: row.destination_zone,
    pax: row.pax,
    ferry_company: row.ferry_company,
    ferry_departure_time: row.ferry_departure_time,
    ferry_arrival_time: row.ferry_arrival_time,
    port_departure: row.port_departure,
    port_arrival: row.port_arrival,
    booking_service_kind: row.booking_service_kind,
    service_type_code: row.service_type_code,
  };
}

function uniqueStopLabels(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const value of values) {
    const label = clean(value);
    const key = normalizeText(label);
    if (!label || seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  return labels;
}

function sameTextValue(left?: string | null, right?: string | null) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  return Boolean(a && b && a === b);
}

function sameMultiDropDeparture(anchor: MergedStop, candidate: MergedStop) {
  return anchor.macro_category === "PARTENZA"
    && candidate.macro_category === "PARTENZA"
    && sameTextValue(anchor.pickup_label, candidate.pickup_label)
    && Math.abs(minutes(anchor.operational_time) - minutes(candidate.operational_time)) <= 5;
}

function makeMultiDropStop(stops: MergedStop[], index: number): MergedStop {
  const ordered = [...stops].sort((a, b) => a.operational_time.localeCompare(b.operational_time));
  const first = ordered[0]!;
  const services = ordered.flatMap((stop) => stop.services);
  const merged: MultiDropMergedStop = {
    ...first,
    stop_id: `multi-drop-${String(index).padStart(4, "0")}`,
    services,
    total_pax: services.reduce((sum, service) => sum + (service.pax ?? 0), 0),
    operational_time: first.operational_time,
    destination_labels: uniqueStopLabels(ordered.flatMap((stop) => stop.destination_labels)),
    is_merged: true,
    merge_reason: "Multi-drop partenza: stesso pickup e destinazioni sequenziali",
    warnings: ordered.flatMap((stop) => stop.warnings ?? []),
    multi_drop: true,
  };
  return merged;
}

function mergeMultiDropStops(stops: MergedStop[]): MergedStop[] {
  const ordered = [...stops].sort((a, b) => a.operational_time.localeCompare(b.operational_time));
  const used = new Set<string>();
  const merged: MergedStop[] = [];
  let multiDropIndex = 1;

  for (const stop of ordered) {
    if (used.has(stop.stop_id)) continue;
    if (stop.macro_category !== "PARTENZA") {
      merged.push(stop);
      used.add(stop.stop_id);
      continue;
    }

    const group = ordered.filter((candidate) =>
      !used.has(candidate.stop_id) && sameMultiDropDeparture(stop, candidate)
    );
    const destinationCount = new Set(
      group.flatMap((candidate) => candidate.destination_labels).map(normalizeText).filter(Boolean)
    ).size;

    if (group.length > 1 && destinationCount > 1) {
      for (const item of group) used.add(item.stop_id);
      merged.push(makeMultiDropStop(group, multiDropIndex));
      multiDropIndex += 1;
      continue;
    }

    used.add(stop.stop_id);
    merged.push(stop);
  }

  return merged.sort((a, b) =>
    a.operational_time.localeCompare(b.operational_time)
      || String(a.pickup_label ?? "").localeCompare(String(b.pickup_label ?? ""))
      || a.stop_id.localeCompare(b.stop_id)
  );
}

function groupStatus(input: {
  needsReviewCount: number;
  conflictCount: number;
  overlapCount: number;
  warningCount: number;
}): RealGiroDiagnosticStatus {
  if (input.needsReviewCount > 0 || input.conflictCount > 0 || input.overlapCount > 0) return "NOT_OPERATIONAL";
  if (input.warningCount > 0) return "WARNING";
  return "OK";
}

function shuttlePairServiceIds(stop: MergedStop) {
  return stop.services.map((service) => service.service_id);
}

function publicShuttlePair(pair: ShuttlePairGroup) {
  return {
    pair_id: pair.pair_id,
    start_time: pair.start_time,
    end_time: pair.end_time,
    loop_label: pair.loop_label,
    outbound_service_ids: shuttlePairServiceIds(pair.outbound as MergedStop),
    inbound_service_ids: shuttlePairServiceIds(pair.inbound as MergedStop),
    explanation: pair.explanation,
  };
}

function shuttlePairToStop(pair: ShuttlePairGroup): MergedStop {
  const outbound = pair.outbound as MergedStop;
  const inbound = pair.inbound as MergedStop;
  const outboundService = outbound.services[0];
  const inboundService = inbound.services[0];
  const syntheticService: ResolvedServiceForSameStop = {
    service_id: pair.pair_id,
    customer_name: pair.loop_label,
    macro_category: "NAVETTA",
    assignable: true,
    needs_review: false,
    review_reasons: [],
    operational_time: pair.start_time,
    pickup_label: outbound.pickup_label,
    pickup_zone: outboundService?.pickup_zone ?? null,
    destination_label: inbound.destination_labels[0] ?? inboundService?.destination_label ?? null,
    destination_zone: inboundService?.destination_zone ?? null,
    pax: pair.total_pax,
    booking_service_kind: "navetta",
    service_type_code: null,
  };

  return {
    stop_id: pair.pair_id,
    services: [syntheticService],
    total_pax: pair.total_pax,
    operational_time: pair.start_time,
    pickup_label: outbound.pickup_label,
    destination_labels: [pair.loop_label],
    macro_category: "NAVETTA",
    ferry_company: null,
    ferry_departure_time: null,
    ferry_arrival_time: null,
    port_departure: null,
    port_arrival: null,
    is_merged: false,
    merge_reason: null,
    warnings: ["Shuttle-pair rappresentato come ciclo navetta"],
  };
}

function presidentShuttlePairCount(pairs: ReturnType<typeof publicShuttlePair>[]) {
  return pairs.filter((pair) => pair.loop_label.toLowerCase().includes("president")).length;
}

function clean(value?: string | number | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeText(value?: string | number | null) {
  return clean(value)
    ?.toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim() ?? "";
}

function minutes(value?: string | null) {
  const [h = "0", m = "0"] = String(value ?? "").slice(0, 5).split(":");
  const hour = Number.parseInt(h, 10);
  const minute = Number.parseInt(m, 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
  return hour * 60 + minute;
}

function formatMinutes(total: number) {
  const normalized = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function stopIsAssignableNavetta(stop: MergedStop) {
  return stop.macro_category === "NAVETTA"
    && stop.services.length > 0
    && stop.services.every((service) => service.assignable !== false && service.needs_review !== true);
}

function stopTextValues(stop: MergedStop) {
  return [
    stop.pickup_label,
    ...stop.destination_labels,
    ...stop.services.flatMap((service) => [
      service.customer_name,
      service.pickup_label,
      service.destination_label,
      service.booking_service_kind,
      service.service_type_code,
    ]),
  ].map(normalizeText);
}

function isSanNicolaCitaraStop(stop: MergedStop) {
  if (!stopIsAssignableNavetta(stop)) return false;
  const values = stopTextValues(stop);
  return values.some((value) => value.includes("san nicola"))
    && values.some((value) => value.includes("citara"));
}

function makeSanNicolaCitaraPair(first: MergedStop, second: MergedStop, index: number): ShuttlePairGroup {
  return {
    pair_id: `san-nicola-citara-shuttle-${String(index).padStart(4, "0")}`,
    type: "SHUTTLE_PAIR",
    outbound: first,
    inbound: second,
    start_time: first.operational_time,
    end_time: second.operational_time,
    loop_label: `NAVETTA CICLO - Hotel San Nicola / Citara - ore ${first.operational_time.slice(0, 5)}`,
    total_pax: first.total_pax + second.total_pax,
    explanation: [
      "Navetta ricorrente San Nicola / Citara",
      "Regola specifica: San Nicola serve Citara e viceversa",
      "Delta orario compatibile con ciclo navetta",
    ],
  };
}

function detectSanNicolaCitaraShuttleCycles(stops: MergedStop[]): {
  shuttle_pairs: ShuttlePairGroup[];
  remaining_stops: MergedStop[];
} {
  const ordered = [...stops].sort((a, b) => a.operational_time.localeCompare(b.operational_time));
  const used = new Set<string>();
  const shuttlePairs: ShuttlePairGroup[] = [];

  for (const stop of ordered) {
    if (used.has(stop.stop_id) || !isSanNicolaCitaraStop(stop)) continue;
    const stopMinutes = minutes(stop.operational_time);
    const match = ordered.find((candidate) => {
      if (candidate.stop_id === stop.stop_id || used.has(candidate.stop_id) || !isSanNicolaCitaraStop(candidate)) return false;
      const delta = minutes(candidate.operational_time) - stopMinutes;
      return delta >= 20 && delta <= 40;
    });
    if (!match) continue;
    used.add(stop.stop_id);
    used.add(match.stop_id);
    shuttlePairs.push(makeSanNicolaCitaraPair(stop, match, shuttlePairs.length + 1));
  }

  return {
    shuttle_pairs: shuttlePairs.sort((a, b) => a.start_time.localeCompare(b.start_time)),
    remaining_stops: ordered.filter((stop) => !used.has(stop.stop_id)),
  };
}

function vehicleGroupInterval(group: RealGiroDiagnosticGroup) {
  const stopTimes = group.stops.map((stop) => stop.operational_time).filter(Boolean).sort();
  const start = stopTimes[0] ?? "00:00";
  const end = stopTimes[stopTimes.length - 1] ?? start;
  const startMin = minutes(start);
  const endMin = Math.max(minutes(end), startMin) + 30;
  return {
    start_min: startMin,
    end_min: endMin,
    label: `${formatMinutes(startMin)}-${formatMinutes(endMin)}`,
  };
}

function buildVehicleDiagnostics(args: {
  groups: RealGiroDiagnosticGroup[];
  vehicles?: Array<{ id?: string | null; label?: string | null; capacity?: number | null }>;
  drivers?: RealGiroDiagnosticDriver[];
}) {
  const availableVehicles = (args.vehicles ?? [])
    .map((vehicle) => ({
      id: vehicle.id ?? null,
      label: String(vehicle.label ?? "").trim(),
      capacity: vehicle.capacity ?? null,
    }))
    .filter((vehicle) => vehicle.label.length > 0)
    .sort((a, b) => a.label.localeCompare(b.label));
  const usedVehicles = Array.from(new Set(
    args.groups.map((group) => group.vehicle_label).filter((label): label is string => Boolean(label))
  )).sort((a, b) => a.localeCompare(b));
  const availableLabels = new Set(availableVehicles.map((vehicle) => vehicle.label));
  const unusedVehicles = availableVehicles
    .filter((vehicle) => !usedVehicles.includes(vehicle.label))
    .map((vehicle) => vehicle.label);
  const duplicatedVehicles = Array.from(
    args.groups.reduce((counts, group) => {
      if (group.vehicle_label) counts.set(group.vehicle_label, (counts.get(group.vehicle_label) ?? 0) + 1);
      return counts;
    }, new Map<string, number>())
  )
    .filter(([, count]) => count > 1)
    .map(([label]) => label)
    .sort((a, b) => a.localeCompare(b));

  const warnings = args.groups
    .filter((group) => group.vehicle_label)
    .map((group) => `Giro ${group.group_id}: vehicle_id non disponibile sullo schema trip_groups/assignments, validazione mezzo basata su vehicle_label "${group.vehicle_label}".`);

  const hybridDrivers = (args.drivers ?? [])
    .map((driver) => {
      const driverKey = driverDailyBindingKey(driver);
      return driverKey
        ? {
            driver_key: driverKey,
            driver_name: driver.driver_name ?? null,
            max_vehicle_capacity: driver.max_vehicle_capacity ?? null,
            ...(driver.availability ? { availability: driver.availability } : {}),
          }
        : null;
    })
    .filter((driver): driver is { driver_key: string; driver_name: string | null; max_vehicle_capacity: number | null } => Boolean(driver));

  const hybrid = buildHybridVehicleBinding({
    drivers: hybridDrivers,
    vehicles: availableVehicles,
    trips: args.groups.map((group) => ({
      group_id: group.group_id,
      driver_key: group.driver_key,
      driver_name: group.driver_name,
      start_time: group.start_time,
      end_time: group.end_time,
      pax: group.pax,
      current_vehicle_label: group.vehicle_label,
    })),
    config: {
      largeGroupPaxThreshold: LARGE_GROUP_PAX_THRESHOLD,
      minBufferMinutes: MIN_BUFFER_MINUTES,
      preferFixedVehicleForStandardTrips: true,
    },
  });

  const proposedByGroupId = new Map(hybrid.trips.map((trip) => [trip.group_id, trip]));
  const changesNeeded = args.groups.filter((group) => {
    const proposed = proposedByGroupId.get(group.group_id);
    return Boolean(proposed?.proposed_vehicle_label && proposed.proposed_vehicle_label !== group.vehicle_label);
  }).length;
  const vehicleBindingConflicts = hybrid.conflicts.filter((conflict) => conflict.severity === "blocker");
  const vehicleBindingWarnings = hybrid.conflicts.filter((conflict) => conflict.severity === "warning");
  const vehicleBindingInfo = hybrid.conflicts.filter((conflict) => conflict.severity === "info");

  const driverVehicleBindings = hybrid.standard_vehicle_bindings.map((binding) => ({
    driver_key: binding.driver_key,
    driver_name: binding.driver_name,
    vehicle_label: binding.vehicle_label ?? null,
  }));
  const driversWithoutVehicle = hybrid.standard_vehicle_bindings
    .filter((binding) => !binding.vehicle_label)
    .map((binding) => ({
      driver_key: binding.driver_key,
      driver_name: binding.driver_name,
    }));
  const legacyConflicts = vehicleBindingConflicts.map((conflict) => ({
    vehicle_label: String(conflict.vehicle_label ?? ""),
    first_group_id: conflict.group_id,
    second_group_id: conflict.group_id,
    first_driver_name: conflict.driver_name,
    second_driver_name: conflict.driver_name,
    first_interval: "",
    second_interval: "",
    message: conflict.message,
  }));

  const conflicts: Array<{
    vehicle_label: string;
    first_group_id: string;
    second_group_id: string;
    first_driver_name: string | null;
    second_driver_name: string | null;
    first_interval: string;
    second_interval: string;
    message: string;
  }> = legacyConflicts;
  const legacyDailyBindingConflicts = vehicleBindingConflicts.map((conflict) => ({
    type: conflict.type,
    message: conflict.message,
    vehicle_label: conflict.vehicle_label,
    driver_name: conflict.driver_name,
    other_driver_name: null,
  }));
  const suggestions = args.groups
    .map((group) => {
      const proposed = proposedByGroupId.get(group.group_id);
      if (!proposed?.proposed_vehicle_label || proposed.proposed_vehicle_label === group.vehicle_label) return null;
      return {
        driver_name: group.driver_name,
        from_vehicle_label: group.vehicle_label,
        to_vehicle_label: proposed.proposed_vehicle_label,
        reason: proposed.is_large_group
          ? "Mezzo capiente condiviso a timeline secondo hybrid_vehicle_binding."
          : "Riallineamento mezzo fisso/compatibile secondo hybrid_vehicle_binding.",
      };
    })
    .filter((suggestion): suggestion is { driver_name: string | null; from_vehicle_label: string | null; to_vehicle_label: string; reason: string } => Boolean(suggestion));

  const mode: "fixed_vehicle_per_driver" | "shared_vehicles" =
    availableVehicles.length < hybridDrivers.length ? "shared_vehicles" : "fixed_vehicle_per_driver";
  const hybridVehicleBinding = {
    changes_needed: changesNeeded,
    conflicts_after: hybrid.summary.conflicts_after,
    overbooking_after: hybrid.summary.overbooking_after,
    driver_vehicle_eligibility_blockers: hybrid.summary.driver_vehicle_eligibility_blockers,
    driver_availability_blockers: hybrid.summary.driver_availability_blockers,
    large_vehicle_shared_timeline_ok: hybrid.large_vehicle_usage.filter((usage) => usage.status === "large_vehicle_shared_timeline_ok"),
    large_vehicle_usage: hybrid.large_vehicle_usage,
    vehicle_binding_conflicts: vehicleBindingConflicts,
    vehicle_binding_warnings: vehicleBindingWarnings,
    vehicle_binding_info: vehicleBindingInfo,
    standard_vehicle_same_day_conflict: vehicleBindingConflicts.filter((conflict) => conflict.type === "standard_vehicle_same_day_conflict"),
    large_vehicle_shared_timeline_conflict: vehicleBindingConflicts.filter((conflict) => conflict.type === "large_vehicle_shared_timeline_conflict"),
    vehicle_capacity_insufficient: vehicleBindingConflicts.filter((conflict) => conflict.type === "vehicle_capacity_insufficient"),
    driver_vehicle_eligibility_blocker: vehicleBindingConflicts.filter((conflict) => conflict.type === "driver_vehicle_eligibility_blocker"),
  };
  const driverVehicleEligibility = (args.drivers ?? []).map((driver) => ({
    driver_key: driverDailyBindingKey(driver) ?? "",
    driver_name: driver.driver_name ?? null,
    max_vehicle_capacity: driver.max_vehicle_capacity ?? null,
    vehicles: availableVehicles.map((vehicle) => {
      const result = canDriverUseVehicle(driver, vehicle);
      return {
        vehicle_label: vehicle.label,
        vehicle_capacity: vehicle.capacity,
        status: result.allowed
          ? driver.max_vehicle_capacity == null ? "NO_CAPACITY_LIMIT" as const : "OK" as const
          : "NO" as const,
      };
    }),
  }));
  const vehicleByLabel = new Map(availableVehicles.map((vehicle) => [vehicle.label, vehicle]));
  const driverByKey = new Map((args.drivers ?? []).map((driver) => [driverDailyBindingKey(driver), driver]));
  const invalidDriverVehicleAssignments = args.groups.flatMap((group) => {
    if (!group.driver_key || !group.vehicle_label) return [];
    const driver = driverByKey.get(group.driver_key);
    const vehicle = vehicleByLabel.get(group.vehicle_label);
    if (!driver || !vehicle) return [];
    const result = canDriverUseVehicle(driver, vehicle);
    if (result.allowed) return [];
    return [{
      group_id: group.group_id,
      driver_name: group.driver_name,
      vehicle_label: group.vehicle_label,
      message: `Autista ${group.driver_name ?? "selezionato"} non puo guidare mezzo ${group.vehicle_label}: capienza mezzo superiore al limite.`,
    }];
  });
  const vehicleDrivers = new Map<string, Set<string | null>>();
  for (const group of args.groups) {
    if (!group.vehicle_label) continue;
    const set = vehicleDrivers.get(group.vehicle_label) ?? new Set<string | null>();
    set.add(group.driver_name);
    vehicleDrivers.set(group.vehicle_label, set);
  }
  return {
    available_vehicles: availableVehicles,
    used_vehicles: usedVehicles,
    unused_vehicles: availableVehicles.length > 0 ? unusedVehicles : [],
    duplicated_vehicles: duplicatedVehicles.filter((label) => availableLabels.size === 0 || availableLabels.has(label)),
    warnings,
    mode,
    driver_vehicle_bindings: driverVehicleBindings,
    drivers_without_vehicle: driversWithoutVehicle,
    vehicles_assigned_to_multiple_drivers: Array.from(vehicleDrivers.entries())
      .filter(([, drivers]) => drivers.size > 1)
      .map(([vehicleLabel, drivers]) => ({ vehicle_label: vehicleLabel, drivers: Array.from(drivers) })),
    driver_vehicle_eligibility: driverVehicleEligibility,
    invalid_driver_vehicle_assignments: invalidDriverVehicleAssignments,
    daily_binding_conflicts: legacyDailyBindingConflicts,
    suggestions,
    vehicle_binding: hybridVehicleBinding,
    conflicts,
  };
}

function groupContainsText(group: RealGiroDiagnosticGroup, text: string) {
  const normalized = normalizeText(text);
  return group.stops.some((stop) =>
    stop.services.some((service) => normalizeText(service.customer_name).includes(normalized))
  );
}

function groupServiceIds(group: RealGiroDiagnosticGroup) {
  return group.stops.flatMap((stop) => stop.services.map((service) => service.service_id));
}

function groupOverlapsInterval(group: RealGiroDiagnosticGroup, startTime: string, endTime: string) {
  const interval = vehicleGroupInterval(group);
  const start = minutes(startTime);
  const end = minutes(endTime);
  return start < interval.end_min && interval.start_min < end;
}

function driverForGroup(group: RealGiroDiagnosticGroup, drivers: RealGiroDiagnosticDriver[]) {
  return drivers.find((driver) => driverDailyBindingKey(driver) === group.driver_key) ?? null;
}

function vehicleForGroup(
  group: RealGiroDiagnosticGroup,
  vehicles: Array<{ id: string | null; label: string; capacity: number | null }>
) {
  return vehicles.find((vehicle) => normalizeText(vehicle.label) === normalizeText(group.vehicle_label)) ?? null;
}

function clusterRelocationCandidates(args: {
  cluster: ExcursionRoundtripCluster;
  groups: RealGiroDiagnosticGroup[];
  drivers: RealGiroDiagnosticDriver[];
  vehicles: Array<{ id: string | null; label: string; capacity: number | null }>;
}) {
  const clusterIds = new Set(args.cluster.service_ids);
  const outboundStart = args.cluster.outbound_services[0]?.operational_time ?? "14:30";
  const outboundEnd = "15:20";
  const returnStart = args.cluster.return_services[0]?.operational_time ?? "17:15";
  const returnEnd = "17:45";
  const compatibleVehicles = args.vehicles.filter((vehicle) => (vehicle.capacity ?? 0) >= args.cluster.total_pax);

  return args.drivers.map((driver) => {
    const driverKey = driverDailyBindingKey(driver);
    const timeline = args.groups.filter((group) => group.driver_key === driverKey);
    const coversOutbound = canDriverCoverInterval(driver.availability, {
      start_time: outboundStart,
      end_time: outboundEnd,
    }, { missingAvailability: "blocker", missingBounds: "blocker" });
    const coversReturn = canDriverCoverInterval(driver.availability, {
      start_time: returnStart,
      end_time: returnEnd,
    }, { missingAvailability: "blocker", missingBounds: "blocker" });
    const conflicts = timeline.filter((group) => {
      const serviceIds = new Set(groupServiceIds(group));
      if ([...serviceIds].some((serviceId) => clusterIds.has(serviceId))) return true;
      return groupOverlapsInterval(group, outboundStart, outboundEnd)
        || groupOverlapsInterval(group, returnStart, returnEnd);
    });
    const vehicle = compatibleVehicles.find((candidate) => canDriverUseVehicle(driver, candidate).allowed) ?? null;
    return {
      driver,
      covers_outbound: coversOutbound.allowed,
      covers_return: coversReturn.allowed,
      vehicle,
      conflicts,
      ok: coversOutbound.allowed && coversReturn.allowed && Boolean(vehicle) && conflicts.length === 0,
    };
  });
}

function buildOperatorRequiredDecisions(args: {
  groups: RealGiroDiagnosticGroup[];
  clusters: ExcursionRoundtripCluster[];
  drivers: RealGiroDiagnosticDriver[];
  vehicles: Array<{ id: string | null; label: string; capacity: number | null }>;
}): RealGiroOperatorDecision[] {
  const decisions: RealGiroOperatorDecision[] = [];
  const mortellaCluster = args.clusters.find((cluster) => cluster.cluster_id === "excursion-mortella-roundtrip") ?? null;
  const mortellaCandidates = mortellaCluster
    ? clusterRelocationCandidates({ cluster: mortellaCluster, groups: args.groups, drivers: args.drivers, vehicles: args.vehicles })
    : [];
  const canMoveMortellaCluster = mortellaCandidates.some((candidate) => candidate.ok);
  const ilariaCandidate = mortellaCandidates.find((candidate) => normalizeText(candidate.driver.driver_name).includes("ilaria"));

  for (const group of args.groups) {
    const driver = driverForGroup(group, args.drivers);
    const vehicle = vehicleForGroup(group, args.vehicles);
    if (!driver || !vehicle) continue;
    const eligibility = canDriverUseVehicle(driver, vehicle);
    if (eligibility.allowed) continue;

    const isGprPeter = groupContainsText(group, "GPR PETER") && group.pax >= LARGE_GROUP_PAX_THRESHOLD;
    if (isGprPeter) {
      decisions.push({
        id: `operator-blocker-gpr-peter-${group.group_id}`,
        type: "driver_vehicle_eligibility_blocker",
        severity: "blocker",
        title: "GPR PETER - non risolvibile automaticamente",
        message: "Riccardo puo guidare massimo mezzi da 16 posti. Il giro GPR PETER ha 21 pax e richiede mezzo capiente.",
        group_ids: [group.group_id],
        driver_name: group.driver_name,
        vehicle_label: group.vehicle_label,
        pax: group.pax,
        reasons: [
          "Gruppo non splittabile.",
          "Riccardo non abilitato al 25 posti.",
          ilariaCandidate ? "Ilaria e abilitata al 25 posti ma risulta coinvolta nel cluster Mortella." : "Ilaria non e disponibile come alternativa automatica.",
          canMoveMortellaCluster ? "Il cluster Mortella ha almeno un candidato, serve comunque conferma operatore." : "Nessun autista alternativo libero puo prendere tutto il cluster Mortella.",
        ],
        suggested_actions: [
          "Aggiungere autista disponibile e abilitato al 25 posti.",
          "Anticipare disponibilita Leo solo se operativamente vero.",
          "Cambiare manualmente assegnazione cluster Mortella.",
          "Lasciare da verificare operatore.",
        ],
      });
      continue;
    }

    const driverName = normalizeText(group.driver_name);
    const isMarioZabattta = driverName.includes("mario zabatta") || driverName.includes("mario zabattta");
    if (isMarioZabattta) {
      const minCapacity = Math.max(1, group.pax);
      decisions.push({
        id: `operator-warning-mario-zabattta-${group.group_id}`,
        type: "vehicle_not_drivable_warning",
        severity: "warning",
        title: "Mario Zabattta - mezzo non compatibile",
        message: "Mario Zabattta puo guidare massimo mezzi da 16 posti. Serve mezzo disponibile con capienza compatibile.",
        group_ids: [group.group_id],
        driver_name: group.driver_name,
        vehicle_label: group.vehicle_label,
        pax: group.pax,
        reasons: [
          `${group.vehicle_label ?? "Mezzo attuale"} non guidabile con max_vehicle_capacity 16.`,
          `Mezzo richiesto: capacity >= ${minCapacity} e <= 16.`,
        ],
        suggested_actions: [
          "Scegliere manualmente un mezzo disponibile del giorno con capienza compatibile.",
          "Non proporre mezzi assenti dalla disponibilita giornaliera.",
          "Lasciare da verificare operatore se nessun mezzo compatibile e libero.",
        ],
        required_vehicle_capacity: { min: minCapacity, max: 16 },
        compatible_available_vehicles: args.vehicles
          .filter((candidate) => (candidate.capacity ?? 0) >= minCapacity && (candidate.capacity ?? 0) <= 16)
          .map((candidate) => ({ label: candidate.label, capacity: candidate.capacity })),
      });
    }
  }

  return decisions;
}

function suggestionTouchesPartialCluster(
  suggestion: ConflictResolutionSuggestion,
  clusters: ExcursionRoundtripCluster[]
) {
  const suggestionIds = new Set(suggestion.involved_services.map((service) => service.service_id));
  return clusters.some((cluster) => {
    const clusterIds = new Set(cluster.service_ids);
    const touched = [...suggestionIds].some((serviceId) => clusterIds.has(serviceId));
    if (!touched) return false;
    return cluster.service_ids.some((serviceId) => !suggestionIds.has(serviceId));
  });
}

function suggestionHashForDiagnostics(input: {
  tenantId: string;
  date: string;
  suggestion: ConflictResolutionSuggestion;
}) {
  const preview = buildResolutionPreview(input.suggestion);
  return buildSuggestionHash({
    tenant_id: input.tenantId,
    service_date: input.date,
    trip_group_id: input.suggestion.group_id,
    action: input.suggestion.recommended_action,
    service_ids: input.suggestion.involved_services.map((service) => service.service_id),
    before_json: preview.before,
    after_json: preview.after,
  });
}

function collectDecisionServiceIds(value: unknown, ids = new Set<string>()) {
  if (!value || typeof value !== "object") return ids;
  if (Array.isArray(value)) {
    for (const item of value) collectDecisionServiceIds(item, ids);
    return ids;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.service_id === "string" && record.service_id.length > 0) ids.add(record.service_id);
  for (const item of Object.values(record)) collectDecisionServiceIds(item, ids);
  return ids;
}

function sameStringSet(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((item) => rightSet.has(item));
}

function isSubset(left: string[], right: string[]) {
  if (left.length === 0) return false;
  const rightSet = new Set(right);
  return left.every((item) => rightSet.has(item));
}

function decisionMatchesSuggestion(args: {
  decision: RealGiroConfirmedDecision;
  suggestion: ConflictResolutionSuggestion;
  hash: string | null;
}) {
  const { decision, suggestion, hash } = args;
  if (decision.status !== "confirmed") return false;
  if (hash && decision.suggestion_hash === hash) return true;
  if (decision.action !== suggestion.recommended_action) return false;

  const decisionServiceIds = Array.from(collectDecisionServiceIds({
    payload_json: decision.payload_json,
    before_json: decision.before_json,
    after_json: decision.after_json,
  })).sort();
  const suggestionServiceIds = suggestion.involved_services
    .map((service) => service.service_id)
    .filter(Boolean)
    .sort();

  if (suggestionServiceIds.length < 2 || decisionServiceIds.length < 2) return false;
  return sameStringSet(decisionServiceIds, suggestionServiceIds)
    || isSubset(suggestionServiceIds, decisionServiceIds);
}

function findConfirmedDecisionForSuggestion(args: {
  decisions: RealGiroConfirmedDecision[];
  suggestion: ConflictResolutionSuggestion;
  hash: string | null;
}) {
  return args.decisions.find((decision) => decisionMatchesSuggestion({
    decision,
    suggestion: args.suggestion,
    hash: args.hash,
  })) ?? null;
}

export function buildRealGiroDiagnostics(args: {
  tenantId?: string;
  date: string;
  services: AutoAssignPreviewService[];
  hotels: AutoAssignPreviewHotel[];
  assignments: RealGiroDiagnosticAssignment[];
  tripGroups: RealGiroDiagnosticTripGroup[];
  operatorDecisions?: RealGiroConfirmedDecision[];
  driverNamesByUserId?: Map<string, string>;
  driverNamesByProfileId?: Map<string, string>;
  vehicles?: Array<{ id?: string | null; label?: string | null; capacity?: number | null }>;
  drivers?: RealGiroDiagnosticDriver[];
}): RealGiroDiagnosticsResult {
  const hotelMap = new Map(args.hotels.map((hotel) => [hotel.id, hotel]));
  const serviceMap = new Map(args.services.map((service) => [service.id, service]));
  const excursionRoundtripClusters = detectExcursionRoundtripClusters({
    services: args.services,
    hotels: args.hotels,
  });
  const assignmentsByGroup = new Map<string, RealGiroDiagnosticAssignment[]>();
  for (const assignment of args.assignments) {
    const list = assignmentsByGroup.get(assignment.group_id) ?? [];
    list.push(assignment);
    assignmentsByGroup.set(assignment.group_id, list);
  }

  const groups = args.tripGroups.map<RealGiroDiagnosticGroup>((group) => {
    const groupAssignments = assignmentsByGroup.get(group.id) ?? [];
    const rows = groupAssignments
      .map((assignment) => serviceMap.get(assignment.service_id))
      .filter((service): service is AutoAssignPreviewService => Boolean(service))
      .map((service) => {
        const resolution = resolveAssignableService(service, {
          hotel: service.hotel_id ? hotelMap.get(service.hotel_id) ?? null : null,
        });
        return serviceRow(service, resolution);
      });

    const needsReview = rows.filter((row) => row.needs_review);
    const assignableStopsInput = rows
      .filter((row) => row.assignable && !row.needs_review)
      .map(rowToSameStopService);
    const stops = mergeMultiDropStops(mergeSameStops(assignableStopsInput));
    const shuttlePairResult = detectShuttlePairs(stops, {
      enabledHotelNames: ["hotel terme president"],
      maxDeltaMinutes: 10,
    });
    const presidentRemainingStopIds = new Set(shuttlePairResult.remaining_stops.map((stop) => stop.stop_id));
    const presidentRemainingStops = stops.filter((stop) => presidentRemainingStopIds.has(stop.stop_id));
    const sanNicolaShuttlePairResult = detectSanNicolaCitaraShuttleCycles(presidentRemainingStops);
    const remainingStopIds = new Set(sanNicolaShuttlePairResult.remaining_stops.map((stop) => stop.stop_id));
    const remainingStops = presidentRemainingStops.filter((stop) => remainingStopIds.has(stop.stop_id));
    const allShuttlePairs = [...shuttlePairResult.shuttle_pairs, ...sanNicolaShuttlePairResult.shuttle_pairs];
    const shuttlePairStops = allShuttlePairs.map(shuttlePairToStop);
    const diagnosticStops = [...remainingStops, ...shuttlePairStops]
      .sort((a, b) => a.operational_time.localeCompare(b.operational_time));
    const groupPax = rows.reduce((sum, row) => sum + (Number(row.pax) || 0), 0);
    const stopMinutes = rows
      .map((row) => row.operational_time)
      .filter((value): value is string => Boolean(value))
      .map((value) => minutes(value))
      .filter((value) => Number.isFinite(value));
    const startMin = stopMinutes.length > 0 ? Math.min(...stopMinutes) : null;
    const endMin = stopMinutes.length > 0 ? Math.max(...stopMinutes) + 30 : null;
    const analysis = analyzeGiro(group.id, null, diagnosticStops);
    const sameStopCount = diagnosticStops.filter((stop) => stop.is_merged).length;
    const shuttlePairs = allShuttlePairs.map(publicShuttlePair);
    const status = groupStatus({
      needsReviewCount: needsReview.length,
      conflictCount: analysis.conflict_count,
      overlapCount: analysis.overlap_count,
      warningCount: analysis.warning_count,
    });
    const driverName = group.driver_profile_id
      ? args.driverNamesByProfileId?.get(group.driver_profile_id) ?? null
      : group.driver_user_id
        ? args.driverNamesByUserId?.get(group.driver_user_id) ?? null
        : null;

    return {
      group_id: group.id,
      driver_key: group.driver_profile_id
        ? `profile:${group.driver_profile_id}`
        : group.driver_user_id
          ? `user:${group.driver_user_id}`
          : null,
      driver_name: driverName,
      vehicle_label: group.vehicle_label ?? null,
      services_count: rows.length,
      pax: groupPax,
      start_time: startMin == null ? null : formatMinutes(startMin),
      end_time: endMin == null ? null : formatMinutes(endMin),
      stops_count: diagnosticStops.length,
      shuttle_pair_count: shuttlePairs.length,
      same_stop_count: sameStopCount,
      needs_review_count: needsReview.length,
      conflict_count: analysis.conflict_count + analysis.overlap_count,
      warning_count: analysis.warning_count,
      status,
      stops: diagnosticStops,
      shuttle_pairs: shuttlePairs,
      transitions: analysis.transitions,
      needs_review: needsReview,
      worst_conflict: analysis.worst_conflict,
    };
  }).sort((a, b) => {
    const aFirst = a.stops[0]?.operational_time ?? "99:99";
    const bFirst = b.stops[0]?.operational_time ?? "99:99";
    return aFirst.localeCompare(bFirst) || String(a.driver_name ?? "").localeCompare(String(b.driver_name ?? ""));
  });

  const confirmedDecisions = (args.operatorDecisions ?? []).filter((decision) => decision.status === "confirmed");
  const confirmedSuggestionCountsByGroup = new Map<string, number>();
  const totalSuggestionCountsByGroup = new Map<string, number>();
  const baseResolutionSuggestions = generateConflictResolutionSuggestions(groups);
  for (const suggestion of baseResolutionSuggestions) {
    totalSuggestionCountsByGroup.set(
      suggestion.group_id,
      (totalSuggestionCountsByGroup.get(suggestion.group_id) ?? 0) + 1
    );
  }
  const resolutionSuggestions = baseResolutionSuggestions
    .filter((suggestion) => !suggestionTouchesPartialCluster(suggestion, excursionRoundtripClusters))
    .map((suggestion) => {
    const hash = args.tenantId
      ? suggestionHashForDiagnostics({ tenantId: args.tenantId, date: args.date, suggestion })
      : null;
    const decision = findConfirmedDecisionForSuggestion({
      decisions: confirmedDecisions,
      suggestion,
      hash,
    });
    if (!decision) return suggestion;
    confirmedSuggestionCountsByGroup.set(
      suggestion.group_id,
      (confirmedSuggestionCountsByGroup.get(suggestion.group_id) ?? 0) + 1
    );
    return {
      ...suggestion,
      operator_confirmed: true,
      operator_decision_id: decision.id,
      operator_decision_type: decision.decision_type,
      operator_confirmed_by: decision.confirmed_by,
      operator_confirmed_at: decision.confirmed_at,
      operator_confirmed_severity: "confirmed_warning" as const,
    };
    });
  const adjustedGroups = groups.map((group) => {
    const confirmedCount = confirmedSuggestionCountsByGroup.get(group.group_id) ?? 0;
    if (confirmedCount <= 0) return group;
    const totalSuggestionCount = totalSuggestionCountsByGroup.get(group.group_id) ?? 0;
    const allOperationalProblemsConfirmed = totalSuggestionCount > 0 && confirmedCount >= totalSuggestionCount;
    const conflictCount = allOperationalProblemsConfirmed ? 0 : Math.max(0, group.conflict_count - confirmedCount);
    return {
      ...group,
      conflict_count: conflictCount,
      status: groupStatus({
        needsReviewCount: group.needs_review_count,
        conflictCount,
        overlapCount: 0,
        warningCount: group.warning_count,
      }),
    };
  });
  const vehicleDiagnostics = buildVehicleDiagnostics({ groups: adjustedGroups, vehicles: args.vehicles, drivers: args.drivers });
  const operatorRequiredDecisions = buildOperatorRequiredDecisions({
    groups: adjustedGroups,
    clusters: excursionRoundtripClusters,
    drivers: args.drivers ?? [],
    vehicles: vehicleDiagnostics.available_vehicles,
  });

  return {
    ok: true,
    date: args.date,
    summary: {
      total_groups: adjustedGroups.length,
      total_services: adjustedGroups.reduce((sum, group) => sum + group.services_count, 0),
      groups_ok: adjustedGroups.filter((group) => group.status === "OK").length,
      groups_with_warnings: adjustedGroups.filter((group) => group.status === "WARNING").length,
      groups_with_conflicts: adjustedGroups.filter((group) => group.status === "NOT_OPERATIONAL").length,
      total_conflicts: adjustedGroups.reduce((sum, group) => sum + group.conflict_count, 0),
      total_warnings: adjustedGroups.reduce((sum, group) => sum + group.warning_count, 0),
      total_needs_review: adjustedGroups.reduce((sum, group) => sum + group.needs_review_count, 0),
      total_same_stop_groups: adjustedGroups.reduce((sum, group) => sum + group.same_stop_count, 0),
      total_shuttle_pairs: adjustedGroups.reduce((sum, group) => sum + group.shuttle_pair_count, 0),
      president_shuttle_pairs_count: adjustedGroups.reduce((sum, group) => sum + presidentShuttlePairCount(group.shuttle_pairs), 0),
      overlaps_removed_by_shuttle_pair: adjustedGroups.reduce((sum, group) => sum + group.shuttle_pair_count, 0),
      vehicle_conflict_count: vehicleDiagnostics.conflicts.length,
    },
    groups: adjustedGroups,
    excursion_roundtrip_clusters: excursionRoundtripClusters,
    operator_required_decisions: operatorRequiredDecisions,
    vehicle_diagnostics: vehicleDiagnostics,
    resolution_suggestions: resolutionSuggestions,
  };
}
