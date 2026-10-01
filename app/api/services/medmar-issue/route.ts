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
import { deliverMedmarTicketWithTimeout } from "@/lib/server/medmar-booking/pdf-delivery";
import { checkMedmarIssuanceGuard } from "@/lib/server/medmar-booking/prior-issuance";
import {
  MEDMAR_ISSUANCE_LOCK_BUSY_MESSAGE,
  acquireMedmarIssuanceLock,
  releaseMedmarIssuanceLock,
} from "@/lib/server/medmar-booking/issuance-lock";
import type { MedmarIssueResult } from "@/lib/server/medmar-booking/issue-types";

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

  const userId = auth.user.id;
  const role = auth.membership.role;
  const serviceIds = parsed.data.service_ids;

  // Guard "biglietto già emesso" (lib/medmar-issuance-guard.ts): prova di
  // emissione completata -> 409, nessuna chiamata Medmar. Fail-closed se lo
  // storico non è verificabile. Eseguito due volte: prima del lock (rifiuto
  // rapido) e DOPO il lock (obbligatorio: un'emissione concorrente può essersi
  // completata tra il primo controllo e l'acquisizione del lock).
  const priorIssuanceRejection = async (stage: "issue" | "issue_after_lock"): Promise<NextResponse | null> => {
    try {
      const guard = await checkMedmarIssuanceGuard(admin, tenantId, serviceIds);
      if (!guard.blocked) return null;
      auditLog({
        event: `medmar_issue_blocked_${guard.decision.reason}`,
        level: "warn",
        tenantId,
        userId,
        role,
        outcome: guard.decision.reason,
        details: { stage, blocking_service_ids: guard.decision.blocking_service_ids, cancelled_after_issuance: guard.decision.cancelled_after_issuance },
      });
      return NextResponse.json(guard.body, { status: 409 });
    } catch {
      auditLog({ event: "medmar_issue_guard_error", level: "error", tenantId, userId, role, details: { stage } });
      return NextResponse.json(
        { ok: false, status: "manual_review", code: "medmar_issuance_history_unavailable", error: "Impossibile verificare lo storico Medmar: emissione non avviata. Riprova tra poco.", retry_allowed: true },
        { status: 503 }
      );
    }
  };

  const earlyRejection = await priorIssuanceRejection("issue");
  if (earlyRejection) return earlyRejection;

  // Lock di concorrenza tenant+service_id (migration 0288), tutto-o-niente
  // sull'intero gruppo, PRIMA del consumo del token e di qualunque chiamata
  // Medmar. Vive solo qui: preflight/prepare non mutano nulla su Medmar.
  let lockToken: string;
  try {
    const lock = await acquireMedmarIssuanceLock(admin, { tenantId, serviceIds, holder: `medmar-issue:${userId}` });
    if (!lock.acquired) {
      auditLog({
        event: "medmar_issue_blocked_in_progress",
        level: "warn",
        tenantId,
        userId,
        role,
        outcome: "issuance_locked",
        details: { conflicting_service_ids: lock.conflictingServiceIds },
      });
      return NextResponse.json(
        {
          ok: false,
          status: "issuance_in_progress",
          code: "medmar_issuance_locked",
          error: MEDMAR_ISSUANCE_LOCK_BUSY_MESSAGE,
          retry_allowed: true,
          conflicting_service_ids: lock.conflictingServiceIds,
        },
        { status: 409 }
      );
    }
    lockToken = lock.lockToken;
  } catch {
    auditLog({ event: "medmar_issue_lock_error", level: "error", tenantId, userId, role });
    return NextResponse.json(
      { ok: false, status: "manual_review", code: "medmar_issuance_lock_unavailable", error: "Impossibile acquisire il blocco di emissione Medmar: emissione non avviata. Riprova tra poco.", retry_allowed: true },
      { status: 503 }
    );
  }

  let result: MedmarIssueResult;
  try {
    const lateRejection = await priorIssuanceRejection("issue_after_lock");
    if (lateRejection) return lateRejection;

    // Gate di conferma server-side (Fase 2B.3): consuma atomicamente il
    // confirmation_token PRIMA di invocare l'orchestratore. Se manca, e'
    // scaduto, gia' usato o non corrisponde ai service_ids richiesti, zero
    // chiamate all'orchestratore e quindi zero mutazioni Medmar.
    try {
      await consumeConfirmationToken(admin, {
        tenantId,
        token: parsed.data.confirmation_token,
        serviceIds,
      });
    } catch (err) {
      auditLog({
        event: "medmar_issue_confirmation_rejected",
        level: "warn",
        tenantId,
        userId,
        role,
        outcome: err instanceof MedmarConfirmationInvalidError ? "confirmation_invalid" : "confirmation_error",
      });
      return NextResponse.json(
        { ok: false, status: "not_ready", error: "Conferma emissione non valida, scaduta o gia usata.", retry_allowed: false },
        { status: 409 }
      );
    }

    try {
      const issue = createMedmarIssueOrchestrator();
      result = await issue({ admin, tenantId, userId, serviceIds });
    } catch {
      auditLog({ event: "medmar_issue_unhandled", level: "error", tenantId, userId, role });
      return NextResponse.json({ ok: false, status: "manual_review", error: "Errore interno emissione Medmar.", retry_allowed: false }, { status: 500 });
    }
  } finally {
    // Rilascio SEMPRE (completed, errore definitivo, preflight fallito,
    // eccezione, rifiuti successivi al lock). Dopo un 'completed' il guard
    // prior-issuance blocca comunque ogni nuova emissione sugli stessi servizi.
    await releaseMedmarIssuanceLock(admin, { tenantId, lockToken, userId });
  }

  auditLog({
    event: "medmar_issue",
    level: result.ok ? "info" : result.status === "remote_state_unknown" ? "error" : "warn",
    tenantId,
    userId,
    role,
    outcome: result.status,
    details: {
      service_count: serviceIds.length,
      attempt_id: "attempt_id" in result ? result.attempt_id : undefined,
      retry_allowed: "retry_allowed" in result ? result.retry_allowed : undefined,
    },
  });

  // Auto-delivery: SOLO dopo emissione "completed" riuscita, mai su un
  // esito di emissione non riuscito. Idempotente (deliverMedmarTicket
  // verifica da solo se è già stato inviato), quindi sicuro da chiamare
  // anche quando "completed" arriva dal fast-path idempotency (retry
  // dello stesso click). Un fallimento della delivery non tocca MAI la
  // risposta di emissione: `result` resta invariato, viene solo
  // arricchito con un campo `delivery` aggiuntivo. Nessuna mutazione Medmar:
  // avviene dopo il rilascio del lock.
  if (result.ok && result.status === "completed") {
    const delivery = await deliverMedmarTicketWithTimeout({
      admin,
      tenantId,
      userId,
      issuingAttemptId: result.attempt_id,
    });
    auditLog({
      event: "medmar_auto_delivery",
      level: delivery.status === "delivered" ? "info" : delivery.status === "delivery_error" ? "error" : "warn",
      tenantId,
      userId,
      role,
      outcome: delivery.status,
      details: { attempt_id: result.attempt_id, warning: delivery.warning ?? undefined },
    });
    return NextResponse.json({ ...result, delivery }, { status: 200 });
  }

  const status = result.ok ? 200 : result.status === "already_in_progress" ? 409 : result.status === "feature_disabled" ? 403 : 422;
  return NextResponse.json(result, { status });
}
