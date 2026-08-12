import type { SupabaseClient } from "@supabase/supabase-js";

export class MedmarConfirmationInvalidError extends Error {
  constructor(message = "Token di conferma non valido, scaduto o gia usato.") {
    super(message);
    this.name = "MedmarConfirmationInvalidError";
  }
}

export type MedmarIssueConfirmation = {
  id: string;
  tenant_id: string;
  token: string;
  service_ids: string[];
  expected_total_cents: number;
  expires_at: string;
};

export async function createConfirmationToken(
  admin: SupabaseClient,
  input: {
    tenantId: string;
    serviceIds: string[];
    expectedTotalCents: number;
    routeSnapshot: unknown;
    createdBy: string;
  }
): Promise<{ confirmation_token: string; expires_at: string }> {
  const sortedServiceIds = [...input.serviceIds].sort();
  const insert = await admin
    .from("medmar_issue_confirmations")
    .insert({
      tenant_id: input.tenantId,
      service_ids: sortedServiceIds,
      expected_total_cents: input.expectedTotalCents,
      route_snapshot: input.routeSnapshot ?? {},
      created_by: input.createdBy,
    })
    .select("token, expires_at")
    .single();
  if (insert.error || !insert.data) {
    throw new Error("medmar_issue_confirmation_create_failed");
  }
  return {
    confirmation_token: insert.data.token as string,
    expires_at: insert.data.expires_at as string,
  };
}

/**
 * Consuma atomicamente un confirmation_token: single-use via
 * `used_at is null`, scadenza verificata lato DB (`expires_at > now()`) in
 * una singola UPDATE condizionale, cosi' due richieste concorrenti con lo
 * stesso token non possono entrambe superare il gate.
 */
export async function consumeConfirmationToken(
  admin: SupabaseClient,
  input: { tenantId: string; token: string; serviceIds: string[] }
): Promise<MedmarIssueConfirmation> {
  const nowIso = new Date().toISOString();
  const update = await admin
    .from("medmar_issue_confirmations")
    .update({ used_at: nowIso })
    .eq("token", input.token)
    .eq("tenant_id", input.tenantId)
    .is("used_at", null)
    .gt("expires_at", nowIso)
    .select("*")
    .maybeSingle();
  if (update.error || !update.data) {
    throw new MedmarConfirmationInvalidError();
  }
  const row = update.data as Record<string, unknown>;
  const sortedRequested = [...input.serviceIds].sort();
  const sortedStored = Array.isArray(row.service_ids) ? [...(row.service_ids as string[])].sort() : [];
  if (JSON.stringify(sortedRequested) !== JSON.stringify(sortedStored)) {
    throw new MedmarConfirmationInvalidError("Token di conferma non corrisponde ai servizi richiesti.");
  }
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    token: String(row.token),
    service_ids: sortedStored,
    expected_total_cents: Number(row.expected_total_cents),
    expires_at: String(row.expires_at),
  };
}
