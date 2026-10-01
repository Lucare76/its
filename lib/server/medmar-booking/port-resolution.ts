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
 * Pratiche importate transfer_port_hotel (già classificate Medmar da
 * lib/medmar-service-classification.ts PRIMA di arrivare qui): il kind non
 * porta il porto, e meeting_point contiene il porto di PARTENZA terraferma
 * (citta_partenza dell'import, es. "PORTO DI NAPOLI PORTA DI MASSA"), non un
 * punto sull'isola. Quindi:
 *   - terraferma: da meeting_point, solo se identifica in modo univoco
 *     Napoli (Porta di Massa / Porto di Napoli) oppure Pozzuoli;
 *   - isola: SOLO dalla corsa canonica in ferry_schedules
 *     (resolveIslandPortFromSchedules sotto), sia per Napoli sia per
 *     Pozzuoli; nessun fallback fisso: senza esito certo resta unknown.
 *
 * Se non risolvibile: unknown. Mai un fallback automatico verso ischia.
 */

import type { MedmarTicketRouteCode } from "@/lib/medmar-ticket-memory";
import { isScheduleActiveOnDate, type FerryScheduleRow } from "@/lib/ferry-schedule-options";

export type MedmarPort = "ischia" | "casamicciola" | "napoli" | "pozzuoli";

export type ScheduleIslandPortLookup =
  | { status: "resolved"; port: "ischia" | "casamicciola" }
  | {
      status: "unknown";
      reason: "schedules_unavailable" | "missing_ferry_time" | "no_schedule_match" | "ambiguous_schedule_match" | "unmapped_schedule_port";
    };

const SCHEDULE_MAINLAND_PORT: Record<"napoli" | "pozzuoli", string> = { napoli: "napoli_beverello", pozzuoli: "pozzuoli" };
const SCHEDULE_ISLAND_PORT: Record<string, "ischia" | "casamicciola"> = { ischia_porto: "ischia", casamicciola: "casamicciola" };

/**
 * Porto isolano di una corsa Medmar letto dalla tabella canonica
 * ferry_schedules (supabase/migrations/0089_ferry_schedules.sql): corsa con
 * lo stesso porto terraferma, la stessa direzione, lo stesso orario di
 * PARTENZA esatto e attiva nella data. Risolto solo se tutte le corse che
 * combaciano indicano lo stesso porto isolano; nessuna corsa "più vicina".
 */
export function resolveIslandPortFromSchedules(
  schedules: FerryScheduleRow[] | null,
  input: { mainlandPort: "napoli" | "pozzuoli"; direction: "arrival" | "departure"; departureTime: string | null; date: string }
): ScheduleIslandPortLookup {
  if (!schedules) return { status: "unknown", reason: "schedules_unavailable" };
  if (!input.departureTime) return { status: "unknown", reason: "missing_ferry_time" };
  const toIschia = input.direction === "arrival";
  const mainland = SCHEDULE_MAINLAND_PORT[input.mainlandPort];
  const islandPorts = new Set<string>();
  for (const row of schedules) {
    if (row.company !== "medmar") continue;
    if (row.direction !== (toIschia ? "mainland_to_ischia" : "ischia_to_mainland")) continue;
    if ((toIschia ? row.departure_port : row.arrival_port) !== mainland) continue;
    if (String(row.departure_time ?? "").slice(0, 5) !== input.departureTime) continue;
    if (!isScheduleActiveOnDate(row, input.date)) continue;
    islandPorts.add(toIschia ? row.arrival_port : row.departure_port);
  }
  if (islandPorts.size === 0) return { status: "unknown", reason: "no_schedule_match" };
  if (islandPorts.size > 1) return { status: "unknown", reason: "ambiguous_schedule_match" };
  const port = SCHEDULE_ISLAND_PORT[[...islandPorts][0]!];
  return port ? { status: "resolved", port } : { status: "unknown", reason: "unmapped_schedule_port" };
}

export type MedmarPortResolution =
  | { status: "resolved"; port: MedmarPort }
  | {
      status: "unknown";
      reason:
        | "missing_booking_service_kind"
        | "unmapped_booking_service_kind"
        | "missing_meeting_point"
        | "unmapped_meeting_point"
        | "missing_island_port";
    };

function normalize(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * transfer_port_hotel: porto terraferma da meeting_point (citta_partenza
 * dell'import). Napoli e Pozzuoli devono escludersi a vicenda: un testo che
 * li cita entrambi, o nessuno dei due, resta unknown.
 */
function resolveImportedMainlandPort(meetingPoint: string | null): MedmarPortResolution {
  const mp = normalize(meetingPoint);
  if (!mp) return { status: "unknown", reason: "missing_meeting_point" };
  const napoli = mp.includes("porta di massa") || mp.includes("porto di napoli");
  const pozzuoli = mp.includes("pozzuoli");
  if (napoli && !pozzuoli) return { status: "resolved", port: "napoli" };
  if (pozzuoli && !napoli) return { status: "resolved", port: "pozzuoli" };
  return { status: "unknown", reason: "unmapped_meeting_point" };
}

export function resolveMainlandPort(bookingServiceKind: string | null, meetingPoint: string | null = null): MedmarPortResolution {
  if (!bookingServiceKind) return { status: "unknown", reason: "missing_booking_service_kind" };
  if (bookingServiceKind === "formula_medmar_napoli") return { status: "resolved", port: "napoli" };
  if (bookingServiceKind === "formula_medmar_pozzuoli") return { status: "resolved", port: "pozzuoli" };
  if (bookingServiceKind === "transfer_port_hotel") return resolveImportedMainlandPort(meetingPoint);
  return { status: "unknown", reason: "unmapped_booking_service_kind" };
}

export function resolveIslandPort(
  bookingServiceKind: string | null,
  meetingPoint: string | null,
  scheduleIslandPort: ScheduleIslandPortLookup | null = null
): MedmarPortResolution {
  if (!bookingServiceKind) return { status: "unknown", reason: "missing_booking_service_kind" };
  if (bookingServiceKind === "formula_medmar_napoli") return { status: "resolved", port: "ischia" };
  if (bookingServiceKind === "transfer_port_hotel") {
    const mainland = resolveImportedMainlandPort(meetingPoint);
    if (mainland.status === "unknown") return mainland;
    if (scheduleIslandPort?.status === "resolved") return { status: "resolved", port: scheduleIslandPort.port };
    return { status: "unknown", reason: "missing_island_port" };
  }
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
        | "unmapped_meeting_point"
        | "missing_island_port"
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
  /** Solo transfer_port_hotel: esito di resolveIslandPortFromSchedules. */
  scheduleIslandPort?: ScheduleIslandPortLookup | null;
}): LegRouteResolution {
  const isArrival = input.direction === "arrival";
  const isDeparture = input.direction === "departure";
  if (!isArrival && !isDeparture) {
    return { status: "unknown", reason: "missing_or_invalid_direction" };
  }

  const mainland = resolveMainlandPort(input.bookingServiceKind, input.meetingPoint);
  if (mainland.status === "unknown") return { status: "unknown", reason: mainland.reason };

  const island = resolveIslandPort(input.bookingServiceKind, input.meetingPoint, input.scheduleIslandPort ?? null);
  if (island.status === "unknown") return { status: "unknown", reason: island.reason };

  const key = isArrival ? `${mainland.port}_${island.port}` : `${island.port}_${mainland.port}`;
  const routeCode = ROUTE_CODE_TABLE[key];
  if (!routeCode) {
    return { status: "unknown", reason: "unmapped_port_combo" };
  }

  return { status: "resolved", routeCode, mainlandPort: mainland.port, islandPort: island.port };
}
