/** Strips diacritics and non-alphanumeric chars; used for fuzzy text matching. */
export function normalizeText(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Returns today's date as YYYY-MM-DD in local time. */
export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}
