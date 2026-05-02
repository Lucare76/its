import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164, logWhatsAppEvent, mapWebhookStatus } from "@/lib/server/whatsapp";
import { matchWhatsAppInboundMessage } from "./matching";
import type { MetaChangeValue, MetaContact, MetaMessage, MetaStatus, MetaWebhookPayload } from "./types";

type ProcessResult = {
  messages: number;
  statuses: number;
  contacts: number;
  errors: string[];
};

function unixToIso(timestamp: string | undefined) {
  const ms = Number(timestamp) * 1000;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date().toISOString();
}

function messageText(message: MetaMessage) {
  if (message.type === "text") return message.text?.body ?? null;
  if (message.type === "button") return message.button?.text ?? message.button?.payload ?? null;
  const media = message.image ?? message.document ?? message.video;
  return media?.caption ?? null;
}

function mediaMeta(message: MetaMessage) {
  const media = message.image ?? message.document ?? message.audio ?? message.video;
  return {
    media_id: media?.id ?? null,
    media_mime_type: media?.mime_type ?? null,
    media_sha256: media?.sha256 ?? null
  };
}

function previewForMessage(message: MetaMessage) {
  const text = messageText(message);
  if (text) return text.slice(0, 240);
  return `[${message.type ?? "messaggio"}]`;
}

function firstEventType(value: MetaChangeValue) {
  if (value.messages?.length) return "message";
  if (value.statuses?.length) return "status";
  return "unknown";
}

export function extractWebhookDedupeKey(payload: MetaWebhookPayload) {
  const ids: string[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        if (message.id) ids.push(`message:${message.id}`);
      }
      for (const status of change.value?.statuses ?? []) {
        if (status.id && status.status) ids.push(`status:${status.id}:${status.status}:${status.timestamp ?? ""}`);
      }
    }
  }
  return ids[0] ?? null;
}

export function extractWebhookEventType(payload: MetaWebhookPayload) {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.value) return firstEventType(change.value);
    }
  }
  return "unknown";
}

async function upsertContact(
  admin: SupabaseClient,
  input: { tenantId: string; contact: MetaContact | undefined; waId: string; phoneE164: string | null }
) {
  const profileName = input.contact?.profile?.name ?? null;
  const { data, error } = await admin
    .from("whatsapp_contacts")
    .upsert({
      tenant_id: input.tenantId,
      wa_id: input.waId,
      phone_e164: input.phoneE164,
      profile_name: profileName,
      updated_at: new Date().toISOString()
    }, { onConflict: "tenant_id,wa_id" })
    .select("id")
    .single();
  if (error) throw error;
  return data as { id: string };
}

async function upsertThread(
  admin: SupabaseClient,
  input: {
    tenantId: string;
    waId: string;
    phoneE164: string | null;
    contactId: string | null;
    bookingId: string | null;
    transferId: string | null;
    customerId: string | null;
    matchStatus: string;
    matchSuggestions: unknown[];
    lastMessageAt: string;
    preview: string;
  }
) {
  const status = input.matchStatus === "matched" ? "open" : "needs_review";
  const { data: existing } = await admin
    .from("whatsapp_threads")
    .select("id, unread_count")
    .eq("tenant_id", input.tenantId)
    .eq("wa_id", input.waId)
    .maybeSingle();

  const row = {
    tenant_id: input.tenantId,
    wa_id: input.waId,
    phone_e164: input.phoneE164,
    contact_id: input.contactId,
    customer_id: input.customerId,
    booking_id: input.bookingId,
    transfer_id: input.transferId,
    last_message_at: input.lastMessageAt,
    last_message_preview: input.preview,
    unread_count: Number(existing?.unread_count ?? 0) + 1,
    status: existing ? undefined : status,
    match_status: input.matchStatus,
    match_suggestions: input.matchSuggestions,
    updated_at: new Date().toISOString()
  };

  const { data, error } = await admin
    .from("whatsapp_threads")
    .upsert(row, { onConflict: "tenant_id,wa_id" })
    .select("id")
    .single();
  if (error) throw error;
  return data as { id: string };
}

