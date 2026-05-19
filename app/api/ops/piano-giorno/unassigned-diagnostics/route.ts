/**
 * Read-only diagnostics for services that do not have real trip groups yet.
 *
 * This endpoint never creates assignments, trip_groups, status events, or
 * service updates. It only resolves services, merges same-stop candidates, and
 * highlights pre-assignment operational patterns.
 */
import { NextRequest, NextResponse } from "next/server";
import type { AutoAssignPreviewHotel, AutoAssignPreviewService } from "@/lib/piano-assignable-preview";
import { buildUnassignedServicesDiagnostics } from "@/lib/piano-unassigned-services-diagnostics";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

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

async function handleDiagnostics(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const url = new URL(request.url);
    const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
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
        .eq("tenant_id", auth.membership.tenant_id)
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

    const hotelsResult = await auth.admin
      .from("hotels")
      .select("id, name, zone, lat, lng")
      .eq("tenant_id", auth.membership.tenant_id);

    if (hotelsResult.error) {
      return NextResponse.json({ ok: false, error: `hotels: ${hotelsResult.error.message}` }, { status: 500 });
    }

    const diagnostics = buildUnassignedServicesDiagnostics({
      date,
      services: (servicesResult.data ?? []) as AutoAssignPreviewService[],
      hotels: (hotelsResult.data ?? []) as AutoAssignPreviewHotel[],
    });

    return NextResponse.json({
      ...diagnostics,
      omitted_service_columns: omittedServiceColumns,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Errore diagnostica servizi non assegnati." },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  return handleDiagnostics(request);
}
