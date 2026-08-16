// Pure, framework-free builder for GET /api/ops/dashboard-data requests.
// Mirrors lib/services-list-request.ts / lib/supabase/tenant-data-request.ts
// so the query-shape/request-key logic can be unit tested without React or
// Supabase. Sprint Performance 14B.

export type DashboardDataRequestOptions = {
  /** dayOffset-aware "today" (YYYY-MM-DD), computed by the caller exactly as
   *  the legacy client-side todayIso was. */
  today: string;
  /** Fixed "now + 48h" (YYYY-MM-DD), independent of the Oggi/Domani toggle,
   *  computed by the caller exactly as the legacy client-side next48hIso was. */
  next48h: string;
};

export type DashboardDataRequest = {
  searchParams: URLSearchParams;
  /** Stable key identifying this exact today+next48h combination — used to
   *  detect "same window, refresh again" vs "window changed, new request". */
  requestKey: string;
};

export function buildDashboardDataRequest(options: DashboardDataRequestOptions): DashboardDataRequest {
  const { today, next48h } = options;
  const searchParams = new URLSearchParams({ today, next48h });
  return { searchParams, requestKey: `${today}|${next48h}` };
}
