/**
 * POST /api/ops/piano-giorno/trips
 * Gestisce creazione, modifica ed eliminazione dei giri del Piano del Giorno.
 *
 * Actions:
 *   create_trip   — crea gruppo + assignments per i servizi selezionati
 *   update_trip   — aggiorna driver/mezzo/note del gruppo; ricalcola assignments
 *   delete_trip   — elimina gruppo, rimuove assignments, riporta servizi a "new"
 *   move_services — sposta servizi da un giro a un altro (o crea nuovo giro)
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { loadVehicleCommitmentsForDate } from "@/lib/server/vehicle-commitments";
import {
  isVehicleManuallyBlockedOnDate,
  manualVehicleBlockMessage,
  type VehicleManualBlock,
} from "@/lib/server/vehicle-availability";
import { sendPushToUser } from "@/lib/server/web-push";
import {
  validateGeographicCompatibility,
  type GeographicCompatibilityService,
} from "@/lib/server/geo-assignment";
import { canDriverUseVehicle } from "@/lib/piano-driver-vehicle-eligibility";
import { canDriverCoverInterval } from "@/lib/piano-driver-availability";
import { effectiveServiceDisembarkTime } from "@/lib/piano-arrival-time";
import { type SupabaseClient } from "@supabase/supabase-js";
import { extractFeatures, logAssignmentChange } from "@/lib/server/assignment-history";
import { updateLearnedPatterns } from "@/lib/server/learned-patterns";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";
const LARGE_GROUP_PAX_THRESHOLD = 21;
const VEHICLE_SHARE_BUFFER_MINUTES = 20;
const SERVICE_VALIDATION_COLUMNS = "id, time, pickup_hotel, direction, pax, hotel_id, meeting_point, arrival_time, orario_barca, porto_bruno, barca_compagnia, booking_service_kind, service_type_code, vessel, ferry_details";
const ASSIGNMENT_SERVICE_VALIDATION_COLUMNS = `group_id, services!inner(${SERVICE_VALIDATION_COLUMNS})`;

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const tenantId = auth.membership.tenant_id;
    const userId = auth.user.id;

    type Body = {
      action: "create_trip" | "update_trip" | "delete_trip" | "move_services" | "swap_driver" | "swap_vehicle" | "delay_vessel";
      // create_trip / common
      date?: string;
      service_ids?: string[];
      driver_user_id?: string | null;
      driver_profile_id?: string | null;
      vehicle_label?: string | null;
      vehicle_id?: string | null;
      vehicle_capacity?: number | null;
      notes?: string | null;
      // update_trip / delete_trip / move_services
      group_id?: string;
      // move_services
      target_group_id?: string | null;
      // swap_driver
      from_driver_id?: string;
      to_driver_id?: string;
      from_driver_profile_id?: string;
      to_driver_profile_id?: string;
      // swap_vehicle
      from_vehicle_label?: string;
      to_vehicle_label?: string;
      // delay_vessel
      vessel?: string;
      original_time?: string;
      delay_minutes?: number;
    };

    const body = (await request.json().catch(() => null)) as Body | null;
    if (!body?.action) {
      return NextResponse.json({ ok: false, error: "action obbligatoria." }, { status: 400 });
    }

    const now = new Date().toISOString();

    // ─── CREATE TRIP ──────────────────────────────────────────────────────────
    if (body.action === "create_trip") {
      const { date, service_ids, driver_user_id, driver_profile_id, vehicle_label, vehicle_id, vehicle_capacity, notes } = body;
      if (!date || !service_ids?.length) {
        return NextResponse.json({ ok: false, error: "date e service_ids obbligatori." }, { status: 400 });
      }
      const ownership = await verifyServiceIdsBelongToTenant(auth.admin, tenantId, service_ids, {
        userId,
        action: "create_trip",
      });
      if (!ownership.ok) return ownership.response;
      const verifiedServiceIds = ownership.uniqueServiceIds;

      // SEC-05 residuo: verifica ownership tenant del driver, prima di
      // qualunque altro guard/scrittura successiva. Stesso pattern già usato
      // in assign-service/departure-bus-assign. Perimetro: solo create_trip
      // in questa sessione — update_trip/move_services/swap_driver restano
      // follow-up separati dello stesso finding.
      const driverOwnership = await verifyTripDriverBelongsToTenant(
        auth.admin,
        tenantId,
        { driverUserId: driver_user_id ?? null, driverProfileId: driver_profile_id ?? null },
        { actorUserId: userId, action: "create_trip" }
      );
      if (!driverOwnership.ok) return driverOwnership.response;

      // FUNC-02 residuo: verifica che nessuno dei servizi selezionati sia in
      // uno stato non operativo prima di creare il giro. Stessa denylist già
      // in uso in assign-service (SERVICE_STATUS_CHECK), non nuova. Deve
      // precedere availability/validateTripPayload e qualunque scrittura.
      const serviceStatusCheck = await verifyTripServicesOperationalStatus(
        auth.admin,
        tenantId,
        verifiedServiceIds,
        { userId, action: "create_trip" }
      );
      if (!serviceStatusCheck.ok) return serviceStatusCheck.response;

      // FUNC-03 residuo: verifica che il driver, già confermato tenant-scoped
      // da SEC-05, sia anche operativo (non sospeso/non disattivato). Stesso
      // segnale già in uso in assign-service (verifyDriverIsOperational).
      // Helper separato da SEC-05 per mantenere distinti 404 (ownership) da
      // 409 (operatività). Deve precedere availability/validateTripPayload e
      // qualunque scrittura.
      const driverOperational = await verifyTripDriverIsOperational(
        auth.admin,
        tenantId,
        { driverUserId: driver_user_id ?? null, driverProfileId: driver_profile_id ?? null },
        { actorUserId: userId, action: "create_trip" }
      );
      if (!driverOperational.ok) return driverOperational.response;

      const confirmationError = await ensureAvailabilityConfirmed(auth.admin, tenantId, date);
      if (confirmationError) {
        return NextResponse.json({ ok: false, error: confirmationError }, { status: 409 });
      }
      const validation = await validateTripPayload(auth.admin, tenantId, {
        date,
        serviceIds: verifiedServiceIds,
        driverUserId: driver_user_id ?? null,
        driverProfileId: driver_profile_id ?? null,
        vehicleCapacity: vehicle_capacity ?? null,
      });
      if (!validation.ok) {
        return NextResponse.json({ ok: false, error: validation.error }, { status: validation.status ?? 409 });
      }
      const vehicleCheck = await resolveVehicleAssignment(auth.admin, tenantId, date, vehicle_id ?? null, vehicle_label ?? null);
      if (!vehicleCheck.ok) {
        return NextResponse.json({ ok: false, error: vehicleCheck.error }, { status: 409 });
      }
      if (vehicleCheck.vehicle?.capacity != null && validation.totalPax > vehicleCheck.vehicle.capacity) {
        return NextResponse.json({ ok: false, error: `Overbooking bloccante: ${validation.totalPax} pax su mezzo da ${vehicleCheck.vehicle.capacity}.` }, { status: 409 });
      }
      const driverVehicleEligibility = await validateDriverVehicleEligibilityPayload(auth.admin, tenantId, {
        driverUserId: driver_user_id ?? null,
        driverProfileId: driver_profile_id ?? null,
        vehicle: vehicleCheck.vehicle,
      });
      if (!driverVehicleEligibility.ok) {
        return NextResponse.json({ ok: false, error: driverVehicleEligibility.error }, { status: 409 });
      }
      const effectiveVehicleLabel = vehicleCheck.vehicle?.label ?? vehicle_label ?? null;
      const vehicleConflict = await validateVehicleTimelinePayload(auth.admin, tenantId, {
        date,
        serviceIds: verifiedServiceIds,
        vehicleLabel: effectiveVehicleLabel,
        driverUserId: driver_user_id ?? null,
        driverProfileId: driver_profile_id ?? null,
      });
      if (!vehicleConflict.ok) {
        return NextResponse.json({ ok: false, error: vehicleConflict.error }, { status: vehicleConflict.status ?? 409 });
      }
      const warnings = [...validation.warnings, ...vehicleConflict.warnings];

      // 1. Crea trip_group
      const { data: group, error: groupErr } = await auth.admin
        .from("trip_groups")
        .insert({
          tenant_id: tenantId,
          date,
          driver_user_id: driver_user_id || null,
          driver_profile_id: driver_profile_id || null,
          vehicle_label: effectiveVehicleLabel || null,
          vehicle_capacity: (vehicleCheck.vehicle?.capacity ?? vehicle_capacity) || null,
          notes: notes || null,
          created_by: userId,
          created_at: now,
          updated_at: now,
        })
        .select("id")
        .single();

      if (groupErr || !group?.id) {
        return NextResponse.json({ ok: false, error: groupErr?.message ?? "Errore creazione giro." }, { status: 500 });
      }

      const groupId = group.id as string;

      // CONC-07: snapshot "prima" degli assignments realmente coinvolti,
      // tenant-scoped, subito prima dell'upsert — _assignServicesToGroup
      // (helper condiviso con move_services, non modificato qui) esegue un
      // upsert su (service_id, tenant_id): un servizio può già avere un
      // assignment preesistente (es. da auto-assign) che l'upsert sovrascrive,
      // quindi "previous" non è mai assunto null per default. Se la lettura
      // fallisce (errore Supabase o eccezione sincrona), previousSnapshotFailed
      // viene marcato e la costruzione dello storico più sotto viene saltata
      // per l'intera richiesta (mai previous values indovinati/falsi) — ma la
      // creazione del giro prosegue comunque: policy best-effort già stabilita
      // altrove.
      let previousByServiceId = new Map<
        string,
        { group_id?: string | null; driver_user_id?: string | null; driver_profile_id?: string | null; vehicle_label?: string | null }
      >();
      let previousSnapshotFailed = false;
      try {
        const { data: previousAssignmentsData, error: previousAssignmentsError } = await auth.admin
          .from("assignments")
          .select("service_id, group_id, driver_user_id, driver_profile_id, vehicle_label")
          .eq("tenant_id", tenantId)
          .in("service_id", verifiedServiceIds);
        if (previousAssignmentsError) {
          previousSnapshotFailed = true;
        } else {
          previousByServiceId = new Map(
            (previousAssignmentsData ?? []).map((row) => [
              row.service_id as string,
              row as { group_id?: string | null; driver_user_id?: string | null; driver_profile_id?: string | null; vehicle_label?: string | null },
            ])
          );
        }
      } catch {
        previousSnapshotFailed = true;
      }

      // 2. Assignments + status update per ogni servizio
      await _assignServicesToGroup(
        auth.admin,
        tenantId,
        verifiedServiceIds,
        groupId,
        driver_user_id ?? null,
        driver_profile_id ?? null,
        effectiveVehicleLabel,
        userId,
        now
      );

      // CONC-07: registra lo storico strutturato per ogni service_id
      // realmente assegnato al nuovo giro. _assignServicesToGroup (helper
      // condiviso, non modificato) non propaga errori dall'upsert: la
      // "conferma successo" richiesta dal contratto arriva quindi da una
      // rilettura tenant-scoped degli assignments realmente scritti con
      // group_id = groupId — solo i service_id confermati con questo
      // group_id producono un evento. Riusa esattamente il contratto già in
      // uso in move_services/assign-service/departure-bus-assign/swap_driver/
      // swap_vehicle: changeType "driver_swap" se il driver è cambiato (porta
      // con sé anche i valori mezzo), "vehicle_binding" se è cambiato solo il
      // mezzo — nessun changeType nuovo, nessun "manual_assign" inventato.
      // Nessun evento se né driver né mezzo sono cambiati (caso tipico:
      // create_trip senza driver né mezzo). Condizionato allo snapshot: nessun
      // previous indovinato se lo snapshot è fallito. Intero blocco avvolto in
      // try/catch e fire-and-forget: mai bloccare né alterare la risposta
      // principale già determinata (già inviata sotto, invariata).
      if (!previousSnapshotFailed) {
        try {
          const { data: confirmedAssignments } = await auth.admin
            .from("assignments")
            .select("service_id")
            .eq("tenant_id", tenantId)
            .eq("group_id", groupId)
            .in("service_id", verifiedServiceIds);
          const confirmedServiceIds = new Set((confirmedAssignments ?? []).map((row) => row.service_id as string));

          const { data: featureServices } = await auth.admin
            .from("services")
            .select(SERVICE_VALIDATION_COLUMNS)
            .eq("tenant_id", tenantId)
            .in("id", verifiedServiceIds);
          const featureServiceRows = (featureServices ?? []) as ServiceValidationRow[];
          const featureHotelIds = Array.from(new Set(featureServiceRows.map((service) => service.hotel_id).filter((id): id is string => Boolean(id))));
          const { data: featureHotels } = featureHotelIds.length > 0
            ? await auth.admin
                .from("hotels")
                .select("id, zone")
                .eq("tenant_id", tenantId)
                .in("id", featureHotelIds)
            : { data: [] };
          const featureServiceMap = new Map(featureServiceRows.map((service) => [service.id, service]));
          const featureHotelMap = new Map((featureHotels ?? []).map((hotel) => [hotel.id as string, hotel as HotelValidationRow]));

          // Rilevazione del cambiamento su driver_user_id (l'identificativo
          // sempre presente nel body, come in swap_driver/departure-bus-assign)
          // — non su driver_profile_id, che il body di create_trip può
          // legittimamente omettere pur specificando un driver reale.
          // driver_profile_id per l'entry resta comunque valorizzato quando
          // possibile: se il body lo fornisce esplicitamente viene usato
          // direttamente, altrimenti risolto con un lookup tenant-scoped
          // best-effort su driver_profiles a partire da driver_user_id.
          const newDriverUserId = driver_user_id ?? null;
          let newDriverProfileId = driver_profile_id ?? null;
          if (!newDriverProfileId && newDriverUserId) {
            const { data: newDriverProfileRow } = await auth.admin
              .from("driver_profiles")
              .select("id")
              .eq("tenant_id", tenantId)
              .eq("user_id", newDriverUserId)
              .maybeSingle();
            newDriverProfileId = (newDriverProfileRow?.id as string | undefined) ?? null;
          }
          const newVehicleLabel = (effectiveVehicleLabel ?? null) || null;

          const historyEntries = verifiedServiceIds.flatMap((serviceId) => {
            if (!confirmedServiceIds.has(serviceId)) return [];

            const previous = previousByServiceId.get(serviceId);
            const prevDriverUserId = previous?.driver_user_id ?? null;
            const prevDriverProfileId = previous?.driver_profile_id ?? null;
            const prevVehicleLabel = (previous?.vehicle_label ?? null) || null;
            const driverChanged = prevDriverUserId !== newDriverUserId;
            const vehicleChanged = prevVehicleLabel !== newVehicleLabel;
            if (!driverChanged && !vehicleChanged) return [];

            const changeType = driverChanged ? ("driver_swap" as const) : ("vehicle_binding" as const);
            const service = featureServiceMap.get(serviceId);
            const hotel = service?.hotel_id ? featureHotelMap.get(service.hotel_id) : null;
            const driverFields = driverChanged
              ? { fromDriverProfileId: prevDriverProfileId, toDriverProfileId: newDriverProfileId }
              : {};
            const features = extractFeatures({
              serviceDate: date,
              changeType,
              ...driverFields,
              fromVehicleLabel: prevVehicleLabel,
              toVehicleLabel: newVehicleLabel,
              direction: service?.direction ?? null,
              zone: hotel?.zone ?? service?.meeting_point ?? null,
              time: service ? serviceOperationalTime(service) : null,
              vessel: service?.vessel ?? service?.barca_compagnia ?? null,
              pax: service?.pax ?? null,
              isNavetta: service ? isNavettaService(service) : false,
            });
            return [{
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
            }];
          });

          if (historyEntries.length > 0) {
            void logAssignmentChange(auth.admin, historyEntries)
              .then(() => updateLearnedPatterns(auth.admin, tenantId))
              .catch(() => undefined);
          }
        } catch {
          // best-effort: mai bloccare né alterare la risposta principale già determinata.
        }
      }

      // 3. Push all'autista se assegnato
      if (driver_user_id) {
        const { data: firstService } = await auth.admin
          .from("services")
          .select("time, customer_name, pax")
          .eq("tenant_id", tenantId)
          .in("id", verifiedServiceIds)
          .order("time")
          .limit(1)
          .maybeSingle();
        const label = firstService
          ? `${firstService.time.slice(0, 5)} — ${firstService.customer_name} · ${firstService.pax} pax`
          : `${verifiedServiceIds.length} servizi`;
        void sendPushToUser(tenantId, driver_user_id, {
          title: `🚌 Nuovo giro assegnato — ${date}`,
          body: label,
          url: "/driver",
          tag: `trip-assigned-${groupId}`,
        });
      }

      return NextResponse.json({ ok: true, group_id: groupId, warnings });
    }

    // ─── UPDATE TRIP ──────────────────────────────────────────────────────────
    if (body.action === "update_trip") {
      const { group_id, driver_user_id, driver_profile_id, vehicle_label, vehicle_id, vehicle_capacity, notes, service_ids } = body;
      if (!group_id) {
        return NextResponse.json({ ok: false, error: "group_id obbligatorio." }, { status: 400 });
      }
      const { data: groupMeta } = await auth.admin
        .from("trip_groups")
        .select("date, driver_profile_id, driver_user_id, vehicle_label")
        .eq("id", group_id)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      const groupDate = groupMeta?.date as string | undefined;
      const prevDriverProfileId = groupMeta?.driver_profile_id as string | null ?? null;
      const prevVehicleLabel = groupMeta?.vehicle_label as string | null ?? null;
      if (!groupDate) {
        return NextResponse.json({ ok: false, error: "Data giro non trovata." }, { status: 404 });
      }
      let verifiedServiceIds: string[] | null = null;
      if (service_ids) {
        const ownership = await verifyServiceIdsBelongToTenant(auth.admin, tenantId, service_ids, {
          userId,
          action: "update_trip",
        });
        if (!ownership.ok) return ownership.response;
        verifiedServiceIds = ownership.uniqueServiceIds;
      }

      // SEC-05 residuo: stesso guard già usato in create_trip, riusato qui
      // (nessun nuovo helper). Verifica contro i valori finali che verranno
      // scritti su trip_groups/assignments più sotto (`driver_user_id ?? null`
      // / `driver_profile_id ?? null`, righe ~315-330) — non i campi grezzi
      // del body prima del default — così da coprire esattamente ciò che
      // arriva a scrittura, incluso il caso di aggiornamento parziale in cui
      // solo uno dei due campi viene inviato dal client. Deve precedere
      // availability/validateTripPayload e qualunque scrittura.
      const driverOwnership = await verifyTripDriverBelongsToTenant(
        auth.admin,
        tenantId,
        { driverUserId: driver_user_id ?? null, driverProfileId: driver_profile_id ?? null },
        { actorUserId: userId, action: "update_trip" }
      );
      if (!driverOwnership.ok) return driverOwnership.response;

      const effectiveServiceIds = verifiedServiceIds ?? await loadGroupServiceIds(auth.admin, tenantId, group_id);

      // FUNC-02 residuo: stesso guard/denylist già usati in create_trip,
      // riusato qui (nessun nuovo helper/denylist). Verificato sull'insieme
      // FINALE dei servizi del giro (`effectiveServiceIds`, riga precedente),
      // non sui soli service_ids ricevuti dal body: se il client omette
      // service_ids, l'insieme finale resta quello già associato al gruppo
      // (letto da loadGroupServiceIds), quindi un giro che contiene già un
      // servizio bloccato viene comunque rifiutato — a meno che
      // l'aggiornamento stesso lo rimuova esplicitamente dal nuovo
      // service_ids, nel qual caso l'insieme finale non lo contiene più e
      // l'update correttivo passa. Deve precedere availability/
      // validateTripPayload e qualunque scrittura.
      const serviceStatusCheck = await verifyTripServicesOperationalStatus(
        auth.admin,
        tenantId,
        effectiveServiceIds,
        { userId, action: "update_trip" }
      );
      if (!serviceStatusCheck.ok) return serviceStatusCheck.response;

      // FUNC-03 residuo: stesso guard già usato in create_trip, riusato qui
      // (nessun nuovo helper). Verifica gli stessi valori finali usati da
      // SEC-05 sopra (`driver_user_id ?? null` / `driver_profile_id ?? null`)
      // — quelli che verranno effettivamente persistiti su
      // trip_groups/assignments più sotto. Deve precedere availability/
      // validateTripPayload e qualunque scrittura.
      const driverOperational = await verifyTripDriverIsOperational(
        auth.admin,
        tenantId,
        { driverUserId: driver_user_id ?? null, driverProfileId: driver_profile_id ?? null },
        { actorUserId: userId, action: "update_trip" }
      );
      if (!driverOperational.ok) return driverOperational.response;

      const confirmationError = await ensureAvailabilityConfirmed(auth.admin, tenantId, groupDate);
      if (confirmationError) {
        return NextResponse.json({ ok: false, error: confirmationError }, { status: 409 });
      }
      const validation = await validateTripPayload(auth.admin, tenantId, {
        date: groupDate,
        serviceIds: effectiveServiceIds,
        driverUserId: driver_user_id ?? null,
        driverProfileId: driver_profile_id ?? null,
        vehicleCapacity: vehicle_capacity ?? null,
        excludeGroupId: group_id,
      });
      if (!validation.ok) {
        return NextResponse.json({ ok: false, error: validation.error }, { status: validation.status ?? 409 });
      }
      const vehicleCheck = groupDate
        ? await resolveVehicleAssignment(auth.admin, tenantId, groupDate, vehicle_id ?? null, vehicle_label ?? null)
        : { ok: true as const, vehicle: null };
      if (!vehicleCheck.ok) {
        return NextResponse.json({ ok: false, error: vehicleCheck.error }, { status: 409 });
      }
      if (vehicleCheck.vehicle?.capacity != null && validation.totalPax > vehicleCheck.vehicle.capacity) {
        return NextResponse.json({ ok: false, error: `Overbooking bloccante: ${validation.totalPax} pax su mezzo da ${vehicleCheck.vehicle.capacity}.` }, { status: 409 });
      }
      const driverVehicleEligibility = await validateDriverVehicleEligibilityPayload(auth.admin, tenantId, {
        driverUserId: driver_user_id ?? null,
        driverProfileId: driver_profile_id ?? null,
        vehicle: vehicleCheck.vehicle,
      });
      if (!driverVehicleEligibility.ok) {
        return NextResponse.json({ ok: false, error: driverVehicleEligibility.error }, { status: 409 });
      }
      const effectiveVehicleLabel = vehicleCheck.vehicle?.label ?? vehicle_label ?? null;
      const vehicleConflict = await validateVehicleTimelinePayload(auth.admin, tenantId, {
        date: groupDate,
        serviceIds: effectiveServiceIds,
        vehicleLabel: effectiveVehicleLabel,
        driverUserId: driver_user_id ?? null,
        driverProfileId: driver_profile_id ?? null,
        excludeGroupId: group_id,
      });
      if (!vehicleConflict.ok) {
        return NextResponse.json({ ok: false, error: vehicleConflict.error }, { status: vehicleConflict.status ?? 409 });
      }
      const warnings = [...validation.warnings, ...vehicleConflict.warnings];

      // CONC-07: il driver_swap esistente (blocco più sotto) copre già il
      // caso "driver cambiato" a livello di gruppo. Il gap residuo è il
      // cambio-solo-mezzo: driver invariato ma vehicle_label per-service
      // diverso dal finale. prevVehicleLabel (sopra) è il valore del solo
      // trip_group, non affidabile per ogni assignment del gruppo — quindi
      // se il driver non cambia, snapshot minimo tenant-scoped degli
      // assignments realmente presenti nel gruppo PRIMA della mutazione
      // sotto, stesso pattern già validato in swap_vehicle. Se lo snapshot
      // fallisce, vehicleSnapshotFailed viene marcato e nessun previous
      // viene indovinato più sotto — ma l'update principale prosegue
      // comunque (best-effort).
      const driverChanged = (driver_profile_id ?? null) !== prevDriverProfileId;
      let previousVehicleByServiceId = new Map<string, { vehicle_label?: string | null }>();
      let vehicleSnapshotFailed = false;
      if (!driverChanged) {
        try {
          const { data: previousAssignmentsData, error: previousAssignmentsError } = await auth.admin
            .from("assignments")
            .select("service_id, vehicle_label")
            .eq("tenant_id", tenantId)
            .eq("group_id", group_id);
          if (previousAssignmentsError) {
            vehicleSnapshotFailed = true;
          } else {
            previousVehicleByServiceId = new Map(
              (previousAssignmentsData ?? []).map((row) => [
                row.service_id as string,
                row as { vehicle_label?: string | null },
              ])
            );
          }
        } catch {
          vehicleSnapshotFailed = true;
        }
      }

      // Aggiorna trip_group
      await auth.admin
        .from("trip_groups")
        .update({
          driver_user_id: driver_user_id ?? null,
          driver_profile_id: driver_profile_id ?? null,
          vehicle_label: effectiveVehicleLabel,
          vehicle_capacity: vehicleCheck.vehicle?.capacity ?? vehicle_capacity ?? null,
          notes: notes ?? null,
          updated_at: now,
        })
        .eq("id", group_id)
        .eq("tenant_id", tenantId);

      // Aggiorna assignments esistenti del gruppo
      await auth.admin
        .from("assignments")
        .update({
          driver_user_id: driver_user_id ?? null,
          driver_profile_id: driver_profile_id ?? null,
          vehicle_label: effectiveVehicleLabel,
          assignment_source: "manual_piano_giorno",
          locked_by_operator: true,
          assigned_by: userId,
          assigned_at: now,
          lock_reason: "manual_assignment_from_daily_plan",
        })
        .eq("group_id", group_id)
        .eq("tenant_id", tenantId);

      // Push all'autista se il driver è stato (ri)assegnato
      if (driver_user_id) {
        const { data: firstAssignment } = await auth.admin
          .from("assignments")
          .select("services!inner(date, time, customer_name, pax)")
          .eq("group_id", group_id)
          .eq("tenant_id", tenantId)
          .limit(1)
          .maybeSingle();
        const svc = (firstAssignment?.services as unknown) as { date: string; time: string; customer_name: string; pax: number } | null;
        const label = svc
          ? `${svc.time.slice(0, 5)} — ${svc.customer_name} · ${svc.pax} pax`
          : "Giro aggiornato";
        void sendPushToUser(tenantId, driver_user_id, {
          title: `🚌 Giro aggiornato — ${svc?.date ?? "oggi"}`,
          body: label,
          url: "/driver",
          tag: `trip-updated-${group_id}`,
        });
      }

      // Se passati nuovi service_ids, riassegna (add/remove dal gruppo)
      if (verifiedServiceIds !== null) {
        // Rimuovi servizi che non sono più nel gruppo
        const { data: existing } = await auth.admin
          .from("assignments")
          .select("id, service_id")
          .eq("group_id", group_id)
          .eq("tenant_id", tenantId);

        const existingIds = new Set((existing ?? []).map((a) => a.service_id as string));
        const newIds = new Set(verifiedServiceIds);

        // Servizi rimossi dal gruppo → cancella assignment o svincola
        const toRemove = (existing ?? []).filter((a) => !newIds.has(a.service_id as string));
        if (toRemove.length > 0) {
          await Promise.all([
            auth.admin.from("assignments").delete().in("id", toRemove.map((a) => a.id)).eq("tenant_id", tenantId),
            auth.admin.from("services").update({ status: "new" }).in("id", toRemove.map((a) => a.service_id)).eq("tenant_id", tenantId),
          ]);
        }

        // Servizi aggiunti → nuovi assignments
        const toAdd = verifiedServiceIds.filter((id) => !existingIds.has(id));
        if (toAdd.length > 0) {
          await _assignServicesToGroup(auth.admin, tenantId, toAdd, group_id, driver_user_id ?? null, driver_profile_id ?? null, vehicle_label ?? null, userId, now);
        }
      }

      // Log driver swap se il driver_profile_id è cambiato
      if (driverChanged) {
        const allServiceIds = verifiedServiceIds ?? await loadGroupServiceIds(auth.admin, tenantId, group_id);
        const { data: featureServices } = allServiceIds.length > 0
          ? await auth.admin
              .from("services")
              .select(SERVICE_VALIDATION_COLUMNS)
              .eq("tenant_id", tenantId)
              .in("id", allServiceIds)
          : { data: [] };
        const featureServiceRows = (featureServices ?? []) as ServiceValidationRow[];
        const featureHotelIds = Array.from(new Set(featureServiceRows.map((service) => service.hotel_id).filter((id): id is string => Boolean(id))));
        const { data: featureHotels } = featureHotelIds.length > 0
          ? await auth.admin
              .from("hotels")
              .select("id, zone")
              .eq("tenant_id", tenantId)
              .in("id", featureHotelIds)
          : { data: [] };
        const featureServiceMap = new Map(featureServiceRows.map((service) => [service.id, service]));
        const featureHotelMap = new Map((featureHotels ?? []).map((hotel) => [hotel.id as string, hotel as HotelValidationRow]));
        const entries = allServiceIds.map((serviceId) => {
          const service = featureServiceMap.get(serviceId);
          const hotel = service?.hotel_id ? featureHotelMap.get(service.hotel_id) : null;
          const features = extractFeatures({
            serviceDate: groupDate!,
            changeType: "driver_swap",
            fromDriverProfileId: prevDriverProfileId,
            toDriverProfileId: driver_profile_id ?? null,
            fromVehicleLabel: prevVehicleLabel,
            toVehicleLabel: vehicle_label ?? null,
            direction: service?.direction ?? null,
            zone: hotel?.zone ?? service?.meeting_point ?? null,
            time: service ? serviceOperationalTime(service) : null,
            vessel: service?.vessel ?? service?.barca_compagnia ?? null,
            pax: service?.pax ?? null,
            isNavetta: service ? isNavettaService(service) : false,
          });
          return {
            tenantId,
            serviceDate: groupDate!,
            serviceId,
            groupId: group_id,
            changeType: "driver_swap" as const,
            fromDriverProfileId: prevDriverProfileId,
            toDriverProfileId: driver_profile_id ?? null,
            fromVehicleLabel: prevVehicleLabel,
            toVehicleLabel: vehicle_label ?? null,
            features,
            operatorId: userId,
          };
        });
        void logAssignmentChange(auth.admin, entries).then(() =>
          updateLearnedPatterns(auth.admin, tenantId).catch(() => undefined)
        );
      } else if (!vehicleSnapshotFailed) {
        // CONC-07: cambio-solo-mezzo (driver invariato). Riusa esattamente
        // il contratto già in uso in swap_vehicle: changeType
        // "vehicle_binding", nessun campo driver nell'entry, previous
        // per-service dallo snapshot preso subito prima della mutazione
        // sopra (mai il valore group-level, che può non coincidere con ogni
        // assignment). "allServiceIds" qui è l'insieme FINALE del gruppo
        // dopo add/remove — i servizi rimossi non ci sono più (nessun
        // evento di rimozione), i servizi aggiunti hanno previous null nello
        // snapshot (nessuna voce pre-esistente) e producono comunque un
        // evento se viene loro assegnato un mezzo reale. Previous già
        // uguale al finale non produce mai evento. Intero blocco avvolto in
        // try/catch e fire-and-forget: mai bloccare né alterare la risposta
        // principale già determinata.
        try {
          const allServiceIds = verifiedServiceIds ?? await loadGroupServiceIds(auth.admin, tenantId, group_id);
          const newVehicleLabel = (effectiveVehicleLabel ?? null) || null;
          const changedServiceIds = allServiceIds.filter((serviceId) => {
            const previous = previousVehicleByServiceId.get(serviceId);
            const prevLabel = (previous?.vehicle_label ?? null) || null;
            return prevLabel !== newVehicleLabel;
          });

          if (changedServiceIds.length > 0) {
            const { data: featureServices } = await auth.admin
              .from("services")
              .select(SERVICE_VALIDATION_COLUMNS)
              .eq("tenant_id", tenantId)
              .in("id", changedServiceIds);
            const featureServiceRows = (featureServices ?? []) as ServiceValidationRow[];
            const featureHotelIds = Array.from(new Set(featureServiceRows.map((service) => service.hotel_id).filter((id): id is string => Boolean(id))));
            const { data: featureHotels } = featureHotelIds.length > 0
              ? await auth.admin
                  .from("hotels")
                  .select("id, zone")
                  .eq("tenant_id", tenantId)
                  .in("id", featureHotelIds)
              : { data: [] };
            const featureServiceMap = new Map(featureServiceRows.map((service) => [service.id, service]));
            const featureHotelMap = new Map((featureHotels ?? []).map((hotel) => [hotel.id as string, hotel as HotelValidationRow]));

            const vehicleHistoryEntries = changedServiceIds.map((serviceId) => {
              const previous = previousVehicleByServiceId.get(serviceId);
              const prevLabel = (previous?.vehicle_label ?? null) || null;
              const service = featureServiceMap.get(serviceId);
              const hotel = service?.hotel_id ? featureHotelMap.get(service.hotel_id) : null;
              const features = extractFeatures({
                serviceDate: groupDate!,
                changeType: "vehicle_binding",
                fromVehicleLabel: prevLabel,
                toVehicleLabel: newVehicleLabel,
                direction: service?.direction ?? null,
                zone: hotel?.zone ?? service?.meeting_point ?? null,
                time: service ? serviceOperationalTime(service) : null,
                vessel: service?.vessel ?? service?.barca_compagnia ?? null,
                pax: service?.pax ?? null,
                isNavetta: service ? isNavettaService(service) : false,
              });
              return {
                tenantId,
                serviceDate: groupDate!,
                serviceId,
                groupId: group_id,
                changeType: "vehicle_binding" as const,
                fromVehicleLabel: prevLabel,
                toVehicleLabel: newVehicleLabel,
                features,
                operatorId: userId,
              };
            });

            void logAssignmentChange(auth.admin, vehicleHistoryEntries)
              .then(() => updateLearnedPatterns(auth.admin, tenantId))
              .catch(() => undefined);
          }
        } catch {
          // best-effort: mai bloccare né alterare la risposta principale già determinata.
        }
      }

      return NextResponse.json({ ok: true, warnings });
    }

    // ─── DELETE TRIP ──────────────────────────────────────────────────────────
    if (body.action === "delete_trip") {
      const { group_id } = body;
      if (!group_id) {
        return NextResponse.json({ ok: false, error: "group_id obbligatorio." }, { status: 400 });
      }
      const { data: groupMeta } = await auth.admin
        .from("trip_groups")
        .select("date")
        .eq("id", group_id)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (!groupMeta?.date) {
        return NextResponse.json({ ok: false, error: "Data giro non trovata." }, { status: 404 });
      }
      const confirmationError = await ensureAvailabilityConfirmed(auth.admin, tenantId, groupMeta.date as string);
      if (confirmationError) {
        return NextResponse.json({ ok: false, error: confirmationError }, { status: 409 });
      }

      // Recupera service_ids del gruppo prima di cancellare
      const { data: groupAssignments } = await auth.admin
        .from("assignments")
        .select("id, service_id")
        .eq("group_id", group_id)
        .eq("tenant_id", tenantId);

      const serviceIds = (groupAssignments ?? []).map((a) => a.service_id as string);

      await Promise.all([
        auth.admin.from("assignments").delete().eq("group_id", group_id).eq("tenant_id", tenantId),
        auth.admin.from("trip_groups").update({ status: "cancelled", updated_at: now }).eq("id", group_id).eq("tenant_id", tenantId),
      ]);

      if (serviceIds.length > 0) {
        await auth.admin.from("services").update({ status: "new" }).in("id", serviceIds).eq("tenant_id", tenantId);
      }

      return NextResponse.json({ ok: true });
    }

    // ─── MOVE SERVICES ────────────────────────────────────────────────────────
    if (body.action === "move_services") {
      const { service_ids, target_group_id, group_id: source_group_id, driver_user_id, driver_profile_id, vehicle_label, vehicle_id, vehicle_capacity, notes, date } = body;
      if (!service_ids?.length) {
        return NextResponse.json({ ok: false, error: "service_ids obbligatori." }, { status: 400 });
      }

      // FUNC-02 residuo: stesso guard/denylist già usati in create_trip/
      // update_trip, riusato qui (nessun nuovo helper). Verifica solo i
      // service_ids realmente ricevuti nel body (deduplicati), non l'intero
      // insieme di servizi già presenti nel gruppo destinazione: un target
      // group che contiene già un servizio bloccato ma non toccato da questa
      // richiesta non deve mai far fallire lo spostamento. Eseguito PRIMA del
      // branching gruppo-esistente/nuovo-giro — quindi prima dei guard SEC-05
      // di questa action, a differenza dell'ordine in create_trip/update_trip
      // — perché il ramo "nuovo giro" esegue un INSERT su trip_groups subito
      // dopo il proprio guard SEC-05 e prima del guard SEC-05 "valori finali"
      // comune a entrambi i rami: per garantire zero scritture in entrambi i
      // rami con un'unica chiamata (nessun helper duplicato né doppia query),
      // FUNC-02 deve necessariamente precedere qui ogni guard SEC-05.
      const uniqueMovedServiceIds = [...new Set(service_ids)];
      const serviceStatusCheck = await verifyTripServicesOperationalStatus(
        auth.admin,
        tenantId,
        uniqueMovedServiceIds,
        { userId, action: "move_services" }
      );
      if (!serviceStatusCheck.ok) return serviceStatusCheck.response;

      let destGroupId = target_group_id;
      const warnings: string[] = [];
      const hasExistingTargetGroup = Boolean(target_group_id);

      // Se target_group_id è null → crea un nuovo giro
      if (!destGroupId) {
        if (!date) return NextResponse.json({ ok: false, error: "date obbligatoria per nuovo giro." }, { status: 400 });

        // SEC-05 residuo (ramo nuovo giro): stesso guard già usato in
        // create_trip/update_trip/swap_driver, riusato qui (nessun nuovo
        // helper). driver_user_id/driver_profile_id del body vengono scritti
        // direttamente nell'insert di trip_groups poco sotto — vanno
        // verificati PRIMA di quella scrittura, non dopo (a differenza del
        // guard sui "valori finali" più sotto, che protegge invece
        // l'update di assignments comune a entrambi i rami).
        const newGroupDriverOwnership = await verifyTripDriverBelongsToTenant(
          auth.admin,
          tenantId,
          { driverUserId: driver_user_id ?? null, driverProfileId: driver_profile_id ?? null },
          { actorUserId: userId, action: "move_services" }
        );
        if (!newGroupDriverOwnership.ok) return newGroupDriverOwnership.response;

        // FUNC-03 residuo (ramo nuovo giro): stesso guard già usato in
        // create_trip/update_trip/swap_driver, riusato qui (nessun nuovo
        // helper). Verifica gli stessi driver_user_id/driver_profile_id del
        // body appena confermati tenant-scoped da SEC-05 sopra — quelli che
        // verranno scritti nell'insert di trip_groups poco sotto. Deve
        // precedere quella scrittura, non seguirla.
        const newGroupDriverOperational = await verifyTripDriverIsOperational(
          auth.admin,
          tenantId,
          { driverUserId: driver_user_id ?? null, driverProfileId: driver_profile_id ?? null },
          { actorUserId: userId, action: "move_services" }
        );
        if (!newGroupDriverOperational.ok) return newGroupDriverOperational.response;

        const confirmationError = await ensureAvailabilityConfirmed(auth.admin, tenantId, date);
        if (confirmationError) {
          return NextResponse.json({ ok: false, error: confirmationError }, { status: 409 });
        }
        const validation = await validateTripPayload(auth.admin, tenantId, {
          date,
          serviceIds: service_ids,
          driverUserId: driver_user_id ?? null,
          driverProfileId: driver_profile_id ?? null,
          vehicleCapacity: vehicle_capacity ?? null,
        });
        if (!validation.ok) {
          return NextResponse.json({ ok: false, error: validation.error }, { status: validation.status ?? 409 });
        }
        warnings.push(...validation.warnings);
        const vehicleCheck = await resolveVehicleAssignment(auth.admin, tenantId, date, vehicle_id ?? null, vehicle_label ?? null);
        if (!vehicleCheck.ok) {
          return NextResponse.json({ ok: false, error: vehicleCheck.error }, { status: 409 });
        }
        if (vehicleCheck.vehicle?.capacity != null && validation.totalPax > vehicleCheck.vehicle.capacity) {
          return NextResponse.json({ ok: false, error: `Overbooking bloccante: ${validation.totalPax} pax su mezzo da ${vehicleCheck.vehicle.capacity}.` }, { status: 409 });
        }
        const driverVehicleEligibility = await validateDriverVehicleEligibilityPayload(auth.admin, tenantId, {
          driverUserId: driver_user_id ?? null,
          driverProfileId: driver_profile_id ?? null,
          vehicle: vehicleCheck.vehicle,
        });
        if (!driverVehicleEligibility.ok) {
          return NextResponse.json({ ok: false, error: driverVehicleEligibility.error }, { status: 409 });
        }
        const effectiveVehicleLabel = vehicleCheck.vehicle?.label ?? vehicle_label ?? null;
        const vehicleConflict = await validateVehicleTimelinePayload(auth.admin, tenantId, {
          date,
          serviceIds: service_ids,
          vehicleLabel: effectiveVehicleLabel,
          driverUserId: driver_user_id ?? null,
          driverProfileId: driver_profile_id ?? null,
        });
        if (!vehicleConflict.ok) {
          return NextResponse.json({ ok: false, error: vehicleConflict.error }, { status: vehicleConflict.status ?? 409 });
        }
        warnings.push(...vehicleConflict.warnings);
        const { data: newGroup, error: newGroupErr } = await auth.admin
          .from("trip_groups")
          .insert({
            tenant_id: tenantId,
            date,
            driver_user_id: driver_user_id || null,
            driver_profile_id: driver_profile_id || null,
            vehicle_label: effectiveVehicleLabel || null,
            vehicle_capacity: (vehicleCheck.vehicle?.capacity ?? vehicle_capacity) || null,
            notes: notes || null,
            created_by: userId,
            created_at: now,
            updated_at: now,
          })
          .select("id")
          .single();
        if (newGroupErr || !newGroup?.id) {
          return NextResponse.json({ ok: false, error: newGroupErr?.message ?? "Errore creazione giro." }, { status: 500 });
        }
        destGroupId = newGroup.id as string;
      }

      // SEC-02: quando il gruppo destinazione è stato fornito dal client (non
      // appena creato da noi sopra), va verificato senza alcun fallback su
      // `date` — altrimenti un target_group_id inesistente o di un altro
      // tenant potrebbe proseguire usando la data fornita dall'attaccante.
      if (hasExistingTargetGroup) {
        const { data: destGroupMeta } = await auth.admin
          .from("trip_groups")
          .select("date")
          .eq("id", destGroupId)
          .eq("tenant_id", tenantId)
          .maybeSingle();
        if (!destGroupMeta?.date) {
          auditLog({
            event: "piano_trip_target_group_ownership_check_failed",
            level: "warn",
            tenantId,
            userId,
            details: { action: "move_services", reason: "target_group_ownership_mismatch" },
          });
          return NextResponse.json({ ok: false, error: "Giro di destinazione non trovato." }, { status: 404 });
        }
        const confirmationError = await ensureAvailabilityConfirmed(auth.admin, tenantId, destGroupMeta.date as string);
        if (confirmationError) {
          return NextResponse.json({ ok: false, error: confirmationError }, { status: 409 });
        }
      }

      // Ottieni driver/vehicle del giro destinazione
      const { data: destGroup } = await auth.admin
        .from("trip_groups")
        .select("date, driver_user_id, driver_profile_id, vehicle_label, vehicle_capacity")
        .eq("id", destGroupId)
        .eq("tenant_id", tenantId)
        .maybeSingle();

      const destDriver = destGroup?.driver_user_id ?? driver_user_id ?? null;
      const destDriverProfile = destGroup?.driver_profile_id ?? driver_profile_id ?? null;
      const destVehicle = destGroup?.vehicle_label ?? vehicle_label ?? null;

      // SEC-05 residuo (valori finali, entrambi i rami): stesso guard già
      // usato in create_trip/update_trip/swap_driver, riusato qui. Verifica
      // destDriver/destDriverProfile — i valori FINALI che verranno scritti
      // su assignments.update poco sotto — non i soli campi del body. Copre
      // in particolare il caso "giro destinazione esistente senza driver",
      // dove destDriver ricade sul driver_user_id del body (riga precedente)
      // mai verificato finora. Quando il giro destinazione ha già un driver
      // proprio, destDriver proviene da un valore già persistito (validato
      // da un'action precedente protetta da questo stesso guard) — non è un
      // nuovo dato client-controlled, ma viene comunque riverificato qui per
      // difesa in profondità, coerente con "il guard deve ricevere i valori
      // finali reali". Deve precedere timeline/eligibility e la scrittura.
      const finalDriverOwnership = await verifyTripDriverBelongsToTenant(
        auth.admin,
        tenantId,
        { driverUserId: destDriver, driverProfileId: destDriverProfile },
        { actorUserId: userId, action: "move_services" }
      );
      if (!finalDriverOwnership.ok) return finalDriverOwnership.response;

      // FUNC-03 residuo (valori finali, entrambi i rami): stesso guard già
      // usato in create_trip/update_trip/swap_driver, riusato qui. Verifica
      // destDriver/destDriverProfile — gli stessi valori FINALI appena
      // confermati tenant-scoped da SEC-05 sopra — non i soli campi del
      // body. Deve precedere timeline/eligibility e l'update di assignments
      // più sotto, in entrambi i rami (nel ramo nuovo giro il driver è già
      // stato verificato operativo prima dell'insert, ma qui si valida
      // comunque il valore finale per difesa in profondità, coerente con
      // SEC-05 sopra).
      const finalDriverOperational = await verifyTripDriverIsOperational(
        auth.admin,
        tenantId,
        { driverUserId: destDriver, driverProfileId: destDriverProfile },
        { actorUserId: userId, action: "move_services" }
      );
      if (!finalDriverOperational.ok) return finalDriverOperational.response;

      if (destDriver && destGroupId) {
        const targetServiceIds = [...new Set([...(await loadGroupServiceIds(auth.admin, tenantId, destGroupId)), ...service_ids])];
        const { data: destGroupDate } = await auth.admin
          .from("trip_groups")
          .select("date")
          .eq("id", destGroupId)
          .eq("tenant_id", tenantId)
          .maybeSingle();
        const validation = await validateTripPayload(auth.admin, tenantId, {
          date: (destGroupDate?.date as string | undefined) ?? date ?? "",
          serviceIds: targetServiceIds,
          driverUserId: destDriver,
          driverProfileId: destDriverProfile,
          vehicleCapacity: (destGroup?.vehicle_capacity as number | null) ?? vehicle_capacity ?? null,
          excludeGroupId: destGroupId,
        });
        if (!validation.ok) {
          return NextResponse.json({ ok: false, error: validation.error }, { status: validation.status ?? 409 });
        }
        warnings.push(...validation.warnings);
        const destVehicleCheck = await resolveVehicleAssignment(auth.admin, tenantId, (destGroupDate?.date as string | undefined) ?? date ?? "", null, destVehicle);
        if (!destVehicleCheck.ok) {
          return NextResponse.json({ ok: false, error: destVehicleCheck.error }, { status: 409 });
        }
        const driverVehicleEligibility = await validateDriverVehicleEligibilityPayload(auth.admin, tenantId, {
          driverUserId: destDriver,
          driverProfileId: destDriverProfile,
          vehicle: destVehicleCheck.vehicle,
        });
        if (!driverVehicleEligibility.ok) {
          return NextResponse.json({ ok: false, error: driverVehicleEligibility.error }, { status: 409 });
        }
        const vehicleConflict = await validateVehicleTimelinePayload(auth.admin, tenantId, {
          date: (destGroupDate?.date as string | undefined) ?? date ?? "",
          serviceIds: targetServiceIds,
          vehicleLabel: destVehicle,
          driverUserId: destDriver,
          driverProfileId: destDriverProfile,
          excludeGroupId: destGroupId,
        });
        if (!vehicleConflict.ok) {
          return NextResponse.json({ ok: false, error: vehicleConflict.error }, { status: vehicleConflict.status ?? 409 });
        }
        warnings.push(...vehicleConflict.warnings);
      }

      // CONC-07: snapshot "prima" degli assignments realmente spostati,
      // tenant-scoped, subito prima della mutazione — stesso pattern già
      // validato in departure-bus-assign (nessuna query esistente sopra lo
      // fornisce con i campi necessari). Se la lettura fallisce (errore
      // Supabase o eccezione sincrona), previousSnapshotFailed viene
      // marcato e la costruzione dello storico più sotto viene saltata per
      // l'intera richiesta (mai previous values indovinati/falsi) — ma lo
      // spostamento principale prosegue comunque: policy best-effort già
      // stabilita altrove, un problema diagnostico sullo storico non deve
      // mai bloccare l'operazione principale.
      let previousByServiceId = new Map<
        string,
        { driver_profile_id?: string | null; vehicle_label?: string | null }
      >();
      let previousSnapshotFailed = false;
      try {
        const { data: previousAssignmentsData, error: previousAssignmentsError } = await auth.admin
          .from("assignments")
          .select("service_id, driver_profile_id, vehicle_label")
          .eq("tenant_id", tenantId)
          .in("service_id", uniqueMovedServiceIds);
        if (previousAssignmentsError) {
          previousSnapshotFailed = true;
        } else {
          previousByServiceId = new Map(
            (previousAssignmentsData ?? []).map((row) => [
              row.service_id as string,
              row as { driver_profile_id?: string | null; vehicle_label?: string | null },
            ])
          );
        }
      } catch {
        previousSnapshotFailed = true;
      }

      // Aggiorna assignments (cambia group_id)
      const { error: assignmentsUpdateError } = await auth.admin
        .from("assignments")
        .update({
          group_id: destGroupId,
          driver_user_id: destDriver,
          driver_profile_id: destDriverProfile,
          vehicle_label: destVehicle,
          assignment_source: "manual_piano_giorno",
          locked_by_operator: true,
          assigned_by: userId,
          assigned_at: now,
          lock_reason: "manual_assignment_from_daily_plan",
        })
        .in("service_id", service_ids)
        .eq("tenant_id", tenantId);

      // CONC-07: registra lo storico strutturato per ogni service_id
      // realmente spostato (uniqueMovedServiceIds, non il `service_ids`
      // grezzo del body: un duplicato nel body non deve produrre due
      // entry). Riusa esattamente il contratto/precedenza già in uso in
      // assign-service/update_trip: changeType "driver_swap" se il
      // driver_profile_id è cambiato (porta con sé anche i valori mezzo),
      // "vehicle_binding" se è cambiato solo il mezzo — nessun changeType
      // nuovo. Un cambio di solo group_id (stesso driver, stesso mezzo)
      // non produce alcun evento: lo schema non ha un change_type per
      // questo caso e non se ne inventa uno (stesso limite già accettato
      // per le rimozioni). Condizionato al successo della mutazione sopra
      // e allo snapshot: nessun evento su mutazione fallita, nessun
      // previous indovinato se lo snapshot è fallito. Intero blocco
      // avvolto in try/catch e fire-and-forget: mai bloccare né alterare
      // la risposta principale già determinata.
      if (!assignmentsUpdateError && !previousSnapshotFailed) {
        try {
          const effectiveDate = (destGroup?.date as string | undefined) ?? date ?? "";
          const { data: featureServices } = await auth.admin
            .from("services")
            .select(SERVICE_VALIDATION_COLUMNS)
            .eq("tenant_id", tenantId)
            .in("id", uniqueMovedServiceIds);
          const featureServiceRows = (featureServices ?? []) as ServiceValidationRow[];
          const featureHotelIds = Array.from(new Set(featureServiceRows.map((service) => service.hotel_id).filter((id): id is string => Boolean(id))));
          const { data: featureHotels } = featureHotelIds.length > 0
            ? await auth.admin
                .from("hotels")
                .select("id, zone")
                .eq("tenant_id", tenantId)
                .in("id", featureHotelIds)
            : { data: [] };
          const featureServiceMap = new Map(featureServiceRows.map((service) => [service.id, service]));
          const featureHotelMap = new Map((featureHotels ?? []).map((hotel) => [hotel.id as string, hotel as HotelValidationRow]));

          const newDriverProfileId = destDriverProfile ?? null;
          const newVehicleLabel = (destVehicle ?? null) || null;

          const historyEntries = uniqueMovedServiceIds.flatMap((serviceId) => {
            const previous = previousByServiceId.get(serviceId);
            const prevDriverProfileId = previous?.driver_profile_id ?? null;
            const prevVehicleLabel = (previous?.vehicle_label ?? null) || null;
            const driverChanged = prevDriverProfileId !== newDriverProfileId;
            const vehicleChanged = prevVehicleLabel !== newVehicleLabel;
            if (!driverChanged && !vehicleChanged) return [];

            const changeType = driverChanged ? ("driver_swap" as const) : ("vehicle_binding" as const);
            const service = featureServiceMap.get(serviceId);
            const hotel = service?.hotel_id ? featureHotelMap.get(service.hotel_id) : null;
            const driverFields = driverChanged
              ? { fromDriverProfileId: prevDriverProfileId, toDriverProfileId: newDriverProfileId }
              : {};
            const features = extractFeatures({
              serviceDate: effectiveDate,
              changeType,
              ...driverFields,
              fromVehicleLabel: prevVehicleLabel,
              toVehicleLabel: newVehicleLabel,
              direction: service?.direction ?? null,
              zone: hotel?.zone ?? service?.meeting_point ?? null,
              time: service ? serviceOperationalTime(service) : null,
              vessel: service?.vessel ?? service?.barca_compagnia ?? null,
              pax: service?.pax ?? null,
              isNavetta: service ? isNavettaService(service) : false,
            });
            return [{
              tenantId,
              serviceDate: effectiveDate,
              serviceId,
              groupId: destGroupId,
              changeType,
              ...driverFields,
              fromVehicleLabel: prevVehicleLabel,
              toVehicleLabel: newVehicleLabel,
              features,
              operatorId: userId,
            }];
          });

          if (historyEntries.length > 0) {
            void logAssignmentChange(auth.admin, historyEntries)
              .then(() => updateLearnedPatterns(auth.admin, tenantId))
              .catch(() => undefined);
          }
        } catch {
          // best-effort: mai bloccare né alterare la risposta principale già determinata.
        }
      }

      // Verifica se il gruppo sorgente è rimasto vuoto → cancellalo
      if (source_group_id) {
        const { data: remaining } = await auth.admin
          .from("assignments")
          .select("id")
          .eq("group_id", source_group_id)
          .eq("tenant_id", tenantId);
        if (!remaining?.length) {
          await auth.admin.from("trip_groups").update({ status: "cancelled", updated_at: now }).eq("id", source_group_id).eq("tenant_id", tenantId);
        }
      }

      return NextResponse.json({ ok: true, group_id: destGroupId, warnings: [...new Set(warnings)] });
    }

    // ─── SWAP DRIVER ─────────────────────────────────────────────────────────────
    if (body.action === "swap_driver") {
      const { date, from_driver_id, to_driver_id } = body;
      if (!date || !from_driver_id || !to_driver_id) {
        return NextResponse.json({ ok: false, error: "date, from_driver_id e to_driver_id obbligatori." }, { status: 400 });
      }

      const { data: groups, error: groupsErr } = await auth.admin
        .from("trip_groups")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("date", date)
        .eq("driver_user_id", from_driver_id)
        .eq("status", "active");

      if (groupsErr) {
        return NextResponse.json({ ok: false, error: groupsErr.message }, { status: 500 });
      }

      // SEC-05 residuo: stesso guard già usato in create_trip/update_trip,
      // riusato qui (nessun nuovo helper). swap_driver usa solo to_driver_id
      // (un driver_user_id semplice) — from_driver_profile_id/
      // to_driver_profile_id sono dichiarati nel tipo Body ma non usati da
      // nessuna action, quindi nessun driverProfileId da verificare qui.
      // Eseguito prima di qualunque scrittura, indipendentemente dal fatto
      // che from_driver_id abbia o meno giri attivi per la data (altrimenti
      // un to_driver_id invalido con zero giri sorgente passerebbe
      // silenziosamente senza mai essere verificato).
      const targetDriverOwnership = await verifyTripDriverBelongsToTenant(
        auth.admin,
        tenantId,
        { driverUserId: to_driver_id, driverProfileId: null },
        { actorUserId: userId, action: "swap_driver" }
      );
      if (!targetDriverOwnership.ok) return targetDriverOwnership.response;

      // FUNC-03 residuo: stesso guard già usato in create_trip/update_trip,
      // riusato qui (nessun nuovo helper). Verifica solo memberships.suspended
      // per to_driver_id — nessun driverProfileId (swap_driver non usa un
      // profilo reale, vedi nota SEC-05 sopra), quindi nessuna query su
      // driver_profiles. Deve precedere timeline/availability e qualunque
      // scrittura.
      const targetDriverOperational = await verifyTripDriverIsOperational(
        auth.admin,
        tenantId,
        { driverUserId: to_driver_id, driverProfileId: null },
        { actorUserId: userId, action: "swap_driver" }
      );
      if (!targetDriverOperational.ok) return targetDriverOperational.response;

      const groupIds = (groups ?? []).map((g) => g.id as string);
      if (!groupIds.length) {
        return NextResponse.json({ ok: true, affected: 0 });
      }

      const movedServiceIds = (await Promise.all(groupIds.map((groupId) => loadGroupServiceIds(auth.admin, tenantId, groupId)))).flat();
      const validation = await validateTripPayload(auth.admin, tenantId, {
        date,
        serviceIds: movedServiceIds,
        driverUserId: to_driver_id,
        driverProfileId: null,
        vehicleCapacity: null,
      });
      if (!validation.ok) {
        return NextResponse.json({ ok: false, error: validation.error }, { status: validation.status ?? 409 });
      }
      const warnings = validation.warnings;

      // CONC-07: snapshot "prima" degli assignments realmente coinvolti dallo
      // swap, tenant-scoped, subito prima della mutazione bulk — stesso
      // pattern già validato in move_services/departure-bus-assign. Se la
      // lettura fallisce (errore Supabase o eccezione sincrona),
      // previousSnapshotFailed viene marcato e la costruzione dello storico
      // più sotto viene saltata per l'intera richiesta (mai previous values
      // indovinati/falsi) — ma lo swap principale prosegue comunque: policy
      // best-effort già stabilita altrove.
      let previousByServiceId = new Map<
        string,
        { group_id?: string | null; driver_user_id?: string | null; driver_profile_id?: string | null; vehicle_label?: string | null }
      >();
      let previousSnapshotFailed = false;
      try {
        const { data: previousAssignmentsData, error: previousAssignmentsError } = await auth.admin
          .from("assignments")
          .select("service_id, group_id, driver_user_id, driver_profile_id, vehicle_label")
          .eq("tenant_id", tenantId)
          .in("group_id", groupIds);
        if (previousAssignmentsError) {
          previousSnapshotFailed = true;
        } else {
          previousByServiceId = new Map(
            (previousAssignmentsData ?? []).map((row) => [
              row.service_id as string,
              row as { group_id?: string | null; driver_user_id?: string | null; driver_profile_id?: string | null; vehicle_label?: string | null },
            ])
          );
        }
      } catch {
        previousSnapshotFailed = true;
      }

      const [tripGroupsUpdateResult, assignmentsUpdateResult] = await Promise.all([
        auth.admin.from("trip_groups").update({ driver_user_id: to_driver_id, updated_at: now }).in("id", groupIds).eq("tenant_id", tenantId),
        auth.admin.from("assignments").update({
          driver_user_id: to_driver_id,
          assignment_source: "manual_piano_giorno",
          locked_by_operator: true,
          assigned_by: userId,
          assigned_at: now,
          lock_reason: "manual_assignment_from_daily_plan",
        }).in("group_id", groupIds).eq("tenant_id", tenantId),
      ]);

      // CONC-07: registra lo storico strutturato per ogni service_id
      // realmente coinvolto nello swap (deduplicato via previousByServiceId,
      // che è già una Map per service_id). Riusa esattamente il contratto già
      // in uso in move_services/assign-service/departure-bus-assign:
      // changeType "driver_swap" — nessun changeType nuovo. swap_driver non
      // tocca vehicle_label, quindi non serve mai vehicle_binding qui.
      // Rilevazione del cambiamento su driver_user_id (l'unico identificativo
      // reale che questa action riceve dal body, come in
      // departure-bus-assign) — non su driver_profile_id, che qui è solo
      // best-effort/informativo. from_driver_id === to_driver_id non produce
      // mai evento (nessuno swap reale). Condizionato al successo della
      // mutazione bulk sopra e allo snapshot: nessun evento su mutazione
      // fallita, nessun previous indovinato se lo snapshot è fallito. Intero
      // blocco avvolto in try/catch e fire-and-forget: mai bloccare né
      // alterare la risposta principale già determinata.
      if (!tripGroupsUpdateResult.error && !assignmentsUpdateResult.error && !previousSnapshotFailed && from_driver_id !== to_driver_id) {
        try {
          const { data: newDriverProfileRow, error: newDriverProfileError } = await auth.admin
            .from("driver_profiles")
            .select("id")
            .eq("tenant_id", tenantId)
            .eq("user_id", to_driver_id)
            .maybeSingle();
          if (newDriverProfileError) throw new Error(newDriverProfileError.message);
          const newDriverProfileId = (newDriverProfileRow?.id as string | undefined) ?? null;

          const { data: featureServices } = await auth.admin
            .from("services")
            .select(SERVICE_VALIDATION_COLUMNS)
            .eq("tenant_id", tenantId)
            .in("id", movedServiceIds);
          const featureServiceRows = (featureServices ?? []) as ServiceValidationRow[];
          const featureHotelIds = Array.from(new Set(featureServiceRows.map((service) => service.hotel_id).filter((id): id is string => Boolean(id))));
          const { data: featureHotels } = featureHotelIds.length > 0
            ? await auth.admin
                .from("hotels")
                .select("id, zone")
                .eq("tenant_id", tenantId)
                .in("id", featureHotelIds)
            : { data: [] };
          const featureServiceMap = new Map(featureServiceRows.map((service) => [service.id, service]));
          const featureHotelMap = new Map((featureHotels ?? []).map((hotel) => [hotel.id as string, hotel as HotelValidationRow]));

          const historyEntries = [...previousByServiceId.entries()].flatMap(([serviceId, previous]) => {
            const prevDriverUserId = previous?.driver_user_id ?? null;
            if (prevDriverUserId === to_driver_id) return [];

            const prevDriverProfileId = previous?.driver_profile_id ?? null;
            const prevVehicleLabel = (previous?.vehicle_label ?? null) || null;
            const service = featureServiceMap.get(serviceId);
            const hotel = service?.hotel_id ? featureHotelMap.get(service.hotel_id) : null;
            const features = extractFeatures({
              serviceDate: date,
              changeType: "driver_swap",
              fromDriverProfileId: prevDriverProfileId,
              toDriverProfileId: newDriverProfileId,
              fromVehicleLabel: prevVehicleLabel,
              toVehicleLabel: prevVehicleLabel,
              direction: service?.direction ?? null,
              zone: hotel?.zone ?? service?.meeting_point ?? null,
              time: service ? serviceOperationalTime(service) : null,
              vessel: service?.vessel ?? service?.barca_compagnia ?? null,
              pax: service?.pax ?? null,
              isNavetta: service ? isNavettaService(service) : false,
            });
            return [{
              tenantId,
              serviceDate: date,
              serviceId,
              groupId: previous?.group_id ?? null,
              changeType: "driver_swap" as const,
              fromDriverProfileId: prevDriverProfileId,
              toDriverProfileId: newDriverProfileId,
              fromVehicleLabel: prevVehicleLabel,
              toVehicleLabel: prevVehicleLabel,
              features,
              operatorId: userId,
            }];
          });

          if (historyEntries.length > 0) {
            void logAssignmentChange(auth.admin, historyEntries)
              .then(() => updateLearnedPatterns(auth.admin, tenantId))
              .catch(() => undefined);
          }
        } catch {
          // best-effort: mai bloccare né alterare la risposta principale già determinata.
        }
      }

      void sendPushToUser(tenantId, to_driver_id, {
        title: `🔄 Giri riassegnati — ${date}`,
        body: `${groupIds.length} giro/i trasferiti dal collega`,
        url: "/driver",
        tag: `trip-swap-driver-${date}`,
      });

      return NextResponse.json({ ok: true, affected: groupIds.length, warnings });
    }

    // ─── SWAP VEHICLE ─────────────────────────────────────────────────────────────
    if (body.action === "swap_vehicle") {
      const { date, from_vehicle_label, to_vehicle_label } = body;
      if (!date || !from_vehicle_label || !to_vehicle_label) {
        return NextResponse.json({ ok: false, error: "date, from_vehicle_label e to_vehicle_label obbligatori." }, { status: 400 });
      }

      const warnings: string[] = [];
      const vehicleCheck = await resolveVehicleAssignment(auth.admin, tenantId, date, null, to_vehicle_label);
      if (!vehicleCheck.ok) warnings.push(vehicleCheck.error);

      const { data: groups, error: groupsErr } = await auth.admin
        .from("trip_groups")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("date", date)
        .eq("vehicle_label", from_vehicle_label)
        .eq("status", "active");

      if (groupsErr) {
        return NextResponse.json({ ok: false, error: groupsErr.message }, { status: 500 });
      }

      const groupIds = (groups ?? []).map((g) => g.id as string);
      if (!groupIds.length) {
        return NextResponse.json({ ok: true, affected: 0, warnings });
      }

      // CONC-07: snapshot "prima" degli assignments realmente coinvolti dallo
      // swap, tenant-scoped, subito prima della mutazione bulk — stesso
      // pattern già validato in swap_driver/move_services/
      // departure-bus-assign. Se la lettura fallisce (errore Supabase o
      // eccezione sincrona), previousSnapshotFailed viene marcato e la
      // costruzione dello storico più sotto viene saltata per l'intera
      // richiesta (mai previous values indovinati/falsi) — ma lo swap
      // principale prosegue comunque: policy best-effort già stabilita
      // altrove.
      let previousByServiceId = new Map<
        string,
        { group_id?: string | null; vehicle_label?: string | null }
      >();
      let previousSnapshotFailed = false;
      try {
        const { data: previousAssignmentsData, error: previousAssignmentsError } = await auth.admin
          .from("assignments")
          .select("service_id, group_id, vehicle_label")
          .eq("tenant_id", tenantId)
          .in("group_id", groupIds);
        if (previousAssignmentsError) {
          previousSnapshotFailed = true;
        } else {
          previousByServiceId = new Map(
            (previousAssignmentsData ?? []).map((row) => [
              row.service_id as string,
              row as { group_id?: string | null; vehicle_label?: string | null },
            ])
          );
        }
      } catch {
        previousSnapshotFailed = true;
      }

      const [tripGroupsUpdateResult, assignmentsUpdateResult] = await Promise.all([
        auth.admin.from("trip_groups").update({ vehicle_label: to_vehicle_label, updated_at: now }).in("id", groupIds).eq("tenant_id", tenantId),
        auth.admin.from("assignments").update({
          vehicle_label: to_vehicle_label,
          assignment_source: "manual_piano_giorno",
          locked_by_operator: true,
          assigned_by: userId,
          assigned_at: now,
          lock_reason: "manual_assignment_from_daily_plan",
        }).in("group_id", groupIds).eq("tenant_id", tenantId),
      ]);

      // CONC-07: registra lo storico strutturato per ogni service_id
      // realmente coinvolto nello swap (deduplicato via previousByServiceId,
      // che è già una Map per service_id). Riusa esattamente il contratto già
      // in uso in move_services/assign-service/departure-bus-assign:
      // changeType "vehicle_binding" — nessun changeType nuovo. swap_vehicle
      // non tocca il driver, quindi non serve mai driver_swap qui né campi
      // driver nell'entry (stesso pattern di apply-vehicle-binding). Previous
      // vehicle già uguale al target non produce mai evento (nessuno swap
      // reale). Condizionato al successo della mutazione bulk sopra e allo
      // snapshot: nessun evento su mutazione fallita, nessun previous
      // indovinato se lo snapshot è fallito. Intero blocco avvolto in
      // try/catch e fire-and-forget: mai bloccare né alterare la risposta
      // principale già determinata.
      if (!tripGroupsUpdateResult.error && !assignmentsUpdateResult.error && !previousSnapshotFailed) {
        try {
          const swappedServiceIds = [...previousByServiceId.keys()];
          const { data: featureServices } = await auth.admin
            .from("services")
            .select(SERVICE_VALIDATION_COLUMNS)
            .eq("tenant_id", tenantId)
            .in("id", swappedServiceIds);
          const featureServiceRows = (featureServices ?? []) as ServiceValidationRow[];
          const featureHotelIds = Array.from(new Set(featureServiceRows.map((service) => service.hotel_id).filter((id): id is string => Boolean(id))));
          const { data: featureHotels } = featureHotelIds.length > 0
            ? await auth.admin
                .from("hotels")
                .select("id, zone")
                .eq("tenant_id", tenantId)
                .in("id", featureHotelIds)
            : { data: [] };
          const featureServiceMap = new Map(featureServiceRows.map((service) => [service.id, service]));
          const featureHotelMap = new Map((featureHotels ?? []).map((hotel) => [hotel.id as string, hotel as HotelValidationRow]));

          const historyEntries = [...previousByServiceId.entries()].flatMap(([serviceId, previous]) => {
            const prevVehicleLabel = (previous?.vehicle_label ?? null) || null;
            const newVehicleLabel = (to_vehicle_label ?? null) || null;
            if (prevVehicleLabel === newVehicleLabel) return [];

            const service = featureServiceMap.get(serviceId);
            const hotel = service?.hotel_id ? featureHotelMap.get(service.hotel_id) : null;
            const features = extractFeatures({
              serviceDate: date,
              changeType: "vehicle_binding",
              fromVehicleLabel: prevVehicleLabel,
              toVehicleLabel: newVehicleLabel,
              direction: service?.direction ?? null,
              zone: hotel?.zone ?? service?.meeting_point ?? null,
              time: service ? serviceOperationalTime(service) : null,
              vessel: service?.vessel ?? service?.barca_compagnia ?? null,
              pax: service?.pax ?? null,
              isNavetta: service ? isNavettaService(service) : false,
            });
            return [{
              tenantId,
              serviceDate: date,
              serviceId,
              groupId: previous?.group_id ?? null,
              changeType: "vehicle_binding" as const,
              fromVehicleLabel: prevVehicleLabel,
              toVehicleLabel: newVehicleLabel,
              features,
              operatorId: userId,
            }];
          });

          if (historyEntries.length > 0) {
            void logAssignmentChange(auth.admin, historyEntries)
              .then(() => updateLearnedPatterns(auth.admin, tenantId))
              .catch(() => undefined);
          }
        } catch {
          // best-effort: mai bloccare né alterare la risposta principale già determinata.
        }
      }

      return NextResponse.json({ ok: true, affected: groupIds.length, warnings });
    }

    // ─── DELAY VESSEL ─────────────────────────────────────────────────────────────
    if (body.action === "delay_vessel") {
      const { date, vessel, original_time, delay_minutes } = body;
      if (!date || !vessel || !original_time || delay_minutes == null) {
        return NextResponse.json({ ok: false, error: "date, vessel, original_time e delay_minutes obbligatori." }, { status: 400 });
      }

      const origMinutes = toMinutes(original_time);

      const { data: affectedServices, error: servicesErr } = await auth.admin
        .from("services")
        .select("id, time, vessel")
        .eq("tenant_id", tenantId)
        .eq("date", date)
        .ilike("vessel", `%${vessel}%`)
        .neq("status", "cancelled");

      if (servicesErr) {
        return NextResponse.json({ ok: false, error: servicesErr.message }, { status: 500 });
      }

      const matched = (affectedServices ?? []).filter((s) => Math.abs(toMinutes(s.time as string) - origMinutes) <= 10);

      if (!matched.length) {
        return NextResponse.json({ ok: true, affected: 0, new_time: null, warnings: ["Nessun servizio trovato per questa corsa."] });
      }

      const newTotalMinutes = origMinutes + Number(delay_minutes);
      const newH = String(Math.floor(newTotalMinutes / 60) % 24).padStart(2, "0");
      const newM = String(newTotalMinutes % 60).padStart(2, "0");
      const newTimeStr = `${newH}:${newM}:00`;
      const matchedIds = matched.map((s) => s.id as string);

      await auth.admin.from("services").update({ time: newTimeStr }).in("id", matchedIds).eq("tenant_id", tenantId);

      // Notifica autisti dei giri coinvolti
      const { data: assignedRows } = await auth.admin
        .from("assignments")
        .select("group_id")
        .in("service_id", matchedIds)
        .eq("tenant_id", tenantId)
        .not("group_id", "is", null);

      const affectedGroupIds = [...new Set((assignedRows ?? []).map((a) => a.group_id as string))];
      if (affectedGroupIds.length) {
        const { data: driverRows } = await auth.admin
          .from("trip_groups")
          .select("driver_user_id")
          .in("id", affectedGroupIds)
          .eq("tenant_id", tenantId)
          .not("driver_user_id", "is", null);

        const driverIds = [...new Set((driverRows ?? []).map((g) => g.driver_user_id as string))];
        for (const driverId of driverIds) {
          void sendPushToUser(tenantId, driverId, {
            title: `⚠️ Ritardo corsa — ${date}`,
            body: `${vessel}: ritardo ${delay_minutes} min. Nuovo orario: ${newH}:${newM}`,
            url: "/driver",
            tag: `delay-vessel-${date}-${vessel}`,
          });
        }
      }

      return NextResponse.json({ ok: true, affected: matchedIds.length, new_time: `${newH}:${newM}` });
    }

    return NextResponse.json({ ok: false, error: "Azione non riconosciuta." }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Errore." },
      { status: 500 }
    );
  }
}

// ─── Helper ───────────────────────────────────────────────────────────────────

// Verifica che tutti i service_ids appartengano al tenant autenticato (SEC-02).
// Deduplica gli id, poi risponde 404 generico identico per id inesistente e id
// di un altro tenant (nessuna distinzione rivelata al client). Un errore nella
// query stessa è fail-closed (500, nessuna scrittura). Deve essere chiamata
// prima di qualsiasi INSERT/UPDATE/UPSERT su assignments/trip_groups.
async function verifyServiceIdsBelongToTenant(
  admin: SupabaseClient,
  tenantId: string,
  serviceIds: string[],
  context: { userId?: string; action: string }
): Promise<
  | { ok: true; uniqueServiceIds: string[] }
  | { ok: false; response: NextResponse }
> {
  const uniqueServiceIds = [...new Set(serviceIds)];
  if (uniqueServiceIds.length === 0) {
    return { ok: true, uniqueServiceIds };
  }

  const { data, error } = await admin
    .from("services")
    .select("id")
    .eq("tenant_id", tenantId)
    .in("id", uniqueServiceIds);

  if (error) {
    auditLog({
      event: "piano_trip_service_ownership_check_failed",
      level: "error",
      tenantId,
      userId: context.userId ?? null,
      details: {
        action: context.action,
        serviceCount: uniqueServiceIds.length,
        error: error.message,
      },
    });
    return {
      ok: false,
      response: NextResponse.json({ ok: false, error: "Errore durante la verifica dei servizi." }, { status: 500 }),
    };
  }

  if ((data?.length ?? 0) !== uniqueServiceIds.length) {
    auditLog({
      event: "piano_trip_tenant_guard_failed",
      level: "warn",
      tenantId,
      userId: context.userId ?? null,
      details: {
        action: context.action,
        serviceCount: uniqueServiceIds.length,
        reason: "service_ownership_mismatch",
      },
    });
    return {
      ok: false,
      response: NextResponse.json({ ok: false, error: "Uno o più servizi non trovati." }, { status: 404 }),
    };
  }

  return { ok: true, uniqueServiceIds };
}

// ── SEC-05 residuo: verifica che driver_user_id/driver_profile_id ricevuti
// dal client appartengano al tenant autenticato prima di scrivere
// trip_groups/assignments. La route usa il client service-role (bypassa
// RLS): il controllo va fatto qui, stesso pattern già usato in
// assign-service/departure-bus-assign. Salta il controllo solo se nessuno
// dei due campi è presente. Stessa risposta 404 generica per driver
// inesistente, di altro tenant, o coppia user_id/profile_id incoerente —
// non deve rivelare quale caso si sia verificato. Errore di query è
// fail-closed (500). Non verifica lo stato sospeso/attivo del driver
// (FUNC-03, fuori scope).
function tripDriverNotFoundResponse(): NextResponse {
  return NextResponse.json({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." }, { status: 404 });
}

async function verifyTripDriverBelongsToTenant(
  admin: SupabaseClient,
  tenantId: string,
  input: { driverUserId?: string | null; driverProfileId?: string | null },
  context: { actorUserId?: string; action: "create_trip" | "update_trip" | "swap_driver" | "move_services" }
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const driverUserId = input.driverUserId ?? null;
  const driverProfileId = input.driverProfileId ?? null;

  if (!driverUserId && !driverProfileId) {
    return { ok: true };
  }

  const verificationFailedResponse = (dbCode: string | null) => {
    auditLog({
      event: "piano_trip_driver_verification_failed",
      level: "error",
      tenantId,
      userId: context.actorUserId ?? null,
      details: {
        action: context.action,
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
    if (!data?.user_id) return { ok: false, response: tripDriverNotFoundResponse() };
  }

  if (driverProfileId) {
    const { data, error } = await admin
      .from("driver_profiles")
      .select("id, user_id")
      .eq("tenant_id", tenantId)
      .eq("id", driverProfileId)
      .maybeSingle();

    if (error) return verificationFailedResponse((error as { code?: string }).code ?? null);
    if (!data?.id) return { ok: false, response: tripDriverNotFoundResponse() };
    profileUserId = (data.user_id as string | null) ?? null;
  }

  // Coppia incoerente: il profilo indicato è già collegato a un altro utente.
  if (driverUserId && driverProfileId && profileUserId && profileUserId !== driverUserId) {
    return { ok: false, response: tripDriverNotFoundResponse() };
  }

  return { ok: true };
}

// ── FUNC-02 residuo: nessun controllo server-side impediva la creazione di un
// giro (create_trip) contenente servizi non più operativi. Stessa denylist
// già validata e usata in assign-service/route.ts (isServiceAssignableForManualAssignment),
// costruita sull'enum reale public.service_status (lib/types.ts:33) più il
// flag is_draft — non ridefinita da zero, solo riapplicata qui perché
// quell'helper non è condiviso/esportato (per design, vedi commento originale
// in assign-service). "new"/"assigned"/"partito"/"caricato"/"scaricato"/
// "arrivato"/"problema" restano assegnabili. Blocca solo "completato",
// "cancelled", "needs_review", "pending_cancellation", is_draft=true.
const NON_ASSIGNABLE_TRIP_SERVICE_STATUSES = new Set<string>([
  "completato",
  "cancelled",
  "needs_review",
  "pending_cancellation",
]);

function isTripServiceAssignable(service: { status?: string | null; is_draft?: boolean | null }): boolean {
  if (service.is_draft === true) return false;
  if (service.status && NON_ASSIGNABLE_TRIP_SERVICE_STATUSES.has(service.status)) return false;
  return true;
}

function tripServiceNotAssignableResponse(): NextResponse {
  return NextResponse.json(
    { ok: false, error: "SERVICE_NOT_ASSIGNABLE", message: "Uno o più servizi non possono essere assegnati nello stato attuale." },
    { status: 409 }
  );
}

// Verifica lo stato operativo dei service_ids passati (tenant-scoped tramite
// il filtro tenant_id della query) prima di creare/modificare/spostare un
// giro. Fail-closed su errore di query (500, nessuna scrittura). Riusata da
// create_trip, update_trip e move_services: l'ordine rispetto ai guard
// SEC-02/SEC-05 varia per action (vedi commenti nei rispettivi call site),
// ma deve sempre precedere qualunque INSERT/UPDATE su trip_groups/assignments.
async function verifyTripServicesOperationalStatus(
  admin: SupabaseClient,
  tenantId: string,
  serviceIds: string[],
  context: { userId?: string; action: "create_trip" | "update_trip" | "move_services" }
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  if (serviceIds.length === 0) {
    return { ok: true };
  }

  const { data, error } = await admin
    .from("services")
    .select("id, status, is_draft")
    .eq("tenant_id", tenantId)
    .in("id", serviceIds);

  if (error) {
    auditLog({
      event: "piano_trip_service_status_check_failed",
      level: "error",
      tenantId,
      userId: context.userId ?? null,
      details: {
        action: context.action,
        serviceCount: serviceIds.length,
        dbCode: (error as { code?: string }).code ?? null,
      },
    });
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "SERVICE_STATUS_CHECK_FAILED", message: "Errore durante la verifica dello stato dei servizi." },
        { status: 500 }
      ),
    };
  }

  const rows = (data ?? []) as { id: string; status: string | null; is_draft: boolean | null }[];
  const hasNonAssignable = rows.some((row) => !isTripServiceAssignable(row));

  if (hasNonAssignable) {
    auditLog({
      event: "piano_trip_service_status_guard_failed",
      level: "warn",
      tenantId,
      userId: context.userId ?? null,
      details: { action: context.action, serviceCount: serviceIds.length },
    });
    return { ok: false, response: tripServiceNotAssignableResponse() };
  }

  return { ok: true };
}

// ── FUNC-03 residuo: verifica che il driver, già confermato esistente/
// tenant-scoped da SEC-05, sia anche operativo (non sospeso/non
// disattivato) prima di creare il giro. Stesso segnale reale già usato in
// assign-service/route.ts (verifyDriverIsOperational): memberships.suspended
// (0056_memberships_tenant_suspension.sql) e driver_profiles.active
// (0080_driver_profiles.sql). Helper separato da SEC-05 per mantenere
// distinti i codici di errore: 404 DRIVER_NOT_FOUND (ownership, SEC-05) resta
// invariato, 409 DRIVER_NOT_ACTIVE è nuovo e specifico dell'operatività.
// Salta il controllo se nessun identificativo driver è presente. Errore di
// query è fail-closed (500, codice distinto). Non verifica disponibilità
// giornaliera, overlap, o geografia — fuori perimetro FUNC-03.
function tripDriverNotActiveResponse(): NextResponse {
  return NextResponse.json(
    { ok: false, error: "DRIVER_NOT_ACTIVE", message: "L'autista non è attualmente disponibile per nuove assegnazioni." },
    { status: 409 }
  );
}

async function verifyTripDriverIsOperational(
  admin: SupabaseClient,
  tenantId: string,
  input: { driverUserId?: string | null; driverProfileId?: string | null },
  context: { actorUserId?: string; action: "create_trip" | "update_trip" | "swap_driver" | "move_services" }
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const driverUserId = input.driverUserId ?? null;
  const driverProfileId = input.driverProfileId ?? null;

  if (!driverUserId && !driverProfileId) {
    return { ok: true };
  }

  const statusCheckFailedResponse = (dbCode: string | null) => {
    auditLog({
      event: "piano_trip_driver_status_check_failed",
      level: "error",
      tenantId,
      userId: context.actorUserId ?? null,
      details: {
        action: context.action,
        hasDriverUserId: Boolean(driverUserId),
        hasDriverProfileId: Boolean(driverProfileId),
        dbCode,
      },
    });
    return {
      ok: false as const,
      response: NextResponse.json(
        { ok: false, error: "DRIVER_STATUS_CHECK_FAILED", message: "Errore durante la verifica dello stato dell'autista." },
        { status: 500 }
      ),
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

    if (error) return statusCheckFailedResponse((error as { code?: string }).code ?? null);
    // Riga assente qui è inatteso (SEC-05 l'ha già confermata poco prima):
    // fail-closed, non un falso successo silenzioso.
    if (!data || data.suspended === true) return { ok: false, response: tripDriverNotActiveResponse() };
  }

  if (driverProfileId) {
    const { data, error } = await admin
      .from("driver_profiles")
      .select("active")
      .eq("tenant_id", tenantId)
      .eq("id", driverProfileId)
      .maybeSingle();

    if (error) return statusCheckFailedResponse((error as { code?: string }).code ?? null);
    if (!data || data.active === false) return { ok: false, response: tripDriverNotActiveResponse() };
  }

  return { ok: true };
}

async function _assignServicesToGroup(
  admin: SupabaseClient,
  tenantId: string,
  serviceIds: string[],
  groupId: string,
  driverUserId: string | null,
  driverProfileId: string | null,
  vehicleLabel: string | null,
  byUserId: string,
  now: string
) {
  // Upsert assignments
  const assignRows = serviceIds.map((sid) => ({
    tenant_id: tenantId,
    service_id: sid,
    driver_user_id: driverUserId,
    driver_profile_id: driverProfileId,
    vehicle_label: vehicleLabel ?? "",
    group_id: groupId,
    assignment_source: "manual_piano_giorno",
    locked_by_operator: true,
    assigned_by: byUserId,
    assigned_at: now,
    lock_reason: "manual_assignment_from_daily_plan",
  }));

  await admin
    .from("assignments")
    .upsert(assignRows, { onConflict: "service_id,tenant_id", ignoreDuplicates: false });

  // Status → assigned + status_events
  await admin.from("services").update({ status: "assigned" }).in("id", serviceIds).eq("tenant_id", tenantId);

  const statusEventRows = serviceIds.map((sid) => ({
    tenant_id: tenantId,
    service_id: sid,
    status: "assigned",
    at: now,
    by_user_id: byUserId,
  }));
  await admin.from("status_events").upsert(statusEventRows, { onConflict: "tenant_id,service_id,status", ignoreDuplicates: true });
}

async function resolveVehicleAssignment(
  admin: SupabaseClient,
  tenantId: string,
  date: string,
  vehicleId: string | null,
  vehicleLabel: string | null
): Promise<
  | { ok: true; vehicle: (VehicleManualBlock & { id: string; label: string; capacity: number | null }) | null }
  | { ok: false; error: string }
> {
  if (!vehicleId && !vehicleLabel) return { ok: true, vehicle: null };

  const { byVehicleId } = await loadVehicleCommitmentsForDate(admin, tenantId, date);

  if (vehicleId && byVehicleId.has(vehicleId)) {
    const commitment = byVehicleId.get(vehicleId)!;
    return { ok: false, error: `Mezzo impegnato per ${commitment.commitment_type}. Rimuovi prima l'impegno in Fleet Ops.` };
  }

  let vehicle: (VehicleManualBlock & { id: string; label: string; capacity: number | null }) | null = null;
  if (vehicleId) {
    const { data } = await admin
      .from("vehicles")
      .select("id, label, capacity, blocked_from, blocked_until, blocked_reason, is_blocked_manual")
      .eq("tenant_id", tenantId)
      .eq("id", vehicleId)
      .maybeSingle();
    if (data) {
      vehicle = {
        id: data.id as string,
        label: data.label as string,
        capacity: (data.capacity as number | null) ?? null,
        blocked_from: (data.blocked_from as string | null) ?? null,
        blocked_until: (data.blocked_until as string | null) ?? null,
        blocked_reason: (data.blocked_reason as string | null) ?? null,
        is_blocked_manual: (data.is_blocked_manual as boolean | null) ?? null,
      };
    }
  } else if (vehicleLabel) {
    const { data } = await admin
      .from("vehicles")
      .select("id, label, capacity, blocked_from, blocked_until, blocked_reason, is_blocked_manual")
      .eq("tenant_id", tenantId)
      .eq("label", vehicleLabel)
      .maybeSingle();
    if (data) {
      vehicle = {
        id: data.id as string,
        label: data.label as string,
        capacity: (data.capacity as number | null) ?? null,
        blocked_from: (data.blocked_from as string | null) ?? null,
        blocked_until: (data.blocked_until as string | null) ?? null,
        blocked_reason: (data.blocked_reason as string | null) ?? null,
        is_blocked_manual: (data.is_blocked_manual as boolean | null) ?? null,
      };
    }
  }

  if (vehicle && byVehicleId.has(vehicle.id)) {
    const commitment = byVehicleId.get(vehicle.id)!;
    return { ok: false, error: `Mezzo impegnato per ${commitment.commitment_type}. Rimuovi prima l'impegno in Fleet Ops.` };
  }
  if (vehicle && isVehicleManuallyBlockedOnDate(vehicle, date)) {
    return { ok: false, error: manualVehicleBlockMessage(vehicle) };
  }

  return { ok: true, vehicle };
}

async function ensureAvailabilityConfirmed(
  admin: SupabaseClient,
  tenantId: string,
  date: string
): Promise<string | null> {
  const { data, error } = await admin
    .from("daily_availability_confirmations")
    .select("confirmed")
    .eq("tenant_id", tenantId)
    .eq("date", date)
    .maybeSingle();

  if (error) {
    return `Errore verifica disponibilita: ${error.message}`;
  }

  if (!data?.confirmed) {
    return "Disponibilita del giorno non confermata. Completa prima la conferma in Disponibilita.";
  }

  return null;
}

type ServiceValidationRow = {
  id: string;
  time: string;
  pickup_hotel: string | null;
  direction: "arrival" | "departure";
  pax: number;
  hotel_id: string | null;
  meeting_point: string | null;
  arrival_time: string | null;
  orario_barca: string | null;
  porto_bruno: string | null;
  barca_compagnia: string | null;
  booking_service_kind: string | null;
  service_type_code: string | null;
  vessel: string | null;
  ferry_details: Record<string, unknown> | null;
};

type HotelValidationRow = {
  id: string;
  zone: string | null;
};

type ValidationFailure = { ok: false; error: string; status?: 409 | 422 };
type TripValidationResult = { ok: true; totalPax: number; warnings: string[] } | ValidationFailure;
type VehicleTimelineValidationResult = { ok: true; warnings: string[] } | ValidationFailure;

function serviceOperationalTime(service: ServiceValidationRow): string {
  return service.direction === "departure"
    ? (service.pickup_hotel ?? service.time).slice(0, 5)
    : effectiveServiceDisembarkTime(service) ?? service.time.slice(0, 5);
}

function isNavettaService(service: Pick<ServiceValidationRow, "booking_service_kind" | "service_type_code">): boolean {
  const kind = service.booking_service_kind ?? service.service_type_code ?? "";
  return kind === "navetta" || kind === "shuttle_hotel" || kind === "bus_city_hotel";
}

function toMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function hhmm(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function normalizeValidationText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function serviceMacroCategory(service: ServiceValidationRow): "ARRIVO" | "PARTENZA" {
  return service.direction === "arrival" ? "ARRIVO" : "PARTENZA";
}

function serviceLocationCandidates(service: ServiceValidationRow): string[] {
  return [
    service.pickup_hotel,
    service.meeting_point,
    service.porto_bruno,
  ]
    .map(normalizeValidationText)
    .filter(Boolean);
}

function hasSamePickupOrMeetingPoint(left: ServiceValidationRow, right: ServiceValidationRow): boolean {
  const leftCandidates = new Set(serviceLocationCandidates(left));
  return serviceLocationCandidates(right).some((candidate) => leftCandidates.has(candidate));
}

function isRecognizedMultiDrop(left: ServiceValidationRow, right: ServiceValidationRow): boolean {
  return serviceMacroCategory(left) === serviceMacroCategory(right)
    && Math.abs(toMinutes(serviceOperationalTime(left)) - toMinutes(serviceOperationalTime(right))) <= 10
    && hasSamePickupOrMeetingPoint(left, right);
}

function serviceDisplayLocation(service: ServiceValidationRow, hotels: Map<string, HotelValidationRow>): string {
  const hotelZone = service.hotel_id ? hotels.get(service.hotel_id)?.zone ?? null : null;
  return service.pickup_hotel
    ?? service.meeting_point
    ?? service.porto_bruno
    ?? hotelZone
    ?? "luogo non indicato";
}

function servicesAreInDifferentPlaces(
  previous: ServiceValidationRow,
  next: ServiceValidationRow,
  hotels: Map<string, HotelValidationRow>
): boolean {
  return normalizeValidationText(serviceDisplayLocation(previous, hotels))
    !== normalizeValidationText(serviceDisplayLocation(next, hotels));
}

function impossibleConflictMessage(params: {
  driverName: string;
  previous: ServiceValidationRow;
  next: ServiceValidationRow;
  previousLocation: string;
  nextLocation: string;
  availableMinutes: number;
  requiredMinutes: number;
  type: "geografico" | "temporale";
}) {
  return [
    `Conflitto ${params.type} impossibile per ${params.driverName}:`,
    `servizio alle ${serviceOperationalTime(params.previous)} (${params.previousLocation})`,
    `e alle ${serviceOperationalTime(params.next)} (${params.nextLocation}) -`,
    `${params.availableMinutes} minuti disponibili, servono almeno ${params.requiredMinutes} min.`,
  ].join(" ");
}

function tightConflictWarning(params: {
  driverName: string;
  previous: ServiceValidationRow;
  next: ServiceValidationRow;
  previousLocation: string;
  nextLocation: string;
  availableMinutes: number;
  requiredMinutes: number;
}) {
  return [
    `Warning operativo per ${params.driverName}:`,
    `servizio alle ${serviceOperationalTime(params.previous)} (${params.previousLocation})`,
    `e alle ${serviceOperationalTime(params.next)} (${params.nextLocation}) -`,
    `${params.availableMinutes} minuti disponibili, servono almeno ${params.requiredMinutes} min.`,
  ].join(" ");
}

function serviceToTimelineWindow(service: ServiceValidationRow, hotels: Map<string, HotelValidationRow>) {
  return {
    service,
    startMinutes: toMinutes(serviceOperationalTime(service)),
    geo: serviceToGeographicWindow(service, hotels),
  };
}

function evaluateDriverTimelineConflicts(
  serviceRows: ServiceValidationRow[],
  otherServicesByGroup: Map<string, ServiceValidationRow[]>,
  hotels: Map<string, HotelValidationRow>,
  driverName: string
): { block: string | null; warnings: string[] } {
  const warnings: string[] = [];
  const windows = [
    ...Array.from(otherServicesByGroup.values()).flat(),
    ...serviceRows,
  ]
    .map((service) => serviceToTimelineWindow(service, hotels))
    .sort((left, right) => left.startMinutes - right.startMinutes);

  for (let i = 1; i < windows.length; i++) {
    const previous = windows[i - 1]!;
    const next = windows[i]!;
    if (isRecognizedMultiDrop(previous.service, next.service)) continue;

    const previousLocation = serviceDisplayLocation(previous.service, hotels);
    const nextLocation = serviceDisplayLocation(next.service, hotels);
    const differentPlaces = servicesAreInDifferentPlaces(previous.service, next.service, hotels);
    const geo = validateGeographicCompatibility(previous.geo, next.geo, { warningMarginMinutes: 5 });
    const availableMinutes = geo.availableMinutes;
    const requiredMinutes = geo.requiredMinutes;

    if (differentPlaces && availableMinutes <= 5) {
      return {
        block: impossibleConflictMessage({
          driverName,
          previous: previous.service,
          next: next.service,
          previousLocation,
          nextLocation,
          availableMinutes,
          requiredMinutes,
          type: "temporale",
        }),
        warnings,
      };
    }

    if (geo.severity === "block") {
      if (geo.marginMinutes < -5) {
        return {
          block: impossibleConflictMessage({
            driverName,
            previous: previous.service,
            next: next.service,
            previousLocation,
            nextLocation,
            availableMinutes,
            requiredMinutes,
            type: "geografico",
          }),
          warnings,
        };
      }

      warnings.push(tightConflictWarning({
        driverName,
        previous: previous.service,
        next: next.service,
        previousLocation,
        nextLocation,
        availableMinutes,
        requiredMinutes,
      }));
      continue;
    }

    if (geo.severity === "warning") {
      warnings.push(tightConflictWarning({
        driverName,
        previous: previous.service,
        next: next.service,
        previousLocation,
        nextLocation,
        availableMinutes,
        requiredMinutes,
      }));
    }
  }

  return { block: null, warnings };
}

async function loadGroupServiceIds(
  admin: SupabaseClient,
  tenantId: string,
  groupId: string
): Promise<string[]> {
  const { data } = await admin
    .from("assignments")
    .select("service_id")
    .eq("tenant_id", tenantId)
    .eq("group_id", groupId);
  return (data ?? []).map((row) => row.service_id as string);
}

async function validateDriverAvailabilityPayload(
  admin: SupabaseClient,
  tenantId: string,
  params: {
    date: string;
    serviceRows: ServiceValidationRow[];
    driverUserId: string | null;
    driverProfileId: string | null;
  }
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!params.driverUserId && !params.driverProfileId) return { ok: true };
  const times = params.serviceRows.map((service) => toMinutes(serviceOperationalTime(service)));
  if (times.length === 0) return { ok: false, error: "Orario giro mancante." };
  const start = Math.min(...times);
  const end = Math.max(...times) + 30;

  let driverProfileId = params.driverProfileId;
  let driverUserId = params.driverUserId;
  if (!driverProfileId && driverUserId) {
    const { data: profile, error: profileError } = await admin
      .from("driver_profiles")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("user_id", driverUserId)
      .maybeSingle();
    if (profileError) return { ok: false, error: `Errore verifica disponibilita autista: ${profileError.message}` };
    driverProfileId = (profile?.id as string | null) ?? null;
  }
  if (!driverUserId && driverProfileId) {
    const { data: profile, error: profileError } = await admin
      .from("driver_profiles")
      .select("user_id")
      .eq("tenant_id", tenantId)
      .eq("id", driverProfileId)
      .maybeSingle();
    if (profileError) return { ok: false, error: `Errore verifica disponibilita autista: ${profileError.message}` };
    driverUserId = (profile?.user_id as string | null) ?? null;
  }

  let query = admin
    .from("driver_daily_availability")
    .select("available, available_from, available_to, notes")
    .eq("tenant_id", tenantId)
    .eq("date", params.date)
    .limit(1);
  if (driverProfileId) {
    query = query.eq("driver_profile_id", driverProfileId);
  } else if (driverUserId) {
    query = query.eq("driver_user_id", driverUserId);
  }

  const { data, error } = await query.maybeSingle();
  if (error) return { ok: false, error: `Errore verifica disponibilita autista: ${error.message}` };

  const result = canDriverCoverInterval(
    data
      ? {
          available: data.available as boolean | null,
          available_from: data.available_from as string | null,
          available_to: data.available_to as string | null,
        }
      : null,
    { start_time: hhmm(start), end_time: hhmm(end) },
    { missingAvailability: "blocker", missingBounds: "warning" }
  );
  if (!result.allowed) {
    return { ok: false, error: result.reason ?? "Autista non disponibile in questa fascia oraria." };
  }
  return { ok: true };
}

async function validateDriverVehicleEligibilityPayload(
  admin: SupabaseClient,
  tenantId: string,
  params: {
    driverUserId: string | null;
    driverProfileId: string | null;
    vehicle: { capacity: number | null; label?: string | null } | null;
  }
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!params.vehicle || (!params.driverUserId && !params.driverProfileId)) return { ok: true };

  let driverUserId = params.driverUserId;
  if (!driverUserId && params.driverProfileId) {
    const { data: profile, error: profileError } = await admin
      .from("driver_profiles")
      .select("user_id")
      .eq("tenant_id", tenantId)
      .eq("id", params.driverProfileId)
      .maybeSingle();
    if (profileError) return { ok: false, error: `Errore verifica abilitazione autista: ${profileError.message}` };
    driverUserId = (profile?.user_id as string | null) ?? null;
  }

  if (!driverUserId) return { ok: true };

  const { data: membership, error: membershipError } = await admin
    .from("memberships")
    .select("max_vehicle_capacity, full_name")
    .eq("tenant_id", tenantId)
    .eq("user_id", driverUserId)
    .maybeSingle();

  if (membershipError) {
    return { ok: false, error: `Errore verifica abilitazione autista: ${membershipError.message}` };
  }

  const result = canDriverUseVehicle(
    {
      max_vehicle_capacity: (membership?.max_vehicle_capacity as number | null) ?? null,
      driver_name: (membership?.full_name as string | null) ?? null,
    },
    params.vehicle,
    { blockUnknownVehicleCapacity: true }
  );

  if (!result.allowed) {
    return { ok: false, error: result.reason ?? "Autista non abilitato a guidare questo mezzo." };
  }

  return { ok: true };
}

async function validateTripPayload(
  admin: SupabaseClient,
  tenantId: string,
  params: {
    date: string;
    serviceIds: string[];
    driverUserId: string | null;
    driverProfileId?: string | null;
    vehicleCapacity: number | null;
    excludeGroupId?: string;
  }
): Promise<TripValidationResult> {
  if (!params.driverUserId) {
    return { ok: false, error: "Seleziona un autista prima di salvare il giro." };
  }

  const { data: services, error } = await admin
    .from("services")
    .select(SERVICE_VALIDATION_COLUMNS)
    .eq("tenant_id", tenantId)
    .in("id", params.serviceIds);

  if (error) {
    return { ok: false, error: `Errore validazione servizi: ${error.message}` };
  }

  const serviceRows = (services ?? []) as ServiceValidationRow[];
  const totalPax = serviceRows.reduce((sum, service) => sum + (service.pax ?? 0), 0);

  if (params.vehicleCapacity != null && totalPax > params.vehicleCapacity) {
    return { ok: false, error: `Overbooking bloccante: ${totalPax} pax su mezzo da ${params.vehicleCapacity}.` };
  }

  const driverAvailability = await validateDriverAvailabilityPayload(admin, tenantId, {
    date: params.date,
    serviceRows,
    driverUserId: params.driverUserId,
    driverProfileId: params.driverProfileId ?? null,
  });
  if (!driverAvailability.ok) {
    return { ok: false, error: driverAvailability.error };
  }

  const hotelIds = serviceRows.map((service) => service.hotel_id).filter((id): id is string => Boolean(id));
  const { data: hotelsData } = hotelIds.length > 0
    ? await admin.from("hotels").select("id, zone").eq("tenant_id", tenantId).in("id", hotelIds)
    : { data: [] as HotelValidationRow[] };
  const hotelMap = new Map((hotelsData ?? []).map((hotel) => [hotel.id as string, hotel as HotelValidationRow]));

  const { data: otherAssignments, error: otherAssignmentsError } = await admin
    .from("assignments")
    .select(ASSIGNMENT_SERVICE_VALIDATION_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("driver_user_id", params.driverUserId)
    .not("group_id", "is", null);

  if (otherAssignmentsError) {
    return { ok: false, error: `Errore validazione conflitti autista: ${otherAssignmentsError.message}` };
  }

  const { data: otherGroups, error: otherGroupsError } = await admin
    .from("trip_groups")
    .select("id, date, status")
    .eq("tenant_id", tenantId)
    .eq("date", params.date)
    .eq("status", "active")
    .eq("driver_user_id", params.driverUserId);

  if (otherGroupsError) {
    return { ok: false, error: `Errore validazione giri autista: ${otherGroupsError.message}` };
  }

  const activeGroupIds = new Set(
    (otherGroups ?? [])
      .map((group) => group.id as string)
      .filter((groupId) => groupId !== params.excludeGroupId)
  );

  const otherAssignmentsForGeo = (otherAssignments ?? [])
    .filter((assignment) => activeGroupIds.has(assignment.group_id as string));
  const otherServices = otherAssignmentsForGeo
    .map((assignment) => (assignment.services as unknown) as ServiceValidationRow);
  const otherHotelIds = otherServices.map((service) => service.hotel_id).filter((id): id is string => Boolean(id));
  const missingHotelIds = otherHotelIds.filter((id) => !hotelMap.has(id));
  if (missingHotelIds.length > 0) {
    const { data: otherHotelsData } = await admin
      .from("hotels")
      .select("id, zone")
      .eq("tenant_id", tenantId)
      .in("id", [...new Set(missingHotelIds)]);
    for (const hotel of otherHotelsData ?? []) {
      hotelMap.set(hotel.id as string, hotel as HotelValidationRow);
    }
  }

  const otherServicesByGroup = new Map<string, ServiceValidationRow[]>();
  for (const assignment of otherAssignmentsForGeo) {
    const groupId = assignment.group_id as string;
    otherServicesByGroup.set(groupId, [
      ...(otherServicesByGroup.get(groupId) ?? []),
      (assignment.services as unknown) as ServiceValidationRow,
    ]);
  }
  const driverName = await loadDriverName(admin, tenantId, params.driverUserId);
  const timelineValidation = evaluateDriverTimelineConflicts(serviceRows, otherServicesByGroup, hotelMap, driverName);
  if (timelineValidation.block) {
    return { ok: false, error: timelineValidation.block, status: 422 };
  }

  return { ok: true, totalPax, warnings: timelineValidation.warnings };
}

async function validateVehicleTimelinePayload(
  admin: SupabaseClient,
  tenantId: string,
  params: {
    date: string;
    serviceIds: string[];
    vehicleLabel: string | null;
    driverUserId: string | null;
    driverProfileId: string | null;
    excludeGroupId?: string;
  }
): Promise<VehicleTimelineValidationResult> {
  if (!params.vehicleLabel) return { ok: true, warnings: [] };

  const { data: services, error: servicesError } = await admin
    .from("services")
    .select(SERVICE_VALIDATION_COLUMNS)
    .eq("tenant_id", tenantId)
    .in("id", params.serviceIds);

  if (servicesError) {
    return { ok: false, error: `Errore validazione mezzo: ${servicesError.message}` };
  }

  const serviceRows = (services ?? []) as ServiceValidationRow[];
  const candidateTotalPax = serviceRows.reduce((sum, service) => sum + (service.pax ?? 0), 0);
  const candidateTimes = serviceRows.map((service) => toMinutes(serviceOperationalTime(service)));
  if (candidateTimes.length === 0) return { ok: true, warnings: [] };

  const { data: vehicle } = await admin
    .from("vehicles")
    .select("id, label, capacity")
    .eq("tenant_id", tenantId)
    .eq("label", params.vehicleLabel)
    .maybeSingle();
  const vehicleCapacity = (vehicle?.capacity as number | null) ?? null;
  const isLargeVehicle = vehicleCapacity != null && vehicleCapacity >= LARGE_GROUP_PAX_THRESHOLD;
  const isCandidateLargeGroup = candidateTotalPax >= LARGE_GROUP_PAX_THRESHOLD;

  let groupsQuery = admin
    .from("trip_groups")
    .select("id, driver_user_id, driver_profile_id")
    .eq("tenant_id", tenantId)
    .eq("date", params.date)
    .eq("status", "active")
    .eq("vehicle_label", params.vehicleLabel);

  if (params.excludeGroupId) groupsQuery = groupsQuery.neq("id", params.excludeGroupId);

  const { data: groups, error: groupsError } = await groupsQuery;
  if (groupsError) {
    return { ok: false, error: `Errore validazione mezzo: ${groupsError.message}` };
  }

  const groupIds = (groups ?? []).map((group) => group.id as string);
  if (groupIds.length === 0) return { ok: true, warnings: [] };

  const { data: assignments, error: assignmentsError } = await admin
    .from("assignments")
    .select(ASSIGNMENT_SERVICE_VALIDATION_COLUMNS)
    .eq("tenant_id", tenantId)
    .in("group_id", groupIds);

  if (assignmentsError) {
    return { ok: false, error: `Errore validazione mezzo: ${assignmentsError.message}` };
  }

  const servicesByGroup = new Map<string, ServiceValidationRow[]>();
  for (const assignment of assignments ?? []) {
    const groupId = assignment.group_id as string;
    servicesByGroup.set(groupId, [
      ...(servicesByGroup.get(groupId) ?? []),
      (assignment.services as unknown) as ServiceValidationRow,
    ]);
  }

  const allVehicleTimelineServices = [
    ...serviceRows,
    ...Array.from(servicesByGroup.values()).flat(),
  ];
  const hotelIds = allVehicleTimelineServices
    .map((service) => service.hotel_id)
    .filter((id): id is string => Boolean(id));
  const { data: hotelsData } = hotelIds.length > 0
    ? await admin.from("hotels").select("id, zone").eq("tenant_id", tenantId).in("id", [...new Set(hotelIds)])
    : { data: [] as HotelValidationRow[] };
  const hotelMap = new Map((hotelsData ?? []).map((hotel) => [hotel.id as string, hotel as HotelValidationRow]));
  const vehicleWarnings: string[] = [];
  const candidateIntervals = serviceRows.map((service) => {
    const start = toMinutes(serviceOperationalTime(service));
    return { service, start, end: start + 30 };
  });

  for (const group of groups ?? []) {
    const sameProfile = params.driverProfileId && group.driver_profile_id === params.driverProfileId;
    const sameUser = !params.driverProfileId && params.driverUserId && group.driver_user_id === params.driverUserId;
    const groupId = group.id as string;
    const groupServices = servicesByGroup.get(groupId) ?? [];
    const otherTotalPax = groupServices.reduce((sum, service) => sum + (service.pax ?? 0), 0);
    const otherLargeGroup = otherTotalPax >= LARGE_GROUP_PAX_THRESHOLD;
    const canShareLargeVehicle = isLargeVehicle && isCandidateLargeGroup && otherLargeGroup;
    const otherIntervals = groupServices.map((service) => {
      const start = toMinutes(serviceOperationalTime(service));
      return { service, start, end: start + 30 };
    });
    if (otherIntervals.length === 0) continue;

    for (const candidate of candidateIntervals) {
      for (const other of otherIntervals) {
        if (isRecognizedMultiDrop(candidate.service, other.service)) continue;

        const overlap = candidate.start < other.end && other.start < candidate.end;
        const gap = candidate.start >= other.end
          ? candidate.start - other.end
          : other.start - candidate.end;

        if (overlap) {
          return {
            ok: false,
            status: 422,
            error: [
              `Conflitto temporale impossibile per mezzo ${params.vehicleLabel}:`,
              `servizio alle ${serviceOperationalTime(other.service)} (${serviceDisplayLocation(other.service, hotelMap)})`,
              `e alle ${serviceOperationalTime(candidate.service)} (${serviceDisplayLocation(candidate.service, hotelMap)}) -`,
              "sovrapposizione reale del mezzo.",
            ].join(" "),
          };
        }

        if (gap >= 0 && gap < VEHICLE_SHARE_BUFFER_MINUTES) {
          vehicleWarnings.push([
            `Warning mezzo ${params.vehicleLabel}:`,
            `${gap} minuti tra servizio alle ${serviceOperationalTime(other.service)}`,
            `e servizio alle ${serviceOperationalTime(candidate.service)}.`,
          ].join(" "));
        }
      }
    }

    if (!sameProfile && !sameUser && !canShareLargeVehicle) {
      vehicleWarnings.push(`Warning mezzo ${params.vehicleLabel}: mezzo usato anche da un altro autista nella stessa giornata.`);
    }
  }

  return { ok: true, warnings: [...new Set(vehicleWarnings)] };
}

function serviceToGeographicWindow(
  service: ServiceValidationRow,
  hotels: Map<string, HotelValidationRow>
): GeographicCompatibilityService {
  const hotelZone = service.hotel_id ? hotels.get(service.hotel_id)?.zone ?? null : null;
  const portZone = service.meeting_point ?? null;
  const startTime = serviceOperationalTime(service);
  if (service.direction === "departure") {
    return {
      id: service.id,
      startTime,
      endZone: portZone,
      startZone: hotelZone,
    };
  }
  return {
    id: service.id,
    startTime,
    endZone: hotelZone,
    startZone: portZone,
  };
}

async function loadDriverName(admin: SupabaseClient, tenantId: string, driverUserId: string): Promise<string> {
  const { data } = await admin
    .from("memberships")
    .select("full_name")
    .eq("tenant_id", tenantId)
    .eq("user_id", driverUserId)
    .maybeSingle();
  return (data?.full_name as string | null) ?? "selezionato";
}

async function loadDriverNameForGroup(
  admin: SupabaseClient,
  tenantId: string,
  params: { driverUserId: string | null; driverProfileId: string | null }
): Promise<string> {
  if (params.driverProfileId) {
    const { data } = await admin
      .from("driver_profiles")
      .select("full_name")
      .eq("tenant_id", tenantId)
      .eq("id", params.driverProfileId)
      .maybeSingle();
    if (data?.full_name) return data.full_name as string;
  }

  if (params.driverUserId) {
    return loadDriverName(admin, tenantId, params.driverUserId);
  }

  return "autista non indicato";
}
