/**
 * GET /api/public/qr/booking/[bookingId]?direction=outbound|return
 *
 * Genera un PNG con il QR code per la prenotazione bus.
 * Route pubblica — nessuna auth richiesta (il token nel QR è già opaco).
 * Il QR codifica l'URL /scan/{qr_token}.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import QRCode from "qrcode";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ bookingId: string }> }
) {
  const { bookingId } = await params;
  const direction = request.nextUrl.searchParams.get("direction") ?? "outbound";

  if (!/^[0-9a-f-]{36}$/i.test(bookingId)) {
    return new NextResponse("Invalid booking ID", { status: 400 });
  }
  if (direction !== "outbound" && direction !== "return") {
    return new NextResponse("Invalid direction", { status: 400 });
  }

  const supabaseUrl  = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceRole  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!supabaseUrl || !serviceRole) {
    return new NextResponse("Server configuration error", { status: 500 });
  }

  const admin = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: qrRow } = await admin
    .from("booking_qr_codes")
    .select("qr_token")
    .eq("booking_id", bookingId)
    .eq("direction", direction)
    .maybeSingle();

  if (!qrRow?.qr_token) {
    return new NextResponse("QR not found", { status: 404 });
  }

  const appUrl  = process.env.NEXT_PUBLIC_APP_URL ?? "https://localhost:3000";
  const scanUrl = `${appUrl}/scan/${qrRow.qr_token}`;

  try {
    const buffer = await QRCode.toBuffer(scanUrl, {
      width: 400,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });

    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return new NextResponse("QR generation failed", { status: 500 });
  }
}
