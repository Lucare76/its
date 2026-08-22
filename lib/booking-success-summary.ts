/**
 * Regole pure (nessun React/JSX) per la card di successo post-creazione in
 * app/(app)/services/new/page.tsx — estratte in un modulo separato perche'
 * questo repo non ha infrastruttura per test di rendering React (nessun
 * jsdom/@testing-library/react in package.json, vitest.config.ts usa
 * environment: "node"), stesso pattern di lib/medmar-delivery-card.ts.
 *
 * L'operatore NON deve mai vedere l'UUID tecnico come identificativo
 * principale della prenotazione: qui non esiste nessuna funzione che
 * restituisca l'id grezzo come testo da mostrare — solo il numero pratica
 * leggibile (o un fallback neutro se manca) e i campi umani.
 */

/** Data "YYYY-MM-DD" (senza ora) -> "DD/MM/YYYY", per i campi arrival_date/departure_date gia' date-only. */
export function formatDateItFromIso(dateOnly: string | null | undefined): string | null {
  if (!dateOnly) return null;
  const match = dateOnly.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, y, m, d] = match;
  return `${d}/${m}/${y}`;
}

/**
 * created_at persistito dal server (ISO) -> "DD/MM/YYYY alle HH:mm" in
 * timezone operativa (Europe/Rome). La fonte deve SEMPRE essere l'ISO
 * restituito dal server (mai `new Date()` lato client): questa funzione si
 * limita a formattare cio' che riceve, non genera mai un timestamp proprio.
 */
export function formatCreatedAtLabel(createdAtIso: string | null | undefined): string | null {
  if (!createdAtIso) return null;
  const d = new Date(createdAtIso);
  if (Number.isNaN(d.getTime())) return null;
  const datePart = new Intl.DateTimeFormat("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Rome" }).format(d);
  const timePart = new Intl.DateTimeFormat("it-IT", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/Rome" }).format(d);
  return `${datePart} alle ${timePart}`;
}

/**
 * true se la prenotazione ha una gamba di ritorno (A/R): sia che l'API abbia
 * restituito `id_return` sia (fallback) che `booking.trip_leg` sia
 * 'round_trip'. Usata per decidere se mostrare "Ritorno" nella card — MAI
 * un secondo numero pratica: andata e ritorno condividono sempre lo stesso
 * `booking.practice_number` (assegnato una sola volta lato server).
 */
export function hasReturnLeg(input: { id_return?: string | null; trip_leg?: string | null }): boolean {
  return !!(input.id_return || input.trip_leg === "round_trip");
}

/** Titolo della card: numero pratica leggibile se presente, mai l'UUID come fallback. */
export function practiceNumberHeading(practiceNumber: string | null | undefined): string {
  return practiceNumber ? `Pratica ${practiceNumber}` : "Prenotazione registrata";
}

/** Etichetta "Creata da X" — mai un UUID utente, sempre il nome operatore gia' risolto server-side (getOperatorName). */
export function createdByLabel(operatorName: string | null | undefined): string {
  return operatorName ? `Creata da ${operatorName}` : "Operatore";
}
