import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { getTenantWhatsAppSettings, isWhatsAppCustomerCareWindowOpen, loadSyncedWhatsAppTemplates, logWhatsAppEvent, normalizeE164, normalizeWhatsAppWaId, sendWhatsAppMediaMessage, sendWhatsAppMessage, sendWhatsAppTextMessage } from "@/lib/server/whatsapp";
import { matchWhatsAppInboundMessage } from "@/lib/server/whatsapp/matching";

export const runtime = "nodejs";

type AuthorizedPricingRequest = Exclude<Awaited<ReturnType<typeof authorizePricingRequest>>, NextResponse>;

const unsupportedManualHeaderFormats = new Set(["IMAGE", "VIDEO", "DOCUMENT", "LOCATION"]);

const patchSchema = z.object({
  thread_id: z.string().uuid(),
  action: z.enum(["mark_read", "close", "reopen", "delete", "associate", "update_phone"]),
  booking_id: z.string().uuid().nullable().optional(),
  phone: z.string().trim().min(6, "Numero troppo corto").max(30, "Numero troppo lungo").optional(),
});

const postSchema = z.object({
  mode: z.enum(["text", "template"]).default("text"),
  thread_id: z.string().uuid().optional(),
  phone: z.string().trim().optional(),
  profile_name: z.string().trim().max(120, "Nome troppo lungo").optional(),
  text: z.string().trim().max(4096, "Messaggio troppo lungo").optional(),
  template_name: z.string().trim().max(120, "Nome template troppo lungo").optional(),
  template_language: z.string().trim().max(20, "Lingua template non valida").optional(),
  template_variables: z.array(z.string().trim().max(1024, "Variabile template troppo lunga")).max(20, "Troppe variabili template").optional()
}).superRefine((value, ctx) => {
  if (!value.thread_id && !value.phone) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Seleziona una conversazione o inserisci un numero."
    });
  }
  if (value.mode === "template" && !value.template_name?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Seleziona un template WhatsApp."
    });
  }
});

const maxAttachmentBytes = 16 * 1024 * 1024;
const outboundMediaTypes = new Set(["image", "video", "audio", "document"]);

function textFormValue(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value : undefined;
}

function parseTemplateVariables(value: string | undefined) {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (Array.isArray(parsed)) return parsed;
  return undefined;
}

function normalizeOutboundMediaType(value: unknown): "image" | "video" | "audio" | "document" | null {
  return typeof value === "string" && outboundMediaTypes.has(value)
    ? value as "image" | "video" | "audio" | "document"
    : null;
}

async function parsePostPayload(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return {
      payload: await request.json().catch(() => null),
      attachment: null as File | null
    };
  }

  const form = await request.formData();
  const attachmentValue = form.get("attachment");
  const attachment = attachmentValue instanceof File && attachmentValue.size > 0 ? attachmentValue : null;
  return {
    payload: {
      mode: textFormValue(form, "mode") ?? "text",
      thread_id: textFormValue(form, "thread_id"),
      phone: textFormValue(form, "phone"),
      profile_name: textFormValue(form, "profile_name"),
      text: textFormValue(form, "text"),
      template_name: textFormValue(form, "template_name"),
      template_language: textFormValue(form, "template_language"),
      template_variables: parseTemplateVariables(textFormValue(form, "template_variables"))
    },
    attachment
  };
}

function extractStatusFailureReason(rawStatus: unknown) {
  const payload = rawStatus as { errors?: Array<{ title?: string; message?: string; code?: number | string }> } | null;
  const error = payload?.errors?.[0];
  if (!error) return null;
  const parts = [error.title, error.message, error.code != null ? `code ${error.code}` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" - ") : "Invio non consegnato";
}

function compactMessagePreview(input: {
  message_type?: string | null;
  text_body?: string | null;
  template_name?: string | null;
}) {
  const text = input.text_body?.trim();
  if (text) return text.slice(0, 140);
  if (input.template_name) return `Template ${input.template_name}`;
  return `[${input.message_type ?? "messaggio"}]`;
}

