import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/server/supabase-admin";
import { parseBusQrDirection, validateBusBookingQr } from "@/lib/server/bus-booking-qr";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ bookingId: string; direction: string; token: string }> }
) {
  try {
    const { bookingId, direction, token } = await params;
    const parsedDirection = parseBusQrDirection(direction);
    if (!parsedDirection) {
      return NextResponse.json({ ok: false, state: "invalid", message: "Direzione non valida." }, { status: 400 });
    }

    const admin = createAdminClient();
    const validation = await validateBusBookingQr(admin, bookingId, parsedDirection, token);
    return NextResponse.json({ ok: validation.state === "valid", ...validation });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      state: "invalid",
      message: error instanceof Error ? error.message : "Errore validazione QR bus.",
    }, { status: 500 });
  }
}
