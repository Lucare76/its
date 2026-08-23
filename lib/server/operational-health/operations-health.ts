/**
 * Operational Health — Servizi imminenti senza assegnazione (Sprint 3, area
 * "operations"). Prima vera health operativa dello sprint.
 *
 * Definizione di "senza assegnazione" (autista) e finestre temporali riusate/
 * allineate a app/api/cron/sla-check/route.ts (gia' in produzione, stessa
 * nozione: un'assignments row con driver_user_id NOT NULL = servizio
 * assegnato — le assignments possono avere driver_user_id null apertamente
 * per design, vedi migrazione 0137_assignments_nullable_driver_unique.sql
 * "Piano del Giorno puo' creare giri senza autista assegnato"). Non si
 * duplica il motore di assegnazione/diagnostica del Piano del Giorno
 * (trip_groups, auto-assign): qui serve solo "questo servizio ha un autista
 * assegnato si'/no", esattamente la stessa domanda gia' risposta da
 * sla-check.
 *
 * Fix mirato (post-audit): quali servizi "richiedono assegnazione"? Audit
 * mirato di lib/piano-assignable-service.ts, lib/piano-unassigned-services-
 * diagnostics.ts, lib/server/continent-dispatch.ts, sla-check e
 * unassigned-diagnostics/route.ts:
 * - is_draft=true resta escluso (bozza, non ancora un servizio confermato),
 *   ma NON e' usato come proxy per "non richiede assegnazione".
 * - `resolveAssignableService` (lib/piano-assignable-service.ts) e' la
 *   stessa logica pura gia' usata dal Piano del Giorno reale (via
 *   piano-unassigned-services-diagnostics.ts / piano-real-giro-
 *   diagnostics.ts / auto-assign-preview) per decidere se un servizio e'
 *   candidato valido all'assegnazione standard autista/mezzo. Un servizio
 *   con `assignable === false` (needs_review — macro categoria non
 *   determinata, orario/pickup/destinazione mancanti, ecc.) NON puo' essere
 *   valutato con certezza: nessun alert, mai un falso critical.
 * - "Continent dispatch" (meeting point sul continente per servizi
 *   ARRIVO/PARTENZA non ancora categorizzati, gestiti da un vendor esterno
 *   — vedi lib/server/continent-dispatch.ts) e' GIA' un sottoinsieme di
 *   quanto sopra: isContinentDispatch() (piano-unassigned-services-
 *   diagnostics.ts) richiede macro_category === "DA_VERIFICARE", e
 *   DA_VERIFICARE genera SEMPRE "Macro categoria non determinata" come
 *   review_reason (vedi makeResolution/addMissingBaseReasons), quindi
 *   assignable e' gia' sempre false per quei servizi. Nessuna esclusione
 *   aggiuntiva necessaria: riusare solo `resolution.assignable` basta.
 *
 * Conversione data+ora locale Europe/Rome -> istante UTC: riusa
 * romeDateTimeToUtc (lib/server/medmar-booking/departure-datetime.ts),
 * stessa utility gia' testata per i controlli temporali fail-closed del
 * preflight Medmar — nessuna nuova logica di timezone duplicata.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { romeDateTimeToUtc } from "@/lib/server/medmar-booking/departure-datetime";
import { resolveAssignableService, type AssignableHotel, type AssignableService } from "@/lib/piano-assignable-service";
import type { AutoAssignPreviewHotel } from "@/lib/piano-assignable-preview";
import type { OperationalHealthAreaResult, OperationalHealthSignal } from "./types";

/**
 * Destinazione affidabile per i segnali operativi (Sprint 4):
 * /services/[id]/edit e' una route reale e stabile (useParams<{id}>()) — vedi
 * audit sprint. Ogni segnale qui porta gia' service.id, quindi il fallback a
 * Piano del Giorno (priorita' 2/3 della spec) non serve mai in pratica: quella
 * pagina non legge comunque alcun query param data oggi.
 */
function serviceEditAction(serviceId: string) {
  return { label: "Apri servizio", href: `/services/${serviceId}/edit` };
}

/** Soglie server-side (non in UI) — vedi spec sprint: prima configurazione semplice, nessuna soglia operativa preesistente trovata nel progetto oltre alla finestra 12h di sla-check (troppo ampia per un alert "imminente"). */
export const OPERATIONS_CRITICAL_WINDOW_MINUTES = 60;
export const OPERATIONS_WARNING_WINDOW_MINUTES = 180;

/**
 * Stessa esclusione di app/api/cron/sla-check/route.ts. Esportata (Sprint 5
 * MCP) per riuso esatto da its.get_unassigned_services / its.get_operational_brief
 * — nessuna nuova definizione di "servizio escluso" altrove.
 */
export const EXCLUDED_STATUSES = new Set(["cancelled", "pending_cancellation", "completato"]);

/**
 * Riga servizio per la valutazione — sovrainsieme dei campi minimi (id/date/
 * time/status/...) piu' tutti i campi opzionali gia' definiti da
 * AssignableService (stesso tipo usato dal Piano del Giorno reale), cosi'
 * requiresOperationalAssignment riusa resolveAssignableService senza
 * ridefinire alcun campo.
 */
