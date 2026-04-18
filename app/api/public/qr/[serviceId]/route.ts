import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";

export const runtime = "nodejs";

// Route pubblica — nessuna auth richiesta.
// Il passeggero mostra il QR, il driver lo scansiona con il suo device loggato.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ serviceId: string }> }
) {
  const { serviceId } = await params;
  if (!serviceId || !/^[0-9a-f-]{36}$/i.test(serviceId)) {
    return new NextResponse("Invalid service ID", { status: 400 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://localhost:3000";
  const scanUrl = `${appUrl}/scan/${serviceId}`;

  try {
    const buffer = await QRCode.toBuffer(scanUrl, {
      width: 400,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });

    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  } catch {
    return new NextResponse("QR generation failed", { status: 500 });
  }
}
