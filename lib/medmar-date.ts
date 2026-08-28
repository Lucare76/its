// Pure calendar-day date helpers for MEDMAR convocation date filtering.
// Deliberately calendar-day arithmetic (no UTC-window math) so DST / midnight
// edge cases can't shift a selected operational day — per spec, the day
// picker represents "data di partenza", not a 24h UTC window.

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// "Today" in the Europe/Rome operational timezone, as YYYY-MM-DD.
export function todayInRome(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which is exactly the canonical form we need.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(now);
}

// Shifts a YYYY-MM-DD calendar day by deltaDays, immune to DST because the
// arithmetic happens on UTC midnight of that calendar date (no timezone
// offset is ever applied to the day count itself).
export function shiftIsoDate(dateIso: string, deltaDays: number): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function formatIsoDateItalian(dateIso: string): string {
  if (!isValidIsoDate(dateIso)) return dateIso;
  const [y, m, d] = dateIso.split("-");
  return `${d}/${m}/${y}`;
}

export function formatIsoDateShort(dateIso: string): string {
  if (!isValidIsoDate(dateIso)) return dateIso;
  const [, m, d] = dateIso.split("-");
  return `${d}/${m}`;
}

// Resolves the operational day to query: validates the provided date param
// (YYYY-MM-DD) or defaults to "today" in Europe/Rome when absent.
export function resolveOperationalDate(dateParam: string | null | undefined, now: Date = new Date()): { ok: true; date: string } | { ok: false; error: string } {
  if (!dateParam) return { ok: true, date: todayInRome(now) };
  if (!isValidIsoDate(dateParam)) return { ok: false, error: "Parametro date non valido: atteso formato YYYY-MM-DD" };
  return { ok: true, date: dateParam };
}
