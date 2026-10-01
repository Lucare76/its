/**
 * POST /api/ops/services/[id]/restore
 *
 * Ripristina una prenotazione cancellata (azione audit "restore_booking").
 * Tutta la parte critica è nella RPC atomica restore_cancelled_service
 * (migration 0286): status cancelled -> new, nessuna ricreazione di
 * assignments/autista/mezzo/allocazioni bus/navette/biglietti Medmar.
 *
 * Penale attiva sulla prenotazione: il ripristino diretto è rifiutato (409
 * active_penalty). Il client deve scegliere esplicitamente:
 *   - penalty_action="void" + void_reason  → penale 'voided' (mai cancellata),
 *     poi email di annullamento all'agenzia se la penale era stata comunicata;
 *   - penalty_action="keep" + confirm_keep_penalty=true (seconda conferma).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";
import { getOperatorName, logServiceChange, readServiceSnapshot, type ServiceSnapshot } from "@/lib/server/service-audit-log";
import { recordServiceAuditEvent, SERVICE_AUDIT_EVENT_TYPES, SERVICE_AUDIT_SOURCES } from "@/lib/server/service-audit-events";
import { PENALTY_ROLES, deliverPenaltyEmail, mapPenaltyRpcError, loadPenaltyServices, type PenaltyEmailOutcome } from "@/lib/server/cancellation-penalty";
import { loadMedmarWarnings, loadPenaltiesTouching } from "@/lib/server/cancelled-booking-state";

export const runtime = "nodejs";

const restoreSchema = z.object({
  scope: z.enum(["leg", "practice"]).optional().default("leg"),
  penalty_action: z.enum(["none", "void", "keep"]).optional().default("none"),
  void_reason: z.string().trim().max(500).optional().default(""),
  confirm_keep_penalty: z.boolean().optional().default(false),
}).superRefine((value, ctx) => {
  if (value.penalty_action === "void" && value.void_reason.length < 3) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["void_reason"], message: "Indica il motivo dell'annullamento della penale." });
  }
});

type RestoreRow = {
  out_service_id: string;
  previous_status: string;
  new_status: string;
  stale_assignments_cleared: number;
  stale_bus_allocations_cleared: number;
  voided_penalty_ids: string[] | null;
  kept_penalty_ids: string[] | null;
};

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authorizePricingRequest(request, [...PENALTY_ROLES]);
    if (auth instanceof NextResponse) return auth;

    const { id: serviceId } = await params;
    const tenantId = auth.membership.tenant_id;
    const parsed = restoreSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Richiesta non valida." }, { status: 400 });
    }
    const { scope, penalty_action, void_reason, confirm_keep_penalty } = parsed.data;
    if (penalty_action === "keep" && !confirm_keep_penalty) {
      return NextResponse.json({
        error: "Ripristinare mantenendo la penale richiede una conferma esplicita.",
        code: "keep_confirmation_required",
      }, { status: 409 });
    }

    const before = await readServiceSnapshot(auth, tenantId, serviceId);
    if (!before) return NextResponse.json({ error: "Prenotazione non trovata." }, { status: 404 });
    const linkedId = scope === "practice" && typeof before.linked_service_id === "string" ? before.linked_service_id : null;
    const linkedBefore = linkedId ? await readServiceSnapshot(auth, tenantId, linkedId) : null;
    const snapshots = new Map<string, ServiceSnapshot>([[before.id, before]]);
    if (linkedBefore) snapshots.set(linkedBefore.id, linkedBefore);

    const operatorName = await getOperatorName(auth);
    const { data, error } = await auth.admin.rpc("restore_cancelled_service", {
      p_tenant_id: tenantId,
      p_service_id: serviceId,
      p_scope: scope,
      p_penalty_action: penalty_action,
      p_void_reason: penalty_action === "void" ? void_reason : null,
      p_user_id: auth.user.id,
      p_user_name: operatorName,
    });

    if (error) {
      const mapped = mapPenaltyRpcError(error.message);
      if (mapped?.code === "active_penalty") {
        const ids = [serviceId, linkedId].filter((id): id is string => Boolean(id));
        const active = (await loadPenaltiesTouching(auth.admin, tenantId, ids)).filter((p) => p.status === "active");
        return NextResponse.json({ error: mapped.error, code: mapped.code, active_penalties: active }, { status: mapped.status });
      }
      auditLog({
        event: "service_restore_failed",
        level: "error",
        tenantId,
        userId: auth.user.id,
        role: auth.membership.role,
        serviceId,
        details: { message: error.message, scope, penalty_action },
      });
      if (mapped) return NextResponse.json({ error: mapped.error, code: mapped.code }, { status: mapped.status });
      return NextResponse.json({ error: "Ripristino non riuscito." }, { status: 500 });
    }

    const rows = (data ?? []) as RestoreRow[];
    if (rows.length === 0) {
      return NextResponse.json({ ok: true, already_active: true, restored_service_ids: [] });
    }

    const restoredIds = rows.map((row) => row.out_service_id);
    const voidedIds = Array.from(new Set(rows.flatMap((row) => row.voided_penalty_ids ?? [])));
    const keptIds = Array.from(new Set(rows.flatMap((row) => row.kept_penalty_ids ?? [])));

    // Audit leggibile (best-effort, dopo il commit della RPC — stesso pattern
    // della route di cancellazione).
    for (const row of rows) {
      const snapshot = snapshots.get(row.out_service_id) ?? await readServiceSnapshot(auth, tenantId, row.out_service_id);
      if (snapshot) {
        await logServiceChange({
          auth,
          tenantId,
          serviceId: row.out_service_id,
          rootServiceId: serviceId,
          before: snapshot,
          after: { ...snapshot, status: row.new_status },
          fields: ["status"],
          action: "RESTORED",
          operatorName,
        });
      }
      await recordServiceAuditEvent(auth.admin, {
        tenantId,
        serviceId: row.out_service_id,
        eventType: SERVICE_AUDIT_EVENT_TYPES.SERVICE_RESTORED,
        source: SERVICE_AUDIT_SOURCES.MANUAL,
        actorUserId: auth.user.id,
        actorName: operatorName,
        actorEmail: auth.user.email ?? null,
        reason: "restore_booking",
        oldData: { status: row.previous_status },
        newData: { status: row.new_status },
        metadata: {
          scope,
          penalty_action,
          voided_penalty_ids: row.voided_penalty_ids ?? [],
          kept_penalty_ids: row.kept_penalty_ids ?? [],
          stale_assignments_cleared: row.stale_assignments_cleared,
          stale_bus_allocations_cleared: row.stale_bus_allocations_cleared,
          needs_reassignment: true,
        },
      });
    }
    for (const penaltyId of voidedIds) {
      await recordServiceAuditEvent(auth.admin, {
        tenantId,
        serviceId,
        eventType: SERVICE_AUDIT_EVENT_TYPES.CANCELLATION_PENALTY_VOIDED,
        source: SERVICE_AUDIT_SOURCES.MANUAL,
        actorUserId: auth.user.id,
        actorName: operatorName,
        actorEmail: auth.user.email ?? null,
        reason: void_reason,
        newData: { penalty_id: penaltyId, status: "voided" },
      });
    }

    auditLog({
      event: "service_restored_from_cancellation",
      tenantId,
      userId: auth.user.id,
      role: auth.membership.role,
      serviceId,
      outcome: "restored",
      details: { action: "restore_booking", scope, penalty_action, service_ids: restoredIds, voided_penalty_ids: voidedIds, kept_penalty_ids: keptIds },
    });

    // Email di annullamento penale: DOPO il commit, separata. Un fallimento
    // non annulla il ripristino: resta "Reinvia email" sulla card.
    const voidEmails: Array<{ penalty_id: string } & PenaltyEmailOutcome> = [];
    for (const penaltyId of voidedIds) {
      const outcome = await deliverPenaltyEmail(auth.admin, {
        tenantId,
        penaltyId,
        channel: "void",
        mode: "auto",
        actorUserId: auth.user.id,
        actorRole: auth.membership.role,
      });
      voidEmails.push({ penalty_id: penaltyId, ...outcome });
    }

    const restoredServices = await loadPenaltyServices(auth.admin, tenantId, restoredIds);
    const medmarWarnings = await loadMedmarWarnings(auth.admin, tenantId, restoredServices);

    return NextResponse.json({
      ok: true,
      restored_service_ids: restoredIds,
      new_status: "new",
      needs_reassignment: true,
      voided_penalty_ids: voidedIds,
      kept_penalty_ids: keptIds,
      void_emails: voidEmails,
      medmar_warnings: medmarWarnings,
      stale_assignments_cleared: rows.reduce((sum, row) => sum + (row.stale_assignments_cleared ?? 0), 0),
      stale_bus_allocations_cleared: rows.reduce((sum, row) => sum + (row.stale_bus_allocations_cleared ?? 0), 0),
    });
  } catch {
    return NextResponse.json({ error: "Errore interno." }, { status: 500 });
  }
}
