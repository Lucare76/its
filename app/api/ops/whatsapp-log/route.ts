import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/server/whatsapp";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { normalizeStatusGroup, isNewerStatus, buildKpi, type KpiStatus } from "@/lib/server/whatsapp-log-shared";
import { resolveOperationalDate } from "@/lib/medmar-date";
import {
  filterMedmarRowsByDate,
  buildMedmarWhatsAppLog,
  type MedmarLogRowSource,
  type MedmarSendLogSource,
  type MedmarOperatorSource,
} from "@/lib/server/medmar-whatsapp-log";
import {
  filterSnavRowsByDate,
  buildSnavWhatsAppLog,
  type SnavLogRowSource,
  type SnavSendLogSource,
  type SnavOperatorSource,
} from "@/lib/server/snav-whatsapp-log";

export const runtime = "nodejs";

type LogRow = {
  service_id: string | null;
  to_phone: string;
  template: string | null;
  status: string;
  status_group: KpiStatus;
  happened_at: string;
  customer_name: string | null;
  arrival_date: string | null;
  booking_service_kind: string | null;
};

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor", "assistenza"]);
  if (auth instanceof NextResponse) return auth;
  const { membership } = auth;
  const tenantId = membership.tenant_id;

  let admin: ReturnType<typeof createAdminClient>;
  try { admin = createAdminClient(); } catch {
    return NextResponse.json({ error: "Server env missing" }, { status: 500 });
  }
  const url      = new URL(request.url);
  const filter   = url.searchParams.get("filter") ?? "info_3d";

  if (filter === "medmar_convocazione") {
    const resolved = resolveOperationalDate(url.searchParams.get("date"));
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });
    return handleMedmarConvocazione(admin, tenantId, resolved.date);
  }

  if (filter === "snav_convocazione") {
    const resolved = resolveOperationalDate(url.searchParams.get("date"));
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });
    return handleSnavConvocazione(admin, tenantId, resolved.date);
  }

  const days     = Math.min(Number(url.searchParams.get("days") ?? "30"), 90);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  if (filter === "bus_convocazione") {
    return handleBusConvocazione(admin, tenantId, since);
  }

  const { data: events, error } = await admin
    .from("whatsapp_events")
    .select("id, service_id, to_phone, template, status, happened_at, provider_message_id, payload_json")
    .eq("tenant_id", tenantId)
    .eq("kind", filter)
    .gte("happened_at", since)
    .order("happened_at", { ascending: false })
    .limit(2000);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const bestByService = new Map<string, typeof events[number]>();

  for (const ev of events ?? []) {
    if (!ev.service_id) continue;
    const existing = bestByService.get(ev.service_id);
    if (!existing || isNewerStatus(ev.status, ev.happened_at, existing.status, existing.happened_at)) {
      bestByService.set(ev.service_id, ev);
    }
  }

  const rows = [...bestByService.values()];

  const actionableIds = rows
    .map((r) => r.service_id!)
    .filter(Boolean);

  const { data: serviceNames } = actionableIds.length === 0 ? { data: [] } : await admin
    .from("services")
    .select("id, customer_name, date, booking_service_kind")
    .in("id", actionableIds);

  const serviceMap = new Map((serviceNames ?? []).map((s) => [s.id, s]));

  const enrichRow = (r: typeof rows[number]): LogRow => ({
    service_id:           r.service_id,
    to_phone:             r.to_phone,
    template:             r.template,
    status:               r.status,
    status_group:         normalizeStatusGroup(r.status),
    happened_at:          r.happened_at,
    customer_name:        serviceMap.get(r.service_id!)?.customer_name ?? null,
    arrival_date:         serviceMap.get(r.service_id!)?.date ?? null,
    booking_service_kind: serviceMap.get(r.service_id!)?.booking_service_kind ?? null,
  });

  const allRows = rows
    .map(enrichRow)
    .sort((a, b) => (a.arrival_date ?? "").localeCompare(b.arrival_date ?? ""));
  const notReadRows = allRows.filter((r) => r.status_group === "delivered" || r.status_group === "pending");
  const failedRows = allRows.filter((r) => r.status_group === "failed");

  const kpi = buildKpi(allRows);

  return NextResponse.json({
    ok: true,
    kpi,
    rows: allRows,
    notReadRows,
    failedRows,
  });
}

