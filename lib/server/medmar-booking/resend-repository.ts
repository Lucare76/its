/**
 * Ledger dei reinvii "Rimanda biglietto" (medmar_ticket_resends, vedi
 * supabase/migrations/0241_medmar_ticket_resends.sql). Stesso pattern di
 * delivery-repository.ts: solo query dirette, nessuna logica di dominio qui
 * — quella vive in ticket-resend.ts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type MedmarTicketResendStatus = "started" | "sent" | "failed";

export type MedmarTicketResendRow = {
  id: string;
  tenant_id: string;
  delivery_attempt_id: string;
  issuing_attempt_id: string | null;
  medmar_id_prenotazione: string;
  medmar_numero: string;
  recipient_email: string;
  resend_message_id: string | null;
  status: MedmarTicketResendStatus;
  error_code: string | null;
  error_message: string | null;
  pdf_cleaned_sha256: string | null;
  original_pdf_sha256: string | null;
  hash_warning: boolean;
  created_at: string;
  created_by: string | null;
  sent_at: string | null;
};

function normalizeResendRow(row: Record<string, unknown>): MedmarTicketResendRow {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    delivery_attempt_id: String(row.delivery_attempt_id),
    issuing_attempt_id: (row.issuing_attempt_id as string | null | undefined) ?? null,
    medmar_id_prenotazione: String(row.medmar_id_prenotazione),
    medmar_numero: String(row.medmar_numero),
    recipient_email: String(row.recipient_email),
    resend_message_id: (row.resend_message_id as string | null | undefined) ?? null,
    status: row.status as MedmarTicketResendStatus,
    error_code: (row.error_code as string | null | undefined) ?? null,
    error_message: (row.error_message as string | null | undefined) ?? null,
    pdf_cleaned_sha256: (row.pdf_cleaned_sha256 as string | null | undefined) ?? null,
    original_pdf_sha256: (row.original_pdf_sha256 as string | null | undefined) ?? null,
    hash_warning: row.hash_warning === true,
    created_at: String(row.created_at),
    created_by: (row.created_by as string | null | undefined) ?? null,
    sent_at: (row.sent_at as string | null | undefined) ?? null,
  };
}

export type MedmarInsertStartedIfEligibleInput = {
  tenantId: string;
  deliveryAttemptId: string;
  issuingAttemptId: string | null;
  medmarIdPrenotazione: string;
  medmarNumero: string;
  recipientEmail: string;
  createdBy: string;
};

export type MedmarInsertStartedIfEligibleResult =
  | { kind: "started"; row: MedmarTicketResendRow }
  | { kind: "blocked"; recent: MedmarTicketResendRow };

export type MedmarResendRepository = {
  insertStarted(input: {
    tenantId: string;
    deliveryAttemptId: string;
    issuingAttemptId: string | null;
    medmarIdPrenotazione: string;
    medmarNumero: string;
    recipientEmail: string;
    createdBy: string;
  }): Promise<MedmarTicketResendRow>;
  /**
   * Guard anti-doppio-reinvio (micro-fix "guard anti-doppio resend"): in
   * un'unica chiamata di repository, verifica se esiste gia' un reinvio
   * (qualunque stato — 'started' = in corso, 'sent'/'failed' = appena
   * tentato) per lo stesso delivery_attempt_id creato negli ultimi
   * `cooldownSeconds`; se si', ritorna quella riga senza inserirne una
   * nuova ('blocked'); altrimenti inserisce 'started' ('started'). Nessun
   * vincolo UNIQUE esiste oggi su medmar_ticket_resends per
   * (tenant_id, delivery_attempt_id) — vedi commento in ticket-resend.ts sul
   * limite reale di questo guard sul backend Supabase (2 round-trip, non un
   * singolo constraint atomico) e sulla migration proposta per chiuderlo del
   * tutto.
   */
  insertStartedIfEligible(
    input: MedmarInsertStartedIfEligibleInput,
    cooldownSeconds: number
  ): Promise<MedmarInsertStartedIfEligibleResult>;
  markSent(id: string, patch: {
    resendMessageId: string;
    pdfCleanedSha256: string;
    originalPdfSha256: string;
    hashWarning: boolean;
  }): Promise<MedmarTicketResendRow>;
  markFailed(id: string, patch: { errorCode: string; errorMessage: string }): Promise<MedmarTicketResendRow>;
  listByDeliveryAttempts(tenantId: string, deliveryAttemptIds: readonly string[]): Promise<MedmarTicketResendRow[]>;
};

