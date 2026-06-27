import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/server/whatsapp";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

type KpiStatus = "read" | "delivered" | "pending" | "failed";

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

const statusPriority: Record<string, number> = {
  failed: 4,
  error: 4,
  read: 3,
  delivered: 2,
  sent: 1,
  queued: 1,
  pending: 1,
};

function normalizeStatusGroup(status?: string | null): KpiStatus {
  const value = String(status ?? "").toLowerCase();
  if (value === "read") return "read";
  if (value === "delivered") return "delivered";
  if (value === "failed" || value === "error") return "failed";
  return "pending";
}

function buildKpi(rows: Array<{ status_group: KpiStatus }>) {
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

function isNewerStatus(
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
