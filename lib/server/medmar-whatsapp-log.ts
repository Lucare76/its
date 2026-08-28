// Pure aggregation logic for the MEDMAR tab of /api/ops/whatsapp-log.
// Kept separate from the Supabase queries in the route handler so the
// date-filtering / status-resolution / KPI rules can be unit tested without
// a database.

import {
  normalizeStatusGroup,
  resolveLatestStatusByMessageId,
  type KpiStatus,
  type MessageStatusSource,
  buildKpi,
} from "@/lib/server/whatsapp-log-shared";

export type MedmarLogRowSource = {
  id: string;
  batch_id: string;
  customer_name: string;
  travel_date: string;
  travel_date_iso: string | null;
  route: string;
  departure_time: string;
  passengers: string;
  phone_raw: string;
  phone_e164: string | null;
  status: string; // 'inviato' | 'errore' | other non-sent statuses
  error_message: string | null;
  provider_message_id: string | null;
  sent_at: string | null;
};

export type MedmarBatchSource = { id: string; file_name: string };

export type MedmarLogRow = {
  row_id: string;
  to_phone: string;
  status: string;
  status_group: KpiStatus;
  happened_at: string | null;
  customer_name: string;
  travel_date: string;
  route: string;
  departure_time: string;
  passengers: string;
  file_name: string | null;
  error_message: string | null;
};

// Only rows that actually represent a send attempt appear in the log —
// rows still queued (pronto/da_inviare/escluso/duplicato/numero_non_valido)
// have no WhatsApp delivery status to report yet.
const SENT_ATTEMPT_STATUSES = new Set(["inviato", "errore"]);

export function filterMedmarRowsByDate(rows: MedmarLogRowSource[], dateIso: string): MedmarLogRowSource[] {
  return rows.filter((r) => r.travel_date_iso === dateIso && SENT_ATTEMPT_STATUSES.has(r.status));
}

function mapRowStatusToWhatsAppStatus(rowStatus: string): string {
  if (rowStatus === "inviato") return "sent";
  if (rowStatus === "errore") return "failed";
  return rowStatus;
}

export function buildMedmarWhatsAppLog(
  rows: MedmarLogRowSource[],
  statuses: MessageStatusSource[],
  batches: MedmarBatchSource[],
) {
  const bestStatusByMsg = resolveLatestStatusByMessageId(statuses);
  const fileNameByBatch = new Map(batches.map((b) => [b.id, b.file_name]));

  // Keyed by row id (the canonical MEDMAR row identity) — a manual resend
  // updates the same row in place (new provider_message_id/status/sent_at),
  // so this map can never contain two entries for one logical convocation.
  const byRowId = new Map<string, MedmarLogRow>();

  for (const row of rows) {
    const latest = row.provider_message_id ? bestStatusByMsg.get(row.provider_message_id) : undefined;
    const resolvedStatus = latest?.status ?? mapRowStatusToWhatsAppStatus(row.status);
    const resolvedAt = latest?.timestamp ?? latest?.created_at ?? row.sent_at ?? null;

    byRowId.set(row.id, {
      row_id: row.id,
      to_phone: row.phone_e164 ?? row.phone_raw,
      status: resolvedStatus,
      status_group: row.status === "errore" && !latest ? "failed" : normalizeStatusGroup(resolvedStatus),
      happened_at: resolvedAt,
      customer_name: row.customer_name,
      travel_date: row.travel_date,
      route: row.route,
      departure_time: row.departure_time,
      passengers: row.passengers,
      file_name: fileNameByBatch.get(row.batch_id) ?? null,
      error_message: row.error_message,
    });
  }

  const allRows = [...byRowId.values()].sort((a, b) => a.customer_name.localeCompare(b.customer_name));
  const notReadRows = allRows.filter((r) => r.status_group === "delivered" || r.status_group === "pending");
  const failedRows = allRows.filter((r) => r.status_group === "failed");
  const kpi = buildKpi(allRows);

  return { kpi, rows: allRows, notReadRows, failedRows };
}
