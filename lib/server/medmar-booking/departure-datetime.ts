/**
 * Conversione data+ora locale Europe/Rome (corsa nave Medmar) in istante UTC
 * comparabile con `now`, per i controlli temporali fail-closed del preflight
 * (corsa già partita / ordine A/R stesso giorno — vedi preflight.ts).
 *
 * Nessuna libreria esterna: stesso approccio round-trip via Intl già usato in
 * lib/server/whatsapp/office-hours.ts (là in direzione UTC -> locale, qui
 * nella direzione opposta locale -> UTC), gestisce correttamente il DST.
 */

const MEDMAR_TIME_ZONE = "Europe/Rome";

const zoneFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: MEDMAR_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function partsInZone(date: Date) {
  const values = Object.fromEntries(zoneFormatter.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

/**
 * Converte data (YYYY-MM-DD) + ora (HH:mm oppure HH:mm:ss) locali
 * Europe/Rome nell'istante UTC corrispondente. null se data/ora non
 * valide — mai un istante indovinato su input malformato.
 */
export function romeDateTimeToUtc(dateIso: string | null | undefined, time: string | null | undefined): Date | null {
  const dateMatch = String(dateIso ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = String(time ?? "").trim().match(/^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
  if (!dateMatch || !timeMatch) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3] ?? "0");

  // Round-trip: interpreta prima i campi come se fossero UTC, poi guarda che
  // ora locale Europe/Rome corrisponde a quell'istante, e usa la differenza
  // come offset per ricavare l'istante UTC reale (gestisce CET/CEST).
  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const guessed = partsInZone(new Date(naiveUtcMs));
  const guessedAsUtcMs = Date.UTC(guessed.year, guessed.month - 1, guessed.day, guessed.hour, guessed.minute, guessed.second);
  const offsetMs = guessedAsUtcMs - naiveUtcMs;
  return new Date(naiveUtcMs - offsetMs);
}

/** Formatta data+ora per i messaggi UI: "HH:mm del DD/MM/YYYY". null-safe (mai un placeholder indovinato). */
export function formatItalianDateTime(dateIso: string | null | undefined, time: string | null | undefined): string {
  const dateMatch = String(dateIso ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = String(time ?? "").trim().match(/^([01]?\d|2[0-3]):([0-5]\d)/);
  const hhmm = timeMatch ? `${timeMatch[1].padStart(2, "0")}:${timeMatch[2]}` : String(time ?? "—");
  if (!dateMatch) return `${hhmm} del ${dateIso ?? "—"}`;
  return `${hhmm} del ${dateMatch[3]}/${dateMatch[2]}/${dateMatch[1]}`;
}
