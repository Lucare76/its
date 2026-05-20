import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canDriverCoverInterval } from "@/lib/piano-driver-availability";
import { canDriverUseVehicle } from "@/lib/piano-driver-vehicle-eligibility";
import { listDriverRegistry, normalizeDriverName, type DriverRegistryEntry } from "@/lib/server/driver-registry";

export const GPR_PETER_DRIVER_SWAP_ACTION = "APPLY_DRIVER_SWAP";
export const GPR_PETER_DRIVER_SWAP_DECISION_TYPE = "driver_swap_confirmed";
export const GPR_PETER_GROUP_ID = "71443ef7-f506-464d-b11d-f9eae8c2858a";
export const GPR_PETER_EXPECTED_DATE = "2026-05-07";
export const GPR_PETER_EXPECTED_START = "15:00";
export const GPR_PETER_EXPECTED_PAX = 21;
export const GPR_PETER_FROM_DRIVER = "RICCARDO";
export const GPR_PETER_TO_DRIVER = "MARIO";
export const GPR_PETER_TO_VEHICLE = "25 BIANCO";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type TripGroupRow = {
  id: string;
  date: string;
  driver_user_id: string | null;
  driver_profile_id: string | null;
  vehicle_label: string | null;
  vehicle_capacity: number | null;
  status: string | null;
  updated_at: string | null;
};

type AssignmentRow = {
  id: string;
  service_id: string;
  group_id: string | null;
  driver_user_id: string | null;
  driver_profile_id: string | null;
  vehicle_label: string | null;
};

type ServiceRow = {
  id: string;
  date: string;
  time: string | null;
  pickup_hotel: string | null;
  customer_name: string | null;
  pax: number | null;
  status: string | null;
};

type VehicleRow = {
  id: string;
  label: string | null;
  capacity: number | null;
  active: boolean | null;
};

type AvailabilityRow = {
  driver_profile_id: string | null;
  driver_user_id: string | null;
  available: boolean | null;
  available_from: string | null;
  available_to: string | null;
};

type VehicleBlockRow = {
  vehicle_id: string | null;
  date?: string | null;
  block_from?: string | null;
  block_to?: string | null;
  blocked_from?: string | null;
  blocked_until?: string | null;
};

export type GprPeterDriverSwapPreview = {
  ok: true;
  date: string;
  trip_group_id: string;
  preview_reference: string;
  already_applied: boolean;
  current: {
    driver_profile_id: string | null;
    driver_user_id: string | null;
    driver_name: string | null;
    vehicle_label: string | null;
    vehicle_capacity: number | null;
    updated_at: string | null;
  };
  proposed: {
    driver_profile_id: string | null;
    driver_user_id: string | null;
    driver_name: string | null;
    max_vehicle_capacity: number | null;
    vehicle_id: string | null;
    vehicle_label: string;
    vehicle_capacity: number | null;
  };
  trip: {
    start_time: string | null;
    end_time: string | null;
    pax: number;
    service_ids: string[];
    customer_names: string[];
  };
  checks: {
    mario_available: boolean;
    mario_can_drive_25: boolean;
    vehicle_available: boolean;
    vehicle_capacity_ok: boolean;
    mario_overlap_count: number;
    vehicle_overlap_count: number;
    overbooking: number;
    driver_vehicle_eligibility_blocker: boolean;
    conflicts_before: number;
    conflicts_after: number;
  };
  warnings: string[];
  blockers: string[];
  before_json: JsonValue;
  after_json: JsonValue;
  payload_json: JsonValue;
};

function normalizeText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizedUpper(value: unknown) {
  return normalizeText(value).toUpperCase();
}

function minutes(value: unknown) {
  const match = String(value ?? "").match(/(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function hhmm(value: number | null) {
  if (value == null) return null;
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function stableJson(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableJson(item)])
    );
  }
  if (value == null) return null;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  return String(value);
}

export function buildGprPeterDriverSwapPreviewReference(payload: unknown) {
  return createHash("sha256").update(JSON.stringify(stableJson(payload))).digest("hex");
}

function driverKey(driver: Pick<DriverRegistryEntry, "id" | "user_id"> | null | undefined) {
  if (!driver) return null;
  return driver.id ? `profile:${driver.id}` : driver.user_id ? `user:${driver.user_id}` : null;
}

function groupDriverKey(group: Pick<TripGroupRow, "driver_profile_id" | "driver_user_id">) {
  return group.driver_profile_id ? `profile:${group.driver_profile_id}` : group.driver_user_id ? `user:${group.driver_user_id}` : null;
}

