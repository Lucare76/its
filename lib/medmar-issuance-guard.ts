/**
 * Regola unica "emissione Medmar già avvenuta / incerta" — modulo puro
 * (nessun I/O, nessun React), usato sia dalle route server-side di emissione
 * (preflight / prepare / issue) sia dalla coda /biglietti-medmar, così UI e
 * server applicano esattamente la stessa decisione.
 *
 * Tre protezioni complementari, separate:
 *   - idempotenza (orchestratore): stesso gruppo -> stesso attempt;
 *   - lock di concorrenza (0288): richiesta concorrente LIVE;
 *   - QUESTA regola: storico degli attempt, protegge anche DOPO un crash.
 *
 * Confine "prima/dopo la prima mutazione remota" (issue-orchestrator.ts):
 * ogni transizione di stato viene persistita PRIMA della chiamata Medmar
 * corrispondente. `lock_started` è scritto subito prima di lockAvailability,
 * la prima chiamata che congela posti/crea prenotazioni: da lì in poi
 * Medmar può aver ricevuto una mutazione. Prima (preflight_started,
 * preflight_ok) al massimo è partito openTurn, che apre una sessione
 * operatore ma non congela posti né crea prenotazioni o biglietti.
 *
 * Classificazione degli stati medmar_issuing_attempts:
 *   ISSUED (prova certa)          completed
 *   REQUIRES_REVIEW (terminali)   remote_state_unknown, manual_review,
 *                                 booking_failed_definitive,
 *                                 payment_failed_definitive
 *                                 (+ qualunque riga con remote_state_unknown=true)
 *   REMOTE_MUTATION_STARTED       lock_started, locked, booking_started, booked,
 *   (intermedi)                   payment_started, paid, unlock_started
 *                                 -> "in corso" se aggiornati da meno del TTL del
 *                                    lock (900s, > durata massima di una Function):
 *                                    un'emissione viva può ancora averli;
 *                                 -> "da verificare" se più vecchi: abbandonati
 *                                    da un'istanza terminata, mai riconciliati.
 *   SAFE (non bloccano)           preflight_started, preflight_ok (nessuna
 *                                 mutazione su posti/prenotazioni),
 *                                 preflight_failed, lock_failed (nulla congelato
 *                                 o posti rilasciati con esito certo).
 *
 * Inoltre services.medmar_ticket_sent_at valorizzato è prova di emissione.
 *
 * Unica eccezione (nessuna nuova emissione possibile): il replay idempotente
 * dello STESSO gruppo di servizi già emesso con un attempt completo, su una
 * prenotazione mai cancellata dopo l'emissione e senza altri attempt incerti.
 * L'orchestratore restituisce l'emissione esistente (idempotency_key =
 * service_ids ordinati) senza alcuna chiamata Medmar.
 */

export const MEDMAR_ALREADY_ISSUED_MESSAGE =
  "Per questa prenotazione risulta già emesso un biglietto Medmar. Verificare lo storico prima di procedere.";

export const MEDMAR_REQUIRES_REVIEW_MESSAGE =
  "Lo stato dell'emissione Medmar precedente non è certo. Verificare manualmente lo storico prima di procedere.";

export const MEDMAR_IN_PROGRESS_MESSAGE =
  "Una delle prenotazioni è già coinvolta in un'emissione Medmar in corso. Riprova tra poco.";

export const MEDMAR_ISSUANCE_PROOF_ATTEMPT_STATUS = "completed" as const;

export const MEDMAR_ATTEMPT_REQUIRES_REVIEW_STATUSES: ReadonlySet<string> = new Set([
  "remote_state_unknown",
  "manual_review",
  "booking_failed_definitive",
  "payment_failed_definitive",
]);

export const MEDMAR_ATTEMPT_REMOTE_MUTATION_STATUSES: ReadonlySet<string> = new Set([
  "lock_started",
  "locked",
  "booking_started",
  "booked",
  "payment_started",
  "paid",
  "unlock_started",
]);

