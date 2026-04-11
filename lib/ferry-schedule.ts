/**
 * Tabelle orari SNAV e MEDMAR per rilevamento automatico porto.
 * Lookup sincrono — nessuna chiamata API esterna.
 */

export type FerryPort = "Casamicciola" | "Ischia Porto";

// ── SNAV ─────────────────────────────────────────────────────────────────────
// Porto fisso: sempre Casamicciola (Napoli Beverello ↔ Casamicciola)

export const SNAV_PORT: FerryPort = "Casamicciola";

export const SNAV_ARRIVALS: string[] = [
  "08:10","08:30","09:20","11:30","12:30","13:55","15:10","16:20","17:10","19:00",
];
export const SNAV_DEPARTURES: string[] = [
  "07:10","09:45","10:30","12:50","13:15","14:00","15:15","17:40","18:30","20:00",
];

// ── MEDMAR ───────────────────────────────────────────────────────────────────
// Porto variabile: dipende dall'orario (Pozzuoli ↔ Ischia Porto | Casamicciola)

export const MEDMAR_ARRIVALS: Record<string, FerryPort> = {
  "06:25": "Ischia Porto",
  "08:15": "Casamicciola",
  "09:40": "Ischia Porto",
  "12:00": "Casamicciola",
  "13:30": "Ischia Porto",
  "15:00": "Casamicciola",
  "16:30": "Ischia Porto",
  "18:30": "Casamicciola",
};

export const MEDMAR_DEPARTURES: Record<string, FerryPort> = {
  "04:30": "Ischia Porto",
  "06:20": "Casamicciola",
  "08:10": "Ischia Porto",
  "10:10": "Casamicciola",
  "11:10": "Ischia Porto",
  "13:35": "Casamicciola",
  "15:00": "Ischia Porto",
  "16:50": "Casamicciola",
};

/** Rileva il porto dal tipo di formula, direzione e orario. */
export function detectFerryPort(
  preset: "formula_snav" | "formula_medmar",
  direction: "arrival" | "departure",
  time: string, // "HH:MM"
): FerryPort | null {
  if (preset === "formula_snav") return SNAV_PORT;
  const table = direction === "arrival" ? MEDMAR_ARRIVALS : MEDMAR_DEPARTURES;
  return table[time] ?? null;
}

/** Elenco orari disponibili per un dato preset + direzione. */
export function ferryTimes(
  preset: "formula_snav" | "formula_medmar",
  direction: "arrival" | "departure",
): string[] {
  if (preset === "formula_snav") {
    return direction === "arrival" ? SNAV_ARRIVALS : SNAV_DEPARTURES;
  }
  const table = direction === "arrival" ? MEDMAR_ARRIVALS : MEDMAR_DEPARTURES;
  return Object.keys(table).sort();
}
