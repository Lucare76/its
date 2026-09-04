import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";
import { z } from "zod";
import {
  findArrivalScheduleForService,
  type FerryScheduleRow
} from "@/lib/ferry-schedule-options";
import {
  compactServiceData,
  getOperatorName,
  logServiceChange,
  readServiceSnapshot,
  type ServiceSnapshot,
} from "@/lib/server/service-audit-log";
import {
  loadFerryConnectionContext,
  resolveHotelZone,
  resolveFerryLeg,
  ferryLegForResponse,
  type FerryConnectionLeg,
} from "@/lib/server/ferry-connection-lookup";
import {
  recalculateDirectFormulaPickupForEdit,
  type FormulaPickupEditState,
} from "@/lib/server/recalculate-formula-pickup";

export const runtime = "nodejs";

const updateServiceSchema = z.object({
  customer_name: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  pax: z.number().int().min(1).max(999).optional(),
  time: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  hotel_id: z.string().uuid().nullable().optional(),
  agency_id: z.string().uuid().nullable().optional(),
  billing_party_name: z.string().nullable().optional(),
  agency_quoted_price_cents: z.number().int().min(0).max(9999900).nullable().optional(),
  meeting_point: z.string().nullable().optional(),
  arrival_date: z.string().nullable().optional(),
  arrival_time: z.string().nullable().optional(),
  departure_date: z.string().nullable().optional(),
  departure_time: z.string().nullable().optional(),
  orario_barca: z.string().nullable().optional(),
  pickup_time: z.string().nullable().optional(),
  transport_code: z.string().nullable().optional(),
  outbound_ferry_departure_time: z.string().nullable().optional(),
  outbound_ferry_arrival_time: z.string().nullable().optional(),
  return_pickup_time: z.string().nullable().optional(),
  return_ferry_departure_time: z.string().nullable().optional(),
});

const hardDeleteReasons = ["Prenotazione di test", "Inserimento errato", "Altro"] as const;
const hardDeleteSchema = z.object({
  reason: z.enum(hardDeleteReasons),
  note: z.string().trim().max(500).optional().default(""),
  confirmation: z.literal("ELIMINA_DEFINITIVAMENTE"),
}).superRefine((value, ctx) => {
  if (value.reason === "Altro" && value.note.trim().length < 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["note"],
      message: "Inserisci una nota per il motivo Altro.",
    });
  }
});

/**
 * Numero pratica dell'AGENZIA (marker `[practice:XXX]` in notes, scritto da
 * ogni write-path di import) ha priorità sul `practice_number` di colonna —
 * quest'ultimo è un identificativo interno diverso (ITS-YYYY-N, generato
 * SOLO da next_booking_practice_number() per le pratiche inserite a mano,
 * vedi supabase/migrations/0243_booking_practice_numbers.sql). Stessa
 * precedenza già in uso in app/api/invoices/route.ts e
 * app/api/cron/agency-invoices/route.ts — nessuna logica nuova, solo
 * applicata anche qui in lettura.
 */
function practiceNumberFromNotes(notes: string | null | undefined): string | null {
  if (typeof notes !== "string") return null;
  const match = notes.match(/\[practice:([^\]]+)\]/);
  return match?.[1] ?? null;
}

/**
 * Read-model fallback (mai scritto su DB): quando un campo strutturato è
 * NULL, ricostruisce il valore dai campi legacy equivalenti — mai dalle
 * notes come fonte primaria di dati operativi (eccetto practice_number, dove
 * il marker [practice:XXX] è già la fonte canonica esistente altrove, vedi
 * sopra). `ferryArrivalArrivalTime` è l'orario "indicativo" calcolato da
 * findArrivalScheduleForService (stessa funzione di /api/ops/search, MAI
 * duplicata) — usato SOLO come ultimissima risorsa quando non esiste alcun
 * dato reale (arrival_time/outbound_time/time tutti NULL), mai per
 * sovrascrivere un valore reale già presente (bug corretto in questa
 * modifica: prima veniva sempre sovrascritto).
 */
