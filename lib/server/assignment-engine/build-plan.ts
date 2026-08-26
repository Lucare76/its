/**
 * Assegnazione Intelligente — orchestratore V1.
 *
 * Carica i dati del giorno esattamente come
 * app/api/ops/piano-giorno/auto-assign-preview/route.ts (stesse tabelle,
 * stesse colonne, stesso fallback per colonne mancanti), li passa alle
 * funzioni gia' esistenti (buildAutoAssignPreview → vincoli/assegnabilita',
 * planAutoAssignPreview → missioni/score), poi classifica il risultato
 * (classifyPlanItems) e lo persiste su assignment_plans/assignment_plan_items
 * (supabase/migrations/0251_assignment_plans.sql).
 *
 * Ricalcolo incrementale (RICALCOLO INCREMENTALE nel requisito): se
 * `scope.changedServiceIds` e' passato, il piano viene comunque ricostruito
 * per l'intera giornata (i vincoli di missione/disponibilita' richiedono la
 * vista completa — non e' sicuro valutare un sottoinsieme in isolamento), ma
 * la SCRITTURA sostituisce solo gli item il cui servizio ricade nello scope o
 * il cui autista proposto coincide con quello di un item in scope; tutti gli
 * altri item (inclusi i 'locked') restano quelli gia' persistiti. Per una
 * giornata da ~400 servizi questo evita di riscrivere 400 righe per la
 * modifica di un singolo servizio.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildAutoAssignPreview,
  type AutoAssignPreviewAssignment,
  type AutoAssignPreviewHotel,
  type AutoAssignPreviewService,
  type AutoAssignPreviewTripGroup,
} from "@/lib/piano-assignable-preview";
import { planAutoAssignPreview } from "@/lib/piano-auto-assign-planner";
import { listDriverRegistry } from "@/lib/server/driver-registry";
import { auditLog } from "@/lib/server/ops-audit";
import {
  classifyPlanItems,
  type PlanItemAlternative,
  type PlanItemAssignmentInfo,
  type PlanItemDraft,
} from "@/lib/server/assignment-engine/classify-plan";
import { rankCandidatesForService, type RankableDriver, type RankableVehicle } from "@/lib/server/assignment-engine/rank-candidates";
import { suggestOperationalFix, type UnresolvedServiceInput } from "@/lib/server/assignment-engine/suggest-fix";

const BASE_SERVICE_COLUMNS = [
  "id", "date", "time", "time_from", "time_to", "direction", "customer_name", "pax", "hotel_id",
  "vessel", "notes", "status", "meeting_point", "place_type", "pickup_hotel", "booking_service_kind",
  "service_type", "phone",
];
const OPTIONAL_SERVICE_COLUMNS = [
  "service_type_code", "transport_code", "orario_barca", "porto_bruno", "barca_compagnia",
  "ferry_details", "excursion_details", "tour_name", "pickup_time", "origin_place_type",
  "destination_place_type", "origin_place_id", "destination_place_id", "arrival_time", "departure_time",
];

function missingSchemaColumn(message: string) {
  return (
    message.match(/Could not find the '([^']+)' column/)?.[1] ??
    message.match(/column (?:public\.)?services\.([a-zA-Z0-9_]+) does not exist/)?.[1] ??
    message.match(/column "([a-zA-Z0-9_]+)" does not exist/)?.[1] ??
    null
  );
}

export type BuildPlanResult = {
  plan: {
    id: string;
    plan_date: string;
    generated_at: string;
    duration_ms: number;
    services_count: number;
    auto_safe_count: number;
    review_count: number;
    unresolved_count: number;
    locked_count: number;
    manual_count: number;
    drivers_count: number;
    vehicles_count: number;
  };
  items: PlanItemDraft[];
};

export type BuildPlanScope = {
  /** Se presente, ricalcola solo gli item per questi servizi + i servizi successivi dello stesso autista. */
  changedServiceIds?: string[];
};

