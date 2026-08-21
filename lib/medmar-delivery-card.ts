/**
 * Regole pure (nessun React/JSX) per la card Medmar in
 * app/(app)/biglietti-medmar/page.tsx — estratte in un modulo separato
 * perche' questo repo non ha infrastruttura per test di rendering React
 * (nessun jsdom/@testing-library/react in package.json, vitest.config.ts
 * usa environment: "node"), stesso pattern di lib/medmar-issue-flow.ts.
 */

/** Stati che il retry automatico (cron medmar-delivery-retry) ritenta davvero — deve restare identico a RETRYABLE_DELIVERY_STATUSES in lib/server/medmar-booking/delivery-types.ts. */
export const MEDMAR_DELIVERY_AUTO_RETRY_STATUSES = new Set(["awaiting_pdf", "pdf_not_found", "pdf_found"]);

/** Stati in cui il pulsante "Riprova ora" NON va mostrato in lista: terminale (delivered), mid-flight (delivery_started) o incerto (nessun retry automatico su ambiguita'). */
export const MEDMAR_DELIVERY_LIST_NON_ACTIONABLE_STATUSES = new Set([
  "delivered",
  "delivery_started",
  "delivery_state_unknown",
  "remote_state_unknown_blocked",
]);

/**
 * Regola card compatta ("emesso e inviato"): compatta se il delivery
 * attempt e' 'delivered'. Se non esiste alcun attempt (fallback difensivo
 * per righe legacy pre-migrazione 0237 dove medmar_ticket_sent_at fu
 * impostato senza mai creare una riga medmar_delivery_attempts), compatta
 * solo se medmar_ticket_sent_at e' valorizzato. MAI compatta quando un
 * attempt esiste con uno stato diverso da 'delivered' (awaiting_pdf,
 * pdf_not_found, delivery_started, errori, revisione manuale) — lo stato
 * dell'attempt vince sempre sul fallback.
 */
export function resolveMedmarCardCompact(input: { attemptStatus: string | null | undefined; sentAt: string | null | undefined }): boolean {
  if (input.attemptStatus != null) return input.attemptStatus === "delivered";
  return input.sentAt != null;
}

/** Il pulsante manuale di retry va mostrato solo per stati non terminali/non incerti. */
export function isMedmarDeliveryRetryButtonVisible(status: string): boolean {
  return !MEDMAR_DELIVERY_LIST_NON_ACTIONABLE_STATUSES.has(status);
}

/**
 * Il fallback manuale con upload PDF ("Invio manuale PDF") NON deve mai
 * comparire nel flusso normale (auto-retry in corso, mid-flight, o gia'
 * delivered): solo per stati di errore/revisione manuale dove il retry
 * automatico non interverra' mai piu' da solo.
 */
export function isMedmarManualFallbackVisible(status: string): boolean {
  return !MEDMAR_DELIVERY_AUTO_RETRY_STATUSES.has(status) && status !== "delivered" && status !== "delivery_started";
}

/**
 * Indicizza gli attempt per service_id (service_ids e' un array Postgres,
 * ogni attempt puo' comparire sotto piu' chiavi). A parita' di service_id
 * vince il PRIMO attempt incontrato nell'array in input — scelta
 * deterministica indipendente dall'ordine restituito da Postgres (nessuna
 * `order by` nella query, quindi l'ordine di ritorno non e' garantito).
 * Estratta da app/(app)/biglietti-medmar/page.tsx per essere testabile
 * (bug FASE 2/3: prima la card compatta si calcolava solo dallo stato
 * locale post-emissione, mai da questa indicizzazione dei dati DB).
 */
export function buildDeliveryAttemptIndex<T extends { service_ids: string[] }>(attempts: readonly T[]): Map<string, T> {
  const index = new Map<string, T>();
  for (const attempt of attempts) {
    for (const sid of attempt.service_ids) {
      if (!index.has(sid)) index.set(sid, attempt);
    }
  }
  return index;
}

/** Trova l'attempt collegato a un gruppo tramite uno qualunque dei suoi service_ids. */
export function lookupDeliveryAttempt<T>(index: Map<string, T>, groupServiceIds: readonly string[]): T | undefined {
  for (const id of groupServiceIds) {
    const found = index.get(id);
    if (found) return found;
  }
  return undefined;
}

/** Compone indicizzazione + lookup + regola compatta in un'unica chiamata pura, riusabile sia in UI che nei test. */
export function resolveMedmarGroupDelivery<T extends { service_ids: string[]; status: string }>(
  groupServiceIds: readonly string[],
  attempts: readonly T[],
  sentAt: string | null | undefined
): { attempt: T | undefined; isCompact: boolean } {
  const attempt = lookupDeliveryAttempt(buildDeliveryAttemptIndex(attempts), groupServiceIds);
  const isCompact = resolveMedmarCardCompact({ attemptStatus: attempt?.status ?? null, sentAt });
  return { attempt, isCompact };
}
