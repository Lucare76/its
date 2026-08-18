/**
 * Controlled apply for hybrid vehicle binding.
 *
 * The client sends only date + preview reference. The binding is recalculated
 * server-side and only trip_groups vehicle fields are updated.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import {
  HYBRID_BINDING_ACTION,
  HYBRID_BINDING_DECISION_TYPE,
  buildVehicleBindingPreview,
  validateVehicleBindingPreviewForApply,
} from "@/lib/server/piano-vehicle-binding-preview";
import { insertOperatorDecision } from "@/lib/server/piano-operator-decisions";
import { extractFeatures, logAssignmentChange, buildAssignmentDecisionFeatures } from "@/lib/server/assignment-history";
import { updateLearnedPatterns } from "@/lib/server/learned-patterns";

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

    const preview = await buildVehicleBindingPreview({
      admin: auth.admin,
      tenantId: auth.membership.tenant_id,
      date: body.data.date,
    });

    if (preview.preview_reference !== body.data.preview_reference) {
      if (preview.changes.length === 0 && preview.summary.conflicts_after === 0 && preview.summary.overbooking_after === 0) {
        return NextResponse.json({
          ok: true,
          applied: 0,
          idempotent: true,
          message: "Riallineamento mezzi gia coerente; nessuna modifica applicata.",
          preview,
        });
      }
      return NextResponse.json(
        { ok: false, error: "Preview non aggiornata. Ricalcola prima di applicare.", current_preview_reference: preview.preview_reference },
        { status: 409 }
      );
    }

    const validation = validateVehicleBindingPreviewForApply(preview);
    if (!validation.ok) {
      return NextResponse.json({ ok: false, error: validation.blockers.join(" "), blockers: validation.blockers, preview }, { status: 409 });
    }

    if (preview.changes.length === 0) {
      return NextResponse.json({ ok: true, applied: 0, message: "Nessun cambio mezzo necessario.", preview });
    }

    const before = preview.changes.map((change) => ({
      group_id: change.group_id,
      vehicle_label: change.current_vehicle_label,
      vehicle_capacity: change.current_vehicle_capacity,
      updated_at: change.current_group_updated_at,
    }));
    const after = preview.changes.map((change) => ({
      group_id: change.group_id,
      vehicle_id: change.proposed_vehicle_id,
      vehicle_label: change.proposed_vehicle_label,
      vehicle_capacity: change.proposed_vehicle_capacity,
    }));

    let decision: Awaited<ReturnType<typeof insertOperatorDecision>>;
    try {
      decision = await insertOperatorDecision(auth, {
        service_date: body.data.date,
        trip_group_id: null,
        decision_type: HYBRID_BINDING_DECISION_TYPE,
        action: HYBRID_BINDING_ACTION,
        service_ids: [...new Set(preview.changes.flatMap((change) => change.service_ids))].sort(),
        before_json: before,
        after_json: after,
        payload_json: {
          preview_reference: preview.preview_reference,
          summary: preview.summary,
          changes: preview.changes,
          large_vehicle_usage: preview.large_vehicle_usage,
          warnings: preview.warnings,
          info: preview.info,
        },
      });
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: err instanceof Error ? err.message : "Audit decisione operatore non salvato." },
        { status: 500 }
      );
    }

    const updatedGroups: Array<{ id: string; vehicle_label: string | null; vehicle_capacity: number | null }> = [];
    for (const change of preview.changes) {
      let updateQuery = auth.admin
        .from("trip_groups")
        .update({
          vehicle_label: change.proposed_vehicle_label,
          vehicle_capacity: change.proposed_vehicle_capacity,
          updated_at: new Date().toISOString(),
        })
        .eq("tenant_id", auth.membership.tenant_id)
        .eq("id", change.group_id);

      if (change.current_group_updated_at) {
        updateQuery = updateQuery.eq("updated_at", change.current_group_updated_at);
      }

      const { data, error } = await updateQuery
        .select("id, vehicle_label, vehicle_capacity")
        .maybeSingle();

      if (error || !data?.id) {
        return NextResponse.json(
          {
            ok: false,
            error: error
              ? `Aggiornamento trip_group ${change.group_id}: ${error.message}`
              : `Preview stale: trip_group ${change.group_id} cambiato durante l'applicazione.`,
            applied: updatedGroups.length,
          },
          { status: error ? 500 : 409 }
        );
      }
      updatedGroups.push(data as { id: string; vehicle_label: string | null; vehicle_capacity: number | null });
    }

    const historyEntries = preview.changes.flatMap((change) =>
      change.service_ids.map((serviceId) => {
        const baseFeatures = extractFeatures({
          serviceDate: body.data.date,
          changeType: "vehicle_binding",
          fromVehicleLabel: change.current_vehicle_label,
          toVehicleLabel: change.proposed_vehicle_label,
        });
        const features = buildAssignmentDecisionFeatures(baseFeatures, {
          source: "vehicle_binding",
          proposal_id: null,
          chosen_rank: null,
          was_override: change.current_vehicle_label != null,
        });
        return {
          tenantId: auth.membership.tenant_id,
          serviceDate: body.data.date,
          serviceId,
          groupId: change.group_id,
          changeType: "vehicle_binding" as const,
          fromVehicleLabel: change.current_vehicle_label,
          toVehicleLabel: change.proposed_vehicle_label,
          features,
          operatorId: auth.user.id,
        };
      })
    );
    void logAssignmentChange(auth.admin, historyEntries)
      .then(() => updateLearnedPatterns(auth.admin, auth.membership.tenant_id))
      .catch(() => undefined);

    return NextResponse.json({
      ok: true,
      applied: updatedGroups.length,
      updated_groups: updatedGroups,
      audit_saved: true,
      decision: {
        id: decision.decision.id,
        duplicate: decision.duplicate,
        suggestion_hash: decision.decision.suggestion_hash,
      },
      before,
      after,
      preview_reference: preview.preview_reference,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Applicazione riallineamento mezzi non riuscita." },
      { status: 500 }
    );
  }
}
