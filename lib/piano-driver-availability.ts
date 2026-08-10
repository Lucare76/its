export type DriverAvailabilityInterval = {
  start_time: string | null;
  end_time?: string | null;
};

export type DriverAvailabilityWindow = {
  available?: boolean | null;
  available_from?: string | null;
  available_to?: string | null;
  blocks?: Array<{ from?: string | null; to?: string | null; reason?: string | null }>;
};

export type DriverAvailabilityPolicy = {
  missingAvailability?: "allow" | "warning" | "blocker";
  missingBounds?: "allow" | "warning" | "blocker";
  defaultDurationMinutes?: number;
  /**
   * Default false: available_to gates only the interval start (shift end = last
   * assignable start time). Set true only when the caller genuinely needs the
   * driver to remain available through the end of the interval.
   */
  requireFullIntervalCoverage?: boolean;
};

export type DriverAvailabilityResult = {
  allowed: boolean;
  severity: "ok" | "warning" | "blocker";
  reason: string | null;
};

function minutes(value?: string | null) {
  const match = String(value ?? "").match(/(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function policyResult(kind: "allow" | "warning" | "blocker", reason: string): DriverAvailabilityResult {
  if (kind === "blocker") return { allowed: false, severity: "blocker", reason };
  if (kind === "warning") return { allowed: true, severity: "warning", reason };
  return { allowed: true, severity: "ok", reason: null };
}

export function canDriverCoverInterval(
  availability: DriverAvailabilityWindow | null | undefined,
  interval: DriverAvailabilityInterval,
  policy: DriverAvailabilityPolicy = {}
): DriverAvailabilityResult {
  const missingAvailability = policy.missingAvailability ?? "warning";
  const missingBounds = policy.missingBounds ?? "warning";
  const duration = policy.defaultDurationMinutes ?? 30;
  const start = minutes(interval.start_time);
  if (start == null) {
    return { allowed: false, severity: "blocker", reason: "Orario giro mancante." };
  }
  const end = Math.max(minutes(interval.end_time) ?? start + duration, start + duration);

  if (!availability) {
    return policyResult(missingAvailability, "Disponibilita autista non dichiarata.");
  }
  if (availability.available === false) {
    return { allowed: false, severity: "blocker", reason: "Autista non disponibile in questa data." };
  }

  const from = minutes(availability.available_from);
  const to = minutes(availability.available_to);
  if (from == null || to == null) {
    const result = policyResult(missingBounds, "Fascia oraria disponibilita autista incompleta.");
    if (!result.allowed || result.severity === "warning") return result;
  }

  if (from != null && start < from) {
    return { allowed: false, severity: "blocker", reason: "Autista non disponibile in questa fascia oraria." };
  }
  if (to != null) {
    const exceedsShiftEnd = policy.requireFullIntervalCoverage ? end > to : start > to;
    if (exceedsShiftEnd) {
      return { allowed: false, severity: "blocker", reason: "Autista non disponibile in questa fascia oraria." };
    }
  }

  for (const block of availability.blocks ?? []) {
    const blockStart = minutes(block.from);
    const blockEnd = minutes(block.to);
    if (blockStart == null || blockEnd == null) continue;
    if (start < blockEnd && end > blockStart) {
      return {
        allowed: false,
        severity: "blocker",
        reason: block.reason ?? "Autista non disponibile in questa fascia oraria.",
      };
    }
  }

  return { allowed: true, severity: "ok", reason: null };
}
