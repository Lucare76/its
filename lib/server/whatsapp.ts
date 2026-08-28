import { createClient } from "@supabase/supabase-js";
import { isWhatsAppConversationWindowOpen } from "@/lib/whatsapp-conversation-window";

export type ReminderStatus = "pending" | "sent" | "delivered" | "read" | "failed";
export type WhatsAppEventStatus = "queued" | "sent" | "delivered" | "read" | "failed";

export interface ServiceReminderRecord {
  id: string;
  tenant_id: string;
  date: string;
  time: string;
  customer_name: string;
  phone: string;
  phone_e164: string | null;
  reminder_status: ReminderStatus | null;
  message_id: string | null;
  sent_at: string | null;
  hotel_id: string;
  vessel: string;
  meeting_point?: string | null;
  bus_plate?: string | null;
  notes?: string | null;
  // Campi per partenze (Rete Ischia → Bruno)
  direction?: string | null;
  place_type?: string | null;
  pickup_hotel?: string | null;   // orario prelievo hotel (HH:MM)
  barca_compagnia?: string | null;
  orario_barca?: string | null;
  porto_bruno?: string | null;
  pickup_alert?: string | null;
}

export interface ReminderMessageContext {
  meetingPoint?: string | null;
  driverPhone?: string | null;
  vehicleLabel?: string | null;
  plate?: string | null;
  trackingUrl?: string | null;
}

export interface TenantWhatsAppSettings {
  default_template: string;
  template_language: string;
  enable_2h_reminder: boolean;
  allow_text_fallback: boolean;
  enable_arrival_messages: boolean;
  arrival_template: string;
  arrival_notice_minutes: number;
  bus_convocazioni_send_hour: number;
}

export interface SendReminderOptions {
  templateName?: string;
  languageCode?: string;
  allowTextFallback?: boolean;
}

export interface SendWhatsAppMessageInput {
  to: string;
  template: string;
  variables: Record<string, string>;
  languageCode?: string;
}

export interface SendWhatsAppTextInput {
  to: string;
  text: string;
  replyToMessageId?: string | null;
}

export interface SendWhatsAppMediaInput {
  to: string;
  file: Blob;
  filename: string;
  mimeType: string;
  caption?: string | null;
}

export interface MetaWhatsAppTemplateComponent {
  type?: string;
  format?: string | null;
  text?: string | null;
}

export interface MetaWhatsAppTemplateSummary {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string | null;
  components: MetaWhatsAppTemplateComponent[];
}

export interface SyncedWhatsAppTemplateRow {
  id: string;
  tenant_id: string;
  meta_template_id: string;
  name: string;
  language_code: string;
  status: string;
  category: string | null;
  header_format: string | null;
  body_text: string | null;
  body_parameter_count: number;
  raw_json: Record<string, unknown>;
  synced_at: string;
  updated_at: string;
  created_at: string;
}

export interface WhatsAppGraphResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
}

export interface WhatsAppMediaMetadata {
  id: string;
  url: string;
  mime_type?: string | null;
  sha256?: string | null;
  file_size?: number | null;
}

export interface WhatsAppEventInsert {
  tenant_id: string;
  service_id: string | null;
  to_phone: string;
  kind?: "24h" | "2h" | "48h_departure" | "24h_reminder" | "info_3d" | "manual" | "webhook" | "bus_convocazione" | "medmar_convocazione" | null;
  template: string | null;
  status: WhatsAppEventStatus;
  provider_message_id: string | null;
  happened_at: string;
  payload_json?: Record<string, unknown>;
}

