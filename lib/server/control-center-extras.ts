/**
 * Centro Operativo / Controllo Giornata — supporto READ-ONLY minimo.
 *
 * Copre SOLO le lacune che l'audit ha confermato non avere già un endpoint
 * riutilizzabile:
 *  - "servizi strutturalmente assegnabili ancora senza autista": incrocia la
 *    classificazione ESISTENTE di piano-unassigned-services-diagnostics.ts
 *    (che NON considera lo stato di assegnazione — vedi nota lì sotto) con
 *    la tabella assignments;
 *  - prenotazioni agenzia in attesa di approvazione operatore;
 *  - richieste di cancellazione in attesa;
 *  - WhatsApp con stato normalizzato realmente "failed" per il kind
 *    "info_3d" (l'unico kind attivo e associabile in modo affidabile alla
 *    giornata per i trasferimenti standard — vedi WHATSAPP_CONTROL_CENTER_KIND).
 *
 * Solo funzioni pure qui dentro: nessuna query Supabase, nessuna modifica a
 * dati, nessuna reimplementazione di resolveAssignableService, delle
 * finestre temporali di operations-health.ts, o della logica WhatsApp. Le
 * query vivono nella route (stesso stile di unassigned-diagnostics/route.ts
 * e group-diagnostics/route.ts), cosi' queste funzioni restano testabili
 * senza mock di Supabase.
 */
import type { UnassignedDiagnosticsResult } from "@/lib/piano-unassigned-services-diagnostics";
import { isNewerStatus, normalizeStatusGroup } from "@/lib/server/whatsapp-log-shared";

// ─── Servizi strutturalmente assegnabili ancora senza autista ────────────

export type AssignableUnassignedService = {
  service_id: string;
  customer_name: string | null;
  operational_time: string | null;
  pax: number | null;
};

export type AssignableUnassignedResult = {
  assignable_count: number;
  assignable_unassigned_count: number;
  assignable_unassigned: AssignableUnassignedService[];
};

/**
 * `stops` viene da buildUnassignedServicesDiagnostics(...).stops — il set
 * completo dei servizi già filtrati da quella funzione come
 * `assignable && !needs_review` (vedi lib/piano-unassigned-services-diagnostics.ts),
 * ma SENZA alcuna nozione di chi abbia già un autista: quella funzione
 * classifica per tipo, non per stato di assegnazione.
 *
 * `assignedServiceIdsWithDriver` deve contenere solo i service_id con una
 * riga in `assignments` il cui `driver_user_id` NON è nullo — dalla
 * migration 0137, `assignments.driver_user_id` è nullable (un giro puo'
 * esistere con mezzo assegnato e autista ancora da definire), quindi la
 * sola presenza di una riga in `assignments` non basta a dire "assegnato".
 */
export function computeAssignableUnassigned(
  stops: UnassignedDiagnosticsResult["stops"],
  assignedServiceIdsWithDriver: ReadonlySet<string>
): AssignableUnassignedResult {
  const all = stops.flatMap((stop) => stop.services);
  const unassigned = all.filter((service) => !assignedServiceIdsWithDriver.has(service.service_id));
  return {
    assignable_count: all.length,
    assignable_unassigned_count: unassigned.length,
    assignable_unassigned: unassigned.map((service) => ({
      service_id: service.service_id,
      customer_name: service.customer_name ?? null,
      operational_time: service.operational_time ?? null,
      pax: service.pax ?? null,
    })),
  };
}

// ─── Prenotazioni agenzia in attesa di approvazione operatore ─────────────

export type PendingAgencyApprovalItem = {
  service_id: string;
  customer_name: string | null;
  date: string | null;
  created_at: string | null;
  token_expires_at: string | null;
};

export type PendingAgencyApprovalsResult = {
  count: number;
  items: PendingAgencyApprovalItem[];
};

/**
 * `services` deve già contenere solo righe con approval_status='pending_operator'
 * oppure l'intero set del tenant (la funzione filtra comunque, per sicurezza
 * e per restare testabile in isolamento).
 */
