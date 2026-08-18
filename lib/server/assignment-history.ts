import type { SupabaseClient } from "@supabase/supabase-js";

export type AssignmentChangeType =
  | "auto_assign_accepted"
  | "driver_swap"
  | "vehicle_binding"
  | "resolution_suggestion";

export type AssignmentHistoryEntry = {
  tenantId: string;
  serviceDate: string;
  serviceId?: string | null;
  groupId?: string | null;
  changeType: AssignmentChangeType;
  fromDriverProfileId?: string | null;
  toDriverProfileId?: string | null;
  fromVehicleLabel?: string | null;
  toVehicleLabel?: string | null;
  features?: Record<string, unknown>;
  operatorId: string;
};

type FeatureInput = {
  serviceDate: string;
  changeType: AssignmentChangeType;
  fromDriverProfileId?: string | null;
  toDriverProfileId?: string | null;
  fromVehicleLabel?: string | null;
  toVehicleLabel?: string | null;
  direction?: string | null;
  zone?: string | null;
  time?: string | null;
  vessel?: string | null;
  pax?: number | null;
  isNavetta?: boolean;
};

// Features v2 (ML Data Collection Sprint 2) — snapshot proposta→decisione,
// riusa driver_assignment_history.features (jsonb, nessuna migration). Ogni
// campo è opzionale: chi non li passa continua a produrre esattamente il
// payload v1 di extractFeatures(), letto invariato da learned-patterns.ts
// (pattern_key resta nella stessa posizione/formato).
export type CandidateSnapshot = {
  driver_profile_id: string;
  score: number;
  rank: number;
  hard_ok: true;
};

export type AssignmentDecisionFeatures = {
  proposal_id?: string | null;
  source?: string | null;
  was_override?: boolean | null;
  chosen_rank?: number | null;
  candidate_count?: number | null;
  candidates?: CandidateSnapshot[] | null;
  is_sunday?: boolean | null;
  weekday?: number | null;
  learned_score_adjustment?: number | null;
};

const DECISION_FEATURE_KEYS = [
  "proposal_id",
  "source",
  "was_override",
  "chosen_rank",
  "candidate_count",
  "candidates",
  "is_sunday",
  "weekday",
  "learned_score_adjustment",
] as const;

// Unisce il payload v1 (extractFeatures) con il contesto decisionale v2,
// omettendo le chiavi v2 non fornite (undefined) invece di scriverle come
// null esplicito — non aggiunge rumore ai payload dei chiamanti che non
// hanno ancora dati di proposta/candidati.
export function buildAssignmentDecisionFeatures(
  baseFeatures: Record<string, unknown>,
  decision: AssignmentDecisionFeatures = {}
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...baseFeatures };
  for (const key of DECISION_FEATURE_KEYS) {
    const value = decision[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

function timeSlot(time: string): string {
  const hour = parseInt((time ?? "").split(":")[0] ?? "0", 10);
  if (hour >= 6 && hour < 12) return "mattina";
  if (hour >= 12 && hour < 16) return "pomeriggio";
  if (hour >= 16 && hour < 20) return "sera";
  return "notte";
}

function macroCategory(direction?: string | null, isNavetta?: boolean): string {
  if (!direction) return "sconosciuto";
  if (isNavetta) return direction === "arrival" ? "navetta_arrivo" : "navetta_partenza";
  return direction === "arrival" ? "arrivo" : "partenza";
}

export function extractFeatures(input: FeatureInput): Record<string, unknown> {
  const date = new Date(input.serviceDate);
  const category = macroCategory(input.direction, input.isNavetta);
  const slot = input.time ? timeSlot(input.time) : null;
  const patternKey = `${category}:${input.zone ?? "*"}:${slot ?? "*"}:${input.vessel ?? "*"}`;

  return {
    change_type: input.changeType,
    day_of_week: date.getUTCDay(),
    macro_category: category,
    destination_zone: input.zone ?? null,
    time_slot: slot,
    ferry_company: input.vessel ?? null,
    pax: input.pax ?? null,
    is_navetta: input.isNavetta ?? false,
    driver_changed: (input.fromDriverProfileId ?? null) !== (input.toDriverProfileId ?? null),
    vehicle_changed: (input.fromVehicleLabel ?? null) !== (input.toVehicleLabel ?? null),
    pattern_key: patternKey,
  };
}

export async function logAssignmentChange(
  admin: SupabaseClient,
  entries: AssignmentHistoryEntry[]
): Promise<void> {
  if (entries.length === 0) return;

  const rows = entries.map((entry) => ({
    tenant_id: entry.tenantId,
    service_date: entry.serviceDate,
    service_id: entry.serviceId ?? null,
    group_id: entry.groupId ?? null,
    change_type: entry.changeType,
    from_driver_profile_id: entry.fromDriverProfileId ?? null,
    to_driver_profile_id: entry.toDriverProfileId ?? null,
    from_vehicle_label: entry.fromVehicleLabel ?? null,
    to_vehicle_label: entry.toVehicleLabel ?? null,
    features: entry.features ?? {},
    operator_id: entry.operatorId,
  }));

  await admin.from("driver_assignment_history").insert(rows);
}
