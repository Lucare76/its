/**
 * POST /api/ops/assign-service
 * Assegna o rimuove un singolo servizio creando sempre un trip_group con group_id.
 * Usato da dispatch, service-workflow e dashboard per garantire che le
 * assegnazioni siano visibili nel Piano del Giorno.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { validateDriverGeographicBatch } from "@/lib/server/geo-assignment";
import { type SupabaseClient } from "@supabase/supabase-js";
import { auditLog } from "@/lib/server/ops-audit";
import { vehicleIntervalsOverlap } from "@/lib/piano-vehicle-timeline";
import { effectiveServiceDisembarkTime, minutesFromHHMM } from "@/lib/piano-arrival-time";

export const runtime = "nodejs";

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

function isServiceAssignableForManualAssignment(service: { status?: string | null; is_draft?: boolean | null }): boolean {
  if (service.is_draft === true) return false;
  if (service.status && NON_ASSIGNABLE_SERVICE_STATUSES.has(service.status)) return false;
  return true;
}

function serviceNotAssignableResponse(): NextResponse {
  return NextResponse.json(
    { ok: false, error: "SERVICE_NOT_ASSIGNABLE", message: "Il servizio non può essere assegnato nello stato attuale." },
    { status: 409 }
  );
}

function serviceVehicleOperationalMinutes(service: VehicleOverlapServiceFields): number | null {
  const timeStr =
    service.direction === "departure"
      ? (service.pickup_hotel ?? service.time)?.slice(0, 5) ?? null
      : effectiveServiceDisembarkTime(service) ?? service.time?.slice(0, 5) ?? null;
  return timeStr ? minutesFromHHMM(timeStr) : null;
}

function vehicleOverlapResponse(): NextResponse {
  return NextResponse.json(
    { ok: false, error: "VEHICLE_OVERLAP", message: "Il mezzo è già impegnato in un altro servizio nello stesso orario." },
    { status: 409 }
  );
}

function vehicleCheckFailedResponse(): NextResponse {
  return NextResponse.json(
    { ok: false, error: "VEHICLE_CHECK_FAILED", message: "Errore durante la verifica della disponibilità del mezzo." },
    { status: 500 }
  );
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
async function checkVehicleOverlap(
  admin: SupabaseClient,
  tenantId: string,
  input: {
    serviceId: string;
    service: VehicleOverlapServiceFields;
    vehicleLabel: string;
    excludeGroupId?: string | null;
  },
  context: { userId?: string }
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const label = input.vehicleLabel.trim();
  if (!label) return { ok: true };

  const candidateStart = serviceVehicleOperationalMinutes(input.service);
  if (candidateStart == null) return { ok: true };
  const candidateInterval = { start_min: candidateStart, end_min: candidateStart + VEHICLE_OVERLAP_DURATION_MINUTES };

  const dbErrorResponse = (stage: string, dbCode: string | null) => {
    auditLog({
      event: "assign_service_vehicle_check_failed",
      level: "error",
      tenantId,
      userId: context.userId ?? null,
      details: { serviceId: input.serviceId, stage, dbCode },
    });
    return { ok: false as const, response: vehicleCheckFailedResponse() };
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
  if (groupsError) return dbErrorResponse("trip_groups", (groupsError as { code?: string }).code ?? null);

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

  if (assignmentsError) return dbErrorResponse("assignments", (assignmentsError as { code?: string }).code ?? null);

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
      return { ok: false, response: vehicleOverlapResponse() };
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
function driverNotFoundResponse(): NextResponse {
  return NextResponse.json({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." }, { status: 404 });
}

async function verifyDriverBelongsToTenant(
  admin: SupabaseClient,
  tenantId: string,
  input: { driverUserId?: string | null; driverProfileId?: string | null },
  context: { userId?: string }
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const driverUserId = input.driverUserId ?? null;
  const driverProfileId = input.driverProfileId ?? null;

  if (!driverUserId && !driverProfileId) {
    return { ok: true };
  }

  const verificationFailedResponse = (dbCode: string | null) => {
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
      ok: false as const,
      response: NextResponse.json(
        { ok: false, error: "DRIVER_VERIFICATION_FAILED", message: "Errore durante la verifica dell'autista." },
        { status: 500 }
      ),
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

    if (error) return verificationFailedResponse((error as { code?: string }).code ?? null);
    if (!data?.user_id) return { ok: false, response: driverNotFoundResponse() };
  }

  if (driverProfileId) {
    const { data, error } = await admin
      .from("driver_profiles")
      .select("id, user_id")
      .eq("tenant_id", tenantId)
      .eq("id", driverProfileId)
      .maybeSingle();

    if (error) return verificationFailedResponse((error as { code?: string }).code ?? null);
    if (!data?.id) return { ok: false, response: driverNotFoundResponse() };
    profileUserId = (data.user_id as string | null) ?? null;
  }

  // Coppia incoerente: il profilo indicato è già collegato a un altro utente.
  if (driverUserId && driverProfileId && profileUserId && profileUserId !== driverUserId) {
    return { ok: false, response: driverNotFoundResponse() };
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

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const tenantId = auth.membership.tenant_id;
    const userId = auth.user.id;

    type Body = {
      service_id: string;
      driver_user_id?: string | null;
      driver_profile_id?: string | null;
      vehicle_label?: string | null;
      action?: "assign" | "remove";
    };

    const body = (await request.json().catch(() => null)) as Body | null;
    if (!body?.service_id) {
      return NextResponse.json({ ok: false, error: "service_id obbligatorio." }, { status: 400 });
    }

    const action = body.action ?? "assign";
    const now = new Date().toISOString();
    const manualAssignmentLock = {
      assignment_source: "manual_assign_service",
      locked_by_operator: true,
      assigned_by: userId,
      assigned_at: now,
      lock_reason: "manual_assignment_from_assign_service",
    };

    // Recupera il servizio per avere la data
    const { data: service, error: serviceErr } = await auth.admin
      .from("services")
      .select(
        "id, date, status, is_draft, time, pickup_hotel, direction, hotel_id, meeting_point, arrival_time, orario_barca, porto_bruno, barca_compagnia, booking_service_kind, service_type_code, vessel, ferry_details"
      )
      .eq("id", body.service_id)
      .eq("tenant_id", tenantId)
      .maybeSingle();

    if (serviceErr || !service) {
      return NextResponse.json({ ok: false, error: "Servizio non trovato." }, { status: 404 });
    }

    const date = service.date as string;

    // FUNC-02: guard stato servizio, solo per l'azione "assign" (remove deve
    // restare sempre possibile, anche su un servizio non più operativo, per
    // permettere di ripulire un'assegnazione residua es. dopo cancellazione).
    // Deve precedere qualunque altro guard/scrittura successiva.
    if (action === "assign" && !isServiceAssignableForManualAssignment(service as { status?: string | null; is_draft?: boolean | null })) {
      return serviceNotAssignableResponse();
    }

    // SEC-05: verifica ownership tenant del driver, solo per l'azione "assign"
    // (remove non tocca driver_user_id/driver_profile_id). Deve avvenire prima
    // di qualunque altro guard/scrittura successiva.
    if (action === "assign") {
      const driverOwnership = await verifyDriverBelongsToTenant(
        auth.admin,
        tenantId,
        { driverUserId: body.driver_user_id ?? null, driverProfileId: body.driver_profile_id ?? null },
        { userId }
      );
      if (!driverOwnership.ok) return driverOwnership.response;
    }

    // Verifica disponibilità confermata
    const { data: availability } = await auth.admin
      .from("daily_availability_confirmations")
      .select("confirmed")
      .eq("tenant_id", tenantId)
      .eq("date", date)
      .maybeSingle();

    if (!availability?.confirmed) {
      return NextResponse.json({
        ok: false,
        error: "Disponibilita del giorno non confermata. Completa prima la conferma in Disponibilita."
      }, { status: 409 });
    }

    // Recupera assignment esistente
    const { data: existingAssignment } = await auth.admin
      .from("assignments")
      .select("id, group_id")
      .eq("service_id", body.service_id)
      .eq("tenant_id", tenantId)
      .maybeSingle();

    // ─── REMOVE ───────────────────────────────────────────────────────────────
    if (action === "remove") {
      if (!existingAssignment) {
        return NextResponse.json({ ok: true });
      }
      await auth.admin.from("assignments").delete().eq("id", existingAssignment.id).eq("tenant_id", tenantId);

      if (existingAssignment.group_id) {
        const { data: remaining } = await auth.admin
          .from("assignments")
          .select("id")
          .eq("group_id", existingAssignment.group_id)
          .eq("tenant_id", tenantId);
        if (!remaining?.length) {
          await auth.admin.from("trip_groups")
            .update({ status: "cancelled", updated_at: now })
            .eq("id", existingAssignment.group_id)
            .eq("tenant_id", tenantId);
        }
      }

      await auth.admin.from("services").update({ status: "new" }).eq("id", body.service_id).eq("tenant_id", tenantId);
      return NextResponse.json({ ok: true });
    }

    // ─── ASSIGN ───────────────────────────────────────────────────────────────
    if (body.driver_user_id) {
      const geoValidation = await validateDriverGeographicBatch(auth.admin, tenantId, body.driver_user_id, [{
        id: service.id as string,
        time: service.time as string,
        pickup_hotel: service.pickup_hotel as string | null,
        direction: service.direction as "arrival" | "departure",
        hotel_id: service.hotel_id as string | null,
        meeting_point: service.meeting_point as string | null,
      }]);
      if (!geoValidation.ok) {
        return NextResponse.json({ ok: false, error: geoValidation.error }, { status: 409 });
      }
    }

    // CONC-03: verifica overlap mezzo, solo se vehicle_label è presente/non
    // vuoto — comportamento invariato altrimenti. Deve avvenire prima di
    // qualunque scrittura su trip_groups/assignments.
    if (body.vehicle_label && body.vehicle_label.trim()) {
      const vehicleCheck = await checkVehicleOverlap(
        auth.admin,
        tenantId,
        {
          serviceId: body.service_id,
          service: service as unknown as VehicleOverlapServiceFields,
          vehicleLabel: body.vehicle_label,
          excludeGroupId: existingAssignment?.group_id ?? null,
        },
        { userId }
      );
      if (!vehicleCheck.ok) return vehicleCheck.response;
    }

    let groupId: string;

    if (existingAssignment?.group_id) {
      groupId = existingAssignment.group_id as string;
      await Promise.all([
        auth.admin.from("trip_groups").update({
          driver_user_id: body.driver_user_id ?? null,
          driver_profile_id: body.driver_profile_id ?? null,
          vehicle_label: body.vehicle_label ?? null,
          updated_at: now,
        }).eq("id", groupId).eq("tenant_id", tenantId),
        auth.admin.from("assignments").update({
          driver_user_id: body.driver_user_id ?? null,
          driver_profile_id: body.driver_profile_id ?? null,
          vehicle_label: body.vehicle_label ?? "",
          ...manualAssignmentLock,
        }).eq("id", existingAssignment.id).eq("tenant_id", tenantId),
      ]);
    } else {
      // Rimuovi eventuale assignment vecchio senza group_id
      if (existingAssignment) {
        await auth.admin.from("assignments").delete().eq("id", existingAssignment.id).eq("tenant_id", tenantId);
      }

      const { data: newGroup, error: groupErr } = await auth.admin
        .from("trip_groups")
        .insert({
          tenant_id: tenantId,
          date,
          driver_user_id: body.driver_user_id ?? null,
          driver_profile_id: body.driver_profile_id ?? null,
          vehicle_label: body.vehicle_label ?? null,
          created_by: userId,
          created_at: now,
          updated_at: now,
        })
        .select("id")
        .single();

      if (groupErr || !newGroup?.id) {
        return NextResponse.json({ ok: false, error: groupErr?.message ?? "Errore creazione giro." }, { status: 500 });
      }

      groupId = newGroup.id as string;

      const { error: assignmentInsertError } = await auth.admin.from("assignments").insert({
        tenant_id: tenantId,
        service_id: body.service_id,
        driver_user_id: body.driver_user_id ?? null,
        driver_profile_id: body.driver_profile_id ?? null,
        vehicle_label: body.vehicle_label ?? "",
        group_id: groupId,
        ...manualAssignmentLock,
      });

      if (assignmentInsertError) {
        const cleanupSucceeded = await cleanupCreatedTripGroup(auth.admin, tenantId, groupId);

        if (assignmentInsertError.code === "23505") {
          auditLog({
            event: "assignment_conflict",
            level: "warn",
            tenantId,
            userId,
            details: {
              serviceId: body.service_id,
              groupIdCreated: groupId,
              cleanupAttempted: true,
              cleanupSucceeded,
            },
          });
          return NextResponse.json(
            {
              ok: false,
              error: "SERVICE_ALREADY_ASSIGNED",
              message: "Il servizio è già stato assegnato da un altro operatore. Ricarica la pagina.",
            },
            { status: 409 }
          );
        }

        auditLog({
          event: "assignment_insert_failed",
          level: "error",
          tenantId,
          userId,
          details: {
            serviceId: body.service_id,
            groupIdCreated: groupId,
            cleanupAttempted: true,
            cleanupSucceeded,
            dbCode: assignmentInsertError.code ?? null,
          },
        });
        return NextResponse.json(
          { ok: false, error: "ASSIGNMENT_FAILED", message: "Errore durante l'assegnazione. Riprova." },
          { status: 500 }
        );
      }
    }

    await auth.admin.from("services").update({ status: "assigned" }).eq("id", body.service_id).eq("tenant_id", tenantId);

    await auth.admin.from("status_events").upsert({
      tenant_id: tenantId,
      service_id: body.service_id,
      status: "assigned",
      at: now,
      by_user_id: userId,
    }, { onConflict: "tenant_id,service_id,status", ignoreDuplicates: true });

    return NextResponse.json({ ok: true, group_id: groupId });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Errore." },
      { status: 500 }
    );
  }
}