function vehicleBlockedOnDate(block: VehicleBlockRow, date: string) {
  const singleDate = String(block.date ?? "").slice(0, 10);
  if (singleDate) return singleDate === date;
  const from = String(block.blocked_from ?? block.block_from ?? "").slice(0, 10);
  const until = String(block.blocked_until ?? block.block_to ?? "").slice(0, 10);
  return Boolean(from && until && from <= date && until >= date);
}

function intervalsOverlap(aStart: number | null, aEnd: number | null, bStart: number | null, bEnd: number | null) {
  if (aStart == null || aEnd == null || bStart == null || bEnd == null) return false;
  return aStart < bEnd && aEnd > bStart;
}

function findDriverByName(drivers: DriverRegistryEntry[], name: string) {
  const target = normalizeDriverName(name);
  return drivers.find((driver) => normalizeDriverName(driver.full_name) === target)
    ?? drivers.find((driver) => normalizeDriverName(driver.full_name).includes(target))
    ?? null;
}

function driverNameForGroup(group: TripGroupRow, drivers: DriverRegistryEntry[]) {
  return group.driver_profile_id
    ? drivers.find((driver) => driver.id === group.driver_profile_id)?.full_name ?? null
    : group.driver_user_id
      ? drivers.find((driver) => driver.user_id === group.driver_user_id)?.full_name ?? null
      : null;
}

export function validateGprPeterDriverSwapPreviewForApply(preview: GprPeterDriverSwapPreview) {
  const blockers = [...preview.blockers];
  if (preview.already_applied) return { ok: true, blockers: [] };
  if (normalizedUpper(preview.current.driver_name) !== GPR_PETER_FROM_DRIVER) blockers.push("GPR PETER non e piu su RICCARDO.");
  if (preview.trip.start_time !== GPR_PETER_EXPECTED_START) blockers.push("GPR PETER non e piu alle 15:00.");
  if (preview.trip.pax !== GPR_PETER_EXPECTED_PAX) blockers.push("Pax GPR PETER cambiato.");
  if (!preview.checks.mario_available) blockers.push("Mario non e piu disponibile alle 15:00.");
  if (!preview.checks.mario_can_drive_25) blockers.push("Mario non puo guidare 25 BIANCO.");
  if (!preview.checks.vehicle_available) blockers.push("25 BIANCO non e piu disponibile.");
  if (preview.checks.mario_overlap_count > 0) blockers.push("Nasce overlap reale su Mario.");
  if (preview.checks.vehicle_overlap_count > 0) blockers.push("25 BIANCO ha overlap reale.");
  if (preview.checks.overbooking > 0) blockers.push("Overbooking maggiore di 0.");
  if (preview.checks.driver_vehicle_eligibility_blocker) blockers.push("Eligibility blocker autista/mezzo.");
  if (preview.checks.conflicts_after > 0) blockers.push("Nuovi conflitti dopo swap.");
  return { ok: blockers.length === 0, blockers: [...new Set(blockers)] };
}

