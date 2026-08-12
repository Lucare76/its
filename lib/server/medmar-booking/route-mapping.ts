/**
 * Mappatura route_code ITS -> id_tratta Medmar (Fase 1.6 "Mappatura completa
 * tratte verificate").
 *
 * IMPORTANTE: contiene SOLO le corrispondenze confermate direttamente da
 * risposte JSON reali Medmar su più corse e più date. Non aggiungere altre
 * tratte finché non vengono verificate allo stesso modo.
 *
 * Verificato:
 *   ISCHIA -> NAPOLI: id_tratta=47, id_porto_partenza=41 (ISCHIA), id_porto_arrivo=1 (NAPOLI)
 *   NAPOLI -> ISCHIA: id_tratta=59, id_porto_partenza=1 (NAPOLI), id_porto_arrivo=41 (ISCHIA)
 *   ISCHIA -> POZZUOLI: id_tratta=14, id_porto_partenza=41 (ISCHIA), id_porto_arrivo=44 (POZZUOLI)
 *   POZZUOLI -> ISCHIA: id_tratta=56, id_porto_partenza=44 (POZZUOLI), id_porto_arrivo=41 (ISCHIA)
 *   CASAMICCIOLA -> POZZUOLI: id_tratta=50, id_porto_partenza=2 (CASAMICCIOLA), id_porto_arrivo=44 (POZZUOLI)
 *   POZZUOLI -> CASAMICCIOLA: id_tratta=53, id_porto_partenza=44 (POZZUOLI), id_porto_arrivo=2 (CASAMICCIOLA)
 *
 * NOTA "id_listino" vs "id_tratta": per la tratta Ischia->Pozzuoli, anche
 * id_listino = 14 (coincidenza numerica con id_tratta osservata nei dati
 * reali). id_listino è un concetto Medmar diverso (catalogo tariffe) e non
 * viene mai letto/usato da questo modulo: qui esiste SOLO id_tratta.
 *
 * LIMITE NOTO (non introdotto da questa fase, pre-esistente): i dati service
 * ITS (booking_service_kind + direction, vedi course-matcher.ts) non
 * distinguono Ischia da Casamicciola come porto isolano — resolveRouteCodeFromService
 * assume sempre Ischia. Le due voci casamicciola_pozzuoli/pozzuoli_casamicciola
 * sono quindi mappature verificate e corrette, ma NON ancora raggiungibili
 * automaticamente dal preflight reale finché i dati service non permettono di
 * riconoscere Casamicciola: un servizio Casamicciola oggi risolve comunque
 * su ischia_pozzuoli/pozzuoli_ischia (già così anche per Napoli, in Fase 1.5B).
 * Questo modulo non inventa una euristica per colmare quel limite — il
 * warning "island_port_assumed" (preflight.ts) segnala il caso.
 *
 * Se il service ITS richiede una tratta non presente qui, il preflight
 * restituisce manual_review — mai un id_tratta indovinato.
 */

import type { MedmarTicketRouteCode } from "@/lib/medmar-ticket-memory";

const VERIFIED_ROUTE_TO_ID_TRATTA: Partial<Record<MedmarTicketRouteCode, number>> = {
  ischia_napoli: 47,
  napoli_ischia: 59,
  ischia_pozzuoli: 14,
  pozzuoli_ischia: 56,
  casamicciola_pozzuoli: 50,
  pozzuoli_casamicciola: 53,
};

type VerifiedPorts = { idPortoPartenza: number; idPortoArrivo: number };

const VERIFIED_ROUTE_TO_PORTS: Partial<Record<MedmarTicketRouteCode, VerifiedPorts>> = {
  ischia_napoli: { idPortoPartenza: 41, idPortoArrivo: 1 },
  napoli_ischia: { idPortoPartenza: 1, idPortoArrivo: 41 },
  ischia_pozzuoli: { idPortoPartenza: 41, idPortoArrivo: 44 },
  pozzuoli_ischia: { idPortoPartenza: 44, idPortoArrivo: 41 },
  casamicciola_pozzuoli: { idPortoPartenza: 2, idPortoArrivo: 44 },
  pozzuoli_casamicciola: { idPortoPartenza: 44, idPortoArrivo: 2 },
};

/**
 * Coppia "andata/ritorno" per ciascuna delle 6 tratte verificate: usata dal
 * preflight per rifiutare (manual_review) un gruppo la cui gamba di ritorno
 * non è lo specchio esatto di quella di andata (es. andata Napoli->Ischia +
 * ritorno Ischia->Pozzuoli), scenario che diventa raggiungibile solo ora che
 * più di 2 tratte sono mappate.
 */
const MIRROR_ROUTE: Partial<Record<MedmarTicketRouteCode, MedmarTicketRouteCode>> = {
  ischia_napoli: "napoli_ischia",
  napoli_ischia: "ischia_napoli",
  ischia_pozzuoli: "pozzuoli_ischia",
  pozzuoli_ischia: "ischia_pozzuoli",
  casamicciola_pozzuoli: "pozzuoli_casamicciola",
  pozzuoli_casamicciola: "casamicciola_pozzuoli",
};

export function getIdTrattaForRouteCode(routeCode: MedmarTicketRouteCode): number | null {
  return VERIFIED_ROUTE_TO_ID_TRATTA[routeCode] ?? null;
}

/** Porti attesi per la tratta: usati per una verifica strutturale bloccante sulla corsa Medmar (vedi preflight.ts). */
export function getExpectedPortsForRouteCode(routeCode: MedmarTicketRouteCode): VerifiedPorts | null {
  return VERIFIED_ROUTE_TO_PORTS[routeCode] ?? null;
}

/** true se `b` è la tratta di ritorno speculare di `a` (es. ischia_napoli <-> napoli_ischia). */
export function isMirrorRouteCode(a: MedmarTicketRouteCode, b: MedmarTicketRouteCode): boolean {
  return MIRROR_ROUTE[a] === b;
}
