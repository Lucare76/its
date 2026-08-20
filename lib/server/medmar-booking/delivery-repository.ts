import type { SupabaseClient } from "@supabase/supabase-js";
import type { DeliveryRepository, MedmarDeliveryAttempt } from "./delivery-types";

function normalizeAttempt(row: Record<string, unknown>): MedmarDeliveryAttempt {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    issuing_attempt_id: String(row.issuing_attempt_id),
    service_ids: Array.isArray(row.service_ids) ? row.service_ids.map(String) : [],
    status: row.status as MedmarDeliveryAttempt["status"],
    medmar_id_prenotazione: (row.medmar_id_prenotazione as string | null | undefined) ?? null,
    medmar_numero: (row.medmar_numero as string | null | undefined) ?? null,
    pdf_mailbox_message_uid: (row.pdf_mailbox_message_uid as string | null | undefined) ?? null,
    pdf_filename: (row.pdf_filename as string | null | undefined) ?? null,
    pdf_original_sha256: (row.pdf_original_sha256 as string | null | undefined) ?? null,
    pdf_cleaned_sha256: (row.pdf_cleaned_sha256 as string | null | undefined) ?? null,
    recipient_type: (row.recipient_type as MedmarDeliveryAttempt["recipient_type"] | null | undefined) ?? null,
    recipient_name: (row.recipient_name as string | null | undefined) ?? null,
    recipient_email: (row.recipient_email as string | null | undefined) ?? null,
    resend_message_id: (row.resend_message_id as string | null | undefined) ?? null,
    attempt_count: typeof row.attempt_count === "number" ? row.attempt_count : 0,
    last_error_code: (row.last_error_code as string | null | undefined) ?? null,
    last_error_message: (row.last_error_message as string | null | undefined) ?? null,
    created_by: (row.created_by as string | null | undefined) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    delivered_at: (row.delivered_at as string | null | undefined) ?? null,
  };
}

export function createDeliveryRepository(admin: SupabaseClient): DeliveryRepository {
  return {
    async findByIssuingAttempt(tenantId, issuingAttemptId) {
      const result = await admin
        .from("medmar_delivery_attempts")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("issuing_attempt_id", issuingAttemptId)
        .maybeSingle();
      if (result.error) throw new Error("medmar_delivery_attempt_lookup_failed");
      return result.data ? normalizeAttempt(result.data as Record<string, unknown>) : null;
    },

    async acquireAttempt(input) {
      const insert = await admin
        .from("medmar_delivery_attempts")
        .insert({
          tenant_id: input.tenantId,
          issuing_attempt_id: input.issuingAttemptId,
          service_ids: input.serviceIds,
          status: "awaiting_pdf",
          medmar_id_prenotazione: input.medmarIdPrenotazione,
          medmar_numero: input.medmarNumero,
          created_by: input.createdBy,
        })
        .select("*")
        .single();

      if (!insert.error && insert.data) {
        return { kind: "created", attempt: normalizeAttempt(insert.data as Record<string, unknown>) };
      }

      const duplicate = (insert.error as { code?: string } | null)?.code === "23505";
      if (!duplicate) {
        throw new Error("medmar_delivery_attempt_insert_failed");
      }

      const existing = await admin
        .from("medmar_delivery_attempts")
        .select("*")
        .eq("tenant_id", input.tenantId)
        .eq("issuing_attempt_id", input.issuingAttemptId)
        .single();
      if (existing.error || !existing.data) {
        throw new Error("medmar_delivery_attempt_lookup_failed");
      }
      return { kind: "existing", attempt: normalizeAttempt(existing.data as Record<string, unknown>) };
    },

    async updateAttempt(id, patch, expectedStatus) {
      // Conditional update (optimistic locking): stesso pattern di
      // issue-repository.ts — chiude il TOCTOU gap tra due chiamate
      // concorrenti sullo stesso delivery attempt.
      const update = await admin
        .from("medmar_delivery_attempts")
        .update(patch)
        .eq("id", id)
        .eq("status", expectedStatus)
        .select("*")
        .single();
      if (update.error || !update.data) {
        throw new Error("medmar_delivery_attempt_conflict");
      }
      return normalizeAttempt(update.data as Record<string, unknown>);
    },
  };
}
