import { NextRequest, NextResponse } from "next/server";
import {
  createAdminClient,
  extractDriverPhoneFromNotes,
  getTenantWhatsAppSettings,
  isReminderDueInWindow,
  logWhatsAppEvent,
  sendWhatsAppReminder
} from "@/lib/server/whatsapp";

export const runtime = "nodejs";

function hasCronAuth(request: NextRequest) {
  const expected = process.env.WHATSAPP_CRON_SECRET ?? process.env.CRON_SECRET;
  if (!expected) return false;
  return request.headers.get("authorization") === `Bearer ${expected}`;
}

async function runCron(request: NextRequest) {
  if (!hasCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "Server env missing" }, { status: 500 });
  }

  const now = new Date();
  const fromDate = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const toDate = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const windowMinutes = Number(process.env.WHATSAPP_REMINDER_WINDOW_MINUTES ?? "15");

  const { data: candidates, error: candidatesError } = await admin
    .from("services")
    .select("id, tenant_id, date, time, customer_name, phone, phone_e164, reminder_status, message_id, sent_at, hotel_id, vessel, status, meeting_point, bus_plate, notes")
    .gte("date", fromDate)
    .lte("date", toDate)
    .in("status", ["new", "assigned"])
    .limit(500);

  if (candidatesError) {
    return NextResponse.json({ error: "Failed to load candidate services" }, { status: 500 });
  }

  const candidateServices = candidates ?? [];
  const candidateServiceIds = candidateServices.map((service) => service.id);
  const tenantIds = Array.from(new Set(candidateServices.map((service) => service.tenant_id)));
  const tenantSettingsEntries = await Promise.all(
    tenantIds.map(async (tenantId) => [tenantId, await getTenantWhatsAppSettings(admin, tenantId)] as const)
  );
  const settingsByTenant = new Map(tenantSettingsEntries);

  const { data: priorEvents } =
    candidateServiceIds.length === 0
      ? { data: [] }
      : await admin
          .from("whatsapp_events")
          .select("service_id, status, payload_json")
          .in("service_id", candidateServiceIds)
          .in("status", ["sent", "delivered", "read"]);
  const sentPhaseByService = new Set<string>();
  for (const event of priorEvents ?? []) {
    if (!event.service_id) continue;
    const payload = (event.payload_json ?? {}) as Record<string, unknown>;
    const phase = typeof payload.phase === "string" ? payload.phase : null;
    if (!phase) continue;
    sentPhaseByService.add(`${event.service_id}:${phase}`);
  }

  const due24h = candidateServices.filter((service) => isReminderDueInWindow(service.date, service.time, 24, windowMinutes, now));
  const due2h = candidateServices.filter((service) => {
    const settings = settingsByTenant.get(service.tenant_id);
    return Boolean(settings?.enable_2h_reminder) && isReminderDueInWindow(service.date, service.time, 2, windowMinutes, now);
  });
  const duePlans = [
    ...due24h.map((service) => ({ service, phase: "24h" as const })),
    ...due2h.map((service) => ({ service, phase: "2h" as const }))
  ].filter((item) => !sentPhaseByService.has(`${item.service.id}:${item.phase}`));

  const hotelIds = Array.from(new Set(duePlans.map((item) => item.service.hotel_id)));
  const { data: hotelsData } =
    hotelIds.length === 0
      ? { data: [] }
      : await admin.from("hotels").select("id, name").in("id", hotelIds);
  const hotelById = new Map((hotelsData ?? []).map((hotel) => [hotel.id, hotel.name]));

  const dueServiceIds = Array.from(new Set(duePlans.map((item) => item.service.id)));
  const { data: assignmentsData } =
    dueServiceIds.length === 0
      ? { data: [] }
      : await admin.from("assignments").select("service_id, vehicle_label").in("service_id", dueServiceIds);
  const assignmentByServiceId = new Map((assignmentsData ?? []).map((item) => [item.service_id, item]));

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const phaseCounters: Record<string, number> = { "24h": 0, "2h": 0 };

  for (const item of duePlans) {
    const { service, phase } = item;
    const dedupeKey = `${service.id}:${phase}`;
    if (sentPhaseByService.has(dedupeKey)) {
      skipped += 1;
      continue;
    }
    const assignment = assignmentByServiceId.get(service.id);
    const settings = settingsByTenant.get(service.tenant_id);
    const result = await sendWhatsAppReminder(service, hotelById.get(service.hotel_id), {
      meetingPoint: service.meeting_point,
      driverPhone: extractDriverPhoneFromNotes(service.notes),
      vehicleLabel: assignment?.vehicle_label ?? null,
      plate: service.bus_plate
    }, {
      templateName: settings?.default_template,
      languageCode: settings?.template_language,
      allowTextFallback: settings?.allow_text_fallback
    });
    const nowIso = new Date().toISOString();
    if (!result.ok) {
      failed += 1;
      await logWhatsAppEvent(admin, {
        tenant_id: service.tenant_id,
        service_id: service.id,
        to_phone: result.phoneE164,
        kind: phase,
        template: result.templateName,
        status: "failed",
        provider_message_id: null,
        happened_at: nowIso,
        payload_json: {
          error: result.error,
          source: "api/cron/whatsapp-reminders",
          phase,
          language: result.languageCode,
          delivery_mode: result.deliveryMode
        }
      });
      await admin
        .from("services")
        .update({ reminder_status: "failed", phone_e164: result.phoneE164 })
        .eq("id", service.id)
        .eq("tenant_id", service.tenant_id);
      continue;
    }

    sent += 1;
    phaseCounters[phase] = (phaseCounters[phase] ?? 0) + 1;
    sentPhaseByService.add(dedupeKey);
    await logWhatsAppEvent(admin, {
      tenant_id: service.tenant_id,
      service_id: service.id,
      to_phone: result.phoneE164,
      kind: phase,
      template: result.templateName,
      status: "sent",
      provider_message_id: result.messageId,
      happened_at: nowIso,
      payload_json: {
        source: "api/cron/whatsapp-reminders",
        phase,
        language: result.languageCode,
        delivery_mode: result.deliveryMode
      }
    });
    await admin
      .from("services")
      .update({
        phone_e164: result.phoneE164,
        reminder_status: "sent",
        message_id: result.messageId,
        sent_at: nowIso
      })
      .eq("id", service.id)
      .eq("tenant_id", service.tenant_id);
  }

  return NextResponse.json({
    ok: true,
    scanned: candidateServices.length,
    due_24h: due24h.length,
    due_2h: due2h.length,
    planned: duePlans.length,
    sent,
    sent_by_phase: phaseCounters,
    skipped_duplicates: skipped,
    failed
  });
}

export async function GET(request: NextRequest) {
  return runCron(request);
}

export async function POST(request: NextRequest) {
  return runCron(request);
}
