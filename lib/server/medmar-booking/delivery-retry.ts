/**
 * Retry controllato per delivery Medmar bloccate su PDF lento
 * (awaiting_pdf / pdf_not_found — RETRYABLE_DELIVERY_STATUSES in
 * delivery-types.ts, l'unico insieme gia' dichiarato sicuro per retry
 * automatico).
 *
 * Non reimplementa MAI l'invio: ogni retry richiama `deliverMedmarTicket`
 * cosi' com'e' (pdf-delivery.ts), identico al pulsante manuale e
 * all'auto-delivery post-emissione. L'idempotenza (mai un secondo invio,
 * mai un secondo `resend_message_id`, mai un doppio `medmar_ticket_sent_at`)
 * resta garantita al 100% da quella funzione — questo modulo si occupa solo
 * di selezionare i candidati, rispettare max_attempts/intervallo minimo, e
 * far avanzare a `manual_review` chi ha esaurito i tentativi senza mai
 * trovare il PDF.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { deliverMedmarTicket, type MedmarDeliveryDeps } from "./pdf-delivery";
import { createDeliveryRepository } from "./delivery-repository";
import { RETRYABLE_DELIVERY_STATUSES, type DeliveryRepository, type MedmarDeliveryStatus } from "./delivery-types";

/** Numero massimo di tentativi automatici prima di passare a revisione manuale. */
export const MEDMAR_DELIVERY_RETRY_MAX_ATTEMPTS = 5;

/** Intervallo minimo tra due tentativi automatici sullo stesso delivery attempt. */
export const MEDMAR_DELIVERY_RETRY_MIN_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Numero massimo di delivery attempt processati in un singolo run del
 * cron/recovery. Il caller esterno (cron-job.org) ha un timeout FISSO di 30
 * secondi non modificabile: un solo candidato con mailbox lenta puo' gia'
 * avvicinarsi al budget totale (vedi MEDMAR_DELIVERY_RETRY_TOTAL_BUDGET_MS),
 * quindi il default resta a 1 per run.
 */
export const MEDMAR_DELIVERY_RETRY_DEFAULT_BATCH_SIZE = 1;

/** Limite massimo consentito per ?limit=, a protezione dello stesso vincolo di timeout esterno. */
export const MEDMAR_DELIVERY_RETRY_MAX_BATCH_SIZE = 3;

/** Budget totale (ms) per l'intero batch: resta sotto il timeout di 30s di cron-job.org, con margine. */
export const MEDMAR_DELIVERY_RETRY_TOTAL_BUDGET_MS = 25_000;

/** Budget (ms) per singolo candidato (lookup mailbox incluso): se scade, il candidato resta ritentabile senza essere toccato. */
export const MEDMAR_DELIVERY_RETRY_PER_CANDIDATE_BUDGET_MS = 20_000;

export type MedmarDeliveryRetryCandidate = {
  id: string;
  tenant_id: string;
  issuing_attempt_id: string;
  status: MedmarDeliveryStatus;
  attempt_count: number;
  updated_at: string;
};

async function loadRetryCandidates(admin: SupabaseClient, limit: number, now: Date): Promise<MedmarDeliveryRetryCandidate[]> {
  const cutoffIso = new Date(now.getTime() - MEDMAR_DELIVERY_RETRY_MIN_INTERVAL_MS).toISOString();
  const result = await admin
    .from("medmar_delivery_attempts")
    .select("id, tenant_id, issuing_attempt_id, status, attempt_count, updated_at")
    .in("status", Array.from(RETRYABLE_DELIVERY_STATUSES))
    .lt("attempt_count", MEDMAR_DELIVERY_RETRY_MAX_ATTEMPTS)
    .lte("updated_at", cutoffIso)
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (result.error) throw new Error("medmar_delivery_retry_candidates_lookup_failed");
  return (result.data ?? []) as MedmarDeliveryRetryCandidate[];
}

export type MedmarDeliveryRetryItemResult = {
  delivery_attempt_id: string;
  tenant_id: string;
  issuing_attempt_id: string;
  before_status: MedmarDeliveryStatus;
  after_status: string;
  escalated_to_manual_review: boolean;
  error: boolean;
};

export type MedmarDeliveryRetrySummary = {
  candidates_found: number;
  processed: number;
  delivered: number;
  still_pending: number;
  escalated_to_manual_review: number;
  errors: number;
  /** true se il batch e' stato interrotto per esaurimento budget (totale o per-candidato): il cron successivo ritentera'. */
  timed_out: boolean;
  db_query_ms: number;
  total_ms: number;
  results: MedmarDeliveryRetryItemResult[];
};

