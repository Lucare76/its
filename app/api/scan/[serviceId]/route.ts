/**
 * GET  /api/scan/[serviceId]  — dettagli servizio per smarcamento porto
 * POST /api/scan/[serviceId]  — azione: "complete" | "update_phone"
 *
 * serviceId può essere:
 *   - UUID (xxxxxxxx-xxxx-…) → lookup diretto in services
 *   - Token QR (36 hex senza trattini) → risolto via booking_qr_codes → services
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { resolveQrToken, markQrUsed } from "@/lib/server/booking-qr";
import { updateServiceStatusCore } from "@/lib/server/update-service-status-core";

export const runtime = "nodejs";

const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{36}$/i;

async function resolveServiceId(
  admin: Parameters<typeof resolveQrToken>[0],
  tenantId: string,
  rawId: string
): Promise<{ serviceId: string; qrDirection: "outbound" | "return" | null; qrToken: string | null }> {
  if (TOKEN_RE.test(rawId) && !UUID_RE.test(rawId)) {
    const resolved = await resolveQrToken(admin, tenantId, rawId);
    if (!resolved) return { serviceId: rawId, qrDirection: null, qrToken: null };
    return { serviceId: resolved.bookingId, qrDirection: resolved.direction, qrToken: rawId };
  }
  return { serviceId: rawId, qrDirection: null, qrToken: null };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ serviceId: string }> }
) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "driver", "supervisor", "assistenza"]);
    if (auth instanceof NextResponse) return auth;

    const { serviceId: rawId } = await params;
    const tenantId = auth.membership.tenant_id;
    const { serviceId, qrDirection, qrToken } = await resolveServiceId(auth.admin, tenantId, rawId);

    if (qrToken && !serviceId) {
      return NextResponse.json({ ok: false, error: "QR non valido o scaduto." }, { status: 404 });
    }

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
        qr_direction: qrDirection,
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

    const { serviceId: rawId } = await params;
    const tenantId = auth.membership.tenant_id;
    const { serviceId, qrToken } = await resolveServiceId(auth.admin, tenantId, rawId);

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

    const { data: service, error: fetchErr } = await auth.admin
      .from("services")
      .select("id, status")
      .eq("id", serviceId)
      .eq("tenant_id", tenantId)
      .maybeSingle();

    if (fetchErr) throw new Error(fetchErr.message);
    if (!service) return NextResponse.json({ ok: false, error: "Servizio non trovato." }, { status: 404 });

    const alreadyDone = service.status === "completato";

    const scanLogResult = await auth.admin.from("service_scan_log").insert({
      tenant_id: tenantId,
      service_id: serviceId,
      scanned_by_user_id: auth.user.id,
      action: alreadyDone ? "double_complete_attempt" : "complete",
    });
    if (scanLogResult.error) throw new Error(scanLogResult.error.message);

    if (alreadyDone) {
      return NextResponse.json({ ok: true, already_completed: true });
    }

    const now = new Date().toISOString();
    const updateResult = await updateServiceStatusCore(auth.admin, {
      tenantId,
      userId: auth.user.id,
      serviceId,
      targetStatus: "completato",
      expectedCurrentStatus: service.status,
    });
    if (updateResult.status !== 200) {
      return NextResponse.json(updateResult.body, { status: updateResult.status });
    }

    // Marca il QR come usato se la scansione è avvenuta tramite token
    if (qrToken) {
      await markQrUsed(auth.admin, tenantId, qrToken, auth.user.id);
    }

    return NextResponse.json({ ok: true, already_completed: false, completed_at: now });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore." }, { status: 500 });
  }
}
