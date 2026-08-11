/**
 * Mappatura route_code ITS -> id_tratta Medmar (Fase 1.5B "Allineamento a
 * dati reali").
 *
 * IMPORTANTE: contiene SOLO le corrispondenze confermate direttamente da
 * risposte JSON reali Medmar su più corse e più date. Non aggiungere altre
 * tratte (Casamicciola, Pozzuoli, ecc.) finché non vengono verificate allo
 * stesso modo.
 *
 * Verificato:
 *   ISCHIA -> NAPOLI: id_tratta=47, id_porto_partenza=41 (ISCHIA), id_porto_arrivo=1 (NAPOLI)
 *   NAPOLI -> ISCHIA: id_tratta=59, id_porto_partenza=1 (NAPOLI), id_porto_arrivo=41 (ISCHIA)
 *
 * Se il service ITS richiede una tratta non presente qui, il preflight
 * restituisce manual_review — mai un id_tratta indovinato.
 */

import type { MedmarTicketRouteCode } from "@/lib/medmar-ticket-memory";

const VERIFIED_ROUTE_TO_ID_TRATTA: Partial<Record<MedmarTicketRouteCode, number>> = {
  ischia_napoli: 47,
  napoli_ischia: 59,
};

type VerifiedPorts = { idPortoPartenza: number; idPortoArrivo: number };

const VERIFIED_ROUTE_TO_PORTS: Partial<Record<MedmarTicketRouteCode, VerifiedPorts>> = {
  ischia_napoli: { idPortoPartenza: 41, idPortoArrivo: 1 },
  napoli_ischia: { idPortoPartenza: 1, idPortoArrivo: 41 },
};

export function getIdTrattaForRouteCode(routeCode: MedmarTicketRouteCode): number | null {
  return VERIFIED_ROUTE_TO_ID_TRATTA[routeCode] ?? null;
}

/** Porti attesi per la tratta, usati per una verifica incrociata diagnostica sulla risposta Medmar. */
export function getExpectedPortsForRouteCode(routeCode: MedmarTicketRouteCode): VerifiedPorts | null {
  return VERIFIED_ROUTE_TO_PORTS[routeCode] ?? null;
}
