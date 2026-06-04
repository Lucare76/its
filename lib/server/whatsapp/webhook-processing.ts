import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeWhatsAppWaId, logWhatsAppEvent, mapWebhookStatus } from "@/lib/server/whatsapp";
import { sendPushToTenantRoles } from "@/lib/server/web-push";
import { matchWhatsAppInboundMessage } from "./matching";
import { persistOutboundWhatsAppMessage } from "./messages";
import type { MetaChangeValue, MetaContact, MetaMessage, MetaStatus, MetaWebhookPayload, WhatsAppMatchResult } from "./types";

type ProcessResult = {
  messages: number;
  statuses: number;
  contacts: number;
  errors: string[];
  tenantsResolved: number;
};

function unixToIso(timestamp: string | undefined) {
  const ms = Number(timestamp) * 1000;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date().toISOString();
}

function messageText(message: MetaMessage) {
  if (message.type === "text") return message.text?.body ?? null;
  if (message.type === "reaction") return message.reaction?.emoji ?? null;
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

function replyContextId(message: MetaMessage) {
  if (message.type === "reaction" &&
      typeof message.reaction?.message_id === "string" &&
      message.reaction.message_id.trim())
    return message.reaction.message_id.trim();
  return typeof message.context?.id === "string" && message.context.id.trim()
    ? message.context.id.trim()
    : null;
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
  input: { tenantId: string | null; contact: MetaContact | undefined; waId: string; phoneE164: string | null }
) {
  const waProfileName = input.contact?.profile?.name?.trim() || null;
  const payload = {
    tenant_id: input.tenantId,
    wa_id: input.waId,
    phone_e164: input.phoneE164,
    wa_profile_name: waProfileName,
    updated_at: new Date().toISOString()
  };
  if (input.tenantId) {
    const { data, error } = await admin
      .from("whatsapp_contacts")
      .upsert(payload, { onConflict: "tenant_id,wa_id" })
      .select("id")
      .single();
    if (error) throw error;
    return data as { id: string };
  }

  const { data: existing, error: existingError } = await admin
    .from("whatsapp_contacts")
    .select("id")
    .is("tenant_id", null)
    .eq("wa_id", input.waId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing?.id) {
    const { data, error } = await admin
      .from("whatsapp_contacts")
      .update(payload)
      .eq("id", existing.id)
      .select("id")
      .single();
    if (error) throw error;
    return data as { id: string };
  }
  const { data, error } = await admin
    .from("whatsapp_contacts")
    .insert({
      ...payload,
      created_at: new Date().toISOString()
    })
    .select("id")
    .single();
  if (error) throw error;
  return data as { id: string };
}

async function upsertThread(
  admin: SupabaseClient,
  input: {
    tenantId: string | null;
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
  const existingQuery = admin
    .from("whatsapp_threads")
    .select("id, unread_count");

  const { data: existing, error: existingError } = input.tenantId
    ? await existingQuery.eq("tenant_id", input.tenantId).eq("wa_id", input.waId).maybeSingle()
    : await existingQuery.is("tenant_id", null).eq("wa_id", input.waId).maybeSingle();
  if (existingError) throw existingError;

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

  if (input.tenantId) {
    const { data, error } = await admin
      .from("whatsapp_threads")
      .upsert(row, { onConflict: "tenant_id,wa_id" })
      .select("id")
      .single();
    if (error) throw error;
    return data as { id: string };
  }

  if (existing?.id) {
    const { data, error } = await admin
      .from("whatsapp_threads")
      .update(row)
      .eq("id", existing.id)
      .select("id")
      .single();
    if (error) throw error;
    return data as { id: string };
  }

  const { data, error } = await admin
    .from("whatsapp_threads")
    .insert({
      ...row,
      created_at: new Date().toISOString()
    })
    .select("id")
    .single();
  if (error) throw error;
  return data as { id: string };
}

async function lookupReplyTarget(admin: SupabaseClient, replyToWaMessageId: string) {
  const { data, error } = await admin
    .from("whatsapp_messages")
    .select("id, tenant_id, thread_id, customer_id, booking_id, transfer_id, contact_id, wa_id, phone_e164, message_type, text_body, template_name")
    .eq("wa_message_id", replyToWaMessageId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as {
    id: string;
    tenant_id: string | null;
    thread_id: string | null;
    customer_id: string | null;
    booking_id: string | null;
    transfer_id: string | null;
    contact_id: string | null;
    wa_id: string | null;
    phone_e164: string | null;
    message_type: string | null;
    text_body: string | null;
    template_name: string | null;
  } | null;
}

async function persistReplyTargetFromLegacyEvent(
  admin: SupabaseClient,
  replyToWaMessageId: string,
  fallbackPhoneE164: string | null,
) {
  const { data: event, error } = await admin
    .from("whatsapp_events")
    .select("tenant_id, service_id, to_phone, template, kind, happened_at, payload_json")
    .eq("provider_message_id", replyToWaMessageId)
    .order("happened_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn("WhatsApp inbound legacy event lookup failed", {
      replyToWaMessageId,
      message: error.message
    });
    return null;
  }
  if (!event?.tenant_id) return null;

  const result = await persistOutboundWhatsAppMessage(admin, {
    tenantId: String(event.tenant_id),
    toPhone: String(fallbackPhoneE164 ?? event.to_phone ?? ""),
    waMessageId: replyToWaMessageId,
    messageType: "template",
    templateName: typeof event.template === "string" ? event.template : null,
    textBody: typeof event.template === "string" ? `Template ${event.template}` : "Template WhatsApp",
    status: "sent",
    timestamp: typeof event.happened_at === "string" ? event.happened_at : null,
    serviceId: typeof event.service_id === "string" ? event.service_id : null,
    rawMessage: {
      id: replyToWaMessageId,
      source: "legacy_whatsapp_event",
      kind: event.kind ?? null,
      payload_json: event.payload_json ?? {}
    }
  });

  console.info("WhatsApp outbound template recovered from event", {
    replyToWaMessageId,
    recovered: result.ok,
    threadId: result.ok ? result.threadId : null,
    reason: result.ok ? null : result.reason
  });

  return result.ok ? lookupReplyTarget(admin, replyToWaMessageId) : null;
}

async function findReplyTarget(admin: SupabaseClient, replyToWaMessageId: string | null, fallbackPhoneE164: string | null) {
  if (!replyToWaMessageId) return null;
  try {
    const stored = await lookupReplyTarget(admin, replyToWaMessageId);
    if (stored) return stored;
    return await persistReplyTargetFromLegacyEvent(admin, replyToWaMessageId, fallbackPhoneE164);
  } catch (error) {
    console.warn("WhatsApp inbound reply target lookup failed", {
      replyToWaMessageId,
      message: error instanceof Error ? error.message : "lookup failed"
    });
    return null;
  }
}

async function processMessage(admin: SupabaseClient, value: MetaChangeValue, message: MetaMessage) {
  if (!message.id || !message.from) return null;
  const contact = value.contacts?.find((item) => item.wa_id === message.from) ?? value.contacts?.[0];
  const phoneE164 = normalizeWhatsAppWaId(message.from);
  const replyToWaMessageId = replyContextId(message);
  console.info("WhatsApp inbound message received", {
    hasWaId: Boolean(message.from),
    normalizedPhonePresent: Boolean(phoneE164),
    hasContextId: Boolean(replyToWaMessageId),
    contextId: replyToWaMessageId
  });
  const textBody = messageText(message);
  const replyTarget = await findReplyTarget(admin, replyToWaMessageId, phoneE164);
  if (replyToWaMessageId) {
    console.info("WhatsApp inbound context lookup", {
      inboundMessageId: message.id,
      replyToWaMessageId,
      linked: Boolean(replyTarget?.id),
      linkedThreadId: replyTarget?.thread_id ?? null
    });
  }
  let match: WhatsAppMatchResult = replyTarget?.tenant_id
    ? {
        tenantId: replyTarget.tenant_id,
        bookingId: replyTarget.booking_id,
        transferId: replyTarget.transfer_id,
        customerId: replyTarget.customer_id,
        status: "matched" as const,
        suggestions: [] as WhatsAppMatchResult["suggestions"],
      }
    : await matchWhatsAppInboundMessage(admin, {
        waId: message.from,
        phoneE164,
        textBody,
        timestamp: message.timestamp
      });
  // Fallback: se nessun tenant abbinato, usa il thread tenant già esistente per questo numero
  if (!match.tenantId && !replyTarget?.tenant_id) {
    const { data: fb } = await admin
      .from("whatsapp_threads")
      .select("tenant_id, booking_id, transfer_id, customer_id")
      .eq("wa_id", message.from)
      .not("tenant_id", "is", null)
      .order("last_message_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (fb?.tenant_id) {
      match = {
        tenantId: String(fb.tenant_id),
        bookingId: fb.booking_id as string | null,
        transferId: fb.transfer_id as string | null,
        customerId: fb.customer_id as string | null,
        status: "matched",
        suggestions: [],
      };
    }
  }
  const effectiveMatchStatus = replyTarget?.tenant_id ? "matched" : match.tenantId ? match.status : "needs_review";

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
    matchStatus: effectiveMatchStatus,
    matchSuggestions: match.suggestions,
    lastMessageAt: timestamp,
    preview: previewForMessage(message)
  });

  const messagePayload = {
    tenant_id: match.tenantId,
    wa_message_id: message.id,
    direction: "inbound" as const,
    wa_id: message.from,
    phone_e164: phoneE164,
    contact_id: contactRow.id,
    thread_id: thread.id,
    customer_id: match.customerId,
    booking_id: match.bookingId,
    transfer_id: match.transferId,
    message_type: message.type ?? null,
    text_body: textBody,
    reply_to_wa_message_id: replyToWaMessageId,
    template_name: null,
    ...mediaMeta(message),
    status: "received",
    timestamp,
    raw_message: message
  };

  if (match.tenantId) {
    const { error } = await admin.from("whatsapp_messages").upsert(
      messagePayload,
      { onConflict: "tenant_id,wa_message_id", ignoreDuplicates: true }
    );
    if (error) throw error;
  } else {
    const { data: existing, error: existingError } = await admin
      .from("whatsapp_messages")
      .select("id")
      .is("tenant_id", null)
      .eq("wa_message_id", message.id)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing?.id) {
      const { error } = await admin.from("whatsapp_messages").insert(messagePayload);
      if (error) throw error;
    }
  }
  return {
    tenantId: match.tenantId,
    phoneE164,
    preview: previewForMessage(message),
    profileName: contact?.profile?.name ?? null
  };
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
  const result: ProcessResult = { messages: 0, statuses: 0, contacts: 0, errors: [], tenantsResolved: 0 };
  const resolvedTenantIds = new Set<string>();

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;
      console.info("WhatsApp webhook change received", {
        field: change.field ?? null,
        messagesCount: value.messages?.length ?? 0,
        statusesCount: value.statuses?.length ?? 0,
        hasWaId: Boolean(value.contacts?.[0]?.wa_id ?? value.messages?.[0]?.from ?? value.statuses?.[0]?.recipient_id)
      });
      for (const message of value.messages ?? []) {
        try {
          const processed = await processMessage(admin, value, message);
          result.messages += 1;
          if (processed?.tenantId) {
            resolvedTenantIds.add(processed.tenantId);
            const sender = processed.profileName || processed.phoneE164 || "cliente";
            try {
              await sendPushToTenantRoles(processed.tenantId, ["admin", "operator", "supervisor"], {
                title: "Nuovo WhatsApp",
                body: `${sender}: ${processed.preview}`.slice(0, 180),
                url: "/whatsapp",
                tag: `whatsapp-${message.id}`
              });
            } catch (pushError) {
              console.warn("WhatsApp push notification failed", {
                message: pushError instanceof Error ? pushError.message : "push failed"
              });
            }
          }
        } catch (error) {
          result.errors.push(error instanceof Error ? error.message : "message processing failed");
          console.error("WhatsApp inbound message persistence failed", {
            message: error instanceof Error ? error.message : "message processing failed"
          });
        }
      }
      for (const status of value.statuses ?? []) {
        try {
          await processStatus(admin, status);
          result.statuses += 1;
        } catch (error) {
          result.errors.push(error instanceof Error ? error.message : "status processing failed");
          console.error("WhatsApp status persistence failed", {
            message: error instanceof Error ? error.message : "status processing failed"
          });
        }
      }
      result.contacts += value.contacts?.length ?? 0;
    }
  }
  result.tenantsResolved = resolvedTenantIds.size;

  if (webhookEventId) {
    await admin
      .from("whatsapp_webhook_events")
      .update({
        tenant_id: resolvedTenantIds.values().next().value ?? null,
        processed_at: new Date().toISOString(),
        processing_error: result.errors.length ? result.errors.join("\n").slice(0, 2000) : null
      })
      .eq("id", webhookEventId);
  }

  return result;
}