export const MEDMAR_ATTEMPT_SAFE_STATUSES: ReadonlySet<string> = new Set([
  "preflight_started",
  "preflight_ok",
  "preflight_failed",
  "lock_failed",
]);

/** Deve restare >= MEDMAR_ISSUANCE_LOCK_TTL_SECONDS (issuance-lock.ts). */
export const MEDMAR_ATTEMPT_LIVE_WINDOW_MS = 900 * 1000;

export type MedmarCompletedAttemptEvidence = {
  id: string;
  service_ids: string[];
  medmar_numero: string | null;
  medmar_id_prenotazione: string | null;
  final_total_cents: number | null;
  completed_at: string | null;
};

export type MedmarUncertainAttemptEvidence = {
  id: string;
  status: string;
  service_ids: string[];
  updated_at: string | null;
  remote_state_unknown: boolean;
};

export type MedmarServiceIssuanceEvidence = {
  service_id: string;
  ticket_sent_at: string | null;
  completed_attempts: MedmarCompletedAttemptEvidence[];
  // Attempt non completati che hanno superato la prima mutazione remota o
  // sono terminali incerti (vedi classificazione sopra).
  uncertain_attempts?: MedmarUncertainAttemptEvidence[];
  // true se la prenotazione è stata cancellata (e poi ripristinata) DOPO
  // l'emissione: il biglietto precedente potrebbe non essere più valido.
  cancelled_after_issuance: boolean;
};

export type MedmarAttemptClass = "issued" | "requires_review" | "in_progress" | "safe";

/** Classifica un attempt. Uno stato sconosciuto è trattato con prudenza come "da verificare". */
export function classifyMedmarAttempt(
  attempt: { status: string; remote_state_unknown?: boolean | null; updated_at?: string | null },
  now = Date.now()
): MedmarAttemptClass {
  if (attempt.status === MEDMAR_ISSUANCE_PROOF_ATTEMPT_STATUS) return "issued";
  if (attempt.remote_state_unknown === true) return "requires_review";
  if (MEDMAR_ATTEMPT_REQUIRES_REVIEW_STATUSES.has(attempt.status)) return "requires_review";
  if (MEDMAR_ATTEMPT_REMOTE_MUTATION_STATUSES.has(attempt.status)) {
    const updated = attempt.updated_at ? Date.parse(attempt.updated_at) : NaN;
    if (Number.isFinite(updated) && now - updated < MEDMAR_ATTEMPT_LIVE_WINDOW_MS) return "in_progress";
    return "requires_review";
  }
  if (MEDMAR_ATTEMPT_SAFE_STATUSES.has(attempt.status)) return "safe";
  return "requires_review";
}

export type MedmarIssuanceDecision = {
  blocked: boolean;
  reason: "none" | "idempotent_replay" | "already_issued" | "requires_review" | "in_progress";
  blocking_service_ids: string[];
  cancelled_after_issuance: boolean;
};