async function upsertManualContact(
  admin: AuthorizedPricingRequest["admin"],
  input: { tenantId: string; waId: string; phoneE164: string; profileName: string | null }
) {
  const { data: existing, error: existingError } = await admin
    .from("whatsapp_contacts")
    .select("id, profile_name, customer_full_name")
    .eq("tenant_id", input.tenantId)
    .or(`wa_id.eq.${input.waId},phone_e164.eq.${input.phoneE164}`)
    .limit(1)
    .maybeSingle();
  if (existingError) throw existingError;

  const basePayload = {
    tenant_id: input.tenantId,
    wa_id: input.waId,
    phone_e164: input.phoneE164,
    updated_at: new Date().toISOString()
  };
  const profileName = input.profileName?.trim() || null;
  const payload: Record<string, unknown> = { ...basePayload };
  if (profileName) {
    payload.profile_name = profileName;
    payload.customer_full_name = profileName;
  }

  if (existing?.id) {
    if (!profileName) {
      const { data, error } = await admin
        .from("whatsapp_contacts")
        .update(basePayload)
        .eq("id", existing.id)
        .select("id")
        .single();
      if (error) throw error;
      return data as { id: string };
    }
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
    .upsert(payload, { onConflict: "tenant_id,wa_id" })
    .select("id")
    .single();
  if (error) throw error;
  return data as { id: string };
}

async function upsertManualThread(
  admin: AuthorizedPricingRequest["admin"],
  input: {
    tenantId: string;
    waId: string;
    phoneE164: string;
    contactId: string;
    customerId: string | null;
    bookingId: string | null;
    transferId: string | null;
    matchStatus: "matched" | "needs_review";
  }
) {
  const { data: existing, error: existingError } = await admin
    .from("whatsapp_threads")
    .select("id, unread_count")
    .eq("tenant_id", input.tenantId)
    .eq("wa_id", input.waId)
    .maybeSingle();
  if (existingError) throw existingError;

  const payload = {
    tenant_id: input.tenantId,
    wa_id: input.waId,
    phone_e164: input.phoneE164,
    contact_id: input.contactId,
    customer_id: input.customerId,
    booking_id: input.bookingId,
    transfer_id: input.transferId,
    unread_count: Number(existing?.unread_count ?? 0),
    status: input.matchStatus === "matched" ? "open" : "needs_review",
    match_status: input.matchStatus,
    match_suggestions: [],
    updated_at: new Date().toISOString()
  };

  const { data, error } = await admin
    .from("whatsapp_threads")
    .upsert(payload, { onConflict: "tenant_id,wa_id" })
    .select("id, tenant_id, wa_id, phone_e164, contact_id, customer_id, booking_id, transfer_id, match_status")
    .single();
  if (error) throw error;
  return data as {
    id: string;
    tenant_id: string | null;
    wa_id: string;
    phone_e164: string | null;
    contact_id: string | null;
    customer_id: string | null;
    booking_id: string | null;
    transfer_id: string | null;
    match_status: string;
  };
}

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor", "assistenza"]);
  if (auth instanceof NextResponse) return auth;

  const tenantId = auth.membership.tenant_id;
  const settings = await getTenantWhatsAppSettings(auth.admin, tenantId);
  let syncedTemplates = [] as Awaited<ReturnType<typeof loadSyncedWhatsAppTemplates>>;
  let templateFetchError: string | null = null;
  try {
    syncedTemplates = await loadSyncedWhatsAppTemplates(auth.admin, tenantId);
  } catch (error) {
    templateFetchError = error instanceof Error ? error.message : "Impossibile caricare i template sincronizzati.";
  }
  const url = new URL(request.url);
  const filter = url.searchParams.get("filter") ?? "open";
  const search = (url.searchParams.get("q") ?? "").trim();
  const selectedThreadId = url.searchParams.get("thread_id") ?? url.searchParams.get("thread");

  let threadQuery = auth.admin
    .from("whatsapp_threads")
    .select("id, wa_id, phone_e164, customer_id, booking_id, transfer_id, last_message_at, last_message_preview, unread_count, assigned_to, status, match_status, match_suggestions, created_at, updated_at, whatsapp_contacts(profile_name,customer_full_name,wa_profile_name)")
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
        (thread.whatsapp_contacts as { profile_name?: string; customer_full_name?: string; wa_profile_name?: string } | null)?.customer_full_name,
        (thread.whatsapp_contacts as { profile_name?: string; customer_full_name?: string; wa_profile_name?: string } | null)?.profile_name,
        (thread.whatsapp_contacts as { profile_name?: string; customer_full_name?: string; wa_profile_name?: string } | null)?.wa_profile_name,
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
      .select("id, wa_message_id, reply_to_wa_message_id, direction, wa_id, phone_e164, message_type, template_name, text_body, media_id, media_mime_type, status, timestamp, created_at, booking_id, transfer_id, raw_message")
      .or(`tenant_id.eq.${tenantId},tenant_id.is.null`)
      .eq("thread_id", selectedId)
      .order("timestamp", { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: true })
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

  const messageByWaId = new Map(
    (messages ?? [])
      .filter((message) => Boolean(message.wa_message_id))
      .map((message) => [message.wa_message_id as string, message])
  );

  const enrichedMessages = (messages ?? []).map((message) => {
    const latestStatus = message.wa_message_id ? latestStatusByMessageId.get(message.wa_message_id) : null;
    const rawMessage = typeof message.raw_message === "object" && message.raw_message !== null
      ? message.raw_message as Record<string, unknown>
      : null;
    const documentMeta = rawMessage && typeof rawMessage.document === "object" && rawMessage.document !== null
      ? rawMessage.document as { filename?: unknown }
      : null;
    const replyTarget = message.reply_to_wa_message_id ? messageByWaId.get(message.reply_to_wa_message_id) : null;
    return {
      id: message.id,
      wa_message_id: message.wa_message_id,
      reply_to_wa_message_id: message.reply_to_wa_message_id,
      direction: message.direction,
      wa_id: message.wa_id,
      phone_e164: message.phone_e164,
      message_type: message.message_type,
      template_name: message.template_name,
      text_body: message.text_body,
      media_id: message.media_id,
      media_mime_type: message.media_mime_type,
      status: latestStatus?.status ?? message.status,
      failure_reason: latestStatus?.status === "failed" ? latestStatus.failure_reason : null,
      timestamp: message.timestamp,
      created_at: message.created_at,
      booking_id: message.booking_id,
      transfer_id: message.transfer_id,
      media_filename: typeof documentMeta?.filename === "string" ? documentMeta.filename : null,
      reply_to_message: replyTarget
        ? {
            id: replyTarget.id,
            wa_message_id: replyTarget.wa_message_id,
            direction: replyTarget.direction,
            message_type: replyTarget.message_type,
            template_name: replyTarget.template_name,
            preview: compactMessagePreview(replyTarget)
          }
        : message.reply_to_wa_message_id
          ? {
              id: null,
              wa_message_id: message.reply_to_wa_message_id,
              direction: null,
              message_type: null,
              template_name: null,
              preview: "Messaggio originale non trovato in questa conversazione"
            }
          : null,
    };
  });

  return NextResponse.json({
    ok: true,
    threads: enrichedThreads,
    selected_thread_id: selectedId ?? null,
    messages: enrichedMessages,
    template_options: syncedTemplates.map((template) => ({
      key: template.meta_template_id,
      label: template.name,
      template: template.name,
      language_code: template.language_code,
      status: template.status,
      category: template.category,
      body_parameter_count: template.body_parameter_count,
      body_text: template.body_text,
      header_format: template.header_format,
      is_tenant_default:
        template.name === settings.default_template && template.language_code === settings.template_language,
      is_tenant_arrival:
        template.name === settings.arrival_template && template.language_code === settings.template_language
    })),
    template_fetch_error: templateFetchError
  });
}

