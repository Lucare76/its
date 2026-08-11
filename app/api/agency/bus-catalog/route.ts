/**
 * GET /api/agency/bus-catalog
 * Restituisce l'elenco delle fermate bus disponibili (dal catalogo statico 2026).
 * Accessibile a agency e admin per popolare il selettore città nel form prenotazione.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";
import { BUS_LINES_2026 } from "@/lib/server/bus-lines-catalog";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["agency", "admin", "operator"],
    auditPrefix: "agency_bus_catalog"
  });
  if (auth instanceof NextResponse) return auth;

  const stops = BUS_LINES_2026.flatMap((line) =>
    line.stops.map((stop) => ({
      city: stop.city,
      time: stop.time,
      pickupNote: stop.pickupNote ?? null,
      lineCode: line.code,
      lineName: line.name
    }))
  ).sort((a, b) => a.city.localeCompare(b.city, "it"));

  return NextResponse.json({ stops });
}
