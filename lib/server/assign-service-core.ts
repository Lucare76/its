/**
 * Core condiviso per l'assegnazione/rimozione autista+mezzo su un servizio.
 *
 * Estratto da app/api/ops/assign-service/route.ts (Sprint 2 MCP) per essere
 * richiamabile sia dalla route HTTP (che resta un adapter sottile:
 * auth → parsing input → questa funzione → NextResponse) sia dal tool MCP
 * its.assign_driver (lib/mcp/tools/assign-driver.ts), senza duplicare la
 * business logic né bypassarla.
 *
 * REGOLA: ogni funzione qui sotto è la stessa logica/query/ordine di guard
 * già in uso prima dell'estrazione — solo la rappresentazione dell'esito è
 * cambiata da NextResponse a { status, body } (un oggetto piano indipendente
 * da next/server, richiamabile fuori da un contesto HTTP). Nessuna regola
 * operativa, nessun messaggio, nessun codice di errore, nessun ordine di
 * validazione è stato modificato. I riferimenti CONC-01..03/SEC-05/FUNC-02/03
 * sono i commenti originali dell'audit di sicurezza, preservati verbatim.
 */
import { type SupabaseClient } from "@supabase/supabase-js";
import { auditLog } from "@/lib/server/ops-audit";
import { validateDriverGeographicBatch } from "@/lib/server/geo-assignment";
import { vehicleIntervalsOverlap } from "@/lib/piano-vehicle-timeline";
import { effectiveServiceDisembarkTime, minutesFromHHMM } from "@/lib/piano-arrival-time";
import { extractFeatures, logAssignmentChange, buildAssignmentDecisionFeatures, type CandidateSnapshot } from "@/lib/server/assignment-history";
import { updateLearnedPatterns } from "@/lib/server/learned-patterns";

export type AssignServiceOutcome = { status: number; body: Record<string, unknown> };

type GuardResult = { ok: true } | { ok: false; status: number; body: Record<string, unknown> };

// ── CONC-03: nessun controllo di sovrapposizione oraria per lo stesso mezzo
// (vehicle_label) era applicato in questa route, a differenza di
// piano-giorno/trips (validateVehicleTimelinePayload). Stessa regola di
// blocco reale già in uso lì: finestra fissa di 30 minuti per servizio,
// overlap [start,end) senza buffer (i gap/warning di trips non si applicano
// qui, solo il blocco vero e proprio). Riusa vehicleIntervalsOverlap
// (lib/piano-vehicle-timeline.ts, già presente ma non invocato fuori dal
// planner automatico) e effectiveServiceDisembarkTime/minutesFromHHMM
// (lib/piano-arrival-time.ts) per calcolare l'orario operativo esattamente
// come trips/route.ts (serviceOperationalTime), senza duplicarne la logica
// interna né toccare quel file (fuori perimetro). vehicle_time_blocks non è
// usato: piano-giorno/trips stesso non lo consulta per questo tipo di
// blocco, solo per meccanismi di blocco manuale separati (fuori scope).
const VEHICLE_OVERLAP_DURATION_MINUTES = 30;

type VehicleOverlapServiceFields = {
  date: string;
  time: string | null;
  direction: "arrival" | "departure";
  pickup_hotel: string | null;
  arrival_time?: string | null;
  orario_barca?: string | null;
  porto_bruno?: string | null;
  barca_compagnia?: string | null;
  booking_service_kind?: string | null;
  service_type_code?: string | null;
  vessel?: string | null;
  ferry_details?: Record<string, unknown> | null;
};

// ── FUNC-02: nessun controllo server-side impediva l'assegnazione manuale a
// servizi non più operativi. Denylist esplicita costruita sull'enum reale
// public.service_status (supabase/migrations/0001_schema.sql:5 + aggiunte in
// 0009/0132/0169, vedi lib/types.ts:33) più il flag is_draft (colonna
// separata, 0001_schema.sql:38):
// - "completato"/"cancelled": stati terminali — driver/page.tsx:529,535 li
//   tratta esplicitamente come "storico", distinti da tutti gli altri stati
//   attivi (incluso "problema", che segnala un'anomalia ma resta operativo:
//   riassegnare durante "partito"/"caricato"/"scaricato"/"arrivato"/"problema"
//   è un correttivo legittimo, es. autista indisponibile a metà corsa — non
//   vengono bloccati).
// - "needs_review": dati importati non ancora verificati manualmente
//   (0009_inbound_attachments_and_needs_review.sql) — non è ancora un
//   servizio pronto per il dispatch.
// - "pending_cancellation": cancellazione in corso di decisione
//   (0132_cancellation_requests.sql); alla finalizzazione
//   (0179_finalize_cancellation_clears_assignments.sql) lo stato diventa
//   "cancelled" o torna "new" e l'assignment viene comunque cancellato —
//   assegnare ora sarebbe prematuro e verrebbe annullato a breve.
// - is_draft=true: stesso segnale già usato da auto-assign per escludere i
//   candidati dal pool (piano-giorno/auto-assign/route.ts:957,
//   ".neq('status','cancelled').neq('is_draft', true)") — riusato qui, non
//   inventato.
// "new"/"assigned" restano assegnabili (assigned è il ramo di aggiornamento
// legittimo, invariato). Nessuno stato "no_show" esiste nell'enum reale.
const NON_ASSIGNABLE_SERVICE_STATUSES = new Set<string>([
  "completato",
  "cancelled",
  "needs_review",
  "pending_cancellation",
]);

