export type OperationalUnitType =
  | "giro_singolo"
  | "same_stop"
  | "multi_drop_confirmed"
  | "accorpamento_confirmed"
  | "shuttle_pair"
  | "cluster_escursione_roundtrip"
  | "navetta_speciale";

export type OperationalStopLike = {
  operational_time?: string | null;
  customer_name?: string | null;
  pickup_label?: string | null;
  destination_label?: string | null;
  pickup_zone?: string | null;
  destination_zone?: string | null;
  booking_service_kind?: string | null;
  service_type_code?: string | null;
  route_kind?: string | null;
  origin_place_id?: string | null;
  destination_place_id?: string | null;
};

export type OperationalDurationResult = {
  duration_minutes: number;
  buffer_minutes: number;
  reason: string;
  source: "route_duration_config" | "service_kind_config" | "unit_type_default";
  warnings: string[];
};

export type OperationalRouteDurationRule = {
  booking_service_kind?: string | null;
  service_type_code?: string | null;
  route_kind?: string | null;
  origin_place_id?: string | null;
  destination_place_id?: string | null;
  origin_label?: string | null;
  destination_label?: string | null;
  duration_minutes: number;
  buffer_minutes: number;
  reason: string;
};

export type OperationalDurationConfig = {
  routeDurations?: OperationalRouteDurationRule[];
  defaultTransferDurationMinutes?: number;
  defaultTransferBufferMinutes?: number;
  defaultShuttleDurationMinutes?: number;
  defaultShuttleBufferMinutes?: number;
  defaultMicroDurationMinutes?: number;
  defaultMicroBufferMinutes?: number;
  microPaxThreshold?: number;
};

const DEFAULT_CONFIG: Required<Omit<OperationalDurationConfig, "routeDurations">> = {
  defaultTransferDurationMinutes: 30,
  defaultTransferBufferMinutes: 5,
  defaultShuttleDurationMinutes: 5,
  defaultShuttleBufferMinutes: 0,
  defaultMicroDurationMinutes: 20,
  defaultMicroBufferMinutes: 0,
  microPaxThreshold: 2,
};

function normalize(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function minutes(value: unknown) {
  const match = String(value ?? "").match(/(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function spanMinutes(stops: OperationalStopLike[]) {
  const times = stops.map((stop) => minutes(stop.operational_time)).filter((value): value is number => value != null);
  if (times.length <= 1) return null;
  return Math.max(...times) - Math.min(...times);
}

function clean(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function sameOptionalRuleValue(ruleValue: string | null | undefined, actual: string | null | undefined) {
  if (ruleValue == null || ruleValue === "") return true;
  return normalize(ruleValue) === normalize(actual);
}

function routeRuleHasConstraint(rule: OperationalRouteDurationRule) {
  return Boolean(
    clean(rule.booking_service_kind)
      || clean(rule.service_type_code)
      || clean(rule.route_kind)
      || clean(rule.origin_place_id)
      || clean(rule.destination_place_id)
      || clean(rule.origin_label)
      || clean(rule.destination_label)
  );
}

function routeRuleMatches(rule: OperationalRouteDurationRule, stops: OperationalStopLike[]) {
  return routeRuleHasConstraint(rule) && stops.some((stop) =>
    sameOptionalRuleValue(rule.booking_service_kind, stop.booking_service_kind)
    && sameOptionalRuleValue(rule.service_type_code, stop.service_type_code)
    && sameOptionalRuleValue(rule.route_kind, stop.route_kind)
    && sameOptionalRuleValue(rule.origin_place_id, stop.origin_place_id)
    && sameOptionalRuleValue(rule.destination_place_id, stop.destination_place_id)
    && sameOptionalRuleValue(rule.origin_label, clean(stop.pickup_label))
    && sameOptionalRuleValue(rule.destination_label, clean(stop.destination_label))
  );
}

export function isOperationalShuttleLike(stops: OperationalStopLike[]) {
  return stops.some((stop) => {
    const kind = normalize(stop.booking_service_kind);
    const routeKind = normalize(stop.route_kind);
    const serviceType = normalize(stop.service_type_code);
    return kind === "NAVETTA"
      || kind === "SHUTTLE_HOTEL"
      || routeKind === "SHUTTLE"
      || routeKind === "NAVETTA"
      || routeKind === "CYCLE"
      || serviceType === "SHUTTLE"
      || serviceType === "NAVETTA";
  });
}

export function calculateOperationalDuration(args: {
  type: OperationalUnitType;
  stops: OperationalStopLike[];
  defaultDurationMinutes?: number;
  defaultBufferMinutes?: number;
  config?: OperationalDurationConfig;
  pax?: number;
}): OperationalDurationResult {
  const config = { ...DEFAULT_CONFIG, ...args.config };
  const defaultDuration = args.defaultDurationMinutes ?? config.defaultTransferDurationMinutes;
  const defaultBuffer = args.defaultBufferMinutes ?? config.defaultTransferBufferMinutes;
  const span = spanMinutes(args.stops);
  const routeRule = args.config?.routeDurations?.find((rule) => routeRuleMatches(rule, args.stops)) ?? null;

  if (routeRule) {
    return {
      duration_minutes: Math.max(routeRule.duration_minutes, span ?? 0),
      buffer_minutes: routeRule.buffer_minutes,
      reason: routeRule.reason,
      source: "route_duration_config",
      warnings: [],
    };
  }

  if (args.type === "cluster_escursione_roundtrip") {
    return {
      duration_minutes: defaultDuration,
      buffer_minutes: defaultBuffer,
      reason: "cluster escursione roundtrip mantenuto come blocco unico",
      source: "unit_type_default",
      warnings: [],
    };
  }

  if (args.type === "same_stop" || args.type === "multi_drop_confirmed" || args.type === "accorpamento_confirmed") {
    return {
      duration_minutes: Math.max(10, span ?? 20),
      buffer_minutes: Math.min(defaultBuffer, 3),
      reason: "blocco confermato/same-stop, durata sullo span operativo",
      source: "unit_type_default",
      warnings: [],
    };
  }

  if (args.type === "shuttle_pair" || args.type === "navetta_speciale") {
    const warnings = isOperationalShuttleLike(args.stops)
      ? ["Durata navetta da default service-kind: configurare route-duration per precisione per-tenant."]
      : ["Unita navetta senza attributo servizio navetta/ciclo e senza route-duration config."];
    return {
      duration_minutes: Math.max(config.defaultShuttleDurationMinutes, span ?? 0),
      buffer_minutes: config.defaultShuttleBufferMinutes,
      reason: "navetta/ciclo da attributo operativo o unit type con default configurabile",
      source: "service_kind_config",
      warnings,
    };
  }

  if ((args.pax ?? 0) > 0 && (args.pax ?? 0) <= config.microPaxThreshold) {
    return {
      duration_minutes: config.defaultMicroDurationMinutes,
      buffer_minutes: config.defaultMicroBufferMinutes,
      reason: "micro-giro pax basso con durata default configurabile",
      source: "unit_type_default",
      warnings: ["Durata micro-giro da default: configurare route-duration se la tratta richiede durata specifica."],
    };
  }

  return {
    duration_minutes: defaultDuration,
    buffer_minutes: defaultBuffer,
    reason: "transfer normale con durata standard",
    source: "unit_type_default",
    warnings: [],
  };
}
