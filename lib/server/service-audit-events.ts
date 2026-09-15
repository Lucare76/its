import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Costanti applicative centralizzate per service_audit_events (Timeline
 * per-servizio) — un solo punto di verità per event_type/source, per evitare
 * stringhe libere inconsistenti tra i vari call site. Copre SOLO i gap reali
 * chiusi in questa prima implementazione (vedi supabase/migrations/0278):
 * restore, rimozione autista/veicolo fuori Piano Giorno, import con source
 * strutturato, approvazione/rifiuto agenzia, servizio creato da booking
 * group. Tutti gli altri eventi (status, bus, driver/vehicle ASSEGNATI,
 * cancellazione, whatsapp) restano sulle fonti esistenti — non replicarli
 * qui (vedi lib/server/service-timeline.ts per l'aggregazione in lettura).
 */
export const SERVICE_AUDIT_EVENT_TYPES = {
  SERVICE_RESTORED: "service_restored",
  DRIVER_REMOVED: "driver_removed",
  VEHICLE_REMOVED: "vehicle_removed",
  SERVICE_IMPORTED: "service_imported",
  AGENCY_APPROVED: "agency_approved",
  AGENCY_REJECTED: "agency_rejected",
  BOOKING_GROUP_SERVICE_CREATED: "booking_group_service_created",
  // Modello a due fasi (mai un solo evento "deleted" scritto DOPO il
  // delete): REQUESTED è scritto PRIMA di qualunque cancellazione
  // distruttiva del chunk — se il delete fallisce o l'evento COMPLETED non
  // può essere scritto, REQUESTED resta comunque come traccia forense.
  // Vedi app/api/ops/bulk-delete-services/route.ts.
  BULK_DELETE_REQUESTED: "bulk_delete_requested",
  BULK_DELETE_COMPLETED: "bulk_delete_completed",
} as const;

export type ServiceAuditEventType = (typeof SERVICE_AUDIT_EVENT_TYPES)[keyof typeof SERVICE_AUDIT_EVENT_TYPES];

export const SERVICE_AUDIT_SOURCES = {
  MANUAL: "manual",
  SYSTEM: "system",
  IMPORT_EXCEL: "import_excel",
  IMPORT_PDF: "import_pdf",
  IMPORT_EMAIL: "import_email",
  IMPORT_MTS_GLOBE: "import_mts_globe",
  AGENCY_PORTAL: "agency_portal",
  BOOKING_GROUP: "booking_group",
  BULK_DELETE: "bulk_delete",
} as const;

export type ServiceAuditSource = (typeof SERVICE_AUDIT_SOURCES)[keyof typeof SERVICE_AUDIT_SOURCES];

// Fase 11/Sicurezza: mai persistere token/secret/signed URL/payload completi
// in old_data/new_data/metadata, anche se un chiamante li passasse per
// errore. Allowlist negativa (deny-pattern) applicata a ogni chiave.
const DENY_KEY_PATTERN = /token|secret|password|authorization|signed_url|signature|api[_-]?key|access[_-]?token|payload|file[_-]?content|document[_-]?content/i;

export function sanitizeAuditData(input: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!input) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (DENY_KEY_PATTERN.test(key)) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Risoluzione nome operatore per i call site che NON hanno il contesto
 * AuthorizedPricingRequest completo (es. assign-service-core.ts, condiviso
 * anche dal tool MCP, riceve solo l'admin client + userId). Stesso principio
 * di getOperatorName (lib/server/service-audit-log.ts) ma senza dipendere
 * da quel tipo — snapshot del nome AL MOMENTO della scrittura (non risolto
 * a lettura, per restare coerente con l'audit storico anche se il profilo
 * cambia nome in seguito).
 */
export async function resolveOperatorNameByUserId(
  admin: SupabaseClient,
  tenantId: string,
  userId: string
): Promise<string | null> {
  const { data } = await admin.from("memberships").select("full_name").eq("tenant_id", tenantId).eq("user_id", userId).maybeSingle();
  const name = (data as { full_name?: string | null } | null)?.full_name;
  return name && name.trim() ? name.trim() : null;
}

export type ServiceAuditEventInput = {
  tenantId: string;
  serviceId: string;
  bookingId?: string | null;
  eventType: ServiceAuditEventType;
  source: ServiceAuditSource;
  actorUserId?: string | null;
  actorName?: string | null;
  actorEmail?: string | null;
  reason?: string | null;
  oldData?: Record<string, unknown> | null;
  newData?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
};

/**
 * Scrittura best-effort: stesso pattern di recordBusAssignmentFeedback
 * (lib/server/bus-assignment-feedback.ts) — un fallimento nel logging non
 * deve MAI bloccare o far fallire un'operazione principale già andata a
 * buon fine. Nessun retry, nessuna propagazione dell'errore al chiamante.
 */
export async function recordServiceAuditEvent(admin: SupabaseClient, input: ServiceAuditEventInput): Promise<void> {
  try {
    const { error } = await admin.from("service_audit_events").insert({
      tenant_id: input.tenantId,
      service_id: input.serviceId,
      booking_id: input.bookingId ?? null,
      event_type: input.eventType,
      source: input.source,
      actor_user_id: input.actorUserId ?? null,
      actor_name: input.actorName ?? null,
      actor_email: input.actorEmail ?? null,
      reason: input.reason ?? null,
      old_data: sanitizeAuditData(input.oldData),
      new_data: sanitizeAuditData(input.newData),
      metadata: sanitizeAuditData(input.metadata),
    });
    if (error) {
      console.error("[service-audit-events] insert fallito:", error.message);
    }
  } catch (err) {
    // Best-effort per davvero: anche un client/mock che non implementa
    // .insert() (o lancia sincronicamente) non deve mai far fallire
    // un'operazione già andata a buon fine.
    console.error("[service-audit-events] insert fallito:", err instanceof Error ? err.message : err);
  }
}

export type ServiceAuditEventsBatchResult = { ok: boolean; error?: string };

/**
 * Variante batch di recordServiceAuditEvent — stesso comportamento
 * best-effort (mai un throw), un solo insert invece di N (import bulk:
 * excel/operational-v2, più servizi creati in un'unica richiesta; bulk
 * delete: un evento per servizio cancellato). Applica lo stesso sanitizer
 * per ogni riga, mai un insert grezzo che lo bypassi.
 *
 * A differenza della prima versione (Promise<void>), ora restituisce l'esito
 * dell'insert: i chiamanti fire-and-forget esistenti (`void
 * recordServiceAuditEventsBatch(...)`) restano invariati (il valore di
 * ritorno resta ignorabile), mentre un chiamante per cui la persistenza
 * dell'audit è parte necessaria del successo dell'operazione (bulk-delete-
 * services) può ora verificarla esplicitamente.
 */
export async function recordServiceAuditEventsBatch(
  admin: SupabaseClient,
  inputs: ServiceAuditEventInput[]
): Promise<ServiceAuditEventsBatchResult> {
  if (inputs.length === 0) return { ok: true };
  try {
    const { error } = await admin.from("service_audit_events").insert(
      inputs.map((input) => ({
        tenant_id: input.tenantId,
        service_id: input.serviceId,
        booking_id: input.bookingId ?? null,
        event_type: input.eventType,
        source: input.source,
        actor_user_id: input.actorUserId ?? null,
        actor_name: input.actorName ?? null,
        actor_email: input.actorEmail ?? null,
        reason: input.reason ?? null,
        old_data: sanitizeAuditData(input.oldData),
        new_data: sanitizeAuditData(input.newData),
        metadata: sanitizeAuditData(input.metadata),
      }))
    );
    if (error) {
      console.error("[service-audit-events] batch insert fallito:", error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[service-audit-events] batch insert fallito:", message);
    return { ok: false, error: message };
  }
}