export function isServiceAssignableForManualAssignment(service: { status?: string | null; is_draft?: boolean | null }): boolean {
  if (service.is_draft === true) return false;
  if (service.status && NON_ASSIGNABLE_SERVICE_STATUSES.has(service.status)) return false;
  return true;
}

function serviceNotAssignableOutcome(): AssignServiceOutcome {
  return {
    status: 409,
    body: { ok: false, error: "SERVICE_NOT_ASSIGNABLE", message: "Il servizio non può essere assegnato nello stato attuale." },
  };
}

function serviceVehicleOperationalMinutes(service: VehicleOverlapServiceFields): number | null {
  const timeStr =
    service.direction === "departure"
      ? (service.pickup_hotel ?? service.time)?.slice(0, 5) ?? null
      : effectiveServiceDisembarkTime(service) ?? service.time?.slice(0, 5) ?? null;
  return timeStr ? minutesFromHHMM(timeStr) : null;
}

function vehicleOverlapOutcome(): AssignServiceOutcome {
  return {
    status: 409,
    body: { ok: false, error: "VEHICLE_OVERLAP", message: "Il mezzo è già impegnato in un altro servizio nello stesso orario." },
  };
}

function vehicleCheckFailedOutcome(): AssignServiceOutcome {
  return {
    status: 500,
    body: { ok: false, error: "VEHICLE_CHECK_FAILED", message: "Errore durante la verifica della disponibilità del mezzo." },
  };
}

// Verifica overlap reale del mezzo (vehicle_label) contro gli altri
// trip_groups attivi dello stesso tenant/data. Va invocata solo per l'azione
// "assign" e solo se vehicle_label è presente/non vuoto — se assente il
// comportamento resta invariato (nessun controllo, come prima di CONC-03).
// Esclude sempre il service_id corrente (sia via excludeGroupId sul gruppo
// riusato, sia via filtro diretto sull'assignment) per non generare un falso
// conflitto quando si aggiorna la stessa assegnazione. Fail-closed: un
// errore di query blocca la scrittura (500 sanificato), non prosegue mai in
// silenzio. Nessun dettaglio del servizio confliggente viene restituito al
// client.
export async function checkVehicleOverlap(
  admin: SupabaseClient,
  tenantId: string,
  input: {
    serviceId: string;
    service: VehicleOverlapServiceFields;
    vehicleLabel: string;
    excludeGroupId?: string | null;
  },
  context: { userId?: string }
): Promise<GuardResult> {
  const label = input.vehicleLabel.trim();
  if (!label) return { ok: true };

  const candidateStart = serviceVehicleOperationalMinutes(input.service);
  if (candidateStart == null) return { ok: true };
  const candidateInterval = { start_min: candidateStart, end_min: candidateStart + VEHICLE_OVERLAP_DURATION_MINUTES };

  const dbErrorResult = (stage: string, dbCode: string | null): GuardResult => {
    auditLog({
      event: "assign_service_vehicle_check_failed",
      level: "error",
      tenantId,
      userId: context.userId ?? null,
      details: { serviceId: input.serviceId, stage, dbCode },
    });
    return { ok: false, ...vehicleCheckFailedOutcome() };
  };

  let groupsQuery = admin
    .from("trip_groups")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("date", input.service.date)
    .eq("status", "active")
    .eq("vehicle_label", label);
  if (input.excludeGroupId) groupsQuery = groupsQuery.neq("id", input.excludeGroupId);

  const { data: groups, error: groupsError } = await groupsQuery;
  if (groupsError) return dbErrorResult("trip_groups", (groupsError as { code?: string }).code ?? null);

  const groupIds = (groups ?? []).map((group) => group.id as string);
  if (groupIds.length === 0) return { ok: true };

  const { data: assignmentsData, error: assignmentsError } = await admin
    .from("assignments")
    .select(
      "service_id, services!inner(date, time, direction, pickup_hotel, arrival_time, orario_barca, porto_bruno, barca_compagnia, booking_service_kind, service_type_code, vessel, ferry_details)"
    )
    .eq("tenant_id", tenantId)
    .in("group_id", groupIds)
    .neq("service_id", input.serviceId);

  if (assignmentsError) return dbErrorResult("assignments", (assignmentsError as { code?: string }).code ?? null);

  for (const row of assignmentsData ?? []) {
    const otherService = (row.services as unknown) as VehicleOverlapServiceFields | null;
    if (!otherService) continue;
    const otherStart = serviceVehicleOperationalMinutes(otherService);
    if (otherStart == null) continue;
    const otherInterval = { start_min: otherStart, end_min: otherStart + VEHICLE_OVERLAP_DURATION_MINUTES };
    if (vehicleIntervalsOverlap(candidateInterval, otherInterval, 0)) {
      auditLog({
        event: "assign_service_vehicle_overlap",
        level: "warn",
        tenantId,
        userId: context.userId ?? null,
        details: { serviceId: input.serviceId, vehicleLabel: label },
      });
      return { ok: false, ...vehicleOverlapOutcome() };
    }
  }

  return { ok: true };
}