function mustEnv(name: string) {
  const value = process.env[name]?.trim().replace(/^["']|["']$/g, "");
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

export function whatsappAccessToken() {
  return process.env.WHATSAPP_ACCESS_TOKEN?.trim().replace(/^["']|["']$/g, "") || mustEnv("WHATSAPP_TOKEN");
}

export function whatsappGraphVersion() {
  return process.env.WHATSAPP_GRAPH_API_VERSION?.trim().replace(/^["']|["']$/g, "") || "v23.0";
}

export function getWhatsAppBusinessAccountId() {
  return mustEnv("WHATSAPP_BUSINESS_ACCOUNT_ID");
}

export function getWhatsAppPhoneNumberId() {
  return mustEnv("WHATSAPP_PHONE_NUMBER_ID");
}

export function createAdminClient() {
  const supabaseUrl = mustEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRole = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

export function normalizeE164(input: string, defaultCountryCode = "+39") {
  let cleaned = input.trim().replace(/[\s\-().]/g, "");
  if (!cleaned) throw new Error("Numero non valido");
  if (!/^\+?\d+$/.test(cleaned)) throw new Error("Numero non valido");

  if (cleaned.startsWith("00")) {
    cleaned = `+${cleaned.slice(2)}`;
  }

  if (!cleaned.startsWith("+")) {
    const defaultCountryDigits = defaultCountryCode.replace(/\D/g, "");
    if (defaultCountryDigits && defaultCountryDigits !== "39") {
      cleaned = `+${defaultCountryDigits}${cleaned.replace(/^0+/, "")}`;
    } else if (/^3\d{9}$/.test(cleaned)) {
      cleaned = `+39${cleaned}`;
    } else if (defaultCountryDigits && cleaned.startsWith(defaultCountryDigits) && cleaned.length >= defaultCountryDigits.length + 7) {
      cleaned = `+${cleaned}`;
    } else {
      cleaned = `+${cleaned}`;
    }
  }

  if (!/^\+\d{7,15}$/.test(cleaned)) {
    throw new Error("Numero non valido");
  }

  return cleaned;
}

export function normalizeWhatsAppWaId(input: string) {
  const compact = input.replace(/[^\d+]/g, "");
  if (compact.startsWith("+")) return compact;
  if (compact.startsWith("00")) return `+${compact.slice(2)}`;
  return compact ? `+${compact}` : "";
}

function parseDateTime(date: string, time: string) {
  const normalizedTime = time.length >= 5 ? time.slice(0, 5) : "00:00";
  return new Date(`${date}T${normalizedTime}:00`);
}

function normalizeLanguageCode(code?: string | null) {
  const trimmed = (code ?? "").trim();
  if (!trimmed) return "it";
  return trimmed.replace("-", "_");
}

export async function getTenantWhatsAppSettings(admin: ReturnType<typeof createAdminClient>, tenantId: string): Promise<TenantWhatsAppSettings> {
  const fallback: TenantWhatsAppSettings = {
    default_template: process.env.WHATSAPP_TEMPLATE_NAME ?? "transfer_reminder",
    template_language: normalizeLanguageCode(process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? "it"),
    enable_2h_reminder: (process.env.WHATSAPP_REMINDER_2H_ENABLED ?? "false").toLowerCase() === "true",
    allow_text_fallback: (process.env.WHATSAPP_ALLOW_TEXT_FALLBACK ?? "false").toLowerCase() === "true",
    enable_arrival_messages: false,
    arrival_template: "arrival_welcome",
    arrival_notice_minutes: 90,
    bus_convocazioni_send_hour: 13
  };

  const { data } = await admin
    .from("tenant_whatsapp_settings")
    .select("default_template, template_language, enable_2h_reminder, allow_text_fallback, enable_arrival_messages, arrival_template, arrival_notice_minutes, bus_convocazioni_send_hour")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (!data) return fallback;
  return {
    default_template: data.default_template || fallback.default_template,
    template_language: normalizeLanguageCode(data.template_language || fallback.template_language),
    enable_2h_reminder: Boolean(data.enable_2h_reminder),
    allow_text_fallback: Boolean(data.allow_text_fallback),
    enable_arrival_messages: Boolean(data.enable_arrival_messages),
    arrival_template: data.arrival_template || fallback.arrival_template,
    arrival_notice_minutes:
      typeof data.arrival_notice_minutes === "number" && Number.isFinite(data.arrival_notice_minutes)
        ? data.arrival_notice_minutes
        : fallback.arrival_notice_minutes,
    bus_convocazioni_send_hour:
      typeof (data as Record<string, unknown>).bus_convocazioni_send_hour === "number"
        ? (data as Record<string, unknown>).bus_convocazioni_send_hour as number
        : fallback.bus_convocazioni_send_hour
  };
}

function compactDetails(context?: ReminderMessageContext) {
  const details: string[] = [];
  if (context?.meetingPoint?.trim()) details.push(`Meeting: ${context.meetingPoint.trim()}`);
  if (context?.vehicleLabel?.trim()) details.push(`Mezzo: ${context.vehicleLabel.trim()}`);
  if (context?.plate?.trim()) details.push(`Targa: ${context.plate.trim()}`);
  if (context?.driverPhone?.trim()) details.push(`Tel autista: ${context.driverPhone.trim()}`);
  return details.join(" | ");
}

export function extractDriverPhoneFromNotes(notes?: string | null) {
  if (!notes) return null;
  const patterns = [
    /(?:driver[_\s-]?phone|telefono[_\s-]?autista|tel[_\s-]?autista)\s*[:=]\s*(\+?\d[\d\s-]{6,})/i,
    /\bautista\b.*?(\+?\d[\d\s-]{6,})/i
  ];
  for (const pattern of patterns) {
    const match = notes.match(pattern)?.[1];
    if (match) return match.replace(/\s+/g, " ").trim();
  }
  return null;
}

export function isReminderDueInWindow(date: string, time: string, targetHours: number, windowMinutes: number, now = new Date()) {
  const serviceAt = parseDateTime(date, time);
  const diffMinutes = (serviceAt.getTime() - now.getTime()) / 60000;
  const targetMinutes = targetHours * 60;
  const tolerance = Math.max(5, Math.floor(windowMinutes));
  return diffMinutes >= targetMinutes - tolerance && diffMinutes <= targetMinutes + tolerance;
}

export function isWhatsAppCustomerCareWindowOpen(lastInboundAt: string | null | undefined, now = new Date()) {
  return isWhatsAppConversationWindowOpen(lastInboundAt, now);
}

export async function fetchWhatsAppMediaMetadata(mediaId: string): Promise<WhatsAppGraphResult<WhatsAppMediaMetadata>> {
  const accessToken = whatsappAccessToken();
  const graphVersion = whatsappGraphVersion();
  const response = await fetch(`https://graph.facebook.com/${graphVersion}/${mediaId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
  });

  let data: WhatsAppMediaMetadata | null = null;
  let error: string | null = null;
  try {
    const json = await response.json();
    if (response.ok) {
      data = {
        id: String(json.id ?? mediaId),
        url: String(json.url ?? ""),
        mime_type: typeof json.mime_type === "string" ? json.mime_type : null,
        sha256: typeof json.sha256 === "string" ? json.sha256 : null,
        file_size: typeof json.file_size === "number" ? json.file_size : null,
      };
      if (!data.url) {
        error = "URL media WhatsApp non disponibile.";
      }
    } else {
      error = typeof json?.error?.message === "string" ? json.error.message : "Errore recupero media WhatsApp.";
    }
  } catch {
    error = response.ok ? "Risposta media WhatsApp non valida." : "Errore recupero media WhatsApp.";
  }

  return {
    ok: response.ok && Boolean(data?.url) && !error,
    status: response.status,
    data,
    error,
  };
}

export async function downloadWhatsAppMedia(mediaId: string) {
  const metadata = await fetchWhatsAppMediaMetadata(mediaId);
  if (!metadata.ok || !metadata.data?.url) {
    return {
      ok: false as const,
      status: metadata.status || 502,
      error: metadata.error ?? "Media WhatsApp non disponibile.",
    };
  }

  const accessToken = whatsappAccessToken();
  const response = await fetch(metadata.data.url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    let error = "Download allegato WhatsApp non riuscito.";
    try {
      const json = await response.json();
      error = typeof json?.error?.message === "string" ? json.error.message : error;
    } catch {
      // ignore non-json body
    }
    return {
      ok: false as const,
      status: response.status,
      error,
    };
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    ok: true as const,
    status: 200,
    data: {
      bytes: Buffer.from(arrayBuffer),
      mimeType: response.headers.get("content-type") ?? metadata.data.mime_type ?? "application/octet-stream",
      metadata: metadata.data,
    },
  };
}

async function sendTemplateMessage(phoneNumberId: string, accessToken: string, toPhone: string, templateName: string, languageCode: string, parameters: Array<{ type: "text"; text: string }>) {
  const template: {
    name: string;
    language: { code: string };
    components?: Array<{ type: "body"; parameters: Array<{ type: "text"; text: string }> }>;
  } = {
    name: templateName,
    language: { code: languageCode }
  };
  if (parameters.length > 0) {
    template.components = [{ type: "body", parameters }];
  }

  const response = await fetch(`https://graph.facebook.com/${whatsappGraphVersion()}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toPhone,
      type: "template",
      template
    })
  });

  const payload = (await response.json().catch(() => null)) as
    | {
        messages?: Array<{ id: string }>;
        error?: { message?: string; code?: number | string; error_data?: { details?: string } };
      }
    | null;
  const errorParts = [
    payload?.error?.message,
    payload?.error?.error_data?.details,
    payload?.error?.code != null ? `code ${payload.error.code}` : null
  ].filter(Boolean);

  return {
    ok: response.ok,
    messageId: payload?.messages?.[0]?.id ?? null,
    error: errorParts.length > 0 ? errorParts.join(" - ") : response.ok ? null : `WhatsApp API error (${response.status})`
  };
}

export async function sendWhatsAppMessage(input: SendWhatsAppMessageInput) {
  const phoneNumberId = mustEnv("WHATSAPP_PHONE_NUMBER_ID");
  const accessToken = whatsappAccessToken();
  const toPhone = normalizeE164(input.to);
  const languageCode = normalizeLanguageCode(input.languageCode ?? process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? "it");
  const parameters = Object.values(input.variables).map((value) => ({
    type: "text" as const,
    text: String(value ?? "").slice(0, 1024)
  }));

  const response = await sendTemplateMessage(phoneNumberId, accessToken, toPhone, input.template, languageCode, parameters);
  if (!response.ok) {
    return {
      ok: false as const,
      error: response.error ?? "WhatsApp template send failed",
      phoneE164: toPhone
    };
  }

  return {
    ok: true as const,
    messageId: response.messageId,
    phoneE164: toPhone
  };
}

async function sendTextMessage(phoneNumberId: string, accessToken: string, toPhone: string, textBody: string, replyToMessageId?: string | null) {
  const context = replyToMessageId?.trim() ? { message_id: replyToMessageId.trim() } : undefined;
  const response = await fetch(`https://graph.facebook.com/${whatsappGraphVersion()}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toPhone,
      type: "text",
      ...(context ? { context } : {}),
      text: { body: textBody.slice(0, 4096), preview_url: false }
    })
  });

  const payload = (await response.json().catch(() => null)) as
    | {
        messages?: Array<{ id: string }>;
        error?: { message?: string; code?: number; error_subcode?: number; type?: string; fbtrace_id?: string };
      }
    | null;

  if (!response.ok) {
    console.error("Meta WhatsApp API error (text)", {
      status: response.status,
      code: payload?.error?.code,
      subcode: payload?.error?.error_subcode,
      type: payload?.error?.type,
      message: payload?.error?.message,
      fbtrace_id: payload?.error?.fbtrace_id,
      phoneNumberId,
      toPhone
    });
  }

  const metaError = payload?.error;
  const formattedError = response.ok
    ? null
    : metaError
      ? `[#${metaError.code ?? response.status}] ${metaError.message ?? "WhatsApp API error"}`
      : `WhatsApp API error (${response.status})`;

  return {
    ok: response.ok,
    messageId: payload?.messages?.[0]?.id ?? null,
    error: formattedError
  };
}

export async function listMetaWhatsAppTemplates() {
  const businessAccountId = getWhatsAppBusinessAccountId();
  const accessToken = whatsappAccessToken();
  const graphVersion = whatsappGraphVersion();

  const templates: MetaWhatsAppTemplateSummary[] = [];
  let nextUrl: string | null =
    `https://graph.facebook.com/${graphVersion}/${businessAccountId}/message_templates?fields=name,status,category,language,components&limit=100`;

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      cache: "no-store"
    });

    const payload = (await response.json().catch(() => null)) as
      | {
          data?: Array<{
            id?: string;
            name?: string;
            language?: string;
            status?: string;
            category?: string | null;
            components?: MetaWhatsAppTemplateComponent[];
          }>;
          paging?: { next?: string };
          error?: { message?: string };
        }
      | null;

    if (!response.ok) {
      const errMsg = payload?.error?.message ?? `WhatsApp template list failed (${response.status})`;
      const errCode = (payload?.error as { code?: number } | undefined)?.code;
      const errSubcode = (payload?.error as { error_subcode?: number } | undefined)?.error_subcode;
      throw new Error(`${errMsg} [code=${errCode ?? "?"} subcode=${errSubcode ?? "?"}] WABA_ID=${businessAccountId}`);
    }

    for (const item of payload?.data ?? []) {
      if (!item.id || !item.name || !item.language || !item.status) continue;
      templates.push({
        id: item.id,
        name: item.name,
        language: item.language,
        status: item.status,
        category: item.category ?? null,
        components: item.components ?? []
      });
    }

    nextUrl = payload?.paging?.next ?? null;
  }

  return templates;
}

export async function fetchWhatsAppGraph<T = unknown>(pathOrUrl: string) {
  const accessToken = whatsappAccessToken();
  const graphVersion = whatsappGraphVersion();
  const url = pathOrUrl.startsWith("https://")
    ? pathOrUrl
    : `https://graph.facebook.com/${graphVersion}/${pathOrUrl.replace(/^\//, "")}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    cache: "no-store"
  });

  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: { message?: string } })
    | null;

  return {
    ok: response.ok,
    status: response.status,
    data: response.ok ? ((payload as T | null) ?? null) : null,
    error: response.ok ? null : payload?.error?.message ?? `Graph API error (${response.status})`
  } satisfies WhatsAppGraphResult<T>;
}

export function countMetaBodyParameters(components: MetaWhatsAppTemplateComponent[]) {
  const bodyText = components.find((component) => component.type?.toUpperCase() === "BODY")?.text ?? "";
  const matches = Array.from(bodyText.matchAll(/\{\{(\d+)\}\}/g));
  const indexes = matches
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0);
  return indexes.length > 0 ? Math.max(...indexes) : 0;
}

export async function loadSyncedWhatsAppTemplates(admin: ReturnType<typeof createAdminClient>, tenantId: string) {
  const { data, error } = await admin
    .from("whatsapp_templates")
    .select("id, tenant_id, meta_template_id, name, language_code, status, category, header_format, body_text, body_parameter_count, raw_json, synced_at, updated_at, created_at")
    .eq("tenant_id", tenantId)
    .order("name", { ascending: true })
    .order("language_code", { ascending: true });

  if (error) throw error;
  return (data ?? []) as SyncedWhatsAppTemplateRow[];
}

export async function syncMetaWhatsAppTemplates(admin: ReturnType<typeof createAdminClient>, tenantId: string) {
  const templates = await listMetaWhatsAppTemplates();
  const nowIso = new Date().toISOString();
  const rows = templates.map((template) => ({
    tenant_id: tenantId,
    meta_template_id: template.id,
    name: template.name,
    language_code: template.language,
    status: template.status,
    category: template.category,
    header_format: template.components.find((component) => component.type?.toUpperCase() === "HEADER")?.format ?? null,
    body_text: template.components.find((component) => component.type?.toUpperCase() === "BODY")?.text ?? null,
    body_parameter_count: countMetaBodyParameters(template.components),
    raw_json: {
      id: template.id,
      name: template.name,
      language: template.language,
      status: template.status,
      category: template.category,
      components: template.components
    },
    synced_at: nowIso,
    updated_at: nowIso
  }));

  const { error } = await admin.from("whatsapp_templates").upsert(rows, {
    onConflict: "tenant_id,meta_template_id"
  });
  if (error) throw error;

  const remoteIds = templates.map((template) => template.id);
  const cleanupQuery = admin
    .from("whatsapp_templates")
    .delete()
    .eq("tenant_id", tenantId);

  const { error: cleanupError } = remoteIds.length > 0
    ? await cleanupQuery.not("meta_template_id", "in", `(${remoteIds.map((id) => `"${id}"`).join(",")})`)
    : await cleanupQuery;
  if (cleanupError) throw cleanupError;

  return loadSyncedWhatsAppTemplates(admin, tenantId);
}

function whatsappMediaMessageType(mimeType: string): "image" | "video" | "audio" | "document" {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}

function parseWhatsAppApiError(response: Response, payload: { error?: { message?: string; code?: number | string; error_data?: { details?: string } } } | null) {
  const parts = [
    payload?.error?.message,
    payload?.error?.error_data?.details,
    payload?.error?.code != null ? `code ${payload.error.code}` : null
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" - ") : `WhatsApp API error (${response.status})`;
}

async function uploadWhatsAppMedia(phoneNumberId: string, accessToken: string, file: Blob, filename: string, mimeType: string) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", file, filename || "allegato");
  form.append("type", mimeType || file.type || "application/octet-stream");

  const response = await fetch(`https://graph.facebook.com/${whatsappGraphVersion()}/${phoneNumberId}/media`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    body: form
  });
  const payload = (await response.json().catch(() => null)) as
    | { id?: string; error?: { message?: string; code?: number | string; error_data?: { details?: string } } }
    | null;

  return {
    ok: response.ok && Boolean(payload?.id),
    mediaId: payload?.id ?? null,
    error: response.ok && payload?.id ? null : parseWhatsAppApiError(response, payload)
  };
}

async function sendMediaMessage(
  phoneNumberId: string,
  accessToken: string,
  toPhone: string,
  mediaId: string,
  mediaType: "image" | "video" | "audio" | "document",
  options: { caption?: string | null; filename?: string | null }
) {
  const caption = options.caption?.trim().slice(0, 1024);
  const mediaPayload: Record<string, unknown> = { id: mediaId };
  if (caption && mediaType !== "audio") mediaPayload.caption = caption;
  if (mediaType === "document" && options.filename?.trim()) mediaPayload.filename = options.filename.trim().slice(0, 240);

  const response = await fetch(`https://graph.facebook.com/${whatsappGraphVersion()}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toPhone,
      type: mediaType,
      [mediaType]: mediaPayload
    })
  });
  const payload = (await response.json().catch(() => null)) as
    | { messages?: Array<{ id: string }>; error?: { message?: string; code?: number | string; error_data?: { details?: string } } }
    | null;

  return {
    ok: response.ok,
    messageId: payload?.messages?.[0]?.id ?? null,
    error: response.ok ? null : parseWhatsAppApiError(response, payload)
  };
}

export async function sendWhatsAppTextMessage(input: SendWhatsAppTextInput) {
  const phoneNumberId = mustEnv("WHATSAPP_PHONE_NUMBER_ID");
  const accessToken = whatsappAccessToken();
  const toPhone = normalizeE164(input.to);
  const textBody = String(input.text ?? "").trim().slice(0, 4096);

  if (!textBody) {
    return {
      ok: false as const,
      error: "Testo messaggio vuoto",
      phoneE164: toPhone
    };
  }

  const response = await sendTextMessage(phoneNumberId, accessToken, toPhone, textBody, input.replyToMessageId);
  if (!response.ok) {
    return {
      ok: false as const,
      error: response.error ?? "WhatsApp text send failed",
      phoneE164: toPhone
    };
  }

  return {
    ok: true as const,
    messageId: response.messageId,
    phoneE164: toPhone
  };
}

export async function sendWhatsAppMediaMessage(input: SendWhatsAppMediaInput) {
  const phoneNumberId = mustEnv("WHATSAPP_PHONE_NUMBER_ID");
  const accessToken = whatsappAccessToken();
  const toPhone = normalizeE164(input.to);
  const mimeType = input.mimeType || input.file.type || "application/octet-stream";
  const mediaType = whatsappMediaMessageType(mimeType);

  const upload = await uploadWhatsAppMedia(phoneNumberId, accessToken, input.file, input.filename, mimeType);
  if (!upload.ok || !upload.mediaId) {
    return {
      ok: false as const,
      error: upload.error ?? "Upload allegato WhatsApp non riuscito",
      phoneE164: toPhone
    };
  }

  const send = await sendMediaMessage(phoneNumberId, accessToken, toPhone, upload.mediaId, mediaType, {
    caption: input.caption,
    filename: input.filename
  });
  if (!send.ok) {
    return {
      ok: false as const,
      error: send.error ?? "Invio allegato WhatsApp non riuscito",
      phoneE164: toPhone,
      mediaId: upload.mediaId,
      mediaType
    };
  }

  return {
    ok: true as const,
    messageId: send.messageId,
    phoneE164: toPhone,
    mediaId: upload.mediaId,
    mediaType,
    mimeType
  };
}

export async function sendWhatsAppReminder(
  service: ServiceReminderRecord,
  hotelName?: string,
  context?: ReminderMessageContext,
  options?: SendReminderOptions
) {
  const phoneNumberId = mustEnv("WHATSAPP_PHONE_NUMBER_ID");
  const accessToken = whatsappAccessToken();
  const templateName = options?.templateName ?? process.env.WHATSAPP_TEMPLATE_NAME ?? "transfer_reminder";
  const languageCode = normalizeLanguageCode(options?.languageCode ?? process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? "it");
  const allowTextFallback = Boolean(options?.allowTextFallback);

  const toPhone = service.phone_e164 ?? normalizeE164(service.phone);
  const details = compactDetails(context);

  // Per le partenze verso stazione/aeroporto, l'orario importante è il pickup dall'hotel
  const isDepartureBruno = service.direction === "departure"
    && service.place_type != null
    && service.place_type !== "hotel"
    && service.pickup_hotel != null;

  const reminderTime = isDepartureBruno
    ? service.pickup_hotel!.slice(0, 5)
    : service.time.slice(0, 5);

  const hotelLine = isDepartureBruno
    ? `${hotelName ?? "hotel"} — prelievo ore ${reminderTime}`
    : (details ? `${hotelName ?? "hotel"} | ${details}` : hotelName ?? "hotel");

  // Per le partenze, arricchisce la riga traghetto con porto Bruno e orario imbarco
  const baseFerryLine = isDepartureBruno
    ? [
        service.barca_compagnia ?? service.vessel,
        service.orario_barca ? `ore ${service.orario_barca.slice(0, 5)}` : null,
        service.porto_bruno ? `da ${service.porto_bruno}` : null,
      ].filter(Boolean).join(" · ")
    : service.vessel;
  const vesselLine = details && !isDepartureBruno
    ? `${baseFerryLine} | ${details}`
    : baseFerryLine;

  const templateAttempt = await sendTemplateMessage(phoneNumberId, accessToken, toPhone, templateName, languageCode, [
    { type: "text", text: service.customer_name },
    { type: "text", text: service.date },
    { type: "text", text: reminderTime },
    { type: "text", text: hotelLine.slice(0, 1024) },
    { type: "text", text: vesselLine.slice(0, 1024) },
    { type: "text", text: (context?.trackingUrl ? `Segui il tuo autista in tempo reale:\n${context.trackingUrl}` : "").slice(0, 1024) }
  ]);

  if (templateAttempt.ok) {
    return {
      ok: true as const,
      messageId: templateAttempt.messageId,
      phoneE164: toPhone,
      templateName,
      languageCode,
      deliveryMode: "template" as const
    };
  }

  if (!allowTextFallback) {
    return {
      ok: false as const,
      error: templateAttempt.error ?? "WhatsApp template send failed",
      templateName,
      languageCode,
      phoneE164: toPhone,
      deliveryMode: "template" as const
    };
  }

  const plainText = isDepartureBruno
    ? [
        `Ciao ${service.customer_name},`,
        `ricorda: il ${service.date} alle ${reminderTime} saremo all'hotel per portarti al porto.`,
        `Traghetto: ${vesselLine}`,
        context?.trackingUrl ? `Segui il tuo autista in tempo reale:\n${context.trackingUrl}` : null,
        service.pickup_alert ? `⚠️ ${service.pickup_alert}` : null,
      ].filter(Boolean).join("\n")
    : [
        `Ciao ${service.customer_name},`,
        `promemoria transfer ${service.date} ${service.time.slice(0, 5)}.`,
        `Hotel/meeting: ${hotelLine}`,
        `Dettagli nave: ${vesselLine}`,
        context?.trackingUrl ? `Segui il tuo autista in tempo reale:\n${context.trackingUrl}` : null
      ].filter(Boolean).join("\n");
  const textAttempt = await sendTextMessage(phoneNumberId, accessToken, toPhone, plainText);

  if (!textAttempt.ok) {
    return {
      ok: false as const,
      error: textAttempt.error ?? templateAttempt.error ?? "WhatsApp send failed",
      templateName,
      languageCode,
      phoneE164: toPhone,
      deliveryMode: "text" as const
    };
  }

  return {
    ok: true as const,
    messageId: textAttempt.messageId,
    phoneE164: toPhone,
    templateName,
    languageCode,
    deliveryMode: "text" as const
  };
}

export function selectInfoTemplate(
  bookingKind: string | null | undefined,
  lang: string = "it"
): { templateName: string; parameters: string[]; hasQrHeader?: boolean; needsDate?: boolean } | null {
  const suffix     = lang === "en" ? "_en" : "";
  const aeroporto  = (process.env.WHATSAPP_TEMPLATE_INFO_AEROPORTO ?? "its_info_aeroporto") + suffix;
  const stazione   = (process.env.WHATSAPP_TEMPLATE_INFO_STAZIONE  ?? "its_info_stazione")  + suffix;
  const medmar     = (process.env.WHATSAPP_TEMPLATE_INFO_MEDMAR    ?? "its_info_medmar")    + suffix;
  const snav       = (process.env.WHATSAPP_TEMPLATE_INFO_SNAV      ?? "its_info_snav")      + suffix;

  switch (bookingKind) {
    case "transfer_airport_hotel":
      return { templateName: aeroporto, parameters: [] };
    case "transfer_train_hotel":
    case "transfer_station_hotel":
      return { templateName: stazione, parameters: [] };
    case "formula_medmar_napoli":
      return { templateName: medmar, parameters: [lang === "en" ? "Naples (Beverello)" : "Napoli Beverello"] };
    case "formula_medmar_pozzuoli":
      return { templateName: medmar, parameters: ["Pozzuoli"] };
    case "formula_snav":
      return { templateName: snav, parameters: [] };
    case "bus_city_hotel": {
      const busName = (process.env.WHATSAPP_TEMPLATE_INFO_BUS ?? "its_qr_bus") + suffix;
      // {{2}} = data servizio — passata dal cron
      return { templateName: busName, parameters: [], hasQrHeader: true, needsDate: true };
    }
    default:
      return null;
  }
}

export function isReminderDueIn24h(date: string, time: string, now = new Date()) {
  return isReminderDueInWindow(date, time, 24, 30, now);
}

export function mapWebhookStatus(status: string): Exclude<ReminderStatus, "pending"> | null {
  if (status === "sent") return "sent";
  if (status === "delivered") return "delivered";
  if (status === "read") return "read";
  if (status === "failed") return "failed";
  return null;
}

export async function logWhatsAppEvent(admin: ReturnType<typeof createAdminClient>, event: WhatsAppEventInsert) {
  await admin.from("whatsapp_events").insert({
    tenant_id: event.tenant_id,
    service_id: event.service_id,
    to_phone: event.to_phone,
    kind: event.kind ?? null,
    template: event.template,
    status: event.status,
    provider_message_id: event.provider_message_id,
    happened_at: event.happened_at,
    payload_json: event.payload_json ?? {}
  });
}
