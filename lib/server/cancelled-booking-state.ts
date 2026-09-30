import type { SupabaseClient } from "@supabase/supabase-js";
import {
  PENALTY_SELECT,
  loadLatestCancellation,
  loadPenaltyServices,
  practiceLabel,
  resolvePenaltyRecipient,
  type PenaltyRow,
  type PenaltyServiceRow,
} from "@/lib/server/cancellation-penalty";
import { SERVICE_AUDIT_EVENT_TYPES } from "@/lib/server/service-audit-events";
import {
  MEDMAR_ATTEMPT_REMOTE_MUTATION_STATUSES,
  MEDMAR_ATTEMPT_REQUIRES_REVIEW_STATUSES,
  MEDMAR_ISSUANCE_PROOF_ATTEMPT_STATUS,
} from "@/lib/medmar-issuance-guard";

/**
 * Stato "derivato" delle prenotazioni cancellate/ripristinate, ricavato solo
 * da tabelle di storico (nessun flag su services, scelta esplicita):
 *   - penale attiva / ultima annullata  → service_cancellation_penalties
 *   - "Ripristinata – da riassegnare"   → service_audit_events (service_restored,
 *     reason restore_booking) più recente dell'ultima cancellazione, con il
 *     servizio ancora in stato 'new' e senza assignment/allocazione bus.
 */

export type PenaltySummary = Pick<
  PenaltyRow,
  | "id" | "service_id" | "linked_service_id" | "scope" | "penalty_type" | "penalty_percentage" | "penalty_amount_cents"
  | "penalty_notes" | "status" | "applied_at" | "applied_by_name" | "voided_at" | "voided_by_name" | "void_reason"
  | "email_kind" | "email_status" | "email_recipient" | "email_sent_at" | "email_attempts" | "email_last_error"
  | "void_email_status" | "void_email_recipient" | "void_email_sent_at" | "void_email_last_error"
>;

export type RestoreSummary = {
  restored_at: string;
  restored_by: string | null;
  needs_reassignment: boolean;
};

export type CancelledBookingState = {
  active_penalty: PenaltySummary | null;
  // Ultima penale annullata con comunicazione di annullamento ancora da
  // completare (per mostrare "Reinvia email" anche dopo un ripristino).
  pending_void_penalty: PenaltySummary | null;
  restored: RestoreSummary | null;
};

// Stati di un issuing attempt Medmar in cui un biglietto può esistere lato
// Medmar (o non si può escludere): stessa classificazione del guard di
// emissione (lib/medmar-issuance-guard.ts) — emesso, da verificare, o
// successivo alla prima mutazione remota.
export const MEDMAR_RISKY_ATTEMPT_STATUSES = [
  MEDMAR_ISSUANCE_PROOF_ATTEMPT_STATUS,
  ...MEDMAR_ATTEMPT_REQUIRES_REVIEW_STATUSES,
  ...MEDMAR_ATTEMPT_REMOTE_MUTATION_STATUSES,
] as const;

function toSummary(row: PenaltyRow): PenaltySummary {
  return {
    id: row.id,
    service_id: row.service_id,
    linked_service_id: row.linked_service_id,
    scope: row.scope,
    penalty_type: row.penalty_type,
    penalty_percentage: row.penalty_percentage,
    penalty_amount_cents: row.penalty_amount_cents,
    penalty_notes: row.penalty_notes,
    status: row.status,
    applied_at: row.applied_at,
    applied_by_name: row.applied_by_name,
    voided_at: row.voided_at,
    voided_by_name: row.voided_by_name,
    void_reason: row.void_reason,
    email_kind: row.email_kind,
    email_status: row.email_status,
    email_recipient: row.email_recipient,
    email_sent_at: row.email_sent_at,
    email_attempts: row.email_attempts,
    email_last_error: row.email_last_error,
    void_email_status: row.void_email_status,
    void_email_recipient: row.void_email_recipient,
    void_email_sent_at: row.void_email_sent_at,
    void_email_last_error: row.void_email_last_error,
  };
}

function touches(row: Pick<PenaltyRow, "service_id" | "linked_service_id">, serviceId: string) {
  return row.service_id === serviceId || row.linked_service_id === serviceId;
}