/**
 * `deliverMedmarTicket` scrive `services.medmar_ticket_sent_by` (FK verso
 * auth.users): un id sintetico "cron-system" romperebbe quella FK e
 * farebbe fallire silenziosamente l'update di `medmar_ticket_sent_at` (la
 * UI perderebbe il badge "Inviato", anche se l'email e' comunque partita).
 * Si risolve quindi un utente admin reale del tenant, primo per data di
 * creazione della membership — stesso ruolo che avrebbe premuto il
 * pulsante manuale.
 */
async function defaultResolveSystemUserId(admin: SupabaseClient, tenantId: string): Promise<string> {
  const result = await admin
    .from("memberships")
    .select("user_id")
    .eq("tenant_id", tenantId)
    .eq("role", "admin")
    .eq("suspended", false)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (result.error || !result.data) throw new Error("medmar_delivery_retry_no_admin_for_tenant");
  return String((result.data as { user_id: string }).user_id);
}

export type MedmarDeliveryRetryDeps = {
  loadCandidates?: typeof loadRetryCandidates;
  deliver?: typeof deliverMedmarTicket;
  repo?: DeliveryRepository;
  deliverDeps?: MedmarDeliveryDeps;
  resolveSystemUserId?: (admin: SupabaseClient, tenantId: string) => Promise<string>;
  now?: () => Date;
  /** Clock iniettabile per il budget interno (default Date.now) — separato da `now` che fissa solo il cutoff della query candidati. */
  nowMs?: () => number;
  /** Budget totale (ms) dell'intero batch. Default MEDMAR_DELIVERY_RETRY_TOTAL_BUDGET_MS. */
  totalBudgetMs?: number;
  /** Budget (ms) per singolo candidato. Default MEDMAR_DELIVERY_RETRY_PER_CANDIDATE_BUDGET_MS. */
  perCandidateBudgetMs?: number;
};

const TIMEOUT_MARKER = Symbol("medmar_delivery_retry_candidate_timeout");

/**
 * Corsa tra `promise` e un timeout di `ms`. Se il timeout vince, la promise
 * originale NON viene annullata (nessun AbortController fino al socket
 * POP3): continua in background nello stesso processo, stesso pattern gia'
 * accettato in `deliverMedmarTicketWithTimeout` (pdf-delivery.ts) per
 * l'auto-delivery post-emissione.
 */
