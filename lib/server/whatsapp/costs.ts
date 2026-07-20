import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchWhatsAppGraph, getWhatsAppBusinessAccountId } from "@/lib/server/whatsapp";
import type { MetaStatus } from "./types";

export type WhatsAppCostStatus = "pending" | "free" | "estimated" | "missing_rate" | "failed";

type StoredMessage = {
  id: string;
  tenant_id: string | null;
  direction: string | null;
  phone_e164: string | null;
  wa_id: string | null;
  booking_id: string | null;
  transfer_id: string | null;
  template_name: string | null;
  message_type: string | null;
};

type CostEventRow = {
  id: string;
  status: string | null;
  status_timestamp: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  failed_at: string | null;
  billable: boolean | null;
  pricing_category: string | null;
  pricing_model: string | null;
  pricing_type: string | null;
  estimated_cost: number | null;
  estimated_currency: string | null;
  cost_status: WhatsAppCostStatus | null;
};

type PricingRateRow = {
  id: string;
  currency: string;
  unit_price: number | string;
  valid_from: string;
  source: string;
  pricing_model: string | null;
  pricing_type: string | null;
};

const STATUS_PRIORITY: Record<string, number> = {
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
};

const COUNTRY_PREFIXES: Array<[string, string]> = [
  ["39", "IT"],
  ["44", "GB"],
  ["49", "DE"],
  ["33", "FR"],
  ["34", "ES"],
  ["31", "NL"],
  ["32", "BE"],
  ["41", "CH"],
  ["43", "AT"],
  ["351", "PT"],
  ["1", "US"],
];

function compactPhone(input: string | null | undefined) {
  const cleaned = String(input ?? "").replace(/[^\d+]/g, "");
  if (cleaned.startsWith("+")) return cleaned.slice(1);
  if (cleaned.startsWith("00")) return cleaned.slice(2);
  return cleaned;
}

export function recipientCountryCode(phone: string | null | undefined) {
  const digits = compactPhone(phone);
  const match = COUNTRY_PREFIXES
    .sort((left, right) => right[0].length - left[0].length)
    .find(([prefix]) => digits.startsWith(prefix));
  return match?.[1] ?? null;
}

export function normalizePricingCategory(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized || null;
}

export function latestStatus(current: string | null | undefined, next: string) {
  const currentPriority = STATUS_PRIORITY[String(current ?? "").toLowerCase()] ?? 0;
  const nextPriority = STATUS_PRIORITY[next] ?? 0;
  return nextPriority >= currentPriority ? next : String(current ?? next);
}

function statusTimestampPatch(status: string, timestamp: string, existing?: CostEventRow | null) {
  return {
    sent_at: status === "sent" ? timestamp : existing?.sent_at ?? null,
    delivered_at: status === "delivered" ? timestamp : existing?.delivered_at ?? null,
    read_at: status === "read" ? timestamp : existing?.read_at ?? null,
    failed_at: status === "failed" ? timestamp : existing?.failed_at ?? null,
  };
}

function firstMetaError(status: MetaStatus) {
  const error = status.errors?.[0] as Record<string, unknown> | undefined;
  return {
    code: error?.code != null ? String(error.code) : null,
    message: typeof error?.message === "string"
      ? error.message
      : typeof error?.title === "string"
        ? error.title
        : null,
  };
}

function rawMetadata(status: MetaStatus) {
  return {
    pricing: status.pricing ?? null,
    conversation: status.conversation ?? null,
    errors: status.errors ?? [],
  };
}

function pricingValue(status: MetaStatus, key: "billable" | "pricing_model" | "type") {
  const pricing = status.pricing as Record<string, unknown> | undefined;
  return pricing?.[key];
}

function deliveryDateForRate(timestamp: string) {
  return timestamp.slice(0, 10);
}

