import {
  resolveAssignableService,
  type AssignableMacroCategory,
  type AssignablePlaceType,
  type AssignableService,
  type AssignableServiceResolution,
} from "@/lib/piano-assignable-service";
import { analyzeGiro, type GiroAnalysis } from "@/lib/piano-conflict-classifier";
import { mergeSameStops, type MergedStop, type ResolvedServiceForSameStop } from "@/lib/piano-same-stop-merge";

export type AutoAssignPreviewMode = "all" | "unassigned_only";
export type AutoAssignPreviewUiMode = "normal" | "intense_day" | "sunday_massive";
export type AutoAssignPreviewStatusValue = "READY" | "READY_WITH_WARNINGS" | "PARTIAL" | "NOT_READY";

export type AutoAssignPreviewAssignment = {
  service_id: string;
  group_id?: string | null;
  locked_by_operator?: boolean | null;
  driver_user_id?: string | null;
  driver_profile_id?: string | null;
  vehicle_label?: string | null;
};

export type AutoAssignPreviewTripGroup = {
  id: string;
  status?: string | null;
};

export type AutoAssignPreviewHotel = {
  id: string;
  name?: string | null;
  zone?: string | null;
  lat?: number | null;
  lng?: number | null;
};

export type AutoAssignPreviewService = AssignableService & {
  date?: string | null;
  status?: string | null;
  phone?: string | null;
};

export type AutoAssignPreviewServiceRow = {
  service_id: string;
  customer_name: string | null;
  macro_category: AssignableMacroCategory;
  assignable: boolean;
  needs_review: boolean;
  review_reasons: string[];
  is_locked: boolean;
  already_assigned: boolean;
  already_assigned_unlocked: boolean;
  confidence_score: number;
  operational_time: string | null;
  pickup_label: string | null;
  pickup_type: AssignablePlaceType | null;
  pickup_zone: string | null;
  destination_label: string | null;
  destination_type: AssignablePlaceType | null;
  destination_zone: string | null;
  pax: number | null;
  capacity_required: number;
  booking_service_kind: string | null;
  service_type_code: string | null;
  connection_label: string | null;
  ferry_company: string | null;
  ferry_departure_time: string | null;
  ferry_arrival_time: string | null;
  port_departure: string | null;
  port_arrival: string | null;
  soft_preferences: string[];
  hard_constraints: string[];
};

export type AutoAssignPreviewProblemGroups = {
  missing_operational_time: AutoAssignPreviewServiceRow[];
  missing_pickup: AutoAssignPreviewServiceRow[];
  missing_destination: AutoAssignPreviewServiceRow[];
  missing_port: AutoAssignPreviewServiceRow[];
  missing_island_arrival: AutoAssignPreviewServiceRow[];
  ambiguous_navetta_pickup: AutoAssignPreviewServiceRow[];
  excursion_destination_missing: AutoAssignPreviewServiceRow[];
  duplicate_possible: AutoAssignPreviewServiceRow[];
  capacity_risk: AutoAssignPreviewServiceRow[];
  time_conflict: AutoAssignPreviewServiceRow[];
  locked_manual: AutoAssignPreviewServiceRow[];
};

export type AutoAssignPreviewStatus = {
  status: AutoAssignPreviewStatusValue;
  color: "green" | "yellow" | "red";
  message: string;
};

export type AutoAssignPreviewConflictSummary = {
  ok_count: number;
  warning_count: number;
  conflict_real_count: number;
  overlap_count: number;
  same_stop_count: number;
};

type MacroBucket = {
  count: number;
  assignable_count: number;
  needs_review_count: number;
};

export type AutoAssignPreviewResult = {
  ok: true;
  date: string;
  mode: AutoAssignPreviewMode;
  ui_mode: AutoAssignPreviewUiMode;
  preview_status: AutoAssignPreviewStatus;
  summary: {
    total_services: number;
    assignable_count: number;
    warning_count: number;
    needs_review_count: number;
    locked_count: number;
    already_assigned_count: number;
    conflict_count: number;
    merged_stops_count: number;
    same_stop_groups_count: number;
    single_stops_count: number;
    conflict_real_count: number;
    overlap_count: number;
    navette_count: number;
    arrivi_count: number;
    partenze_count: number;
    escursioni_count: number;
    da_verificare_count: number;
  };
  by_macro_category: {
    navette: MacroBucket;
    arrivi: MacroBucket;
    partenze: MacroBucket;
    escursioni: MacroBucket;
    da_verificare: Pick<MacroBucket, "count">;
  };
  problem_groups: AutoAssignPreviewProblemGroups;
  top_problems: AutoAssignPreviewServiceRow[];
  services: AutoAssignPreviewServiceRow[];
  needs_review: AutoAssignPreviewServiceRow[];
  assignable: AutoAssignPreviewServiceRow[];
  locked: AutoAssignPreviewServiceRow[];
  already_assigned_unlocked: AutoAssignPreviewServiceRow[];
  same_stop_groups: MergedStop[];
  single_assignable_stops: MergedStop[];
  merged_stops: MergedStop[];
  giro_analyses: GiroAnalysis[];
  conflict_summary: AutoAssignPreviewConflictSummary;
};

