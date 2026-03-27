/**
 * GET /api/gps/vehicle/:id
 *
 * Posizione live di un singolo veicolo Radius, con dati PMS se mappato.
 * :id = radius_vehicle_id
 *
 * Protetto: solo admin / operator.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { fetchRadiusVehiclePosition } from "@/lib/server/radius-adapter";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;
  const tenantId = auth.membership.tenant_id;

  if (!process.env.RADIUS_REFRESH_TOKEN) {
    return NextResponse.json(
      { ok: false, error: "GPS Radius non configurato (RADIUS_REFRESH_TOKEN mancante)." },
      { status: 503 }
    );
  }

  const { id: vehicleId } = await params;
  if (!vehicleId) {
    return NextResponse.json({ ok: false, error: "ID veicolo mancante." }, { status: 400 });
  }

  // Cerca il mapping PMS per questo radius_vehicle_id
  const { data: pmsVehicle } = await auth.admin
    .from("vehicles")
    .select("id, label")
    .eq("tenant_id", tenantId)
    .eq("radius_vehicle_id", vehicleId)
    .maybeSingle();

  try {
    const position = await fetchRadiusVehiclePosition(vehicleId);
    if (!position) {
      return NextResponse.json({ ok: false, error: "Veicolo non trovato su Radius." }, { status: 404 });
    }
    return NextResponse.json({
      ok: true,
      position,
      pms_vehicle_id: pmsVehicle?.id ?? null,
      pms_label: pmsVehicle?.label ?? null
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Errore Radius API." },
      { status: 502 }
    );
  }
}
