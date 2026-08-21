/**
 * Fase delivery — state machine per l'invio email del PDF Medmar pulito,
 * successiva e distinta dall'emissione (issue-types.ts/MedmarIssueStatus).
 * Stesso pattern strutturale (repository + optimistic locking su status).
 */

export type MedmarDeliveryStatus =
  | "awaiting_pdf"
  | "pdf_found"
  | "pdf_cleaned"
  | "delivery_started"
  | "delivered"
  | "pdf_not_found"
  | "pdf_ambiguous"
  | "pdf_validation_failed"
  | "recipient_missing"
  | "delivery_failed"
  | "delivery_state_unknown"
  | "manual_review";

/** Stati terminali: nessuna transizione automatica ulteriore prevista. */
export const TERMINAL_DELIVERY_STATUSES: ReadonlySet<MedmarDeliveryStatus> = new Set(["delivered"]);

/**
 * Stati da cui e' sicuro ritentare automaticamente. `pdf_found` e' il nuovo
 * stato intermedio del retry a due fasi: PDF gia' individuato e salvato
 * (uid/filename/hash) ma non ancora pulito/inviato — il prossimo run lo
 * riprende con un fetch mirato via UID invece di rifare lo scan completo.
 */
export const RETRYABLE_DELIVERY_STATUSES: ReadonlySet<MedmarDeliveryStatus> = new Set(["pdf_not_found", "awaiting_pdf", "pdf_found"]);

/** Stati che richiedono intervento umano esplicito, mai un retry automatico. */
export const MANUAL_REVIEW_DELIVERY_STATUSES: ReadonlySet<MedmarDeliveryStatus> = new Set([
  "pdf_ambiguous",
  "pdf_validation_failed",
  "manual_review",
]);

export type MedmarDeliveryAttempt = {
  id: string;
  tenant_id: string;
  issuing_attempt_id: string;
  service_ids: string[];
  status: MedmarDeliveryStatus;
  medmar_id_prenotazione: string | null;
  medmar_numero: string | null;
  pdf_mailbox_message_uid: string | null;
  pdf_filename: string | null;
  pdf_original_sha256: string | null;
  pdf_cleaned_sha256: string | null;
  recipient_type: "agency" | "customer" | null;
  recipient_name: string | null;
  recipient_email: string | null;
  resend_message_id: string | null;
  attempt_count: number;
  last_error_code: string | null;
  last_error_message: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
};

export type DeliveryRepository = {
  findByIssuingAttempt(tenantId: string, issuingAttemptId: string): Promise<MedmarDeliveryAttempt | null>;
  acquireAttempt(input: {
    tenantId: string;
    issuingAttemptId: string;
    serviceIds: string[];
    medmarIdPrenotazione: string | null;
    medmarNumero: string | null;
    createdBy: string;
  }): Promise<{ kind: "created"; attempt: MedmarDeliveryAttempt } | { kind: "existing"; attempt: MedmarDeliveryAttempt }>;
  updateAttempt(
    id: string,
    patch: Partial<MedmarDeliveryAttempt>,
    expectedStatus: MedmarDeliveryStatus
  ): Promise<MedmarDeliveryAttempt>;
};
