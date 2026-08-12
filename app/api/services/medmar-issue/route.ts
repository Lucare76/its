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

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = issueInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "service_ids obbligatorio (array di UUID). Non passare dati Medmar dal browser." }, { status: 400 });
  }

  const admin = auth.admin as SupabaseClient;
  const tenantId = auth.membership.tenant_id;

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