export async function buildAndPersistAssignmentPlan(
  admin: SupabaseClient,
  args: { tenantId: string; date: string; userId: string; scope?: BuildPlanScope }
): Promise<BuildPlanResult> {
  const startedAt = Date.now();

  let serviceColumns = [...BASE_SERVICE_COLUMNS, ...OPTIONAL_SERVICE_COLUMNS];
  let servicesResult: { data: Array<Record<string, unknown>> | null; error: { message: string } | null } = { data: null, error: null };
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const result = await admin
      .from("services")
      .select(serviceColumns.join(", "))
      .eq("tenant_id", args.tenantId)
      .eq("date", args.date)
      .neq("status", "cancelled")
      .neq("is_draft", true)
      .order("time")
      .limit(3000);
    servicesResult = result as typeof servicesResult;
    if (!result.error) break;
    const missingColumn = missingSchemaColumn(result.error.message);
    if (!missingColumn || !serviceColumns.includes(missingColumn)) break;
    serviceColumns = serviceColumns.filter((column) => column !== missingColumn);
  }
  if (servicesResult.error) throw new Error(`services: ${servicesResult.error.message}`);

  const services = (servicesResult.data ?? []) as AutoAssignPreviewService[];
  const serviceIds = services.map((service) => service.id);

  const [
    hotelsResult,
    tripGroupsResult,
    assignmentsResult,
    driverRegistry,
    vehiclesResult,
    driverAvailabilityResult,
    vehicleAvailabilityResult,
    availabilityConfirmationResult,
  ] = await Promise.all([
    admin.from("hotels").select("id, name, zone, lat, lng").eq("tenant_id", args.tenantId),
    admin.from("trip_groups").select("id, status").eq("tenant_id", args.tenantId).eq("date", args.date).eq("status", "active").limit(3000),
    serviceIds.length > 0
      ? admin
          .from("assignments")
          .select("service_id, group_id, driver_user_id, driver_profile_id, vehicle_label, locked_by_operator")
          .eq("tenant_id", args.tenantId)
          .in("service_id", serviceIds)
          .limit(5000)
      : Promise.resolve({ data: [] as AutoAssignPreviewAssignment[], error: null }),
    listDriverRegistry(admin, args.tenantId, { activeOnly: true }),
    admin.from("vehicles").select("id, label, capacity, active").eq("tenant_id", args.tenantId).eq("active", true).order("capacity"),
    admin.from("driver_daily_availability").select("driver_profile_id, available, available_from, available_to").eq("tenant_id", args.tenantId).eq("date", args.date),
    admin.from("vehicle_daily_availability").select("vehicle_id, available").eq("tenant_id", args.tenantId).eq("date", args.date),
    admin.from("daily_availability_confirmations").select("confirmed").eq("tenant_id", args.tenantId).eq("date", args.date).maybeSingle(),
  ]);

  const loadErrors = [
    hotelsResult.error ? `hotels: ${hotelsResult.error.message}` : null,
    tripGroupsResult.error ? `trip_groups: ${tripGroupsResult.error.message}` : null,
    assignmentsResult.error ? `assignments: ${assignmentsResult.error.message}` : null,
    vehiclesResult.error ? `vehicles: ${vehiclesResult.error.message}` : null,
    driverAvailabilityResult.error ? `driver_daily_availability: ${driverAvailabilityResult.error.message}` : null,
    vehicleAvailabilityResult.error ? `vehicle_daily_availability: ${vehicleAvailabilityResult.error.message}` : null,
    availabilityConfirmationResult.error ? `daily_availability_confirmations: ${availabilityConfirmationResult.error.message}` : null,
  ].filter((value): value is string => Boolean(value));
  if (loadErrors.length > 0) throw new Error(loadErrors.join("; "));

  const preview = buildAutoAssignPreview({
    date: args.date,
    mode: "all",
    services,
    hotels: (hotelsResult.data ?? []) as AutoAssignPreviewHotel[],
    assignments: (assignmentsResult.data ?? []) as AutoAssignPreviewAssignment[],
    tripGroups: (tripGroupsResult.data ?? []) as AutoAssignPreviewTripGroup[],
  });

  const driverAvailabilityById = new Map(
    (driverAvailabilityResult.data ?? []).map((row) => [
      row.driver_profile_id as string,
      { available: row.available as boolean | null, available_from: row.available_from as string | null, available_to: row.available_to as string | null },
    ])
  );
  const vehicleAvailabilityById = new Map((vehicleAvailabilityResult.data ?? []).map((row) => [row.vehicle_id as string, row.available as boolean | null]));
  const driverNameByProfileId = new Map(driverRegistry.map((driver) => [driver.id, driver.full_name]));
  const driverNameByUserId = new Map(driverRegistry.filter((driver) => driver.user_id).map((driver) => [driver.user_id!, driver.full_name]));

  const activeDrivers: RankableDriver[] = driverRegistry
    .filter((driver) => !driver.access_suspended)
    .map((driver) => {
      const availability = driverAvailabilityById.get(driver.id);
      return {
        id: driver.id,
        name: driver.full_name,
        available: availability?.available ?? true,
        available_from: availability?.available_from ?? null,
        available_to: availability?.available_to ?? null,
        max_vehicle_capacity: driver.max_vehicle_capacity ?? null,
      };
    });
  const activeVehicles: RankableVehicle[] = ((vehiclesResult.data ?? []) as Array<{ id: string; label: string; capacity: number | null }>).map((vehicle) => ({
    id: vehicle.id,
    label: vehicle.label,
    capacity: vehicle.capacity,
    available: vehicleAvailabilityById.get(vehicle.id) ?? true,
  }));

  const lockedAssignments = ((assignmentsResult.data ?? []) as AutoAssignPreviewAssignment[])
    .filter((assignment) => assignment.locked_by_operator === true)
    .map((assignment) => ({
      service_id: assignment.service_id,
      driver_id: assignment.driver_profile_id ?? null,
      driver_name: assignment.driver_profile_id
        ? driverNameByProfileId.get(assignment.driver_profile_id) ?? null
        : assignment.driver_user_id
          ? driverNameByUserId.get(assignment.driver_user_id) ?? null
          : null,
      vehicle_label: assignment.vehicle_label ?? null,
    }));

  const planning = planAutoAssignPreview({
    services: preview.services,
    availability_confirmed: availabilityConfirmationResult.data?.confirmed === true,
    drivers: activeDrivers.map((driver) => ({
      id: driver.id,
      name: driver.name,
      available: driver.available,
      available_from: driver.available_from,
      available_to: driver.available_to,
      max_vehicle_capacity: driver.max_vehicle_capacity,
    })),
    vehicles: activeVehicles,
    locked_assignments: lockedAssignments,
  });

  const assignmentByServiceId = new Map<string, PlanItemAssignmentInfo>(
    ((assignmentsResult.data ?? []) as AutoAssignPreviewAssignment[]).map((assignment) => [
      assignment.service_id,
      {
        driver_id: assignment.driver_profile_id ?? null,
        driver_name: assignment.driver_profile_id
          ? driverNameByProfileId.get(assignment.driver_profile_id) ?? null
          : assignment.driver_user_id
            ? driverNameByUserId.get(assignment.driver_user_id) ?? null
            : null,
        vehicle_id: null,
        vehicle_label: assignment.vehicle_label ?? null,
        locked_by_operator: assignment.locked_by_operator === true,
      },
    ])
  );

  const assignmentsCountByDriverId = new Map<string, number>();
  for (const group of planning.proposed_groups) {
    assignmentsCountByDriverId.set(group.driver_id, group.services.length);
  }

  // Piano/item precedenti (per preservare i 'locked' espliciti attraverso il ricalcolo).
  const { data: existingPlanRow } = await admin
    .from("assignment_plans")
    .select("id")
    .eq("tenant_id", args.tenantId)
    .eq("plan_date", args.date)
    .maybeSingle();
  const previousItemsByServiceId = new Map<string, PlanItemDraft>();
  if (existingPlanRow?.id) {
    const { data: previousItems } = await admin
      .from("assignment_plan_items")
      .select("*")
      .eq("tenant_id", args.tenantId)
      .eq("plan_id", existingPlanRow.id);
    for (const row of previousItems ?? []) {
      previousItemsByServiceId.set(row.service_id as string, rowToDraft(row as Record<string, unknown>));
    }
  }

  const items = classifyPlanItems({
    preview,
    planning,
    assignmentByServiceId,
    previousItemsByServiceId,
    rankAlternatives: (row) =>
      rankCandidatesForService({
        service: { operational_time: row.operational_time, pax: row.pax },
        drivers: activeDrivers,
        vehicles: activeVehicles,
        assignmentsCountByDriverId,
      }),
  });

  // Suggerimento di manovra per gli 'unresolved' (richiede la vista completa del piano).
  const serviceInfoById = new Map<string, UnresolvedServiceInput>(
    preview.services.map((row) => [row.service_id, { service_id: row.service_id, operational_time: row.operational_time, pax: row.pax }])
  );
  for (const item of items) {
    if (item.status !== "unresolved") continue;
    const info = serviceInfoById.get(item.service_id);
    if (!info) continue;
    item.suggested_fix = suggestOperationalFix({
      blockedService: info,
      planItems: items,
      serviceInfoById,
      drivers: activeDrivers,
      vehicles: activeVehicles,
    });
  }

  const scopeServiceIds = args.scope?.changedServiceIds?.length ? new Set(args.scope.changedServiceIds) : null;
  const writableItems = scopeServiceIds ? expandIncrementalScope(items, scopeServiceIds) : items;

  const durationMs = Date.now() - startedAt;
  const summary = {
    services_count: items.length,
    auto_safe_count: items.filter((item) => item.status === "auto_safe").length,
    review_count: items.filter((item) => item.status === "review").length,
    unresolved_count: items.filter((item) => item.status === "unresolved").length,
    locked_count: items.filter((item) => item.status === "locked").length,
    manual_count: items.filter((item) => item.status === "manual").length,
    drivers_count: activeDrivers.length,
    vehicles_count: activeVehicles.length,
  };

  const now = new Date().toISOString();
  const { data: planRow, error: planUpsertError } = await admin
    .from("assignment_plans")
    .upsert(
      {
        tenant_id: args.tenantId,
        plan_date: args.date,
        status: "ready",
        generated_by: args.userId,
        generated_at: now,
        duration_ms: durationMs,
        ...summary,
        summary: summary,
        updated_at: now,
      },
      { onConflict: "tenant_id,plan_date" }
    )
    .select("id")
    .single();
  if (planUpsertError || !planRow?.id) throw new Error(planUpsertError?.message ?? "Errore creazione piano.");

  const planId = planRow.id as string;
  const itemRows = writableItems.map((item) => draftToRow(item, planId, args.tenantId));
  if (itemRows.length > 0) {
    const { error: itemsUpsertError } = await admin.from("assignment_plan_items").upsert(itemRows, { onConflict: "plan_id,service_id" });
    if (itemsUpsertError) throw new Error(itemsUpsertError.message);
  }

  auditLog({
    event: existingPlanRow?.id ? "plan_recalculated" : "plan_generated",
    level: "info",
    tenantId: args.tenantId,
    userId: args.userId,
    details: { plan_id: planId, date: args.date, duration_ms: durationMs, ...summary, incremental: Boolean(scopeServiceIds) },
  });
  for (const item of items) {
    if (item.status === "unresolved") {
      auditLog({ event: "assignment_unresolved", level: "warn", tenantId: args.tenantId, userId: args.userId, serviceId: item.service_id, details: { reason: item.reason.summary } });
    }
  }

  return {
    plan: { id: planId, plan_date: args.date, generated_at: now, duration_ms: durationMs, ...summary },
    items,
  };
}

