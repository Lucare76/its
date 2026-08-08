/**
 * Controlled apply for the single GPR PETER driver swap.
 *
 * The client sends only date + preview_reference. The preview is recalculated
 * server-side and only the target trip_group plus its assignments are updated.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  buildGprPeterDriverSwapPreview,
  GPR_PETER_DRIVER_SWAP_ACTION,
  GPR_PETER_DRIVER_SWAP_DECISION_TYPE,
  GPR_PETER_GROUP_ID,
  validateGprPeterDriverSwapPreviewForApply,
} from "@/lib/server/piano-driver-swap-preview";
import { insertOperatorDecision, loadConfirmedOperatorDecisions } from "@/lib/server/piano-operator-decisions";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { extractFeatures, logAssignmentChange } from "@/lib/server/assignment-history";
import { updateLearnedPatterns } from "@/lib/server/learned-patterns";
import { effectiveServiceDisembarkTime } from "@/lib/piano-arrival-time";

export const runtime = "nodejs";

const BodySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  preview_reference: z.string().min(16),
});

const SERVICE_FEATURE_COLUMNS = "id, time, pickup_hotel, direction, pax, hotel_id, meeting_point, arrival_time, orario_barca, porto_bruno, barca_compagnia, booking_service_kind, service_type_code, vessel, ferry_details";

type ServiceFeatureRow = {
  id: string;
  time: string;
  pickup_hotel: string | null;
  direction: "arrival" | "departure";
  pax: number;
  hotel_id: string | null;
  meeting_point: string | null;
  arrival_time: string | null;
  orario_barca: string | null;
  porto_bruno: string | null;
  barca_compagnia: string | null;
  booking_service_kind: string | null;
  service_type_code: string | null;
  vessel: string | null;
  ferry_details: Record<string, unknown> | null;
};

type HotelFeatureRow = {
  id: string;
  zone: string | null;
};

function serviceOperationalTime(service: ServiceFeatureRow): string {
  return service.direction === "departure"
    ? (service.pickup_hotel ?? service.time).slice(0, 5)
    : effectiveServiceDisembarkTime(service) ?? service.time.slice(0, 5);
}

function isNavettaService(service: Pick<ServiceFeatureRow, "booking_service_kind" | "service_type_code">): boolean {
  const kind = service.booking_service_kind ?? service.service_type_code ?? "";
  return kind === "navetta" || kind === "shuttle_hotel" || kind === "bus_city_hotel";
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const body = BodySchema.safeParse(await request.json().catch(() => ({})));
    if (!body.success) {
      return NextResponse.json({ ok: false, error: "Payload non valido." }, { status: 400 });
    }

    const preview = await buildGprPeterDriverSwapPreview({
      admin: auth.admin,
      tenantId: auth.membership.tenant_id,
      date: body.data.date,
    });

    if (preview.already_applied) {
      const decisions = await loadConfirmedOperatorDecisions(auth, body.data.date);
      const decision = decisions.find((row) =>
        row.action === GPR_PETER_DRIVER_SWAP_ACTION
        && row.trip_group_id === GPR_PETER_GROUP_ID
      );
      return NextResponse.json({
        ok: true,
        applied: 0,
        idempotent: true,
        status: "already_applied",
        audit_saved: Boolean(decision),
        decision: decision
          ? { id: decision.id, suggestion_hash: decision.suggestion_hash }
          : null,
        preview,
      });
    }

    if (preview.preview_reference !== body.data.preview_reference) {
      return NextResponse.json(
        {
          ok: false,
          error: "Preview non aggiornata. Ricalcola prima di applicare.",
          current_preview_reference: preview.preview_reference,
          preview,
        },
        { status: 409 }
      );
    }

    const validation = validateGprPeterDriverSwapPreviewForApply(preview);
    if (!validation.ok) {
      return NextResponse.json(
        { ok: false, error: validation.blockers.join(" "), blockers: validation.blockers, preview },
        { status: 409 }
      );
    }

    const now = new Date().toISOString();
    let groupUpdate = auth.admin
      .from("trip_groups")
      .update({
        driver_user_id: preview.proposed.driver_user_id,
        driver_profile_id: preview.proposed.driver_profile_id,
        vehicle_label: preview.proposed.vehicle_label,
        vehicle_capacity: preview.proposed.vehicle_capacity,
        updated_at: now,
      })
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("id", preview.trip_group_id)
      .eq("driver_profile_id", preview.current.driver_profile_id)
      .eq("date", body.data.date)
      .eq("status", "active");

    if (preview.current.updated_at) {
      groupUpdate = groupUpdate.eq("updated_at", preview.current.updated_at);
    }

    const { data: updatedGroup, error: groupError } = await groupUpdate
      .select("id, driver_user_id, driver_profile_id, vehicle_label, vehicle_capacity, updated_at")
      .maybeSingle();

    if (groupError || !updatedGroup?.id) {
      return NextResponse.json(
        {
          ok: false,
          error: groupError
            ? `Aggiornamento trip_group ${preview.trip_group_id}: ${groupError.message}`
            : `Preview stale: trip_group ${preview.trip_group_id} cambiato durante l'applicazione.`,
        },
        { status: groupError ? 500 : 409 }
      );
    }

    const { data: updatedAssignments, error: assignmentError } = await auth.admin
      .from("assignments")
      .update({
        driver_user_id: preview.proposed.driver_user_id,
        driver_profile_id: preview.proposed.driver_profile_id,
        vehicle_label: preview.proposed.vehicle_label,
        assignment_source: "manual_piano_giorno",
        locked_by_operator: true,
        assigned_by: auth.user.id,
        assigned_at: now,
        lock_reason: "manual_assignment_from_daily_plan",
      })
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("group_id", preview.trip_group_id)
      .select("id, service_id, driver_user_id, driver_profile_id, vehicle_label");

    if (assignmentError) {
      return NextResponse.json(
        {
          ok: false,
          error: `Aggiornamento assignments ${preview.trip_group_id}: ${assignmentError.message}`,
          updated_group: updatedGroup,
        },
        { status: 500 }
      );
    }

    let decision: Awaited<ReturnType<typeof insertOperatorDecision>>;
    try {
      decision = await insertOperatorDecision(auth, {
        service_date: body.data.date,
        trip_group_id: preview.trip_group_id,
        decision_type: GPR_PETER_DRIVER_SWAP_DECISION_TYPE,
        action: GPR_PETER_DRIVER_SWAP_ACTION,
        service_ids: preview.trip.service_ids,
        before_json: preview.before_json,
        after_json: preview.after_json,
        payload_json: preview.payload_json,
      });
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : "Audit decisione operatore non salvato.",
          updated_group: updatedGroup,
          updated_assignments: updatedAssignments ?? [],
        },
        { status: 500 }
      );
    }

    const { data: featureServices } = preview.trip.service_ids.length > 0
      ? await auth.admin
          .from("services")
          .select(SERVICE_FEATURE_COLUMNS)
          .eq("tenant_id", auth.membership.tenant_id)
          .in("id", preview.trip.service_ids)
      : { data: [] };
    const featureServiceRows = (featureServices ?? []) as ServiceFeatureRow[];
    const featureHotelIds = Array.from(new Set(featureServiceRows.map((service) => service.hotel_id).filter((id): id is string => Boolean(id))));
    const { data: featureHotels } = featureHotelIds.length > 0
      ? await auth.admin
          .from("hotels")
          .select("id, zone")
          .eq("tenant_id", auth.membership.tenant_id)
          .in("id", featureHotelIds)
      : { data: [] };
    const featureServiceMap = new Map(featureServiceRows.map((service) => [service.id, service]));
    const featureHotelMap = new Map((featureHotels ?? []).map((hotel) => [hotel.id as string, hotel as HotelFeatureRow]));

    void logAssignmentChange(auth.admin, preview.trip.service_ids.map((serviceId) => ({
      tenantId: auth.membership.tenant_id,
      serviceDate: body.data.date,
      serviceId,
      groupId: preview.trip_group_id,
      changeType: "driver_swap",
      fromDriverProfileId: preview.current.driver_profile_id,
      toDriverProfileId: preview.proposed.driver_profile_id,
      fromVehicleLabel: preview.current.vehicle_label,
      toVehicleLabel: preview.proposed.vehicle_label,
      features: (() => {
        const service = featureServiceMap.get(serviceId);
        const hotel = service?.hotel_id ? featureHotelMap.get(service.hotel_id) : null;
        return extractFeatures({
          serviceDate: body.data.date,
          changeType: "driver_swap",
          fromDriverProfileId: preview.current.driver_profile_id,
          toDriverProfileId: preview.proposed.driver_profile_id,
          fromVehicleLabel: preview.current.vehicle_label,
          toVehicleLabel: preview.proposed.vehicle_label,
          direction: service?.direction ?? null,
          zone: hotel?.zone ?? service?.meeting_point ?? null,
          time: service ? serviceOperationalTime(service) : null,
          vessel: service?.vessel ?? service?.barca_compagnia ?? null,
          pax: service?.pax ?? null,
          isNavetta: service ? isNavettaService(service) : false,
        });
      })(),
      operatorId: auth.user.id,
    })))
      .then(() => updateLearnedPatterns(auth.admin, auth.membership.tenant_id))
      .catch(() => undefined);

    return NextResponse.json({
      ok: true,
      applied: 1,
      updated_group: updatedGroup,
      updated_assignments: updatedAssignments ?? [],
      audit_saved: true,
      decision: {
        id: decision.decision.id,
        duplicate: decision.duplicate,
        suggestion_hash: decision.decision.suggestion_hash,
      },
      before: preview.before_json,
      after: preview.after_json,
      preview_reference: preview.preview_reference,
      warnings: preview.warnings,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Applicazione driver swap non riuscita." },
      { status: 500 }
    );
  }
}