async function processMessage(admin: SupabaseClient, value: MetaChangeValue, message: MetaMessage) {
  if (!message.id || !message.from) return;
  const contact = value.contacts?.find((item) => item.wa_id === message.from) ?? value.contacts?.[0];
  const phoneE164 = normalizeE164(message.from);
  const textBody = messageText(message);
  const match = await matchWhatsAppInboundMessage(admin, {
    waId: message.from,
    phoneE164,
    textBody,
    timestamp: message.timestamp
  });
  if (!match.tenantId) {
    throw new Error("Unable to resolve tenant for inbound WhatsApp message");
  }

  const contactRow = await upsertContact(admin, { tenantId: match.tenantId, contact, waId: message.from, phoneE164 });
  const timestamp = unixToIso(message.timestamp);
  const thread = await upsertThread(admin, {
    tenantId: match.tenantId,
    waId: message.from,
    phoneE164,
    contactId: contactRow.id,
    bookingId: match.bookingId,
    transferId: match.transferId,
    customerId: match.customerId,
    matchStatus: match.status,
    matchSuggestions: match.suggestions,
    lastMessageAt: timestamp,
    preview: previewForMessage(message)
  });

  const { error } = await admin.from("whatsapp_messages").upsert({
    tenant_id: match.tenantId,
    wa_message_id: message.id,
    direction: "inbound",
    wa_id: message.from,
    phone_e164: phoneE164,
    contact_id: contactRow.id,
    thread_id: thread.id,
    customer_id: match.customerId,
    booking_id: match.bookingId,
    transfer_id: match.transferId,
    message_type: message.type ?? null,
    text_body: textBody,
    ...mediaMeta(message),
    status: "received",
    timestamp,
    raw_message: message
  }, { onConflict: "tenant_id,wa_message_id", ignoreDuplicates: true });
  if (error) throw error;
}

async function resolveStatusTenant(admin: SupabaseClient, status: MetaStatus) {
  const { data: sentMessage } = status.id
    ? await admin.from("services").select("id, tenant_id").eq("message_id", status.id).maybeSingle()
    : { data: null };
  if (sentMessage?.tenant_id) return { tenantId: String(sentMessage.tenant_id), serviceId: String(sentMessage.id) };

  const { data: storedMessage } = status.id
    ? await admin.from("whatsapp_messages").select("tenant_id, booking_id").eq("wa_message_id", status.id).maybeSingle()
    : { data: null };
  if (storedMessage?.tenant_id) return { tenantId: String(storedMessage.tenant_id), serviceId: storedMessage.booking_id ? String(storedMessage.booking_id) : null };

  const { data: tenants } = await admin.from("tenants").select("id").limit(2);
  return tenants?.length === 1 ? { tenantId: String(tenants[0].id), serviceId: null } : { tenantId: null, serviceId: null };
}

async function processStatus(admin: SupabaseClient, status: MetaStatus) {
  if (!status.id || !status.status) return;
  const resolved = await resolveStatusTenant(admin, status);
  if (!resolved.tenantId) throw new Error("Unable to resolve tenant for WhatsApp status");
  const timestamp = unixToIso(status.timestamp);

  await admin.from("whatsapp_message_statuses").upsert({
    tenant_id: resolved.tenantId,
    wa_message_id: status.id,
    status: status.status,
    recipient_id: status.recipient_id ?? null,
    conversation_id: status.conversation?.id ?? null,
    pricing_category: status.pricing?.category ?? null,
    timestamp,
    raw_status: status
  }, { onConflict: "tenant_id,wa_message_id,status,timestamp", ignoreDuplicates: true });

  const mappedStatus = mapWebhookStatus(status.status);
  if (mappedStatus) {
    const patch: { reminder_status: string; sent_at?: string } = { reminder_status: mappedStatus };
    if (mappedStatus === "sent") patch.sent_at = timestamp;
    let updateQuery = admin.from("services").update(patch).eq("message_id", status.id);
    if (resolved.tenantId) updateQuery = updateQuery.eq("tenant_id", resolved.tenantId);
    await updateQuery;

    await logWhatsAppEvent(admin, {
      tenant_id: resolved.tenantId,
      service_id: resolved.serviceId,
      to_phone: status.recipient_id ?? "unknown",
      kind: "webhook",
      template: process.env.WHATSAPP_TEMPLATE_NAME ?? null,
      status: mappedStatus,
      provider_message_id: status.id,
      happened_at: timestamp,
      payload_json: {
        source: "api/whatsapp/webhook",
        raw_status: status.status,
        errors: status.errors ?? []
      }
    });
  }
}

export async function processWhatsAppWebhook(admin: SupabaseClient, payload: MetaWebhookPayload, webhookEventId?: string): Promise<ProcessResult> {
  const result: ProcessResult = { messages: 0, statuses: 0, contacts: 0, errors: [] };

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;
      for (const message of value.messages ?? []) {
        try {
          await processMessage(admin, value, message);
          result.messages += 1;
        } catch (error) {
          result.errors.push(error instanceof Error ? error.message : "message processing failed");
        }
      }
      for (const status of value.statuses ?? []) {
        try {
          await processStatus(admin, status);
          result.statuses += 1;
        } catch (error) {
          result.errors.push(error instanceof Error ? error.message : "status processing failed");
        }
      }
      result.contacts += value.contacts?.length ?? 0;
    }
  }

  if (webhookEventId) {
    await admin
      .from("whatsapp_webhook_events")
      .update({
        processed_at: new Date().toISOString(),
        processing_error: result.errors.length ? result.errors.join("\n").slice(0, 2000) : null
      })
      .eq("id", webhookEventId);
  }

  return result;
}