export function hasPriorMedmarIssuance(evidence: MedmarServiceIssuanceEvidence | undefined | null): boolean {
  return Boolean(evidence && (evidence.ticket_sent_at || evidence.completed_attempts.length > 0));
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

function isReplaySafe(evidence: MedmarServiceIssuanceEvidence, requested: readonly string[]): boolean {
  if (evidence.cancelled_after_issuance) return false;
  // medmar_ticket_sent_at senza alcun attempt completato (righe legacy):
  // l'orchestratore non avrebbe nulla da riusare -> nuova emissione -> blocco.
  if (evidence.completed_attempts.length === 0) return false;
  return evidence.completed_attempts.every((attempt) =>
    sameSet(attempt.service_ids, requested)
    // Stessa condizione di existingAttemptResult (issue-orchestrator.ts):
    // senza questi campi l'orchestratore NON riuserebbe l'attempt.
    && Boolean(attempt.medmar_numero)
    && Boolean(attempt.medmar_id_prenotazione)
    && attempt.final_total_cents != null
  );
}

export function evaluateMedmarIssuanceRequest(
  requestedServiceIds: readonly string[],
  evidenceByServiceId: ReadonlyMap<string, MedmarServiceIssuanceEvidence> | Record<string, MedmarServiceIssuanceEvidence>,
  now = Date.now()
): MedmarIssuanceDecision {
  const lookup = (id: string) =>
    evidenceByServiceId instanceof Map ? evidenceByServiceId.get(id) : (evidenceByServiceId as Record<string, MedmarServiceIssuanceEvidence>)[id];
  const requested = Array.from(new Set(requestedServiceIds));
  const evidences = requested.map(lookup).filter((e): e is MedmarServiceIssuanceEvidence => Boolean(e));

  // 1. Stato incerto: prevale su tutto (anche sul replay idempotente).
  const reviewIds: string[] = [];
  const liveIds: string[] = [];
  for (const e of evidences) {
    const classes = (e.uncertain_attempts ?? []).map((a) => classifyMedmarAttempt(a, now));
    if (classes.includes("requires_review")) reviewIds.push(e.service_id);
    else if (classes.includes("in_progress")) liveIds.push(e.service_id);
  }
  const cancelledAfter = evidences.some((e) => hasPriorMedmarIssuance(e) && e.cancelled_after_issuance);
  if (reviewIds.length) {
    return { blocked: true, reason: "requires_review", blocking_service_ids: reviewIds, cancelled_after_issuance: cancelledAfter };
  }
  if (liveIds.length) {
    return { blocked: true, reason: "in_progress", blocking_service_ids: liveIds, cancelled_after_issuance: false };
  }

  // 2. Emissione certa già avvenuta.
  const withEvidence = evidences.filter((e) => hasPriorMedmarIssuance(e));
  if (withEvidence.length === 0) {
    return { blocked: false, reason: "none", blocking_service_ids: [], cancelled_after_issuance: false };
  }
  const blocking = withEvidence.filter((e) => !isReplaySafe(e, requested));
  if (blocking.length === 0) {
    return { blocked: false, reason: "idempotent_replay", blocking_service_ids: [], cancelled_after_issuance: false };
  }
  return {
    blocked: true,
    reason: "already_issued",
    blocking_service_ids: blocking.map((e) => e.service_id),
    cancelled_after_issuance: cancelledAfter,
  };
}

export type MedmarQueueIssuanceView = {
  issueAllowed: boolean;
  warningTitle: string | null;
  warningDetail: string | null;
  shortLabel: string | null;
  // Il gruppo resta visibile in coda anche se risulta "inviato", perché
  // l'operatore deve accorgersi del caso (ripristinata / da verificare).
  forceVisible: boolean;
};

export function resolveMedmarQueueIssuanceView(decision: MedmarIssuanceDecision | null | undefined): MedmarQueueIssuanceView {
  if (!decision?.blocked) return { issueAllowed: true, warningTitle: null, warningDetail: null, shortLabel: null, forceVisible: false };
  if (decision.reason === "requires_review") {
    return {
      issueAllowed: false,
      warningTitle: "⚠ EMISSIONE MEDMAR DA VERIFICARE",
      warningDetail: "Una precedente emissione potrebbe essere arrivata a Medmar. Verificare prima di procedere.",
      shortLabel: "Da verificare",
      forceVisible: true,
    };
  }
  if (decision.reason === "in_progress") {
    return { issueAllowed: false, warningTitle: "⏳ EMISSIONE MEDMAR IN CORSO", warningDetail: "Riprova tra poco.", shortLabel: "In corso", forceVisible: false };
  }
  const warningDetail = "Verificare lo storico Medmar prima di una nuova emissione.";
  if (decision.cancelled_after_issuance) {
    return { issueAllowed: false, warningTitle: "⚠ BIGLIETTO GIÀ EMESSO PRIMA DELLA CANCELLAZIONE", warningDetail, shortLabel: "Già emesso", forceVisible: true };
  }
  return { issueAllowed: false, warningTitle: "⚠ BIGLIETTO MEDMAR GIÀ EMESSO", warningDetail, shortLabel: "Già emesso", forceVisible: false };
}
