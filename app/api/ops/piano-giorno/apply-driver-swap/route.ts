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

export const runtime = "nodejs";

const BodySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  preview_reference: z.string().min(16),
});

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
