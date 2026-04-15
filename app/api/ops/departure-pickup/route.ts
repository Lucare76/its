/**
 * POST /api/ops/departure-pickup
 * Calcola l'orario di prelevamento per una partenza.
 *
 * Body (JSON):
 * {
 *   mode: "transfer" | "bus_line"
 *
 *   -- per mode=transfer --
 *   agency_name:     string   (nome agenzia)
 *   transport_type:  string   (treno_traghetto | treno_aliscafo | volo_traghetto | volo_aliscafo | snav | medmar)
 *   transport_from:  string   (HH:MM — orario partenza treno/volo oppure orario barca per snav/medmar)
 *   zona:            string   (ischia | lacco | casamicciola | barano | forio)
 *
 *   -- per mode=bus_line --
 *   hotel_name:  string   (nome hotel)
 *   zona:        string   (fallback se hotel non trovato)
 *   bus_line:    string   (italia | centro | adriatica)
 * }
 *
 * Response:
 * {
 *   ok: true,
 *   pickup_time: "HH:MM",
 *   boat_co?:    string,
 *   boat_time?:  string,
 *   porto_p?:    string,
 *   porto_a?:    string,
 *   exc?:        string,
 *   notes?:      string,
 * }
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { getPickupRule } from "@/lib/departure-pickup-rules";
import { getBusLinePickup, getBusLinePickupByZone } from "@/lib/bus-line-pickup-rules";
import type { BusLine } from "@/lib/bus-line-pickup-rules";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  let body: Record<string, string>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Body JSON non valido." }, { status: 400 });
  }

  const mode = body.mode ?? "transfer";

  // -----------------------------------------------------------------------
  // Mode: bus_line
  // -----------------------------------------------------------------------
  if (mode === "bus_line") {
    const hotelName = body.hotel_name?.trim() ?? "";
    const zona      = body.zona?.trim() ?? "";
    const busLine   = (body.bus_line?.trim().toLowerCase() ?? "") as BusLine;

    if (!["italia", "centro", "adriatica"].includes(busLine)) {
      return NextResponse.json({ error: "bus_line deve essere italia | centro | adriatica." }, { status: 400 });
    }

    const result = hotelName
      ? getBusLinePickup(hotelName, busLine)
      : null;

    const final = result ?? (zona ? getBusLinePickupByZone(zona, busLine) : null);

    if (!final) {
      return NextResponse.json({ ok: false, error: "Hotel o zona non trovati nelle regole linea bus." }, { status: 404 });
    }

    return NextResponse.json({
      ok:          true,
      pickup_time: final.pickup,
      boat_co:     "MEDMAR",
      boat_time:   final.nave_time,
      porto_p:     final.porto,
      porto_a:     final.porto === "CASAMICCIOLA" ? "CASAMICCIOLA" : "ISCHIA",
    });
  }

  // -----------------------------------------------------------------------
  // Mode: transfer
  // -----------------------------------------------------------------------
  const agencyName     = body.agency_name?.trim() ?? "";
  const transportType  = body.transport_type?.trim() ?? "";
  const transportFrom  = body.transport_from?.trim() ?? "";
  const zona           = body.zona?.trim().toLowerCase() ?? "";

  if (!agencyName || !transportType || !transportFrom || !zona) {
    return NextResponse.json({ error: "Campi obbligatori: agency_name, transport_type, transport_from, zona." }, { status: 400 });
  }

  const rule = getPickupRule(agencyName, transportType, transportFrom, zona);

  if (!rule) {
    return NextResponse.json({ ok: false, error: "Nessuna regola trovata per questa combinazione." }, { status: 404 });
  }

  return NextResponse.json({
    ok:          true,
    pickup_time: rule.pickup,
    boat_co:     rule.boat_co,
    boat_time:   rule.boat_t,
    porto_p:     rule.porto_p,
    porto_a:     rule.porto_a,
    exc:         rule.exc ?? null,
    notes:       rule.notes ?? null,
  });
}