export async function loadPenaltiesTouching(admin: SupabaseClient, tenantId: string, serviceIds: string[]): Promise<PenaltyRow[]> {
  const ids = Array.from(new Set(serviceIds.filter(Boolean)));
  if (ids.length === 0) return [];
  const list = ids.join(",");
  const { data, error } = await admin
    .from("service_cancellation_penalties")
    .select(PENALTY_SELECT)
    .eq("tenant_id", tenantId)
    .or(`service_id.in.(${list}),linked_service_id.in.(${list})`)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as PenaltyRow[];
}

const PENDING_VOID_STATUSES = new Set(["pending", "sending", "failed", "skipped", "no_recipient"]);

export async function loadCancelledBookingStates(
  admin: SupabaseClient,
  tenantId: string,
  serviceIds: string[]
): Promise<Record<string, CancelledBookingState>> {
  const ids = Array.from(new Set(serviceIds.filter(Boolean))).slice(0, 200);
  const out: Record<string, CancelledBookingState> = {};
  if (ids.length === 0) return out;

  const [penalties, restoreEventsResult, servicesResult, cancellations] = await Promise.all([
    loadPenaltiesTouching(admin, tenantId, ids),
    admin
      .from("service_audit_events")
      .select("service_id, actor_name, created_at")
      .eq("tenant_id", tenantId)
      .eq("event_type", SERVICE_AUDIT_EVENT_TYPES.SERVICE_RESTORED)
      .eq("reason", "restore_booking")
      .in("service_id", ids)
      .order("created_at", { ascending: false }),
    admin.from("services").select("id, status").eq("tenant_id", tenantId).in("id", ids),
    loadLatestCancellation(admin, tenantId, ids),
  ]);

  const statusById = new Map(((servicesResult.data ?? []) as Array<{ id: string; status: string }>).map((s) => [s.id, s.status]));
  const latestRestore = new Map<string, { created_at: string; actor_name: string | null }>();
  for (const ev of (restoreEventsResult.data ?? []) as Array<{ service_id: string; actor_name: string | null; created_at: string }>) {
    if (!latestRestore.has(ev.service_id)) latestRestore.set(ev.service_id, ev);
  }

  const restoredCandidates = ids.filter((id) => {
    const restore = latestRestore.get(id);
    if (!restore || statusById.get(id) === "cancelled") return false;
    const cancelledAt = cancellations.get(id)?.cancelled_at;
    return !cancelledAt || new Date(restore.created_at).getTime() >= new Date(cancelledAt).getTime();
  });

  const assignedIds = new Set<string>();
  if (restoredCandidates.length) {
    const [assignmentsResult, busResult] = await Promise.all([
      admin.from("assignments").select("service_id").eq("tenant_id", tenantId).in("service_id", restoredCandidates),
      admin.from("tenant_bus_allocations").select("service_id").eq("tenant_id", tenantId).in("service_id", restoredCandidates),
    ]);
    for (const row of [...(assignmentsResult.data ?? []), ...(busResult.data ?? [])] as Array<{ service_id: string }>) {
      assignedIds.add(row.service_id);
    }
  }

  for (const id of ids) {
    const mine = penalties.filter((p) => touches(p, id));
    const active = mine.find((p) => p.status === "active") ?? null;
    const pendingVoid = mine.find((p) => p.status === "voided" && p.void_email_status && PENDING_VOID_STATUSES.has(p.void_email_status)) ?? null;
    const restore = restoredCandidates.includes(id) ? latestRestore.get(id) ?? null : null;
    out[id] = {
      active_penalty: active ? toSummary(active) : null,
      pending_void_penalty: pendingVoid ? toSummary(pendingVoid) : null,
      restored: restore
        ? {
            restored_at: restore.created_at,
            restored_by: restore.actor_name,
            needs_reassignment: statusById.get(id) === "new" && !assignedIds.has(id),
          }
        : null,
    };
  }
  return out;
}

export type MedmarRestoreWarning = {
  service_id: string;
  ticket_sent_at: string | null;
  issuing_attempt_status: string | null;
  medmar_numero: string | null;
};

