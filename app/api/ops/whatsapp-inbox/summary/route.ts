import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

type ThreadSummaryRow = {
  id: string;
  phone_e164: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count: number | null;
  whatsapp_contacts: { profile_name?: string | null } | { profile_name?: string | null }[] | null;
};

function contactName(contact: ThreadSummaryRow["whatsapp_contacts"]) {
  const row = Array.isArray(contact) ? contact[0] : contact;
  return row?.profile_name?.trim() || null;
}

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor", "assistenza"]);
  if (auth instanceof NextResponse) return auth;

  const tenantId = auth.membership.tenant_id;
  const { data, error } = await auth.admin
    .from("whatsapp_threads")
    .select("id, phone_e164, last_message_at, last_message_preview, unread_count, whatsapp_contacts(profile_name)")
    .or(`tenant_id.eq.${tenantId},tenant_id.is.null`)
    .neq("status", "closed")
    .gt("unread_count", 0)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = ((data ?? []) as ThreadSummaryRow[]);
  const unreadCount = rows.reduce((sum, row) => sum + Number(row.unread_count ?? 0), 0);
  const latest = rows[0] ?? null;
  const latestSender = latest ? contactName(latest.whatsapp_contacts) ?? latest.phone_e164 ?? "cliente" : null;

  return NextResponse.json({
    ok: true,
    unread_count: unreadCount,
    latest_thread_id: latest?.id ?? null,
    latest_message_at: latest?.last_message_at ?? null,
    latest_preview: latest?.last_message_preview ?? null,
    latest_sender: latestSender
  });
}
