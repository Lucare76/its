import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/server/supabase-admin";
import { parseBusQrDirection, validateBusBookingQr } from "@/lib/server/bus-booking-qr";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ bookingId: string; direction: string; token: string }> }
) {
  let bookingId: string | undefined;
  try {
    const parsedParams = await params;
    bookingId = parsedParams.bookingId;
    const { direction, token } = parsedParams;
    const parsedDirection = parseBusQrDirection(direction);
    if (!parsedDirection) {
      return NextResponse.json({ ok: false, state: "invalid", message: "Direzione non valida." }, { status: 400 });
    }

    const admin = createAdminClient();
    const validation = await validateBusBookingQr(admin, bookingId, parsedDirection, token);
    return NextResponse.json({ ok: validation.state === "valid", ...validation });
  } catch (error) {
    auditLog({
      event: "qr_bus_validate_failed",
      level: "error",
      serviceId: bookingId ?? null,
      details: { message: error instanceof Error ? error.message : String(error) },
    });
    return NextResponse.json({
      ok: false,
      state: "invalid",
      message: "Errore durante la validazione del QR.",
    }, { status: 500 });
  }
}