// ── CONC-02: nessun vero controllo di sovrapposizione oraria per lo stesso
// autista era applicato in questa route. L'unico controllo esistente
// (validateDriverGeographicBatch, sotto) è euristico — valuta solo il tempo
// di trasferimento geografico tra zone — e scatta solo se è presente
// body.driver_user_id, mai con driver_profile_id (gap confermato in audit).
// Riusa esattamente lo stesso schema di CONC-03 (vehicleIntervalsOverlap,
// finestra fissa 30 min, overlap [start,end) senza buffer) applicato però
// all'identità del driver anziché al mezzo, e per ENTRAMBI gli identificatori
// quando presenti — non solo driver_user_id. Nessuna scrittura prima del
// guard, stesso pattern di risposta 409/500 sanificata.
const DRIVER_OVERLAP_DURATION_MINUTES = 30;

function driverOverlapOutcome(): AssignServiceOutcome {
  return {
    status: 409,
    body: { ok: false, error: "DRIVER_OVERLAP", message: "L'autista è già impegnato in un altro servizio nello stesso orario." },
  };
}

function driverOverlapCheckFailedOutcome(): AssignServiceOutcome {
  return {
    status: 500,
    body: { ok: false, error: "DRIVER_OVERLAP_CHECK_FAILED", message: "Errore durante la verifica della disponibilità dell'autista." },
  };
}

async function findActiveGroupIdsByDriverField(
  admin: SupabaseClient,
  tenantId: string,
  date: string,
  field: "driver_user_id" | "driver_profile_id",
  value: string,
  excludeGroupId?: string | null
): Promise<{ ok: true; groupIds: string[] } | { ok: false; dbCode: string | null }> {
  let query = admin
    .from("trip_groups")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("date", date)
    .eq("status", "active")
    .eq(field, value);
  if (excludeGroupId) query = query.neq("id", excludeGroupId);

  const { data, error } = await query;
  if (error) return { ok: false, dbCode: (error as { code?: string }).code ?? null };
  return { ok: true, groupIds: (data ?? []).map((row) => row.id as string) };
}

// Verifica overlap reale dell'autista (driver_user_id e/o driver_profile_id)
// contro gli altri trip_groups attivi dello stesso tenant/data. Va invocata
// solo per l'azione "assign" e solo se almeno un identificatore driver è
// presente — se assenti entrambi il comportamento resta invariato. Esclude
// sempre il service_id corrente ed excludeGroupId (gruppo riusato) per non
// generare un falso conflitto quando si aggiorna la stessa assegnazione.
// Fail-closed: un errore di query blocca la scrittura (500 sanificato).
export async function checkDriverOverlap(
  admin: SupabaseClient,
  tenantId: string,
  input: {
    serviceId: string;
    service: VehicleOverlapServiceFields;
    driverUserId?: string | null;
    driverProfileId?: string | null;
    excludeGroupId?: string | null;
  },
  context: { userId?: string }
): Promise<GuardResult> {
  const driverUserId = input.driverUserId ?? null;
  const driverProfileId = input.driverProfileId ?? null;
  if (!driverUserId && !driverProfileId) return { ok: true };

  const candidateStart = serviceVehicleOperationalMinutes(input.service);
  if (candidateStart == null) return { ok: true };
  const candidateInterval = { start_min: candidateStart, end_min: candidateStart + DRIVER_OVERLAP_DURATION_MINUTES };

  const dbErrorResult = (stage: string, dbCode: string | null): GuardResult => {
    auditLog({
      event: "assign_service_driver_overlap_check_failed",
      level: "error",
      tenantId,
      userId: context.userId ?? null,
      details: { serviceId: input.serviceId, stage, dbCode },
    });
    return { ok: false, ...driverOverlapCheckFailedOutcome() };
  };

  const groupIds = new Set<string>();

  if (driverUserId) {
    const result = await findActiveGroupIdsByDriverField(
      admin, tenantId, input.service.date, "driver_user_id", driverUserId, input.excludeGroupId
    );
    if (!result.ok) return dbErrorResult("trip_groups_driver_user_id", result.dbCode);
    for (const id of result.groupIds) groupIds.add(id);
  }

  if (driverProfileId) {
    const result = await findActiveGroupIdsByDriverField(
      admin, tenantId, input.service.date, "driver_profile_id", driverProfileId, input.excludeGroupId
    );
    if (!result.ok) return dbErrorResult("trip_groups_driver_profile_id", result.dbCode);
    for (const id of result.groupIds) groupIds.add(id);
  }

  if (groupIds.size === 0) return { ok: true };

  const { data: assignmentsData, error: assignmentsError } = await admin
    .from("assignments")
    .select(
      "service_id, services!inner(date, time, direction, pickup_hotel, arrival_time, orario_barca, porto_bruno, barca_compagnia, booking_service_kind, service_type_code, vessel, ferry_details)"
    )
    .eq("tenant_id", tenantId)
    .in("group_id", Array.from(groupIds))
    .neq("service_id", input.serviceId);

  if (assignmentsError) return dbErrorResult("assignments", (assignmentsError as { code?: string }).code ?? null);

  for (const row of assignmentsData ?? []) {
    const otherService = (row.services as unknown) as VehicleOverlapServiceFields | null;
    if (!otherService) continue;
    const otherStart = serviceVehicleOperationalMinutes(otherService);
    if (otherStart == null) continue;
    const otherInterval = { start_min: otherStart, end_min: otherStart + DRIVER_OVERLAP_DURATION_MINUTES };
    if (vehicleIntervalsOverlap(candidateInterval, otherInterval, 0)) {
      auditLog({
        event: "assign_service_driver_overlap",
        level: "warn",
        tenantId,
        userId: context.userId ?? null,
        details: { serviceId: input.serviceId, hasDriverUserId: Boolean(driverUserId), hasDriverProfileId: Boolean(driverProfileId) },
      });
      return { ok: false, ...driverOverlapOutcome() };
    }
  }

  return { ok: true };
}

