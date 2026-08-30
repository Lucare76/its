import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";
import { z } from "zod";
import {
  ferryPortLabel,
  findArrivalScheduleForService,
  findDepartureScheduleForService,
  type FerryScheduleRow
} from "@/lib/ferry-schedule-options";
import {
  compactServiceData,
  getOperatorName,
  logServiceChange,
  readServiceSnapshot,
  type ServiceSnapshot,
} from "@/lib/server/service-audit-log";

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

function ferryCompanyLabel(company: string | null | undefined) {
  if (!company) return null;
  return company.toUpperCase();
}

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
    const returnFerryDepartureTime = departureLeg?.orario_barca ?? serviceRes.data.orario_barca ?? departureLeg?.departure_time ?? serviceRes.data.departure_time;
    const returnSchedule = findDepartureScheduleForService(
      (schedulesRes.data ?? []) as FerryScheduleRow[],
      departureLeg?.departure_date ?? serviceRes.data.departure_date ?? serviceRes.data.date,
      returnFerryDepartureTime,
      departureLeg?.booking_service_kind ?? serviceRes.data.booking_service_kind
    );

    return NextResponse.json({
      ok: true,
      service: { ...correctedService, phone_e164: null, reminder_status: null, sent_at: null },
      linked_service: correctedLinked ?? null,
      ferry_meta: {
        outbound: arrivalSchedule ? {
          company: ferryCompanyLabel(arrivalSchedule.company),
          departure_port: ferryPortLabel(arrivalSchedule.departurePort),
          arrival_port: ferryPortLabel(arrivalSchedule.arrivalPort),
        } : null,
        return: returnSchedule ? {
          company: ferryCompanyLabel(returnSchedule.company),
          departure_port: ferryPortLabel(returnSchedule.departurePort),
          arrival_port: ferryPortLabel(returnSchedule.arrivalPort),
        } : null,
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
        const linkedUpdate = compactServiceData({
          ...(ordinaryUpdates.arrival_date !== undefined ? { arrival_date: ordinaryUpdates.arrival_date } : {}),
          ...(ordinaryUpdates.departure_date !== undefined ? { departure_date: ordinaryUpdates.departure_date } : {}),
          ...(ordinaryUpdates.arrival_date !== undefined && linkedSnapshot.direction === "arrival"
            ? { date: ordinaryUpdates.arrival_date } : {}),
          ...(ordinaryUpdates.departure_date !== undefined && linkedSnapshot.direction === "departure"
            ? { date: ordinaryUpdates.departure_date } : {}),
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
        const departureUpdate = compactServiceData({
          ...(return_pickup_time !== undefined ? { pickup_time: return_pickup_time, departure_time: return_pickup_time } : {}),
          ...(return_ferry_departure_time !== undefined ? { orario_barca: return_ferry_departure_time } : {}),
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
