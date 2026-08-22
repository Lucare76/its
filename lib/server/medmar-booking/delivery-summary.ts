/**
 * Contatore coda Medmar (biglietti-medmar UX PARTE 3) — regole pure
 * (nessun accesso DB qui) per raggruppare le righe di
 * medmar_delivery_attempts in bucket operativi. Stesso pattern di
 * lib/medmar-delivery-card.ts: la route (app/api/services/medmar-delivery-summary)
 * fa solo la query e delega il conteggio a questa funzione, cosi' la logica
 * di raggruppamento resta testabile senza Supabase.
 *
 * "Emessi oggi"/"Inviati oggi" sono filtrati sulla finestra temporale
 * (default Europe/Rome, mezzanotte locale); i bucket di coda (in attesa,
 * pronti, in corso, errori) NON sono filtrati per data: un record bloccato
 * da ieri deve continuare a comparire finche' non viene risolto.
 */

import type { MedmarDeliveryStatus } from "./delivery-types";

export const MEDMAR_SUMMARY_AWAITING_STATUSES: ReadonlySet<MedmarDeliveryStatus> = new Set([
  "awaiting_pdf",
  "pdf_not_found",
]);

export const MEDMAR_SUMMARY_READY_STATUSES: ReadonlySet<MedmarDeliveryStatus> = new Set([
  "pdf_found",
  "pdf_cleaned",
]);

export const MEDMAR_SUMMARY_IN_PROGRESS_STATUSES: ReadonlySet<MedmarDeliveryStatus> = new Set([
  "delivery_started",
]);

/** Include pdf_ambiguous (revisione manuale) oltre ai codici esplicitamente elencati nella richiesta operativa. */
export const MEDMAR_SUMMARY_ERROR_STATUSES: ReadonlySet<MedmarDeliveryStatus> = new Set([
  "pdf_ambiguous",
  "pdf_validation_failed",
  "recipient_missing",
  "delivery_failed",
  "delivery_state_unknown",
  "manual_review",
]);

export type MedmarDeliverySummaryRow = {
  id: string;
  issuing_attempt_id: string;
  status: MedmarDeliveryStatus;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
  medmar_numero: string | null;
  last_error_code: string | null;
};

export type MedmarDeliverySummary = {
  as_of: string;
  window_start: string;
  today: { issued: number; delivered: number };
  queue: { awaiting_pdf: number; ready: number; in_progress: number; errors: number };
  oldest_pending: { id: string; status: MedmarDeliveryStatus; created_at: string } | null;
  last_delivered: { id: string; medmar_numero: string | null; delivered_at: string } | null;
  last_error: { id: string; status: MedmarDeliveryStatus; last_error_code: string | null; updated_at: string } | null;
};

/**
 * Raggruppa le righe gia' caricate (sola lettura, nessuna mutazione).
 * `now` e `windowStart` sono passati esplicitamente (non calcolati qui) per
 * restare puramente deterministica e testabile.
 */
export function summarizeMedmarDeliveryAttempts(
  rows: readonly MedmarDeliverySummaryRow[],
  now: string,
  windowStart: string
): MedmarDeliverySummary {
  let issuedToday = 0;
  let deliveredToday = 0;
  let awaiting = 0;
  let ready = 0;
  let inProgress = 0;
  let errors = 0;
  let oldestPending: MedmarDeliverySummary["oldest_pending"] = null;
  let lastDelivered: MedmarDeliverySummary["last_delivered"] = null;
  let lastError: MedmarDeliverySummary["last_error"] = null;

  for (const row of rows) {
    if (row.created_at >= windowStart) issuedToday += 1;
    if (row.status === "delivered" && row.delivered_at && row.delivered_at >= windowStart) deliveredToday += 1;

    const isAwaiting = MEDMAR_SUMMARY_AWAITING_STATUSES.has(row.status);
    const isReady = MEDMAR_SUMMARY_READY_STATUSES.has(row.status);
    const isInProgress = MEDMAR_SUMMARY_IN_PROGRESS_STATUSES.has(row.status);
    const isError = MEDMAR_SUMMARY_ERROR_STATUSES.has(row.status);

    if (isAwaiting) awaiting += 1;
    else if (isReady) ready += 1;
    else if (isInProgress) inProgress += 1;
    else if (isError) errors += 1;

    if ((isAwaiting || isReady || isInProgress) && (!oldestPending || row.created_at < oldestPending.created_at)) {
      oldestPending = { id: row.id, status: row.status, created_at: row.created_at };
    }

    if (row.status === "delivered" && row.delivered_at) {
      if (!lastDelivered || row.delivered_at > lastDelivered.delivered_at) {
        lastDelivered = { id: row.id, medmar_numero: row.medmar_numero, delivered_at: row.delivered_at };
      }
    }

    if (isError && (!lastError || row.updated_at > lastError.updated_at)) {
      lastError = { id: row.id, status: row.status, last_error_code: row.last_error_code, updated_at: row.updated_at };
    }
  }

  return {
    as_of: now,
    window_start: windowStart,
    today: { issued: issuedToday, delivered: deliveredToday },
    queue: { awaiting_pdf: awaiting, ready, in_progress: inProgress, errors },
    oldest_pending: oldestPending,
    last_delivered: lastDelivered,
    last_error: lastError,
  };
}

