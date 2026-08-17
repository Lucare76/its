/**
 * Core condiviso per l'aggiornamento controllato di services.status.
 *
 * MCP Sprint 3. A differenza di assignServiceCore (estratto da una route HTTP
 * preesistente), qui NON esiste una route HTTP unica e affidabile da cui
 * estrarre: l'audit ha trovato più percorsi che scrivono services.status
 * (app/api/ops/driver-status/route.ts, app/api/scan/[serviceId]/route.ts,
 * app/api/ops/piano-giorno/trips/route.ts, il workflow di cancellazione), il
 * più vicino concettualmente (driver-status) è permissivo per design (nessuna
 * verifica dello stato di origine) e contiene un valore bug ("attesa", non
 * presente nell'enum reale ServiceStatus né nell'enum Postgres
 * public.service_status). Questo modulo è quindi un core NUOVO, scritto per
 * essere usato dal tool MCP, che riusa lo STESSO shape di scrittura già in
 * produzione (services.update({status}) + status_events insert con
 * tenant_id/service_id/status/by_user_id) — nessun campo nuovo, nessuna
 * business rule inventata — aggiungendo solo ciò che oggi non esiste in
 * nessuna route: una funzione di validazione transizione esplicita,
 * progettata per essere permissiva quanto il comportamento reale osservato
 * (nessuna transizione oggi raggiungibile viene bloccata) più i soli due
 * blocchi impliciti nei dati stessi:
 *  - stati terminali (completato/cancelled): nessuna route trovata
 *    nell'audit transiziona MAI fuori da questi due stati;
 *  - pending_cancellation/cancelled come target diretto: appartengono al
 *    workflow dedicato di cancellazione (app/api/ops/cancellation-requests/*),
 *    che scrive anche cancellation_requests e note dedicate — impostarli qui
 *    salterebbe quei side effect, non li "restringerebbe" arbitrariamente.
 *  - needs_review: stato della pipeline di import, nessuna evidenza di un
 *    percorso operativo che lo imposti manualmente.
 *
 * status_events: upsert con onConflict "tenant_id,service_id,status" +
 * ignoreDuplicates, lo stesso pattern già in uso da assignServiceCore (non
 * il semplice insert di driver-status/route.ts, che infatti duplica righe
 * identiche ad ogni chiamata — comportamento non riprodotto qui).
 */
import { type SupabaseClient } from "@supabase/supabase-js";
import type { ServiceStatus } from "@/lib/types";

export type UpdateServiceStatusOutcome = { status: number; body: Record<string, unknown> };

// Tutti gli 11 valori reali dell'enum (lib/types.ts:33), usato per validare
// che targetStatus sia sintatticamente un vero stato di dominio (rifiuta
// "attesa" e qualunque altra stringa non reale) prima di decidere se è anche
// impostabile tramite questo core.
export const ALL_SERVICE_STATUSES = [
  "needs_review", "new", "assigned", "partito", "arrivato", "caricato",
  "scaricato", "completato", "problema", "cancelled", "pending_cancellation",
] as const satisfies readonly ServiceStatus[];

// Sottoinsieme impostabile tramite questo core (vedi commento di modulo).
export const MCP_SETTABLE_STATUSES = [
  "new", "assigned", "partito", "arrivato", "caricato", "scaricato", "completato", "problema",
] as const satisfies readonly ServiceStatus[];
export type McpSettableStatus = (typeof MCP_SETTABLE_STATUSES)[number];

const TERMINAL_STATUSES = new Set<string>(["completato", "cancelled"]);

// Stati "di percorso operativo" per cui l'assenza di un'assegnazione autista
// è degna di segnalazione (warning, non bloccante — nessuna route trovata
// nell'audit impedisce comunque questa transizione se non assegnato).
const OPERATIONAL_JOURNEY_STATUSES = new Set<string>(["partito", "arrivato", "caricato", "scaricato", "completato"]);

export type TransitionCheckResult =
  | { allowed: true }
  | { allowed: false; code: "SERVICE_STATUS_TERMINAL" | "TARGET_STATUS_NOT_SETTABLE"; message: string };

