import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { logWhatsAppEvent, normalizeE164, sendWhatsAppTextMessage } from "@/lib/server/whatsapp";

export const runtime = "nodejs";

const patchSchema = z.object({
  thread_id: z.string().uuid(),
  action: z.enum(["mark_read", "close", "reopen"])
});

const postSchema = z.object({
  thread_id: z.string().uuid(),
  text: z.string().trim().min(1, "Inserisci un messaggio").max(4096, "Messaggio troppo lungo")
});

function extractStatusFailureReason(rawStatus: unknown) {
  const payload = rawStatus as { errors?: Array<{ title?: string; message?: string; code?: number | string }> } | null;
  const error = payload?.errors?.[0];
  if (!error) return null;
  const parts = [error.title, error.message, error.code != null ? `code ${error.code}` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" - ") : "Invio non consegnato";
}

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
    .or(`tenant_id.eq.${tenantId},tenant_id.is.null`)
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
      .or(`tenant_id.eq.${tenantId},tenant_id.is.null`)
      .eq("thread_id", selectedId)
      .order("timestamp", { ascending: true, nullsFirst: true })
      .limit(500)
    : { data: [], error: null };
  if (messageError) return NextResponse.json({ error: messageError.message }, { status: 500 });

  const waMessageIds = Array.from(new Set((messages ?? []).map((message) => message.wa_message_id).filter(Boolean) as string[]));
  const { data: messageStatuses, error: statusError } = waMessageIds.length
    ? await auth.admin
      .from("whatsapp_message_statuses")
      .select("wa_message_id, status, created_at, raw_status")
      .eq("tenant_id", tenantId)
      .in("wa_message_id", waMessageIds)
      .order("created_at", { ascending: false })
    : { data: [], error: null };
  if (statusError) return NextResponse.json({ error: statusError.message }, { status: 500 });

  const latestStatusByMessageId = new Map<string, { status: string; failure_reason: string | null }>();
  for (const statusRow of messageStatuses ?? []) {
    if (!statusRow.wa_message_id || latestStatusByMessageId.has(statusRow.wa_message_id)) continue;
    latestStatusByMessageId.set(statusRow.wa_message_id, {
      status: statusRow.status,
      failure_reason: extractStatusFailureReason(statusRow.raw_status)
    });
  }

  const enrichedMessages = (messages ?? []).map((message) => {
    const latestStatus = message.wa_message_id ? latestStatusByMessageId.get(message.wa_message_id) : null;
    return {
      ...message,
      status: latestStatus?.status ?? message.status,
      failure_reason: latestStatus?.status === "failed" ? latestStatus.failure_reason : null
    };
  });

  return NextResponse.json({
    ok: true,
    threads: enrichedThreads,
    selected_thread_id: selectedId ?? null,
    messages: enrichedMessages
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
    .or(`tenant_id.eq.${auth.membership.tenant_id},tenant_id.is.null`)
    .eq("id", parsed.data.thread_id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" }, { status: 400 });
  }

  const tenantId = auth.membership.tenant_id;
  const nowIso = new Date().toISOString();
  const text = parsed.data.text.trim();

  const { data: thread, error: threadError } = await auth.admin
    .from("whatsapp_threads")
    .select("id, tenant_id, wa_id, phone_e164, contact_id, customer_id, booking_id, transfer_id, match_status")
    .or(`tenant_id.eq.${tenantId},tenant_id.is.null`)
    .eq("id", parsed.data.thread_id)
    .maybeSingle();

  if (threadError) return NextResponse.json({ error: threadError.message }, { status: 500 });
  if (!thread?.wa_id) {
    return NextResponse.json({ error: "Conversazione non trovata" }, { status: 404 });
  }

  const targetPhone = normalizeE164(thread.wa_id);
  const sendResult = await sendWhatsAppTextMessage({
    to: targetPhone,
    text
  });

  if (!sendResult.ok) {
    console.error("WhatsApp inbox reply failed", {
      hasWaId: Boolean(thread.wa_id),
      normalizedPhonePresent: Boolean(sendResult.phoneE164),
      error: sendResult.error ?? "unknown"
    });
    return NextResponse.json({ error: sendResult.error ?? "Invio WhatsApp non riuscito" }, { status: 502 });
  }

  const messagePayload = {
    tenant_id: thread.tenant_id ?? tenantId,
    wa_message_id: sendResult.messageId ?? null,
    direction: "outbound" as const,
    wa_id: thread.wa_id,
    phone_e164: sendResult.phoneE164,
    contact_id: thread.contact_id ?? null,
    thread_id: thread.id,
    customer_id: thread.customer_id ?? null,
    booking_id: thread.booking_id ?? null,
    transfer_id: thread.transfer_id ?? null,
    message_type: "text",
    text_body: text,
    media_id: null,
    media_mime_type: null,
    media_sha256: null,
    status: "sent",
    timestamp: nowIso,
    raw_message: {
      id: sendResult.messageId ?? null,
      type: "text",
      text: { body: text },
      source: "manual_reply"
    }
  };

  const { error: insertError } = await auth.admin.from("whatsapp_messages").insert(messagePayload);
  if (insertError) {
    console.error("WhatsApp inbox reply message persist failed", {
      hasWaId: Boolean(thread.wa_id),
      normalizedPhonePresent: Boolean(sendResult.phoneE164),
      error: insertError.message
    });
    return NextResponse.json({ error: "Messaggio inviato ma non salvato in archivio" }, { status: 500 });
  }

  const { error: updateError } = await auth.admin
    .from("whatsapp_threads")
    .update({
      phone_e164: sendResult.phoneE164,
      last_message_at: nowIso,
      last_message_preview: text.slice(0, 240),
      unread_count: 0,
      status: "open",
      match_status: thread.match_status === "matched" ? "matched" : "needs_review",
      updated_at: nowIso
    })
    .or(`tenant_id.eq.${tenantId},tenant_id.is.null`)
    .eq("id", thread.id);

  if (updateError) {
    console.error("WhatsApp inbox reply thread update failed", {
      hasWaId: Boolean(thread.wa_id),
      normalizedPhonePresent: Boolean(sendResult.phoneE164),
      error: updateError.message
    });
    return NextResponse.json({ error: "Messaggio inviato ma thread non aggiornato" }, { status: 500 });
  }

  await logWhatsAppEvent(auth.admin, {
    tenant_id: tenantId,
    service_id: thread.booking_id ?? null,
    to_phone: sendResult.phoneE164,
    kind: "manual",
    template: null,
    status: "sent",
    provider_message_id: sendResult.messageId ?? null,
    happened_at: nowIso,
    payload_json: {
      source: "api/ops/whatsapp-inbox",
      mode: "manual_reply",
      thread_id: thread.id
    }
  });

  console.info("WhatsApp inbox reply sent", {
    hasWaId: Boolean(thread.wa_id),
    normalizedPhonePresent: Boolean(sendResult.phoneE164),
    threadId: thread.id
  });

  return NextResponse.json({
    ok: true,
    message_id: sendResult.messageId ?? null,
    phone_e164: sendResult.phoneE164
  });
}
