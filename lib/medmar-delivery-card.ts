/**
 * Regole pure (nessun React/JSX) per la card Medmar in
 * app/(app)/biglietti-medmar/page.tsx — estratte in un modulo separato
 * perche' questo repo non ha infrastruttura per test di rendering React
 * (nessun jsdom/@testing-library/react in package.json, vitest.config.ts
 * usa environment: "node"), stesso pattern di lib/medmar-issue-flow.ts.
 */

/** Stati che il retry automatico (cron medmar-delivery-retry) ritenta davvero — deve restare identico a RETRYABLE_DELIVERY_STATUSES in lib/server/medmar-booking/delivery-types.ts. */
export const MEDMAR_DELIVERY_AUTO_RETRY_STATUSES = new Set(["awaiting_pdf", "pdf_not_found"]);

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
