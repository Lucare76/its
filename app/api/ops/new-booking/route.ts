/**
 * POST /api/ops/new-booking
 * Crea una nuova prenotazione da admin o operatore.
 * Simile a /api/agency/bookings ma:
 *  - Accetta ruoli admin e operator
 *  - Agency fatturazione opzionale (dropdown + inline creation gestito lato client)
 *  - Status "new" diretto, senza workflow approvazione
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { agencyBookingCreateSchema } from "@/lib/validation";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { buildServiceLabelShort } from "@/lib/service-label";
import { auditLog } from "@/lib/server/ops-audit";
import { appUrlFromRequest, ensureBusBookingQrCodes } from "@/lib/server/bus-booking-qr";
import { computeIschiaArrivalTime, findArrivalScheduleForService, type FerryScheduleRow } from "@/lib/ferry-schedule-options";
import { buildBookingAncillaryDetails } from "@/lib/booking-ancillaries";
import { applyPickupCalc } from "@/lib/server/apply-pickup-calc";
import { ensureWhatsAppContact } from "@/lib/server/whatsapp/contacts";
import { autoAllocateBusService } from "@/lib/server/bus-auto-allocation";
import { getOperatorName, logServiceChange, readServiceSnapshot } from "@/lib/server/service-audit-log";
import { resolveBookingPracticeNumber } from "@/lib/server/booking-practice-number";

export const runtime = "nodejs";

type BookingKind = z.infer<typeof agencyBookingCreateSchema>["booking_service_kind"];

function vesselFromKind(kind: BookingKind, transportCode: string, busCityOrigin?: string) {
  if (kind === "formula_snav") return "SNAV";
  if (kind === "formula_medmar_napoli") return "MEDMAR Napoli";
  if (kind === "formula_medmar_pozzuoli") return "MEDMAR Pozzuoli";
  if (kind === "transfer_airport_hotel" || kind === "transfer_airport_hotel_exclusive")
    return transportCode ? `Volo ${transportCode}` : "Transfer aeroporto";
  if (kind === "transfer_airport_hotel_aliscafo")
    return transportCode ? `Volo ${transportCode}` : "Transfer aeroporto (aliscafo)";
  if (kind === "transfer_train_hotel" || kind === "transfer_train_hotel_exclusive")
    return transportCode ? transportCode : "Transfer stazione";
  if (kind === "transfer_train_hotel_aliscafo")
    return transportCode ? transportCode : "Transfer stazione (aliscafo)";
  if (kind === "transfer_port_hotel") return "Transfer porto";
  if (kind === "bus_city_hotel") return busCityOrigin?.trim() ? `Bus da ${busCityOrigin.trim()}` : "Bus";
  if (kind === "transfer_hotel_hotel") return transportCode ? transportCode : "Transfer hotel → hotel";
  if (kind === "shuttle_hotel") return "Navetta hotel";
  if (kind === "private_island") return "Servizio Privato sull'Isola";
  return "Escursione";
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;

    const payload = await request.json().catch(() => null);
    const bodyRaw = (payload ?? {}) as Record<string, unknown>;
    const parsed = agencyBookingCreateSchema.safeParse(payload);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
    }

    const d = parsed.data;
    const bookingKind = d.booking_service_kind;
    const transportCodeOut = (d.transport_code ?? "").trim();
    const transportCodeReturn = (d.transport_code_return ?? "").trim();
    const transportCode = transportCodeOut && transportCodeReturn
      ? `${transportCodeOut} / ${transportCodeReturn}`
      : transportCodeOut || transportCodeReturn;
    const busCityOrigin = (d.bus_city_origin ?? "").trim();
    const excursionTitle = (d.excursion_title ?? "").trim();
    const customerName = `${(d.customer_first_name ?? "").trim()} ${d.customer_last_name.trim()}`.trim();
    const notes = d.notes.trim();
    // Porto e dati extra per SNAV/MEDMAR
    const meetingPoint = typeof bodyRaw.meeting_point === "string" ? bodyRaw.meeting_point.trim() || null : null;
    const ferryDepTime = typeof bodyRaw.ferry_dep_time === "string" ? bodyRaw.ferry_dep_time.trim() || null : null;
    const portoPartenza = typeof bodyRaw.porto_partenza === "string" ? bodyRaw.porto_partenza.trim() || null : null;
    // Porti escursione
    const excursionDeparturePort = typeof bodyRaw.excursion_departure_port === "string" ? bodyRaw.excursion_departure_port.trim() || null : null;
    const excursionPickupPort = typeof bodyRaw.excursion_pickup_port === "string" ? bodyRaw.excursion_pickup_port.trim() || null : null;

    // A/R e pickup_time
    const tripLeg = d.trip_leg ?? "outbound_only";
    const pickupTimeOutbound = d.pickup_time_outbound?.trim() || null;
    const pickupTimeReturn = d.pickup_time_return?.trim() || null;
    const hotelDestId = d.hotel_dest_id?.trim() || null;

    // Per private_island: mappa arrival_time→time_from, departure_time→time_to
    const isPrivateIsland = bookingKind === "private_island";

    // Destinazione hotel per transfer_hotel_hotel
    let hotelDestName: string | null = null;
    if (bookingKind === "transfer_hotel_hotel" && hotelDestId) {
      const { data: destHotel } = await auth.admin
        .from("hotels").select("name").eq("tenant_id", tenantId).eq("id", hotelDestId).maybeSingle();
      hotelDestName = destHotel?.name ?? null;
    }

    // Limite 500 servizi giornalieri (arrivi + partenze)
    const DAILY_SERVICE_LIMIT = 500;
    const serviceDateForLimit = tripLeg === "return_only" ? d.departure_date : d.arrival_date;
    const { count: dailyCount } = await auth.admin
      .from("services")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("date", serviceDateForLimit)
      .eq("is_draft", false)
      .neq("status", "cancelled");
    if ((dailyCount ?? 0) >= DAILY_SERVICE_LIMIT) {
      return NextResponse.json({
        error: `Limite giornaliero raggiunto: massimo ${DAILY_SERVICE_LIMIT} servizi per data. Contatta il supporto se necessario.`
      }, { status: 422 });
    }

    // Valida hotel (non obbligatorio per private_island)
    let hotelData: { id: string; name: string; zone?: string | null } | null = null;
    if (!isPrivateIsland) {
      const { data: hd } = await auth.admin
        .from("hotels")
        .select("id, name, zone")
        .eq("tenant_id", tenantId)
        .eq("id", d.hotel_id ?? "")
        .maybeSingle();
      if (!hd?.id) {
        return NextResponse.json({ error: "Hotel non valido per il tenant corrente." }, { status: 400 });
      }
      hotelData = hd;
    }

    // Risolve agenzia fatturazione (opzionale)
    let agencyId: string | null = null;
    let billingPartyName: string | null = null;
    if (d.agency_id) {
      const { data: agencyData } = await auth.admin
        .from("agencies")
        .select("id, name")
        .eq("tenant_id", tenantId)
        .eq("id", d.agency_id)
        .maybeSingle();
      if (agencyData?.id) {
        agencyId = agencyData.id;
        billingPartyName = agencyData.name;
      }
    }

    // Data arrivo deve precedere partenza
    // Per SNAV/MEDMAR confronta solo le date (departure_time è pickup hotel, non ora traghetto)
    const isFerryKind = bookingKind === "formula_snav" || bookingKind === "formula_medmar_napoli" || bookingKind === "formula_medmar_pozzuoli";
    if (tripLeg === "round_trip" && isFerryKind) {
      if (d.departure_date < d.arrival_date) {
        return NextResponse.json({ error: "La data di partenza non può essere precedente alla data di arrivo." }, { status: 400 });
      }
    } else if (tripLeg === "round_trip") {
      const arrivalMs = new Date(`${d.arrival_date}T${d.arrival_time}:00`).getTime();
      const departureMs = new Date(`${d.departure_date}T${d.departure_time}:00`).getTime();
      if (departureMs < arrivalMs) {
        return NextResponse.json({ error: "La data di partenza non può essere precedente all'arrivo." }, { status: 400 });
      }
    }

    // Direzione base per la tratta
    const baseDirection = tripLeg === "return_only" ? "departure" : "arrival";
    const baseVessel = vesselFromKind(bookingKind, transportCode, busCityOrigin);
    // Regole canoniche + orari nave: caricati UNA volta (singola richiesta,
    // un solo servizio creato — non un batch, quindi non e' un problema N+1),
    // passati come context ad applyPickupCalc cosi' che il dominio A
    // (treno/aeroporto) possa usare la STESSA regola canonica DB del
    // read-path (/departures) invece del solo fallback statico quando una
    // regola e' configurata — vedi lib/server/apply-pickup-calc.ts.
    const isTrainOrFlightKind = bookingKind === "transfer_train_hotel" || bookingKind === "transfer_train_hotel_exclusive" || bookingKind === "transfer_train_hotel_aliscafo"
      || bookingKind === "transfer_airport_hotel" || bookingKind === "transfer_airport_hotel_exclusive" || bookingKind === "transfer_airport_hotel_aliscafo";
    // isFerryKind (Formula SNAV/MEDMAR diretta, definito sopra) copre ESATTAMENTE
    // formula_snav/formula_medmar_napoli/formula_medmar_pozzuoli — le uniche righe
    // transport_type='direct' in ferry_pickup_rules. transfer_port_hotel resta
    // fuori (kind diverso, non incluso in isFerryKind) e continua a usare solo il
    // fallback statico in questo step — vedi apply-pickup-calc.ts dominio B.
    const needsOperationalRules = isTrainOrFlightKind || isFerryKind;
    const [scheduleRows, operationalRulesRows] = await Promise.all([
      needsOperationalRules
        ? auth.admin.from("ferry_schedules")
            .select("company, departure_port, arrival_port, departure_time, arrival_time, direction, days_of_week, valid_from, valid_to")
            .then((r) => r.data ?? [])
        : Promise.resolve([]),
      needsOperationalRules
        ? auth.admin.from("ferry_pickup_rules").select("*").then((r) => r.data ?? [])
        : Promise.resolve([]),
    ]);
    // Pickup automatico: canonico via apply-pickup-calc.ts, che ora copre sia
    // treno/aeroporto (transfer_train_hotel*/transfer_airport_hotel*) sia
    // Formula SNAV/MEDMAR diretta — stessa funzione, stesso risultato del
    // canale agenzia/Excel/email per uno scenario equivalente. Per Formula
    // l'orario-ancora e' quello della nave (ferryDepTime), non d.departure_time
    // (che per queste prenotazioni e' un campo diverso — vedi UI operatore).
    const departurePickupFields = applyPickupCalc({
      direction: "departure",
      booking_service_kind: bookingKind,
      time: isFerryKind ? (ferryDepTime ?? d.departure_time) : d.departure_time,
      billing_party_name: billingPartyName,
      vessel: baseVessel,
      hotel_zone: hotelData?.zone ?? null,
      hotel_name: hotelData?.name ?? null,
      context: needsOperationalRules
        ? {
            operationalRules: operationalRulesRows as never,
            ferrySchedules: scheduleRows as never,
            date: tripLeg === "return_only" ? d.departure_date : d.arrival_date,
            hotelId: hotelData?.id ?? null,
          }
        : undefined,
    });
    const ferryVesselTime = tripLeg === "return_only" ? ferryDepTime : d.arrival_time;
    let resolvedFerryArrivalTime = computeIschiaArrivalTime(bookingKind, d.arrival_time ?? "") ?? d.arrival_time;
    if (isFerryKind && tripLeg !== "return_only") {
      const schedule = findArrivalScheduleForService(
        scheduleRows as FerryScheduleRow[],
        d.arrival_date,
        d.arrival_time,
        bookingKind
      );
      if (schedule?.arrivalTime) resolvedFerryArrivalTime = schedule.arrivalTime;
    }

    // Numero pratica leggibile (ITS-YYYY-N), generato server-side con protezione
    // concorrenza reale — vedi lib/server/booking-practice-number.ts. Condiviso
    // da entrambe le gambe A/R tramite lo spread `...insert` sotto (returnInsert).
    // OBBLIGATORIO: e' parte dell'identita' operativa della prenotazione, non
    // un arricchimento opzionale. Se la generazione fallisce, la creazione
    // viene interrotta QUI, prima di qualunque insert su `services` — mai una
    // pratica con practice_number = null. Il numero eventualmente gia'
    // consumato da questo tentativo (contatore incrementato) resta perso
    // (buco nella sequenza, mai riutilizzato) per design: vedi
    // supabase/migrations/0243_booking_practice_numbers.sql.
    const practiceNumber = await resolveBookingPracticeNumber(auth.admin, tenantId);
    if (!practiceNumber) {
      auditLog({
        event: "ops_booking_create_failed",
        level: "error",
        tenantId,
        userId: auth.user.id,
        details: { reason: "practice_number_generation_failed" },
      });
      return NextResponse.json(
        { error: "Impossibile generare il numero pratica. Riprova tra qualche istante." },
        { status: 500 }
      );
    }

    const insert = {
      tenant_id: tenantId,
      practice_number: practiceNumber,
      agency_id: agencyId,
      billing_party_name: billingPartyName,
      is_draft: false,
      status: "new",
      date: tripLeg === "return_only" ? d.departure_date : d.arrival_date,
      time: tripLeg === "return_only" ? d.departure_time : d.arrival_time,
      service_type: bookingKind === "excursion" ? "bus_tour" : "transfer",
      direction: baseDirection,
      vessel: (() => {
        if (isFerryKind && ferryVesselTime) {
          return `${baseVessel} ${ferryVesselTime}`;
        }
        return baseVessel;
      })(),
      pax: d.pax,
      hotel_id: d.hotel_id || null,
      customer_name: customerName,
      customer_first_name: (d.customer_first_name ?? "").trim() || null,
      customer_last_name: d.customer_last_name.trim(),
      customer_email: (d.customer_email ?? "").trim() || null,
      phone: (d.customer_phone ?? "").trim(),
      notes,
      booking_service_kind: bookingKind,
      arrival_date: d.arrival_date,
      arrival_time: resolvedFerryArrivalTime,
      departure_date: d.departure_date,
      departure_time: d.departure_time,
      transport_code: transportCode || null,
      bus_city_origin: busCityOrigin || null,
      meeting_point: bookingKind === "bus_city_hotel"
        ? buildServiceLabelShort({ kind: "bus_city_hotel", busCityOrigin: busCityOrigin || null })
        : (bookingKind === "transfer_hotel_hotel" && hotelDestName)
          ? hotelDestName
          : bookingKind === "excursion"
            ? excursionDeparturePort
            : meetingPoint,
      // Per SNAV/MEDMAR: orario barca partenza e porto partenza nei campi calcolati
      ...(ferryDepTime ? { orario_barca: ferryDepTime } : {}),
      ...(portoPartenza ? { barca_compagnia: portoPartenza } : {}),
      include_ferry_tickets: d.include_ferry_tickets ?? false,
      ferry_details: {
        outbound_code: (d.ferry_outbound_code ?? "").trim() || null,
        return_code: (d.ferry_return_code ?? "").trim() || null,
        ...buildBookingAncillaryDetails(d)
      },
      excursion_details: bookingKind === "excursion" ? { title: excursionTitle } : {},
      agency_quoted_price_cents: d.agency_quoted_price_cents ?? null,
      created_by_user_id: auth.user.id,
      pickup_time: tripLeg === "return_only" ? (pickupTimeReturn || null) : (pickupTimeOutbound || null),
      ...(isPrivateIsland ? { time_from: d.arrival_time, time_to: d.departure_time } : {}),
      ...(baseDirection === "departure" ? departurePickupFields : {}),
    };

    const { data: firstInsert, error: insertError } = await auth.admin
      .from("services")
      .insert(insert)
      .select("id, created_at")
      .single();

    if (insertError || !firstInsert?.id) {
      return NextResponse.json({ error: insertError?.message ?? "Inserimento non riuscito." }, { status: 500 });
    }
    const serviceId: string = firstInsert.id;
    const createdAt = firstInsert.created_at ?? new Date().toISOString();
    const operatorName = await getOperatorName(auth);

    ensureWhatsAppContact(auth.admin, {
      tenantId,
      phone: d.customer_phone,
      profileName: customerName,
    }).catch((error) => console.error("WhatsApp contact creation failed:", error));

    await auth.admin.from("status_events").insert({
      tenant_id: tenantId,
      service_id: serviceId,
      status: "new",
      by_user_id: auth.user.id
    });

    // Per A/R: crea la tratta di ritorno e collega i due record
    // Le escursioni creano sempre la tratta di ritorno (autista A/R separati)
    let returnServiceId: string | null = null;
    if ((tripLeg === "round_trip" || bookingKind === "excursion") && serviceId) {
      const returnInsert = {
        ...insert,
        date: d.departure_date,
        time: d.departure_time,
        direction: "departure",
        vessel: isFerryKind && ferryDepTime ? `${baseVessel} ${ferryDepTime}` : insert.vessel,
        pickup_time: pickupTimeReturn || null,
        linked_service_id: null,
        ...(bookingKind === "excursion" ? { meeting_point: excursionPickupPort } : {}),
        // Il porto isolano del ritorno è indipendente da quello dell'andata
        // (es. andata Pozzuoli->Ischia, ritorno Casamicciola->Pozzuoli): senza
        // questo override meeting_point erediterebbe per spread (sopra) il
        // porto di ARRIVO dell'andata, falsando resolveIslandPort (Fase 1.7).
        // portoPartenza è già raccolto per-gamba dalla UI (usato per
        // barca_compagnia sopra); se manca -> null -> fail-closed
        // (manual_review nel preflight Medmar), mai un porto ereditato.
        ...(isFerryKind ? { meeting_point: portoPartenza } : {}),
        ...departurePickupFields,
      };
      const { data: retData } = await auth.admin
        .from("services").insert(returnInsert).select("id").single();
      if (retData?.id) {
        returnServiceId = retData.id;
        await auth.admin.from("status_events").insert({
          tenant_id: tenantId, service_id: returnServiceId, status: "new", by_user_id: auth.user.id
        });
        await Promise.all([
          auth.admin.from("services").update({ linked_service_id: returnServiceId }).eq("id", serviceId).eq("tenant_id", tenantId),
          auth.admin.from("services").update({ linked_service_id: serviceId }).eq("id", returnServiceId).eq("tenant_id", tenantId),
        ]).catch(() => {});
      }
    }

    const createdLogFields = [
      "status",
      "date",
      "time",
      "direction",
      "customer_name",
      "pax",
      "booking_service_kind",
      "agency_id",
      "hotel_id",
    ];
    const firstSnapshot = await readServiceSnapshot(auth, tenantId, serviceId);
    await logServiceChange({
      auth,
      tenantId,
      serviceId,
      rootServiceId: serviceId,
      before: null,
      after: firstSnapshot,
      fields: createdLogFields,
      action: "CREATED",
      operatorName,
    });
    if (returnServiceId) {
      const returnSnapshot = await readServiceSnapshot(auth, tenantId, returnServiceId);
      await logServiceChange({
        auth,
        tenantId,
        serviceId: returnServiceId,
        rootServiceId: serviceId,
        before: null,
        after: returnSnapshot,
        fields: createdLogFields,
        action: "CREATED",
        operatorName,
      });
    }

    if (bookingKind === "bus_city_hotel") {
      await ensureBusBookingQrCodes({
        admin: auth.admin,
        tenantId,
        serviceId,
        appUrl: appUrlFromRequest(request),
      });
      await autoAllocateBusService({
        admin: auth.admin,
        tenantId,
        serviceId,
        userId: auth.user.id,
      }).catch((error) => {
        console.error("Bus auto allocation failed:", error);
        return null;
      });
      if (returnServiceId) {
        await autoAllocateBusService({
          admin: auth.admin,
          tenantId,
          serviceId: returnServiceId,
          userId: auth.user.id,
        }).catch((error) => {
          console.error("Bus return auto allocation failed:", error);
          return null;
        });
      }
    }

    auditLog({
      event: "ops_booking_created",
      tenantId,
      userId: auth.user.id,
      role: auth.membership.role,
      serviceId,
      outcome: "created",
      details: { booking_kind: bookingKind, agency_id: agencyId, hotel_id: d.hotel_id, trip_leg: tripLeg }
    });

    return NextResponse.json({
      ok: true,
      id: serviceId,
      ...(returnServiceId ? { id_return: returnServiceId, round_trip: true } : {}),
      created_at: createdAt,
      operator_name: operatorName,
      booking: {
        practice_number: practiceNumber,
        customer_name: customerName,
        pax: d.pax,
        booking_service_kind: bookingKind,
        service_label: baseVessel,
        arrival_date: d.arrival_date,
        departure_date: d.departure_date,
        trip_leg: tripLeg,
        hotel_name: hotelData?.name ?? null,
        agency_name: billingPartyName ?? "Privato",
      },
    });
  } catch (error) {
    auditLog({ event: "ops_booking_create_failed", level: "error", details: { message: error instanceof Error ? error.message : "Unknown error" } });
    return NextResponse.json({ error: "Errore interno server." }, { status: 500 });
  }
}