export async function loadMedmarWarnings(
  admin: SupabaseClient,
  tenantId: string,
  services: Array<Pick<PenaltyServiceRow, "id" | "medmar_ticket_sent_at">>
): Promise<MedmarRestoreWarning[]> {
  const ids = services.map((s) => s.id);
  if (ids.length === 0) return [];
  const { data } = await admin
    .from("medmar_issuing_attempts")
    .select("service_ids, status, medmar_numero, updated_at")
    .eq("tenant_id", tenantId)
    .overlaps("service_ids", ids)
    .in("status", [...MEDMAR_RISKY_ATTEMPT_STATUSES])
    .order("updated_at", { ascending: false });
  const attempts = (data ?? []) as Array<{ service_ids: string[]; status: string; medmar_numero: string | null }>;
  const warnings: MedmarRestoreWarning[] = [];
  for (const service of services) {
    const attempt = attempts.find((a) => (a.service_ids ?? []).includes(service.id)) ?? null;
    if (!service.medmar_ticket_sent_at && !attempt) continue;
    warnings.push({
      service_id: service.id,
      ticket_sent_at: service.medmar_ticket_sent_at ?? null,
      issuing_attempt_status: attempt?.status ?? null,
      medmar_numero: attempt?.medmar_numero ?? null,
    });
  }
  return warnings;
}

function serviceSummary(service: PenaltyServiceRow) {
  const agency = Array.isArray(service.agencies) ? service.agencies[0] : service.agencies;
  const hotel = Array.isArray(service.hotels) ? service.hotels[0] : service.hotels;
  return {
    id: service.id,
    status: service.status,
    customer_name: service.customer_name,
    practice_label: practiceLabel(service),
    direction: service.direction,
    date: service.date,
    arrival_date: service.arrival_date,
    departure_date: service.departure_date,
    booking_service_kind: service.booking_service_kind,
    pax: service.pax,
    agency_name: agency?.name ?? service.billing_party_name ?? null,
    hotel_name: hotel?.name ?? null,
    linked_service_id: service.linked_service_id,
  };
}

export async function loadServiceCancellationDetail(admin: SupabaseClient, tenantId: string, serviceId: string) {
  const [main] = await loadPenaltyServices(admin, tenantId, [serviceId]);
  if (!main) return null;
  const linked = main.linked_service_id ? (await loadPenaltyServices(admin, tenantId, [main.linked_service_id]))[0] ?? null : null;
  const ids = [main.id, linked?.id].filter((id): id is string => Boolean(id));

  const [penalties, cancellations, medmar, recipient, legacyRequests] = await Promise.all([
    loadPenaltiesTouching(admin, tenantId, ids),
    loadLatestCancellation(admin, tenantId, ids),
    loadMedmarWarnings(admin, tenantId, [main, ...(linked ? [linked] : [])]),
    resolvePenaltyRecipient(admin, tenantId, main),
    admin
      .from("cancellation_requests")
      .select("id, status, penalty_cents, penalty_note, resolved_at")
      .eq("tenant_id", tenantId)
      .in("service_id", ids)
      .not("penalty_cents", "is", null)
      .gt("penalty_cents", 0)
      .order("created_at", { ascending: false }),
  ]);

  return {
    service: serviceSummary(main),
    linked_service: linked ? serviceSummary(linked) : null,
    cancellation: Object.fromEntries(ids.map((id) => [id, cancellations.get(id) ?? null])),
    active_penalties: penalties.filter((p) => p.status === "active").map(toSummary),
    penalty_history: penalties.map(toSummary),
    medmar_warnings: medmar,
    agency_recipient: { email: recipient.email, agency_name: recipient.agencyName, source: recipient.source },
    // Penale registrata col vecchio flusso richieste (cancellation_requests):
    // mostrata come avviso per evitare una doppia penale sulla stessa pratica.
    legacy_request_penalties: (legacyRequests.data ?? []) as Array<{ id: string; status: string; penalty_cents: number; penalty_note: string | null; resolved_at: string | null }>,
  };
}

export type ServiceCancellationDetail = NonNullable<Awaited<ReturnType<typeof loadServiceCancellationDetail>>>;
