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
import { vehicleIntervalsOverlap } from "@/lib/piano-vehicle-timeline";
import { buildVehicleDailyBinding, driverDailyBindingKey, type VehicleDailyBindingDriver } from "@/lib/piano-vehicle-daily-binding";
import { canDriverUseVehicle } from "@/lib/piano-driver-vehicle-eligibility";
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

export type RealGiroDiagnosticGroup = {
  group_id: string;
  driver_key: string | null;
  driver_name: string | null;
  vehicle_label: string | null;
  services_count: number;
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
  "id" | "tenant_id" | "service_date" | "trip_group_id" | "suggestion_hash" | "confirmed_by" | "confirmed_at" | "status"
>;

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
    warnings: ["Shuttle-pair President rappresentato come ciclo navetta"],
  };
}

function presidentShuttlePairCount(pairs: ReturnType<typeof publicShuttlePair>[]) {
  return pairs.filter((pair) => pair.loop_label.toLowerCase().includes("president")).length;
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
  drivers?: Array<VehicleDailyBindingDriver & { max_vehicle_capacity?: number | null }>;
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

  const conflicts: Array<{
    vehicle_label: string;
    first_group_id: string;
    second_group_id: string;
    first_driver_name: string | null;
    second_driver_name: string | null;
    first_interval: string;
    second_interval: string;
    message: string;
  }> = [];
  const binding = buildVehicleDailyBinding({
    drivers: args.drivers ?? [],
    vehicles: availableVehicles,
    assignments: args.groups
      .filter((group) => group.driver_name || group.vehicle_label)
      .map((group) => ({
        driver_profile_id: group.driver_key?.startsWith("profile:") ? group.driver_key.slice("profile:".length) : null,
        driver_user_id: group.driver_key?.startsWith("user:") ? group.driver_key.slice("user:".length) : null,
        driver_id: group.driver_key && !group.driver_key.startsWith("profile:") && !group.driver_key.startsWith("user:")
          ? group.driver_key
          : null,
        driver_name: group.driver_name,
        label: group.vehicle_label,
        group_id: group.group_id,
      })),
  });
  const driverVehicleBindings = Array.from(binding.driver_to_vehicle.entries()).map(([driverKey, vehicle]) => ({
    driver_key: driverKey,
    driver_name: args.drivers?.find((driver) => driverDailyBindingKey(driver) === driverKey)?.driver_name ?? null,
    vehicle_label: vehicle.label ?? null,
  }));
  const driversWithoutVehicle = binding.unassigned_drivers.map((driver) => ({
    driver_key: driverDailyBindingKey(driver) ?? "",
    driver_name: driver.driver_name ?? null,
  }));
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
  const groupsByVehicle = new Map<string, RealGiroDiagnosticGroup[]>();
  for (const group of args.groups) {
    if (!group.vehicle_label) continue;
    groupsByVehicle.set(group.vehicle_label, [...(groupsByVehicle.get(group.vehicle_label) ?? []), group]);
  }

  for (const [vehicleLabel, vehicleGroups] of groupsByVehicle.entries()) {
    for (let i = 0; i < vehicleGroups.length; i += 1) {
      for (let j = i + 1; j < vehicleGroups.length; j += 1) {
        const first = vehicleGroups[i]!;
        const second = vehicleGroups[j]!;
        const firstInterval = vehicleGroupInterval(first);
        const secondInterval = vehicleGroupInterval(second);
        if (!vehicleIntervalsOverlap(firstInterval, secondInterval, 20)) continue;
        conflicts.push({
          vehicle_label: vehicleLabel,
          first_group_id: first.group_id,
          second_group_id: second.group_id,
          first_driver_name: first.driver_name,
          second_driver_name: second.driver_name,
          first_interval: firstInterval.label,
          second_interval: secondInterval.label,
          message: `Mezzo ${vehicleLabel} assegnato a ${first.driver_name ?? "autista non indicato"} e ${second.driver_name ?? "autista non indicato"} nello stesso intervallo.`,
        });
      }
    }
  }

  return {
    available_vehicles: availableVehicles,
    used_vehicles: usedVehicles,
    unused_vehicles: availableVehicles.length > 0 ? unusedVehicles : [],
    duplicated_vehicles: duplicatedVehicles.filter((label) => availableLabels.size === 0 || availableLabels.has(label)),
    warnings,
    mode: binding.mode,
    driver_vehicle_bindings: driverVehicleBindings,
    drivers_without_vehicle: driversWithoutVehicle,
    vehicles_assigned_to_multiple_drivers: Array.from(vehicleDrivers.entries())
      .filter(([, drivers]) => drivers.size > 1)
      .map(([vehicleLabel, drivers]) => ({ vehicle_label: vehicleLabel, drivers: Array.from(drivers) })),
    driver_vehicle_eligibility: driverVehicleEligibility,
    invalid_driver_vehicle_assignments: invalidDriverVehicleAssignments,
    daily_binding_conflicts: binding.conflicts.map((conflict) => ({
      type: conflict.conflict_type,
      message: conflict.message,
      vehicle_label: conflict.vehicle_label,
      driver_name: conflict.driver_name,
      other_driver_name: conflict.other_driver_name,
    })),
    suggestions: binding.suggestions.map((suggestion) => ({
      driver_name: suggestion.driver_name,
      from_vehicle_label: suggestion.from_vehicle_label,
      to_vehicle_label: suggestion.to_vehicle_label,
      reason: suggestion.reason,
    })),
    conflicts,
  };
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
  drivers?: VehicleDailyBindingDriver[];
}): RealGiroDiagnosticsResult {
  const hotelMap = new Map(args.hotels.map((hotel) => [hotel.id, hotel]));
  const serviceMap = new Map(args.services.map((service) => [service.id, service]));
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
    const stops = mergeSameStops(assignableStopsInput);
    const shuttlePairResult = detectShuttlePairs(stops, {
      enabledHotelNames: ["hotel terme president"],
      maxDeltaMinutes: 10,
    });
    const remainingStopIds = new Set(shuttlePairResult.remaining_stops.map((stop) => stop.stop_id));
    const remainingStops = stops.filter((stop) => remainingStopIds.has(stop.stop_id));
    const shuttlePairStops = shuttlePairResult.shuttle_pairs.map(shuttlePairToStop);
    const diagnosticStops = [...remainingStops, ...shuttlePairStops]
      .sort((a, b) => a.operational_time.localeCompare(b.operational_time));
    const analysis = analyzeGiro(group.id, null, diagnosticStops);
    const sameStopCount = diagnosticStops.filter((stop) => stop.is_merged).length;
    const shuttlePairs = shuttlePairResult.shuttle_pairs.map(publicShuttlePair);
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

  const confirmedByHash = new Map(
    (args.operatorDecisions ?? [])
      .filter((decision) => decision.status === "confirmed")
      .map((decision) => [decision.suggestion_hash, decision])
  );
  const confirmedSuggestionCountsByGroup = new Map<string, number>();
  const totalSuggestionCountsByGroup = new Map<string, number>();
  const baseResolutionSuggestions = generateConflictResolutionSuggestions(groups);
  for (const suggestion of baseResolutionSuggestions) {
    totalSuggestionCountsByGroup.set(
      suggestion.group_id,
      (totalSuggestionCountsByGroup.get(suggestion.group_id) ?? 0) + 1
    );
  }
  const resolutionSuggestions = baseResolutionSuggestions.map((suggestion) => {
    if (!args.tenantId) return suggestion;
    const hash = suggestionHashForDiagnostics({ tenantId: args.tenantId, date: args.date, suggestion });
    const decision = confirmedByHash.get(hash);
    if (!decision) return suggestion;
    confirmedSuggestionCountsByGroup.set(
      suggestion.group_id,
      (confirmedSuggestionCountsByGroup.get(suggestion.group_id) ?? 0) + 1
    );
    return {
      ...suggestion,
      operator_confirmed: true,
      operator_decision_id: decision.id,
      operator_confirmed_by: decision.confirmed_by,
      operator_confirmed_at: decision.confirmed_at,
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
    vehicle_diagnostics: vehicleDiagnostics,
    resolution_suggestions: resolutionSuggestions,
  };
}