/* =========================================================================
 * "Credito e fabbisogno Medmar" — evoluzione del box coda (biglietti-medmar).
 * Tutto sotto e' ancora sola lettura su dati gia' presenti in
 * medmar_issuing_attempts / medmar_delivery_attempts / services: NESSUNA
 * chiamata Medmar (no preflight live, no lock, no booking, no payment).
 * ========================================================================= */

export type MedmarIssuingActivityRow = {
  id: string;
  status: string;
  completed_at: string | null;
  final_total_cents: number | null;
  service_ids: readonly string[];
};

export type MedmarDeliveryActivityRow = {
  issuing_attempt_id: string;
  status: string;
  delivered_at: string | null;
};

export type MedmarIssuedDeliveredSummary = {
  issued_today_count: number;
  issued_today_amount_cents: number;
  delivered_today_count: number;
  /** null solo se almeno un delivered di oggi non trova il proprio importo (issuing attempt mancante/importo nullo) — mai una somma parziale silenziosa. */
  delivered_today_amount_cents: number | null;
  /** Piu' recente in assoluto (non solo oggi), null se non esiste ancora nessuna emissione completata. */
  last_issued_amount_cents: number | null;
  /** Piu' recente in assoluto, null se non esiste ancora nessun delivered o il suo importo non e' risolvibile. */
  last_delivered_amount_cents: number | null;
};

/**
 * Attivita' di emissione/invio con importi (PARTE "Credito e fabbisogno").
 * Prende in input righe gia' caricate da medmar_issuing_attempts (solo
 * status='completed', idealmente) e medmar_delivery_attempts — nessun
 * accesso DB qui, stesso pattern di summarizeMedmarDeliveryAttempts sopra.
 */
export function summarizeMedmarIssuedAndDelivered(
  issuingRows: readonly MedmarIssuingActivityRow[],
  deliveryRows: readonly MedmarDeliveryActivityRow[],
  windowStart: string
): MedmarIssuedDeliveredSummary {
  const completedIssuing = issuingRows.filter((r) => r.status === "completed");
  const amountByIssuingId = new Map(completedIssuing.map((r) => [r.id, r.final_total_cents]));

  let issuedTodayCount = 0;
  let issuedTodayAmount = 0;
  let lastIssuedAt: string | null = null;
  let lastIssuedAmount: number | null = null;
  for (const row of completedIssuing) {
    const ts = row.completed_at;
    if (ts && ts >= windowStart) {
      issuedTodayCount += 1;
      issuedTodayAmount += row.final_total_cents ?? 0;
    }
    if (ts && (!lastIssuedAt || ts > lastIssuedAt)) {
      lastIssuedAt = ts;
      lastIssuedAmount = row.final_total_cents ?? null;
    }
  }

  let deliveredTodayCount = 0;
  let deliveredTodayAmount = 0;
  let deliveredTodayAmountFullyKnown = true;
  let lastDeliveredAt: string | null = null;
  let lastDeliveredAmount: number | null = null;
  for (const row of deliveryRows) {
    if (row.status !== "delivered" || !row.delivered_at) continue;
    const amount = amountByIssuingId.get(row.issuing_attempt_id) ?? null;
    if (row.delivered_at >= windowStart) {
      deliveredTodayCount += 1;
      if (amount == null) deliveredTodayAmountFullyKnown = false;
      else deliveredTodayAmount += amount;
    }
    if (!lastDeliveredAt || row.delivered_at > lastDeliveredAt) {
      lastDeliveredAt = row.delivered_at;
      lastDeliveredAmount = amount;
    }
  }

  return {
    issued_today_count: issuedTodayCount,
    issued_today_amount_cents: issuedTodayAmount,
    delivered_today_count: deliveredTodayCount,
    delivered_today_amount_cents: deliveredTodayCount === 0 ? 0 : deliveredTodayAmountFullyKnown ? deliveredTodayAmount : null,
    last_issued_amount_cents: lastIssuedAmount,
    last_delivered_amount_cents: lastDeliveredAt ? lastDeliveredAmount : null,
  };
}

