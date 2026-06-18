import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/server/whatsapp";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

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

  const statusRank: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 0 };
  const bestByService = new Map<string, typeof events[number]>();

  for (const ev of events ?? []) {
    if (!ev.service_id) continue;
    const existing = bestByService.get(ev.service_id);
    const rank     = statusRank[ev.status] ?? 0;
    const existingRank = existing ? (statusRank[existing.status] ?? 0) : -1;
    if (rank > existingRank) bestByService.set(ev.service_id, ev);
  }

  const rows = [...bestByService.values()];

  const total     = rows.length;
  const read      = rows.filter((r) => r.status === "read").length;
  const delivered = rows.filter((r) => r.status === "delivered").length;
  const sent      = rows.filter((r) => r.status === "sent").length;
  const failed    = rows.filter((r) => r.status === "failed").length;
  const notRead   = rows.filter((r) => r.status === "sent" || r.status === "delivered").length;

  const actionableIds = rows
    .filter((r) => r.status === "sent" || r.status === "delivered" || r.status === "failed")
    .map((r) => r.service_id!)
    .filter(Boolean);

  const { data: serviceNames } = actionableIds.length === 0 ? { data: [] } : await admin
    .from("services")
    .select("id, customer_name, date, booking_service_kind")
    .in("id", actionableIds);

  const serviceMap = new Map((serviceNames ?? []).map((s) => [s.id, s]));

  const enrichRow = (r: typeof rows[number]) => ({
    service_id:           r.service_id,
    to_phone:             r.to_phone,
    template:             r.template,
    status:               r.status,
    happened_at:          r.happened_at,
    customer_name:        serviceMap.get(r.service_id!)?.customer_name ?? null,
    arrival_date:         serviceMap.get(r.service_id!)?.date ?? null,
    booking_service_kind: serviceMap.get(r.service_id!)?.booking_service_kind ?? null,
  });

  const notReadRows = rows
    .filter((r) => r.status === "sent" || r.status === "delivered")
    .map(enrichRow)
    .sort((a, b) => (a.arrival_date ?? "").localeCompare(b.arrival_date ?? ""));

  const failedRows = rows
    .filter((r) => r.status === "failed")
    .map(enrichRow)
    .sort((a, b) => (a.arrival_date ?? "").localeCompare(b.arrival_date ?? ""));

  return NextResponse.json({
    ok: true,
    kpi: { total, read, delivered, sent, failed, notRead },
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
    .neq("status", "failed")
    .gte("happened_at", since)
    .order("happened_at", { ascending: false })
    .limit(2000);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!sendEvents || sendEvents.length === 0) {
    return NextResponse.json({
      ok: true,
      kpi: { total: 0, read: 0, delivered: 0, sent: 0, failed: 0, notRead: 0 },
      notReadRows: [],
      failedRows: [],
    });
  }

  const messageIds = sendEvents
    .map((e) => e.provider_message_id)
    .filter((id): id is string => id != null && id.length > 0);

  type StatusRow = { wa_message_id: string; status: string };
  let latestStatuses: StatusRow[] = [];
  if (messageIds.length > 0) {
    const chunks: string[][] = [];
    for (let i = 0; i < messageIds.length; i += 500) chunks.push(messageIds.slice(i, i + 500));
    for (const chunk of chunks) {
      const { data } = await admin
        .from("whatsapp_message_statuses")
        .select("wa_message_id, status")
        .in("wa_message_id", chunk);
      if (data) latestStatuses = latestStatuses.concat(data as StatusRow[]);
    }
  }

  const statusRank: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 0 };
  const bestStatusByMsg = new Map<string, string>();
  for (const s of latestStatuses) {
    const existing = bestStatusByMsg.get(s.wa_message_id);
    const rank = statusRank[s.status] ?? 0;
    const existingRank = existing ? (statusRank[existing] ?? 0) : -1;
    if (rank > existingRank) bestStatusByMsg.set(s.wa_message_id, s.status);
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
      ? (bestStatusByMsg.get(ev.provider_message_id) ?? ev.status)
      : ev.status;

    const payload = (ev.payload_json ?? {}) as Record<string, unknown>;
    const key = `${ev.to_phone}||${payload.date_line ?? ""}`;

    const existing = bestByPhone.get(key);
    const rank = statusRank[resolvedStatus] ?? 0;
    const existingRank = existing ? (statusRank[existing.status] ?? 0) : -1;

    if (rank > existingRank) {
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

  const total     = rows.length;
  const read      = rows.filter((r) => r.status === "read").length;
  const delivered = rows.filter((r) => r.status === "delivered").length;
  const sent      = rows.filter((r) => r.status === "sent").length;
  const failed    = rows.filter((r) => r.status === "failed").length;
  const notRead   = rows.filter((r) => r.status === "sent" || r.status === "delivered").length;

  const enrichRow = (r: typeof rows[number]) => ({
    service_id:           null,
    to_phone:             r.to_phone,
    template:             r.template,
    status:               r.status,
    happened_at:          r.happened_at,
    customer_name:        r.customer_name,
    arrival_date:         r.date_line,
    booking_service_kind: "bus_convocazione",
  });

  const notReadRows = rows
    .filter((r) => r.status === "sent" || r.status === "delivered")
    .map(enrichRow)
    .sort((a, b) => (a.happened_at ?? "").localeCompare(b.happened_at ?? ""));

  const failedRows = rows
    .filter((r) => r.status === "failed")
    .map(enrichRow)
    .sort((a, b) => (a.happened_at ?? "").localeCompare(b.happened_at ?? ""));

  return NextResponse.json({
    ok: true,
    kpi: { total, read, delivered, sent, failed, notRead },
    notReadRows,
    failedRows,
  });
}
