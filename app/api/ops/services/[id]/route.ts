import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

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
