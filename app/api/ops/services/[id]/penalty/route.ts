/**
 * POST /api/ops/services/[id]/penalty
 *
 * Registra (o modifica) la penale di cancellazione di una prenotazione
 * cancellata. Due passi logicamente separati:
 *   1. salvataggio atomico e idempotente (RPC apply_cancellation_penalty,
 *      migration 0286) — una modifica crea una nuova versione e marca le
 *      precedenti 'superseded', mai un update in place;
 *   2. invio email all'agenzia (deliverPenaltyEmail) — un fallimento NON
 *      annulla la penale: resta "Penale registrata, email non inviata" con
 *      "Reinvia email".
 *
 * Primo rilascio: solo "Nessuna penale" e "Importo fisso". La percentuale è
 * supportata dal DB ma rifiutata qui finché la base di calcolo non è certa.
 * Non tocca mai services.agency_quoted_price_cents.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";
import { getOperatorName } from "@/lib/server/service-audit-log";
import { recordServiceAuditEvent, SERVICE_AUDIT_EVENT_TYPES, SERVICE_AUDIT_SOURCES } from "@/lib/server/service-audit-events";
import { PENALTY_ROLES, PENALTY_SELECT, deliverPenaltyEmail, mapPenaltyRpcError, type PenaltyEmailOutcome, type PenaltyRow } from "@/lib/server/cancellation-penalty";

export const runtime = "nodejs";

const penaltySchema = z.object({
  scope: z.enum(["leg", "practice"]),
  penalty_type: z.enum(["none", "fixed", "percentage"]),
  amount_cents: z.number().int().min(0).max(9_999_900).optional().default(0),
  notes: z.string().trim().max(1000).optional().default(""),
  idempotency_key: z.string().trim().min(8).max(120),
  expected_active_ids: z.array(z.string().uuid()).max(10).optional().default([]),
  confirm_rectification: z.boolean().optional().default(false),
}).superRefine((value, ctx) => {
  if (value.penalty_type === "percentage") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["penalty_type"],
      message: "La penale in percentuale non è ancora abilitata: usa un importo fisso.",
    });
  }
  if (value.penalty_type === "fixed" && value.amount_cents <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["amount_cents"], message: "Inserisci un importo penale maggiore di zero." });
  }
});

type ApplyRow = {
  penalty_id: string;
  replayed: boolean;
  out_email_kind: "initial" | "rectification";
  out_email_status: string;
  superseded_ids: string[] | null;
  previous_communicated: boolean;
};

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authorizePricingRequest(request, [...PENALTY_ROLES]);
    if (auth instanceof NextResponse) return auth;

    const { id: serviceId } = await params;
    const tenantId = auth.membership.tenant_id;
    const parsed = penaltySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati penale non validi." }, { status: 400 });
    }
    const body = parsed.data;
    const operatorName = await getOperatorName(auth);

    const { data, error } = await auth.admin.rpc("apply_cancellation_penalty", {
      p_tenant_id: tenantId,
      p_service_id: serviceId,
      p_scope: body.scope,
      p_penalty_type: body.penalty_type,
      p_amount_cents: body.penalty_type === "none" ? 0 : body.amount_cents,
      p_percentage: null,
      p_base_amount_cents: null,
      p_base_amount_source: null,
      p_notes: body.notes || null,
      p_idempotency_key: body.idempotency_key,
      p_expected_active_ids: body.expected_active_ids,
      p_confirm_rectification: body.confirm_rectification,
      p_user_id: auth.user.id,
      p_user_name: operatorName,
      p_user_role: auth.membership.role,
    });

    let row: ApplyRow | null = ((data ?? []) as ApplyRow[])[0] ?? null;

    if (error) {
      // Corsa estrema sulla stessa idempotency_key: il vincolo unique ha
      // fermato il secondo insert -> è un replay della stessa richiesta.
      if (error.code === "23505" && error.message.includes("idempotency")) {
        const { data: existing } = await auth.admin
          .from("service_cancellation_penalties")
          .select(PENALTY_SELECT)
          .eq("tenant_id", tenantId)
          .eq("idempotency_key", body.idempotency_key)
          .maybeSingle();
        const existingRow = existing as unknown as PenaltyRow | null;
        if (existingRow) {
          row = {
            penalty_id: existingRow.id,
            replayed: true,
            out_email_kind: existingRow.email_kind,
            out_email_status: existingRow.email_status,
            superseded_ids: existingRow.supersedes_ids,
            previous_communicated: existingRow.email_kind === "rectification",
          };
        }
      }
      if (!row) {
        const mapped = mapPenaltyRpcError(error.message);
        auditLog({
          event: "cancellation_penalty_save_failed",
          level: mapped ? "warn" : "error",
          tenantId,
          userId: auth.user.id,
          role: auth.membership.role,
          serviceId,
          details: { message: error.message, scope: body.scope, penalty_type: body.penalty_type },
        });
        if (mapped) return NextResponse.json({ error: mapped.error, code: mapped.code }, { status: mapped.status });
        return NextResponse.json({ error: "Salvataggio penale non riuscito." }, { status: 500 });
      }
    }

    if (!row) return NextResponse.json({ error: "Salvataggio penale non riuscito." }, { status: 500 });

    if (!row.replayed) {
      const modified = (row.superseded_ids ?? []).length > 0;
      await recordServiceAuditEvent(auth.admin, {
        tenantId,
        serviceId,
        eventType: modified ? SERVICE_AUDIT_EVENT_TYPES.CANCELLATION_PENALTY_MODIFIED : SERVICE_AUDIT_EVENT_TYPES.CANCELLATION_PENALTY_APPLIED,
        source: SERVICE_AUDIT_SOURCES.MANUAL,
        actorUserId: auth.user.id,
        actorName: operatorName,
        actorEmail: auth.user.email ?? null,
        reason: body.notes || null,
        oldData: modified ? { superseded_penalty_ids: row.superseded_ids, previous_communicated: row.previous_communicated } : null,
        newData: {
          penalty_id: row.penalty_id,
          scope: body.scope,
          penalty_type: body.penalty_type,
          penalty_amount_cents: body.penalty_type === "none" ? 0 : body.amount_cents,
          email_kind: row.out_email_kind,
        },
      });
    }

    // Passo 2: email. Il claim su 'pending' garantisce che un doppio click o
    // un replay non producano una seconda email.
    let email: PenaltyEmailOutcome | { status: string; claimed: false } = { status: row.out_email_status, claimed: false };
    if (row.out_email_status === "pending") {
      email = await deliverPenaltyEmail(auth.admin, {
        tenantId,
        penaltyId: row.penalty_id,
        channel: "penalty",
        mode: "auto",
        actorUserId: auth.user.id,
        actorRole: auth.membership.role,
      });
    } else if (row.replayed) {
      const { data: current } = await auth.admin
        .from("service_cancellation_penalties")
        .select(PENALTY_SELECT)
        .eq("tenant_id", tenantId)
        .eq("id", row.penalty_id)
        .maybeSingle();
      const currentRow = current as unknown as PenaltyRow | null;
      if (currentRow) {
        email = {
          status: currentRow.email_status,
          recipient: currentRow.email_recipient,
          sent_at: currentRow.email_sent_at,
          error: currentRow.email_last_error,
          claimed: false,
        };
      }
    }

    return NextResponse.json({
      ok: true,
      penalty_id: row.penalty_id,
      replayed: row.replayed,
      email_kind: row.out_email_kind,
      superseded_ids: row.superseded_ids ?? [],
      email,
    });
  } catch {
    return NextResponse.json({ error: "Errore interno." }, { status: 500 });
  }
}
