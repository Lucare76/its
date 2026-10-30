import { computeIschiaArrivalTime } from "@/lib/ferry-schedule-options";
import { isFerryFormula } from "@/lib/agency-booking-time-labels";

export function agencyModificationOutboundTime(row: {booking_service_kind?:string|null; outbound_time?:string|null; time?:string|null; arrival_time?:string|null}): string {
  return (isFerryFormula(row.booking_service_kind) ? row.outbound_time || row.time || "" : row.arrival_time || row.time || "").slice(0,5);
}

/** The virtual request field must never become a database column. */
export function normalizeAgencyModificationTimes(changes: Record<string, unknown>, currentKind: string | null): Record<string, unknown> {
  const {ferry_departure_time, ...result} = changes;
  if (ferry_departure_time === undefined) return result;
  const kind = typeof result.booking_service_kind === "string" ? result.booking_service_kind : currentKind;
  if (!isFerryFormula(kind) || typeof ferry_departure_time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(ferry_departure_time)) throw new Error("Orario partenza nave non valido per questa tipologia di servizio.");
  return {...result, time:ferry_departure_time, outbound_time:ferry_departure_time, arrival_time:computeIschiaArrivalTime(kind, ferry_departure_time)};
}
