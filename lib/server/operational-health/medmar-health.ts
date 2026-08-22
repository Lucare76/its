/**
 * Operational Health — Medmar delivery (Sprint 3, area "medmar").
 *
 * Read-only sopra medmar_delivery_attempts (state machine gia' esistente,
 * vedi lib/server/medmar-booking/delivery-types.ts). NON emette biglietti,
 * NON reinvia, NON rilancia retry, NON cambia stato — osserva soltanto gli
 * stati REALMENTE prodotti dal flusso di emissione/consegna gia' in
 * produzione (lib/server/medmar-booking/delivery-retry.ts).
 *
 * Significato esatto dei termini usati nei segnali (per non usare parole
 * piu' forti di quanto i dati garantiscano):
 * - "emesso" = esiste un medmar_issuing_attempts.status === 'completed'.
 * - "consegna"/"invio" = stato di medmar_delivery_attempts. 'delivered'
 *   significa solo che l'invio email e' stato accettato dal provider
 *   (Resend) — i dati disponibili non permettono di distinguere "inviato"
 *   da "aperto/letto dal cliente", quindi non si usa mai la parola
 *   "consegnato" nel senso di "ricevuto dal cliente", solo "invio riuscito".
 * - RETRYABLE_DELIVERY_STATUSES (awaiting_pdf, pdf_not_found, pdf_found) e
 *   "delivery_started" sono stati non terminali: il sistema li ritenta
 *   automaticamente (o li sta processando in modo sincrono).
 * - MEDMAR_SUMMARY_ERROR_STATUSES (pdf_ambiguous, pdf_validation_failed,
 *   recipient_missing, delivery_failed, delivery_state_unknown,
 *   manual_review) sono stati che il retry automatico NON tocca piu' (vedi
 *   RETRYABLE_DELIVERY_STATUSES in delivery-types.ts): da qui in poi serve
 *   un intervento umano, quindi sono trattati come "invio definitivamente
 *   fallito" nel senso di "il sistema ha smesso di ritentare da solo".
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MEDMAR_DELIVERY_RETRY_MAX_ATTEMPTS,
  MEDMAR_DELIVERY_RETRY_MIN_INTERVAL_MS,
} from "@/lib/server/medmar-booking/delivery-retry";
import { MEDMAR_SUMMARY_ERROR_STATUSES } from "@/lib/server/medmar-booking/delivery-summary";
import type { MedmarDeliveryStatus } from "@/lib/server/medmar-booking/delivery-types";
import type { OperationalHealthAreaResult, OperationalHealthSignal } from "./types";

/**
 * Soglia "pending oltre il ragionevole" derivata direttamente dalle
 * costanti gia' esistenti del retry automatico (non una SLA inventata): e'
 * il tempo minimo teorico perche' il retry esaurisca tutti i tentativi
 * automatici (MAX_ATTEMPTS al MIN_INTERVAL tra un tentativo e l'altro). Un
 * record ancora "in attesa" oltre questa soglia significa che il retry non
 * sta avanzando come previsto dal design del flusso stesso.
 */
export const MEDMAR_PENDING_WARNING_MS = MEDMAR_DELIVERY_RETRY_MAX_ATTEMPTS * MEDMAR_DELIVERY_RETRY_MIN_INTERVAL_MS;

export type MedmarDeliveryHealthRow = {
  id: string;
  status: MedmarDeliveryStatus;
  created_at: string;
  updated_at: string;
  medmar_numero: string | null;
  last_error_code: string | null;
};

/** Numero massimo di righe lette dal DB per il reader — vedi readMedmarOperationalHealth. */
export const MEDMAR_HEALTH_QUERY_LIMIT = 200;

/**
 * Pura — valuta le righe gia' caricate (nessun accesso DB qui, stesso
 * pattern di summarizeMedmarDeliveryAttempts). Le righe 'delivered' non
 * producono mai un segnale (sane).
 */
export function evaluateMedmarDeliveryRows(
  rows: readonly MedmarDeliveryHealthRow[],
  now: Date
): OperationalHealthSignal[] {
  const detectedAt = now.toISOString();
  const signals: OperationalHealthSignal[] = [];

  for (const row of rows) {
    if (row.status === "delivered") continue;

    if (MEDMAR_SUMMARY_ERROR_STATUSES.has(row.status)) {
      signals.push({
        key: `medmar:delivery_failed:${row.id}`,
        area: "medmar",
        severity: "critical",
        title: "Invio biglietto Medmar non riuscito",
        message: `Biglietto Medmar${row.medmar_numero ? ` ${row.medmar_numero}` : ""} emesso ma invio non riuscito (stato: ${row.status}), retry automatico esaurito: richiede revisione manuale.`,
        detectedAt,
        entityId: row.medmar_numero ?? row.id,
        metadata: { delivery_attempt_id: row.id, status: row.status, last_error_code: row.last_error_code },
      });
      continue;
    }

    // Da qui: stati non terminali (retryable o delivery_started/in corso).
    const ageMs = now.getTime() - new Date(row.created_at).getTime();

    if (ageMs > MEDMAR_PENDING_WARNING_MS) {
      signals.push({
        key: `medmar:delivery_pending:${row.id}`,
        area: "medmar",
        severity: "warning",
        title: "Invio biglietto Medmar in attesa da tempo",
        message: `Biglietto Medmar${row.medmar_numero ? ` ${row.medmar_numero}` : ""} emesso ma invio ancora in attesa (stato: ${row.status}) da oltre ${Math.round(MEDMAR_PENDING_WARNING_MS / 60000)} minuti.`,
        detectedAt,
        entityId: row.medmar_numero ?? row.id,
        metadata: { delivery_attempt_id: row.id, status: row.status, age_minutes: Math.round(ageMs / 60000) },
      });
    } else {
      signals.push({
        key: `medmar:delivery_in_progress:${row.id}`,
        area: "medmar",
        severity: "info",
        title: "Invio biglietto Medmar in corso",
        message: `Biglietto Medmar${row.medmar_numero ? ` ${row.medmar_numero}` : ""} in fase di invio (stato: ${row.status}), retry entro la normale finestra prevista.`,
        detectedAt,
        entityId: row.medmar_numero ?? row.id,
        metadata: { delivery_attempt_id: row.id, status: row.status },
      });
    }
  }

  return signals;
}

/**
 * I/O — legge solo i delivery attempt NON 'delivered' (i "sani" non
 * producono segnali comunque), limitati e ordinati dal piu' vecchio (i piu'
 * urgenti) per restare entro un costo di query prevedibile — vedi
 * MEDMAR_HEALTH_QUERY_LIMIT. Nessuna mutazione, nessuna chiamata Medmar.
 */
export async function readMedmarOperationalHealth(
  admin: SupabaseClient,
  tenantId: string,
  now: Date
): Promise<OperationalHealthAreaResult> {
  const { data, error } = await admin
    .from("medmar_delivery_attempts")
    .select("id, status, created_at, updated_at, medmar_numero, last_error_code")
    .eq("tenant_id", tenantId)
    .neq("status", "delivered")
    .order("created_at", { ascending: true })
    .limit(MEDMAR_HEALTH_QUERY_LIMIT);

  if (error) {
    return { area: "medmar", available: false, error: "Salute delivery Medmar non disponibile.", signals: [] };
  }

  return {
    area: "medmar",
    available: true,
    signals: evaluateMedmarDeliveryRows((data ?? []) as MedmarDeliveryHealthRow[], now),
  };
}
