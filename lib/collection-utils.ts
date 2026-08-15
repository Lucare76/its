// Generic client-side helper for incremental pagination ("Carica altre" style
// UIs): appends a new page of rows to an already-loaded list without
// duplicating rows the list already has.
export function dedupeAppend<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const seen = new Set(current.map((row) => row.id));
  const merged = current.slice();
  for (const row of incoming) {
    if (!seen.has(row.id)) {
      merged.push(row);
      seen.add(row.id);
    }
  }
  return merged;
}
