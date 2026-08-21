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

/**
 * Budget totale (ms) per l'intero batch. cron-job.org taglia a 30s: si
 * lascia margine per l'audit awaited finale + serializzazione JSON, puntando
 * a una response entro ~28-29s (vedi anche MEDMAR_DELIVERY_RETRY_PER_CANDIDATE_BUDGET_MS).
 */
export const MEDMAR_DELIVERY_RETRY_TOTAL_BUDGET_MS = 28_000;

/**
 * Budget (ms) per singolo candidato (lookup mailbox incluso): se scade, il
 * candidato resta ritentabile senza essere toccato. Coincide con il timeout
 * del socket POP3 passato a `findMedmarTicketPdf` (mailboxTimeoutMs): allo
 * scadere il socket viene chiuso per davvero, non solo abbandonato.
 */
export const MEDMAR_DELIVERY_RETRY_PER_CANDIDATE_BUDGET_MS = 26_000;

export type MedmarDeliveryRetryCandidate = {
  id: string;
  tenant_id: string;
  issuing_attempt_id: string;
  status: MedmarDeliveryStatus;
  attempt_count: number;
  updated_at: string;
  medmar_id_prenotazione: string | null;
  medmar_numero: string | null;
};

async function loadRetryCandidates(admin: SupabaseClient, limit: number, now: Date): Promise<MedmarDeliveryRetryCandidate[]> {
  const cutoffIso = new Date(now.getTime() - MEDMAR_DELIVERY_RETRY_MIN_INTERVAL_MS).toISOString();
  const result = await admin
    .from("medmar_delivery_attempts")
    .select("id, tenant_id, issuing_attempt_id, status, attempt_count, updated_at, medmar_id_prenotazione, medmar_numero")
    .in("status", Array.from(RETRYABLE_DELIVERY_STATUSES))
    .lt("attempt_count", MEDMAR_DELIVERY_RETRY_MAX_ATTEMPTS)
    .lte("updated_at", cutoffIso)
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (result.error) throw new Error("medmar_delivery_retry_candidates_lookup_failed");
  return (result.data ?? []) as MedmarDeliveryRetryCandidate[];
}

/**
 * Esito osservabile di un candidato nella response del cron — per capire da
 * fuori (cron-job.org, audit) cosa e' successo davvero dietro un 200 OK:
 * - delivered: consegnato ora (o gia' delivered, idempotente);
 * - timed_out: budget per-candidato scaduto durante il lookup/invio, nessuno stato toccato, ritentabile;
 * - skipped_budget: mai nemmeno iniziato, budget totale del batch gia' esaurito da un candidato precedente;
 * - pending: tentato ma resta in uno stato non terminale non-timeout (es. pdf_not_found sotto soglia, precondizione fallita);
 * - escalated_to_manual_review: max tentativi esauriti, passato a revisione manuale;
 * - error: eccezione imprevista, contenuta, nessuno stato toccato.
 */
export type MedmarDeliveryRetryItemResult = {
  delivery_attempt_id: string;
  tenant_id: string;
  issuing_attempt_id: string;
  medmar_id_prenotazione: string | null;
  medmar_numero: string | null;
  status_before: MedmarDeliveryStatus;
  result: "delivered" | "timed_out" | "skipped_budget" | "pending" | "escalated_to_manual_review" | "error";
  resend_message_id?: string | null;
  elapsed_ms: number;
};