export type OperationsHealthServiceRow = Omit<AssignableService, "time" | "direction"> & {
  date: string;
  time: string;
  status: string;
  is_draft: boolean;
  direction: string | null;
  practice_number: string | null;
};

export type OperationsHealthAssignmentRow = {
  service_id: string;
  driver_user_id: string | null;
};

export type OperationsHealthHotelRow = AutoAssignPreviewHotel;

/**
 * Pura — CASO A dell'audit: esiste gia' una logica affidabile
 * (resolveAssignableService, riusata identica) per decidere se un servizio
 * e' un candidato valido all'assegnazione standard autista/mezzo. Non
 * duplica quella logica: la richiama e basta.
 */
export function requiresOperationalAssignment(
  service: OperationsHealthServiceRow,
  hotel: AssignableHotel
): boolean {
  return resolveAssignableService(service, { hotel }).assignable;
}

/**
 * Pura — valuta servizi gia' caricati (nessun accesso DB qui). `now` iniettato
 * per restare testabile con date fisse ed esplicitamente verificare il caso
 * timezone Europe/Rome (CET/CEST). `hotelsById` risolve il contesto hotel
 * (nome/zona) richiesto da resolveAssignableService per pickup/destinazione.
 */
export function evaluateImminentUnassignedServices(
  services: readonly OperationsHealthServiceRow[],
  assignments: readonly OperationsHealthAssignmentRow[],
  hotelsById: ReadonlyMap<string, OperationsHealthHotelRow>,
  now: Date
): OperationalHealthSignal[] {
  const detectedAt = now.toISOString();
  const assignedServiceIds = new Set(
    assignments.filter((a) => a.driver_user_id != null).map((a) => a.service_id)
  );

  const signals: OperationalHealthSignal[] = [];

  for (const service of services) {
    if (service.is_draft) continue;
    if (EXCLUDED_STATUSES.has(service.status)) continue;

    const hotel = service.hotel_id ? hotelsById.get(service.hotel_id) ?? null : null;
    if (!requiresOperationalAssignment(service, hotel)) continue;

    const serviceAtUtc = romeDateTimeToUtc(service.date, service.time);
    if (!serviceAtUtc) continue; // data/ora non valide: nessun alert indovinato.

    const minutesUntil = (serviceAtUtc.getTime() - now.getTime()) / 60_000;
    if (minutesUntil < 0 || minutesUntil > OPERATIONS_WARNING_WINDOW_MINUTES) continue;

    if (assignedServiceIds.has(service.id)) continue;

    const severity = minutesUntil <= OPERATIONS_CRITICAL_WINDOW_MINUTES ? "critical" : "warning";
    const minutesRounded = Math.max(0, Math.round(minutesUntil));
    const label = service.practice_number ?? `servizio ${service.id.slice(0, 8)}`;
    const directionLabel = service.direction === "arrival" ? "Arrivo" : service.direction === "departure" ? "Partenza" : "Servizio";

    signals.push({
      key: `operations:unassigned:${service.id}`,
      area: "operations",
      severity,
      title: "Servizio imminente senza autista assegnato",
      message: `${directionLabel} ${label} delle ${service.time.slice(0, 5)} parte fra ${minutesRounded} minuti senza autista assegnato.`,
      detectedAt,
      entityId: label,
      metadata: { service_id: service.id, minutes_until: minutesRounded, direction: service.direction },
      action: serviceEditAction(service.id),
    });
  }

  return signals;
}

/** Esportata (Sprint 5 MCP) — "oggi" operativo ITS per i tool che di default operano sulla giornata corrente, mai UTC ingenuo. */
export function romeDateKey(date: Date): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(date);
}

/**
 * Pura — sorella di evaluateImminentUnassignedServices (Sprint 5 MCP): stessi
 * identici filtri (is_draft, EXCLUDED_STATUSES, requiresOperationalAssignment,
 * nessun driver assegnato), ma SENZA il vincolo di finestra "imminente"
 * (0..OPERATIONS_WARNING_WINDOW_MINUTES) — risponde a "quali servizi di
 * OGGI mancano ancora di autista", non solo a quelli a rischio nelle
 * prossime ore. `options.withinMinutes`, se passato, filtra ulteriormente
 * per un orizzonte esplicito richiesto dal chiamante (mai un default
 * "assenza assegnazione = problema" — vedi guardia requiresOperationalAssignment,
 * stessa di evaluateImminentUnassignedServices).
 */