/** Ricalcolo incrementale: scrive solo gli item il cui servizio e' nello scope,
 * o il cui autista proposto coincide con quello di un item in scope (missione
 * potenzialmente influenzata) — mai i 'locked'. */
function expandIncrementalScope(items: PlanItemDraft[], changedServiceIds: Set<string>): PlanItemDraft[] {
  const affectedDriverIds = new Set<string>();
  for (const item of items) {
    if (changedServiceIds.has(item.service_id) && item.proposed_driver_id) affectedDriverIds.add(item.proposed_driver_id);
  }
  return items.filter((item) => {
    if (item.locked) return false;
    if (changedServiceIds.has(item.service_id)) return true;
    return Boolean(item.proposed_driver_id && affectedDriverIds.has(item.proposed_driver_id));
  });
}

function draftToRow(item: PlanItemDraft, planId: string, tenantId: string) {
  return {
    plan_id: planId,
    tenant_id: tenantId,
    service_id: item.service_id,
    status: item.status,
    proposed_driver_id: item.proposed_driver_id,
    proposed_driver_name: item.proposed_driver_name,
    proposed_vehicle_id: item.proposed_vehicle_id,
    proposed_vehicle_label: item.proposed_vehicle_label,
    mission_group_key: item.mission_group_key,
    score: item.score,
    confidence: item.confidence,
    reason: item.reason,
    alternatives: item.alternatives,
    warnings: item.warnings,
    suggested_fix: item.suggested_fix,
    locked: item.locked,
    updated_at: new Date().toISOString(),
  };
}

function rowToDraft(row: Record<string, unknown>): PlanItemDraft {
  return {
    service_id: row.service_id as string,
    status: row.status as PlanItemDraft["status"],
    proposed_driver_id: (row.proposed_driver_id as string | null) ?? null,
    proposed_driver_name: (row.proposed_driver_name as string | null) ?? null,
    proposed_vehicle_id: (row.proposed_vehicle_id as string | null) ?? null,
    proposed_vehicle_label: (row.proposed_vehicle_label as string | null) ?? null,
    mission_group_key: (row.mission_group_key as string | null) ?? null,
    score: (row.score as number | null) ?? null,
    confidence: (row.confidence as number | null) ?? null,
    reason: (row.reason as PlanItemDraft["reason"]) ?? { summary: [], details: {} },
    alternatives: (row.alternatives as PlanItemAlternative[]) ?? [],
    warnings: (row.warnings as string[]) ?? [],
    suggested_fix: row.suggested_fix ?? null,
    locked: row.locked === true,
  };
}
