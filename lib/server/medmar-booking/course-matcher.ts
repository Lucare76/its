/**
 * Determina la corsa Medmar prevista usando gli orari noti già presenti nel
 * repository (lib/server/medmar-schedule.ts), NON una chiamata live a Medmar
 * (nessun endpoint "ricerca corse" è ancora documentato — vedi client.ts).
 *
 * La risoluzione del route_code (quale porto isolano è coinvolto: Ischia o
 * Casamicciola) NON avviene qui — vedi port-resolution.ts:resolveLegRouteCode,
 * che usa booking_service_kind + meeting_point ed è fail-closed su unknown.
 * Questo modulo resta solo un confronto diagnostico sugli orari noti per un
 * route_code già risolto altrove.
 */

import { MEDMAR_SCHEDULE } from "@/lib/server/medmar-schedule";
import type { MedmarTicketRouteCode } from "@/lib/medmar-ticket-memory";

export type CourseMatchResult =
  | { status: "matched"; matchedTime: string }
  | { status: "no_match" }
  | { status: "ambiguous"; candidateTimes: string[] };

const ROUTE_SCHEDULE: Partial<Record<MedmarTicketRouteCode, readonly string[]>> = {
  napoli_ischia: MEDMAR_SCHEDULE.napoliToIschia,
  ischia_napoli: MEDMAR_SCHEDULE.ischiaToNapoli,
  pozzuoli_ischia: MEDMAR_SCHEDULE.pozzuoliToIschia,
  ischia_pozzuoli: MEDMAR_SCHEDULE.ischiaToPozzuoli,
  casamicciola_pozzuoli: MEDMAR_SCHEDULE.casamicciolaToPozzuoli,
  pozzuoli_casamicciola: MEDMAR_SCHEDULE.pozzuoliToCasamicciola,
};

const MATCH_TOLERANCE_MINUTES = 20;

function toMinutes(time: string): number | null {
  const match = time.match(/^([0-2]\d):([0-5]\d)/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Cerca, tra gli orari noti per la tratta, quelli compatibili con l'orario
 * richiesto (tolleranza fissa). 0 risultati -> no_match. 1 -> matched.
 * >1, oppure orario richiesto assente -> ambiguous (nessuna scelta arbitraria).
 */
export function matchCourseByRouteAndTime(
  routeCode: MedmarTicketRouteCode,
  requestedTime: string | null
): CourseMatchResult {
  const knownTimes = ROUTE_SCHEDULE[routeCode];
  if (!knownTimes || knownTimes.length === 0) {
    return { status: "no_match" };
  }

  if (!requestedTime) {
    return { status: "ambiguous", candidateTimes: [...knownTimes] };
  }

  const requestedMinutes = toMinutes(requestedTime);
  if (requestedMinutes === null) {
    return { status: "ambiguous", candidateTimes: [...knownTimes] };
  }

  const compatible = knownTimes.filter((time) => {
    const minutes = toMinutes(time);
    return minutes !== null && Math.abs(minutes - requestedMinutes) <= MATCH_TOLERANCE_MINUTES;
  });

  if (compatible.length === 0) return { status: "no_match" };
  if (compatible.length > 1) return { status: "ambiguous", candidateTimes: compatible };
  return { status: "matched", matchedTime: compatible[0]! };
}