function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT_MARKER> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMEOUT_MARKER), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Esegue un batch di retry controllato. Per ogni candidato ritentabile
 * (awaiting_pdf/pdf_not_found, sotto max_attempts, oltre l'intervallo
 * minimo dall'ultimo aggiornamento) richiama `deliverMedmarTicket` una sola
 * volta. Se il PDF non viene trovato e attempt_count ha raggiunto il tetto,
 * l'attempt passa a `manual_review` (mai un retry infinito, mai un altro
 * invio automatico da li' in poi — vedi MANUAL_REVIEW_DELIVERY_STATUSES in
 * pdf-delivery.ts, che blocca gia' qualunque stato di revisione manuale).
 */
export async function runMedmarDeliveryRetryBatch(
  admin: SupabaseClient,
  limit: number = MEDMAR_DELIVERY_RETRY_DEFAULT_BATCH_SIZE,
  deps?: MedmarDeliveryRetryDeps
): Promise<MedmarDeliveryRetrySummary> {
  const now = (deps?.now ?? (() => new Date()))();
  const doLoadCandidates = deps?.loadCandidates ?? loadRetryCandidates;
  const doDeliver = deps?.deliver ?? deliverMedmarTicket;
  const doResolveSystemUserId = deps?.resolveSystemUserId ?? defaultResolveSystemUserId;
  const repo = deps?.repo ?? createDeliveryRepository(admin);
  const nowMs = deps?.nowMs ?? Date.now;
  const totalBudgetMs = deps?.totalBudgetMs ?? MEDMAR_DELIVERY_RETRY_TOTAL_BUDGET_MS;
  const perCandidateBudgetMs = deps?.perCandidateBudgetMs ?? MEDMAR_DELIVERY_RETRY_PER_CANDIDATE_BUDGET_MS;

  const batchStartMs = nowMs();
  const dbQueryStartMs = nowMs();
  const candidates = await doLoadCandidates(admin, limit, now);
  const dbQueryMs = nowMs() - dbQueryStartMs;

  const results: MedmarDeliveryRetryItemResult[] = [];
  let delivered = 0;
  let stillPending = 0;
  let escalated = 0;
  let errors = 0;
  let timedOut = false;
  const systemUserIdByTenant = new Map<string, string>();

  for (const candidate of candidates) {
    if (nowMs() - batchStartMs >= totalBudgetMs) {
      // Budget totale esaurito: i candidati non ancora processati restano ritentabili, il prossimo cron riprovera'.
      timedOut = true;
      break;
    }
    try {
      let systemUserId = systemUserIdByTenant.get(candidate.tenant_id);
      if (!systemUserId) {
        systemUserId = await doResolveSystemUserId(admin, candidate.tenant_id);
        systemUserIdByTenant.set(candidate.tenant_id, systemUserId);
      }

      const raced = await raceWithTimeout(
        doDeliver(
          { admin, tenantId: candidate.tenant_id, userId: systemUserId, issuingAttemptId: candidate.issuing_attempt_id },
          deps?.deliverDeps
        ),
        perCandidateBudgetMs
      );

      if (raced === TIMEOUT_MARKER) {
        // Budget per-candidato esaurito (tipicamente mailbox/PDF lookup lento): nessuno stato toccato,
        // il candidato resta ritentabile cosi' com'e' al prossimo giro. Si interrompe il batch qui:
        // il budget totale e' comunque prossimo all'esaurimento se un candidato ha gia' consumato questa quota.
        timedOut = true;
        stillPending += 1;
        results.push({
          delivery_attempt_id: candidate.id,
          tenant_id: candidate.tenant_id,
          issuing_attempt_id: candidate.issuing_attempt_id,
          before_status: candidate.status,
          after_status: "timeout",
          escalated_to_manual_review: false,
          error: false,
        });
        break;
      }

      const outcome = raced;
      let afterStatus: string = outcome.status;
      let escalatedNow = false;
      let attemptId = candidate.id;

      if (outcome.ok) {
        delivered += 1;
        attemptId = outcome.attempt.id;
      } else if ("attempt" in outcome) {
        attemptId = outcome.attempt.id;
        if (outcome.status === "pdf_not_found" && outcome.attempt.attempt_count >= MEDMAR_DELIVERY_RETRY_MAX_ATTEMPTS) {
          try {
            const escalatedAttempt = await repo.updateAttempt(
              outcome.attempt.id,
              {
                status: "manual_review",
                last_error_code: "delivery_retry_max_attempts_exhausted",
                last_error_message: `PDF non trovato in mailbox dopo ${outcome.attempt.attempt_count} tentativi automatici: revisione manuale richiesta.`,
              },
              "pdf_not_found"
            );
            afterStatus = escalatedAttempt.status;
            escalatedNow = true;
            escalated += 1;
          } catch {
            // Conflitto concorrente (un altro run ha gia' toccato questo attempt nel frattempo): non bloccante, resta ritentabile al prossimo giro.
            stillPending += 1;
          }
        } else {
          stillPending += 1;
        }
      } else {
        // Precondizione fallita (issuing_attempt_not_found / issuing_not_completed / remote_state_unknown_blocked / already_sent):
        // non e' uno stato del delivery attempt, quindi non e' ritentabile qui — resta fuori dal prossimo batch solo se la causa a monte si risolve.
        stillPending += 1;
      }

      results.push({
        delivery_attempt_id: attemptId,
        tenant_id: candidate.tenant_id,
        issuing_attempt_id: candidate.issuing_attempt_id,
        before_status: candidate.status,
        after_status: afterStatus,
        escalated_to_manual_review: escalatedNow,
        error: false,
      });
    } catch {
      errors += 1;
      results.push({
        delivery_attempt_id: candidate.id,
        tenant_id: candidate.tenant_id,
        issuing_attempt_id: candidate.issuing_attempt_id,
        before_status: candidate.status,
        after_status: "error",
        escalated_to_manual_review: false,
        error: true,
      });
    }
  }

  return {
    candidates_found: candidates.length,
    processed: results.length,
    delivered,
    still_pending: stillPending,
    escalated_to_manual_review: escalated,
    errors,
    timed_out: timedOut,
    db_query_ms: dbQueryMs,
    total_ms: nowMs() - batchStartMs,
    results,
  };
}