function normalizeDateDow(date: string) {
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getUTCDay();
}

export function getAutoAssignPreviewUiMode(date: string, totalServices: number): AutoAssignPreviewUiMode {
  const dayOfWeek = normalizeDateDow(date);
  if (dayOfWeek === 0 || totalServices > 250) return "sunday_massive";
  if (totalServices > 100) return "intense_day";
  return "normal";
}

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

function bucketKey(macro: AssignableMacroCategory) {
  if (macro === "NAVETTA") return "navette";
  if (macro === "ARRIVO") return "arrivi";
  if (macro === "PARTENZA") return "partenze";
  if (macro === "ESCURSIONE") return "escursioni";
  return "da_verificare";
}

function pushByReason(problemGroups: AutoAssignPreviewProblemGroups, row: AutoAssignPreviewServiceRow) {
  if (!row.needs_review) return;
  const text = row.review_reasons.join(" | ").toLowerCase();
  if (text.includes("orario operativo")) problemGroups.missing_operational_time.push(row);
  if (text.includes("pickup mancante") || text.includes("punto partenza")) problemGroups.missing_pickup.push(row);
  if (text.includes("destinazione mancante")) problemGroups.missing_destination.push(row);
  if (text.includes("porto imbarco")) problemGroups.missing_port.push(row);
  if (text.includes("arrivo isola") || text.includes("porto arrivo isola")) problemGroups.missing_island_arrival.push(row);
  if (text.includes("pickup navetta")) problemGroups.ambiguous_navetta_pickup.push(row);
  if (text.includes("destinazione escursione")) problemGroups.excursion_destination_missing.push(row);
}

function emptyMacroBucket(): MacroBucket {
  return { count: 0, assignable_count: 0, needs_review_count: 0 };
}

