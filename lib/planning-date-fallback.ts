// Pure, framework-free helpers for Planning's "jump to the earliest date with
// data" fallback. Extracted so this logic is unit-testable without jsdom.
// Sprint Performance 13 — targeted fix.
//
// Background: before Sprint 13, Planning loaded the tenant's ENTIRE service
// history, so when the selected date had zero services it could always find
// `availableDates[0]` (the earliest date with any data, anywhere in tenant
// history) from data already in memory. Sprint 13 scoped Planning's normal
// load to a [-7, +14] day window around selectedDate, which silently broke
// that fallback for dates whose nearest available data sits outside the
// window. These helpers drive a SEPARATE, deliberately rare lookup
// (app/api/ops/services-nearest-date/route.ts) that answers exactly that one
// question without ever re-loading full tenant history.

export type PlanningRangeScope = { mode: "range"; from: string; to: string };

/**
 * Same [-7, +14] day window used by Planning's normal scoped load. Extracted
 * so "after jumping to a fallback date, Planning still requests a range scope
 * (never legacy/full-history)" is verifiable without rendering the page.
 */
export function computePlanningRangeScope(selectedDate: string): PlanningRangeScope {
  const from = new Date(`${selectedDate}T12:00:00`);
  from.setDate(from.getDate() - 7);
  const to = new Date(`${selectedDate}T12:00:00`);
  to.setDate(to.getDate() + 14);
  return { mode: "range", from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/**
 * True exactly when Planning's pre-Sprint-13 fallback would have kicked in:
 * the selected date has no data among what's currently loaded. Also guards
 * against re-firing the lookup repeatedly for the same date (e.g. while a
 * load is settling, or once the lookup already came back empty).
 */
export function shouldRequestNearestDate(params: {
  loading: boolean;
  selectedDate: string;
  availableDates: string[];
  lastAttemptedDate: string | null;
}): boolean {
  if (params.loading) return false;
  if (params.availableDates.includes(params.selectedDate)) return false;
  if (params.lastAttemptedDate === params.selectedDate) return false;
  return true;
}

/**
 * What selectedDate should become once the lookup resolves. Mirrors the
 * original `availableDates[0] ?? selectedDate` fallback: jump to the found
 * date, or stay put if nothing was found anywhere in tenant history.
 */
export function resolveNearestDateResult(foundDate: string | null, selectedDate: string): string {
  return foundDate && foundDate !== selectedDate ? foundDate : selectedDate;
}
