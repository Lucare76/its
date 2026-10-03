/**
 * Avvisi di revisione manuale prodotti dai controlli deterministici sul testo
 * PDF (lib/server/aleste-deterministic-checks.ts). Condiviso client+server:
 * stesso formato per import IMAP (parsed_json.review_warnings), preview PDF
 * manuale e salvataggio bozza — un solo normalizzatore, nessuna variante.
 */

export const REVIEW_WARNINGS_TITLE = "Verifica manuale richiesta";

const MAX_WARNINGS = 20;
const MAX_WARNING_CHARS = 500;

/** Accetta solo un array di stringhe non vuote (input anche non fidato, es. body client). */
export function normalizeReviewWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, MAX_WARNING_CHARS))
    .filter(Boolean)
    .slice(0, MAX_WARNINGS);
}