function withServiceReadModelFallbacks<T extends Record<string, unknown> | null | undefined>(
  row: T,
  ferryArrivalArrivalTime?: string | null
): T {
  if (!row) return row;
  const trainArrivalNumber = (row.train_arrival_number as string | null) ?? null;
  const trainDepartureNumber = (row.train_departure_number as string | null) ?? null;
  return {
    ...row,
    arrival_time:
      (row.arrival_time as string | null) ??
      (row.outbound_time as string | null) ??
      (row.time as string | null) ??
      ferryArrivalArrivalTime ??
      null,
    departure_time: (row.departure_time as string | null) ?? (row.return_time as string | null) ?? null,
    meeting_point: (row.meeting_point as string | null) ?? (row.vessel as string | null) ?? null,
    transport_code:
      (row.transport_code as string | null) ??
      (trainArrivalNumber && trainDepartureNumber
        ? `${trainArrivalNumber} / ${trainDepartureNumber}`
        : trainArrivalNumber ?? trainDepartureNumber ?? null),
    practice_number: practiceNumberFromNotes(row.notes as string | null) ?? (row.practice_number as string | null) ?? null,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const { id: serviceId } = await params;
    const tenantId = auth.membership.tenant_id;

    const [serviceRes, hotelsRes, agenciesRes, schedulesRes, changeLogsRes] = await Promise.all([
      auth.admin
        .from("services")
        .select("id, customer_name, phone, pax, date, time, notes, hotel_id, agency_id, billing_party_name, agency_quoted_price_cents, place_type, meeting_point, arrival_date, arrival_time, departure_date, departure_time, orario_barca, pickup_time, linked_service_id, transport_code, direction, booking_service_kind, service_type_code, internal_notes, internal_notes_updated_at, internal_notes_updated_by, outbound_time, return_time, vessel, train_arrival_number, train_arrival_time, train_departure_number, train_departure_time, status, is_draft, pickup_hotel, pickup_alert, bus_city_origin, practice_number")
        .eq("id", serviceId)
        .eq("tenant_id", tenantId)
        .maybeSingle(),
      auth.admin
        .from("hotels")
        .select("id, name")
        .eq("tenant_id", tenantId)
        .order("name"),
      auth.admin
        .from("agencies")
        .select("id, name")
        .eq("tenant_id", tenantId)
        .eq("active", true)
        .order("name"),
      auth.admin
        .from("ferry_schedules")
        .select("company, departure_port, arrival_port, departure_time, arrival_time, direction, days_of_week, valid_from, valid_to"),
      auth.admin
        .from("service_change_logs")
        .select("id, service_id, root_service_id, action, changed_fields, operator_name, operator_email, created_at")
        .eq("tenant_id", tenantId)
        .or(`service_id.eq.${serviceId},root_service_id.eq.${serviceId}`)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

    if (serviceRes.error) return NextResponse.json({ error: serviceRes.error.message }, { status: 500 });
    if (!serviceRes.data) return NextResponse.json({ error: "Servizio non trovato." }, { status: 404 });
    if (hotelsRes.error) return NextResponse.json({ error: hotelsRes.error.message }, { status: 500 });
    if (agenciesRes.error) return NextResponse.json({ error: agenciesRes.error.message }, { status: 500 });
    if (schedulesRes.error) return NextResponse.json({ error: schedulesRes.error.message }, { status: 500 });

    const linkedServiceRes = serviceRes.data.linked_service_id
      ? await auth.admin.from("services")
        .select("id, direction, date, time, notes, arrival_date, arrival_time, departure_date, departure_time, orario_barca, pickup_time, booking_service_kind, outbound_time, return_time, vessel, transport_code, train_arrival_number, train_arrival_time, train_departure_number, train_departure_time, status, is_draft, pickup_hotel, pickup_alert, meeting_point, bus_city_origin, practice_number")
        .eq("id", serviceRes.data.linked_service_id)
        .eq("tenant_id", tenantId)
        .maybeSingle()
      : { data: null };

    const arrivalLeg = serviceRes.data.direction === "arrival" ? serviceRes.data
      : linkedServiceRes.data?.direction === "arrival" ? linkedServiceRes.data : null;
    const arrivalSchedule = arrivalLeg ? findArrivalScheduleForService(
      (schedulesRes.data ?? []) as FerryScheduleRow[],
      arrivalLeg.arrival_date ?? arrivalLeg.date,
      arrivalLeg.time,
      arrivalLeg.booking_service_kind
    ) : null;
    // L'orario "indicativo" da orario traghetto (arrivalSchedule) resta SOLO
    // un fallback di ultima istanza dentro withServiceReadModelFallbacks —
    // mai una sovrascrittura del dato reale già strutturato/legacy (era il
    // bug: prima veniva sempre applicato, anche quando arrival_time reale
    // era già presente — vedi caso MATTIOLI 26/010806, treno ITA 9998 delle
    // 12:53 "corretto" in 15:40 da un match ferry_schedules coincidente).
    // L'arrivo indicativo resta comunque disponibile in ferry_meta sotto, e
    // /api/ops/search continua a esporlo separatamente in
    // outbound_ferry_arrival_time — nessuna duplicazione di logica.
    const correctedService = withServiceReadModelFallbacks(
      serviceRes.data,
      arrivalLeg?.id === serviceRes.data.id ? arrivalSchedule?.arrivalTime ?? null : null
    );
    const correctedLinked = withServiceReadModelFallbacks(
      linkedServiceRes.data,
      arrivalLeg?.id === linkedServiceRes.data?.id ? arrivalSchedule?.arrivalTime ?? null : null
    );
    const departureLeg = serviceRes.data.direction === "departure" ? serviceRes.data
      : linkedServiceRes.data?.direction === "departure" ? linkedServiceRes.data : null;

    // Connessione marittima agency-aware (audit pratica 26/010806, MATTIOLI
    // ALESSANDRA): resolveOperationalConnection è l'UNICA fonte canonica —
    // mai un match generico su ferry_schedules per sola coincidenza di
    // orario (era il bug: un aliscafo ALILAURO delle 13:20 scambiato per il
    // traghetto del ritorno solo perché coincide con l'orario del treno).
    // MATTIOLI è una riga singola con sia arrival_time che departure_time:
    // le due gambe si risolvono indipendentemente dalla `direction` della
    // riga, non solo per quella corrispondente. Gli orari nave restano
    // separati da arrival_time/departure_time del trasporto terrestre —
    // questi ultimi non vengono mai toccati qui.
    const [ferryContext, hotelZone] = await Promise.all([
      loadFerryConnectionContext(auth.admin),
      resolveHotelZone(auth.admin, serviceRes.data.hotel_id),
    ]);
    // Entrambe le gambe si risolvono indipendentemente dalla `direction` della
    // riga (MATTIOLI: riga singola con arrival_time + departure_time): l'orario
    // treno/volo si legge prima dalla gamba dedicata (prenotazione A/R su 2
    // righe collegate), poi — per la riga combinata — dai campi della riga
    // stessa. Nessun lato dipende più solo da `direction`, come già fa il ritorno.
    const outboundTransportTime = arrivalLeg?.arrival_time ?? arrivalLeg?.time
      ?? serviceRes.data.arrival_time ?? serviceRes.data.outbound_time ?? serviceRes.data.time ?? null;
    const outboundDate = arrivalLeg?.arrival_date ?? arrivalLeg?.date
      ?? serviceRes.data.arrival_date ?? serviceRes.data.date ?? null;
    const outboundLeg: FerryConnectionLeg | null = outboundTransportTime ? resolveFerryLeg({
      direction: "to_ischia",
      bookingServiceKind: (arrivalLeg?.booking_service_kind ?? serviceRes.data.booking_service_kind) as string | null,
      transportTime: outboundTransportTime as string | null,
      date: outboundDate as string | null,
      hotelId: serviceRes.data.hotel_id,
      zone: hotelZone.zone,
      zoneRecognized: hotelZone.zoneRecognized,
      agencyName: serviceRes.data.billing_party_name,
      pax: serviceRes.data.pax,
      context: ferryContext,
    }) : null;
    const returnTransportTime = departureLeg?.departure_time ?? departureLeg?.time
      ?? serviceRes.data.departure_time ?? serviceRes.data.return_time ?? null;
    const returnDate = departureLeg?.departure_date ?? serviceRes.data.departure_date ?? serviceRes.data.date ?? null;
    const returnLeg: FerryConnectionLeg | null = returnTransportTime ? resolveFerryLeg({
      direction: "from_ischia",
      bookingServiceKind: departureLeg?.booking_service_kind ?? serviceRes.data.booking_service_kind,
      transportTime: returnTransportTime,
      date: returnDate,
      hotelId: serviceRes.data.hotel_id,
      zone: hotelZone.zone,
      zoneRecognized: hotelZone.zoneRecognized,
      agencyName: serviceRes.data.billing_party_name,
      pax: serviceRes.data.pax,
      context: ferryContext,
    }) : null;

    return NextResponse.json({
      ok: true,
      service: { ...correctedService, phone_e164: null, reminder_status: null, sent_at: null },
      linked_service: correctedLinked ?? null,
      ferry_meta: {
        outbound: ferryLegForResponse(outboundLeg),
        return: ferryLegForResponse(returnLeg),
      },
      hotels: hotelsRes.data ?? [],
      agencies: agenciesRes.data ?? [],
      change_logs: changeLogsRes.error ? [] : changeLogsRes.data ?? [],
    });
  } catch {
    return NextResponse.json({ error: "Errore interno." }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const { id: serviceId } = await params;
    const tenantId = auth.membership.tenant_id;
    const parsed = updateServiceSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "Payload non valido." }, { status: 400 });
    }

    const {
      outbound_ferry_departure_time,
      outbound_ferry_arrival_time,
      return_pickup_time,
      return_ferry_departure_time,
      ...ordinaryUpdates
    } = parsed.data;

    const { data: current } = await auth.admin.from("services")
      .select("*")
      .eq("id", serviceId).eq("tenant_id", tenantId).maybeSingle();
    if (!current) return NextResponse.json({ error: "Servizio non trovato." }, { status: 404 });
    const currentSnapshot = current as ServiceSnapshot;

    // Step B — ricalcolo write-time pickup Formula direct (formula_snav/
    // formula_medmar_napoli/formula_medmar_pozzuoli): confronta lo stato
    // CORRENTE della riga con lo stato FINALE (dopo merge del patch) sui soli
    // input pickup-relevant (hotel, agenzia, orario_barca, data partenza).
    // Nessuna query a ferry_pickup_rules se nessuno di questi e' cambiato —
    // vedi lib/server/recalculate-formula-pickup.ts. Applicabile solo se
    // QUESTA riga (currentSnapshot, non la eventuale gamba collegata) e' una
    // Formula direct in direction=departure.
    const currentPickupState: FormulaPickupEditState = {
      booking_service_kind: currentSnapshot.booking_service_kind as string | null,
      direction: currentSnapshot.direction as string | null,
      hotel_id: currentSnapshot.hotel_id as string | null,
      billing_party_name: currentSnapshot.billing_party_name as string | null,
      orario_barca: currentSnapshot.orario_barca as string | null,
      departure_date: currentSnapshot.departure_date as string | null,
      departure_time: currentSnapshot.departure_time as string | null,
      date: currentSnapshot.date as string | null,
    };
    const finalHotelId = ordinaryUpdates.hotel_id !== undefined ? ordinaryUpdates.hotel_id : currentPickupState.hotel_id;
    const finalBillingPartyName = ordinaryUpdates.billing_party_name !== undefined
      ? ordinaryUpdates.billing_party_name : currentPickupState.billing_party_name;
    const finalOrarioBarca = ordinaryUpdates.orario_barca !== undefined ? ordinaryUpdates.orario_barca : currentPickupState.orario_barca;
    const finalDepartureDate = ordinaryUpdates.departure_date !== undefined ? ordinaryUpdates.departure_date : currentPickupState.departure_date;
    const finalDepartureTime = ordinaryUpdates.departure_time !== undefined ? ordinaryUpdates.departure_time : currentPickupState.departure_time;
    const finalPickupState: FormulaPickupEditState = {
      ...currentPickupState,
      hotel_id: finalHotelId,
      billing_party_name: finalBillingPartyName,
      orario_barca: finalOrarioBarca,
      departure_date: finalDepartureDate,
      departure_time: finalDepartureTime,
    };
    const pickupRecalc = await recalculateDirectFormulaPickupForEdit(
      auth.admin,
      currentPickupState,
      finalPickupState
    );

    // "date" è il campo autorevole usato ovunque (raggruppamento, Biglietti
    // MEDMAR, matching preflight Medmar) per identificare la data operativa
    // di QUESTA riga — arrival_date/departure_date sono invece i campi che
    // il form di modifica espone all'operatore. Prima di questo fix, un
    // edit di arrival_date/departure_date non toccava mai "date": la riga
    // restava agganciata alla data vecchia ovunque tranne che nel form.
    const mainUpdate = compactServiceData({
      ...(ordinaryUpdates as Record<string, unknown>),
      ...(ordinaryUpdates.notes === null ? { notes: "" } : {}),
      ...(ordinaryUpdates.arrival_date !== undefined && currentSnapshot.direction === "arrival"
        ? { date: ordinaryUpdates.arrival_date } : {}),
      ...(ordinaryUpdates.departure_date !== undefined && currentSnapshot.direction === "departure"
        ? { date: ordinaryUpdates.departure_date } : {}),
      ...(pickupRecalc ? { pickup_hotel: pickupRecalc.pickup_hotel, pickup_alert: pickupRecalc.pickup_alert } : {}),
    });
    if (Object.keys(mainUpdate).length > 0) {
      const { error } = await auth.admin
        .from("services")
        .update(mainUpdate)
        .eq("id", serviceId)
        .eq("tenant_id", tenantId);

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      const afterMain = await readServiceSnapshot(auth, tenantId, serviceId);
      await logServiceChange({
        auth,
        tenantId,
        serviceId,
        rootServiceId: serviceId,
        before: currentSnapshot,
        after: afterMain,
        fields: Object.keys(mainUpdate)
      });
    }

    // Prenotazioni A/R modellate su 2 righe (linked_service_id): il form di
    // modifica presenta arrival_date/departure_date come UN'unica coppia di
    // date per l'intera prenotazione, ma li scrive solo sulla riga aperta.
    // Senza questa propagazione la riga gemella (l'altra gamba) restava
    // silenziosamente sulla data vecchia — bug reale osservato in produzione
    // (BEATRICE PAPA, riprogrammata 19->23/30 agosto: solo la riga arrival
    // veniva aggiornata, la riga departure restava al 19).
    if (current.linked_service_id
      && (ordinaryUpdates.arrival_date !== undefined || ordinaryUpdates.departure_date !== undefined)) {
      const linkedId = current.linked_service_id;
      const { data: linkedCurrent } = await auth.admin.from("services")
        .select("*").eq("id", linkedId).eq("tenant_id", tenantId).maybeSingle();
      if (linkedCurrent) {
        const linkedSnapshot = linkedCurrent as ServiceSnapshot;
        // Step B: la propagazione sotto tocca SOLO arrival_date/departure_date
        // sulla gamba collegata (nessun altro campo pickup-relevant viene mai
        // propagato qui, ne' oggi ne' con questo Step — vedi §12/§28 del task:
        // non si amplia la propagazione esistente). Se la gamba collegata e'
        // una Formula direct in direction=departure e la sua departure_date
        // finale cambia per effetto di questa propagazione, il pickup va
        // ricalcolato sulla STESSA riga — altrimenti resterebbe quello vecchio.
        const linkedCurrentPickupState: FormulaPickupEditState = {
          booking_service_kind: linkedSnapshot.booking_service_kind as string | null,
          direction: linkedSnapshot.direction as string | null,
          hotel_id: linkedSnapshot.hotel_id as string | null,
          billing_party_name: linkedSnapshot.billing_party_name as string | null,
          orario_barca: linkedSnapshot.orario_barca as string | null,
          departure_date: linkedSnapshot.departure_date as string | null,
          departure_time: linkedSnapshot.departure_time as string | null,
          date: linkedSnapshot.date as string | null,
        };
        const linkedFinalPickupState: FormulaPickupEditState = {
          ...linkedCurrentPickupState,
          departure_date: ordinaryUpdates.departure_date !== undefined
            ? ordinaryUpdates.departure_date : linkedCurrentPickupState.departure_date,
        };
        const linkedPickupRecalc = await recalculateDirectFormulaPickupForEdit(
          auth.admin,
          linkedCurrentPickupState,
          linkedFinalPickupState
        );
        const linkedUpdate = compactServiceData({
          ...(ordinaryUpdates.arrival_date !== undefined ? { arrival_date: ordinaryUpdates.arrival_date } : {}),
          ...(ordinaryUpdates.departure_date !== undefined ? { departure_date: ordinaryUpdates.departure_date } : {}),
          ...(ordinaryUpdates.arrival_date !== undefined && linkedSnapshot.direction === "arrival"
            ? { date: ordinaryUpdates.arrival_date } : {}),
          ...(ordinaryUpdates.departure_date !== undefined && linkedSnapshot.direction === "departure"
            ? { date: ordinaryUpdates.departure_date } : {}),
          ...(linkedPickupRecalc
            ? { pickup_hotel: linkedPickupRecalc.pickup_hotel, pickup_alert: linkedPickupRecalc.pickup_alert } : {}),
        });
        if (Object.keys(linkedUpdate).length > 0) {
          const { error: linkedError } = await auth.admin.from("services")
            .update(linkedUpdate).eq("id", linkedId).eq("tenant_id", tenantId);
          if (linkedError) return NextResponse.json({ error: linkedError.message }, { status: 500 });
          const linkedAfter = await readServiceSnapshot(auth, tenantId, linkedId);
          await logServiceChange({
            auth,
            tenantId,
            serviceId: linkedId,
            rootServiceId: serviceId,
            before: linkedSnapshot,
            after: linkedAfter,
            fields: Object.keys(linkedUpdate)
          });
        }
      }
    }

    if (outbound_ferry_departure_time !== undefined || outbound_ferry_arrival_time !== undefined
      || return_pickup_time !== undefined || return_ferry_departure_time !== undefined) {
      const linked = current.linked_service_id
        ? await auth.admin.from("services").select("*").eq("id", current.linked_service_id).eq("tenant_id", tenantId).maybeSingle()
        : { data: null };
      const linkedSnapshot = (linked.data ?? null) as ServiceSnapshot | null;
      const arrivalBefore = current.direction === "arrival" ? currentSnapshot : linkedSnapshot?.direction === "arrival" ? linkedSnapshot : null;
      const departureBefore = current.direction === "departure" ? currentSnapshot : linkedSnapshot?.direction === "departure" ? linkedSnapshot : currentSnapshot;
      const arrivalId = arrivalBefore?.id ?? null;
      const departureId = departureBefore?.id ?? null;
      if (arrivalId && (outbound_ferry_departure_time !== undefined || outbound_ferry_arrival_time !== undefined)) {
        const arrivalUpdate = compactServiceData({
          ...(outbound_ferry_departure_time !== undefined ? { time: outbound_ferry_departure_time } : {}),
          ...(outbound_ferry_arrival_time !== undefined ? { arrival_time: outbound_ferry_arrival_time } : {}),
        });
        const { error: arrivalError } = await auth.admin.from("services").update(arrivalUpdate).eq("id", arrivalId).eq("tenant_id", tenantId);
        if (arrivalError) return NextResponse.json({ error: arrivalError.message }, { status: 500 });
        const arrivalAfter = await readServiceSnapshot(auth, tenantId, arrivalId);
        await logServiceChange({
          auth,
          tenantId,
          serviceId: arrivalId,
          rootServiceId: serviceId,
          before: arrivalBefore,
          after: arrivalAfter,
          fields: Object.keys(arrivalUpdate)
        });
      }
      if (departureId && (return_pickup_time !== undefined || return_ferry_departure_time !== undefined)) {
        const departureUpdateBase: Record<string, unknown> = {
          ...(return_pickup_time !== undefined ? { pickup_time: return_pickup_time, departure_time: return_pickup_time } : {}),
          ...(return_ferry_departure_time !== undefined ? { orario_barca: return_ferry_departure_time } : {}),
        };
        // Step B: questo e' il write path REALE usato dalla UI Formula per
        // cambiare l'orario nave (return_ferry_departure_time -> orario_barca
        // sulla riga departureId — vedi app/(app)/services/[id]/edit/page.tsx,
        // isFerryFormula invia SEMPRE return_ferry_departure_time, mai il
        // campo orario_barca "ordinario"). Se departureId e' la STESSA riga
        // gia' aggiornata sopra (mainUpdate, quando si edita direttamente la
        // gamba departure), lo stato "finale" di hotel/agenzia/data va preso
        // dalle variabili gia' calcolate sopra (finalHotelId ecc.) e non dallo
        // snapshot pre-PATCH (departureBefore), altrimenti un edit combinato
        // (es. hotel + orario nave nella stessa richiesta) userebbe l'hotel
        // vecchio per il ricalcolo.
        const departureIsSameRowAsMain = departureId === serviceId;
        const departureCurrentPickupState: FormulaPickupEditState = {
          booking_service_kind: departureBefore.booking_service_kind as string | null,
          direction: departureBefore.direction as string | null,
          hotel_id: departureBefore.hotel_id as string | null,
          billing_party_name: departureBefore.billing_party_name as string | null,
          orario_barca: departureBefore.orario_barca as string | null,
          departure_date: departureBefore.departure_date as string | null,
          departure_time: departureBefore.departure_time as string | null,
          date: departureBefore.date as string | null,
        };
        const departureFinalPickupState: FormulaPickupEditState = {
          ...departureCurrentPickupState,
          hotel_id: departureIsSameRowAsMain ? finalHotelId : departureCurrentPickupState.hotel_id,
          billing_party_name: departureIsSameRowAsMain ? finalBillingPartyName : departureCurrentPickupState.billing_party_name,
          departure_date: departureIsSameRowAsMain ? finalDepartureDate : departureCurrentPickupState.departure_date,
          orario_barca: departureUpdateBase.orario_barca !== undefined
            ? (departureUpdateBase.orario_barca as string | null) : departureCurrentPickupState.orario_barca,
          departure_time: departureUpdateBase.departure_time !== undefined
            ? (departureUpdateBase.departure_time as string | null) : departureCurrentPickupState.departure_time,
        };
        const departurePickupRecalc = await recalculateDirectFormulaPickupForEdit(
          auth.admin,
          departureCurrentPickupState,
          departureFinalPickupState
        );
        const departureUpdate = compactServiceData({
          ...departureUpdateBase,
          ...(departurePickupRecalc
            ? { pickup_hotel: departurePickupRecalc.pickup_hotel, pickup_alert: departurePickupRecalc.pickup_alert } : {}),
        });
        const { error: departureError } = await auth.admin.from("services").update(departureUpdate).eq("id", departureId).eq("tenant_id", tenantId);
        if (departureError) return NextResponse.json({ error: departureError.message }, { status: 500 });
        const departureAfter = await readServiceSnapshot(auth, tenantId, departureId);
        await logServiceChange({
          auth,
          tenantId,
          serviceId: departureId,
          rootServiceId: serviceId,
          before: departureBefore,
          after: departureAfter,
          fields: Object.keys(departureUpdate)
        });
      }
    }

    auditLog({
      event: "service_updated",
      tenantId,
      userId: auth.user.id,
      role: auth.membership.role,
      serviceId,
      outcome: "updated",
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Errore interno." }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authorizePricingRequest(request, ["admin"]);
    if (auth instanceof NextResponse) return auth;

    const { id: serviceId } = await params;
    const tenantId = auth.membership.tenant_id;
    const parsed = hardDeleteSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Motivo eliminazione non valido." }, { status: 400 });
    }

    const { data: svc } = await auth.admin
      .from("services")
      .select("id, customer_name, date, pax, booking_service_kind, status, hotel_id")
      .eq("id", serviceId)
      .eq("tenant_id", tenantId)
      .maybeSingle();

    if (!svc) {
      return NextResponse.json({ error: "Servizio non trovato." }, { status: 404 });
    }

    // Recupera nome hotel
    let hotelName: string | null = null;
    if (svc.hotel_id) {
      const { data: hotel } = await auth.admin
        .from("hotels").select("name").eq("id", svc.hotel_id).maybeSingle();
      hotelName = hotel?.name ?? null;
    }

    const operatorName = await getOperatorName(auth);

    // Lascia traccia nel log prima di eliminare
    await auth.admin.from("service_deletion_log").insert({
      tenant_id: tenantId,
      original_service_id: serviceId,
      customer_name: svc.customer_name ?? null,
      hotel_name: hotelName,
      service_date: svc.date ?? null,
      pax: svc.pax ?? null,
      booking_service_kind: svc.booking_service_kind ?? null,
      status: svc.status ?? null,
      deleted_by_user_id: auth.user.id,
      deleted_by_name: operatorName,
      deleted_by_role: auth.membership.role,
      deletion_reason: parsed.data.reason,
      notes: parsed.data.note.trim() || null,
    });

    // Elimina definitivamente (cascade su status_events, assignments, cancellation_requests)
    const { error } = await auth.admin
      .from("services")
      .delete()
      .eq("id", serviceId)
      .eq("tenant_id", tenantId);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    auditLog({
      event: "service_deleted_permanently",
      tenantId,
      userId: auth.user.id,
      role: auth.membership.role,
      serviceId,
      outcome: "deleted",
      details: { customer_name: svc.customer_name, date: svc.date, reason: parsed.data.reason },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: "Errore interno." }, { status: 500 });
  }
}
