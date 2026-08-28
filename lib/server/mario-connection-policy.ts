/**
 * MARIO_CONNECTION_POLICY — configurazione centralizzata delle regole
 * operative sul collegamento nave/continente confermate da Mario (audit
 * 2026-08-28). Unica fonte per questi valori: nessun magic number duplicato
 * altrove in lib/travel-connection-resolver.ts / lib/operational-connection-resolver.ts.
 *
 * Fonte di ogni valore — vedi commenti puntuali sotto. I buffer temporali
 * (trainToFerryMin/ferryToTrainMin/ferryToFlightMin) sono minuti CONFERMATI
 * da Mario, non stime: non degradare mai la confidence per il solo fatto di
 * usarli (a differenza delle stime storiche che restano altrove nel file,
 * es. margine sbarco aeroporto per gli arrivi in volo, dove Mario non ha
 * indicato un numero).
 */

/**
 * Ordine di preferenza dei porti continentali. Napoli è sempre tentata per
 * prima; Pozzuoli entra in gioco SOLO come fallback (nessuna corsa Napoli
 * temporalmente valida) e solo sotto il limite pax — vedi pozzuoliMaxPax.
 * Motivo: divieto di transito bus a Pozzuoli (regola operativa, non
 * un'euristica di comodo/margine/vicinanza hotel).
 */
export const MAINLAND_PORT_PREFERENCE = ["napoli_beverello", "pozzuoli"] as const;
export type MainlandPort = (typeof MAINLAND_PORT_PREFERENCE)[number];

/** Pozzuoli ammessa come fallback solo se il totale pax del servizio/gruppo è <= a questo valore. */
export const POZZUOLI_MAX_PAX = 8;

/** ARRIVO TRENO → NAVE: la nave deve partire almeno questi minuti dopo l'arrivo del treno in stazione. */
export const TRAIN_TO_FERRY_MIN = 70;

/** PARTENZA (nave → TRENO): la nave deve arrivare in porto almeno questi minuti prima della partenza del treno. */
export const FERRY_TO_TRAIN_MIN = 90;

/** PARTENZA (nave → VOLO): la nave deve arrivare in porto almeno questi minuti prima della partenza del volo. */
export const FERRY_TO_FLIGHT_MIN = 160;

/** ARRIVO VOLO → NAVE: nessun buffer fisso confermato da Mario. Regola: prima corsa MEDMAR da Napoli realmente raggiungibile (vedi resolveArrival, ramo flight). */
export const AIRPORT_ARRIVAL_PREFERRED_COMPANY = "medmar";
export const AIRPORT_ARRIVAL_PREFERRED_PORT: MainlandPort = "napoli_beverello";

/**
 * Preferenza commerciale SNAV entro ±30min — DISATTIVATA come regola globale:
 * la risposta di Mario al questionario non la conferma esplicitamente. Resta
 * disponibile solo come comportamento legacy/manuale per casi già confermati
 * uno per uno (es. BIRAGO, override manuale). Non generalizzare da un caso
 * confermato a una policy automatica.
 */
export const SNAV_PREFERENCE_ENABLED = false;

/**
 * Budget/costi extra — Mario ha indicato che la scelta considera anche
 * budget x costi extra, ma non esistono nel repo dati tariffari strutturati
 * (costi ferry per compagnia, costi bus, supplementi, costi agenzia) per
 * modellare un motore costi reale. Marker esplicito di gap, mai un numero
 * simulato:
 */
export const COST_CONSTRAINT_NOT_MODELED = true;

export const MARIO_CONNECTION_POLICY = {
  mainlandPortPreference: MAINLAND_PORT_PREFERENCE,
  pozzuoliMaxPax: POZZUOLI_MAX_PAX,
  trainToFerryMin: TRAIN_TO_FERRY_MIN,
  ferryToTrainMin: FERRY_TO_TRAIN_MIN,
  ferryToFlightMin: FERRY_TO_FLIGHT_MIN,
  airportArrivalPreferredCompany: AIRPORT_ARRIVAL_PREFERRED_COMPANY,
  airportArrivalPreferredPort: AIRPORT_ARRIVAL_PREFERRED_PORT,
  snavPreferenceEnabled: SNAV_PREFERENCE_ENABLED,
  costConstraintNotModeled: COST_CONSTRAINT_NOT_MODELED,
} as const;
