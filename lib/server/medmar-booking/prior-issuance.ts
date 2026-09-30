import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MEDMAR_ALREADY_ISSUED_MESSAGE,
  MEDMAR_IN_PROGRESS_MESSAGE,
  MEDMAR_ISSUANCE_PROOF_ATTEMPT_STATUS,
  MEDMAR_REQUIRES_REVIEW_MESSAGE,
  classifyMedmarAttempt,
  evaluateMedmarIssuanceRequest,
  type MedmarCompletedAttemptEvidence,
  type MedmarIssuanceDecision,
  type MedmarServiceIssuanceEvidence,
  type MedmarUncertainAttemptEvidence,
} from "@/lib/medmar-issuance-guard";

/**
 * Carica le prove di emissione Medmar già avvenuta (vedi
 * lib/medmar-issuance-guard.ts per la regola) per un insieme di servizi,
 * sempre filtrate per tenant. Sola lettura: nessuno storico viene toccato.
 * Un errore di lettura viene propagato: il chiamante deve fallire chiuso
 * (mai emettere se non si riesce a verificare).
 */
export async function loadMedmarIssuanceEvidence(
  admin: SupabaseClient,
  tenantId: string,
  serviceIds: readonly string[]
): Promise<Map<string, MedmarServiceIssuanceEvidence>> {
  const ids = Array.from(new Set(serviceIds.filter(Boolean)));
  const out = new Map<string, MedmarServiceIssuanceEvidence>();
  if (ids.length === 0) return out;

  const [servicesRes, attemptsRes] = await Promise.all([
    admin.from("services").select("id, medmar_ticket_sent_at").eq("tenant_id", tenantId).in("id", ids),
    // Tutti gli attempt che toccano questi servizi, qualunque stato: la
    // classificazione (emesso / incerto / sicuro) è nel modulo puro.
    admin
      .from("medmar_issuing_attempts")
      .select("id, service_ids, status, remote_state_unknown, medmar_numero, medmar_id_prenotazione, final_total_cents, completed_at, updated_at")
      .eq("tenant_id", tenantId)
      .overlaps("service_ids", ids),
  ]);
  if (servicesRes.error) throw new Error(`medmar_issuance_services_lookup_failed: ${servicesRes.error.message}`);
  if (attemptsRes.error) throw new Error(`medmar_issuance_attempts_lookup_failed: ${attemptsRes.error.message}`);

  const attemptRows = (attemptsRes.data ?? []) as Array<Record<string, unknown>>;
  const attempts = attemptRows.filter((row) => row.status === MEDMAR_ISSUANCE_PROOF_ATTEMPT_STATUS).map((row) => ({
    id: String(row.id),
    service_ids: Array.isArray(row.service_ids) ? row.service_ids.map(String) : [],
    medmar_numero: (row.medmar_numero as string | null) ?? null,
    medmar_id_prenotazione: (row.medmar_id_prenotazione as string | null) ?? null,
    final_total_cents: (row.final_total_cents as number | null) ?? null,
    completed_at: ((row.completed_at ?? row.updated_at) as string | null) ?? null,
  } satisfies MedmarCompletedAttemptEvidence));
  // Attempt non completati e non "sicuri": lo stato grezzo e updated_at
  // vengono conservati, la finestra "in corso / abbandonato" è valutata al
  // momento della decisione.
  const uncertain = attemptRows
    .filter((row) => row.status !== MEDMAR_ISSUANCE_PROOF_ATTEMPT_STATUS)
    .map((row) => ({
      id: String(row.id),
      status: String(row.status),
      service_ids: Array.isArray(row.service_ids) ? row.service_ids.map(String) : [],
      updated_at: (row.updated_at as string | null) ?? null,
      remote_state_unknown: row.remote_state_unknown === true,
    } satisfies MedmarUncertainAttemptEvidence))
    .filter((a) => classifyMedmarAttempt(a) !== "safe");

  for (const row of (servicesRes.data ?? []) as Array<{ id: string; medmar_ticket_sent_at: string | null }>) {
    out.set(row.id, {
      service_id: row.id,
      ticket_sent_at: row.medmar_ticket_sent_at ?? null,
      completed_attempts: attempts.filter((a) => a.service_ids.includes(row.id)),
      uncertain_attempts: uncertain.filter((a) => a.service_ids.includes(row.id)),
      cancelled_after_issuance: false,
    });
  }

  // Cancellazione DOPO l'emissione: status_events 'cancelled' (scritto da
  // cancel_service_practice e finalize_cancellation_request) successivo alla
  // prova di emissione più recente. Copre qualunque percorso di ripristino.
  const issued = Array.from(out.values()).filter((e) => e.ticket_sent_at || e.completed_attempts.length > 0);
  if (issued.length) {
    const { data: cancelEvents, error } = await admin
      .from("status_events")
      .select("service_id, at")
      .eq("tenant_id", tenantId)
      .eq("status", "cancelled")
      .in("service_id", issued.map((e) => e.service_id));
    if (error) throw new Error(`medmar_issuance_status_events_lookup_failed: ${error.message}`);
    for (const evidence of issued) {
      const issuedAt = Math.max(
        evidence.ticket_sent_at ? Date.parse(evidence.ticket_sent_at) : 0,
        ...evidence.completed_attempts.map((a) => (a.completed_at ? Date.parse(a.completed_at) : 0))
      );
      evidence.cancelled_after_issuance = ((cancelEvents ?? []) as Array<{ service_id: string; at: string }>).some(
        (ev) => ev.service_id === evidence.service_id && Date.parse(ev.at) > issuedAt
      );
    }
  }
  return out;
}

export type MedmarIssuanceGuardResult =
  | { blocked: false; decision: MedmarIssuanceDecision }
  | { blocked: true; decision: MedmarIssuanceDecision; body: Record<string, unknown> };

/** Guard server-side condiviso da preflight / prepare / issue. */
export async function checkMedmarIssuanceGuard(
  admin: SupabaseClient,
  tenantId: string,
  serviceIds: readonly string[]
): Promise<MedmarIssuanceGuardResult> {
  const evidence = await loadMedmarIssuanceEvidence(admin, tenantId, serviceIds);
  const decision = evaluateMedmarIssuanceRequest(serviceIds, evidence);
  if (!decision.blocked) return { blocked: false, decision };
  const outcome = decision.reason === "requires_review"
    ? { status: "requires_review", code: "medmar_issuance_requires_review", error: MEDMAR_REQUIRES_REVIEW_MESSAGE, retry_allowed: false }
    : decision.reason === "in_progress"
      ? { status: "issuance_in_progress", code: "medmar_issuance_in_progress", error: MEDMAR_IN_PROGRESS_MESSAGE, retry_allowed: true }
      : { status: "already_issued", code: "medmar_already_issued", error: MEDMAR_ALREADY_ISSUED_MESSAGE, retry_allowed: false };
  return {
    blocked: true,
    decision,
    body: {
      ok: false,
      ...outcome,
      blocking_service_ids: decision.blocking_service_ids,
      cancelled_after_issuance: decision.cancelled_after_issuance,
      prior_issuance: decision.blocking_service_ids.map((id) => {
        const e = evidence.get(id)!;
        return {
          service_id: id,
          ticket_sent_at: e.ticket_sent_at,
          completed_attempts: e.completed_attempts.map((a) => ({ id: a.id, medmar_numero: a.medmar_numero, completed_at: a.completed_at })),
          uncertain_attempts: (e.uncertain_attempts ?? []).map((a) => ({ id: a.id, status: a.status, updated_at: a.updated_at })),
        };
      }),
    },
  };
}
