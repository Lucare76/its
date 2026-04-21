/**
 * GET  /api/scan/[serviceId]  — dettagli servizio per smarcamento porto
 * POST /api/scan/[serviceId]  — azione: "complete" | "log_view"
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ serviceId: string }> }
) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "driver", "supervisor", "assistenza"]);
    if (auth instanceof NextResponse) return auth;

    const { serviceId } = await params;
    const tenantId = auth.membership.tenant_id;

    const [serviceResult, assignmentResult] = await Promise.all([
      auth.admin
        .from("services")
        .select("id, date, time, direction, customer_name, phone, pax, vessel, notes, status, hotel_id, meeting_point, outbound_time, service_type, booking_service_kind")
        .eq("id", serviceId)
        .eq("tenant_id", tenantId)
        .maybeSingle(),
      auth.admin
        .from("assignments")
        .select("id, driver_user_id, vehicle_label")
        .eq("service_id", serviceId)
        .eq("tenant_id", tenantId)
        .maybeSingle(),
    ]);

    if (serviceResult.error) throw new Error(serviceResult.error.message);
    if (!serviceResult.data) {
      return NextResponse.json({ ok: false, error: "Servizio non trovato." }, { status: 404 });
    }

    const service = serviceResult.data;
    const assignment = assignmentResult.data ?? null;

    // Hotel name
    let hotelName: string | null = null;
    if (service.hotel_id) {
      const { data: hotel } = await auth.admin
        .from("hotels")
        .select("name")
        .eq("id", service.hotel_id)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      hotelName = hotel?.name ?? null;
    }

    // Driver name from memberships
    let driverName: string | null = null;
    if (assignment?.driver_user_id) {
      const { data: membership } = await auth.admin
        .from("memberships")
        .select("full_name")
        .eq("user_id", assignment.driver_user_id)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      driverName = membership?.full_name ?? null;
    }

    // Log this view
    await auth.admin.from("service_scan_log").insert({
      tenant_id: tenantId,
      service_id: serviceId,
      scanned_by_user_id: auth.user.id,
      action: "view",
    });

    return NextResponse.json({
      ok: true,
      service: {
        ...service,
        hotel_name: hotelName,
      },
      assignment: assignment
        ? { vehicle_label: assignment.vehicle_label, driver_name: driverName }
        : null,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore." }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ serviceId: string }> }
) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "driver", "supervisor", "assistenza"]);
    if (auth instanceof NextResponse) return auth;

    const { serviceId } = await params;
    const tenantId = auth.membership.tenant_id;
    const body = await request.json().catch(() => null) as { action?: string; phone?: string } | null;

    if (body?.action === "update_phone") {
      const phone = (body.phone ?? "").trim() || null;
      const { error: upErr } = await auth.admin
        .from("services")
        .update({ phone })
        .eq("id", serviceId)
        .eq("tenant_id", tenantId);
      if (upErr) throw new Error(upErr.message);
      return NextResponse.json({ ok: true, phone });
    }

    if (body?.action !== "complete") {
      return NextResponse.json({ ok: false, error: "Azione non valida." }, { status: 400 });
    }

    // Fetch current service status
    const { data: service, error: fetchErr } = await auth.admin
      .from("services")
      .select("id, status")
      .eq("id", serviceId)
      .eq("tenant_id", tenantId)
      .maybeSingle();

    if (fetchErr) throw new Error(fetchErr.message);
    if (!service) return NextResponse.json({ ok: false, error: "Servizio non trovato." }, { status: 404 });

    const alreadyDone = service.status === "completato";

    // Log the scan attempt
    await auth.admin.from("service_scan_log").insert({
      tenant_id: tenantId,
      service_id: serviceId,
      scanned_by_user_id: auth.user.id,
      action: alreadyDone ? "double_complete_attempt" : "complete",
    });

    if (alreadyDone) {
      return NextResponse.json({ ok: true, already_completed: true });
    }

    // Mark service as completato
    const now = new Date().toISOString();
    await Promise.all([
      auth.admin
        .from("services")
        .update({ status: "completato" })
        .eq("id", serviceId)
        .eq("tenant_id", tenantId),
      auth.admin.from("status_events").insert({
        tenant_id: tenantId,
        service_id: serviceId,
        status: "completato",
        at: now,
        by_user_id: auth.user.id,
      }),
    ]);

    return NextResponse.json({ ok: true, already_completed: false, completed_at: now });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore." }, { status: 500 });
  }
}
