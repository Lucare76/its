/**
 * POST /api/services/medmar-issue
 *
 * Orchestrazione emissione Medmar One Click. Accetta solo identificatori ITS:
 * tutti i dati Medmar/prezzi/frozen id vengono ricostruiti server-side.
 */

import { NextRequest, NextResponse } from "next/server";
import { type SupabaseClient } from "@supabase/supabase-js";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";
import { issueInputSchema } from "@/lib/server/medmar-booking/validation";
import { createMedmarIssueOrchestrator } from "@/lib/server/medmar-booking/issue-orchestrator";
import { consumeConfirmationToken, MedmarConfirmationInvalidError } from "@/lib/server/medmar-booking/issue-confirmation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = issueInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "service_ids e confirmation_token obbligatori. Non passare dati Medmar dal browser." }, { status: 400 });
  }

  const admin = auth.admin as SupabaseClient;
  const tenantId = auth.membership.tenant_id;

  // Gate di conferma server-side (Fase 2B.3): consuma atomicamente il
  // confirmation_token PRIMA di invocare l'orchestratore. Se manca, e'
  // scaduto, gia' usato o non corrisponde ai service_ids richiesti, zero
  // chiamate all'orchestratore e quindi zero mutazioni Medmar.
  try {
    await consumeConfirmationToken(admin, {
      tenantId,
      token: parsed.data.confirmation_token,
      serviceIds: parsed.data.service_ids,
    });
  } catch (err) {
    auditLog({
      event: "medmar_issue_confirmation_rejected",
      level: "warn",
      tenantId,
      userId: auth.user.id,
      role: auth.membership.role,
      outcome: err instanceof MedmarConfirmationInvalidError ? "confirmation_invalid" : "confirmation_error",
    });
    return NextResponse.json(
      { ok: false, status: "not_ready", error: "Conferma emissione non valida, scaduta o gia usata.", retry_allowed: false },
      { status: 409 }
    );
  }

  try {
    const issue = createMedmarIssueOrchestrator();
    const result = await issue({
      admin,
      tenantId,
      userId: auth.user.id,
      serviceIds: parsed.data.service_ids,
    });

    auditLog({
      event: "medmar_issue",
      level: result.ok ? "info" : result.status === "remote_state_unknown" ? "error" : "warn",
      tenantId,
      userId: auth.user.id,
      role: auth.membership.role,
      outcome: result.status,
      details: {
        service_count: parsed.data.service_ids.length,
        attempt_id: "attempt_id" in result ? result.attempt_id : undefined,
        retry_allowed: "retry_allowed" in result ? result.retry_allowed : undefined,
      },
    });

    const status = result.ok ? 200 : result.status === "already_in_progress" ? 409 : result.status === "feature_disabled" ? 403 : 422;
    return NextResponse.json(result, { status });
  } catch {
    auditLog({
      event: "medmar_issue_unhandled",
      level: "error",
      tenantId,
      userId: auth.user.id,
      role: auth.membership.role,
    });
    return NextResponse.json({ ok: false, status: "manual_review", error: "Errore interno emissione Medmar.", retry_allowed: false }, { status: 500 });
  }
}