function emptyProblemGroups(): AutoAssignPreviewProblemGroups {
  return {
    missing_operational_time: [],
    missing_pickup: [],
    missing_destination: [],
    missing_port: [],
    missing_island_arrival: [],
    ambiguous_navetta_pickup: [],
    excursion_destination_missing: [],
    duplicate_possible: [],
    capacity_risk: [],
    time_conflict: [],
    locked_manual: [],
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

function buildConflictSummary(analyses: GiroAnalysis[]): AutoAssignPreviewConflictSummary {
  return analyses.reduce(
    (summary, analysis) => ({
      ok_count: summary.ok_count + analysis.ok_count,
      warning_count: summary.warning_count + analysis.warning_count,
      conflict_real_count: summary.conflict_real_count + analysis.conflict_count,
      overlap_count: summary.overlap_count + analysis.overlap_count,
      same_stop_count: summary.same_stop_count + analysis.same_stop_count,
    }),
    {
      ok_count: 0,
      warning_count: 0,
      conflict_real_count: 0,
      overlap_count: 0,
      same_stop_count: 0,
    }
  );
}

function buildPreviewStatus(input: {
  needsReviewCount: number;
  conflictSummary: AutoAssignPreviewConflictSummary;
}): AutoAssignPreviewStatus {
  if (input.conflictSummary.conflict_real_count > 0 || input.conflictSummary.overlap_count > 0) {
    return {
      status: "NOT_READY",
      color: "red",
      message: "Preview non operativa: ci sono conflitti reali o sovrapposizioni da risolvere.",
    };
  }

  if (input.needsReviewCount > 0) {
    return {
      status: "PARTIAL",
      color: "yellow",
      message: "Preview parziale: alcuni servizi devono essere verificati prima dell'assegnazione.",
    };
  }

  if (input.conflictSummary.warning_count > 0) {
    return {
      status: "READY_WITH_WARNINGS",
      color: "yellow",
      message: "Preview pronta con warning: controllare i margini temporali stretti.",
    };
  }

  return {
    status: "READY",
    color: "green",
    message: "Preview pronta: servizi risolti e transizioni senza conflitti.",
  };
}

export function buildAutoAssignPreview(args: {
  date: string;
  mode?: AutoAssignPreviewMode;
  services: AutoAssignPreviewService[];
  hotels: AutoAssignPreviewHotel[];
  assignments: AutoAssignPreviewAssignment[];
  tripGroups?: AutoAssignPreviewTripGroup[];
}): AutoAssignPreviewResult {
  const mode = args.mode ?? "all";
  const hotelMap = new Map(args.hotels.map((hotel) => [hotel.id, hotel]));
  const activeGroupIds = new Set((args.tripGroups ?? []).map((group) => group.id));
  const assignmentByServiceId = new Map(args.assignments.map((assignment) => [assignment.service_id, assignment]));
  const services = [...args.services].sort((a, b) =>
    String(a.time ?? "").localeCompare(String(b.time ?? "")) ||
    String(a.customer_name ?? "").localeCompare(String(b.customer_name ?? ""))
  );

  const rows = services.map((service) => {
    const assignment = assignmentByServiceId.get(service.id);
    const groupIsActive = assignment?.group_id ? activeGroupIds.has(assignment.group_id) : false;
    const isLocked = assignment?.locked_by_operator === true;
    const alreadyAssigned = Boolean(assignment?.group_id && groupIsActive);
    const resolution = resolveAssignableService(service, {
      hotel: service.hotel_id ? hotelMap.get(service.hotel_id) ?? null : null,
    });
    const baseAssignable = resolution.assignable && !isLocked && !alreadyAssigned && confidenceScore(resolution) >= 80;
    return {
      service_id: service.id,
      customer_name: service.customer_name ?? null,
      macro_category: resolution.macro_category,
      assignable: baseAssignable,
      needs_review: resolution.needs_review,
      review_reasons: resolution.review_reasons,
      is_locked: isLocked,
      already_assigned: alreadyAssigned,
      already_assigned_unlocked: alreadyAssigned && !isLocked,
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
    } satisfies AutoAssignPreviewServiceRow;
  });

  const visibleRows = mode === "unassigned_only"
    ? rows.filter((row) => !row.already_assigned && !row.is_locked)
    : rows;
  const problemGroups = emptyProblemGroups();
  const byMacro = {
    navette: emptyMacroBucket(),
    arrivi: emptyMacroBucket(),
    partenze: emptyMacroBucket(),
    escursioni: emptyMacroBucket(),
    da_verificare: { count: 0 },
  };

  for (const row of rows) {
    const key = bucketKey(row.macro_category);
    if (key === "da_verificare") {
      byMacro.da_verificare.count += 1;
    } else {
      byMacro[key].count += 1;
      if (row.assignable) byMacro[key].assignable_count += 1;
      if (row.needs_review) byMacro[key].needs_review_count += 1;
    }
    pushByReason(problemGroups, row);
    if (row.is_locked) problemGroups.locked_manual.push(row);
  }

  const needsReview = visibleRows.filter((row) => row.needs_review);
  const assignable = visibleRows.filter((row) => row.assignable);
  const locked = rows.filter((row) => row.is_locked);
  const alreadyAssignedUnlocked = rows.filter((row) => row.already_assigned_unlocked);
  const warningCount = rows.filter((row) => row.soft_preferences.length > 0 && !row.needs_review).length;
  const topProblems = needsReview
    .sort((a, b) => a.confidence_score - b.confidence_score || String(a.operational_time ?? "").localeCompare(String(b.operational_time ?? "")))
    .slice(0, 25);
  const sameStopCandidates = assignable
    .filter((row) => row.assignable && !row.needs_review)
    .map(rowToSameStopService);
  const mergedStops = mergeSameStops(sameStopCandidates);
  const sameStopGroups = mergedStops.filter((stop) => stop.is_merged);
  const singleAssignableStops = mergedStops.filter((stop) => !stop.is_merged);
  const giroAnalyses = mergedStops.length > 0
    ? [analyzeGiro("preview-readonly", null, mergedStops)]
    : [];
  const conflictSummary = buildConflictSummary(giroAnalyses);
  const previewStatus = buildPreviewStatus({
    needsReviewCount: needsReview.length,
    conflictSummary,
  });
  const transitionWarningCount = conflictSummary.warning_count;
  const totalWarningCount = warningCount + transitionWarningCount;
  const conflictCount = conflictSummary.conflict_real_count + conflictSummary.overlap_count;

  return {
    ok: true,
    date: args.date,
    mode,
    ui_mode: getAutoAssignPreviewUiMode(args.date, rows.length),
    preview_status: previewStatus,
    summary: {
      total_services: rows.length,
      assignable_count: assignable.length,
      warning_count: totalWarningCount,
      needs_review_count: needsReview.length,
      locked_count: locked.length,
      already_assigned_count: rows.filter((row) => row.already_assigned).length,
      conflict_count: conflictCount,
      merged_stops_count: mergedStops.length,
      same_stop_groups_count: sameStopGroups.length,
      single_stops_count: singleAssignableStops.length,
      conflict_real_count: conflictSummary.conflict_real_count,
      overlap_count: conflictSummary.overlap_count,
      navette_count: byMacro.navette.count,
      arrivi_count: byMacro.arrivi.count,
      partenze_count: byMacro.partenze.count,
      escursioni_count: byMacro.escursioni.count,
      da_verificare_count: byMacro.da_verificare.count,
    },
    by_macro_category: byMacro,
    problem_groups: problemGroups,
    top_problems: topProblems,
    services: rows,
    needs_review: needsReview,
    assignable,
    locked,
    already_assigned_unlocked: alreadyAssignedUnlocked,
    same_stop_groups: sameStopGroups,
    single_assignable_stops: singleAssignableStops,
    merged_stops: mergedStops,
    giro_analyses: giroAnalyses,
    conflict_summary: conflictSummary,
  };
}
