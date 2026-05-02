import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

const patchSchema = z.object({
  thread_id: z.string().uuid(),
  action: z.enum(["mark_read", "close", "reopen"])
});

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const tenantId = auth.membership.tenant_id;
  const url = new URL(request.url);
  const filter = url.searchParams.get("filter") ?? "open";
  const search = (url.searchParams.get("q") ?? "").trim();
  const selectedThreadId = url.searchParams.get("thread_id");

  let threadQuery = auth.admin
    .from("whatsapp_threads")
    .select("id, wa_id, phone_e164, customer_id, booking_id, transfer_id, last_message_at, last_message_preview, unread_count, assigned_to, status, match_status, match_suggestions, created_at, updated_at, whatsapp_contacts(profile_name)")
    .eq("tenant_id", tenantId)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(100);

  if (filter === "needs_review") threadQuery = threadQuery.eq("status", "needs_review");
  if (filter === "associated") threadQuery = threadQuery.not("booking_id", "is", null);
  if (filter === "unassociated") threadQuery = threadQuery.is("booking_id", null);
  if (filter === "closed") threadQuery = threadQuery.eq("status", "closed");
  if (filter === "open") threadQuery = threadQuery.neq("status", "closed");

  const { data: threads, error: threadError } = await threadQuery;
  if (threadError) return NextResponse.json({ error: threadError.message }, { status: 500 });

  const threadRows = (threads ?? []) as Array<Record<string, unknown>>;
  const bookingIds = Array.from(new Set(threadRows.map((row) => row.booking_id).filter(Boolean) as string[]));
  const { data: services } = bookingIds.length
    ? await auth.admin
      .from("services")
      .select("id, customer_name, phone, phone_e164, date, time, booking_service_kind, hotel_id, hotels(name)")
      .eq("tenant_id", tenantId)
      .in("id", bookingIds)
    : { data: [] };
  const serviceMap = new Map((services ?? []).map((service: Record<string, unknown>) => [String(service.id), service]));

  const enrichedThreads: Array<Record<string, unknown>> = threadRows
    .map((thread) => ({ ...thread, service: thread.booking_id ? serviceMap.get(String(thread.booking_id)) ?? null : null }))
    .filter((rawThread) => {
      const thread = rawThread as Record<string, unknown>;
      if (!search) return true;
      const haystack = [
        thread.wa_id,
        thread.phone_e164,
        (thread.whatsapp_contacts as { profile_name?: string } | null)?.profile_name,
        (thread.service as Record<string, unknown> | null)?.customer_name,
        (thread.service as Record<string, unknown> | null)?.phone,
        (thread.service as Record<string, unknown> | null)?.booking_service_kind,
        ((thread.service as Record<string, unknown> | null)?.hotels as { name?: string } | null)?.name,
        thread.last_message_preview
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(search.toLowerCase());
    });

  const selectedId = selectedThreadId ?? enrichedThreads[0]?.id;
  const { data: messages, error: messageError } = selectedId
    ? await auth.admin
      .from("whatsapp_messages")
      .select("id, wa_message_id, direction, wa_id, phone_e164, message_type, text_body, media_id, media_mime_type, status, timestamp, created_at, booking_id, transfer_id")
      .eq("tenant_id", tenantId)
      .eq("thread_id", selectedId)
      .order("timestamp", { ascending: true, nullsFirst: true })
      .limit(500)
    : { data: [], error: null };
  if (messageError) return NextResponse.json({ error: messageError.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    threads: enrichedThreads,
    selected_thread_id: selectedId ?? null,
    messages: messages ?? []
  });
}

export async function PATCH(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" }, { status: 400 });
  }

  const update =
    parsed.data.action === "mark_read"
      ? { unread_count: 0, updated_at: new Date().toISOString() }
      : parsed.data.action === "close"
        ? { status: "closed", unread_count: 0, updated_at: new Date().toISOString() }
        : { status: "open", updated_at: new Date().toISOString() };

  const { error } = await auth.admin
    .from("whatsapp_threads")
    .update(update)
    .eq("tenant_id", auth.membership.tenant_id)
    .eq("id", parsed.data.thread_id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
