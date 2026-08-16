import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { getTenantWhatsAppSettings, isWhatsAppCustomerCareWindowOpen, loadSyncedWhatsAppTemplates, logWhatsAppEvent, normalizeE164, normalizeWhatsAppWaId, sendWhatsAppMediaMessage, sendWhatsAppMessage, sendWhatsAppTextMessage } from "@/lib/server/whatsapp";
import { matchWhatsAppInboundMessage } from "@/lib/server/whatsapp/matching";
import { sanitizedErrorResponse } from "@/lib/server/api-error";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

type AuthorizedPricingRequest = Exclude<Awaited<ReturnType<typeof authorizePricingRequest>>, NextResponse>;

const unsupportedManualHeaderFormats = new Set(["IMAGE", "VIDEO", "DOCUMENT", "LOCATION"]);

const DEFAULT_THREAD_PAGE_SIZE = 50;
const MAX_THREAD_PAGE_SIZE = 100;
const SEARCH_CANDIDATE_LIMIT = 500;
const INCREMENTAL_MESSAGES_LIMIT = 200;
const PENDING_STATUS_LIMIT = 50;
const MESSAGE_COLUMNS = "id, wa_message_id, reply_to_wa_message_id, direction, wa_id, phone_e164, message_type, template_name, text_body, media_id, media_mime_type, status, timestamp, created_at, booking_id, transfer_id, raw_message";
// Colonne minime per il poll leggero (poll_mode=1): id, wa_id, phone_e164,
// booking_id/transfer_id (associazione), last_message_at/preview, unread_count,
// status, match_status, match_suggestions (badge "da verificare"), whatsapp_contacts
// (nome contatto). Verificato via grep su app/(app)/whatsapp/page.tsx: customer_id,
// assigned_to, created_at, updated_at non sono letti dal client (ThreadRow non li
// dichiara), quindi vengono omessi solo qui per non toccare il payload del GET normale.
const POLL_THREAD_COLUMNS = "id, wa_id, phone_e164, booking_id, transfer_id, last_message_at, last_message_preview, unread_count, status, match_status, match_suggestions, whatsapp_contacts(profile_name,customer_full_name,manual_contact_name,wa_profile_name)";
const FULL_THREAD_COLUMNS = "id, wa_id, phone_e164, customer_id, booking_id, transfer_id, last_message_at, last_message_preview, unread_count, assigned_to, status, match_status, match_suggestions, created_at, updated_at, whatsapp_contacts(profile_name,customer_full_name,manual_contact_name,wa_profile_name)";

// Stessa euristica già usata in app/api/ops/search/route.ts: virgole e parentesi
// romperebbero la sintassi della stringa .or() di PostgREST, quindi in quel caso
// ripieghiamo su .ilike() singole per campo invece di costruire l'OR combinato.
function canUsePostgrestOr(value: string): boolean {
  return !/[(),]/.test(value);
}

