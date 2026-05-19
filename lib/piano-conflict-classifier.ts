import type { MergedStop } from "@/lib/piano-same-stop-merge";

export type ConflictType = "OK" | "SAME_STOP" | "WARNING" | "CONFLICT_REAL" | "OVERLAP";
export type MacroArea = "NORD_OVEST" | "SUD_OVEST" | "EST_SUD";

export interface TransitionResult {
  type: ConflictType;
  minutes_available: number;
  minutes_required: number;
  margin: number;
  from_macro_area: string | null;
  to_macro_area: string | null;
  from_stop_label: string;
  to_stop_label: string;
  reason: string;
  pax_buffer: number;
  geo_buffer: number;
  warnings: string[];
}

export interface GiroAnalysis {
  giro_id: string;
  driver: string | null;
  stops: MergedStop[];
  transitions: TransitionResult[];
  has_conflicts: boolean;
  conflict_count: number;
  warning_count: number;
  ok_count: number;
  same_stop_count: number;
  overlap_count: number;
  worst_conflict: TransitionResult | null;
}

export type ConflictClassifierOptions = {
  samePointBufferMinutes?: number;
  sameZoneBufferMinutes?: number;
  sameMacroAreaBufferMinutes?: number;
  crossMacroAreaBufferMinutes?: number;
  unknownZoneBufferMinutes?: number;
  samePoint?: boolean;
};

type StopWithExplicitEnd = MergedStop & {
  end_time?: string | null;
  arrival_time?: string | null;
};

type StopEndTime = {
  time: string;
  minutes: number;
  warnings: string[];
};

