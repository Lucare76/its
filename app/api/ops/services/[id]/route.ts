import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";
import { z } from "zod";

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
  transport_code: z.string().nullable().optional(),
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

    const [serviceRes, hotelsRes, agenciesRes] = await Promise.all([
      auth.admin
        .from("services")
        .select("id, customer_name, phone, pax, time, notes, hotel_id, agency_id, billing_party_name, place_type, meeting_point, arrival_date, arrival_time, departure_date, departure_time, transport_code, direction, booking_service_kind, service_type_code, reminder_status, sent_at, internal_notes, internal_notes_updated_at, internal_notes_updated_by")
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
    ]);

    if (serviceRes.error) return NextResponse.json({ error: serviceRes.error.message }, { status: 500 });
    if (!serviceRes.data) return NextResponse.json({ error: "Servizio non trovato." }, { status: 404 });
    if (hotelsRes.error) return NextResponse.json({ error: hotelsRes.error.message }, { status: 500 });
    if (agenciesRes.error) return NextResponse.json({ error: agenciesRes.error.message }, { status: 500 });

    return NextResponse.json({
      ok: true,
      service: { ...serviceRes.data, phone_e164: null },
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

    const { error } = await auth.admin
      .from("services")
      .update(parsed.data)
      .eq("id", serviceId)
      .eq("tenant_id", tenantId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

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
