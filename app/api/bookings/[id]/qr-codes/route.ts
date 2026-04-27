import { NextRequest, NextResponse } from "next/server";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";
import { listBusBookingQrCodes } from "@/lib/server/bus-booking-qr";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "operator", "supervisor", "assistenza"],
    auditPrefix: "bus_qr_list",
  });
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;
    const summary = await listBusBookingQrCodes(auth.admin, auth.membership.tenant_id, id);
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "Errore caricamento QR bus.",
    }, { status: 400 });
  }
}
