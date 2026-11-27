import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/server/supabase-admin";
import { getBusQrImageResponse, parseBusQrDirection } from "@/lib/server/bus-booking-qr";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; direction: string }> }
) {
  try {
    const { id, direction } = await params;
    const parsedDirection = parseBusQrDirection(direction);
    if (!parsedDirection) {
      return new NextResponse("Direzione non valida", { status: 400 });
    }

    const admin = createAdminClient();
    const token = new URL(request.url).searchParams.get("t")?.trim() ?? "";
    return await getBusQrImageResponse(admin, id, parsedDirection, token);
  } catch {
    return new NextResponse("QR image error", { status: 500 });
  }
}
