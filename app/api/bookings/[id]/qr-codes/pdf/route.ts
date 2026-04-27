import { NextRequest, NextResponse } from "next/server";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";
import { buildBusBookingQrPdfHtml } from "@/lib/server/bus-booking-qr";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "operator", "supervisor", "assistenza"],
    auditPrefix: "bus_qr_pdf",
  });
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;
    const html = await buildBusBookingQrPdfHtml(auth.admin, auth.membership.tenant_id, id);
    return new NextResponse(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "PDF QR bus non disponibile.",
    }, { status: 400 });
  }
}
