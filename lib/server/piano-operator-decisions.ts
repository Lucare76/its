import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PricingAuthContext } from "@/lib/server/pricing-auth";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type PianoOperatorDecisionRow = {
  id: string;
  tenant_id: string;
  service_date: string;
  trip_group_id: string | null;
  decision_type: string;
  action: string;
  suggestion_hash: string;
  payload_json: JsonValue;
  before_json: JsonValue | null;
  after_json: JsonValue | null;
  confirmed_by: string;
  confirmed_at: string;
  status: "confirmed" | "revoked" | "superseded";
  revoked_by: string | null;
  revoked_at: string | null;
  created_at: string;
};

export type SuggestionHashInput = {
  tenant_id: string;
  service_date: string;
  trip_group_id?: string | null;
  action: string;
  service_ids: string[];
  before_json?: unknown;
  after_json?: unknown;
};

export type InsertOperatorDecisionPayload = {
  service_date: string;
  trip_group_id?: string | null;
  decision_type: string;
  action: string;
  service_ids: string[];
  payload_json?: unknown;
  before_json?: unknown;
  after_json?: unknown;
};

type SupersedeOverlappingPayload = InsertOperatorDecisionPayload & {
  new_decision_id: string;
  suggestion_hash: string;
};

function normalizeScalar(value: unknown): JsonValue {
  if (value == null) return null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return String(value);
}

export function normalizeDecisionJson(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(normalizeDecisionJson);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, normalizeDecisionJson(item)] as const);
    return Object.fromEntries(entries);
  }
  return normalizeScalar(value);
}

function compactHashPayload(input: SuggestionHashInput) {
  return normalizeDecisionJson({
    tenant_id: input.tenant_id,
    service_date: input.service_date,
    trip_group_id: input.trip_group_id ?? null,
    action: input.action,
    service_ids: [...new Set(input.service_ids)].sort(),
    before_json: input.before_json ?? null,
    after_json: input.after_json ?? null,
  });
}

export function buildSuggestionHash(input: SuggestionHashInput) {
  const payload = JSON.stringify(compactHashPayload(input));
  return createHash("sha256").update(payload).digest("hex");
}

function table(admin: SupabaseClient) {
  return admin.from("piano_operator_decisions");
}

function duplicateDecisionError(error: { code?: string; message?: string } | null | undefined) {
  return error?.code === "23505" || /duplicate key value/i.test(error?.message ?? "");
}

export async function loadConfirmedOperatorDecisions(auth: PricingAuthContext, date: string) {
  const { data, error } = await table(auth.admin)
    .select("*")
    .eq("tenant_id", auth.membership.tenant_id)
    .eq("service_date", date)
    .eq("status", "confirmed")
    .order("confirmed_at", { ascending: false });

  if (error) throw new Error(`piano_operator_decisions load: ${error.message}`);
  return (data ?? []) as PianoOperatorDecisionRow[];
}

export async function insertOperatorDecision(
  auth: PricingAuthContext,
  payload: InsertOperatorDecisionPayload
) {
  const tenantId = auth.membership.tenant_id;
  const suggestionHash = buildSuggestionHash({
    tenant_id: tenantId,
    service_date: payload.service_date,
    trip_group_id: payload.trip_group_id ?? null,
    action: payload.action,
    service_ids: payload.service_ids,
    before_json: payload.before_json ?? null,
    after_json: payload.after_json ?? null,
  });

  const row = {
    tenant_id: tenantId,
    service_date: payload.service_date,
    trip_group_id: payload.trip_group_id ?? null,
    decision_type: payload.decision_type,
    action: payload.action,
    suggestion_hash: suggestionHash,
    payload_json: normalizeDecisionJson(payload.payload_json ?? {}),
    before_json: payload.before_json == null ? null : normalizeDecisionJson(payload.before_json),
    after_json: payload.after_json == null ? null : normalizeDecisionJson(payload.after_json),
    confirmed_by: auth.user.id,
    status: "confirmed",
  };

  const { data, error } = await table(auth.admin)
    .insert(row)
    .select("*")
    .single();

  if (duplicateDecisionError(error)) {
    const existing = await table(auth.admin)
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("service_date", payload.service_date)
      .eq("suggestion_hash", suggestionHash)
      .eq("status", "confirmed")
      .single();
    if (existing.error) throw new Error(`piano_operator_decisions duplicate lookup: ${existing.error.message}`);
    return { decision: existing.data as PianoOperatorDecisionRow, duplicate: true };
  }
  if (error) throw new Error(`piano_operator_decisions insert: ${error.message}`);
  return { decision: data as PianoOperatorDecisionRow, duplicate: false };
}

