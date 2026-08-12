/**
 * Risoluzione del porto Medmar (lato terraferma e lato isola) a partire da
 * dati ITS strutturati già presenti su services: booking_service_kind e
 * meeting_point.
 *
 * Nessuna euristica nuova: il lato terraferma è determinato in modo esatto
 * (match stretto, non "includes") da booking_service_kind
 * (formula_medmar_napoli -> napoli, formula_medmar_pozzuoli -> pozzuoli).
 *
 * Il lato isola riusa la STESSA regola già in produzione in
 * lib/service-display.ts:getDepartureIschiaPort (usata per la UI passeggeri):
 * Napoli implica sempre Ischia (Napoli<->Casamicciola non è una tratta
 * verificata, vedi route-mapping.ts), mentre per Pozzuoli il porto isola
 * dipende dal meeting_point del servizio (contiene "casamicciola" ->
 * casamicciola, altrimenti ischia). A differenza dell'helper di display,
 * qui la regola è fail-closed: se meeting_point manca/è vuoto per un
 * servizio Pozzuoli, il porto isola resta "unknown" — non si assume mai
 * Ischia per assenza di dati (requisito di sicurezza Fase 1.7).
 *
 * Se non risolvibile: unknown. Mai un fallback automatico verso ischia.
 */

import type { MedmarTicketRouteCode } from "@/lib/medmar-ticket-memory";

export type MedmarPort = "ischia" | "casamicciola" | "napoli" | "pozzuoli";

export type MedmarPortResolution =
  | { status: "resolved"; port: MedmarPort }
  | {
      status: "unknown";
      reason: "missing_booking_service_kind" | "unmapped_booking_service_kind" | "missing_meeting_point";
    };

function normalize(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

export function resolveMainlandPort(bookingServiceKind: string | null): MedmarPortResolution {
  if (!bookingServiceKind) return { status: "unknown", reason: "missing_booking_service_kind" };
  if (bookingServiceKind === "formula_medmar_napoli") return { status: "resolved", port: "napoli" };
  if (bookingServiceKind === "formula_medmar_pozzuoli") return { status: "resolved", port: "pozzuoli" };
  return { status: "unknown", reason: "unmapped_booking_service_kind" };
}

export function resolveIslandPort(bookingServiceKind: string | null, meetingPoint: string | null): MedmarPortResolution {
  if (!bookingServiceKind) return { status: "unknown", reason: "missing_booking_service_kind" };
  if (bookingServiceKind === "formula_medmar_napoli") return { status: "resolved", port: "ischia" };
  if (bookingServiceKind === "formula_medmar_pozzuoli") {
    const mp = normalize(meetingPoint);
    if (!mp) return { status: "unknown", reason: "missing_meeting_point" };
    return { status: "resolved", port: mp.includes("casamicciola") ? "casamicciola" : "ischia" };
  }
  return { status: "unknown", reason: "unmapped_booking_service_kind" };
}

const ROUTE_CODE_TABLE: Record<string, MedmarTicketRouteCode> = {
  napoli_ischia: "napoli_ischia",
  ischia_napoli: "ischia_napoli",
  napoli_casamicciola: "napoli_casamicciola",
  casamicciola_napoli: "casamicciola_napoli",
  pozzuoli_ischia: "pozzuoli_ischia",
  ischia_pozzuoli: "ischia_pozzuoli",
  pozzuoli_casamicciola: "pozzuoli_casamicciola",
  casamicciola_pozzuoli: "casamicciola_pozzuoli",
};

export type LegRouteResolution =
  | { status: "resolved"; routeCode: MedmarTicketRouteCode; mainlandPort: MedmarPort; islandPort: MedmarPort }
  | {
      status: "unknown";
      reason:
        | "missing_or_invalid_direction"
        | "missing_booking_service_kind"
        | "unmapped_booking_service_kind"
        | "missing_meeting_point"
        | "unmapped_port_combo";
    };

/**
 * Risolve la tratta (route_code) per UNA gamba, in modo indipendente da
 * qualunque altra gamba dello stesso gruppo A/R: il porto isolano
 * dell'andata non viene mai assunto per il ritorno (e viceversa) — ogni
 * chiamata usa solo i dati della propria riga service.
 */
export function resolveLegRouteCode(input: {
  bookingServiceKind: string | null;
  direction: string | null;
  meetingPoint: string | null;
}): LegRouteResolution {
  const isArrival = input.direction === "arrival";
  const isDeparture = input.direction === "departure";
  if (!isArrival && !isDeparture) {
    return { status: "unknown", reason: "missing_or_invalid_direction" };
  }

  const mainland = resolveMainlandPort(input.bookingServiceKind);
  if (mainland.status === "unknown") return { status: "unknown", reason: mainland.reason };

  const island = resolveIslandPort(input.bookingServiceKind, input.meetingPoint);
  if (island.status === "unknown") return { status: "unknown", reason: island.reason };

  const key = isArrival ? `${mainland.port}_${island.port}` : `${island.port}_${mainland.port}`;
  const routeCode = ROUTE_CODE_TABLE[key];
  if (!routeCode) {
    return { status: "unknown", reason: "unmapped_port_combo" };
  }

  return { status: "resolved", routeCode, mainlandPort: mainland.port, islandPort: island.port };
}
