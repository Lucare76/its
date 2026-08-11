/**
 * Determina la corsa Medmar prevista usando gli orari noti già presenti nel
 * repository (lib/server/medmar-schedule.ts), NON una chiamata live a Medmar
 * (nessun endpoint "ricerca corse" è ancora documentato — vedi client.ts).
 *
 * Limite noto: i dati service (booking_service_kind + direction) permettono
 * di determinare il porto "esterno" (Napoli o Pozzuoli) e la direzione, ma
 * NON distinguono in modo affidabile Ischia da Casamicciola come porto
 * isolano. Si assume quindi Ischia come porto isolano di default e si
 * aggiunge sempre un warning esplicito da verificare manualmente.
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
 * Determina il route_code Medmar (tratta) a partire dai dati service noti:
 * booking_service_kind ("formula_medmar_napoli" | "formula_medmar_pozzuoli")
 * e direction ("arrival" | "departure"). Assume sempre Ischia come porto
 * isolano (vedi limite documentato in testa al file).
 */
export function resolveRouteCodeFromService(input: {
  bookingServiceKind: string | null;
  direction: string | null;
}): MedmarTicketRouteCode | null {
  const isArrival = input.direction === "arrival";
  const isDeparture = input.direction === "departure";
  if (!isArrival && !isDeparture) return null;

  if (input.bookingServiceKind?.includes("medmar_napoli")) {
    return isArrival ? "napoli_ischia" : "ischia_napoli";
  }
  if (input.bookingServiceKind?.includes("medmar_pozzuoli")) {
    return isArrival ? "pozzuoli_ischia" : "ischia_pozzuoli";
  }
  return null;
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
