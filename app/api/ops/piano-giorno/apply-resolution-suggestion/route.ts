/**
 * Controlled apply entrypoint for operational conflict suggestions.
 *
 * The route recalculates diagnostics server-side and persists only operator
 * decisions for safe operator-confirmed suggestions. It never changes
 * services, assignments, trip_groups, or service status.
 */
import { NextRequest, NextResponse } from "next/server";
import type { AutoAssignPreviewHotel, AutoAssignPreviewService } from "@/lib/piano-assignable-preview";
import { buildResolutionPreview } from "@/lib/piano-conflict-resolution-preview";
import { buildRealGiroDiagnostics, type RealGiroDiagnosticAssignment, type RealGiroDiagnosticTripGroup } from "@/lib/piano-real-giro-diagnostics";
import { validateResolutionSuggestionApply } from "@/lib/piano-resolution-apply-guard";
import { listDriverRegistry } from "@/lib/server/driver-registry";
import { insertOperatorDecision, loadConfirmedOperatorDecisions, supersedeOverlappingOperatorDecisions } from "@/lib/server/piano-operator-decisions";
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

type ApplyResolutionBody = {
  date?: string;
  suggestion_id?: string;
  group_id?: string;
  action?: string;
};

type AuthorizedPricingContext = Exclude<Awaited<ReturnType<typeof authorizePricingRequest>>, NextResponse>;

function decisionTypeForAction(action: string) {
  if (action === "MULTI_DROP") return "multi_drop_confirmed";
  return "accorpamento_confirmed";
}

function firstPickupLabel(suggestion: { involved_services: Array<{ pickup_label: string | null }> }) {
  return suggestion.involved_services.find((service) => service.pickup_label)?.pickup_label ?? null;
}

