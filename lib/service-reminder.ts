// Shared by components/services-table.tsx (per-row badge) and
// lib/server/services-list-aggregates.ts (dataset-wide stat) so both stay in
// sync with a single definition of "undelivered reminder".
const DEFAULT_REMINDER_ALERT_MINUTES = 30;

export function isUndeliveredReminder(service: { reminder_status?: string | null; sent_at?: string | null }): boolean {
  if (service.reminder_status !== "sent" || !service.sent_at) return false;
  const alertMinutes = Number(process.env.NEXT_PUBLIC_REMINDER_ALERT_MINUTES ?? String(DEFAULT_REMINDER_ALERT_MINUTES));
  const thresholdMs = (Number.isFinite(alertMinutes) ? alertMinutes : DEFAULT_REMINDER_ALERT_MINUTES) * 60 * 1000;
  const sentAtMs = new Date(service.sent_at).getTime();
  if (!Number.isFinite(sentAtMs)) return false;
  return Date.now() - sentAtMs > thresholdMs;
}