export async function buildGprPeterDriverSwapPreview(args: {
  admin: SupabaseClient;
  tenantId: string;
  date: string;
}): Promise<GprPeterDriverSwapPreview> {
  const { admin, tenantId, date } = args;
  if (date !== GPR_PETER_EXPECTED_DATE) {
    throw new Error(`La rotazione GPR PETER e prevista solo per ${GPR_PETER_EXPECTED_DATE}.`);
  }

  const [drivers, groupResult, vehiclesResult, vehicleAvailabilityResult, vehicleBlocksResult, driverAvailabilityResult] = await Promise.all([
    listDriverRegistry(admin, tenantId, { activeOnly: true }),
    admin
      .from("trip_groups")
      .select("id,date,driver_user_id,driver_profile_id,vehicle_label,vehicle_capacity,status,updated_at")
      .eq("tenant_id", tenantId)
      .eq("date", date)
      .eq("id", GPR_PETER_GROUP_ID)
      .maybeSingle(),
    admin.from("vehicles").select("id,label,capacity,active").eq("tenant_id", tenantId),
    admin.from("vehicle_daily_availability").select("vehicle_id,available").eq("tenant_id", tenantId).eq("date", date),
    admin.from("vehicle_time_blocks").select("*").eq("tenant_id", tenantId),
    admin
      .from("driver_daily_availability")
      .select("driver_profile_id,driver_user_id,available,available_from,available_to")
      .eq("tenant_id", tenantId)
      .eq("date", date),
  ]);

  const errors = [
    groupResult.error ? `trip_groups: ${groupResult.error.message}` : null,
    vehiclesResult.error ? `vehicles: ${vehiclesResult.error.message}` : null,
    vehicleAvailabilityResult.error ? `vehicle_daily_availability: ${vehicleAvailabilityResult.error.message}` : null,
    vehicleBlocksResult.error ? `vehicle_time_blocks: ${vehicleBlocksResult.error.message}` : null,
    driverAvailabilityResult.error ? `driver_daily_availability: ${driverAvailabilityResult.error.message}` : null,
  ].filter(Boolean);
  if (errors.length > 0) throw new Error(errors.join("; "));
  if (!groupResult.data?.id) throw new Error("Trip group GPR PETER non trovato.");

  const group = groupResult.data as TripGroupRow;
  const assignmentsResult = await admin
    .from("assignments")
    .select("id,service_id,group_id,driver_user_id,driver_profile_id,vehicle_label")
    .eq("tenant_id", tenantId)
    .eq("group_id", group.id);
  if (assignmentsResult.error) throw new Error(`assignments: ${assignmentsResult.error.message}`);

  const assignments = (assignmentsResult.data ?? []) as AssignmentRow[];
  const serviceIds = [...new Set(assignments.map((assignment) => assignment.service_id).filter(Boolean))].sort();
  const servicesResult = serviceIds.length > 0
    ? await admin
        .from("services")
        .select("id,date,time,pickup_hotel,customer_name,pax,status")
        .eq("tenant_id", tenantId)
        .in("id", serviceIds)
    : { data: [] as ServiceRow[], error: null };
  if (servicesResult.error) throw new Error(`services: ${servicesResult.error.message}`);

  const services = (servicesResult.data ?? []) as ServiceRow[];
  const serviceTimes = services.map((service) => minutes(service.pickup_hotel ?? service.time)).filter((value): value is number => value != null);
  const start = serviceTimes.length > 0 ? Math.min(...serviceTimes) : null;
  const end = serviceTimes.length > 0 ? Math.max(...serviceTimes) + 30 : null;
  const pax = services.reduce((sum, service) => sum + (Number(service.pax) || 0), 0);

  const toDriver = findDriverByName(drivers, GPR_PETER_TO_DRIVER);
  const currentDriverName = driverNameForGroup(group, drivers);
  const vehicle = ((vehiclesResult.data ?? []) as VehicleRow[]).find((row) => normalizedUpper(row.label) === GPR_PETER_TO_VEHICLE) ?? null;
  const vehicleAvail = new Map((vehicleAvailabilityResult.data ?? []).map((row) => [row.vehicle_id, row.available]));
  const blockedVehicleIds = new Set(
    ((vehicleBlocksResult.data ?? []) as VehicleBlockRow[])
      .filter((block) => vehicleBlockedOnDate(block, date))
      .map((block) => block.vehicle_id)
  );
  const vehicleAvailable = vehicle?.id
    ? vehicle.active !== false
      && vehicleAvail.get(vehicle.id) !== false
      && !blockedVehicleIds.has(vehicle.id)
    : false;

  const availabilityRows = (driverAvailabilityResult.data ?? []) as AvailabilityRow[];
  const toAvailability = toDriver
    ? availabilityRows.find((row) => row.driver_profile_id === toDriver.id)
      ?? (toDriver.user_id ? availabilityRows.find((row) => row.driver_user_id === toDriver.user_id) : null)
      ?? null
    : null;
  const driverAvailability = canDriverCoverInterval(toAvailability, { start_time: hhmm(start), end_time: hhmm(end) }, {
    missingAvailability: "blocker",
    missingBounds: "warning",
  });
  const eligibility = canDriverUseVehicle(toDriver ?? {}, vehicle ?? {}, { blockUnknownVehicleCapacity: true });

  const allGroupsResult = await admin
    .from("trip_groups")
    .select("id,date,driver_user_id,driver_profile_id,vehicle_label,vehicle_capacity,status,updated_at")
    .eq("tenant_id", tenantId)
    .eq("date", date)
    .eq("status", "active");
  if (allGroupsResult.error) throw new Error(`trip_groups timeline: ${allGroupsResult.error.message}`);

  const otherGroups = ((allGroupsResult.data ?? []) as TripGroupRow[]).filter((row) => row.id !== group.id);
  const otherGroupIds = otherGroups.map((row) => row.id);
  const otherAssignmentsResult = otherGroupIds.length > 0
    ? await admin.from("assignments").select("service_id,group_id").eq("tenant_id", tenantId).in("group_id", otherGroupIds)
    : { data: [] as Array<{ service_id: string; group_id: string | null }>, error: null };
  if (otherAssignmentsResult.error) throw new Error(`assignments timeline: ${otherAssignmentsResult.error.message}`);

  const otherServiceIds = [...new Set((otherAssignmentsResult.data ?? []).map((assignment) => assignment.service_id).filter(Boolean))];
  const otherServicesResult = otherServiceIds.length > 0
    ? await admin.from("services").select("id,time,pickup_hotel,pax,status").eq("tenant_id", tenantId).in("id", otherServiceIds)
    : { data: [] as Array<{ id: string; time: string | null; pickup_hotel: string | null; pax: number | null; status: string | null }>, error: null };
  if (otherServicesResult.error) throw new Error(`services timeline: ${otherServicesResult.error.message}`);

  const servicesById = new Map((otherServicesResult.data ?? []).map((service) => [service.id, service]));
  const assignmentsByGroup = new Map<string, Array<{ service_id: string; group_id: string | null }>>();
  for (const assignment of otherAssignmentsResult.data ?? []) {
    if (!assignment.group_id) continue;
    assignmentsByGroup.set(assignment.group_id, [...(assignmentsByGroup.get(assignment.group_id) ?? []), assignment]);
  }

  const proposedDriverKey = driverKey(toDriver);
  const proposedVehicleLabel = vehicle?.label ?? GPR_PETER_TO_VEHICLE;
  let marioOverlapCount = 0;
  let vehicleOverlapCount = 0;
  let driverBufferBefore: number | null = null;
  let driverBufferAfter: number | null = null;
  let vehicleBufferBefore: number | null = null;
  let vehicleBufferAfter: number | null = null;

  for (const otherGroup of otherGroups) {
    const otherAssignments = assignmentsByGroup.get(otherGroup.id) ?? [];
    const times = otherAssignments
      .map((assignment) => servicesById.get(assignment.service_id))
      .filter((service): service is NonNullable<ReturnType<typeof servicesById.get>> => Boolean(service))
      .map((service) => minutes(service.pickup_hotel ?? service.time))
      .filter((value): value is number => value != null);
    if (times.length === 0) continue;
    const otherStart = Math.min(...times);
    const otherEnd = Math.max(...times) + 30;
    if (groupDriverKey(otherGroup) === proposedDriverKey && intervalsOverlap(start, end, otherStart, otherEnd)) {
      marioOverlapCount += 1;
    }
    if (groupDriverKey(otherGroup) === proposedDriverKey) {
      if (otherEnd <= (start ?? -1)) {
        const candidate = (start ?? 0) - otherEnd;
        driverBufferBefore = driverBufferBefore == null ? candidate : Math.min(driverBufferBefore, candidate);
      }
      if ((end ?? 99999) <= otherStart) {
        const candidate = otherStart - (end ?? 0);
        driverBufferAfter = driverBufferAfter == null ? candidate : Math.min(driverBufferAfter, candidate);
      }
    }
    if (normalizedUpper(otherGroup.vehicle_label) === normalizedUpper(proposedVehicleLabel) && intervalsOverlap(start, end, otherStart, otherEnd)) {
      vehicleOverlapCount += 1;
    }
    if (normalizedUpper(otherGroup.vehicle_label) === normalizedUpper(proposedVehicleLabel)) {
      if (otherEnd <= (start ?? -1)) {
        const candidate = (start ?? 0) - otherEnd;
        vehicleBufferBefore = vehicleBufferBefore == null ? candidate : Math.min(vehicleBufferBefore, candidate);
      }
      if ((end ?? 99999) <= otherStart) {
        const candidate = otherStart - (end ?? 0);
        vehicleBufferAfter = vehicleBufferAfter == null ? candidate : Math.min(vehicleBufferAfter, candidate);
      }
    }
  }

  const alreadyApplied = groupDriverKey(group) === proposedDriverKey
    && normalizedUpper(group.vehicle_label) === normalizedUpper(proposedVehicleLabel);
  const overbooking = Math.max(0, pax - (vehicle?.capacity ?? 0));
  const bufferBefore = driverBufferBefore ?? vehicleBufferBefore;
  const bufferAfter = driverBufferAfter ?? vehicleBufferAfter;
  const warnings = [
    bufferBefore != null ? `Buffer prima ${bufferBefore} min.` : null,
    bufferAfter != null ? `Buffer dopo ${bufferAfter} min.` : null,
  ].filter((warning): warning is string => Boolean(warning));

  const beforeJson = {
    group_id: group.id,
    driver_profile_id: group.driver_profile_id,
    driver_user_id: group.driver_user_id,
    driver_name: currentDriverName,
    vehicle_label: group.vehicle_label,
    vehicle_capacity: group.vehicle_capacity,
    updated_at: group.updated_at,
    service_ids: serviceIds,
  };
  const afterJson = {
    group_id: group.id,
    driver_profile_id: toDriver?.id ?? null,
    driver_user_id: toDriver?.user_id ?? null,
    driver_name: toDriver?.full_name ?? GPR_PETER_TO_DRIVER,
    vehicle_id: vehicle?.id ?? null,
    vehicle_label: proposedVehicleLabel,
    vehicle_capacity: vehicle?.capacity ?? null,
    service_ids: serviceIds,
  };
  const checks = {
    mario_available: driverAvailability.allowed,
    mario_can_drive_25: eligibility.allowed,
    vehicle_available: vehicleAvailable,
    vehicle_capacity_ok: overbooking === 0,
    mario_overlap_count: marioOverlapCount,
    vehicle_overlap_count: vehicleOverlapCount,
    overbooking,
    driver_vehicle_eligibility_blocker: !eligibility.allowed,
    conflicts_before: normalizedUpper(currentDriverName) === GPR_PETER_FROM_DRIVER && !canDriverUseVehicle(
      drivers.find((driver) => groupDriverKey(group) === driverKey(driver)) ?? {},
      vehicle ?? {},
      { blockUnknownVehicleCapacity: true }
    ).allowed ? 1 : 0,
    conflicts_after: marioOverlapCount + vehicleOverlapCount + (overbooking > 0 ? 1 : 0) + (!eligibility.allowed ? 1 : 0),
  };
  const basePayload = {
    tenantId,
    date,
    group: {
      id: group.id,
      date: group.date,
      status: group.status,
      driver_user_id: group.driver_user_id,
      driver_profile_id: group.driver_profile_id,
      vehicle_label: group.vehicle_label,
      vehicle_capacity: group.vehicle_capacity,
      updated_at: group.updated_at,
    },
    assignments,
    services: services.map((service) => ({
      id: service.id,
      time: service.time,
      pickup_hotel: service.pickup_hotel,
      customer_name: service.customer_name,
      pax: service.pax,
      status: service.status,
    })),
    proposed: afterJson,
    checks,
    warnings,
  };

  const preview: GprPeterDriverSwapPreview = {
    ok: true,
    date,
    trip_group_id: group.id,
    preview_reference: buildGprPeterDriverSwapPreviewReference(basePayload),
    already_applied: alreadyApplied,
    current: {
      driver_profile_id: group.driver_profile_id,
      driver_user_id: group.driver_user_id,
      driver_name: currentDriverName,
      vehicle_label: group.vehicle_label,
      vehicle_capacity: group.vehicle_capacity,
      updated_at: group.updated_at,
    },
    proposed: {
      driver_profile_id: toDriver?.id ?? null,
      driver_user_id: toDriver?.user_id ?? null,
      driver_name: toDriver?.full_name ?? null,
      max_vehicle_capacity: toDriver?.max_vehicle_capacity ?? null,
      vehicle_id: vehicle?.id ?? null,
      vehicle_label: proposedVehicleLabel,
      vehicle_capacity: vehicle?.capacity ?? null,
    },
    trip: {
      start_time: hhmm(start),
      end_time: hhmm(end),
      pax,
      service_ids: serviceIds,
      customer_names: [...new Set(services.map((service) => normalizeText(service.customer_name)).filter(Boolean))].sort(),
    },
    checks,
    warnings,
    blockers: [],
    before_json: stableJson(beforeJson),
    after_json: stableJson(afterJson),
    payload_json: stableJson({
      preview_reference: buildGprPeterDriverSwapPreviewReference(basePayload),
      trip_group_id: group.id,
      controlled_swap: "GPR PETER RICCARDO -> MARIO / 25 BIANCO",
      checks,
      warnings,
      before: beforeJson,
      after: afterJson,
    }),
  };

  preview.blockers = validateGprPeterDriverSwapPreviewForApply(preview).blockers;
  return preview;
}