async function loadDiagnostics(args: {
  date: string;
  tenantId: string;
  admin: AuthorizedPricingContext["admin"];
  auth: AuthorizedPricingContext;
}) {
  let serviceColumns = [...BASE_SERVICE_COLUMNS, ...OPTIONAL_SERVICE_COLUMNS];
  let servicesResult: {
    data: Array<Record<string, unknown>> | null;
    error: { message: string } | null;
  } = { data: null, error: null };

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const result = await args.admin
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

  if (servicesResult.error) {
    throw new Error(`services: ${servicesResult.error.message}`);
  }

  const [hotelsResult, tripGroupsResult, driverRegistry, operatorDecisions] = await Promise.all([
    args.admin
      .from("hotels")
      .select("id, name, zone, lat, lng")
      .eq("tenant_id", args.tenantId),
    args.admin
      .from("trip_groups")
      .select("id, date, driver_user_id, driver_profile_id, vehicle_label, vehicle_capacity, status")
      .eq("tenant_id", args.tenantId)
      .eq("date", args.date)
      .eq("status", "active")
      .limit(3000),
    listDriverRegistry(args.admin, args.tenantId, { activeOnly: true }),
    loadConfirmedOperatorDecisions(args.auth, args.date),
  ]);

  const errors = [
    hotelsResult.error ? `hotels: ${hotelsResult.error.message}` : null,
    tripGroupsResult.error ? `trip_groups: ${tripGroupsResult.error.message}` : null,
  ].filter(Boolean);
  if (errors.length > 0) throw new Error(errors.join("; "));

  const tripGroups = (tripGroupsResult.data ?? []) as RealGiroDiagnosticTripGroup[];
  const groupIds = tripGroups.map((group) => group.id);
  const assignmentsResult = groupIds.length > 0
    ? await args.admin
        .from("assignments")
        .select("service_id, group_id, driver_user_id, driver_profile_id, vehicle_label, locked_by_operator")
        .eq("tenant_id", args.tenantId)
        .in("group_id", groupIds)
        .limit(5000)
    : { data: [] as RealGiroDiagnosticAssignment[], error: null };

  if (assignmentsResult.error) {
    throw new Error(`assignments: ${assignmentsResult.error.message}`);
  }

  const driverNamesByProfileId = new Map(driverRegistry.map((driver) => [driver.id, driver.full_name]));
  const driverNamesByUserId = new Map(
    driverRegistry
      .filter((driver) => driver.user_id)
      .map((driver) => [driver.user_id!, driver.full_name])
  );
  const assignments = (assignmentsResult.data ?? []) as RealGiroDiagnosticAssignment[];
  const diagnostics = buildRealGiroDiagnostics({
    tenantId: args.tenantId,
    date: args.date,
    services: (servicesResult.data ?? []) as AutoAssignPreviewService[],
    hotels: (hotelsResult.data ?? []) as AutoAssignPreviewHotel[],
    assignments,
    tripGroups,
    operatorDecisions,
    driverNamesByProfileId,
    driverNamesByUserId,
  });

  return { diagnostics, assignments };
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const body = (await request.json().catch(() => ({}))) as ApplyResolutionBody;
    const date = body.date;
    const suggestionId = body.suggestion_id;
    const groupId = body.group_id;
    const action = body.action;

    if (!date || !suggestionId || !groupId || !action) {
      return NextResponse.json(
        { ok: false, error: "date, suggestion_id, group_id e action sono obbligatori." },
        { status: 400 }
      );
    }

    const { diagnostics, assignments } = await loadDiagnostics({
      date,
      tenantId: auth.membership.tenant_id,
      admin: auth.admin,
      auth,
    });
    const lockedServiceIds = new Set(
      assignments
        .filter((assignment) => assignment.locked_by_operator === true)
        .map((assignment) => assignment.service_id)
    );
    const decision = validateResolutionSuggestionApply({
      suggestions: diagnostics.resolution_suggestions,
      suggestion_id: suggestionId,
      group_id: groupId,
      action,
      locked_service_ids: lockedServiceIds,
    });

    if (!decision.ok) {
      const status = decision.apply_status === "stale" ? 409 : 422;
      return NextResponse.json(
        {
          ok: false,
          apply_status: decision.apply_status,
          error: decision.message,
          diagnostics,
        },
        { status }
      );
    }

    const preview = buildResolutionPreview(decision.suggestion);
    const serviceIds = decision.suggestion.involved_services.map((service) => service.service_id);
    const decisionType = decisionTypeForAction(decision.suggestion.recommended_action);
    const isMultiDrop = decision.suggestion.recommended_action === "MULTI_DROP";
    const saved = await insertOperatorDecision(auth, {
      service_date: date,
      trip_group_id: decision.suggestion.group_id,
      decision_type: decisionType,
      action: decision.suggestion.recommended_action,
      service_ids: serviceIds,
      payload_json: {
        decision_type: decisionType,
        suggestion: decision.suggestion,
        preview: {
          simulated_status: preview.simulated_status,
          residual_conflicts: preview.residual_conflicts,
          residual_warnings: preview.residual_warnings,
          total_pax: preview.total_pax,
          final_stops: preview.final_stops,
        },
        ...(isMultiDrop ? {
          multi_drop: {
            pickup_label: firstPickupLabel(decision.suggestion),
            suggested_order: decision.suggestion.suggested_order,
            services: decision.suggestion.involved_services,
            total_pax: preview.total_pax,
            accepted_warnings: preview.warnings,
            operator_confirmation_required: decision.suggestion.operator_confirmation_required,
          },
        } : {}),
      },
      before_json: preview.before,
      after_json: preview.after,
    });
    const superseded = await supersedeOverlappingOperatorDecisions(auth, {
      service_date: date,
      trip_group_id: decision.suggestion.group_id,
      decision_type: decisionType,
      action: decision.suggestion.recommended_action,
      service_ids: serviceIds,
      payload_json: {
        decision_type: decisionType,
        suggestion: decision.suggestion,
        preview: {
          simulated_status: preview.simulated_status,
          residual_conflicts: preview.residual_conflicts,
          residual_warnings: preview.residual_warnings,
          total_pax: preview.total_pax,
          final_stops: preview.final_stops,
        },
        ...(isMultiDrop ? {
          multi_drop: {
            pickup_label: firstPickupLabel(decision.suggestion),
            suggested_order: decision.suggestion.suggested_order,
            services: decision.suggestion.involved_services,
            total_pax: preview.total_pax,
            accepted_warnings: preview.warnings,
            operator_confirmation_required: decision.suggestion.operator_confirmation_required,
          },
        } : {}),
      },
      before_json: preview.before,
      after_json: preview.after,
      new_decision_id: saved.decision.id,
      suggestion_hash: saved.decision.suggestion_hash,
    });

    const refreshed = await loadDiagnostics({
      date,
      tenantId: auth.membership.tenant_id,
      admin: auth.admin,
      auth,
    });

    return NextResponse.json({
      ok: true,
      apply_status: saved.duplicate ? "already_confirmed" : "confirmed",
      message: saved.duplicate ? "Decisione gia salvata." : "Decisione salvata.",
      decision: saved.decision,
      superseded_decisions: superseded,
      diagnostics: refreshed.diagnostics,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Errore applicazione suggerimento." },
      { status: 500 }
    );
  }
}
