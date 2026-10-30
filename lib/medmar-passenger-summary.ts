/** Never infer age categories from the total alone. */
export function medmarPassengerSummary(details: unknown, pax: number): string {
  const fd = details && typeof details === "object" && !Array.isArray(details) ? details as Record<string, unknown> : {};
  const values = [fd.medmar_infant_count, fd.medmar_child_count, fd.medmar_adult_count];
  if (!values.every((v): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0) || values.reduce((sum, v) => sum + v, 0) !== pax || pax <= 0) {
    return "Composizione per età non disponibile o incoerente: da verificare";
  }
  return `${values[2]} adulti (12+) · ${values[1]} bambini (4–11 anni) · ${values[0]} bambini (0–3 anni)`;
}
