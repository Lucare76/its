import type { SupabaseClient } from "@supabase/supabase-js";
import { auditLog } from "@/lib/server/ops-audit";
import { MEDMAR_ATTEMPT_LIVE_WINDOW_MS, MEDMAR_IN_PROGRESS_MESSAGE } from "@/lib/medmar-issuance-guard";

/**
 * Lock di concorrenza per l'emissione Medmar (tenant_id + service_id),
 * migration 0288. Separato di proposito da:
 *   - idempotenza (orchestratore, idempotency_key = service_ids ordinati);
 *   - prior issuance (lib/medmar-issuance-guard.ts, emissione già avvenuta).
 * Questo modulo risponde solo a "c'è un'altra emissione IN CORSO che
 * coinvolge uno di questi servizi?".
 *
 * TTL: 900s, sempre più lungo della durata massima di una Function Vercel
 * (800s): un lock non può scadere mentre la richiesta che lo detiene è
 * ancora viva, ma un'istanza terminata senza rilascio non blocca oltre.
 */

// Stessa finestra usata dal guard per considerare "in corso" un attempt in
// stato intermedio: oltre il TTL nessuna Function può più essere viva, quindi
// un attempt intermedio più vecchio è abbandonato e diventa "da verificare".
export const MEDMAR_ISSUANCE_LOCK_TTL_SECONDS = MEDMAR_ATTEMPT_LIVE_WINDOW_MS / 1000;

export const MEDMAR_ISSUANCE_LOCK_BUSY_MESSAGE = MEDMAR_IN_PROGRESS_MESSAGE;

export type MedmarIssuanceLockResult =
  | { acquired: true; lockToken: string; expiresAt: string | null }
  | { acquired: false; conflictingServiceIds: string[] };

type AcquireRow = {
  acquired: boolean;
  lock_token: string | null;
  conflicting_service_ids: string[] | null;
  expires_at: string | null;
};

/** Tutto-o-niente sull'intero gruppo. Lancia se la RPC fallisce: il chiamante deve fallire chiuso. */
export async function acquireMedmarIssuanceLock(
  admin: SupabaseClient,
  input: { tenantId: string; serviceIds: readonly string[]; holder: string }
): Promise<MedmarIssuanceLockResult> {
  const serviceIds = Array.from(new Set(input.serviceIds)).sort();
  const { data, error } = await admin.rpc("acquire_medmar_service_issuance_locks", {
    p_tenant_id: input.tenantId,
    p_service_ids: serviceIds,
    p_ttl_seconds: MEDMAR_ISSUANCE_LOCK_TTL_SECONDS,
    p_holder: input.holder,
  });
  if (error) throw new Error(`medmar_issuance_lock_acquire_failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as AcquireRow | null | undefined;
  if (!row) throw new Error("medmar_issuance_lock_acquire_failed: empty response");
  if (row.acquired && row.lock_token) {
    return { acquired: true, lockToken: row.lock_token, expiresAt: row.expires_at ?? null };
  }
  return { acquired: false, conflictingServiceIds: row.conflicting_service_ids ?? [] };
}

/**
 * Rilascio best-effort: mai un throw verso il chiamante (l'esito
 * dell'emissione non deve cambiare per un errore di rilascio). Se il
 * rilascio fallisce, il TTL libera comunque il lock.
 */
export async function releaseMedmarIssuanceLock(
  admin: SupabaseClient,
  input: { tenantId: string; lockToken: string; userId?: string | null }
): Promise<void> {
  try {
    const { error } = await admin.rpc("release_medmar_service_issuance_locks", {
      p_tenant_id: input.tenantId,
      p_lock_token: input.lockToken,
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    auditLog({
      event: "medmar_issuance_lock_release_failed",
      level: "error",
      tenantId: input.tenantId,
      userId: input.userId ?? null,
      details: { message: err instanceof Error ? err.message : "unknown", ttl_seconds: MEDMAR_ISSUANCE_LOCK_TTL_SECONDS },
    });
  }
}
