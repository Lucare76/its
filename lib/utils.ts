/** Strips diacritics and non-alphanumeric chars; used for fuzzy text matching. */
export function normalizeText(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const ROME_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Rome",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Fix P2 (audit pre-go-live): data odierna (YYYY-MM-DD) nel fuso
 * Europe/Rome — non UTC. La versione precedente (`new Date().toISOString()
 * .slice(0, 10)`, nonostante il commento "in local time") restituiva
 * sempre la data UTC: nelle ore intorno alla mezzanotte italiana (23:00-
 * 23:59 CET, 22:00-23:59 CEST) "oggi" poteva risultare il giorno
 * precedente rispetto alla data operativa reale in Italia. Stesso pattern
 * già usato e testato altrove nel repo (mai una terza implementazione):
 * lib/ferry-pickup-rules.ts::todayIsoDateRome,
 * lib/server/operational-health/operations-health.ts::romeDateKey.
 * `now` opzionale per testabilità deterministica (stesso approccio di
 * todayIsoDateRome).
 */
export function todayIsoDate(now: Date = new Date()): string {
  return ROME_DATE_FORMATTER.format(now);
}