export function checkStatusTransitionAllowed(currentStatus: string, targetStatus: string): TransitionCheckResult {
  if (!(MCP_SETTABLE_STATUSES as readonly string[]).includes(targetStatus)) {
    return {
      allowed: false,
      code: "TARGET_STATUS_NOT_SETTABLE",
      message: "Questo stato non può essere impostato da questa funzione (gestito da un flusso dedicato, es. cancellazione).",
    };
  }
  if (currentStatus !== targetStatus && TERMINAL_STATUSES.has(currentStatus)) {
    return {
      allowed: false,
      code: "SERVICE_STATUS_TERMINAL",
      message: "Il servizio è in uno stato definitivo e non può essere modificato.",
    };
  }
  return { allowed: true };
}

export function serviceLacksAssignmentWarningApplicable(targetStatus: string): boolean {
  return OPERATIONAL_JOURNEY_STATUSES.has(targetStatus);
}

export type UpdateServiceStatusParams = {
  tenantId: string;
  userId: string;
  serviceId: string;
  targetStatus: McpSettableStatus;
  /**
   * Snapshot dello stato letto al momento della preview. Se presente, la
   * scrittura è condizionale (WHERE ... AND status = expectedCurrentStatus,
   * FASE 19): chiude la finestra tra la SELECT di verifica e la UPDATE — due
   * esecuzioni concorrenti che partono dallo stesso stato non possono
   * entrambe avere successo silenziosamente, solo la prima.
   */
  expectedCurrentStatus?: string | null;
};

export async function updateServiceStatusCore(
  admin: SupabaseClient,
  params: UpdateServiceStatusParams
): Promise<UpdateServiceStatusOutcome> {
  const { tenantId, userId, serviceId, targetStatus, expectedCurrentStatus } = params;

  const { data: serviceRow, error: serviceError } = await admin
    .from("services")
    .select("id, status")
    .eq("id", serviceId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (serviceError) {
    return { status: 500, body: { ok: false, error: "SERVICE_STATUS_CHECK_FAILED", message: "Errore durante la verifica del servizio." } };
  }
  if (!serviceRow) {
    return { status: 404, body: { ok: false, error: "SERVICE_NOT_FOUND", message: "Servizio non trovato." } };
  }

  const liveStatus = serviceRow.status as string;

  const transitionCheck = checkStatusTransitionAllowed(liveStatus, targetStatus);
  if (!transitionCheck.allowed) {
    return { status: 409, body: { ok: false, error: transitionCheck.code, message: transitionCheck.message } };
  }

  const isNoOp = liveStatus === targetStatus;

  let updateQuery = admin.from("services").update({ status: targetStatus }).eq("id", serviceId).eq("tenant_id", tenantId);
  if (expectedCurrentStatus != null) {
    updateQuery = updateQuery.eq("status", expectedCurrentStatus);
  }
  const { data: updatedRows, error: updateError } = await updateQuery.select("id");
  if (updateError) {
    return { status: 500, body: { ok: false, error: "SERVICE_STATUS_UPDATE_FAILED", message: "Errore durante l'aggiornamento dello stato." } };
  }
  if (expectedCurrentStatus != null && (!updatedRows || updatedRows.length === 0)) {
    return { status: 409, body: { ok: false, error: "STATUS_STALE", message: "Lo stato del servizio è cambiato dall'ultima verifica." } };
  }

  const { error: eventError } = await admin.from("status_events").upsert(
    { tenant_id: tenantId, service_id: serviceId, status: targetStatus, by_user_id: userId },
    { onConflict: "tenant_id,service_id,status", ignoreDuplicates: true }
  );
  if (eventError) {
    // Non critico (stesso comportamento di driver-status/route.ts): lo stato
    // è già stato aggiornato, un fallimento qui non deve annullare la
    // scrittura principale né bloccare la risposta.
    console.error("[update-service-status-core] status_events upsert error:", eventError.message);
  }

  return { status: 200, body: { ok: true, status: targetStatus, no_op: isNoOp } };
}