async function handleBusConvocazione(
  admin: ReturnType<typeof createAdminClient>,
  tenantId: string,
  since: string,
) {
  const { data: sendEvents, error } = await admin
    .from("whatsapp_events")
    .select("id, to_phone, template, status, happened_at, provider_message_id, payload_json")
    .eq("tenant_id", tenantId)
    .eq("kind", "bus_convocazione")
    .gte("happened_at", since)
    .order("happened_at", { ascending: false })
    .limit(2000);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!sendEvents || sendEvents.length === 0) {
    return NextResponse.json({
      ok: true,
      kpi: { total: 0, read: 0, delivered: 0, sent: 0, pending: 0, failed: 0, notRead: 0 },
      rows: [],
      notReadRows: [],
      failedRows: [],
    });
  }

  const messageIds = sendEvents
    .map((e) => e.provider_message_id)
    .filter((id): id is string => id != null && id.length > 0);

  type StatusRow = { wa_message_id: string; status: string; timestamp: string | null; created_at: string };
  let latestStatuses: StatusRow[] = [];
  if (messageIds.length > 0) {
    const chunks: string[][] = [];
    for (let i = 0; i < messageIds.length; i += 500) chunks.push(messageIds.slice(i, i + 500));
    for (const chunk of chunks) {
      const { data } = await admin
        .from("whatsapp_message_statuses")
        .select("wa_message_id, status, timestamp, created_at")
        .in("wa_message_id", chunk);
      if (data) latestStatuses = latestStatuses.concat(data as StatusRow[]);
    }
  }

  const bestStatusByMsg = new Map<string, StatusRow>();
  for (const s of latestStatuses) {
    const existing = bestStatusByMsg.get(s.wa_message_id);
    if (!existing || isNewerStatus(s.status, s.timestamp ?? s.created_at, existing.status, existing.timestamp ?? existing.created_at)) {
      bestStatusByMsg.set(s.wa_message_id, s);
    }
  }

  const bestByPhone = new Map<string, {
    to_phone: string;
    template: string | null;
    status: string;
    happened_at: string;
    provider_message_id: string | null;
    customer_name: string | null;
    date_line: string | null;
    departure_point: string | null;
  }>();

  for (const ev of sendEvents) {
    const resolvedStatus = ev.provider_message_id
      ? (bestStatusByMsg.get(ev.provider_message_id)?.status ?? ev.status)
      : ev.status;

    const payload = (ev.payload_json ?? {}) as Record<string, unknown>;
    const key = `${ev.to_phone}||${payload.date_line ?? ""}`;

    const existing = bestByPhone.get(key);
    if (!existing || isNewerStatus(resolvedStatus, ev.happened_at, existing.status, existing.happened_at)) {
      bestByPhone.set(key, {
        to_phone: ev.to_phone,
        template: ev.template,
        status: resolvedStatus,
        happened_at: ev.happened_at,
        provider_message_id: ev.provider_message_id,
        customer_name: (payload.customer_name as string) ?? null,
        date_line: (payload.date_line as string) ?? null,
        departure_point: (payload.departure_point as string) ?? null,
      });
    }
  }

  const rows = [...bestByPhone.values()];

  const enrichRow = (r: typeof rows[number]): LogRow => ({
    service_id:           null,
    to_phone:             r.to_phone,
    template:             r.template,
    status:               r.status,
    status_group:         normalizeStatusGroup(r.status),
    happened_at:          r.happened_at,
    customer_name:        r.customer_name,
    arrival_date:         r.date_line,
    booking_service_kind: "bus_convocazione",
  });

  const allRows = rows
    .map(enrichRow)
    .sort((a, b) => (a.happened_at ?? "").localeCompare(b.happened_at ?? ""));
  const notReadRows = allRows.filter((r) => r.status_group === "delivered" || r.status_group === "pending");
  const failedRows = allRows.filter((r) => r.status_group === "failed");

  const kpi = buildKpi(allRows);

  return NextResponse.json({
    ok: true,
    kpi,
    rows: allRows,
    notReadRows,
    failedRows,
  });
}

