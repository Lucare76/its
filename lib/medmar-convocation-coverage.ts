// Pure coverage-status resolution for MEDMAR "Genera dal gestionale" rows —
// SPRINT MEDMAR STEP 2. Decides, per departure-day row, whether it is a
// brand new convocation, already sent, sent-then-changed, or not sendable
// yet, by comparing against the most recent successful send for the same
// service_id (or, only when unambiguous, a phone+date+vessel-time fallback
// for pre-service_id Excel history — see resolveCoverageForRow below).
//
// No DB access here — lib/server/medmar-convocation-coverage-source.ts does
// the batched Supabase queries and hands this module plain data.

export type CoverageStatus = "new" | "sent" | "changed" | "invalid";

// The subset of a convocation's data that must match for it to count as
// "still the same convocation" — i.e. no resend needed.
export type ComparableConvocationData = {
  phone_e164: string | null;
  customer_name: string;
  travel_date_iso: string | null;
  hotel: string;
  passengers: string;
  pickup_time: string;
  vessel_time: string;
};

export type MedmarSentSnapshot = ComparableConvocationData & {
  source_row_id: string;
  sent_at: string | null;
};

export type ChangedField = { field: string; label: string; from: string; to: string };

export type CoverageResult = {
  coverage_status: CoverageStatus;
  previous_send?: MedmarSentSnapshot;
  changed_fields?: ChangedField[];
};

const FIELD_LABELS: Record<keyof ComparableConvocationData, string> = {
  phone_e164: "Telefono",
  customer_name: "Cliente",
  travel_date_iso: "Data partenza",
  hotel: "Hotel",
  passengers: "Pax",
  pickup_time: "Pickup",
  vessel_time: "Nave",
};

function norm(v: string | null): string {
  return (v ?? "").trim().toLowerCase();
}

// Compares the fields listed in section 8/9 of the spec. Order matches
// FIELD_LABELS so diffs render in a stable, predictable order.
export function diffConvocationData(previous: ComparableConvocationData, current: ComparableConvocationData): ChangedField[] {
  const fields = Object.keys(FIELD_LABELS) as (keyof ComparableConvocationData)[];
  const diffs: ChangedField[] = [];
  for (const field of fields) {
    if (norm(previous[field]) !== norm(current[field])) {
      diffs.push({ field, label: FIELD_LABELS[field], from: previous[field] ?? "", to: current[field] ?? "" });
    }
  }
  return diffs;
}

// Only used for the "prudent Excel-history fallback" (spec §17): rows with
// no service_id can't be matched by identity, so — and only when the key is
// unambiguous (exactly one candidate) — phone+date+vessel-time stands in.
export function buildFallbackKey(phoneE164: string | null, travelDateIso: string | null, vesselTime: string): string | null {
  const phone = (phoneE164 ?? "").trim();
  const date = (travelDateIso ?? "").trim();
  const vessel = vesselTime.trim().toLowerCase();
  if (!phone || !date || !vessel) return null;
  return `${phone}||${date}||${vessel}`;
}

export type CoverageInputRow = ComparableConvocationData & {
  /** row-level validation status from buildGeneratedConvocationRows; only "pronto" rows can be new/sent/changed. */
  status: string;
  service_id: string;
};

// Core decision per row. Never marks a row "sent"/"changed" on a doubtful
// match — an ambiguous fallback key (0 or 2+ candidates) is treated as "new"
// rather than risking a false "already sent".
export function resolveCoverageForRow(
  row: CoverageInputRow,
  sentByServiceId: Map<string, MedmarSentSnapshot>,
  fallbackSentByKey: Map<string, MedmarSentSnapshot[]>,
): CoverageResult {
  if (row.status !== "pronto") {
    return { coverage_status: "invalid" };
  }

  let previous = sentByServiceId.get(row.service_id);

  if (!previous) {
    const key = buildFallbackKey(row.phone_e164, row.travel_date_iso, row.vessel_time);
    const candidates = key ? fallbackSentByKey.get(key) : undefined;
    if (candidates && candidates.length === 1) {
      previous = candidates[0];
    }
  }

  if (!previous) {
    return { coverage_status: "new" };
  }

  const changedFields = diffConvocationData(previous, row);
  if (changedFields.length === 0) {
    return { coverage_status: "sent", previous_send: previous };
  }
  return { coverage_status: "changed", previous_send: previous, changed_fields: changedFields };
}

export type CoverageSummary = {
  found: number;
  new: number;
  sent: number;
  changed: number;
  invalid: number;
};

export function buildCoverageSummary(statuses: CoverageStatus[]): CoverageSummary {
  const summary: CoverageSummary = { found: statuses.length, new: 0, sent: 0, changed: 0, invalid: 0 };
  for (const s of statuses) summary[s]++;
  return summary;
}