function normalizeText(value: unknown) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function serviceIdsFromDecisionPayload(payload: unknown) {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const multiDrop = record.multi_drop && typeof record.multi_drop === "object"
    ? record.multi_drop as Record<string, unknown>
    : {};
  const services = Array.isArray(multiDrop.services)
    ? multiDrop.services
    : Array.isArray((record.suggestion as Record<string, unknown> | undefined)?.involved_services)
      ? (record.suggestion as Record<string, unknown>).involved_services as unknown[]
      : [];

  return services
    .map((service) => service && typeof service === "object"
      ? (service as Record<string, unknown>).service_id
      : null)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

function pickupFromDecisionPayload(payload: unknown) {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const multiDrop = record.multi_drop && typeof record.multi_drop === "object"
    ? record.multi_drop as Record<string, unknown>
    : {};
  return multiDrop.pickup_label ?? null;
}

function orderFromDecisionPayload(payload: unknown) {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const multiDrop = record.multi_drop && typeof record.multi_drop === "object"
    ? record.multi_drop as Record<string, unknown>
    : {};
  return Array.isArray(multiDrop.suggested_order) ? multiDrop.suggested_order.map(normalizeText) : [];
}

function isSubset(left: string[], right: string[]) {
  const rightSet = new Set(right);
  return left.length > 0 && left.every((item) => rightSet.has(item));
}

function sameSuggestedOrder(left: string[], right: string[]) {
  return left.length > 0
    && right.length > 0
    && left.length === right.length
    && left.every((item, index) => item === right[index]);
}

export async function supersedeOverlappingOperatorDecisions(
  auth: PricingAuthContext,
  payload: SupersedeOverlappingPayload
) {
  if (payload.action !== "MULTI_DROP") return [] as PianoOperatorDecisionRow[];

  const tenantId = auth.membership.tenant_id;
  const newServiceIds = [...new Set(payload.service_ids)].sort();
  const newPayload = normalizeDecisionJson(payload.payload_json ?? {});
  const newPickup = normalizeText(pickupFromDecisionPayload(newPayload));
  const newOrder = orderFromDecisionPayload(newPayload);
  if (!newPickup || newOrder.length === 0 || newServiceIds.length < 2) return [] as PianoOperatorDecisionRow[];

  const { data: existingRows, error: loadError } = await table(auth.admin)
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("service_date", payload.service_date)
    .eq("trip_group_id", payload.trip_group_id ?? null)
    .eq("action", "MULTI_DROP")
    .eq("status", "confirmed")
    .order("confirmed_at", { ascending: false });
  if (loadError) throw new Error(`piano_operator_decisions supersede lookup: ${loadError.message}`);

  const toSupersede = ((existingRows ?? []) as PianoOperatorDecisionRow[]).filter((row) => {
    if (row.id === payload.new_decision_id || row.suggestion_hash === payload.suggestion_hash) return false;
    const oldServiceIds = serviceIdsFromDecisionPayload(row.payload_json).sort();
    const oldPickup = normalizeText(pickupFromDecisionPayload(row.payload_json));
    const oldOrder = orderFromDecisionPayload(row.payload_json);
    return oldPickup === newPickup
      && sameSuggestedOrder(oldOrder, newOrder)
      && isSubset(oldServiceIds, newServiceIds)
      && oldServiceIds.length < newServiceIds.length;
  });
  if (toSupersede.length === 0) return [];

  const ids = toSupersede.map((row) => row.id);
  const { data, error } = await table(auth.admin)
    .update({
      status: "superseded",
      revoked_by: auth.user.id,
      revoked_at: new Date().toISOString(),
    })
    .eq("tenant_id", tenantId)
    .in("id", ids)
    .eq("status", "confirmed")
    .select("*")
    .order("confirmed_at", { ascending: false });
  if (error) throw new Error(`piano_operator_decisions supersede: ${error.message}`);
  return (data ?? []) as PianoOperatorDecisionRow[];
}

export async function revokeOperatorDecision(auth: PricingAuthContext, decisionId: string) {
  const { data, error } = await table(auth.admin)
    .update({
      status: "revoked",
      revoked_by: auth.user.id,
      revoked_at: new Date().toISOString(),
    })
    .eq("tenant_id", auth.membership.tenant_id)
    .eq("id", decisionId)
    .eq("status", "confirmed")
    .select("*")
    .single();

  if (error) throw new Error(`piano_operator_decisions revoke: ${error.message}`);
  return data as PianoOperatorDecisionRow;
}