export function evaluatePendingAgencyApprovals(
  services: Array<{
    id: string;
    customer_name: string | null;
    date: string | null;
    created_at: string | null;
    approval_status: string | null;
  }>,
  tokenExpiryByServiceId: ReadonlyMap<string, string | null>
): PendingAgencyApprovalsResult {
  const pending = services.filter((service) => service.approval_status === "pending_operator");
  return {
    count: pending.length,
    items: pending.map((service) => ({
      service_id: service.id,
      customer_name: service.customer_name,
      date: service.date,
      created_at: service.created_at,
      token_expires_at: tokenExpiryByServiceId.get(service.id) ?? null,
    })),
  };
}

// Nota: la soglia di urgenza (token vicino/oltre scadenza) è un dettaglio di
// SEVERITÀ, non di lettura dati — vive in lib/control-center-severity.ts
// (hasAgencyApprovalNearOrPastExpiry), che è client-safe e importabile
// direttamente dalla pagina "use client" senza tirare dentro lib/server/*.

// ─── Richieste di cancellazione in attesa ──────────────────────────────────

export type PendingCancellationItem = {
  id: string;
  service_id: string;
  status: string;
  created_at: string | null;
};

export type PendingCancellationsResult = {
  count: number;
  items: PendingCancellationItem[];
};

const PENDING_CANCELLATION_STATUSES = new Set(["pending_review", "pending_agency_approval"]);

export function evaluatePendingCancellationRequests(
  rows: Array<{ id: string; service_id: string; status: string; created_at: string | null }>
): PendingCancellationsResult {
  const pending = rows.filter((row) => PENDING_CANCELLATION_STATUSES.has(row.status));
  return {
    count: pending.length,
    items: pending.map((row) => ({
      id: row.id,
      service_id: row.service_id,
      status: row.status,
      created_at: row.created_at,
    })),
  };
}

// ─── WhatsApp falliti (kind "info_3d" soltanto) ────────────────────────────

/**
 * Unico kind di whatsapp_events attivo E associabile in modo affidabile alla
 * giornata di un servizio per i trasferimenti standard:
 *  - "info_3d" è scritto da /api/cron/whatsapp-info, registrato in
 *    vercel.json e sempre corredato di service_id (payload_json.arrival_date
 *    = services.date), quindi joinabile con certezza sulla giornata;
 *  - i kind "48h_departure"/"24h"/"2h" esistono nel codice
 *    (app/api/cron/whatsapp-reminders/route.ts) ma quel cron NON è
 *    registrato in vercel.json: non produce eventi in produzione oggi, e non
 *    va usato come fonte (verificato in fase di audit, non riattivato qui).
 */
export const WHATSAPP_CONTROL_CENTER_KIND = "info_3d";

export type WhatsAppFailedItem = {
  service_id: string;
  to_phone: string | null;
  template: string | null;
  status: string;
  happened_at: string;
};

export type WhatsAppFailedResult = {
  count: number;
  items: WhatsAppFailedItem[];
};

/**
 * Riusa isNewerStatus/normalizeStatusGroup — le stesse funzioni condivise già
 * usate da /api/ops/whatsapp-log (lib/server/whatsapp-log-shared.ts) — per
 * tenere, per ogni servizio, solo lo stato più recente prima di giudicarlo
 * fallito. Conta come fallito ESCLUSIVAMENTE uno stato normalizzato
 * "failed" (cioè status Meta realmente 'failed' o 'error'): 'sent',
 * 'queued', 'pending' e l'assenza di 'delivered' non contano mai come
 * fallimento.
 */
export function computeWhatsAppFailedForServices(
  events: Array<{
    service_id: string | null;
    status: string;
    happened_at: string;
    to_phone: string | null;
    template: string | null;
  }>
): WhatsAppFailedResult {
  const bestByService = new Map<string, (typeof events)[number]>();
  for (const event of events) {
    if (!event.service_id) continue;
    const existing = bestByService.get(event.service_id);
    if (!existing || isNewerStatus(event.status, event.happened_at, existing.status, existing.happened_at)) {
      bestByService.set(event.service_id, event);
    }
  }
  const failed = [...bestByService.values()].filter((event) => normalizeStatusGroup(event.status) === "failed");
  return {
    count: failed.length,
    items: failed.map((event) => ({
      service_id: event.service_id as string,
      to_phone: event.to_phone,
      template: event.template,
      status: event.status,
      happened_at: event.happened_at,
    })),
  };
}