const MEDMAR_PRATICA_TAG_RE = /\[practice:([^\]]+)\]/;

/**
 * Stessa chiave di raggruppamento usata client-side in
 * app/(app)/biglietti-medmar/page.tsx (extractPratica + normalizeCustomerKey)
 * per raggruppare andata+ritorno di una stessa prenotazione: duplicata qui
 * (non importabile — quel file e' "use client") per evitare di contare due
 * biglietti stimati dove in realta' un'unica emissione coprirebbe entrambe
 * le tratte A/R.
 */
function medmarBookingGroupKey(notes: string | null, customerName: string | null): string {
  const match = (notes ?? "").match(MEDMAR_PRATICA_TAG_RE);
  if (match?.[1]) return `practice:${match[1]}`;
  return `name:${(customerName ?? "sconosciuto").trim().toLowerCase().replace(/\s+/g, " ")}`;
}

export type MedmarCandidateServiceRow = {
  id: string;
  customer_name: string | null;
  notes: string | null;
};

export type MedmarUpcomingAmountSource = "preflight_local" | "historical_average" | "service_price" | "unavailable";

export type MedmarUpcomingForecast = {
  upcoming_3d_candidate_services: number;
  upcoming_3d_estimated_tickets: number;
  upcoming_3d_estimated_amount_cents: number | null;
  upcoming_3d_amount_source: MedmarUpcomingAmountSource;
};

/**
 * Stima "quanti biglietti Medmar servira' emettere nei prossimi 3 giorni"
 * SOLO da dati locali gia' in DB — nessuna chiamata Medmar (no preflight
 * live/lock/booking/payment). `candidateServices` deve gia' essere filtrato
 * a monte (route) su: date nei prossimi 3 giorni, non cancellati, vessel
 * riconducibile a Medmar. `alreadyIssuedServiceIds` esclude i service gia'
 * coperti da un'emissione completata. Il conteggio biglietti deduplica per
 * prenotazione (medmarBookingGroupKey) per non contare due volte andata e
 * ritorno della stessa prenotazione. L'importo e' una media storica
 * (`historical_average`) sui soli importi reali gia' emessi: se non ce
 * n'e' nessuno con biglietti stimati > 0, l'importo resta esplicitamente
 * non calcolabile (mai inventato).
 */
export function estimateMedmarUpcoming3Days(
  candidateServices: readonly MedmarCandidateServiceRow[],
  alreadyIssuedServiceIds: ReadonlySet<string>,
  historicalCompletedAmountsCents: readonly number[]
): MedmarUpcomingForecast {
  const pending = candidateServices.filter((s) => !alreadyIssuedServiceIds.has(s.id));
  const groupKeys = new Set<string>();
  for (const s of pending) groupKeys.add(medmarBookingGroupKey(s.notes, s.customer_name));
  const estimatedTickets = groupKeys.size;

  const validAmounts = historicalCompletedAmountsCents.filter((v) => Number.isFinite(v) && v > 0);

  if (estimatedTickets === 0) {
    return {
      upcoming_3d_candidate_services: pending.length,
      upcoming_3d_estimated_tickets: 0,
      upcoming_3d_estimated_amount_cents: 0,
      upcoming_3d_amount_source: validAmounts.length > 0 ? "historical_average" : "unavailable",
    };
  }

  if (validAmounts.length === 0) {
    return {
      upcoming_3d_candidate_services: pending.length,
      upcoming_3d_estimated_tickets: estimatedTickets,
      upcoming_3d_estimated_amount_cents: null,
      upcoming_3d_amount_source: "unavailable",
    };
  }

  const averageCents = validAmounts.reduce((sum, v) => sum + v, 0) / validAmounts.length;
  return {
    upcoming_3d_candidate_services: pending.length,
    upcoming_3d_estimated_tickets: estimatedTickets,
    upcoming_3d_estimated_amount_cents: Math.round(averageCents * estimatedTickets),
    upcoming_3d_amount_source: "historical_average",
  };
}

