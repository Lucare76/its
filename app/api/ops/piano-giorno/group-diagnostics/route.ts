/**
 * Read-only diagnostics for real Piano del Giorno trip groups.
 *
 * This endpoint does not create assignments, trip_groups, status events, or
 * service updates. It only analyzes existing groups with the operational
 * resolver, same-stop merge, and conflict classifier.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildRealGiroDiagnostics, type RealGiroDiagnosticAssignment, type RealGiroDiagnosticTripGroup } from "@/lib/piano-real-giro-diagnostics";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { listDriverRegistry } from "@/lib/server/driver-registry";
import { loadConfirmedOperatorDecisions } from "@/lib/server/piano-operator-decisions";
import type { AutoAssignPreviewHotel, AutoAssignPreviewService } from "@/lib/piano-assignable-preview";

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

async function requestDate(request: NextRequest) {
  const url = new URL(request.url);
  if (request.method === "GET") {
    return url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
  }

  const body = (await request.json().catch(() => ({}))) as { date?: string };
  return body.date ?? url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
}

async function handleDiagnostics(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const tenantId = auth.membership.tenant_id;
    const date = await requestDate(request);
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

    const [hotelsResult, tripGroupsResult, vehiclesResult, vehicleDailyAvailabilityResult, vehicleTimeBlocksResult, driverDailyAvailabilityResult, driverRegistry, operatorDecisions] = await Promise.all([
      auth.admin
        .from("hotels")
        .select("id, name, zone, lat, lng")
        .eq("tenant_id", tenantId),
      auth.admin
        .from("trip_groups")
        .select("id, date, driver_user_id, driver_profile_id, vehicle_label, vehicle_capacity, status")
        .eq("tenant_id", tenantId)
        .eq("date", date)
        .eq("status", "active")
        .limit(3000),
      auth.admin
        .from("vehicles")
        .select("id, label, capacity, active")
        .eq("tenant_id", tenantId)
        .eq("active", true)
        .order("label"),
      auth.admin
        .from("vehicle_daily_availability")
        .select("vehicle_id, available")
        .eq("tenant_id", tenantId)
        .eq("date", date),
      auth.admin
        .from("vehicle_time_blocks")
        .select("vehicle_id, date, block_from, block_to")
        .eq("tenant_id", tenantId),
      auth.admin
        .from("driver_daily_availability")
        .select("driver_profile_id, driver_user_id, available, available_from, available_to")
        .eq("tenant_id", tenantId)
        .eq("date", date),
      listDriverRegistry(auth.admin, tenantId, { activeOnly: true }),
      loadConfirmedOperatorDecisions(auth, date),
    ]);

    const errors = [
      hotelsResult.error ? `hotels: ${hotelsResult.error.message}` : null,
      tripGroupsResult.error ? `trip_groups: ${tripGroupsResult.error.message}` : null,
      vehiclesResult.error ? `vehicles: ${vehiclesResult.error.message}` : null,
      vehicleDailyAvailabilityResult.error ? `vehicle_daily_availability: ${vehicleDailyAvailabilityResult.error.message}` : null,
      vehicleTimeBlocksResult.error ? `vehicle_time_blocks: ${vehicleTimeBlocksResult.error.message}` : null,
      driverDailyAvailabilityResult.error ? `driver_daily_availability: ${driverDailyAvailabilityResult.error.message}` : null,
    ].filter(Boolean);
    if (errors.length > 0) {
      return NextResponse.json({ ok: false, error: errors.join("; ") }, { status: 500 });
    }

    const tripGroups = (tripGroupsResult.data ?? []) as RealGiroDiagnosticTripGroup[];
    const groupIds = tripGroups.map((group) => group.id);
    const assignmentsResult = groupIds.length > 0
      ? await auth.admin
          .from("assignments")
          .select("service_id, group_id, driver_user_id, driver_profile_id, vehicle_label, locked_by_operator")
          .eq("tenant_id", tenantId)
          .in("group_id", groupIds)
          .limit(5000)
      : { data: [] as RealGiroDiagnosticAssignment[], error: null };

    if (assignmentsResult.error) {
      return NextResponse.json(
        { ok: false, error: `assignments: ${assignmentsResult.error.message}` },
        { status: 500 }
      );
    }

    const driverNamesByProfileId = new Map(driverRegistry.map((driver) => [driver.id, driver.full_name]));
    const driverNamesByUserId = new Map(
      driverRegistry
        .filter((driver) => driver.user_id)
        .map((driver) => [driver.user_id!, driver.full_name])
    );
    const vehicleAvailabilityById = new Map(
      (vehicleDailyAvailabilityResult.data ?? []).map((row) => [row.vehicle_id, row])
    );
    const blockedVehicleIds = new Set(
      (vehicleTimeBlocksResult.data ?? [])
        .filter((block) => {
          const singleDate = String(block.date ?? "").slice(0, 10);
          return singleDate === date;
        })
        .map((block) => block.vehicle_id)
    );
    const availableVehicles = ((vehiclesResult.data ?? []) as Array<{ id: string | null; label: string | null; capacity: number | null }>)
      .filter((vehicle) => {
        if (!vehicle.id) return true;
        if (blockedVehicleIds.has(vehicle.id)) return false;
        return vehicleAvailabilityById.get(vehicle.id)?.available !== false;
      });
    const driverAvailabilityByProfileId = new Map(
      (driverDailyAvailabilityResult.data ?? [])
        .filter((row) => row.driver_profile_id)
        .map((row) => [row.driver_profile_id, row])
    );
    const driverAvailabilityByUserId = new Map(
      (driverDailyAvailabilityResult.data ?? [])
        .filter((row) => row.driver_user_id)
        .map((row) => [row.driver_user_id, row])
    );

    const diagnostics = buildRealGiroDiagnostics({
      tenantId,
      date,
      services: (servicesResult.data ?? []) as AutoAssignPreviewService[],
      hotels: (hotelsResult.data ?? []) as AutoAssignPreviewHotel[],
      assignments: (assignmentsResult.data ?? []) as RealGiroDiagnosticAssignment[],
      tripGroups,
      operatorDecisions,
      driverNamesByProfileId,
      driverNamesByUserId,
      vehicles: availableVehicles,
      drivers: driverRegistry.map((driver) => ({
        driver_profile_id: driver.id,
        driver_user_id: driver.user_id ?? null,
        driver_name: driver.full_name,
        max_vehicle_capacity: driver.max_vehicle_capacity ?? null,
        availability: (() => {
          const availability = driverAvailabilityByProfileId.get(driver.id)
            ?? (driver.user_id ? driverAvailabilityByUserId.get(driver.user_id) : null);
          return availability
            ? {
                available: availability.available,
                available_from: availability.available_from,
                available_to: availability.available_to,
                blocks: [],
              }
            : null;
        })(),
      })),
    });

    return NextResponse.json({
      ...diagnostics,
      omitted_service_columns: omittedServiceColumns,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Errore diagnostica giri." },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  return handleDiagnostics(request);
}

export async function POST(request: NextRequest) {
  return handleDiagnostics(request);
}
