import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

type ThreadSummaryRow = {
  id: string;
  phone_e164: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count: number | null;
  whatsapp_contacts:
    | { manual_contact_name?: string | null; customer_full_name?: string | null; profile_name?: string | null; wa_profile_name?: string | null }
    | { manual_contact_name?: string | null; customer_full_name?: string | null; profile_name?: string | null; wa_profile_name?: string | null }[]
    | null;
};

function contactName(contact: ThreadSummaryRow["whatsapp_contacts"]) {
  const row = Array.isArray(contact) ? contact[0] : contact;
  return cleanName(row?.manual_contact_name) || cleanName(row?.customer_full_name) || cleanName(row?.wa_profile_name) || cleanName(row?.profile_name);
}

function cleanName(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return null;
  return trimmed;
}

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor", "assistenza"]);
  if (auth instanceof NextResponse) return auth;

  const tenantId = auth.membership.tenant_id;
  const tenantScope = `tenant_id.eq.${tenantId},tenant_id.is.null`;

  // Il badge globale ha bisogno solo del numero di thread non letti e dell'ultimo
  // messaggio: una count "head" mirata + una singola riga LIMIT 1 costano molto
  // meno del precedente fetch di fino a 50 righe complete (con join) ad ogni poll,
  // ed evitano anche il bug per cui il badge si fermava a 50 anche con più unread.
  const [
    { count: unreadCountRaw, error: unreadCountError },
    { count: openCountRaw, error: openCountError },
    { count: associatedCountRaw, error: associatedCountError },
    { count: unassociatedCountRaw, error: unassociatedCountError },
    { count: urgentCountRaw, error: urgentCountError },
    { data: latestRows, error: latestError }
  ] = await Promise.all([
    auth.admin
      .from("whatsapp_threads")
      .select("id", { count: "exact", head: true })
      .or(tenantScope)
      .neq("status", "closed")
      .gt("unread_count", 0),
    auth.admin
      .from("whatsapp_threads")
      .select("id", { count: "exact", head: true })
      .or(tenantScope)
      .neq("status", "closed"),
    auth.admin
      .from("whatsapp_threads")
      .select("id", { count: "exact", head: true })
      .or(tenantScope)
      .neq("status", "closed")
      .eq("match_status", "matched"),
    auth.admin
      .from("whatsapp_threads")
      .select("id", { count: "exact", head: true })
      .or(tenantScope)
      .neq("status", "closed")
      .neq("match_status", "matched"),
    auth.admin
      .from("whatsapp_threads")
      .select("id", { count: "exact", head: true })
      .or(tenantScope)
      .neq("status", "closed")
      .or("unread_count.gt.0,status.eq.needs_review,match_status.eq.needs_review"),
    auth.admin
      .from("whatsapp_threads")
      .select("id, phone_e164, last_message_at, last_message_preview, unread_count, whatsapp_contacts(manual_contact_name,customer_full_name,profile_name,wa_profile_name)")
      .or(tenantScope)
      .neq("status", "closed")
      .gt("unread_count", 0)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(1)
  ]);

  const summaryError = unreadCountError ?? openCountError ?? associatedCountError ?? unassociatedCountError ?? urgentCountError;
  if (summaryError) {
    return NextResponse.json({ ok: false, error: summaryError.message }, { status: 500 });
  }
  if (latestError) {
    return NextResponse.json({ ok: false, error: latestError.message }, { status: 500 });
  }

  const unreadCount = unreadCountRaw ?? 0;
  const latest = ((latestRows ?? []) as ThreadSummaryRow[])[0] ?? null;
  const latestSender = latest ? contactName(latest.whatsapp_contacts) ?? latest.phone_e164 ?? "cliente" : null;

  return NextResponse.json({
    ok: true,
    unread_count: unreadCount,
    open_count: openCountRaw ?? 0,
    associated_count: associatedCountRaw ?? 0,
    unassociated_count: unassociatedCountRaw ?? 0,
    urgent_count: urgentCountRaw ?? 0,
    latest_thread_id: latest?.id ?? null,
    latest_message_at: latest?.last_message_at ?? null,
    latest_preview: latest?.last_message_preview ?? null,
    latest_sender: latestSender
  });
}
