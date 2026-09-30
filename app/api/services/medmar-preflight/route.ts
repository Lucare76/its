/**
 * POST /api/services/medmar-preflight
 *
 * Preflight Medmar One Click — Fase 1. SOLO lettura: verifica tratta, data,
 * corsa, orario, pax, tariffa e importo atteso senza mai creare una
 * prenotazione, congelare posti o produrre un movimento economico.
 *
 * Body: { service_ids: string[] }
 */

import { NextRequest, NextResponse } from "next/server";
import { type SupabaseClient } from "@supabase/supabase-js";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";
import { preflightInputSchema } from "@/lib/server/medmar-booking/validation";
import { runMedmarPreflight } from "@/lib/server/medmar-booking/preflight";
import { checkMedmarIssuanceGuard } from "@/lib/server/medmar-booking/prior-issuance";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const admin = auth.admin as SupabaseClient;
  const tenantId = auth.membership.tenant_id;

  const parsed = preflightInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "service_ids obbligatorio (array di UUID, max 20)." }, { status: 400 });
  }

  // Guard "biglietto già emesso" (lib/medmar-issuance-guard.ts): prova di
  // emissione completata -> 409, nessuna chiamata Medmar. Fail-closed se lo
  // storico non è verificabile.
  try {
    const guard = await checkMedmarIssuanceGuard(admin, tenantId, parsed.data.service_ids);
    if (guard.blocked) {
      auditLog({
        event: `medmar_issue_blocked_${guard.decision.reason}`,
        level: "warn",
        tenantId,
        userId: auth.user.id,
        role: auth.membership.role,
        outcome: guard.decision.reason,
        details: { stage: "preflight", blocking_service_ids: guard.decision.blocking_service_ids, cancelled_after_issuance: guard.decision.cancelled_after_issuance },
      });
      return NextResponse.json(guard.body, { status: 409 });
    }
  } catch {
    auditLog({ event: "medmar_issue_guard_error", level: "error", tenantId, userId: auth.user.id, role: auth.membership.role, details: { stage: "preflight" } });
    return NextResponse.json(
      { ok: false, status: "manual_review", code: "medmar_issuance_history_unavailable", error: "Impossibile verificare lo storico Medmar: emissione non avviata. Riprova tra poco.", retry_allowed: true },
      { status: 503 }
    );
  }

  try {
    const result = await runMedmarPreflight(admin, tenantId, parsed.data.service_ids);

    auditLog({
      event: "medmar_preflight",
      level: result.ok ? "info" : "warn",
      tenantId,
      userId: auth.user.id,
      role: auth.membership.role,
      outcome: result.status,
      details: { service_count: parsed.data.service_ids.length, can_issue: result.can_issue },
    });

    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch {
    auditLog({
      event: "medmar_preflight_error",
      level: "error",
      tenantId,
      userId: auth.user.id,
      role: auth.membership.role,
    });
    return NextResponse.json({ ok: false, error: "Errore interno durante il preflight Medmar." }, { status: 500 });
  }
}
