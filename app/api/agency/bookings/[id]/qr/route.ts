/**
 * GET /api/agency/bookings/[id]/qr
 *
 * Restituisce i QR code (outbound + return) per una prenotazione bus.
 * Se non esistono ancora, li genera al volo.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { generateBookingQrCodes } from "@/lib/server/booking-qr";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "agency"]);
    if (auth instanceof NextResponse) return auth;

    const { id } = await params;
    const tenantId = auth.membership.tenant_id;

    const { data: svc, error: svcErr } = await auth.admin
      .from("services")
      .select("id, arrival_date, departure_date, booking_service_kind")
      .eq("id", id)
      .eq("tenant_id", tenantId)
      .maybeSingle();

    if (svcErr) throw new Error(svcErr.message);
    if (!svc) {
      return NextResponse.json({ ok: false, error: "Prenotazione non trovata." }, { status: 404 });
    }

    const { data: existing } = await auth.admin
      .from("booking_qr_codes")
      .select("direction, qr_token, status, service_date")
      .eq("booking_id", id)
      .eq("tenant_id", tenantId)
      .order("direction");

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";

    if (existing?.length) {
      return NextResponse.json({
        ok: true,
        qr_codes: existing.map((r) => ({
          direction: r.direction,
          token: r.qr_token,
          status: r.status,
          service_date: r.service_date,
          scan_url: `${appUrl}/scan/${r.qr_token}`,
          qr_image_url: `${appUrl}/api/public/qr/booking/${id}?direction=${r.direction}`,
        })),
      });
    }

    // Genera se mancanti
    const codes = await generateBookingQrCodes(
      auth.admin,
      tenantId,
      id,
      svc.arrival_date,
      svc.departure_date ?? null
    );

    const result = [
      { direction: "outbound", token: codes.outbound, status: "active", scan_url: `${appUrl}/scan/${codes.outbound}`, qr_image_url: `${appUrl}/api/public/qr/booking/${id}?direction=outbound` },
      ...(codes.return
        ? [{ direction: "return", token: codes.return, status: "active", scan_url: `${appUrl}/scan/${codes.return}`, qr_image_url: `${appUrl}/api/public/qr/booking/${id}?direction=return` }]
        : []),
    ];

    return NextResponse.json({ ok: true, qr_codes: result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore." }, { status: 500 });
  }
}
