import type { SupabaseClient } from "@supabase/supabase-js";
import type { IssueRepository, MedmarIssueAttempt, MedmarIssueEventInput } from "./issue-types";

function normalizeAttempt(row: Record<string, unknown>): MedmarIssueAttempt {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    idempotency_key: String(row.idempotency_key),
    service_ids: Array.isArray(row.service_ids) ? row.service_ids.map(String) : [],
    status: row.status as MedmarIssueAttempt["status"],
    preflight_snapshot: row.preflight_snapshot ?? null,
    lock_snapshot: row.lock_snapshot ?? null,
    booking_payload_hash: (row.booking_payload_hash as string | null | undefined) ?? null,
    medmar_id_prenotazione: (row.medmar_id_prenotazione as string | null | undefined) ?? null,
    medmar_numero: (row.medmar_numero as string | null | undefined) ?? null,
    expected_total_cents: (row.expected_total_cents as number | null | undefined) ?? null,
    final_total_cents: (row.final_total_cents as number | null | undefined) ?? null,
    last_error_code: (row.last_error_code as string | null | undefined) ?? null,
    last_error_message: (row.last_error_message as string | null | undefined) ?? null,
    remote_state_unknown: row.remote_state_unknown === true,
    created_by: (row.created_by as string | null | undefined) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    completed_at: (row.completed_at as string | null | undefined) ?? null,
  };
}

export function createIssueRepository(admin: SupabaseClient): IssueRepository {
  return {
    async findAttempt(tenantId, idempotencyKey) {
      const existing = await admin
        .from("medmar_issuing_attempts")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      if (existing.error) {
        throw new Error("medmar_issue_attempt_lookup_failed");
      }
      return existing.data ? normalizeAttempt(existing.data as Record<string, unknown>) : null;
    },

    async acquireAttempt(input) {
      const insert = await admin
        .from("medmar_issuing_attempts")
        .insert({
          tenant_id: input.tenantId,
          idempotency_key: input.idempotencyKey,
          service_ids: input.serviceIds,
          status: "preflight_started",
          created_by: input.createdBy,
        })
        .select("*")
        .single();

      if (!insert.error && insert.data) {
        return { kind: "created", attempt: normalizeAttempt(insert.data as Record<string, unknown>) };
      }

      const duplicate = (insert.error as { code?: string } | null)?.code === "23505";
      if (!duplicate) {
        throw new Error("medmar_issue_attempt_insert_failed");
      }

      const existing = await admin
        .from("medmar_issuing_attempts")
        .select("*")
        .eq("tenant_id", input.tenantId)
        .eq("idempotency_key", input.idempotencyKey)
        .single();
      if (existing.error || !existing.data) {
        throw new Error("medmar_issue_attempt_lookup_failed");
      }
      return { kind: "existing", attempt: normalizeAttempt(existing.data as Record<string, unknown>) };
    },

    async updateAttempt(id, patch, expectedStatus) {
      // Conditional update (optimistic locking): only applies if the row is
      // still in the status the caller last observed, closing the TOCTOU gap
      // where two concurrent requests could both act on a stale read of the
      // same attempt row.
      const update = await admin
        .from("medmar_issuing_attempts")
        .update(patch)
        .eq("id", id)
        .eq("status", expectedStatus)
        .select("*")
        .single();
      if (update.error || !update.data) {
        throw new Error("medmar_issue_attempt_conflict");
      }
      return normalizeAttempt(update.data as Record<string, unknown>);
    },

    async addEvent(input: MedmarIssueEventInput) {
      await admin.from("medmar_issuing_events").insert({
        tenant_id: input.tenantId,
        attempt_id: input.attemptId,
        service_id: input.serviceId ?? null,
        previous_status: input.previousStatus ?? null,
        new_status: input.newStatus,
        event_type: input.eventType,
        medmar_id_prenotazione: input.medmarIdPrenotazione ?? null,
        medmar_numero: input.medmarNumero ?? null,
        error_code: input.errorCode ?? null,
        details: input.details ?? {},
        created_by: input.createdBy ?? null,
      });
    },

    async loadServices(tenantId, serviceIds) {
      // La colonna reale in services e' "phone", non "customer_phone" — la
      // select precedente falliva sempre con 42703 (column does not exist),
      // bloccando /prepare per qualunque service_id. Alias mantenuto per
      // non toccare la shape MedmarIssueServiceRow usata a valle.
      const result = await admin
        .from("services")
        .select("id, tenant_id, customer_name, customer_email, customer_phone:phone, pax")
        .in("id", serviceIds)
        .eq("tenant_id", tenantId);
      if (result.error) throw new Error("medmar_issue_services_lookup_failed");
      return (result.data ?? []) as never;
    },
  };
}
