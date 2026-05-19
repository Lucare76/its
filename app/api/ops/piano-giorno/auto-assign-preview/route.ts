/**
 * Read-only preview for the next operational auto-assign flow.
 *
 * This endpoint intentionally does not create trip_groups, assignments, status
 * events, or service updates. It only resolves services into operational
 * categories and groups review reasons for operator inspection.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { listDriverRegistry } from "@/lib/server/driver-registry";
import { planAutoAssignPreview } from "@/lib/piano-auto-assign-planner";
import {
  buildAutoAssignPreview,
  type AutoAssignPreviewAssignment,
  type AutoAssignPreviewHotel,
  type AutoAssignPreviewMode,
  type AutoAssignPreviewService,
  type AutoAssignPreviewTripGroup,
} from "@/lib/piano-assignable-preview";

export const runtime = "nodejs";

const BASE_SERVICE_COLUMNS = [
  "id",
  "date",
  "time",
  "time_from",
  "time_to",
  "direction",
  "customer_name",
  "pax",
  "hotel_id",
  "vessel",
  "notes",
  "status",
  "meeting_point",
  "place_type",
  "pickup_hotel",
  "booking_service_kind",
  "service_type",
  "phone",
];

const OPTIONAL_SERVICE_COLUMNS = [
  "service_type_code",
  "transport_code",
  "orario_barca",
  "porto_bruno",
  "barca_compagnia",
  "ferry_details",
  "excursion_details",
  "tour_name",
  "pickup_time",
  "origin_place_type",
  "destination_place_type",
  "origin_place_id",
  "destination_place_id",
  "arrival_time",
  "departure_time",
];

function missingSchemaColumn(message: string) {
  return message.match(/Could not find the '([^']+)' column/)?.[1]
    ?? message.match(/column (?:public\.)?services\.([a-zA-Z0-9_]+) does not exist/)?.[1]
    ?? message.match(/column "([a-zA-Z0-9_]+)" does not exist/)?.[1]
    ?? null;
}

function normalizeMode(value: string | null | undefined): AutoAssignPreviewMode {
  return value === "unassigned_only" ? "unassigned_only" : "all";
}

async function requestParams(request: NextRequest) {
  const url = new URL(request.url);
  if (request.method === "GET") {
    return {
      date: url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10),
      mode: normalizeMode(url.searchParams.get("mode")),
    };
  }

  const body = (await request.json().catch(() => ({}))) as { date?: string; mode?: string };
  return {
    date: body.date ?? url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10),
    mode: normalizeMode(body.mode ?? url.searchParams.get("mode")),
  };
}

async function handlePreview(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const tenantId = auth.membership.tenant_id;
    const { date, mode } = await requestParams(request);

    let serviceColumns = [...BASE_SERVICE_COLUMNS, ...OPTIONAL_SERVICE_COLUMNS];
    let servicesResult: {
      data: Array<Record<string, unknown>> | null;
      error: { message: string } | null;
    } = { data: null, error: null };
    const omittedServiceColumns: string[] = [];

    for (let attempt = 0; attempt < 25; attempt += 1) {
      const result = await auth.admin
        .from("services")
        .select(serviceColumns.join(", "))
        .eq("tenant_id", tenantId)
        .eq("date", date)
        .neq("status", "cancelled")
        .neq("is_draft", true)
        .order("time")
        .limit(3000);

      servicesResult = result as typeof servicesResult;
      if (!result.error) break;

      const missingColumn = missingSchemaColumn(result.error.message);
      if (!missingColumn || !serviceColumns.includes(missingColumn)) break;
      omittedServiceColumns.push(missingColumn);
      serviceColumns = serviceColumns.filter((column) => column !== missingColumn);
    }

    if (servicesResult.error) {
      return NextResponse.json(
        { ok: false, error: `services: ${servicesResult.error.message}` },
        { status: 500 }
      );
    }

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
      auth.admin
        .from("hotels")
        .select("id, name, zone, lat, lng")
        .eq("tenant_id", tenantId),
      auth.admin
        .from("trip_groups")
        .select("id, status")
        .eq("tenant_id", tenantId)
        .eq("date", date)
        .eq("status", "active")
        .limit(3000),
      serviceIds.length > 0
        ? auth.admin
            .from("assignments")
            .select("service_id, group_id, driver_user_id, driver_profile_id, vehicle_label, locked_by_operator")
            .eq("tenant_id", tenantId)
            .in("service_id", serviceIds)
            .limit(5000)
        : Promise.resolve({ data: [] as AutoAssignPreviewAssignment[], error: null }),
      listDriverRegistry(auth.admin, tenantId, { activeOnly: true }),
      auth.admin
        .from("vehicles")
        .select("id, label, capacity, active")
        .eq("tenant_id", tenantId)
        .eq("active", true)
        .order("capacity"),
      auth.admin
        .from("driver_daily_availability")
        .select("driver_profile_id, available, available_from, available_to")
        .eq("tenant_id", tenantId)
        .eq("date", date),
      auth.admin
        .from("vehicle_daily_availability")
        .select("vehicle_id, available")
        .eq("tenant_id", tenantId)
        .eq("date", date),
      auth.admin
        .from("daily_availability_confirmations")
        .select("confirmed")
        .eq("tenant_id", tenantId)
        .eq("date", date)
        .maybeSingle(),
    ]);

    const errors = [
      hotelsResult.error ? `hotels: ${hotelsResult.error.message}` : null,
      tripGroupsResult.error ? `trip_groups: ${tripGroupsResult.error.message}` : null,
      assignmentsResult.error ? `assignments: ${assignmentsResult.error.message}` : null,
      vehiclesResult.error ? `vehicles: ${vehiclesResult.error.message}` : null,
      driverAvailabilityResult.error ? `driver_daily_availability: ${driverAvailabilityResult.error.message}` : null,
      vehicleAvailabilityResult.error ? `vehicle_daily_availability: ${vehicleAvailabilityResult.error.message}` : null,
      availabilityConfirmationResult.error ? `daily_availability_confirmations: ${availabilityConfirmationResult.error.message}` : null,
    ].filter(Boolean);
    if (errors.length > 0) {
      return NextResponse.json({ ok: false, error: errors.join("; ") }, { status: 500 });
    }

    const preview = buildAutoAssignPreview({
      date,
      mode,
      services,
      hotels: (hotelsResult.data ?? []) as AutoAssignPreviewHotel[],
      assignments: (assignmentsResult.data ?? []) as AutoAssignPreviewAssignment[],
      tripGroups: (tripGroupsResult.data ?? []) as AutoAssignPreviewTripGroup[],
    });
    const driverAvailabilityById = new Map(
      (driverAvailabilityResult.data ?? []).map((row) => [
        row.driver_profile_id as string,
        {
          available: row.available as boolean | null,
          available_from: row.available_from as string | null,
          available_to: row.available_to as string | null,
        },
      ])
    );
    const vehicleAvailabilityById = new Map(
      (vehicleAvailabilityResult.data ?? []).map((row) => [row.vehicle_id as string, row.available as boolean | null])
    );
    const driverNameByProfileId = new Map(driverRegistry.map((driver) => [driver.id, driver.full_name]));
    const driverNameByUserId = new Map(
      driverRegistry
        .filter((driver) => driver.user_id)
        .map((driver) => [driver.user_id!, driver.full_name])
    );
    const planningPreview = planAutoAssignPreview({
      services: preview.services,
      availability_confirmed: availabilityConfirmationResult.data?.confirmed === true,
      drivers: driverRegistry
        .filter((driver) => !driver.access_suspended)
        .map((driver) => {
          const availability = driverAvailabilityById.get(driver.id);
          return {
            id: driver.id,
            name: driver.full_name,
            available: availability?.available ?? true,
            available_from: availability?.available_from ?? null,
            available_to: availability?.available_to ?? null,
          };
        }),
      vehicles: ((vehiclesResult.data ?? []) as Array<{ id: string; label: string; capacity: number | null }>)
        .map((vehicle) => ({
          id: vehicle.id,
          label: vehicle.label,
          capacity: vehicle.capacity,
          available: vehicleAvailabilityById.get(vehicle.id) ?? true,
        })),
      locked_assignments: ((assignmentsResult.data ?? []) as AutoAssignPreviewAssignment[])
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
        })),
    });

    return NextResponse.json({
      ...preview,
      planning_preview: planningPreview,
      omitted_service_columns: omittedServiceColumns,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Errore preview auto-assign." },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  return handlePreview(request);
}

export async function POST(request: NextRequest) {
  return handlePreview(request);
}