async function loadStoredMessage(admin: SupabaseClient, tenantId: string, wamid: string) {
  const { data, error } = await admin
    .from("whatsapp_messages")
    .select("id, tenant_id, direction, phone_e164, wa_id, booking_id, transfer_id, template_name, message_type")
    .eq("tenant_id", tenantId)
    .eq("wa_message_id", wamid)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as StoredMessage | null;
}

async function findApplicableRate(
  admin: SupabaseClient,
  input: {
    tenantId: string;
    countryCode: string;
    pricingCategory: string;
    pricingType: string | null;
    pricingModel: string | null;
    deliveredAt: string;
  },
) {
  const date = deliveryDateForRate(input.deliveredAt);
  const { data, error } = await admin
    .from("whatsapp_pricing_rates")
    .select("id, currency, unit_price, valid_from, source, pricing_model, pricing_type")
    .eq("tenant_id", input.tenantId)
    .eq("country_code", input.countryCode)
    .eq("pricing_category", input.pricingCategory)
    .lte("valid_from", date)
    .or(`valid_to.is.null,valid_to.gte.${date}`)
    .order("valid_from", { ascending: false })
    .limit(20);
  if (error) throw error;

  const rows = (data ?? []) as PricingRateRow[];
  return rows.find((row) => {
    const typeMatches = !row.pricing_type || !input.pricingType || row.pricing_type === input.pricingType;
    const modelMatches = !row.pricing_model || !input.pricingModel || row.pricing_model === input.pricingModel;
    return typeMatches && modelMatches;
  }) ?? null;
}

async function calculateCostPatch(
  admin: SupabaseClient,
  input: {
    tenantId: string;
    status: string;
    statusTimestamp: string;
    deliveredAt: string | null;
    billable: boolean | null;
    pricingCategory: string | null;
    pricingType: string | null;
    pricingModel: string | null;
    countryCode: string | null;
    existing?: CostEventRow | null;
  },
) {
  if (input.status === "failed") {
    return {
      applied_rate_id: null,
      applied_rate_source: null,
      applied_rate_valid_from: null,
      estimated_cost: 0,
      estimated_currency: input.existing?.estimated_currency ?? "EUR",
      cost_status: "failed" satisfies WhatsAppCostStatus,
      cost_calculated_at: new Date().toISOString(),
    };
  }

  const deliveredAt = input.deliveredAt;
  if (!deliveredAt) {
    return {
      estimated_cost: input.existing?.estimated_cost ?? null,
      estimated_currency: input.existing?.estimated_currency ?? "EUR",
      cost_status: input.existing?.cost_status ?? "pending",
    };
  }

  if (input.billable === false) {
    return {
      applied_rate_id: null,
      applied_rate_source: "meta_webhook",
      applied_rate_valid_from: null,
      estimated_cost: 0,
      estimated_currency: input.existing?.estimated_currency ?? "EUR",
      cost_status: "free" satisfies WhatsAppCostStatus,
      cost_calculated_at: new Date().toISOString(),
    };
  }

  if (input.billable !== true || !input.pricingCategory || !input.countryCode) {
    return {
      estimated_cost: input.existing?.estimated_cost ?? null,
      estimated_currency: input.existing?.estimated_currency ?? "EUR",
      cost_status: input.existing?.cost_status ?? "pending",
    };
  }

  const rate = await findApplicableRate(admin, {
    tenantId: input.tenantId,
    countryCode: input.countryCode,
    pricingCategory: input.pricingCategory,
    pricingType: input.pricingType,
    pricingModel: input.pricingModel,
    deliveredAt,
  });

  if (!rate) {
    return {
      applied_rate_id: null,
      applied_rate_source: null,
      applied_rate_valid_from: null,
      estimated_cost: null,
      estimated_currency: input.existing?.estimated_currency ?? "EUR",
      cost_status: "missing_rate" satisfies WhatsAppCostStatus,
      cost_calculated_at: new Date().toISOString(),
    };
  }

  return {
    applied_rate_id: rate.id,
    applied_rate_source: rate.source,
    applied_rate_valid_from: rate.valid_from,
    estimated_cost: Number(rate.unit_price),
    estimated_currency: rate.currency,
    cost_status: "estimated" satisfies WhatsAppCostStatus,
    cost_calculated_at: new Date().toISOString(),
  };
}

