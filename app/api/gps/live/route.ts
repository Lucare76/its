/**
 * GET /api/gps/live
 *
 * Restituisce le posizioni live di tutti i veicoli GPS mappati ai mezzi del PMS.
 * Per ogni voce include sia i dati Radius (lat/lng/speed/...) sia i dati PMS
 * (pms_vehicle_id, pms_label) per mostrare info combinate sulla mappa.
 *
 * Protetto: solo admin / operator.
 *
 * Env richieste:
 *   RADIUS_API_BASE_URL
 *   RADIUS_API_KEY  (o RADIUS_API_TOKEN)
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { fetchRadiusAllPositions } from "@/lib/server/radius-adapter";
import type { GpsLiveEntry } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;
  const tenantId = auth.membership.tenant_id;

  if (!process.env.RADIUS_REFRESH_TOKEN) {
    return NextResponse.json(
      { ok: false, error: "GPS Radius non configurato (RADIUS_REFRESH_TOKEN mancante)." },
      { status: 503 }
    );
  }

  // Carica mezzi del PMS che hanno un radius_vehicle_id impostato
  const { data: pmsVehicles, error: pmsError } = await auth.admin
    .from("vehicles")
    .select("id, label, radius_vehicle_id")
    .eq("tenant_id", tenantId)
    .not("radius_vehicle_id", "is", null);

  if (pmsError) {
    return NextResponse.json(
      { ok: false, error: pmsError.message },
      { status: 500 }
    );
  }

  // Mappa radius_vehicle_id → record PMS
  type PmsVehicle = { id: string; label: string; radius_vehicle_id: string };
  const pmsByRadiusId = new Map<string, PmsVehicle>(
    ((pmsVehicles ?? []) as PmsVehicle[]).map((v) => [v.radius_vehicle_id, v])
  );

  // Recupera posizioni live da Radius
  let radiusPositions;
  try {
    radiusPositions = await fetchRadiusAllPositions();
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Errore Radius API." },
      { status: 502 }
    );
  }

  // Filtra solo i veicoli che hanno un mapping PMS, oppure restituisce tutti
  // se mappedOnly=true è passato come query param (default: tutti)
  const { searchParams } = new URL(request.url);
  const mappedOnly = searchParams.get("mappedOnly") === "true";

  const entries: GpsLiveEntry[] = radiusPositions
    .filter((pos) => !mappedOnly || pmsByRadiusId.has(pos.radius_vehicle_id))
    .map((pos) => {
      const pms = pmsByRadiusId.get(pos.radius_vehicle_id);
      return {
        ...pos,
        pms_vehicle_id: pms?.id ?? null,
        pms_label: pms?.label ?? null
      };
    });

  return NextResponse.json({
    ok: true,
    entries,
    fetched_at: new Date().toISOString(),
    mapped_count: entries.filter((e) => e.pms_vehicle_id !== null).length,
    total_count: entries.length
  });
}
