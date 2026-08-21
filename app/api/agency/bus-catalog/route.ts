/**
 * GET /api/agency/bus-catalog
 * Restituisce l'elenco delle fermate bus disponibili (dal catalogo statico 2026).
 * Accessibile a agency e admin per popolare il selettore città nel form prenotazione.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";
import { BUS_LINES_2026 } from "@/lib/server/bus-lines-catalog";

export const runtime = "nodejs";

type BusCatalogStop = {
  city: string;
  time: string;
  pickupNote: string | null;
  lineCode: string;
  lineName: string;
};

type TenantBusLine = {
  id: string;
  code: string | null;
  name: string | null;
  family_code: string | null;
  family_name: string | null;
};

type TenantBusStop = {
  bus_line_id: string;
  stop_name: string | null;
  city: string | null;
  pickup_note: string | null;
  pickup_time: string | null;
};

function catalogKey(stop: BusCatalogStop) {
  return [
    stop.city.trim().toLowerCase(),
    (stop.pickupNote ?? "").trim().toLowerCase(),
  ].join("|");
}

const STANDARD_CENTRO_ROMA_STOPS = new Set(["ROMA ANAGNINA", "ROMA TIBURTINA"]);

export async function GET(request: NextRequest) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["agency", "admin", "operator"],
    auditPrefix: "agency_bus_catalog"
  });
  if (auth instanceof NextResponse) return auth;

  const staticStops = BUS_LINES_2026.flatMap((line) =>
    line.stops.map((stop) => ({
      city: stop.city,
      time: stop.time,
      pickupNote: stop.pickupNote ?? null,
      lineCode: line.code,
      lineName: line.name
    }))
  );

  const [linesResult, stopsResult] = await Promise.all([
    auth.admin
      .from("tenant_bus_lines")
      .select("id,code,name,family_code,family_name")
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("active", true),
    auth.admin
      .from("tenant_bus_line_stops")
      .select("bus_line_id,stop_name,city,pickup_note,pickup_time")
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("direction", "arrival")
      .eq("active", true),
  ]);

  if (linesResult.error || stopsResult.error) {
    return NextResponse.json({ stops: staticStops.sort((a, b) => a.city.localeCompare(b.city, "it")) });
  }

  const linesById = new Map(
    ((linesResult.data ?? []) as TenantBusLine[]).map((line) => [line.id, line])
  );

  const tenantStops: BusCatalogStop[] = ((stopsResult.data ?? []) as TenantBusStop[])
    .map((stop) => {
      const line = linesById.get(stop.bus_line_id);
      const city = (stop.stop_name || stop.city || "").trim();
      if (!city || !line) return null;
      if (STANDARD_CENTRO_ROMA_STOPS.has(city.toUpperCase())) return null;
      return {
        city,
        time: stop.pickup_time ?? "",
        pickupNote: stop.pickup_note ?? null,
        lineCode: line.code ?? line.family_code ?? "",
        lineName: line.name ?? line.family_name ?? line.code ?? "Linea bus",
      } satisfies BusCatalogStop;
    })
    .filter((stop): stop is BusCatalogStop => Boolean(stop?.city && stop.lineCode));

  const stopsByKey = new Map<string, BusCatalogStop>();
  [...staticStops, ...tenantStops].forEach((stop) => {
    const key = catalogKey(stop);
    if (!stopsByKey.has(key)) stopsByKey.set(key, stop);
  });

  const stops = Array.from(stopsByKey.values()).sort((a, b) => {
    const byCity = a.city.localeCompare(b.city, "it");
    if (byCity !== 0) return byCity;
    const byNote = (a.pickupNote ?? "").localeCompare(b.pickupNote ?? "", "it");
    if (byNote !== 0) return byNote;
    return a.time.localeCompare(b.time, "it");
  });

  return NextResponse.json({ stops });
}
