// Pure aggregation logic for the SNAV tab of /api/ops/whatsapp-log.
// Kept separate from the Supabase queries in the route handler so the
// date-filtering / status-resolution / KPI rules can be unit tested without
// a database. Mirrors lib/server/medmar-whatsapp-log.ts.
//
// Data sources joined here:
//   - snav_convocation_rows        → one row per convocation (current state)
//   - snav_convocation_send_logs   → per-attempt detail (template, params,
//                                     operator, Meta error, attempt number)
//   - whatsapp_message_statuses    → real delivery/read state from webhooks
//   - snav_convocation_batches     → file name / label of the source Excel
//   - memberships                  → operator display name

import {
  normalizeStatusGroup,
  resolveLatestStatusByMessageId,
  type KpiStatus,
  type MessageStatusSource,
} from "@/lib/server/whatsapp-log-shared";

export type SnavLogRowSource = {
  id: string;
  batch_id: string;
  inviare: boolean | null;
  customer_name: string;
  departure_date_label: string;
  departure_date: string | null;
  hotel: string;
  passengers: string;
  pickup_time: string;
  vessel_time: string;
  phone_raw: string;
  phone_e164: string | null;
  status: string;
  error_message: string | null;
  provider_message_id: string | null;
  sent_at: string | null;
};

export type SnavSendLogSource = {
  id: string;
  row_id: string;
  operator_user_id: string | null;
  template_name: string | null;
  language_code: string | null;
  variables_json: Record<string, unknown> | null;
  status: string; // 'sent' | 'failed'
  provider_message_id: string | null;
  error_message: string | null;
  api_response_json: unknown;
  attempt_number: number | null;
  attempted_at: string | null;
};

export type SnavBatchSource = { id: string; file_name: string; label?: string | null };
export type SnavOperatorSource = { user_id: string; full_name: string | null; email: string | null };

export type SnavSendState = "sent" | "failed" | "not_sent";

export type SnavLogRow = {
  row_id: string;
  to_phone: string;
  customer_name: string;
  departure_date_label: string;
  departure_date: string | null;
  hotel: string;
  passengers: string;
  pickup_time: string;
  vessel_time: string;
  send_state: SnavSendState;
  status: string;
  status_group: KpiStatus;
  happened_at: string | null;
  template: string | null;
  language_code: string | null;
  params: string[];
  operator_name: string | null;
  attempt_number: number | null;
  error_code: string | null;
  error_message: string | null;
  error_raw: unknown;
  file_name: string | null;
  batch_label: string | null;
};

export type SnavLogSummary = {
  total: number;
  expected: number; // convocazioni che DEVONO ricevere un WhatsApp (inviare=true, non escluse/duplicate)
  sent: number;
  failed: number;
  notSent: number;
  missing: number; // expected - sent, mai negativo — "N convocazioni non inviate"
  delivered: number;
  read: number;
  pending: number;
  successRate: number; // % inviati sul totale del giorno
  readRate: number; // % letti sugli inviati
};

// Ordered labels for the 6 params of the "partenze_snav" Meta template —
// see lib/snav-convocation-template.ts. Purely presentational.
export const SNAV_PARAM_LABELS = [
  "Cliente",
  "Data partenza",
  "Hotel",
  "Pax",
  "Ora prelevamento",
  "Ora aliscafo",
];

const SENT_STATUSES = new Set(["inviato"]);
const FAILED_STATUSES = new Set(["errore", "numero_non_valido"]);
const NOT_EXPECTED_STATUSES = new Set(["escluso", "duplicato"]);

export function classifyRowState(status: string): SnavSendState {
  if (SENT_STATUSES.has(status)) return "sent";
  if (FAILED_STATUSES.has(status)) return "failed";
  return "not_sent";
}

// A convocation is "expected" (must get a WhatsApp) when inviare is not
// false and its status is not escluso/duplicato. Used for previste-vs-inviate.
export function isExpectedConvocation(row: { inviare: boolean | null; status: string }): boolean {
  return row.inviare !== false && !NOT_EXPECTED_STATUSES.has(row.status);
}

// Day filtering uses the canonical `departure_date` DATE column (Supabase
// returns it as a plain "YYYY-MM-DD" string), so this is an exact value
// match — never a fragile substring / locale-string comparison. This is the
// SNAV departure day, NOT the day the WhatsApp was sent.
export function filterSnavRowsByDate(rows: SnavLogRowSource[], dateIso: string): SnavLogRowSource[] {
  return rows.filter((r) => r.departure_date === dateIso);
}

function attemptRank(log: SnavSendLogSource): number {
  return typeof log.attempt_number === "number" ? log.attempt_number : 0;
}

function isLaterAttempt(next: SnavSendLogSource, current: SnavSendLogSource): boolean {
  const dr = attemptRank(next) - attemptRank(current);
  if (dr !== 0) return dr > 0;
  const nt = next.attempted_at ? new Date(next.attempted_at).getTime() : 0;
  const ct = current.attempted_at ? new Date(current.attempted_at).getTime() : 0;
  return nt >= ct;
}

