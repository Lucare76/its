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
