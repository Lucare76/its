import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/server/whatsapp";

export type EnsureWhatsAppContactParams = {
  tenantId: string;
  phone: string | null | undefined;
  profileName?: string | null;
  waProfileName?: string | null;
};

function cleanProfileName(value: string | null | undefined) {
  const trimmed = (value ?? "").trim();
  return trimmed || null;
}

export function normalizeWhatsAppContactPhone(phone: string | null | undefined) {
  try {
    return normalizeE164(phone ?? "");
  } catch {
    return null;
  }
}

export async function ensureWhatsAppContact(
  admin: SupabaseClient,
  params: EnsureWhatsAppContactParams,
) {
  const phoneE164 = normalizeWhatsAppContactPhone(params.phone);
  if (!phoneE164) return { ok: false as const, skipped: true as const, reason: "invalid_phone" };

  const waId = phoneE164.replace(/^\+/, "");
  const profileName = cleanProfileName(params.profileName);
  const waProfileName = cleanProfileName(params.waProfileName);
  const nowIso = new Date().toISOString();

  const { data: existing, error: existingError } = await admin
    .from("whatsapp_contacts")
    .select("id, profile_name, customer_full_name, wa_profile_name")
    .eq("tenant_id", params.tenantId)
    .eq("phone_e164", phoneE164)
    .maybeSingle();
  if (existingError) throw existingError;

  if (existing?.id) {
    const shouldPatchName = profileName && !cleanProfileName(existing.profile_name as string | null);
    const shouldPatchCustomerName = profileName && !cleanProfileName(existing.customer_full_name as string | null);
    const update: Record<string, unknown> = {
      wa_id: waId,
      phone_e164: phoneE164,
      updated_at: nowIso,
    };
    if (shouldPatchName) update.profile_name = profileName;
    if (shouldPatchCustomerName) update.customer_full_name = profileName;
    if (waProfileName) update.wa_profile_name = waProfileName;

    const { error } = await admin
      .from("whatsapp_contacts")
      .update(update)
      .eq("tenant_id", params.tenantId)
      .eq("id", existing.id);
    if (error) throw error;
    return { ok: true as const, id: String(existing.id), phoneE164, waId, created: false as const };
  }

  const insertPayload = {
    tenant_id: params.tenantId,
    wa_id: waId,
    phone_e164: phoneE164,
    profile_name: profileName,
    customer_full_name: profileName,
    wa_profile_name: waProfileName,
    updated_at: nowIso,
  };
  const { data, error } = await admin
    .from("whatsapp_contacts")
    .insert(insertPayload)
    .select("id")
    .single();

  if (!error) return { ok: true as const, id: String(data.id), phoneE164, waId, created: true as const };

  if ((error as { code?: string }).code !== "23505") throw error;

  const { data: byWaId, error: byWaIdError } = await admin
    .from("whatsapp_contacts")
    .select("id, profile_name, customer_full_name")
    .eq("tenant_id", params.tenantId)
    .eq("wa_id", waId)
    .maybeSingle();
  if (byWaIdError) throw byWaIdError;
  if (!byWaId?.id) throw error;

  const update: Record<string, unknown> = {
    phone_e164: phoneE164,
    updated_at: nowIso,
  };
  if (profileName && !cleanProfileName(byWaId.profile_name as string | null)) update.profile_name = profileName;
  if (profileName && !cleanProfileName(byWaId.customer_full_name as string | null)) update.customer_full_name = profileName;
  if (waProfileName) update.wa_profile_name = waProfileName;
  const { error: updateError } = await admin
    .from("whatsapp_contacts")
    .update(update)
    .eq("tenant_id", params.tenantId)
    .eq("id", byWaId.id);
  if (updateError) throw updateError;
  return { ok: true as const, id: String(byWaId.id), phoneE164, waId, created: false as const };
}
