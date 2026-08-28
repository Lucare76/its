import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/server/whatsapp";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { normalizeStatusGroup, isNewerStatus, buildKpi, type KpiStatus } from "@/lib/server/whatsapp-log-shared";
import { resolveOperationalDate } from "@/lib/medmar-date";
import { filterMedmarRowsByDate, buildMedmarWhatsAppLog, type MedmarLogRowSource } from "@/lib/server/medmar-whatsapp-log";

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
  const { data: convocationRows, error } = await admin
    .from("medmar_convocation_rows")
    .select("id, batch_id, customer_name, travel_date, travel_date_iso, route, departure_time, passengers, phone_raw, phone_e164, status, error_message, provider_message_id, sent_at")
    .eq("tenant_id", tenantId)
    .eq("travel_date_iso", dateIso)
    .in("status", ["inviato", "errore"])
    .limit(5000);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = filterMedmarRowsByDate((convocationRows ?? []) as MedmarLogRowSource[], dateIso);

  if (rows.length === 0) {
    return NextResponse.json({
      ok: true,
      kpi: { total: 0, read: 0, delivered: 0, sent: 0, pending: 0, failed: 0, notRead: 0 },
      rows: [],
      notReadRows: [],
      failedRows: [],
    });
  }

  const batchIds = [...new Set(rows.map((r) => r.batch_id))];
  const { data: batches } = batchIds.length === 0 ? { data: [] } : await admin
    .from("medmar_convocation_batches")
    .select("id, file_name")
    .in("id", batchIds);

  const messageIds = rows
    .map((r) => r.provider_message_id)
    .filter((id): id is string => id != null && id.length > 0);

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

  const result = buildMedmarWhatsAppLog(rows, statuses, batches ?? []);
  return NextResponse.json({ ok: true, ...result });
}
