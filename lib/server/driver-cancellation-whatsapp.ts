import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164, sendWhatsAppMessage } from "@/lib/server/whatsapp";
import { sendEmail } from "@/lib/server/send-email";

type CancellationNoticeInput = {
  admin: SupabaseClient;
  tenantId: string;
  service: {
    id: string;
    customer_name?: string | null;
    date?: string | null;
    time?: string | null;
  };
  driverUserId?: string | null;
  requestedByUserId?: string | null;
};

function metadataPhone(metadata: Record<string, unknown> | null | undefined) {
  const candidates = [
    metadata?.phone,
    metadata?.phone_e164,
    metadata?.mobile,
    metadata?.whatsapp,
    metadata?.driver_phone,
  ];
  return candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? null;
}

async function audit(admin: SupabaseClient, input: CancellationNoticeInput, outcome: string, details: Record<string, unknown>) {
  await admin.from("ops_audit_events").insert({
    tenant_id: input.tenantId,
    event: "driver_notified_service_cancelled",
    level: outcome === "sent" ? "info" : "warn",
    user_id: input.requestedByUserId ?? null,
    service_id: input.service.id,
    outcome,
    details,
  });
}

export async function notifyDriverServiceCancelled(input: CancellationNoticeInput) {
  try {
  const { admin, tenantId, service, driverUserId } = input;
  if (!driverUserId) {
    await audit(admin, input, "skipped", { reason: "no_driver_assigned" });
    return { ok: false, skipped: true, reason: "no_driver_assigned" };
  }

  const { data: membership } = await admin
    .from("memberships")
    .select("full_name")
    .eq("tenant_id", tenantId)
    .eq("user_id", driverUserId)
    .maybeSingle();

  const { data: userResult } = await admin.auth.admin.getUserById(driverUserId);
  const user = userResult?.user ?? null;
  const userMetadata = user?.user_metadata as Record<string, unknown> | null | undefined;
  let phone = user?.phone ?? metadataPhone(userMetadata);

  if (!phone && membership?.full_name) {
    const { data: profile } = await admin
      .from("driver_profiles")
      .select("phone")
      .eq("tenant_id", tenantId)
      .ilike("full_name", membership.full_name)
      .maybeSingle();
    phone = profile?.phone ?? null;
  }

  if (!phone) {
    await audit(admin, input, "skipped", { reason: "driver_phone_missing", driver_user_id: driverUserId });
    return { ok: false, skipped: true, reason: "driver_phone_missing" };
  }

  const phoneE164 = normalizeE164(phone);
  const result = await sendWhatsAppMessage({
    to: phoneE164,
    template: process.env.WHATSAPP_TEMPLATE_DRIVER_SERVICE_CANCELLED ?? "driver_service_cancelled",
    variables: {
      customer_name: service.customer_name ?? "Cliente",
      service_date: service.date ?? "data non disponibile",
      service_time: service.time?.slice(0, 5) ?? "orario non disponibile",
    },
  });

  if (result.ok) {
    await audit(admin, input, "sent", {
      driver_user_id: driverUserId,
      phone_e164: phoneE164,
      provider_message_id: result.messageId ?? null,
    });
    return result;
  }

  // WhatsApp fallito → tenta email se l'autista ha un indirizzo
  if (user?.email) {
    const emailResult = await sendEmail({
      to: user.email,
      subject: `Servizio cancellato — ${service.customer_name ?? "Cliente"}`,
      html: `<p>Il servizio del <strong>${service.date ?? "data non disponibile"}</strong> alle <strong>${service.time?.slice(0, 5) ?? "orario non disponibile"}</strong> per il cliente <strong>${service.customer_name ?? "Cliente"}</strong> è stato cancellato.</p>`,
    });
    await audit(admin, input, emailResult.ok ? "sent_email_fallback" : "failed", {
      driver_user_id: driverUserId,
      phone_e164: phoneE164,
      whatsapp_error: result.error,
      email: user.email,
      email_error: emailResult.ok ? null : emailResult.error,
    });
    return emailResult.ok ? { ok: true } : { ok: false, error: `WhatsApp: ${result.error ?? "fallito"}; Email: ${emailResult.error ?? "fallita"}` };
  }

  await audit(admin, input, "failed", {
    driver_user_id: driverUserId,
    phone_e164: phoneE164,
    error: result.error,
  });
  return result;
  } catch (error) {
    await audit(input.admin, input, "failed", {
      error: error instanceof Error ? error.message : "Errore invio notifica autista",
    });
    return { ok: false, error: error instanceof Error ? error.message : "Errore invio notifica autista" };
  }
}