export type MedmarDeliveryRetrySummary = {
  candidates_found: number;
  processed: number;
  delivered: number;
  /** Candidati per cui e' scaduto il budget per-candidato durante il tentativo (result: "timed_out"). */
  deferred: number;
  /** Candidati trovati ma mai tentati perche' il budget totale del batch era gia' esaurito (result: "skipped_budget"). */
  skipped: number;
  still_pending: number;
  escalated_to_manual_review: number;
  errors: number;
  /** true se almeno un candidato e' stato deferred/skipped per budget: il cron successivo ritentera'. */
  timed_out: boolean;
  db_query_ms: number;
  total_ms: number;
  items: MedmarDeliveryRetryItemResult[];
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

  const items: MedmarDeliveryRetryItemResult[] = [];
  let delivered = 0;
  let deferred = 0;
  let skipped = 0;
  let stillPending = 0;
  let escalated = 0;
  let errors = 0;
  const systemUserIdByTenant = new Map<string, string>();

  for (const candidate of candidates) {
    const itemBase = {
      delivery_attempt_id: candidate.id,
      tenant_id: candidate.tenant_id,
      issuing_attempt_id: candidate.issuing_attempt_id,
      medmar_id_prenotazione: candidate.medmar_id_prenotazione,
      medmar_numero: candidate.medmar_numero,
      status_before: candidate.status,
    };

    if (nowMs() - batchStartMs >= totalBudgetMs) {
      // Budget totale esaurito: questo e ogni candidato successivo restano intatti/ritentabili, il prossimo cron riprovera'.
      skipped += 1;
      items.push({ ...itemBase, result: "skipped_budget", elapsed_ms: 0 });
      continue;
    }

    const candidateStartMs = nowMs();
    try {
      let systemUserId = systemUserIdByTenant.get(candidate.tenant_id);
      if (!systemUserId) {
        systemUserId = await doResolveSystemUserId(admin, candidate.tenant_id);
        systemUserIdByTenant.set(candidate.tenant_id, systemUserId);
      }

      const raced = await raceWithTimeout(
        doDeliver(
          {
            admin,
            tenantId: candidate.tenant_id,
            userId: systemUserId,
            issuingAttemptId: candidate.issuing_attempt_id,
            mailboxTimeoutMs: perCandidateBudgetMs,
          },
          deps?.deliverDeps
        ),
        perCandidateBudgetMs
      );
      const elapsedMs = nowMs() - candidateStartMs;

      if (raced === TIMEOUT_MARKER) {
        // Budget per-candidato esaurito (tipicamente mailbox/PDF lookup lento): nessuno stato toccato,
        // il candidato resta ritentabile cosi' com'e' al prossimo giro. Il socket POP3, se e' li' che
        // si e' bloccato, viene chiuso per davvero dal suo stesso timeoutMs (vedi pdf-mailbox-lookup.ts).
        deferred += 1;
        items.push({ ...itemBase, result: "timed_out", elapsed_ms: elapsedMs });
        continue;
      }

      const outcome = raced;

      if (outcome.ok) {
        delivered += 1;
        items.push({
          ...itemBase,
          delivery_attempt_id: outcome.attempt.id,
          result: "delivered",
          resend_message_id: outcome.attempt.resend_message_id,
          elapsed_ms: elapsedMs,
        });
      } else if ("attempt" in outcome) {
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
            escalated += 1;
            items.push({
              ...itemBase,
              delivery_attempt_id: escalatedAttempt.id,
              result: "escalated_to_manual_review",
              elapsed_ms: elapsedMs,
            });
          } catch {
            // Conflitto concorrente (un altro run ha gia' toccato questo attempt nel frattempo): non bloccante, resta ritentabile al prossimo giro.
            stillPending += 1;
            items.push({ ...itemBase, delivery_attempt_id: outcome.attempt.id, result: "pending", elapsed_ms: elapsedMs });
          }
        } else {
          stillPending += 1;
          items.push({ ...itemBase, delivery_attempt_id: outcome.attempt.id, result: "pending", elapsed_ms: elapsedMs });
        }
      } else {
        // Precondizione fallita (issuing_attempt_not_found / issuing_not_completed / remote_state_unknown_blocked / already_sent):
        // non e' uno stato del delivery attempt, quindi non e' ritentabile qui — resta fuori dal prossimo batch solo se la causa a monte si risolve.
        stillPending += 1;
        items.push({ ...itemBase, result: "pending", elapsed_ms: elapsedMs });
      }
    } catch {
      errors += 1;
      items.push({ ...itemBase, result: "error", elapsed_ms: nowMs() - candidateStartMs });
    }
  }

  return {
    candidates_found: candidates.length,
    processed: items.filter((i) => i.result !== "skipped_budget").length,
    delivered,
    deferred,
    skipped,
    still_pending: stillPending,
    escalated_to_manual_review: escalated,
    errors,
    timed_out: deferred > 0 || skipped > 0,
    db_query_ms: dbQueryMs,
    total_ms: nowMs() - batchStartMs,
    items,
  };
}
