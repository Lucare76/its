import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildHybridVehicleBinding, type HybridVehicleBindingResult } from "@/lib/piano-hybrid-vehicle-binding";
import { canDriverUseVehicle } from "@/lib/piano-driver-vehicle-eligibility";
import { listDriverRegistry } from "@/lib/server/driver-registry";

export const HYBRID_BINDING_ACTION = "APPLY_HYBRID_VEHICLE_BINDING";
export const HYBRID_BINDING_DECISION_TYPE = "vehicle_binding_confirmed";

const LARGE_GROUP_PAX_THRESHOLD = 21;
const MIN_BUFFER_MINUTES = 20;

type TripGroupRow = {
  id: string;
  date: string;
  driver_user_id: string | null;
  driver_profile_id: string | null;
  vehicle_label: string | null;
  vehicle_capacity: number | null;
  status: string | null;
  updated_at?: string | null;
};

type AssignmentRow = {
  id?: string | null;
  service_id: string;
  group_id: string | null;
  driver_user_id?: string | null;
  driver_profile_id?: string | null;
  vehicle_label?: string | null;
};

type ServiceRow = {
  id: string;
  time: string | null;
  pickup_hotel: string | null;
  pax: number | null;
  status?: string | null;
};

type VehicleRow = {
  id: string;
  label: string | null;
  capacity: number | null;
  active?: boolean | null;
};

type VehicleAvailabilityRow = {
  vehicle_id: string | null;
  available?: boolean | null;
};

type DriverAvailabilityRow = {
  driver_profile_id?: string | null;
  driver_user_id?: string | null;
  available?: boolean | null;
};

type VehicleBlockRow = {
  vehicle_id: string | null;
  date?: string | null;
  block_from?: string | null;
  blocked_from?: string | null;
  blocked_until?: string | null;
};
type StableJsonValue = null | boolean | number | string | StableJsonValue[] | { [key: string]: StableJsonValue };
type EligibilityStatus = "OK" | "NO_CAPACITY_LIMIT" | "NO" | "WARNING";

export type VehicleBindingPreviewChange = {
  group_id: string;
  driver_key: string | null;
  driver_name: string | null;
  start_time: string | null;
  end_time: string | null;
  pax: number;
  current_vehicle_label: string | null;
  current_vehicle_capacity: number | null;
  proposed_vehicle_label: string | null;
  proposed_vehicle_capacity: number | null;
  reason: string;
  large_vehicle_shared: boolean;
  buffer_from_previous: number | null;
  service_ids: string[];
};

export type VehicleBindingPreviewPayload = {
  ok: true;
  date: string;
  preview_reference: string;
  config: {
    largeGroupPaxThreshold: number;
    minBufferMinutes: number;
  };
  current_binding: Array<{
    group_id: string;
    driver_key: string | null;
    driver_name: string | null;
    vehicle_label: string | null;
    vehicle_capacity: number | null;
    pax: number;
    start_time: string | null;
    end_time: string | null;
  }>;
  proposed_binding: Array<{
    group_id: string;
    driver_key: string | null;
    driver_name: string | null;
    vehicle_label: string | null;
    vehicle_capacity: number | null;
    pax: number;
    start_time: string | null;
    end_time: string | null;
    is_large_group: boolean;
  }>;
  changes: VehicleBindingPreviewChange[];
  large_trips: VehicleBindingPreviewPayload["proposed_binding"];
  large_vehicle_usage: HybridVehicleBindingResult["large_vehicle_usage"];
  standard_vehicle_bindings: HybridVehicleBindingResult["standard_vehicle_bindings"];
  conflicts: HybridVehicleBindingResult["conflicts"];
  summary: HybridVehicleBindingResult["summary"] & {
    eligibility_blockers: number;
    changes_needed: number;
    services_involved: number;
  };
  warnings: string[];
  info: string[];
  audit: {
    available_drivers: Array<{ driver_key: string; driver_name: string | null; max_vehicle_capacity: number | null }>;
    available_vehicles: Array<{ id: string | null; label: string | null; capacity: number | null }>;
    eligibility_matrix: Array<{
      driver_key: string;
      driver_name: string | null;
      max_vehicle_capacity: number | null;
      vehicles: Array<{ vehicle_label: string | null; vehicle_capacity: number | null; status: EligibilityStatus }>;
    }>;
  };
  snapshot: {
    group_ids: string[];
    service_ids: string[];
  };
};

