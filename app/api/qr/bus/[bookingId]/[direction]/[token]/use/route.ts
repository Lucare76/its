import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/server/supabase-admin";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";
import { markBusBookingQrCodeUsed, parseBusQrDirection } from "@/lib/server/bus-booking-qr";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ bookingId: string; direction: string; token: string }> }
) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "operator", "driver", "supervisor", "assistenza"],
    auditPrefix: "bus_qr_use",
  });
  if (auth instanceof NextResponse) return auth;

  try {
    const { bookingId, direction, token } = await params;
    const parsedDirection = parseBusQrDirection(direction);
    if (!parsedDirection) {
      return NextResponse.json({ ok: false, state: "invalid", message: "Direzione non valida." }, { status: 400 });
    }

    const admin = createAdminClient();
    const result = await markBusBookingQrCodeUsed(admin, bookingId, parsedDirection, token, auth.user.id);
    return NextResponse.json({ ok: result.state === "valid", ...result });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      state: "invalid",
      message: error instanceof Error ? error.message : "Errore marcatura QR bus.",
    }, { status: 500 });
  }
}