const patchSchema = z.object({
  thread_id: z.string().uuid(),
  action: z.enum(["mark_read", "close", "reopen", "delete", "associate", "update_phone", "rename_contact"]),
  booking_id: z.string().uuid().nullable().optional(),
  phone: z.string().trim().min(6, "Numero troppo corto").max(30, "Numero troppo lungo").optional(),
  contact_name: z.string().trim().max(120).optional(),
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
const WHATSAPP_WINDOW_CLOSED_ERROR =
  "La finestra WhatsApp di 24 ore è chiusa. Per ricontattare il cliente devi utilizzare un template approvato da Meta.";

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

function failedOutboundPreview(input: {
  mode: "text" | "template";
  text: string;
  templateBodyText: string | null;
  templateName: string | null;
  attachment: File | null;
}) {
  const body = input.templateBodyText?.trim()
    || (input.mode === "template" && input.templateName ? `Template ${input.templateName}` : "")
    || input.text.trim()
    || (input.attachment ? `Allegato: ${input.attachment.name || "file"}` : "Messaggio WhatsApp");
  return `[Non inviato] ${body}`.slice(0, 240);
}

async function upsertManualContact(
  admin: AuthorizedPricingRequest["admin"],
  input: { tenantId: string; waId: string; phoneE164: string; profileName: string | null }
) {
  const { data: existing, error: existingError } = await admin
    .from("whatsapp_contacts")
    .select("id, profile_name, customer_full_name, manual_contact_name")
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
    payload.manual_contact_name = profileName;
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

function buildLatestStatusMap(
  statusRows: Array<{ wa_message_id: string | null; status: string; raw_status: unknown }> | null | undefined
) {
  const map = new Map<string, { status: string; failure_reason: string | null }>();
  for (const row of statusRows ?? []) {
    if (!row.wa_message_id || map.has(row.wa_message_id)) continue;
    map.set(row.wa_message_id, { status: row.status, failure_reason: extractStatusFailureReason(row.raw_status) });
  }
  return map;
}

function enrichMessages(
  rawMessages: Array<Record<string, unknown>>,
  latestStatusByMessageId: Map<string, { status: string; failure_reason: string | null }>,
  replyLookupMap: Map<string, Record<string, unknown>>
) {
  return rawMessages.map((message) => {
    const latestStatus = message.wa_message_id ? latestStatusByMessageId.get(message.wa_message_id as string) : null;
    const rawMessage = typeof message.raw_message === "object" && message.raw_message !== null
      ? message.raw_message as Record<string, unknown>
      : null;
    const documentMeta = rawMessage && typeof rawMessage.document === "object" && rawMessage.document !== null
      ? rawMessage.document as { filename?: unknown }
      : null;
    const replyTarget = message.reply_to_wa_message_id
      ? replyLookupMap.get(message.reply_to_wa_message_id as string)
      : null;
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
            preview: compactMessagePreview(replyTarget as { message_type?: string | null; text_body?: string | null; template_name?: string | null })
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
}

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor", "assistenza"]);
  if (auth instanceof NextResponse) return auth;

  const tenantId = auth.membership.tenant_id;
  const url = new URL(request.url);
  // I template sono dati tenant-wide, stabili: il client li richiede una sola
  // volta al mount e li tiene in stato locale. I refetch "silenziosi" (poll
  // 12s/20s, cambio filtro/thread, refresh dopo mutazioni) passano
  // include_templates=0 per evitare 2 query DB inutili ad ogni giro.
  // poll_mode=1: refresh leggero usato dai timer 12s/20s e da visibilitychange
  // (Sprint Performance 5). Salta sempre template/settings (oltre a rispettare
  // include_templates=0 già inviato dal client), salta la query "services" e,
  // se c'è un cursore messages_after/_id, rilegge solo i messaggi nuovi + gli
  // status dei messaggi outbound ancora non definitivi, invece dell'intera
  // conversazione. Il comportamento del GET normale (senza poll_mode) resta
  // identico a prima: nessuna retrocompatibilità rotta.
  const pollMode = url.searchParams.get("poll_mode") === "1";
  const includeTemplates = !pollMode && url.searchParams.get("include_templates") !== "0";
  let settings: Awaited<ReturnType<typeof getTenantWhatsAppSettings>> | null = null;
  let syncedTemplates = [] as Awaited<ReturnType<typeof loadSyncedWhatsAppTemplates>>;
  let templateFetchError: string | null = null;
  if (includeTemplates) {
    settings = await getTenantWhatsAppSettings(auth.admin, tenantId);
    try {
      syncedTemplates = await loadSyncedWhatsAppTemplates(auth.admin, tenantId);
    } catch (error) {
      templateFetchError = "Impossibile caricare i template sincronizzati.";
      auditLog({
        event: "whatsapp_inbox_load_templates_failed",
        level: "error",
        tenantId,
        details: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  const filter = url.searchParams.get("filter") ?? "open";
  const search = (url.searchParams.get("q") ?? "").trim();
  const searchDigits = search.replace(/\D/g, "");
  const selectedThreadId = url.searchParams.get("thread_id") ?? url.searchParams.get("thread");

  const pageSizeParam = Number.parseInt(url.searchParams.get("page_size") ?? "", 10);
  const pageSize = Number.isFinite(pageSizeParam) && pageSizeParam > 0
    ? Math.min(pageSizeParam, MAX_THREAD_PAGE_SIZE)
    : DEFAULT_THREAD_PAGE_SIZE;
  const pageParam = Number.parseInt(url.searchParams.get("page") ?? "", 10);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;
  const offset = (page - 1) * pageSize;

  // Ricerca lato DB: risolviamo prima gli id di contatti/prenotazioni che
  // corrispondono al termine (query mirate e con LIMIT, mai fetchAllServices),
  // poi filtriamo whatsapp_threads con un solo .or() su colonne native + IN(...).
  // Sostituisce il vecchio pattern "fetch fino a 5000 thread + filtro in JS".
  let searchContactIds: string[] = [];
  let searchServiceIds: string[] = [];
  if (search) {
    const pattern = `%${search}%`;
    if (canUsePostgrestOr(search)) {
      const [contactsRes, servicesFieldsRes, servicesHotelRes] = await Promise.all([
        auth.admin
          .from("whatsapp_contacts")
          .select("id")
          .eq("tenant_id", tenantId)
          .or(`profile_name.ilike.${pattern},customer_full_name.ilike.${pattern},manual_contact_name.ilike.${pattern},wa_profile_name.ilike.${pattern}`)
          .limit(SEARCH_CANDIDATE_LIMIT),
        auth.admin
          .from("services")
          .select("id")
          .eq("tenant_id", tenantId)
          .or(`customer_name.ilike.${pattern},customer_first_name.ilike.${pattern},customer_last_name.ilike.${pattern},phone.ilike.${pattern},booking_service_kind.ilike.${pattern}`)
          .limit(SEARCH_CANDIDATE_LIMIT),
        auth.admin
          .from("services")
          .select("id, hotels!inner(name)")
          .eq("tenant_id", tenantId)
          .ilike("hotels.name", pattern)
          .limit(SEARCH_CANDIDATE_LIMIT),
      ]);
      searchContactIds = (contactsRes.data ?? []).map((row: { id: string }) => String(row.id));
      searchServiceIds = Array.from(new Set([
        ...((servicesFieldsRes.data ?? []) as Array<{ id: string }>).map((row) => String(row.id)),
        ...((servicesHotelRes.data ?? []) as Array<{ id: string }>).map((row) => String(row.id)),
      ]));
    } else {
      // Il termine contiene virgole/parentesi: la sintassi .or() di PostgREST si
      // romperebbe, quindi ripieghiamo su .ilike() singole per campo (nessuna
      // ricerca sul nome hotel in questo ramo raro: caso limite accettato).
      const contactFields = ["profile_name", "customer_full_name", "manual_contact_name", "wa_profile_name"] as const;
      const serviceFields = ["customer_name", "customer_first_name", "customer_last_name", "phone", "booking_service_kind"] as const;
      const [contactsRows, serviceRows] = await Promise.all([
        Promise.all(contactFields.map((field) =>
          auth.admin.from("whatsapp_contacts").select("id").eq("tenant_id", tenantId).ilike(field, pattern).limit(SEARCH_CANDIDATE_LIMIT)
        )),
        Promise.all(serviceFields.map((field) =>
          auth.admin.from("services").select("id").eq("tenant_id", tenantId).ilike(field, pattern).limit(SEARCH_CANDIDATE_LIMIT)
        )),
      ]);
      searchContactIds = Array.from(new Set(contactsRows.flatMap((res) => ((res.data ?? []) as Array<{ id: string }>).map((row) => String(row.id)))));
      searchServiceIds = Array.from(new Set(serviceRows.flatMap((res) => ((res.data ?? []) as Array<{ id: string }>).map((row) => String(row.id)))));
    }
  }

  // Le due select() sotto usano ciascuna una stringa-literal singola (non una
  // ternaria condivisa): passare una union di due literal a .select() rompe il
  // parser a livello di tipo di postgrest-js (ParserError su entrambi i rami).
  // Duplicare la costruzione della query per ramo evita il problema restando
  // comunque a costo zero a runtime (branch deciso una sola volta).
  let searchYieldsNothing = false;
  let searchOrClause: string | null = null;
  if (search) {
    const searchClauses: string[] = [];
    if (searchDigits.length >= 6) {
      searchClauses.push(`wa_id.ilike.%${searchDigits}%`, `phone_e164.ilike.%${searchDigits}%`);
    }
    if (canUsePostgrestOr(search)) {
      searchClauses.push(`last_message_preview.ilike.%${search}%`);
    }
    if (searchContactIds.length) searchClauses.push(`contact_id.in.(${searchContactIds.join(",")})`);
    if (searchServiceIds.length) {
      searchClauses.push(`booking_id.in.(${searchServiceIds.join(",")})`);
      searchClauses.push(`transfer_id.in.(${searchServiceIds.join(",")})`);
    }
    if (searchClauses.length === 0) {
      searchYieldsNothing = true;
    } else {
      searchOrClause = searchClauses.join(",");
    }
  }

  let threadRows: Array<Record<string, unknown>> = [];
  let hasMoreThreads = false;
  if (!searchYieldsNothing) {
    let threadQuery = pollMode
      ? auth.admin.from("whatsapp_threads").select(POLL_THREAD_COLUMNS)
      : auth.admin.from("whatsapp_threads").select(FULL_THREAD_COLUMNS);
    threadQuery = threadQuery
      .or(`tenant_id.eq.${tenantId},tenant_id.is.null`)
      .order("last_message_at", { ascending: false, nullsFirst: false });
    if (filter === "unread") threadQuery = threadQuery.neq("status", "closed").gt("unread_count", 0);
    if (filter === "urgent") threadQuery = threadQuery.neq("status", "closed").or("unread_count.gt.0,status.eq.needs_review,match_status.eq.needs_review");
    if (filter === "needs_review") threadQuery = threadQuery.eq("status", "needs_review");
    if (filter === "associated") threadQuery = threadQuery.or("booking_id.not.is.null,transfer_id.not.is.null");
    if (filter === "unassociated") threadQuery = threadQuery.is("booking_id", null).is("transfer_id", null);
    if (filter === "closed") threadQuery = threadQuery.eq("status", "closed");
    if (filter === "open") threadQuery = threadQuery.neq("status", "closed");
    if (searchOrClause) threadQuery = threadQuery.or(searchOrClause);

    // Range inclusivo: chiediamo pageSize+1 righe per sapere se esiste una
    // pagina successiva senza una query di COUNT separata.
    const { data: threads, error: threadError } = await threadQuery.range(offset, offset + pageSize);
    if (threadError) {
      return sanitizedErrorResponse(threadError, {
        status: 500,
        fallback: "Impossibile caricare le conversazioni.",
        event: "whatsapp_inbox_list_threads_failed",
        tenantId,
        details: { filter },
      });
    }
    const fetched = (threads ?? []) as Array<Record<string, unknown>>;
    hasMoreThreads = fetched.length > pageSize;
    threadRows = fetched.slice(0, pageSize);
  }

  // Fase 8: i dati servizio/prenotazione collegati non cambiano durante un poll
  // silenzioso. In poll_mode saltiamo del tutto la query "services" e non
  // includiamo la chiave "service" nell'oggetto thread: il client mantiene il
  // valore già in stato invece di sovrascriverlo con null.
  let enrichedThreads: Array<Record<string, unknown>>;
  if (pollMode) {
    enrichedThreads = threadRows;
  } else {
    const serviceIds = Array.from(new Set(
      threadRows
        .map((row) => row.booking_id ?? row.transfer_id)
        .filter(Boolean) as string[]
    ));
    const { data: services } = serviceIds.length
      ? await auth.admin
        .from("services")
        .select("id, customer_name, customer_first_name, customer_last_name, phone, date, time, booking_service_kind, hotel_id, hotels(name)")
        .eq("tenant_id", tenantId)
        .in("id", serviceIds)
      : { data: [] };
    const serviceMap = new Map((services ?? []).map((service: Record<string, unknown>) => [String(service.id), service]));
    enrichedThreads = threadRows.map((thread) => {
      const serviceId = thread.booking_id ?? thread.transfer_id;
      return { ...thread, service: serviceId ? serviceMap.get(String(serviceId)) ?? null : null };
    });
  }

  // Fase 3/4: in poll_mode non si ricade mai sul primo thread della pagina se
  // il client non ha esplicitamente selezionato un thread (mobile "list view" /
  // nessuna chat aperta) — evita di rileggere una conversazione che non è
  // visualizzata. Il GET normale mantiene il comportamento originale (auto
  // selezione del primo thread al mount).
  const selectedId = pollMode ? (selectedThreadId ?? null) : (selectedThreadId ?? enrichedThreads[0]?.id ?? null);

  const messagesAfter = url.searchParams.get("messages_after");
  const messagesAfterId = url.searchParams.get("messages_after_id");
  const useIncrementalMessages = pollMode && Boolean(selectedId) && Boolean(messagesAfter) && Boolean(messagesAfterId);

  let enrichedMessages: Array<Record<string, unknown>> = [];
  let statusUpdates: Array<{ id: string; wa_message_id: string; status: string; failure_reason: string | null }> = [];
  let messagesMode: "full" | "incremental" = "full";

  if (useIncrementalMessages && selectedId) {
    // Fase 5/6: rileggiamo solo i messaggi inseriti dopo il cursore
    // (created_at, con id come tie-break deterministico per timestamp
    // identici — evita la fragilità di un confronto basato solo su
    // timestamp). .gte() include anche il messaggio-cursore stesso, che
    // viene poi escluso in JS dal tie-break qui sotto.
    const { data: rawNewMessages, error: newMessagesError } = await auth.admin
      .from("whatsapp_messages")
      .select(MESSAGE_COLUMNS)
      .or(`tenant_id.eq.${tenantId},tenant_id.is.null`)
      .eq("thread_id", selectedId)
      .gte("created_at", messagesAfter as string)
      .order("created_at", { ascending: true })
      .limit(INCREMENTAL_MESSAGES_LIMIT);
    if (newMessagesError) {
      return sanitizedErrorResponse(newMessagesError, {
        status: 500,
        fallback: "Impossibile caricare i nuovi messaggi della conversazione.",
        event: "whatsapp_inbox_list_new_messages_failed",
        tenantId,
        details: { threadId: selectedId },
      });
    }
    const newMessages = (rawNewMessages ?? []).filter((message) => {
      const createdAt = String(message.created_at);
      if (createdAt > (messagesAfter as string)) return true;
      if (createdAt < (messagesAfter as string)) return false;
      return String(message.id) > (messagesAfterId as string);
    });

    // Fase 6: risolvi le anteprime di risposta ("reply_to") che puntano a
    // messaggi più vecchi già caricati dal client ma non presenti in questo
    // batch incrementale: lookup mirato e limitato, non l'intera conversazione.
    const replyLookupMap = new Map<string, Record<string, unknown>>(
      newMessages.filter((m) => m.wa_message_id).map((m) => [m.wa_message_id as string, m])
    );
    const missingReplyIds = Array.from(new Set(
      newMessages
        .map((m) => m.reply_to_wa_message_id)
        .filter((id): id is string => Boolean(id) && !replyLookupMap.has(id as string))
    ));
    if (missingReplyIds.length > 0) {
      const { data: replyTargets } = await auth.admin
        .from("whatsapp_messages")
        .select("id, wa_message_id, direction, message_type, template_name, text_body")
        .or(`tenant_id.eq.${tenantId},tenant_id.is.null`)
        .in("wa_message_id", missingReplyIds)
        .limit(missingReplyIds.length);
      for (const target of replyTargets ?? []) {
        if (target.wa_message_id) replyLookupMap.set(target.wa_message_id, target);
      }
    }

    const newWaMessageIds = Array.from(new Set(newMessages.map((m) => m.wa_message_id).filter(Boolean) as string[]));
    const { data: newMessageStatuses, error: newStatusError } = newWaMessageIds.length
      ? await auth.admin
        .from("whatsapp_message_statuses")
        .select("wa_message_id, status, created_at, raw_status")
        .eq("tenant_id", tenantId)
        .in("wa_message_id", newWaMessageIds)
        .order("created_at", { ascending: false })
      : { data: [], error: null };
    if (newStatusError) {
      return sanitizedErrorResponse(newStatusError, {
        status: 500,
        fallback: "Impossibile caricare lo stato dei nuovi messaggi.",
        event: "whatsapp_inbox_list_new_message_statuses_failed",
        tenantId,
        details: { threadId: selectedId },
      });
    }
    enrichedMessages = enrichMessages(newMessages, buildLatestStatusMap(newMessageStatuses), replyLookupMap);
    messagesMode = "incremental";

    // Fase 7: i messaggi outbound già caricati possono avanzare di stato
    // (sent -> delivered -> read) senza che arrivi alcun messaggio nuovo.
    // Rileggiamo solo lo stato dei messaggi outbound non ancora in stato
    // definitivo (read/failed), non l'intera cronologia di stato del thread.
    const { data: pendingOutbound, error: pendingError } = await auth.admin
      .from("whatsapp_messages")
      .select("id, wa_message_id, status")
      .or(`tenant_id.eq.${tenantId},tenant_id.is.null`)
      .eq("thread_id", selectedId)
      .eq("direction", "outbound")
      .neq("status", "read")
      .neq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(PENDING_STATUS_LIMIT);
    if (pendingError) {
      return sanitizedErrorResponse(pendingError, {
        status: 500,
        fallback: "Impossibile aggiornare lo stato dei messaggi.",
        event: "whatsapp_inbox_pending_statuses_failed",
        tenantId,
        details: { threadId: selectedId },
      });
    }
    const pendingWaMessageIds = Array.from(new Set(
      (pendingOutbound ?? []).map((m) => m.wa_message_id).filter(Boolean) as string[]
    ));
    const { data: pendingStatusRows, error: pendingStatusError } = pendingWaMessageIds.length
      ? await auth.admin
        .from("whatsapp_message_statuses")
        .select("wa_message_id, status, created_at, raw_status")
        .eq("tenant_id", tenantId)
        .in("wa_message_id", pendingWaMessageIds)
        .order("created_at", { ascending: false })
      : { data: [], error: null };
    if (pendingStatusError) {
      return sanitizedErrorResponse(pendingStatusError, {
        status: 500,
        fallback: "Impossibile aggiornare lo stato dei messaggi.",
        event: "whatsapp_inbox_pending_status_lookup_failed",
        tenantId,
        details: { threadId: selectedId },
      });
    }
    const pendingLatestStatus = buildLatestStatusMap(pendingStatusRows);
    statusUpdates = (pendingOutbound ?? [])
      .filter((m): m is { id: string; wa_message_id: string; status: string } => Boolean(m.wa_message_id))
      .map((m) => {
        const latest = pendingLatestStatus.get(m.wa_message_id);
        return {
          id: String(m.id),
          wa_message_id: m.wa_message_id,
          status: latest?.status ?? m.status,
          failure_reason: latest?.status === "failed" ? latest.failure_reason : null,
        };
      });
  } else if (selectedId) {
    const { data: messages, error: messageError } = await auth.admin
      .from("whatsapp_messages")
      .select(MESSAGE_COLUMNS)
      .or(`tenant_id.eq.${tenantId},tenant_id.is.null`)
      .eq("thread_id", selectedId)
      .order("timestamp", { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: true })
      .limit(500);
    if (messageError) {
      return sanitizedErrorResponse(messageError, {
        status: 500,
        fallback: "Impossibile caricare i messaggi della conversazione.",
        event: "whatsapp_inbox_list_messages_failed",
        tenantId,
        details: { threadId: selectedId },
      });
    }

    const waMessageIds = Array.from(new Set((messages ?? []).map((message) => message.wa_message_id).filter(Boolean) as string[]));
    const { data: messageStatuses, error: statusError } = waMessageIds.length
      ? await auth.admin
        .from("whatsapp_message_statuses")
        .select("wa_message_id, status, created_at, raw_status")
        .eq("tenant_id", tenantId)
        .in("wa_message_id", waMessageIds)
        .order("created_at", { ascending: false })
      : { data: [], error: null };
    if (statusError) {
      return sanitizedErrorResponse(statusError, {
        status: 500,
        fallback: "Impossibile caricare lo stato dei messaggi.",
        event: "whatsapp_inbox_list_message_statuses_failed",
        tenantId,
        details: { threadId: selectedId },
      });
    }

    const messageByWaId = new Map<string, Record<string, unknown>>(
      (messages ?? [])
        .filter((message) => Boolean(message.wa_message_id))
        .map((message) => [message.wa_message_id as string, message])
    );
    enrichedMessages = enrichMessages(messages ?? [], buildLatestStatusMap(messageStatuses), messageByWaId);
    messagesMode = "full";
  }

  return NextResponse.json({
    ok: true,
    threads: enrichedThreads,
    page,
    page_size: pageSize,
    has_more: hasMoreThreads,
    selected_thread_id: selectedId ?? null,
    messages: enrichedMessages,
    messages_mode: messagesMode,
    status_updates: statusUpdates,
    templates_included: includeTemplates,
    template_options: settings
      ? syncedTemplates.map((template) => ({
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
        }))
      : [],
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
    if (error) {
      return sanitizedErrorResponse(error, {
        status: 500,
        fallback: "Impossibile associare la conversazione alla prenotazione.",
        event: "whatsapp_inbox_associate_thread_failed",
        tenantId: auth.membership.tenant_id,
        details: { threadId: parsed.data.thread_id },
      });
    }
    return NextResponse.json({ ok: true });
  }

  if (parsed.data.action === "delete") {
    const { data: thread, error: threadError } = await auth.admin
      .from("whatsapp_threads")
      .select("id, tenant_id")
      .or(`tenant_id.eq.${auth.membership.tenant_id},tenant_id.is.null`)
      .eq("id", parsed.data.thread_id)
      .maybeSingle();
    if (threadError) {
      return sanitizedErrorResponse(threadError, {
        status: 500,
        fallback: "Impossibile eliminare la conversazione.",
        event: "whatsapp_inbox_delete_lookup_failed",
        tenantId: auth.membership.tenant_id,
        details: { threadId: parsed.data.thread_id },
      });
    }
    if (!thread?.id) return NextResponse.json({ error: "Conversazione non trovata" }, { status: 404 });

    const { data: messageRows, error: messageRowsError } = await auth.admin
      .from("whatsapp_messages")
      .select("wa_message_id")
      .or(`tenant_id.eq.${auth.membership.tenant_id},tenant_id.is.null`)
      .eq("thread_id", thread.id);
    if (messageRowsError) {
      return sanitizedErrorResponse(messageRowsError, {
        status: 500,
        fallback: "Impossibile eliminare la conversazione.",
        event: "whatsapp_inbox_delete_messages_lookup_failed",
        tenantId: auth.membership.tenant_id,
        details: { threadId: thread.id },
      });
    }

    const waMessageIds = Array.from(new Set((messageRows ?? []).map((row) => row.wa_message_id).filter(Boolean) as string[]));
    if (waMessageIds.length > 0) {
      const { error: statusDeleteError } = await auth.admin
        .from("whatsapp_message_statuses")
        .delete()
        .eq("tenant_id", auth.membership.tenant_id)
        .in("wa_message_id", waMessageIds);
      if (statusDeleteError) {
        return sanitizedErrorResponse(statusDeleteError, {
          status: 500,
          fallback: "Impossibile eliminare la conversazione.",
          event: "whatsapp_inbox_delete_statuses_failed",
          tenantId: auth.membership.tenant_id,
          details: { threadId: thread.id },
        });
      }
    }

    const { error: messagesDeleteError } = await auth.admin
      .from("whatsapp_messages")
      .delete()
      .or(`tenant_id.eq.${auth.membership.tenant_id},tenant_id.is.null`)
      .eq("thread_id", thread.id);
    if (messagesDeleteError) {
      return sanitizedErrorResponse(messagesDeleteError, {
        status: 500,
        fallback: "Impossibile eliminare la conversazione.",
        event: "whatsapp_inbox_delete_messages_failed",
        tenantId: auth.membership.tenant_id,
        details: { threadId: thread.id },
      });
    }

    const { error: threadDeleteError } = await auth.admin
      .from("whatsapp_threads")
      .delete()
      .or(`tenant_id.eq.${auth.membership.tenant_id},tenant_id.is.null`)
      .eq("id", thread.id);
    if (threadDeleteError) {
      return sanitizedErrorResponse(threadDeleteError, {
        status: 500,
        fallback: "Impossibile eliminare la conversazione.",
        event: "whatsapp_inbox_delete_thread_failed",
        tenantId: auth.membership.tenant_id,
        details: { threadId: thread.id },
      });
    }

    return NextResponse.json({ ok: true });
  }

  if (parsed.data.action === "rename_contact") {
    const contactName = parsed.data.contact_name?.trim() || null;
    const { data: thread, error: threadError } = await auth.admin
      .from("whatsapp_threads")
      .select("id, contact_id")
      .or(`tenant_id.eq.${auth.membership.tenant_id},tenant_id.is.null`)
      .eq("id", parsed.data.thread_id)
      .maybeSingle();
    if (threadError) {
      return sanitizedErrorResponse(threadError, {
        status: 500,
        fallback: "Impossibile rinominare il contatto.",
        event: "whatsapp_inbox_rename_contact_lookup_failed",
        tenantId: auth.membership.tenant_id,
        details: { threadId: parsed.data.thread_id },
      });
    }
    if (!thread?.id) return NextResponse.json({ error: "Conversazione non trovata" }, { status: 404 });
    if (!thread.contact_id) return NextResponse.json({ error: "Contatto non trovato per questa conversazione" }, { status: 404 });
    const { error } = await auth.admin
      .from("whatsapp_contacts")
      .update({ manual_contact_name: contactName, updated_at: new Date().toISOString() })
      .or(`tenant_id.eq.${auth.membership.tenant_id},tenant_id.is.null`)
      .eq("id", thread.contact_id);
    if (error) {
      return sanitizedErrorResponse(error, {
        status: 500,
        fallback: "Impossibile rinominare il contatto.",
        event: "whatsapp_inbox_rename_contact_update_failed",
        tenantId: auth.membership.tenant_id,
        details: { threadId: thread.id },
      });
    }
    return NextResponse.json({ ok: true });
  }

  if (parsed.data.action === "update_phone") {
    let normalizedPhone: string;
    try {
      normalizedPhone = normalizeE164(parsed.data.phone ?? "");
    } catch (error) {
      return NextResponse.json({
        error: error instanceof Error ? error.message : "Inserisci il numero in formato internazionale con prefisso (es. +39 392 4425299)."
      }, { status: 400 });
    }
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
    if (threadError) {
      return sanitizedErrorResponse(threadError, {
        status: 500,
        fallback: "Impossibile aggiornare il numero di telefono.",
        event: "whatsapp_inbox_update_phone_lookup_failed",
        tenantId: auth.membership.tenant_id,
        details: { threadId: parsed.data.thread_id },
      });
    }
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
    if (contactError) {
      return sanitizedErrorResponse(contactError, {
        status: 500,
        fallback: "Impossibile aggiornare il numero di telefono.",
        event: "whatsapp_inbox_update_phone_contact_failed",
        tenantId: auth.membership.tenant_id,
        details: { threadId: thread.id },
      });
    }

    const { error: threadUpdateError } = await auth.admin
      .from("whatsapp_threads")
      .update({ wa_id: nextWaId, phone_e164: normalizedPhone, updated_at: updateTimestamp })
      .or(`tenant_id.eq.${auth.membership.tenant_id},tenant_id.is.null`)
      .eq("id", thread.id);
    if (threadUpdateError) {
      return sanitizedErrorResponse(threadUpdateError, {
        status: 500,
        fallback: "Impossibile aggiornare il numero di telefono.",
        event: "whatsapp_inbox_update_phone_thread_failed",
        tenantId: auth.membership.tenant_id,
        details: { threadId: thread.id },
      });
    }

    const { error: messagesUpdateError } = await auth.admin
      .from("whatsapp_messages")
      .update({ wa_id: nextWaId, phone_e164: normalizedPhone })
      .or(`tenant_id.eq.${auth.membership.tenant_id},tenant_id.is.null`)
      .eq("thread_id", thread.id);
    if (messagesUpdateError) {
      return sanitizedErrorResponse(messagesUpdateError, {
        status: 500,
        fallback: "Impossibile aggiornare il numero di telefono.",
        event: "whatsapp_inbox_update_phone_messages_failed",
        tenantId: auth.membership.tenant_id,
        details: { threadId: thread.id },
      });
    }

    if (thread.booking_id) {
      const { error: serviceUpdateError } = await auth.admin
        .from("services")
        .update({ phone: normalizedPhone, phone_e164: normalizedPhone })
        .eq("tenant_id", auth.membership.tenant_id)
        .eq("id", thread.booking_id);
      if (serviceUpdateError) {
        return sanitizedErrorResponse(serviceUpdateError, {
          status: 500,
          fallback: "Impossibile aggiornare il numero di telefono.",
          event: "whatsapp_inbox_update_phone_service_failed",
          tenantId: auth.membership.tenant_id,
          details: { threadId: thread.id },
        });
      }
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

  if (error) {
    return sanitizedErrorResponse(error, {
      status: 500,
      fallback: "Impossibile aggiornare la conversazione.",
      event: "whatsapp_inbox_update_status_failed",
      tenantId: auth.membership.tenant_id,
      details: { threadId: parsed.data.thread_id, action: parsed.data.action },
    });
  }
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
    if (threadError) {
      return sanitizedErrorResponse(threadError, {
        status: 500,
        fallback: "Impossibile caricare la conversazione.",
        event: "whatsapp_inbox_send_thread_lookup_failed",
        tenantId,
        details: { threadId: parsed.data.thread_id },
      });
    }
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
    } catch (error) {
      return NextResponse.json({
        error: error instanceof Error ? error.message : "Numero non valido. Usa il formato +393391234567 o 3391234567."
      }, { status: 400 });
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
      return sanitizedErrorResponse(latestInboundError, {
        status: 500,
        fallback: "Impossibile verificare la finestra di invio.",
        event: "whatsapp_inbox_send_window_check_failed",
        tenantId,
        details: { threadId: thread.id },
      });
    }

    const lastInboundAt = latestInbound?.timestamp ?? latestInbound?.created_at ?? null;
    if (!isWhatsAppCustomerCareWindowOpen(lastInboundAt)) {
      return NextResponse.json({
        ok: false,
        code: "WHATSAPP_CUSTOMER_CARE_WINDOW_CLOSED",
        error: WHATSAPP_WINDOW_CLOSED_ERROR,
        conversation_window: {
          is_open: false,
          last_inbound_at: lastInboundAt
        }
      }, { status: 409 });
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
    if (tplError) {
      return sanitizedErrorResponse(tplError, {
        status: 500,
        fallback: "Impossibile caricare il template WhatsApp.",
        event: "whatsapp_inbox_send_template_lookup_failed",
        tenantId,
        details: { threadId: thread.id, templateName },
      });
    }
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
  const sendResult = await (async () => {
    try {
      return attachment
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
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : "Invio WhatsApp non riuscito",
        phoneE164: targetPhone,
        internalError: true as const
      };
    }
  })();

  if (!sendResult.ok) {
    const failurePreview = failedOutboundPreview({
      mode: sendMode,
      text,
      templateBodyText,
      templateName,
      attachment
    });
    const failedMessagePayload = {
      tenant_id: thread.tenant_id ?? tenantId,
      wa_message_id: null,
      direction: "outbound" as const,
      wa_id: thread.wa_id,
      phone_e164: sendResult.phoneE164,
      contact_id: thread.contact_id ?? null,
      thread_id: thread.id,
      customer_id: thread.customer_id ?? null,
      booking_id: thread.booking_id ?? null,
      transfer_id: thread.transfer_id ?? null,
      message_type: attachment ? "document" : sendMode === "template" ? "template" : "text",
      template_name: templateName,
      reply_to_wa_message_id: null,
      text_body: sendMode === "template" ? (templateBodyText ?? failurePreview) : (text || failurePreview),
      media_id: null,
      media_mime_type: attachment ? attachment.type || "application/octet-stream" : null,
      media_sha256: null,
      status: "failed",
      timestamp: nowIso,
      raw_message: {
        error: sendResult.error ?? "Invio WhatsApp non riuscito",
        type: sendMode,
        source: attachment ? "manual_attachment" : sendMode === "template" ? "manual_template" : "manual_reply",
        template: sendMode === "template" ? {
          name: templateName,
          language: { code: templateLang },
          parameters: templateVariables
        } : null,
        attachment: attachment ? {
          filename: attachment.name || null,
          mime_type: attachment.type || "application/octet-stream",
          size: attachment.size
        } : null
      }
    };
    const { error: failedInsertError } = await auth.admin.from("whatsapp_messages").insert(failedMessagePayload);
    if (failedInsertError) {
      console.error("WhatsApp inbox failed reply persistence failed", {
        hasWaId: Boolean(thread.wa_id),
        normalizedPhonePresent: Boolean(sendResult.phoneE164),
        sendError: sendResult.error ?? "unknown",
        persistError: failedInsertError.message
      });
    }
    const { error: failedThreadError } = await auth.admin
      .from("whatsapp_threads")
      .update({
        phone_e164: sendResult.phoneE164,
        last_message_at: nowIso,
        last_message_preview: failurePreview,
        unread_count: 0,
        status: "open",
        match_status: thread.match_status === "matched" ? "matched" : "needs_review",
        updated_at: nowIso
      })
      .or(`tenant_id.eq.${tenantId},tenant_id.is.null`)
      .eq("id", thread.id);
    if (failedThreadError) {
      console.warn("WhatsApp inbox failed reply thread update failed", {
        hasWaId: Boolean(thread.wa_id),
        normalizedPhonePresent: Boolean(sendResult.phoneE164),
        error: failedThreadError.message
      });
    }
    await logWhatsAppEvent(auth.admin, {
      tenant_id: tenantId,
      service_id: thread.booking_id ?? null,
      to_phone: sendResult.phoneE164,
      kind: "manual",
      template: templateName,
      status: "failed",
      provider_message_id: null,
      happened_at: nowIso,
      payload_json: {
        source: "api/ops/whatsapp-inbox",
        mode: attachment ? "manual_attachment" : sendMode === "template" ? "manual_template" : "manual_reply",
        error: sendResult.error ?? "Invio WhatsApp non riuscito",
        template_language: sendMode === "template" ? templateLang : null,
        template_variables: sendMode === "template" ? templateVariables : [],
        thread_id: thread.id
      }
    });
    console.error("WhatsApp inbox reply failed", {
      hasWaId: Boolean(thread.wa_id),
      normalizedPhonePresent: Boolean(sendResult.phoneE164),
      error: sendResult.error ?? "unknown",
      mode: sendMode
    });
    if ("internalError" in sendResult && sendResult.internalError) {
      return sanitizedErrorResponse(new Error(sendResult.error ?? "Invio WhatsApp non riuscito"), {
        status: 502,
        fallback: "Invio WhatsApp non riuscito.",
        event: "whatsapp_inbox_send_internal_error",
        tenantId,
        details: { threadId: thread.id, mode: sendMode },
      });
    }
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
    console.warn("WhatsApp inbox reply thread update failed (non-fatal)", {
      hasWaId: Boolean(thread.wa_id),
      normalizedPhonePresent: Boolean(sendResult.phoneE164),
      error: updateError.message,
      code: updateError.code ?? null
    });
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