export function listUnassignedServicesForDay(
  services: readonly OperationsHealthServiceRow[],
  assignments: readonly OperationsHealthAssignmentRow[],
  hotelsById: ReadonlyMap<string, OperationsHealthHotelRow>,
  options?: { now?: Date; withinMinutes?: number }
): Array<{ id: string; time: string; direction: string | null; practiceNumber: string | null; minutesUntil: number | null }> {
  const now = options?.now ?? new Date();
  const assignedServiceIds = new Set(
    assignments.filter((a) => a.driver_user_id != null).map((a) => a.service_id)
  );

  const results: Array<{ id: string; time: string; direction: string | null; practiceNumber: string | null; minutesUntil: number | null }> = [];

  for (const service of services) {
    if (service.is_draft) continue;
    if (EXCLUDED_STATUSES.has(service.status)) continue;

    const hotel = service.hotel_id ? hotelsById.get(service.hotel_id) ?? null : null;
    if (!requiresOperationalAssignment(service, hotel)) continue;
    if (assignedServiceIds.has(service.id)) continue;

    const serviceAtUtc = romeDateTimeToUtc(service.date, service.time);
    const minutesUntil = serviceAtUtc ? Math.round((serviceAtUtc.getTime() - now.getTime()) / 60_000) : null;

    if (options?.withinMinutes != null) {
      if (minutesUntil === null || minutesUntil < 0 || minutesUntil > options.withinMinutes) continue;
    }

    results.push({
      id: service.id,
      time: service.time,
      direction: service.direction,
      practiceNumber: service.practice_number,
      minutesUntil,
    });
  }

  return results;
}

/**
 * Colonne minime + gli stessi campi opzionali "operational_v2" che alimentano
 * resolveAssignableService — stesso elenco concettuale gia' usato da
 * app/api/ops/piano-giorno/unassigned-diagnostics/route.ts. Esportata
 * (Sprint 5 MCP) cosi' its.get_unassigned_services / its.get_operational_brief
 * leggono ESATTAMENTE lo stesso set di colonne, mai una selezione parallela
 * che potrebbe divergere silenziosamente da questa.
 */
export const SERVICE_COLUMNS = [
  "id",
  "date",
  "time",
  "time_to",
  "status",
  "is_draft",
  "direction",
  "practice_number",
  "hotel_id",
  "customer_name",
  "pax",
  "vessel",
  "meeting_point",
  "place_type",
  "pickup_hotel",
  "pickup_time",
  "booking_service_kind",
  "service_type",
  "service_type_code",
  "transport_code",
  "arrival_time",
  "departure_time",
  "orario_barca",
  "barca_compagnia",
  "porto_bruno",
  "ferry_details",
  "excursion_details",
  "tour_name",
  "origin_place_type",
  "destination_place_type",
].join(", ");

/**
 * I/O — legge solo i servizi entro la finestra di warning (al massimo i
 * prossimi 2 giorni solari Europe/Rome, per gestire il caso a cavallo di
 * mezzanotte), poi filtra al minuto esatto in JS via romeDateTimeToUtc.
 * Query filtrata per tenant/data/status, limitata — mai l'intero storico
 * servizi. Gli hotel del tenant sono una tabella piccola: stessa scelta di
 * app/api/ops/piano-giorno/route.ts (nessun filtro aggiuntivo necessario).
 *
 * Nota: a differenza di unassigned-diagnostics/route.ts, qui NON si
 * reimplementa il retry "colonna operational_v2 mancante -> riprova senza
 * quella colonna": se una di queste colonne opzionali non esiste ancora in
 * un ambiente, la query fallisce e l'area "operations" torna
 * available:false (failure isolation gia' presente) — stesso esito pratico
 * (nessun alert), percorso piu' semplice, deliberatamente non duplicato per
 * restare nel perimetro di questo fix mirato.
 */
export async function readOperationsOperationalHealth(
  admin: SupabaseClient,
  tenantId: string,
  now: Date
): Promise<OperationalHealthAreaResult> {
  const windowEnd = new Date(now.getTime() + OPERATIONS_WARNING_WINDOW_MINUTES * 60_000);
  const todayKey = romeDateKey(now);
  const windowEndKey = romeDateKey(windowEnd);

  const [servicesResult, hotelsResult] = await Promise.all([
    admin
      .from("services")
      .select(SERVICE_COLUMNS)
      .eq("tenant_id", tenantId)
      .gte("date", todayKey)
      .lte("date", windowEndKey)
      .limit(500),
    admin.from("hotels").select("id, name, zone").eq("tenant_id", tenantId),
  ]);

  if (servicesResult.error || hotelsResult.error) {
    return { area: "operations", available: false, error: "Salute servizi non assegnati non disponibile.", signals: [] };
  }

  const services = (servicesResult.data ?? []) as unknown as OperationsHealthServiceRow[];
  const hotelsById = new Map(
    ((hotelsResult.data ?? []) as OperationsHealthHotelRow[]).map((h) => [h.id, h] as const)
  );
  const serviceIds = services.map((s) => s.id);

  const { data: assignmentRows, error: assignmentError } = serviceIds.length
    ? await admin
        .from("assignments")
        .select("service_id, driver_user_id")
        .eq("tenant_id", tenantId)
        .in("service_id", serviceIds)
        .not("driver_user_id", "is", null)
    : { data: [] as OperationsHealthAssignmentRow[], error: null };

  if (assignmentError) {
    return { area: "operations", available: false, error: "Salute servizi non assegnati non disponibile.", signals: [] };
  }

  return {
    area: "operations",
    available: true,
    signals: evaluateImminentUnassignedServices(
      services,
      (assignmentRows ?? []) as OperationsHealthAssignmentRow[],
      hotelsById,
      now
    ),
  };
}
