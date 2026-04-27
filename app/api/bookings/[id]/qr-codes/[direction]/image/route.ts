import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/server/supabase-admin";
import { getBusQrImageResponse, parseBusQrDirection } from "@/lib/server/bus-booking-qr";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; direction: string }> }
) {
  try {
    const { id, direction } = await params;
    const parsedDirection = parseBusQrDirection(direction);
    if (!parsedDirection) {
      return new NextResponse("Direzione non valida", { status: 400 });
    }

    const admin = createAdminClient();
    return await getBusQrImageResponse(admin, id, parsedDirection);
  } catch (error) {
    return new NextResponse(error instanceof Error ? error.message : "QR image error", { status: 500 });
  }
}
