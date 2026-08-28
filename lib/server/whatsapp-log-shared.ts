// Shared status-resolution helpers for /api/ops/whatsapp-log, extracted
// verbatim from the existing "info_3d" / "bus_convocazione" handlers so the
// new MEDMAR handler (and any future one) can reuse the exact same
// dedup/priority rules without behavior drift.

export type KpiStatus = "read" | "delivered" | "pending" | "failed";

export const statusPriority: Record<string, number> = {
  failed: 4,
  error: 4,
  read: 3,
  delivered: 2,
  sent: 1,
  queued: 1,
  pending: 1,
};

export function normalizeStatusGroup(status?: string | null): KpiStatus {
  const value = String(status ?? "").toLowerCase();
  if (value === "read") return "read";
  if (value === "delivered") return "delivered";
  if (value === "failed" || value === "error") return "failed";
  return "pending";
}

export function isNewerStatus(
  nextStatus: string,
  nextAt: string | null | undefined,
  currentStatus: string,
  currentAt: string | null | undefined,
) {
  const nextTime = nextAt ? new Date(nextAt).getTime() : 0;
  const currentTime = currentAt ? new Date(currentAt).getTime() : 0;
  if (nextTime !== currentTime) return nextTime > currentTime;
  return (statusPriority[nextStatus] ?? 0) > (statusPriority[currentStatus] ?? 0);
}

export function buildKpi(rows: Array<{ status_group: KpiStatus }>) {
  const total = rows.length;
  const read = rows.filter((row) => row.status_group === "read").length;
  const delivered = rows.filter((row) => row.status_group === "delivered").length;
  const pending = rows.filter((row) => row.status_group === "pending").length;
  const failed = rows.filter((row) => row.status_group === "failed").length;
  return {
    total,
    read,
    delivered,
    sent: pending,
    pending,
    failed,
    notRead: delivered + pending,
  };
}

export type MessageStatusSource = { wa_message_id: string; status: string; timestamp: string | null; created_at: string };

// Resolves, per provider_message_id, the single most-recent webhook status —
// used to correlate whatsapp_events / convocation rows with the real
// delivery/read state from whatsapp_message_statuses.
export function resolveLatestStatusByMessageId(statuses: MessageStatusSource[]): Map<string, MessageStatusSource> {
  const best = new Map<string, MessageStatusSource>();
  for (const s of statuses) {
    const existing = best.get(s.wa_message_id);
    if (!existing || isNewerStatus(s.status, s.timestamp ?? s.created_at, existing.status, existing.timestamp ?? existing.created_at)) {
      best.set(s.wa_message_id, s);
    }
  }
  return best;
}
