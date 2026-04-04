import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  createAdminClient,
  extractDriverPhoneFromNotes,
  getTenantWhatsAppSettings,
  logWhatsAppEvent,
  sendWhatsAppReminder
} from "@/lib/server/whatsapp";

export const runtime = "nodejs";

const payloadSchema = z.object({
  service_id: z.string().uuid()
});

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = payloadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" }, { status: 400 });
  }

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "Server env missing" }, { status: 500 });
  }

  const token = authHeader.slice("Bearer ".length);
  const {
    data: { user },
    error: authError
  } = await admin.auth.getUser(token);

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: membership, error: membershipError } = await admin
    .from("memberships")
    .select("tenant_id, role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (membershipError || !membership?.tenant_id || !["admin", "operator"].includes(membership.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: service, error: serviceError } = await admin
    .from("services")
    .select("id, tenant_id, date, time, customer_name, phone, phone_e164, reminder_status, message_id, sent_at, hotel_id, vessel, meeting_point, bus_plate, notes")
    .eq("id", parsed.data.service_id)
    .eq("tenant_id", membership.tenant_id)
    .maybeSingle();

  if (serviceError || !service) {
    return NextResponse.json({ error: "Service not found" }, { status: 404 });
  }

  const { data: hotel } = await admin
    .from("hotels")
    .select("name")
    .eq("id", service.hotel_id)
    .eq("tenant_id", membership.tenant_id)
    .maybeSingle();
  const { data: assignment } = await admin
    .from("assignments")
    .select("vehicle_label")
    .eq("service_id", service.id)
    .eq("tenant_id", membership.tenant_id)
    .maybeSingle();
  const settings = await getTenantWhatsAppSettings(admin, membership.tenant_id);

  const result = await sendWhatsAppReminder(service, hotel?.name, {
    meetingPoint: service.meeting_point,
    driverPhone: extractDriverPhoneFromNotes(service.notes),
    vehicleLabel: assignment?.vehicle_label ?? null,
    plate: service.bus_plate
  }, {
    templateName: settings.default_template,
    languageCode: settings.template_language,
    allowTextFallback: settings.allow_text_fallback
  });
  if (!result.ok) {
    const nowIso = new Date().toISOString();
    await logWhatsAppEvent(admin, {
      tenant_id: membership.tenant_id,
      service_id: service.id,
      to_phone: result.phoneE164,
      kind: "manual",
      template: result.templateName,
      status: "failed",
      provider_message_id: null,
      happened_at: nowIso,
      payload_json: {
        error: result.error,
        source: "api/whatsapp/send",
        phase: "manual",
        language: result.languageCode,
        delivery_mode: result.deliveryMode
      }
    });
    await admin
      .from("services")
      .update({
        phone_e164: result.phoneE164,
        reminder_status: "failed"
      })
      .eq("id", service.id)
      .eq("tenant_id", membership.tenant_id);
    return NextResponse.json({ error: result.error }, { status: 502 });
  }

  const nowIso = new Date().toISOString();
  await logWhatsAppEvent(admin, {
    tenant_id: membership.tenant_id,
    service_id: service.id,
    to_phone: result.phoneE164,
    kind: "manual",
    template: result.templateName,
    status: "sent",
    provider_message_id: result.messageId,
    happened_at: nowIso,
    payload_json: {
      source: "api/whatsapp/send",
      phase: "manual",
      language: result.languageCode,
      delivery_mode: result.deliveryMode
    }
  });
  const { error: updateError } = await admin
    .from("services")
    .update({
      phone_e164: result.phoneE164,
      reminder_status: "sent",
      message_id: result.messageId,
      sent_at: nowIso
    })
    .eq("id", service.id)
    .eq("tenant_id", membership.tenant_id);

  if (updateError) {
    return NextResponse.json({ error: "Failed to save reminder metadata" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    service_id: service.id,
    reminder_status: "sent",
    message_id: result.messageId,
    sent_at: nowIso
  });
}