// ── SEC-05: verifica che driver_user_id/driver_profile_id ricevuti dal client
// appartengano al tenant autenticato prima di scrivere l'assignment. La route
// usa il client service-role (bypassa RLS): il controllo va fatto qui.
// Salta il controllo solo se nessuno dei due campi è presente. Stessa risposta
// 404 generica per driver inesistente, di altro tenant, o coppia
// user_id/profile_id incoerente — non deve rivelare quale caso si sia
// verificato. Errore di query è fail-closed (500). Non verifica lo stato
// sospeso/attivo del driver (FUNC-03, fuori scope).
function driverNotFoundOutcome(): AssignServiceOutcome {
  return { status: 404, body: { ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." } };
}

export async function verifyDriverBelongsToTenant(
  admin: SupabaseClient,
  tenantId: string,
  input: { driverUserId?: string | null; driverProfileId?: string | null },
  context: { userId?: string }
): Promise<GuardResult> {
  const driverUserId = input.driverUserId ?? null;
  const driverProfileId = input.driverProfileId ?? null;

  if (!driverUserId && !driverProfileId) {
    return { ok: true };
  }

  const verificationFailedOutcome = (dbCode: string | null): GuardResult => {
    auditLog({
      event: "assign_service_driver_verification_failed",
      level: "error",
      tenantId,
      userId: context.userId ?? null,
      details: {
        action: "assign",
        hasDriverUserId: Boolean(driverUserId),
        hasDriverProfileId: Boolean(driverProfileId),
        dbCode,
      },
    });
    return {
      ok: false,
      status: 500,
      body: { ok: false, error: "DRIVER_VERIFICATION_FAILED", message: "Errore durante la verifica dell'autista." },
    };
  };

  let profileUserId: string | null = null;

  if (driverUserId) {
    const { data, error } = await admin
      .from("memberships")
      .select("user_id")
      .eq("tenant_id", tenantId)
      .eq("user_id", driverUserId)
      .eq("role", "driver")
      .maybeSingle();

    if (error) return verificationFailedOutcome((error as { code?: string }).code ?? null);
    if (!data?.user_id) return { ok: false, ...driverNotFoundOutcome() };
  }

  if (driverProfileId) {
    const { data, error } = await admin
      .from("driver_profiles")
      .select("id, user_id")
      .eq("tenant_id", tenantId)
      .eq("id", driverProfileId)
      .maybeSingle();

    if (error) return verificationFailedOutcome((error as { code?: string }).code ?? null);
    if (!data?.id) return { ok: false, ...driverNotFoundOutcome() };
    profileUserId = (data.user_id as string | null) ?? null;
  }

  // Coppia incoerente: il profilo indicato è già collegato a un altro utente.
  if (driverUserId && driverProfileId && profileUserId && profileUserId !== driverUserId) {
    return { ok: false, ...driverNotFoundOutcome() };
  }

  return { ok: true };
}

// ── FUNC-03: verifica che il driver, già confermato esistente/tenant-scoped
// da SEC-05, sia anche operativo (non sospeso/non disattivato) prima di
// consentire l'assegnazione manuale. Helper separato (non fuso con SEC-05)
// per mantenere invariati i codici di errore esistenti di SEC-05 e per dare
// alla query di stato un proprio codice 500 distinto, come richiesto.
// Segnali reali riusati (stessi già usati da auto-assign, non inventati):
// - memberships.suspended (0056_memberships_tenant_suspension.sql), alias
//   applicativo "access_suspended" in lib/server/driver-registry.ts, escluso
//   dai candidati auto-assign via `!driver.access_suspended`
//   (piano-giorno/auto-assign/route.ts:1068);
// - driver_profiles.active (0080_driver_profiles.sql), filtrato di default
//   da loadDriverRegistry via `.eq("active", true)`.
// Driver esistente ma non operativo -> 409 DRIVER_NOT_ACTIVE, mai confuso col
// 404 di ownership. Non verifica disponibilità giornaliera (già gestita dal
// guard FUNC-01 esistente più sotto) né altri stati funzionali.
function driverNotActiveOutcome(): AssignServiceOutcome {
  return {
    status: 409,
    body: { ok: false, error: "DRIVER_NOT_ACTIVE", message: "L'autista non è attualmente disponibile per nuove assegnazioni." },
  };
}

export async function verifyDriverIsOperational(
  admin: SupabaseClient,
  tenantId: string,
  input: { driverUserId?: string | null; driverProfileId?: string | null },
  context: { userId?: string }
): Promise<GuardResult> {
  const driverUserId = input.driverUserId ?? null;
  const driverProfileId = input.driverProfileId ?? null;

  if (!driverUserId && !driverProfileId) {
    return { ok: true };
  }

  const statusCheckFailedOutcome = (dbCode: string | null): GuardResult => {
    auditLog({
      event: "assign_service_driver_status_check_failed",
      level: "error",
      tenantId,
      userId: context.userId ?? null,
      details: {
        action: "assign",
        hasDriverUserId: Boolean(driverUserId),
        hasDriverProfileId: Boolean(driverProfileId),
        dbCode,
      },
    });
    return {
      ok: false,
      status: 500,
      body: { ok: false, error: "DRIVER_STATUS_CHECK_FAILED", message: "Errore durante la verifica dello stato dell'autista." },
    };
  };

  if (driverUserId) {
    const { data, error } = await admin
      .from("memberships")
      .select("suspended")
      .eq("tenant_id", tenantId)
      .eq("user_id", driverUserId)
      .eq("role", "driver")
      .maybeSingle();

    if (error) return statusCheckFailedOutcome((error as { code?: string }).code ?? null);
    // Riga assente qui è inatteso (SEC-05 l'ha già confermata poco prima):
    // fail-closed, non un falso successo silenzioso.
    if (!data || data.suspended === true) return { ok: false, ...driverNotActiveOutcome() };
  }

  if (driverProfileId) {
    const { data, error } = await admin
      .from("driver_profiles")
      .select("active")
      .eq("tenant_id", tenantId)
      .eq("id", driverProfileId)
      .maybeSingle();

    if (error) return statusCheckFailedOutcome((error as { code?: string }).code ?? null);
    if (!data || data.active === false) return { ok: false, ...driverNotActiveOutcome() };
  }

  return { ok: true };
}

// Elimina, in modo best-effort, il trip_group appena creato dalla richiesta
// corrente quando il successivo insert su assignments fallisce (CONC-01).
// Va chiamata solo con un groupId proveniente da un insert eseguito nella
// stessa richiesta: non deve mai cancellare un gruppo preesistente/riusato.
async function cleanupCreatedTripGroup(
  admin: SupabaseClient,
  tenantId: string,
  groupId: string
): Promise<boolean> {
  try {
    const { error } = await admin.from("trip_groups").delete().eq("id", groupId).eq("tenant_id", tenantId);
    if (error) {
      auditLog({
        event: "assignment_cleanup_failed",
        level: "error",
        tenantId,
        details: { groupIdCreated: groupId, error: error.message },
      });
      return false;
    }
    return true;
  } catch (err) {
    auditLog({
      event: "assignment_cleanup_failed",
      level: "error",
      tenantId,
      details: { groupIdCreated: groupId, error: err instanceof Error ? err.message : "Errore sconosciuto." },
    });
    return false;
  }
}

export type AssignServiceCoreParams = {
  tenantId: string;
  userId: string;
  serviceId: string;
  driverUserId?: string | null;
  driverProfileId?: string | null;
  vehicleLabel?: string | null;
  action?: "assign" | "remove";
  // ML Data Collection Sprint 2 (opzionali, non-breaking): contesto
  // proposta→decisione da propagare in driver_assignment_history.features.
  // Chi non li passa (route HTTP esistente) ottiene lo stesso comportamento
  // di prima — wasOverride viene comunque calcolato internamente da questa
  // funzione (non richiede input dal chiamante) in base al driver/mezzo
  // precedente già letto da existingAssignment.
  source?: string | null;
  proposalId?: string | null;
  candidateSnapshot?: CandidateSnapshot[] | null;
  chosenRank?: number | null;
};

/**
 * Core di assegnazione/rimozione — identico, guard per guard e query per
 * query, alla logica originaria del POST /api/ops/assign-service prima
 * dell'estrazione Sprint 2. Ogni return-site del corpo originale è
 * rappresentato qui da un { status, body } equivalente byte-per-byte a
 * quanto la route passava a NextResponse.json(...).
 */
export async function assignServiceCore(admin: SupabaseClient, params: AssignServiceCoreParams): Promise<AssignServiceOutcome> {
  const { tenantId, userId, serviceId } = params;
  const action = params.action ?? "assign";
  const driverUserId = params.driverUserId ?? null;
  const driverProfileId = params.driverProfileId ?? null;
  const vehicleLabel = params.vehicleLabel ?? null;

  const now = new Date().toISOString();
  const manualAssignmentLock = {
    assignment_source: "manual_assign_service",
    locked_by_operator: true,
    assigned_by: userId,
    assigned_at: now,
    lock_reason: "manual_assignment_from_assign_service",
  };

  // Recupera il servizio per avere la data
  const { data: service, error: serviceErr } = await admin
    .from("services")
    .select(
      "id, date, status, is_draft, time, pickup_hotel, direction, hotel_id, meeting_point, arrival_time, orario_barca, porto_bruno, barca_compagnia, booking_service_kind, service_type_code, vessel, ferry_details, pax"
    )
    .eq("id", serviceId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (serviceErr || !service) {
    return { status: 404, body: { ok: false, error: "Servizio non trovato." } };
  }

  const date = service.date as string;

  // FUNC-02: guard stato servizio, solo per l'azione "assign" (remove deve
  // restare sempre possibile, anche su un servizio non più operativo, per
  // permettere di ripulire un'assegnazione residua es. dopo cancellazione).
  // Deve precedere qualunque altro guard/scrittura successiva.
  if (action === "assign" && !isServiceAssignableForManualAssignment(service as { status?: string | null; is_draft?: boolean | null })) {
    return serviceNotAssignableOutcome();
  }

  // SEC-05: verifica ownership tenant del driver, solo per l'azione "assign"
  // (remove non tocca driver_user_id/driver_profile_id). Deve avvenire prima
  // di qualunque altro guard/scrittura successiva.
  if (action === "assign") {
    const driverOwnership = await verifyDriverBelongsToTenant(admin, tenantId, { driverUserId, driverProfileId }, { userId });
    if (!driverOwnership.ok) return { status: driverOwnership.status, body: driverOwnership.body };

    // FUNC-03: verifica che il driver, già confermato tenant-scoped da
    // SEC-05, sia anche operativo (non sospeso/non disattivato).
    const driverOperational = await verifyDriverIsOperational(admin, tenantId, { driverUserId, driverProfileId }, { userId });
    if (!driverOperational.ok) return { status: driverOperational.status, body: driverOperational.body };
  }

  // Verifica disponibilità confermata
  const { data: availability } = await admin
    .from("daily_availability_confirmations")
    .select("confirmed")
    .eq("tenant_id", tenantId)
    .eq("date", date)
    .maybeSingle();

  if (!availability?.confirmed) {
    return {
      status: 409,
      body: { ok: false, error: "Disponibilita del giorno non confermata. Completa prima la conferma in Disponibilita." },
    };
  }

  // Recupera assignment esistente
  const { data: existingAssignment } = await admin
    .from("assignments")
    .select("id, group_id, driver_profile_id, vehicle_label")
    .eq("service_id", serviceId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  // ─── REMOVE ───────────────────────────────────────────────────────────────
  if (action === "remove") {
    if (!existingAssignment) {
      return { status: 200, body: { ok: true } };
    }
    await admin.from("assignments").delete().eq("id", existingAssignment.id).eq("tenant_id", tenantId);

    if (existingAssignment.group_id) {
      const { data: remaining } = await admin
        .from("assignments")
        .select("id")
        .eq("group_id", existingAssignment.group_id)
        .eq("tenant_id", tenantId);
      if (!remaining?.length) {
        await admin.from("trip_groups")
          .update({ status: "cancelled", updated_at: now })
          .eq("id", existingAssignment.group_id)
          .eq("tenant_id", tenantId);
      }
    }

    await admin.from("services").update({ status: "new" }).eq("id", serviceId).eq("tenant_id", tenantId);
    return { status: 200, body: { ok: true } };
  }

  // ─── ASSIGN ───────────────────────────────────────────────────────────────
  // CONC-02: verifica overlap orario reale dello stesso autista, per
  // entrambi gli identificatori (driver_user_id e/o driver_profile_id).
  // Eseguita PRIMA della validazione geografica euristica sotto: quest'ultima
  // confronta solo tempi di trasferimento tra zone e, su un vero overlap
  // esatto, produrrebbe comunque un 409 ma con un messaggio euristico meno
  // chiaro ("zona sconosciuta", minuti disponibili) invece della diagnosi
  // precisa DRIVER_OVERLAP — il controllo strutturale ha priorità su quello
  // euristico. Deve avvenire prima di qualunque scrittura su
  // trip_groups/assignments.
  if (driverUserId || driverProfileId) {
    const driverOverlapCheck = await checkDriverOverlap(
      admin,
      tenantId,
      {
        serviceId,
        service: service as unknown as VehicleOverlapServiceFields,
        driverUserId,
        driverProfileId,
        excludeGroupId: existingAssignment?.group_id ?? null,
      },
      { userId }
    );
    if (!driverOverlapCheck.ok) return { status: driverOverlapCheck.status, body: driverOverlapCheck.body };
  }

  if (driverUserId) {
    const geoValidation = await validateDriverGeographicBatch(admin, tenantId, driverUserId, [{
      id: service.id as string,
      date,
      time: service.time as string,
      pickup_hotel: service.pickup_hotel as string | null,
      direction: service.direction as "arrival" | "departure",
      hotel_id: service.hotel_id as string | null,
      meeting_point: service.meeting_point as string | null,
    }]);
    if (!geoValidation.ok) {
      return { status: 409, body: { ok: false, error: geoValidation.error } };
    }
  }

  // CONC-03: verifica overlap mezzo, solo se vehicle_label è presente/non
  // vuoto — comportamento invariato altrimenti. Deve avvenire prima di
  // qualunque scrittura su trip_groups/assignments.
  if (vehicleLabel && vehicleLabel.trim()) {
    const vehicleCheck = await checkVehicleOverlap(
      admin,
      tenantId,
      {
        serviceId,
        service: service as unknown as VehicleOverlapServiceFields,
        vehicleLabel,
        excludeGroupId: existingAssignment?.group_id ?? null,
      },
      { userId }
    );
    if (!vehicleCheck.ok) return { status: vehicleCheck.status, body: vehicleCheck.body };
  }

  let groupId: string;

  if (existingAssignment?.group_id) {
    groupId = existingAssignment.group_id as string;
    await Promise.all([
      admin.from("trip_groups").update({
        driver_user_id: driverUserId,
        driver_profile_id: driverProfileId,
        vehicle_label: vehicleLabel,
        updated_at: now,
      }).eq("id", groupId).eq("tenant_id", tenantId),
      admin.from("assignments").update({
        driver_user_id: driverUserId,
        driver_profile_id: driverProfileId,
        vehicle_label: vehicleLabel ?? "",
        ...manualAssignmentLock,
      }).eq("id", existingAssignment.id).eq("tenant_id", tenantId),
    ]);
  } else {
    // Rimuovi eventuale assignment vecchio senza group_id
    if (existingAssignment) {
      await admin.from("assignments").delete().eq("id", existingAssignment.id).eq("tenant_id", tenantId);
    }

    const { data: newGroup, error: groupErr } = await admin
      .from("trip_groups")
      .insert({
        tenant_id: tenantId,
        date,
        driver_user_id: driverUserId,
        driver_profile_id: driverProfileId,
        vehicle_label: vehicleLabel,
        created_by: userId,
        created_at: now,
        updated_at: now,
      })
      .select("id")
      .single();

    if (groupErr || !newGroup?.id) {
      return { status: 500, body: { ok: false, error: groupErr?.message ?? "Errore creazione giro." } };
    }

    groupId = newGroup.id as string;

    const { error: assignmentInsertError } = await admin.from("assignments").insert({
      tenant_id: tenantId,
      service_id: serviceId,
      driver_user_id: driverUserId,
      driver_profile_id: driverProfileId,
      vehicle_label: vehicleLabel ?? "",
      group_id: groupId,
      ...manualAssignmentLock,
    });

    if (assignmentInsertError) {
      const cleanupSucceeded = await cleanupCreatedTripGroup(admin, tenantId, groupId);

      if (assignmentInsertError.code === "23505") {
        auditLog({
          event: "assignment_conflict",
          level: "warn",
          tenantId,
          userId,
          details: {
            serviceId,
            groupIdCreated: groupId,
            cleanupAttempted: true,
            cleanupSucceeded,
          },
        });
        return {
          status: 409,
          body: {
            ok: false,
            error: "SERVICE_ALREADY_ASSIGNED",
            message: "Il servizio è già stato assegnato da un altro operatore. Ricarica la pagina.",
          },
        };
      }

      auditLog({
        event: "assignment_insert_failed",
        level: "error",
        tenantId,
        userId,
        details: {
          serviceId,
          groupIdCreated: groupId,
          cleanupAttempted: true,
          cleanupSucceeded,
          dbCode: assignmentInsertError.code ?? null,
        },
      });
      return { status: 500, body: { ok: false, error: "ASSIGNMENT_FAILED", message: "Errore durante l'assegnazione. Riprova." } };
    }
  }

  await admin.from("services").update({ status: "assigned" }).eq("id", serviceId).eq("tenant_id", tenantId);

  await admin.from("status_events").upsert({
    tenant_id: tenantId,
    service_id: serviceId,
    status: "assigned",
    at: now,
    by_user_id: userId,
  }, { onConflict: "tenant_id,service_id,status", ignoreDuplicates: true });

  // CONC-07: registra lo storico strutturato dell'assegnazione manuale,
  // riusando esattamente il contratto già in uso da piano-giorno/trips
  // (changeType "driver_swap" quando driver_profile_id cambia) e da
  // apply-vehicle-binding (changeType "vehicle_binding" quando cambia solo
  // vehicle_label). "Prima" letto dalla riga assignments già recuperata
  // sopra (pre-mutazione). vehicle_label "" (default della colonna
  // assignments, non nullable) è normalizzato a null per confrontarlo
  // coerentemente con trip_groups.vehicle_label (nullable) e con l'assenza
  // di mezzo. Nessun evento se né driver né mezzo sono cambiati. Scrittura
  // fire-and-forget dopo il successo della mutazione principale, come negli
  // altri chiamanti: non blocca né altera la risposta HTTP.
  const prevDriverProfileId = (existingAssignment?.driver_profile_id as string | null | undefined) ?? null;
  const newDriverProfileId = driverProfileId ?? null;
  const prevVehicleLabel = ((existingAssignment?.vehicle_label as string | null | undefined) ?? null) || null;
  const newVehicleLabel = (vehicleLabel ?? null) || null;
  const driverChanged = prevDriverProfileId !== newDriverProfileId;
  const vehicleChanged = prevVehicleLabel !== newVehicleLabel;

  if (driverChanged || vehicleChanged) {
    // driver_swap porta sempre con sé anche i valori mezzo (come in
    // piano-giorno/trips: il driver_swap è loggato per l'intero giro,
    // vehicle_label incluso, anche se solo il driver è cambiato).
    // vehicle_binding NON include i campi driver (come in
    // apply-vehicle-binding: quel changeType descrive solo il mezzo) —
    // qui scatta solo quando il driver è rimasto invariato, quindi
    // ometterlo non perde informazione.
    const changeType = driverChanged ? ("driver_swap" as const) : ("vehicle_binding" as const);
    const bookingKind = (service.booking_service_kind as string | null) ?? (service.service_type_code as string | null) ?? "";
    const isNavetta = bookingKind === "navetta" || bookingKind === "shuttle_hotel" || bookingKind === "bus_city_hotel";
    const driverFields = driverChanged
      ? { fromDriverProfileId: prevDriverProfileId, toDriverProfileId: newDriverProfileId }
      : {};
    const baseFeatures = extractFeatures({
      serviceDate: date,
      changeType,
      ...driverFields,
      fromVehicleLabel: prevVehicleLabel,
      toVehicleLabel: newVehicleLabel,
      direction: service.direction as string | null,
      zone: service.meeting_point as string | null,
      time: service.time as string | null,
      vessel: (service.vessel as string | null) ?? (service.barca_compagnia as string | null) ?? null,
      pax: (service.pax as number | null) ?? null,
      isNavetta,
    });
    // FASE 6/7 (Sprint 2): was_override = c'era un valore precedente diverso
    // che questa scrittura sostituisce (driver per driver_swap, mezzo per
    // vehicle_binding) — calcolato qui internamente, non richiede input dal
    // chiamante. source di default riusa la stringa già scritta su
    // assignments.assignment_source per questo stesso path (nessun valore
    // nuovo inventato); i chiamanti (es. MCP) possono sovrascriverla.
    const wasOverride = driverChanged ? prevDriverProfileId != null : prevVehicleLabel != null;
    const features = buildAssignmentDecisionFeatures(baseFeatures, {
      source: params.source ?? manualAssignmentLock.assignment_source,
      proposal_id: params.proposalId ?? null,
      was_override: wasOverride,
      chosen_rank: params.chosenRank ?? null,
      candidate_count: params.candidateSnapshot?.length ?? null,
      candidates: params.candidateSnapshot ?? null,
    });
    void logAssignmentChange(admin, [{
      tenantId,
      serviceDate: date,
      serviceId,
      groupId,
      changeType,
      ...driverFields,
      fromVehicleLabel: prevVehicleLabel,
      toVehicleLabel: newVehicleLabel,
      features,
      operatorId: userId,
    }])
      .then(() => updateLearnedPatterns(admin, tenantId))
      // best-effort: un errore qui (insert history o aggiornamento pattern
      // appresi) non deve mai propagarsi come unhandled rejection né
      // alterare la risposta già inviata al client.
      .catch(() => undefined);
  }

  return { status: 200, body: { ok: true, group_id: groupId } };
}