export function extractMetaErrorCode(errorMessage: string | null, apiResponseJson: unknown): string | null {
  if (apiResponseJson && typeof apiResponseJson === "object") {
    const err = (apiResponseJson as { error?: { code?: unknown } }).error;
    if (err && err.code != null) return String(err.code);
    const flat = (apiResponseJson as { code?: unknown }).code;
    if (flat != null && typeof flat !== "object") return String(flat);
  }
  if (errorMessage) {
    const bracket = errorMessage.match(/\[#(\d+)\]/);
    if (bracket) return bracket[1];
    const worded = errorMessage.match(/\bcode\s+(\d+)\b/i);
    if (worded) return worded[1];
  }
  return null;
}

function paramsFromVariables(variables: Record<string, unknown> | null | undefined): string[] {
  if (!variables) return [];
  return Object.keys(variables)
    .sort((a, b) => {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.localeCompare(b);
    })
    .map((k) => String(variables[k] ?? ""));
}

export function buildSnavWhatsAppLog(
  rows: SnavLogRowSource[],
  statuses: MessageStatusSource[],
  batches: SnavBatchSource[],
  sendLogs: SnavSendLogSource[],
  operators: SnavOperatorSource[],
): { summary: SnavLogSummary; rows: SnavLogRow[]; failedRows: SnavLogRow[]; notSentRows: SnavLogRow[] } {
  const bestStatusByMsg = resolveLatestStatusByMessageId(statuses);
  const fileNameByBatch = new Map(batches.map((b) => [b.id, b.file_name]));
  const labelByBatch = new Map(batches.map((b) => [b.id, b.label ?? null]));
  const operatorById = new Map(operators.map((o) => [o.user_id, o]));

  const latestLogByRow = new Map<string, SnavSendLogSource>();
  for (const log of sendLogs) {
    const current = latestLogByRow.get(log.row_id);
    if (!current || isLaterAttempt(log, current)) latestLogByRow.set(log.row_id, log);
  }

  const mapped: SnavLogRow[] = rows.map((row) => {
    const log = latestLogByRow.get(row.id);
    const sendState = classifyRowState(row.status);

    const messageId = log?.provider_message_id ?? row.provider_message_id ?? null;
    const latestWa = messageId ? bestStatusByMsg.get(messageId) : undefined;

    const resolvedStatus =
      latestWa?.status ??
      (sendState === "sent" ? "sent" : sendState === "failed" ? "failed" : "pending");

    const statusGroup: KpiStatus = latestWa
      ? normalizeStatusGroup(latestWa.status)
      : sendState === "failed"
        ? "failed"
        : "pending";

    const happenedAt =
      latestWa?.timestamp ??
      latestWa?.created_at ??
      log?.attempted_at ??
      row.sent_at ??
      null;

    const operator = log?.operator_user_id ? operatorById.get(log.operator_user_id) : undefined;
    const errorMessage = log?.error_message ?? row.error_message ?? null;

    return {
      row_id: row.id,
      to_phone: row.phone_e164 ?? row.phone_raw,
      customer_name: row.customer_name,
      departure_date_label: row.departure_date_label,
      departure_date: row.departure_date,
      hotel: row.hotel,
      passengers: row.passengers,
      pickup_time: row.pickup_time,
      vessel_time: row.vessel_time,
      send_state: sendState,
      status: resolvedStatus,
      status_group: statusGroup,
      happened_at: happenedAt,
      template: log?.template_name ?? null,
      language_code: log?.language_code ?? null,
      params: paramsFromVariables(log?.variables_json),
      operator_name: operator?.full_name ?? operator?.email ?? null,
      attempt_number: log?.attempt_number ?? null,
      error_code: sendState === "failed" ? extractMetaErrorCode(errorMessage, log?.api_response_json) : null,
      error_message: sendState === "failed" ? errorMessage : null,
      error_raw: sendState === "failed" ? (log?.api_response_json ?? null) : null,
      file_name: fileNameByBatch.get(row.batch_id) ?? null,
      batch_label: labelByBatch.get(row.batch_id) ?? null,
    };
  });

  mapped.sort((a, b) => {
    const t = (a.vessel_time ?? "").localeCompare(b.vessel_time ?? "");
    return t !== 0 ? t : a.customer_name.localeCompare(b.customer_name);
  });

  const sent = mapped.filter((r) => r.send_state === "sent").length;
  const failed = mapped.filter((r) => r.send_state === "failed").length;
  const notSent = mapped.filter((r) => r.send_state === "not_sent").length;
  const delivered = mapped.filter((r) => r.status_group === "delivered").length;
  const read = mapped.filter((r) => r.status_group === "read").length;
  const pending = mapped.filter((r) => r.status_group === "pending").length;
  const total = mapped.length;
  const expected = rows.filter((r) => isExpectedConvocation(r)).length;

  const summary: SnavLogSummary = {
    total,
    expected,
    sent,
    failed,
    notSent,
    missing: Math.max(expected - sent, 0),
    delivered,
    read,
    pending,
    successRate: total > 0 ? Math.round((sent / total) * 100) : 0,
    readRate: sent > 0 ? Math.round((read / sent) * 100) : 0,
  };

  return {
    summary,
    rows: mapped,
    failedRows: mapped.filter((r) => r.send_state === "failed"),
    notSentRows: mapped.filter((r) => r.send_state === "not_sent"),
  };
}
