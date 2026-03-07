import { createClient } from "@supabase/supabase-js";

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
}

export interface ReminderMessageContext {
  meetingPoint?: string | null;
  driverPhone?: string | null;
  vehicleLabel?: string | null;
  plate?: string | null;
}

export interface TenantWhatsAppSettings {
  default_template: string;
  template_language: string;
  enable_2h_reminder: boolean;
  allow_text_fallback: boolean;
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

export interface WhatsAppEventInsert {
  tenant_id: string;
  service_id: string | null;
  to_phone: string;
  kind?: "24h" | "2h" | "24h_reminder" | "manual" | "webhook" | null;
  template: string | null;
  status: WhatsAppEventStatus;
  provider_message_id: string | null;
  happened_at: string;
  payload_json?: Record<string, unknown>;
}

function mustEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

export function createAdminClient() {
  const supabaseUrl = mustEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRole = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

export function normalizeE164(input: string, defaultCountryCode = "+39") {
  const compact = input.replace(/[^\d+]/g, "");
  if (compact.startsWith("+")) return compact;
  if (compact.startsWith("00")) return `+${compact.slice(2)}`;
  if (compact.startsWith("0")) return `${defaultCountryCode}${compact.slice(1)}`;
  return `${defaultCountryCode}${compact}`;
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
    allow_text_fallback: (process.env.WHATSAPP_ALLOW_TEXT_FALLBACK ?? "false").toLowerCase() === "true"
  };

  const { data } = await admin
    .from("tenant_whatsapp_settings")
    .select("default_template, template_language, enable_2h_reminder, allow_text_fallback")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (!data) return fallback;
  return {
    default_template: data.default_template || fallback.default_template,
    template_language: normalizeLanguageCode(data.template_language || fallback.template_language),
    enable_2h_reminder: Boolean(data.enable_2h_reminder),
    allow_text_fallback: Boolean(data.allow_text_fallback)
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

async function sendTemplateMessage(phoneNumberId: string, accessToken: string, toPhone: string, templateName: string, languageCode: string, parameters: Array<{ type: "text"; text: string }>) {
  const response = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toPhone,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        components: [{ type: "body", parameters }]
      }
    })
  });

  const payload = (await response.json().catch(() => null)) as
    | {
        messages?: Array<{ id: string }>;
        error?: { message?: string };
      }
    | null;

  return {
    ok: response.ok,
    messageId: payload?.messages?.[0]?.id ?? null,
    error: payload?.error?.message ?? (response.ok ? null : `WhatsApp API error (${response.status})`)
  };
}

export async function sendWhatsAppMessage(input: SendWhatsAppMessageInput) {
  const phoneNumberId = mustEnv("WHATSAPP_PHONE_NUMBER_ID");
  const accessToken = mustEnv("WHATSAPP_TOKEN");
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

async function sendTextMessage(phoneNumberId: string, accessToken: string, toPhone: string, textBody: string) {
  const response = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toPhone,
      type: "text",
      text: { body: textBody.slice(0, 4096), preview_url: false }
    })
  });

  const payload = (await response.json().catch(() => null)) as
    | {
        messages?: Array<{ id: string }>;
        error?: { message?: string };
      }
    | null;

  return {
    ok: response.ok,
    messageId: payload?.messages?.[0]?.id ?? null,
    error: payload?.error?.message ?? (response.ok ? null : `WhatsApp API error (${response.status})`)
  };
}

export async function sendWhatsAppReminder(
  service: ServiceReminderRecord,
  hotelName?: string,
  context?: ReminderMessageContext,
  options?: SendReminderOptions
) {
  const phoneNumberId = mustEnv("WHATSAPP_PHONE_NUMBER_ID");
  const accessToken = mustEnv("WHATSAPP_TOKEN");
  const templateName = options?.templateName ?? process.env.WHATSAPP_TEMPLATE_NAME ?? "transfer_reminder";
  const languageCode = normalizeLanguageCode(options?.languageCode ?? process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? "it");
  const allowTextFallback = Boolean(options?.allowTextFallback);

  const toPhone = service.phone_e164 ?? normalizeE164(service.phone);
  const details = compactDetails(context);
  const hotelLine = details ? `${hotelName ?? "hotel"} | ${details}` : hotelName ?? "hotel";
  const vesselLine = details ? `${service.vessel} | ${details}` : service.vessel;
  const templateAttempt = await sendTemplateMessage(phoneNumberId, accessToken, toPhone, templateName, languageCode, [
    { type: "text", text: service.customer_name },
    { type: "text", text: service.date },
    { type: "text", text: service.time.slice(0, 5) },
    { type: "text", text: hotelLine.slice(0, 1024) },
    { type: "text", text: vesselLine.slice(0, 1024) }
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

  const plainText = [
    `Ciao ${service.customer_name},`,
    `promemoria transfer ${service.date} ${service.time.slice(0, 5)}.`,
    `Hotel/meeting: ${hotelLine}`,
    `Dettagli nave: ${vesselLine}`
  ].join("\n");
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