export async function upsertWhatsAppCostEvent(
  admin: SupabaseClient,
  input: {
    tenantId: string;
    serviceId: string | null;
    status: MetaStatus;
    timestamp: string;
  },
) {
  const wamid = input.status.id?.trim();
  if (!wamid || !input.status.status) return { ok: false as const, reason: "missing_status_id" };

  const status = input.status.status.toLowerCase();
  const storedMessage = await loadStoredMessage(admin, input.tenantId, wamid);
  const { data: existing } = await admin
    .from("whatsapp_message_events")
    .select("id, status, status_timestamp, sent_at, delivered_at, read_at, failed_at, billable, pricing_category, pricing_model, pricing_type, estimated_cost, estimated_currency, cost_status")
    .eq("tenant_id", input.tenantId)
    .eq("wamid", wamid)
    .maybeSingle();
  const existingRow = existing as CostEventRow | null;

  const billableRaw = pricingValue(input.status, "billable");
  const billable = typeof billableRaw === "boolean" ? billableRaw : existingRow?.billable ?? null;
  const pricingCategory =
    normalizePricingCategory(input.status.pricing?.category) ?? existingRow?.pricing_category ?? null;
  const pricingModelRaw = pricingValue(input.status, "pricing_model");
  const pricingTypeRaw = pricingValue(input.status, "type");
  const pricingModel = typeof pricingModelRaw === "string" ? pricingModelRaw : existingRow?.pricing_model ?? null;
  const pricingType = typeof pricingTypeRaw === "string" ? pricingTypeRaw : existingRow?.pricing_type ?? null;
  const recipientPhone = input.status.recipient_id ?? storedMessage?.phone_e164 ?? storedMessage?.wa_id ?? null;
  const countryCode = recipientCountryCode(recipientPhone);
  const timestamps = statusTimestampPatch(status, input.timestamp, existingRow);
  const deliveredAt = timestamps.delivered_at ?? (timestamps.read_at ? existingRow?.delivered_at ?? input.timestamp : null);
  const metaError = firstMetaError(input.status);
  const nextStatus = latestStatus(existingRow?.status, status);

  const costPatch = await calculateCostPatch(admin, {
    tenantId: input.tenantId,
    status,
    statusTimestamp: input.timestamp,
    deliveredAt,
    billable,
    pricingCategory,
    pricingType,
    pricingModel,
    countryCode,
    existing: existingRow,
  });

  const payload = {
    tenant_id: input.tenantId,
    wamid,
    recipient_phone: recipientPhone,
    recipient_country_code: countryCode,
    passenger_id: null,
    booking_id: storedMessage?.booking_id ?? input.serviceId ?? null,
    template_name: storedMessage?.template_name ?? null,
    message_direction: storedMessage?.direction ?? "outbound",
    status: nextStatus,
    status_timestamp: input.timestamp,
    ...timestamps,
    billable,
    pricing_category: pricingCategory,
    pricing_model: pricingModel,
    pricing_type: pricingType,
    error_code: metaError.code,
    error_message: metaError.message,
    raw_metadata: rawMetadata(input.status),
    ...costPatch,
  };

  const { error } = await admin
    .from("whatsapp_message_events")
    .upsert(payload, { onConflict: "tenant_id,wamid" });
  if (error) throw error;
  return { ok: true as const, costStatus: payload.cost_status };
}

export async function fetchMetaPricingAnalytics(params: { start: string; end: string }) {
  const businessId = getWhatsAppBusinessAccountId();
  const path = `${businessId}?fields=pricing_analytics.start(${params.start}).end(${params.end})`;
  return fetchWhatsAppGraph(path);
}