async function handleMedmarConvocazione(
  admin: ReturnType<typeof createAdminClient>,
  tenantId: string,
  dateIso: string,
) {
  // Day scope: exact match on the canonical travel_date_iso DATE column
  // (Europe/Rome operational departure day resolved in resolveOperationalDate).
  // No timestamp-range / string comparison — travel_date_iso is already the
  // stable "YYYY-MM-DD" value we filter on.
  const { data: convocationRows, error } = await admin
    .from("medmar_convocation_rows")
    .select("id, batch_id, customer_name, travel_date, travel_date_iso, route, departure_time, passengers, phone_raw, phone_e164, status, error_message, provider_message_id, sent_at")
    .eq("tenant_id", tenantId)
    .eq("travel_date_iso", dateIso)
    .limit(5000);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = filterMedmarRowsByDate((convocationRows ?? []) as MedmarLogRowSource[], dateIso);

  const emptySummary = { total: 0, sent: 0, failed: 0, notSent: 0, delivered: 0, read: 0, successRate: 0 };
  if (rows.length === 0) {
    return NextResponse.json({ ok: true, date: dateIso, summary: emptySummary, rows: [], failedRows: [], notSentRows: [] });
  }

  const batchIds = [...new Set(rows.map((r) => r.batch_id))];
  const rowIds = rows.map((r) => r.id);

  const { data: batches } = batchIds.length === 0 ? { data: [] } : await admin
    .from("medmar_convocation_batches")
    .select("id, file_name, label")
    .in("id", batchIds);

  // Per-attempt detail: template, params sent, operator, Meta error, attempt #.
  let sendLogs: MedmarSendLogSource[] = [];
  {
    const chunks: string[][] = [];
    for (let i = 0; i < rowIds.length; i += 500) chunks.push(rowIds.slice(i, i + 500));
    for (const chunk of chunks) {
      const { data } = await admin
        .from("medmar_convocation_send_logs")
        .select("id, row_id, operator_user_id, template_name, language_code, variables_json, status, provider_message_id, error_message, api_response_json, attempt_number, attempted_at")
        .eq("tenant_id", tenantId)
        .in("row_id", chunk);
      if (data) sendLogs = sendLogs.concat(data as MedmarSendLogSource[]);
    }
  }

  const operatorIds = [...new Set(sendLogs.map((l) => l.operator_user_id).filter((v): v is string => !!v))];
  const { data: operatorRows } = operatorIds.length === 0 ? { data: [] } : await admin
    .from("memberships")
    .select("user_id, full_name, email")
    .eq("tenant_id", tenantId)
    .in("user_id", operatorIds);

  const messageIds = [
    ...new Set(
      [...rows.map((r) => r.provider_message_id), ...sendLogs.map((l) => l.provider_message_id)]
        .filter((id): id is string => id != null && id.length > 0),
    ),
  ];

  type StatusRow = { wa_message_id: string; status: string; timestamp: string | null; created_at: string };
  let statuses: StatusRow[] = [];
  if (messageIds.length > 0) {
    const chunks: string[][] = [];
    for (let i = 0; i < messageIds.length; i += 500) chunks.push(messageIds.slice(i, i + 500));
    for (const chunk of chunks) {
      const { data } = await admin
        .from("whatsapp_message_statuses")
        .select("wa_message_id, status, timestamp, created_at")
        .in("wa_message_id", chunk);
      if (data) statuses = statuses.concat(data as StatusRow[]);
    }
  }

  const result = buildMedmarWhatsAppLog(
    rows,
    statuses,
    batches ?? [],
    sendLogs,
    (operatorRows ?? []) as MedmarOperatorSource[],
  );
  return NextResponse.json({ ok: true, date: dateIso, ...result });
}

