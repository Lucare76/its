import { NextRequest, NextResponse } from "next/server";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";
import { appUrlFromRequest, ensureBusBookingQrCodes } from "@/lib/server/bus-booking-qr";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "operator", "supervisor", "assistenza"],
    auditPrefix: "bus_qr_generate",
  });
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;
    const body = await request.json().catch(() => null) as { force?: boolean } | null;
    const summary = await ensureBusBookingQrCodes({
      admin: auth.admin,
      tenantId: auth.membership.tenant_id,
      serviceId: id,
      appUrl: appUrlFromRequest(request),
      force: body?.force === true,
    });
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "Generazione QR bus non riuscita.",
    }, { status: 400 });
  }
}
