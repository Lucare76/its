/**
 * GET /api/gps/vehicles
 *
 * Lista tutti i veicoli disponibili nel sistema GPS Radius.
 * Protetto: solo admin / operator.
 *
 * Env richieste:
 *   RADIUS_API_BASE_URL
 *   RADIUS_API_KEY  (o RADIUS_API_TOKEN)
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { fetchRadiusVehicles } from "@/lib/server/radius-adapter";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  if (!process.env.RADIUS_REFRESH_TOKEN) {
    return NextResponse.json(
      { ok: false, error: "GPS Radius non configurato (RADIUS_REFRESH_TOKEN mancante)." },
      { status: 503 }
    );
  }

  try {
    const vehicles = await fetchRadiusVehicles();
    return NextResponse.json({ ok: true, vehicles });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Errore Radius API." },
      { status: 502 }
    );
  }
}