export function createResendRepository(admin: SupabaseClient): MedmarResendRepository {
  return {
    async insertStarted(input) {
      const insert = await admin
        .from("medmar_ticket_resends")
        .insert({
          tenant_id: input.tenantId,
          delivery_attempt_id: input.deliveryAttemptId,
          issuing_attempt_id: input.issuingAttemptId,
          medmar_id_prenotazione: input.medmarIdPrenotazione,
          medmar_numero: input.medmarNumero,
          recipient_email: input.recipientEmail,
          status: "started",
          created_by: input.createdBy,
        })
        .select("*")
        .single();
      if (insert.error || !insert.data) throw new Error("medmar_ticket_resend_insert_failed");
      return normalizeResendRow(insert.data as Record<string, unknown>);
    },

    async insertStartedIfEligible(input, cooldownSeconds) {
      const cutoffIso = new Date(Date.now() - cooldownSeconds * 1000).toISOString();
      // Check-then-insert: due round-trip separati, NON un singolo constraint
      // atomico (nessun UNIQUE esiste oggi su questa tabella per
      // (tenant_id, delivery_attempt_id) — vedi migration proposta nel
      // report del micro-fix). Copre in modo affidabile il caso reale
      // (doppio click, refresh, richiesta ripetuta a pochi secondi di
      // distanza): la finestra di race residua e' la latenza tra queste due
      // query, non l'intera finestra di cooldown.
      const recent = await admin
        .from("medmar_ticket_resends")
        .select("*")
        .eq("tenant_id", input.tenantId)
        .eq("delivery_attempt_id", input.deliveryAttemptId)
        .gte("created_at", cutoffIso)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (recent.error) throw new Error("medmar_ticket_resend_lookup_failed");
      if (recent.data) {
        return { kind: "blocked", recent: normalizeResendRow(recent.data as Record<string, unknown>) };
      }

      const insert = await admin
        .from("medmar_ticket_resends")
        .insert({
          tenant_id: input.tenantId,
          delivery_attempt_id: input.deliveryAttemptId,
          issuing_attempt_id: input.issuingAttemptId,
          medmar_id_prenotazione: input.medmarIdPrenotazione,
          medmar_numero: input.medmarNumero,
          recipient_email: input.recipientEmail,
          status: "started",
          created_by: input.createdBy,
        })
        .select("*")
        .single();
      if (insert.error || !insert.data) throw new Error("medmar_ticket_resend_insert_failed");
      return { kind: "started", row: normalizeResendRow(insert.data as Record<string, unknown>) };
    },

    async markSent(id, patch) {
      const update = await admin
        .from("medmar_ticket_resends")
        .update({
          status: "sent",
          resend_message_id: patch.resendMessageId,
          pdf_cleaned_sha256: patch.pdfCleanedSha256,
          original_pdf_sha256: patch.originalPdfSha256,
          hash_warning: patch.hashWarning,
          sent_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select("*")
        .single();
      if (update.error || !update.data) throw new Error("medmar_ticket_resend_update_failed");
      return normalizeResendRow(update.data as Record<string, unknown>);
    },

    async markFailed(id, patch) {
      const update = await admin
        .from("medmar_ticket_resends")
        .update({ status: "failed", error_code: patch.errorCode, error_message: patch.errorMessage })
        .eq("id", id)
        .select("*")
        .single();
      if (update.error || !update.data) throw new Error("medmar_ticket_resend_update_failed");
      return normalizeResendRow(update.data as Record<string, unknown>);
    },

    async listByDeliveryAttempts(tenantId, deliveryAttemptIds) {
      if (deliveryAttemptIds.length === 0) return [];
      const result = await admin
        .from("medmar_ticket_resends")
        .select("*")
        .eq("tenant_id", tenantId)
        .in("delivery_attempt_id", deliveryAttemptIds)
        .order("created_at", { ascending: false });
      if (result.error) throw new Error("medmar_ticket_resend_list_failed");
      return (result.data ?? []).map((row) => normalizeResendRow(row as Record<string, unknown>));
    },
  };
}