export async function PATCH(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor", "assistenza"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" }, { status: 400 });
  }

  if (parsed.data.action === "associate") {
    const bookingId = parsed.data.booking_id ?? null;
    let customerId: string | null = null;
    if (bookingId) {
      const { data: svc } = await auth.admin
        .from("services")
        .select("customer_id")
        .eq("tenant_id", auth.membership.tenant_id)
        .eq("id", bookingId)
        .maybeSingle();
      customerId = (svc as { customer_id?: string | null } | null)?.customer_id ?? null;
    }
    const { error } = await auth.admin
      .from("whatsapp_threads")
      .update({
        booking_id: bookingId,
        customer_id: customerId,
        match_status: bookingId ? "matched" : "unmatched",
        match_suggestions: [],
        updated_at: new Date().toISOString(),
      })
      .or(`tenant_id.eq.${auth.membership.tenant_id},tenant_id.is.null`)
      .eq("id", parsed.data.thread_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (parsed.data.action === "delete") {
    const { data: thread, error: threadError } = await auth.admin
      .from("whatsapp_threads")
      .select("id, tenant_id")
      .or(`tenant_id.eq.${auth.membership.tenant_id},tenant_id.is.null`)
      .eq("id", parsed.data.thread_id)
      .maybeSingle();
    if (threadError) return NextResponse.json({ error: threadError.message }, { status: 500 });
    if (!thread?.id) return NextResponse.json({ error: "Conversazione non trovata" }, { status: 404 });

    const { data: messageRows, error: messageRowsError } = await auth.admin
      .from("whatsapp_messages")
      .select("wa_message_id")
      .or(`tenant_id.eq.${auth.membership.tenant_id},tenant_id.is.null`)
      .eq("thread_id", thread.id);
    if (messageRowsError) return NextResponse.json({ error: messageRowsError.message }, { status: 500 });

    const waMessageIds = Array.from(new Set((messageRows ?? []).map((row) => row.wa_message_id).filter(Boolean) as string[]));
    if (waMessageIds.length > 0) {
      const { error: statusDeleteError } = await auth.admin
        .from("whatsapp_message_statuses")
        .delete()
        .eq("tenant_id", auth.membership.tenant_id)
        .in("wa_message_id", waMessageIds);
      if (statusDeleteError) return NextResponse.json({ error: statusDeleteError.message }, { status: 500 });
    }

    const { error: messagesDeleteError } = await auth.admin
      .from("whatsapp_messages")
      .delete()
      .or(`tenant_id.eq.${auth.membership.tenant_id},tenant_id.is.null`)
      .eq("thread_id", thread.id);
    if (messagesDeleteError) return NextResponse.json({ error: messagesDeleteError.message }, { status: 500 });

    const { error: threadDeleteError } = await auth.admin
      .from("whatsapp_threads")
      .delete()
      .or(`tenant_id.eq.${auth.membership.tenant_id},tenant_id.is.null`)
      .eq("id", thread.id);
    if (threadDeleteError) return NextResponse.json({ error: threadDeleteError.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  }

  if (parsed.data.action === "update_phone") {
    const normalizedPhone = normalizeWhatsAppWaId(parsed.data.phone ?? "");
    const digits = normalizedPhone.replace(/\D/g, "");
    if (digits.length < 8) {
      return NextResponse.json({ error: "Inserisci il numero in formato internazionale con prefisso (es. +49 172 5404319)." }, { status: 400 });
    }

    const { data: thread, error: threadError } = await auth.admin
      .from("whatsapp_threads")
      .select("id, tenant_id, contact_id, booking_id")
      .or(`tenant_id.eq.${auth.membership.tenant_id},tenant_id.is.null`)
      .eq("id", parsed.data.thread_id)
      .maybeSingle();
    if (threadError) return NextResponse.json({ error: threadError.message }, { status: 500 });
    if (!thread?.id) return NextResponse.json({ error: "Conversazione non trovata" }, { status: 404 });

    const nextWaId = normalizedPhone.replace(/^\+/, "");
    const updateTimestamp = new Date().toISOString();
    const { error: contactError } = thread.contact_id
      ? await auth.admin
        .from("whatsapp_contacts")
        .update({ wa_id: nextWaId, phone_e164: normalizedPhone, updated_at: updateTimestamp })
        .or(`tenant_id.eq.${auth.membership.tenant_id},tenant_id.is.null`)
        .eq("id", thread.contact_id)
      : { error: null };
    if (contactError) return NextResponse.json({ error: contactError.message }, { status: 500 });

    const { error: threadUpdateError } = await auth.admin
      .from("whatsapp_threads")
      .update({ wa_id: nextWaId, phone_e164: normalizedPhone, updated_at: updateTimestamp })
      .or(`tenant_id.eq.${auth.membership.tenant_id},tenant_id.is.null`)
      .eq("id", thread.id);
    if (threadUpdateError) return NextResponse.json({ error: threadUpdateError.message }, { status: 500 });

    const { error: messagesUpdateError } = await auth.admin
      .from("whatsapp_messages")
      .update({ wa_id: nextWaId, phone_e164: normalizedPhone })
      .or(`tenant_id.eq.${auth.membership.tenant_id},tenant_id.is.null`)
      .eq("thread_id", thread.id);
    if (messagesUpdateError) return NextResponse.json({ error: messagesUpdateError.message }, { status: 500 });

    if (thread.booking_id) {
      const { error: serviceUpdateError } = await auth.admin
        .from("services")
        .update({ phone: normalizedPhone, phone_e164: normalizedPhone })
        .eq("tenant_id", auth.membership.tenant_id)
        .eq("id", thread.booking_id);
      if (serviceUpdateError) return NextResponse.json({ error: serviceUpdateError.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, phone_e164: normalizedPhone, wa_id: nextWaId });
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
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor", "assistenza"]);
  if (auth instanceof NextResponse) return auth;

  let parsedRequest: Awaited<ReturnType<typeof parsePostPayload>>;
  try {
    parsedRequest = await parsePostPayload(request);
  } catch {
    return NextResponse.json({ error: "Payload invio WhatsApp non valido." }, { status: 400 });
  }

  const parsed = postSchema.safeParse(parsedRequest.payload);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" }, { status: 400 });
  }

  const tenantId = auth.membership.tenant_id;
  const nowIso = new Date().toISOString();
  const text = parsed.data.text?.trim() ?? "";
  const sendMode = parsed.data.mode;
  const attachment = parsedRequest.attachment;
  if (sendMode === "text" && !text && !attachment) {
    return NextResponse.json({ error: "Inserisci un messaggio o allega un file." }, { status: 400 });
  }
  if (sendMode === "template" && attachment) {
    return NextResponse.json({ error: "Gli allegati sono disponibili solo nei messaggi liberi dentro la finestra WhatsApp di 24 ore." }, { status: 400 });
  }
  if (attachment && attachment.size > maxAttachmentBytes) {
    return NextResponse.json({ error: "Allegato troppo grande. Limite massimo 16 MB." }, { status: 400 });
  }
  const settings = await getTenantWhatsAppSettings(auth.admin, tenantId);

  let thread:
    | {
        id: string;
        tenant_id: string | null;
        wa_id: string;
        phone_e164: string | null;
        contact_id: string | null;
        customer_id: string | null;
        booking_id: string | null;
        transfer_id: string | null;
        match_status: string;
      }
    | null = null;

  if (parsed.data.thread_id) {
    const { data: existingThread, error: threadError } = await auth.admin
      .from("whatsapp_threads")
      .select("id, tenant_id, wa_id, phone_e164, contact_id, customer_id, booking_id, transfer_id, match_status")
      .or(`tenant_id.eq.${tenantId},tenant_id.is.null`)
      .eq("id", parsed.data.thread_id)
      .maybeSingle();
    if (threadError) return NextResponse.json({ error: threadError.message }, { status: 500 });
    if (!existingThread?.wa_id) {
      return NextResponse.json({ error: "Conversazione non trovata" }, { status: 404 });
    }
    thread = existingThread;
  } else {
    if (sendMode === "text") {
      return NextResponse.json({
        error: "Per iniziare una nuova conversazione WhatsApp devi usare un template approvato."
      }, { status: 400 });
    }

    let normalizedPhone: string;
    try {
      normalizedPhone = normalizeE164(parsed.data.phone ?? "");
    } catch {
      return NextResponse.json({ error: "Numero non valido. Usa il formato +393391234567 o 3391234567." }, { status: 400 });
    }
    const waId = normalizedPhone.replace(/^\+/, "");
    const match = await matchWhatsAppInboundMessage(auth.admin, {
      waId,
      phoneE164: normalizedPhone,
      textBody: text,
      timestamp: null
    });
    const contact = await upsertManualContact(auth.admin, {
      tenantId,
      waId,
      phoneE164: normalizedPhone,
      profileName: parsed.data.profile_name ?? null
    });
    thread = await upsertManualThread(auth.admin, {
      tenantId,
      waId,
      phoneE164: normalizedPhone,
      contactId: contact.id,
      customerId: match.tenantId === tenantId ? match.customerId : null,
      bookingId: match.tenantId === tenantId ? match.bookingId : null,
      transferId: match.tenantId === tenantId ? match.transferId : null,
      matchStatus: match.tenantId === tenantId && match.status === "matched" ? "matched" : "needs_review"
    });
  }

  if (sendMode === "text") {
    const { data: latestInbound, error: latestInboundError } = await auth.admin
      .from("whatsapp_messages")
      .select("timestamp, created_at")
      .or(`tenant_id.eq.${tenantId},tenant_id.is.null`)
      .eq("thread_id", thread.id)
      .eq("direction", "inbound")
      .order("timestamp", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestInboundError) {
      return NextResponse.json({ error: latestInboundError.message }, { status: 500 });
    }

    const lastInboundAt = latestInbound?.timestamp ?? latestInbound?.created_at ?? null;
    if (!isWhatsAppCustomerCareWindowOpen(lastInboundAt)) {
      return NextResponse.json({
        ok: false,
        error: "La finestra WhatsApp di 24 ore è chiusa. Usa un template approvato per contattare il cliente."
      }, { status: 400 });
    }
  }

  const templateName = sendMode === "template" ? parsed.data.template_name!.trim() : null;
  const templateVariables = sendMode === "template" ? parsed.data.template_variables ?? [] : [];
  const templateLang = sendMode === "template"
    ? parsed.data.template_language?.trim() || settings.template_language
    : settings.template_language;
  let templateBodyText: string | null = null;

  if (sendMode === "template" && templateName) {
    const { data: tplRow, error: tplError } = await auth.admin
      .from("whatsapp_templates")
      .select("body_text, body_parameter_count, header_format, raw_json")
      .eq("tenant_id", tenantId)
      .eq("name", templateName)
      .eq("language_code", templateLang)
      .maybeSingle();
    if (tplError) return NextResponse.json({ error: tplError.message }, { status: 500 });
    if (!tplRow) {
      return NextResponse.json({ error: "Template WhatsApp non trovato. Sincronizza i template da Impostazioni WhatsApp." }, { status: 400 });
    }

    const headerFormat = String(tplRow.header_format ?? "").toUpperCase();
    if (unsupportedManualHeaderFormats.has(headerFormat) || templateHeaderNeedsParameter(tplRow.raw_json)) {
      return NextResponse.json({
        error: "Questo template richiede parametri header non supportati dall'invio manuale. Seleziona un template solo testo."
      }, { status: 400 });
    }

    const expectedVariables = Number(tplRow.body_parameter_count ?? 0);
    if (templateVariables.length !== expectedVariables || templateVariables.some((value) => !value.trim())) {
      return NextResponse.json({
        error: `Il template richiede ${expectedVariables} variabil${expectedVariables === 1 ? "e" : "i"} compilat${expectedVariables === 1 ? "a" : "e"}.`
      }, { status: 400 });
    }

    if (tplRow.body_text) {
      let filled = tplRow.body_text as string;
      for (let i = 0; i < templateVariables.length; i++) {
        filled = filled.replace(new RegExp(`\\{\\{${i + 1}\\}\\}`, "g"), templateVariables[i] ?? "");
      }
      templateBodyText = filled;
    }
  }

  const targetPhone = normalizeWhatsAppWaId(thread.wa_id);
  console.info("WhatsApp inbox send requested", {
    mode: sendMode,
    threadId: thread.id,
    templateName,
    hasTemplateVariables: templateVariables.length > 0,
    hasAttachment: Boolean(attachment)
  });
  const sendResult = attachment
    ? await sendWhatsAppMediaMessage({
        to: targetPhone,
        file: attachment,
        filename: attachment.name || "allegato",
        mimeType: attachment.type || "application/octet-stream",
        caption: text
      })
    : sendMode === "template"
    ? await sendWhatsAppMessage({
        to: targetPhone,
        template: templateName!,
        languageCode: templateLang,
        variables: Object.fromEntries(
          templateVariables.map((value, index) => [String(index + 1), value])
        )
      })
    : await sendWhatsAppTextMessage({
        to: targetPhone,
        text
      });

  if (!sendResult.ok) {
    console.error("WhatsApp inbox reply failed", {
      hasWaId: Boolean(thread.wa_id),
      normalizedPhonePresent: Boolean(sendResult.phoneE164),
      error: sendResult.error ?? "unknown",
      mode: sendMode
    });
    return NextResponse.json({ error: sendResult.error ?? "Invio WhatsApp non riuscito" }, { status: 502 });
  }

  const previewText = templateBodyText
    ? templateBodyText.slice(0, 240)
    : sendMode === "template"
      ? `[Template] ${templateName}${templateVariables.length ? ` · ${templateVariables.join(" | ").slice(0, 180)}` : ""}`.slice(0, 240)
      : attachment
        ? `${text ? `${text.slice(0, 180)} - ` : ""}Allegato: ${attachment.name || "file"}`.slice(0, 240)
        : text.slice(0, 240);
  const outboundMediaType = normalizeOutboundMediaType(
    attachment && sendResult.ok && "mediaType" in sendResult ? sendResult.mediaType : null
  );
  const outboundMediaId = attachment && sendResult.ok && "mediaId" in sendResult ? sendResult.mediaId : null;

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
    message_type: outboundMediaType ?? (sendMode === "template" ? "template" : "text"),
    template_name: templateName,
    reply_to_wa_message_id: null,
    text_body: sendMode === "template" ? (templateBodyText ?? previewText) : (text || previewText),
    media_id: outboundMediaId,
    media_mime_type: attachment ? attachment.type || "application/octet-stream" : null,
    media_sha256: null,
    status: "sent",
    timestamp: nowIso,
    raw_message: {
      id: sendResult.messageId ?? null,
      type: sendMode,
      ...(attachment
        ? {
            [outboundMediaType ?? "document"]: {
              id: outboundMediaId,
              caption: text || null,
              filename: attachment.name || null
            }
          }
        : sendMode === "template"
        ? {
            template: {
              name: templateName,
              language: { code: parsed.data.template_language?.trim() || settings.template_language },
              parameters: templateVariables
            }
          }
        : {
            text: { body: text }
          }),
      source: attachment ? "manual_attachment" : sendMode === "template" ? "manual_template" : "manual_reply"
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
  console.info("WhatsApp inbox message persisted", {
    mode: sendMode,
    threadId: thread.id,
    waMessageId: sendResult.messageId ?? null,
    templateName,
    hasAttachment: Boolean(attachment),
    textPreview: previewText.slice(0, 80)
  });

  const { error: updateError } = await auth.admin
    .from("whatsapp_threads")
    .update({
      phone_e164: sendResult.phoneE164,
      last_message_at: nowIso,
      last_message_preview: previewText,
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
    template: templateName,
    status: "sent",
    provider_message_id: sendResult.messageId ?? null,
    happened_at: nowIso,
    payload_json: {
      source: "api/ops/whatsapp-inbox",
      mode: attachment ? "manual_attachment" : sendMode === "template" ? "manual_template" : "manual_reply",
      template_language: sendMode === "template" ? parsed.data.template_language?.trim() || settings.template_language : null,
      template_variables: sendMode === "template" ? templateVariables : [],
      attachment: attachment ? {
        filename: attachment.name || null,
        mime_type: attachment.type || "application/octet-stream",
        size: attachment.size,
        media_id: outboundMediaId
      } : null,
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
    thread_id: thread.id,
    message_id: sendResult.messageId ?? null,
    phone_e164: sendResult.phoneE164
  });
}

function templateHeaderNeedsParameter(rawJson: unknown) {
  const components = (rawJson as { components?: Array<{ type?: string; text?: string | null }> } | null)?.components;
  const header = components?.find((component) => component.type?.toUpperCase() === "HEADER");
  return /\{\{\d+\}\}/.test(header?.text ?? "");
}