function clean(value?: string | number | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalize(value?: string | null) {
  return clean(value)
    ?.toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim() ?? "";
}

function minutes(value?: string | null) {
  const match = clean(value)?.match(/([01]?\d|2[0-3]):([0-5]\d)/);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatMinutes(value: number) {
  const normalized = ((value % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function samePlace(left?: string | null, right?: string | null) {
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && a === b);
}

function stopStartMinutes(stop: MergedStop) {
  return minutes(stop.operational_time);
}

function stopDestinationZone(stop: MergedStop) {
  return stop.services
    .map((service) => service.destination_zone ?? service.destination_label)
    .map(clean)
    .find(Boolean) ?? stop.destination_labels.map(clean).find(Boolean) ?? null;
}

function stopPickupZone(stop: MergedStop) {
  return stop.services
    .map((service) => service.pickup_zone ?? service.pickup_label)
    .map(clean)
    .find(Boolean) ?? stop.pickup_label ?? null;
}

function stopLabel(stop: MergedStop) {
  const destination = stop.destination_labels.length > 0 ? stop.destination_labels.join(" / ") : "destinazione da verificare";
  return `${stop.operational_time} ${stop.macro_category} ${stop.pickup_label ?? "pickup da verificare"} -> ${destination}`;
}

export function getMacroArea(zone?: string | null): MacroArea | null {
  const text = normalize(zone);
  if (!text) return null;
  if (/(casamicciola|lacco ameno|lacco|forio|citara|panza|cuotto)/.test(text)) return "NORD_OVEST";
  if (/(sant angelo|santangelo|serrara|fontana)/.test(text)) return "SUD_OVEST";
  if (/(ischia porto|ischia|barano|testaccio|fiaiano|cartaromana)/.test(text)) return "EST_SUD";
  return null;
}

export function getPaxBuffer(pax?: number | null) {
  const value = pax ?? 0;
  if (value >= 31) return 20;
  if (value >= 21) return 15;
  if (value >= 11) return 10;
  if (value >= 6) return 5;
  return 0;
}

export function getGeoBuffer(
  fromZone?: string | null,
  toZone?: string | null,
  options?: ConflictClassifierOptions
): { minutes: number; from_macro_area: MacroArea | null; to_macro_area: MacroArea | null; warnings: string[] } {
  const samePointBuffer = options?.samePointBufferMinutes ?? 5;
  const sameZoneBuffer = options?.sameZoneBufferMinutes ?? 10;
  const sameMacroBuffer = options?.sameMacroAreaBufferMinutes ?? 15;
  const crossMacroBuffer = options?.crossMacroAreaBufferMinutes ?? 30;
  const unknownBuffer = options?.unknownZoneBufferMinutes ?? 40;
  const warnings: string[] = [];
  const fromArea = getMacroArea(fromZone);
  const toArea = getMacroArea(toZone);

  if (options?.samePoint) {
    return { minutes: samePointBuffer, from_macro_area: fromArea, to_macro_area: toArea, warnings };
  }

  if (!fromArea || !toArea) {
    warnings.push("Zona non determinata: buffer prudente");
    return { minutes: unknownBuffer, from_macro_area: fromArea, to_macro_area: toArea, warnings };
  }

  if (samePlace(fromZone, toZone)) {
    return { minutes: sameZoneBuffer, from_macro_area: fromArea, to_macro_area: toArea, warnings };
  }

  if (fromArea === toArea) {
    return { minutes: sameMacroBuffer, from_macro_area: fromArea, to_macro_area: toArea, warnings };
  }

  return { minutes: crossMacroBuffer, from_macro_area: fromArea, to_macro_area: toArea, warnings };
}

export function getStopEndTime(stop: MergedStop): StopEndTime {
  const start = stopStartMinutes(stop);
  const explicitEnd = clean((stop as StopWithExplicitEnd).end_time ?? (stop as StopWithExplicitEnd).arrival_time);
  if (explicitEnd) {
    return { time: explicitEnd, minutes: minutes(explicitEnd), warnings: [] };
  }

  const warnings: string[] = [];
  let duration = 10;

  if (stop.macro_category === "NAVETTA") {
    duration = 15;
  } else if (stop.macro_category === "ESCURSIONE") {
    duration = 30;
    warnings.push("Durata escursione non determinata");
  }

  if (stop.macro_category === "ARRIVO" || stop.macro_category === "PARTENZA" || stop.macro_category === "ESCURSIONE") {
    duration += getPaxBuffer(stop.total_pax);
  }

  const end = start + duration;
  return { time: formatMinutes(end), minutes: end, warnings };
}

export function getStopMacroArea(stop: MergedStop) {
  const zone = stopDestinationZone(stop) ?? stopPickupZone(stop);
  return getMacroArea(zone);
}

function classifyTransition(from: MergedStop, to: MergedStop, options?: ConflictClassifierOptions): TransitionResult {
  const fromEnd = getStopEndTime(from);
  const toStart = stopStartMinutes(to);
  const fromZone = stopDestinationZone(from);
  const toZone = stopPickupZone(to);
  const samePoint = from.destination_labels.some((destination) => samePlace(destination, to.pickup_label));
  const geo = getGeoBuffer(fromZone, toZone, { ...options, samePoint: options?.samePoint ?? samePoint });
  const paxBuffer = getPaxBuffer(from.total_pax);
  const minutesAvailable = toStart - fromEnd.minutes;
  const minutesRequired = geo.minutes + paxBuffer;
  const margin = minutesAvailable - minutesRequired;
  const warnings = [...fromEnd.warnings, ...geo.warnings];
  let type: ConflictType;
  let reason: string;

  if (from.is_merged && from.services.length > 1 && from === to) {
    type = "SAME_STOP";
    reason = "Servizi gia accorpati nello stesso stop operativo";
  } else if (toStart < fromEnd.minutes) {
    type = "OVERLAP";
    reason = `Sovrapposizione: lo stop successivo inizia prima della fine stimata (${fromEnd.time})`;
  } else if (margin < 0) {
    type = "CONFLICT_REAL";
    reason = `Tempo insufficiente: ${minutesAvailable} minuti disponibili, ${minutesRequired} richiesti`;
  } else if (margin < 5) {
    type = "WARNING";
    reason = `Margine stretto: ${margin} minuti`;
  } else {
    type = "OK";
    reason = `Margine sufficiente: ${margin} minuti`;
  }

  return {
    type,
    minutes_available: minutesAvailable,
    minutes_required: minutesRequired,
    margin,
    from_macro_area: geo.from_macro_area,
    to_macro_area: geo.to_macro_area,
    from_stop_label: stopLabel(from),
    to_stop_label: stopLabel(to),
    reason,
    pax_buffer: paxBuffer,
    geo_buffer: geo.minutes,
    warnings,
  };
}

function sameStopTransition(stop: MergedStop): TransitionResult {
  return {
    type: "SAME_STOP",
    minutes_available: 0,
    minutes_required: 0,
    margin: 0,
    from_macro_area: getStopMacroArea(stop),
    to_macro_area: getStopMacroArea(stop),
    from_stop_label: stopLabel(stop),
    to_stop_label: stopLabel(stop),
    reason: "Servizi gia accorpati nello stesso stop operativo",
    pax_buffer: 0,
    geo_buffer: 0,
    warnings: [],
  };
}

export function classifyGiroTransitions(stops: MergedStop[], options?: ConflictClassifierOptions): TransitionResult[] {
  const ordered = [...stops].sort((a, b) => a.operational_time.localeCompare(b.operational_time));
  const transitions: TransitionResult[] = [];

  for (const stop of ordered) {
    if (stop.is_merged && stop.services.length > 1) {
      transitions.push(sameStopTransition(stop));
    }
  }

  for (let index = 1; index < ordered.length; index += 1) {
    transitions.push(classifyTransition(ordered[index - 1]!, ordered[index]!, options));
  }

  return transitions;
}

export function analyzeGiro(
  giro_id: string,
  driver: string | null,
  stops: MergedStop[],
  options?: ConflictClassifierOptions
): GiroAnalysis {
  const transitions = classifyGiroTransitions(stops, options);
  const conflictTransitions = transitions.filter((transition) => transition.type === "CONFLICT_REAL");
  const overlapTransitions = transitions.filter((transition) => transition.type === "OVERLAP");
  const worstConflict = [...conflictTransitions, ...overlapTransitions]
    .sort((left, right) => left.margin - right.margin)[0] ?? null;

  return {
    giro_id,
    driver,
    stops,
    transitions,
    has_conflicts: conflictTransitions.length > 0 || overlapTransitions.length > 0,
    conflict_count: conflictTransitions.length,
    warning_count: transitions.filter((transition) => transition.type === "WARNING").length,
    ok_count: transitions.filter((transition) => transition.type === "OK").length,
    same_stop_count: transitions.filter((transition) => transition.type === "SAME_STOP").length,
    overlap_count: overlapTransitions.length,
    worst_conflict: worstConflict,
  };
}
