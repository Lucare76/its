import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureWhatsAppContact, normalizeWhatsAppContactPhone } from "./contacts";

type ServiceContext = {
  id: string;
  customer_name?: string | null;
  phone?: string | null;
  phone_e164?: string | null;
};

export type PersistOutboundWhatsAppMessageInput = {
  tenantId: string;
  toPhone: string | null | undefined;
  waMessageId: string | null | undefined;
  messageType: "template" | "text" | string;
  templateName?: string | null;
  textBody?: string | null;
  status?: string | null;
  timestamp?: string | null;
  serviceId?: string | null;
  rawMessage?: Record<string, unknown>;
};

function previewText(input: PersistOutboundWhatsAppMessageInput) {
  const text = input.textBody?.trim();
  if (text) return text.slice(0, 240);
  if (input.templateName) return `Template ${input.templateName}`;
  return `[${input.messageType || "messaggio"}]`;
}

async function loadServiceContext(
  admin: SupabaseClient,
  tenantId: string,
  serviceId: string | null | undefined,
) {
  if (!serviceId) return null;
  const { data, error } = await admin
    .from("services")
    .select("id, customer_name, phone, phone_e164")
    .eq("tenant_id", tenantId)
    .eq("id", serviceId)
    .maybeSingle();
  if (error) throw error;
  return data as ServiceContext | null;
}

export async function persistOutboundWhatsAppMessage(
  admin: SupabaseClient,
  input: PersistOutboundWhatsAppMessageInput,
) {
  const waMessageId = input.waMessageId?.trim();
  if (!waMessageId) return { ok: false as const, skipped: true as const, reason: "missing_wa_message_id" };

  const phoneE164 = normalizeWhatsAppContactPhone(input.toPhone);
  if (!phoneE164) return { ok: false as const, skipped: true as const, reason: "invalid_phone" };

  const nowIso = new Date().toISOString();
  const timestamp = input.timestamp ?? nowIso;
  const waId = phoneE164.replace(/^\+/, "");
  const service = await loadServiceContext(admin, input.tenantId, input.serviceId);
  const contact = await ensureWhatsAppContact(admin, {
    tenantId: input.tenantId,
    phone: phoneE164,
    profileName: service?.customer_name ?? null,
  });
  if (!contact.ok) return contact;

  const { data: existingThread, error: existingThreadError } = await admin
    .from("whatsapp_threads")
    .select("id, booking_id, transfer_id, customer_id, match_status, status")
    .eq("tenant_id", input.tenantId)
    .eq("wa_id", waId)
    .maybeSingle();
  if (existingThreadError) throw existingThreadError;

  const threadPatch = {
    tenant_id: input.tenantId,
    wa_id: waId,
    phone_e164: phoneE164,
    contact_id: contact.id,
    customer_id: existingThread?.customer_id ?? null,
    booking_id: existingThread?.booking_id ?? service?.id ?? null,
    transfer_id: existingThread?.transfer_id ?? service?.id ?? null,
    last_message_at: timestamp,
    last_message_preview: previewText(input),
    unread_count: 0,
    status: existingThread?.status ?? "open",
    match_status: existingThread?.match_status ?? (service?.id ? "matched" : "needs_review"),
    match_suggestions: [],
    updated_at: nowIso,
  };

  const { data: thread, error: threadError } = existingThread?.id
    ? await admin
        .from("whatsapp_threads")
        .update(threadPatch)
        .eq("tenant_id", input.tenantId)
        .eq("id", existingThread.id)
        .select("id")
        .single()
    : await admin
        .from("whatsapp_threads")
        .insert({
          ...threadPatch,
          created_at: nowIso,
        })
        .select("id")
        .single();
  if (threadError) throw threadError;

  const messagePayload = {
    tenant_id: input.tenantId,
    wa_message_id: waMessageId,
    reply_to_wa_message_id: null,
    direction: "outbound" as const,
    wa_id: waId,
    phone_e164: phoneE164,
    contact_id: contact.id,
    thread_id: thread.id,
    customer_id: null,
    booking_id: service?.id ?? input.serviceId ?? null,
    transfer_id: service?.id ?? input.serviceId ?? null,
    message_type: input.messageType,
    template_name: input.templateName ?? null,
    text_body: input.textBody ?? previewText(input),
    media_id: null,
    media_mime_type: null,
    media_sha256: null,
    status: input.status ?? "sent",
    timestamp,
    raw_message: input.rawMessage ?? {},
  };

  const { error: messageError } = await admin
    .from("whatsapp_messages")
    .upsert(messagePayload, { onConflict: "tenant_id,wa_message_id", ignoreDuplicates: true });
  if (messageError) throw messageError;

  return { ok: true as const, threadId: String(thread.id), waMessageId, phoneE164, waId };
}