async function handleSnavConvocazione(
  admin: ReturnType<typeof createAdminClient>,
  tenantId: string,
  dateIso: string,
) {
  // Day scope: exact match on the canonical departure_date DATE column
  // (Europe/Rome operational departure day). This is the SNAV departure day,
  // NOT the day the WhatsApp was sent — a message sent on 29/08 for a 30/08
  // departure shows up under 30/08.
  const { data: convocationRows, error } = await admin
    .from("snav_convocation_rows")
    .select("id, batch_id, inviare, customer_name, departure_date_label, departure_date, hotel, passengers, pickup_time, vessel_time, phone_raw, phone_e164, status, error_message, provider_message_id, sent_at")
    .eq("tenant_id", tenantId)
    .eq("departure_date", dateIso)
    .limit(5000);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = filterSnavRowsByDate((convocationRows ?? []) as SnavLogRowSource[], dateIso);

  const emptySummary = { total: 0, expected: 0, sent: 0, failed: 0, notSent: 0, missing: 0, delivered: 0, read: 0, pending: 0, successRate: 0, readRate: 0 };
  if (rows.length === 0) {
    return NextResponse.json({ ok: true, date: dateIso, summary: emptySummary, rows: [], failedRows: [], notSentRows: [] });
  }

  const batchIds = [...new Set(rows.map((r) => r.batch_id))];
  const rowIds = rows.map((r) => r.id);

  const { data: batches } = batchIds.length === 0 ? { data: [] } : await admin
    .from("snav_convocation_batches")
    .select("id, file_name, label")
    .in("id", batchIds);

  let sendLogs: SnavSendLogSource[] = [];
  {
    const chunks: string[][] = [];
    for (let i = 0; i < rowIds.length; i += 500) chunks.push(rowIds.slice(i, i + 500));
    for (const chunk of chunks) {
      const { data } = await admin
        .from("snav_convocation_send_logs")
        .select("id, row_id, operator_user_id, template_name, language_code, variables_json, status, provider_message_id, error_message, api_response_json, attempt_number, attempted_at")
        .eq("tenant_id", tenantId)
        .in("row_id", chunk);
      if (data) sendLogs = sendLogs.concat(data as SnavSendLogSource[]);
    }
  }

  const operatorIds = [...new Set(sendLogs.map((l) => l.operator_user_id).filter((v): v is string => !!v))];
  const { data: operatorRows } = operatorIds.length === 0 ? { data: [] } : await admin
    .from("memberships")
    .select("user_id, full_name, email")
    .eq("tenant_id", tenantId)
    .in("user_id", operatorIds);

  const messageIds = [
    ...new Set(
      [...rows.map((r) => r.provider_message_id), ...sendLogs.map((l) => l.provider_message_id)]
        .filter((id): id is string => id != null && id.length > 0),
    ),
  ];

  type StatusRow = { wa_message_id: string; status: string; timestamp: string | null; created_at: string };
  let statuses: StatusRow[] = [];
  if (messageIds.length > 0) {
    const chunks: string[][] = [];
    for (let i = 0; i < messageIds.length; i += 500) chunks.push(messageIds.slice(i, i + 500));
    for (const chunk of chunks) {
      const { data } = await admin
        .from("whatsapp_message_statuses")
        .select("wa_message_id, status, timestamp, created_at")
        .in("wa_message_id", chunk);
      if (data) statuses = statuses.concat(data as StatusRow[]);
    }
  }

  const result = buildSnavWhatsAppLog(
    rows,
    statuses,
    batches ?? [],
    sendLogs,
    (operatorRows ?? []) as SnavOperatorSource[],
  );
  return NextResponse.json({ ok: true, date: dateIso, ...result });
}