export type MedmarCreditType = "real" | "manual_estimated" | "unavailable";

export type MedmarCreditInfo = {
  type: MedmarCreditType;
  available_cents: number | null;
  /** Timestamp ultimo aggiornamento — significativo solo per type "real" (nessuna integrazione reale oggi, vedi resolveMedmarCreditInfo). */
  as_of: string | null;
};

/**
 * Nessuna integrazione Medmar espone oggi il credito/saldo reale
 * dell'account: verificato che POST /authenticate restituisce solo un
 * token (il resto della risposta e' deliberatamente scartato per requisito
 * di sicurezza, vedi medmar-auth-provider.ts) e che le altre chiamate
 * client (lock-disponibilita', prenotazioni, pagamento) riguardano posti
 * disponibili, mai un saldo economico. Finche' non esiste un'integrazione
 * reale, l'UNICO input ammesso e' una cifra manuale/stimata via env var
 * (MEDMAR_MANUAL_CREDIT_CENTS, interi di centesimi) — mai un valore
 * inventato. Se l'env var e' assente o non valida, il credito resta
 * esplicitamente "non disponibile" (mai un fallback silenzioso a zero).
 */
export function resolveMedmarCreditInfo(env: { MEDMAR_MANUAL_CREDIT_CENTS?: string | undefined }): MedmarCreditInfo {
  const raw = (env.MEDMAR_MANUAL_CREDIT_CENTS ?? "").trim();
  if (!raw) return { type: "unavailable", available_cents: null, as_of: null };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return { type: "unavailable", available_cents: null, as_of: null };
  return { type: "manual_estimated", available_cents: Math.round(parsed), as_of: null };
}

/** Soglia iniziale semplice richiesta operativamente (€200). */
export const MEDMAR_CREDIT_SAFETY_THRESHOLD_CENTS = 20_000;

export type MedmarCreditEvaluationStatus = "sufficient" | "warning" | "insufficient" | "unknown";

export type MedmarCreditEvaluation = {
  status: MedmarCreditEvaluationStatus;
  /** Solo per status "insufficient": quanto manca (centesimi) per coprire la stima. */
  shortfall_cents: number | null;
  safety_threshold_cents: number;
};

/**
 * credito_disponibile - importo_stimato_prossimi_3_giorni, con soglia di
 * sicurezza. Agnostica rispetto all'origine del credito (reale o
 * manuale/stimato): la sufficienza dipende solo dal numero, mai dal tipo.
 *
 *   sufficient:   credito >= stima + soglia
 *   warning:      credito >= stima ma (credito - stima) < soglia
 *   insufficient: credito < stima
 *   unknown:      manca credito o manca importo stimato
 */
export function evaluateMedmarCredit(
  availableCents: number | null,
  estimatedNeedCents: number | null,
  safetyThresholdCents: number = MEDMAR_CREDIT_SAFETY_THRESHOLD_CENTS
): MedmarCreditEvaluation {
  if (availableCents == null || estimatedNeedCents == null) {
    return { status: "unknown", shortfall_cents: null, safety_threshold_cents: safetyThresholdCents };
  }
  if (availableCents < estimatedNeedCents) {
    return { status: "insufficient", shortfall_cents: estimatedNeedCents - availableCents, safety_threshold_cents: safetyThresholdCents };
  }
  const remainingAfter = availableCents - estimatedNeedCents;
  if (remainingAfter < safetyThresholdCents) {
    return { status: "warning", shortfall_cents: null, safety_threshold_cents: safetyThresholdCents };
  }
  return { status: "sufficient", shortfall_cents: null, safety_threshold_cents: safetyThresholdCents };
}