function normalize(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function minuteFromTime(value: unknown) {
  const match = String(value ?? "").match(/(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function hhmm(value: number | null) {
  if (value == null) return null;
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function stableJson(value: unknown): StableJsonValue {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableJson(item)])
    );
  }
  if (value === undefined) return null;
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  return String(value);
}

export function buildVehicleBindingPreviewReference(payload: unknown) {
  return createHash("sha256").update(JSON.stringify(stableJson(payload))).digest("hex");
}

function vehicleBlockedOnDate(block: VehicleBlockRow, date: string) {
  const singleDate = String(block.date ?? "").slice(0, 10);
  if (singleDate) return singleDate === date;
  const from = String(block.blocked_from ?? block.block_from ?? "").slice(0, 10);
  const until = String(block.blocked_until ?? "").slice(0, 10);
  return Boolean(from && until && from <= date && until >= date);
}

function vehicleCapacityByLabel(vehicles: Array<{ label: string | null; capacity?: number | null }>) {
  return new Map(vehicles.filter((vehicle) => vehicle.label).map((vehicle) => [vehicle.label!, vehicle.capacity ?? null]));
}

export function validateVehicleBindingPreviewForApply(preview: VehicleBindingPreviewPayload) {
  const blockers: string[] = [];
  if (preview.summary.conflicts_after > 0) blockers.push("La preview contiene ancora conflitti mezzo.");
  if (preview.summary.overbooking_after > 0) blockers.push("La preview contiene ancora overbooking.");
  if (preview.summary.eligibility_blockers > 0) blockers.push("La preview contiene autisti non abilitati al mezzo proposto.");
  if (preview.conflicts.some((conflict) => conflict.type === "standard_vehicle_same_day_conflict" && conflict.severity === "blocker")) {
    blockers.push("Un mezzo standard risulta condiviso tra autisti.");
  }
  if (preview.conflicts.some((conflict) => conflict.type === "large_vehicle_shared_timeline_conflict" && conflict.severity === "blocker")) {
    blockers.push("Un mezzo capiente condiviso ha overlap o buffer insufficiente.");
  }
  return { ok: blockers.length === 0, blockers };
}

export async function buildVehicleBindingPreview(args: {
  admin: SupabaseClient;
  tenantId: string;
  date: string;
}): Promise<VehicleBindingPreviewPayload> {
  const { admin, tenantId, date } = args;

  const [
    driverRegistry,
    driverAvailabilityResult,
    vehiclesResult,
    vehicleAvailabilityResult,
    vehicleBlocksResult,
    tripGroupsResult,
  ] = await Promise.all([
    listDriverRegistry(admin, tenantId, { activeOnly: true }),
    admin.from("driver_daily_availability").select("*").eq("tenant_id", tenantId).eq("date", date),
    admin.from("vehicles").select("id, label, capacity, active").eq("tenant_id", tenantId).order("label"),
    admin.from("vehicle_daily_availability").select("*").eq("tenant_id", tenantId).eq("date", date),
    admin.from("vehicle_time_blocks").select("*").eq("tenant_id", tenantId),
    admin
      .from("trip_groups")
      .select("id, date, driver_user_id, driver_profile_id, vehicle_label, vehicle_capacity, status, updated_at")
      .eq("tenant_id", tenantId)
      .eq("date", date)
      .neq("status", "cancelled")
      .limit(3000),
  ]);

  const loadErrors = [
    driverAvailabilityResult.error ? `driver_daily_availability: ${driverAvailabilityResult.error.message}` : null,
    vehiclesResult.error ? `vehicles: ${vehiclesResult.error.message}` : null,
    vehicleAvailabilityResult.error ? `vehicle_daily_availability: ${vehicleAvailabilityResult.error.message}` : null,
    vehicleBlocksResult.error ? `vehicle_time_blocks: ${vehicleBlocksResult.error.message}` : null,
    tripGroupsResult.error ? `trip_groups: ${tripGroupsResult.error.message}` : null,
  ].filter(Boolean);
  if (loadErrors.length > 0) throw new Error(loadErrors.join("; "));

  const driverByProfileId = new Map(driverRegistry.map((driver) => [driver.id, driver]));
  const driverByUserId = new Map(driverRegistry.filter((driver) => driver.user_id).map((driver) => [driver.user_id!, driver]));
  const availableDrivers = ((driverAvailabilityResult.data ?? []) as DriverAvailabilityRow[])
    .filter((row) => row.available !== false)
    .map((row) => {
      const profile = row.driver_profile_id ? driverByProfileId.get(row.driver_profile_id) : null;
      const user = row.driver_user_id ? driverByUserId.get(row.driver_user_id) : null;
      const driver = profile ?? user ?? null;
      const userId = row.driver_user_id ?? driver?.user_id ?? null;
      const driverKey = row.driver_profile_id
        ? `profile:${row.driver_profile_id}`
        : userId
          ? `user:${userId}`
          : null;
      return driverKey
        ? {
            driver_key: driverKey,
            driver_name: driver?.full_name ?? null,
            max_vehicle_capacity: driver?.max_vehicle_capacity ?? null,
          }
        : null;
    })
    .filter((driver): driver is { driver_key: string; driver_name: string | null; max_vehicle_capacity: number | null } => Boolean(driver));

  const availabilityByVehicleId = new Map(((vehicleAvailabilityResult.data ?? []) as VehicleAvailabilityRow[]).map((row) => [row.vehicle_id, row]));
  const blockedVehicleIds = new Set(((vehicleBlocksResult.data ?? []) as VehicleBlockRow[]).filter((block) => vehicleBlockedOnDate(block, date)).map((block) => block.vehicle_id));
  const availableVehicles = ((vehiclesResult.data ?? []) as VehicleRow[])
    .filter((vehicle) => vehicle.active !== false)
    .filter((vehicle) => availabilityByVehicleId.get(vehicle.id)?.available !== false)
    .filter((vehicle) => !blockedVehicleIds.has(vehicle.id))
    .map((vehicle) => ({ id: vehicle.id, label: vehicle.label, capacity: vehicle.capacity }));

  const tripGroups = (tripGroupsResult.data ?? []) as TripGroupRow[];
  const groupIds = tripGroups.map((group) => group.id);
  const assignmentsResult = groupIds.length > 0
    ? await admin
        .from("assignments")
        .select("id, service_id, group_id, driver_user_id, driver_profile_id, vehicle_label")
        .eq("tenant_id", tenantId)
        .in("group_id", groupIds)
        .limit(8000)
    : { data: [] as AssignmentRow[], error: null };
  if (assignmentsResult.error) throw new Error(`assignments: ${assignmentsResult.error.message}`);

  const assignments = (assignmentsResult.data ?? []) as AssignmentRow[];
  const serviceIds = [...new Set(assignments.map((assignment) => assignment.service_id).filter(Boolean))].sort();
  const servicesResult = serviceIds.length > 0
    ? await admin
        .from("services")
        .select("id, time, pickup_hotel, pax, status")
        .eq("tenant_id", tenantId)
        .in("id", serviceIds)
        .limit(8000)
    : { data: [] as ServiceRow[], error: null };
  if (servicesResult.error) throw new Error(`services: ${servicesResult.error.message}`);

  const services = (servicesResult.data ?? []) as ServiceRow[];
  const serviceById = new Map(services.map((service) => [service.id, service]));
  const assignmentsByGroup = new Map<string, AssignmentRow[]>();
  for (const assignment of assignments) {
    if (!assignment.group_id) continue;
    assignmentsByGroup.set(assignment.group_id, [...(assignmentsByGroup.get(assignment.group_id) ?? []), assignment]);
  }

  const driverByKey = new Map(availableDrivers.map((driver) => [driver.driver_key, driver]));
  const vehicleCapacity = vehicleCapacityByLabel(availableVehicles);
  const trips = tripGroups.map((group) => {
    const groupAssignments = assignmentsByGroup.get(group.id) ?? [];
    const groupServices = groupAssignments.map((assignment) => serviceById.get(assignment.service_id)).filter((service): service is ServiceRow => Boolean(service));
    const times = groupServices.map((service) => minuteFromTime(service.pickup_hotel ?? service.time)).filter((value): value is number => value != null);
    const start = times.length > 0 ? Math.min(...times) : null;
    const end = times.length > 0 ? Math.max(...times) + 30 : null;
    const driverKey = group.driver_profile_id ? `profile:${group.driver_profile_id}` : group.driver_user_id ? `user:${group.driver_user_id}` : null;
    const driver = driverKey ? driverByKey.get(driverKey) : null;
    return {
      group_id: group.id,
      driver_key: driverKey,
      driver_name: driver?.driver_name ?? null,
      start_time: hhmm(start),
      end_time: hhmm(end),
      pax: groupServices.reduce((sum, service) => sum + (Number(service.pax) || 0), 0),
      current_vehicle_label: group.vehicle_label ?? null,
      service_ids: groupAssignments.map((assignment) => assignment.service_id).filter(Boolean).sort(),
      current_vehicle_capacity: group.vehicle_capacity ?? (group.vehicle_label ? vehicleCapacity.get(group.vehicle_label) ?? null : null),
    };
  });

  const simulation = buildHybridVehicleBinding({
    drivers: availableDrivers,
    vehicles: availableVehicles,
    trips: trips.map((trip) => ({
      group_id: trip.group_id,
      driver_key: trip.driver_key,
      driver_name: trip.driver_name,
      start_time: trip.start_time,
      end_time: trip.end_time,
      pax: trip.pax,
      current_vehicle_label: trip.current_vehicle_label,
    })),
    config: {
      largeGroupPaxThreshold: LARGE_GROUP_PAX_THRESHOLD,
      minBufferMinutes: MIN_BUFFER_MINUTES,
      preferFixedVehicleForStandardTrips: true,
    },
  });

  const tripsByGroupId = new Map(trips.map((trip) => [trip.group_id, trip]));
  const proposedVehicleCapacity = vehicleCapacityByLabel(availableVehicles);
  const largeUsageByGroupId = new Map(simulation.large_vehicle_usage.map((usage) => [usage.group_id, usage]));
  const changes = simulation.trips
    .map<VehicleBindingPreviewChange | null>((trip) => {
      const original = tripsByGroupId.get(trip.group_id);
      if (!original) return null;
      const currentLabel = normalize(original.current_vehicle_label);
      const proposedLabel = normalize(trip.proposed_vehicle_label);
      if (!proposedLabel || currentLabel === proposedLabel) return null;
      const largeUsage = largeUsageByGroupId.get(trip.group_id) ?? null;
      return {
        group_id: trip.group_id,
        driver_key: trip.driver_key,
        driver_name: trip.driver_name ?? original.driver_name,
        start_time: trip.start_time,
        end_time: trip.end_time ?? null,
        pax: trip.pax,
        current_vehicle_label: original.current_vehicle_label ?? null,
        current_vehicle_capacity: original.current_vehicle_capacity ?? null,
        proposed_vehicle_label: trip.proposed_vehicle_label ?? null,
        proposed_vehicle_capacity: trip.proposed_vehicle_label ? proposedVehicleCapacity.get(trip.proposed_vehicle_label) ?? null : null,
        reason: trip.is_large_group ? "Mezzo capiente condiviso a timeline" : "Riallineamento mezzo fisso/compatibile",
        large_vehicle_shared: Boolean(largeUsage && largeUsage.status === "large_vehicle_shared_timeline_ok"),
        buffer_from_previous: largeUsage?.buffer_from_previous ?? null,
        service_ids: original.service_ids,
      };
    })
    .filter((change): change is VehicleBindingPreviewChange => Boolean(change));

  const currentBinding = trips.map((trip) => ({
    group_id: trip.group_id,
    driver_key: trip.driver_key,
    driver_name: trip.driver_name,
    vehicle_label: trip.current_vehicle_label ?? null,
    vehicle_capacity: trip.current_vehicle_capacity ?? null,
    pax: trip.pax,
    start_time: trip.start_time,
    end_time: trip.end_time,
  }));
  const proposedBinding = simulation.trips.map((trip) => ({
    group_id: trip.group_id,
    driver_key: trip.driver_key,
    driver_name: trip.driver_name ?? tripsByGroupId.get(trip.group_id)?.driver_name ?? null,
    vehicle_label: trip.proposed_vehicle_label ?? null,
    vehicle_capacity: trip.proposed_vehicle_label ? proposedVehicleCapacity.get(trip.proposed_vehicle_label) ?? null : null,
    pax: trip.pax,
    start_time: trip.start_time,
    end_time: trip.end_time ?? null,
    is_large_group: trip.is_large_group,
  }));

  const hashPayload = {
    tenantId,
    date,
    drivers: availableDrivers,
    vehicles: availableVehicles,
    tripGroups: tripGroups.map((group) => ({
      id: group.id,
      driver_user_id: group.driver_user_id,
      driver_profile_id: group.driver_profile_id,
      vehicle_label: group.vehicle_label,
      vehicle_capacity: group.vehicle_capacity,
      status: group.status,
      updated_at: group.updated_at ?? null,
    })),
    assignments: assignments.map((assignment) => ({
      id: assignment.id ?? null,
      service_id: assignment.service_id,
      group_id: assignment.group_id,
      driver_user_id: assignment.driver_user_id ?? null,
      driver_profile_id: assignment.driver_profile_id ?? null,
      vehicle_label: assignment.vehicle_label ?? null,
    })),
    services: services.map((service) => ({
      id: service.id,
      time: service.time,
      pickup_hotel: service.pickup_hotel,
      pax: service.pax,
      status: service.status ?? null,
    })),
    changes: changes.map((change) => ({
      group_id: change.group_id,
      to: change.proposed_vehicle_label,
      capacity: change.proposed_vehicle_capacity,
    })),
    summary: simulation.summary,
  };

  const eligibilityMatrix = availableDrivers.map((driver) => ({
    driver_key: driver.driver_key,
    driver_name: driver.driver_name,
    max_vehicle_capacity: driver.max_vehicle_capacity,
    vehicles: availableVehicles.map((vehicle) => {
      const result = canDriverUseVehicle(driver, vehicle);
      const status: EligibilityStatus = result.allowed
        ? (result.severity === "warning" ? "WARNING" : driver.max_vehicle_capacity == null ? "NO_CAPACITY_LIMIT" : "OK")
        : "NO";
      return {
        vehicle_label: vehicle.label ?? null,
        vehicle_capacity: vehicle.capacity ?? null,
        status,
      };
    }),
  }));

  return {
    ok: true,
    date,
    preview_reference: buildVehicleBindingPreviewReference(hashPayload),
    config: {
      largeGroupPaxThreshold: LARGE_GROUP_PAX_THRESHOLD,
      minBufferMinutes: MIN_BUFFER_MINUTES,
    },
    current_binding: currentBinding,
    proposed_binding: proposedBinding,
    changes,
    large_trips: proposedBinding.filter((trip) => trip.is_large_group),
    large_vehicle_usage: simulation.large_vehicle_usage,
    standard_vehicle_bindings: simulation.standard_vehicle_bindings,
    conflicts: simulation.conflicts,
    summary: {
      ...simulation.summary,
      eligibility_blockers: simulation.summary.driver_vehicle_eligibility_blockers,
      changes_needed: changes.length,
      services_involved: new Set(changes.flatMap((change) => change.service_ids)).size,
    },
    warnings: simulation.conflicts.filter((conflict) => conflict.severity === "warning").map((conflict) => conflict.message),
    info: simulation.large_vehicle_usage
      .filter((usage) => usage.status === "large_vehicle_shared_timeline_ok")
      .map((usage) => `${usage.vehicle_label ?? "Mezzo capiente"} condiviso a timeline con buffer ${usage.buffer_from_previous ?? "n/d"} min.`),
    audit: {
      available_drivers: availableDrivers,
      available_vehicles: availableVehicles,
      eligibility_matrix: eligibilityMatrix,
    },
    snapshot: {
      group_ids: groupIds.sort(),
      service_ids: serviceIds,
    },
  };
}
