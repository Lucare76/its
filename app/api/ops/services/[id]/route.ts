import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";
import { z } from "zod";
import { findArrivalScheduleForService, type FerryScheduleRow } from "@/lib/ferry-schedule-options";

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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const { id: serviceId } = await params;
    const tenantId = auth.membership.tenant_id;

    const [serviceRes, hotelsRes, agenciesRes, schedulesRes] = await Promise.all([
      auth.admin
        .from("services")
        .select("id, customer_name, phone, pax, date, time, notes, hotel_id, agency_id, billing_party_name, place_type, meeting_point, arrival_date, arrival_time, departure_date, departure_time, orario_barca, pickup_time, linked_service_id, transport_code, direction, booking_service_kind, service_type_code, internal_notes, internal_notes_updated_at, internal_notes_updated_by")
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
    ]);

    if (serviceRes.error) return NextResponse.json({ error: serviceRes.error.message }, { status: 500 });
    if (!serviceRes.data) return NextResponse.json({ error: "Servizio non trovato." }, { status: 404 });
    if (hotelsRes.error) return NextResponse.json({ error: hotelsRes.error.message }, { status: 500 });
    if (agenciesRes.error) return NextResponse.json({ error: agenciesRes.error.message }, { status: 500 });
    if (schedulesRes.error) return NextResponse.json({ error: schedulesRes.error.message }, { status: 500 });

    const linkedServiceRes = serviceRes.data.linked_service_id
      ? await auth.admin.from("services")
        .select("id, direction, date, time, arrival_date, arrival_time, departure_time, orario_barca, pickup_time, booking_service_kind")
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
    const correctedService = arrivalLeg?.id === serviceRes.data.id && arrivalSchedule
      ? { ...serviceRes.data, arrival_time: arrivalSchedule.arrivalTime }
      : serviceRes.data;
    const correctedLinked = arrivalLeg?.id === linkedServiceRes.data?.id && arrivalSchedule
      ? { ...linkedServiceRes.data, arrival_time: arrivalSchedule.arrivalTime }
      : linkedServiceRes.data;

    return NextResponse.json({
      ok: true,
      service: { ...correctedService, phone_e164: null, reminder_status: null, sent_at: null },
      linked_service: correctedLinked ?? null,
      hotels: hotelsRes.data ?? [],
      agencies: agenciesRes.data ?? [],
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
      .select("id, direction, linked_service_id")
      .eq("id", serviceId).eq("tenant_id", tenantId).maybeSingle();
    if (!current) return NextResponse.json({ error: "Servizio non trovato." }, { status: 404 });

    const { error } = await auth.admin
      .from("services")
      .update(ordinaryUpdates)
      .eq("id", serviceId)
      .eq("tenant_id", tenantId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    if (outbound_ferry_departure_time !== undefined || outbound_ferry_arrival_time !== undefined
      || return_pickup_time !== undefined || return_ferry_departure_time !== undefined) {
      const linked = current.linked_service_id
        ? await auth.admin.from("services").select("id, direction").eq("id", current.linked_service_id).eq("tenant_id", tenantId).maybeSingle()
        : { data: null };
      const arrivalId = current.direction === "arrival" ? current.id : linked.data?.direction === "arrival" ? linked.data.id : null;
      const departureId = current.direction === "departure" ? current.id : linked.data?.direction === "departure" ? linked.data.id : null;
      if (arrivalId && (outbound_ferry_departure_time !== undefined || outbound_ferry_arrival_time !== undefined)) {
        const { error: arrivalError } = await auth.admin.from("services").update({
          ...(outbound_ferry_departure_time !== undefined ? { time: outbound_ferry_departure_time } : {}),
          ...(outbound_ferry_arrival_time !== undefined ? { arrival_time: outbound_ferry_arrival_time } : {}),
        }).eq("id", arrivalId).eq("tenant_id", tenantId);
        if (arrivalError) return NextResponse.json({ error: arrivalError.message }, { status: 500 });
      }
      if (departureId && (return_pickup_time !== undefined || return_ferry_departure_time !== undefined)) {
        const { error: departureError } = await auth.admin.from("services").update({
          ...(return_pickup_time !== undefined ? { pickup_time: return_pickup_time, departure_time: return_pickup_time } : {}),
          ...(return_ferry_departure_time !== undefined ? { orario_barca: return_ferry_departure_time } : {}),
        }).eq("id", departureId).eq("tenant_id", tenantId);
        if (departureError) return NextResponse.json({ error: departureError.message }, { status: 500 });
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

    // Recupera nome operatore
    const { data: membership } = await auth.admin
      .from("memberships")
      .select("full_name")
      .eq("user_id", auth.user.id)
      .eq("tenant_id", tenantId)
      .maybeSingle();

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
      deleted_by_name: membership?.full_name ?? null,
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
      details: { customer_name: svc.customer_name, date: svc.date },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: "Errore interno." }, { status: 500 });
  }
}
