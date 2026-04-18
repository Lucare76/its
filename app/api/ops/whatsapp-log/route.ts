import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/server/whatsapp";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { membership, admin: authAdmin } = auth as any;
  const tenantId = membership.tenant_id as string;
  void authAdmin; // usa admin client con service role per query cross-tenant

  let admin: ReturnType<typeof createAdminClient>;
  try { admin = createAdminClient(); } catch {
    return NextResponse.json({ error: "Server env missing" }, { status: 500 });
  }
  const url      = new URL(request.url);
  const filter   = url.searchParams.get("filter") ?? "info_3d"; // default: solo "Prima di partire"
  const days     = Math.min(Number(url.searchParams.get("days") ?? "30"), 90);

  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  // Carica eventi info_3d degli ultimi N giorni
  const { data: events, error } = await admin
    .from("whatsapp_events")
    .select("id, service_id, to_phone, template, status, happened_at, provider_message_id, payload_json")
    .eq("tenant_id", tenantId)
    .eq("kind", filter)
    .gte("happened_at", since)
    .order("happened_at", { ascending: false })
    .limit(2000);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Per ogni service_id prendi solo il record con status più avanzato
  // (sent < delivered < read, failed separato)
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

  // KPI
  const total     = rows.length;
  const read      = rows.filter((r) => r.status === "read").length;
  const delivered = rows.filter((r) => r.status === "delivered").length;
  const sent      = rows.filter((r) => r.status === "sent").length;
  const failed    = rows.filter((r) => r.status === "failed").length;
  const notRead   = rows.filter((r) => r.status === "sent" || r.status === "delivered").length;

  // Arricchisce i "non letti" con il nome cliente
  const notReadIds = rows
    .filter((r) => r.status === "sent" || r.status === "delivered")
    .map((r) => r.service_id!)
    .filter(Boolean);

  const { data: serviceNames } = notReadIds.length === 0 ? { data: [] } : await admin
    .from("services")
    .select("id, customer_name, date, booking_service_kind")
    .in("id", notReadIds);

  const serviceMap = new Map((serviceNames ?? []).map((s) => [s.id, s]));

  const notReadRows = rows
    .filter((r) => r.status === "sent" || r.status === "delivered")
    .map((r) => ({
      service_id:          r.service_id,
      to_phone:            r.to_phone,
      template:            r.template,
      status:              r.status,
      happened_at:         r.happened_at,
      customer_name:       serviceMap.get(r.service_id!)?.customer_name ?? null,
      arrival_date:        serviceMap.get(r.service_id!)?.date ?? null,
      booking_service_kind: serviceMap.get(r.service_id!)?.booking_service_kind ?? null,
    }))
    .sort((a, b) => (a.arrival_date ?? "").localeCompare(b.arrival_date ?? ""));

  return NextResponse.json({
    ok: true,
    kpi: { total, read, delivered, sent, failed, notRead },
    notReadRows,
  });
}
