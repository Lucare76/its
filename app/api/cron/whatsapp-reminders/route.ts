import { NextRequest, NextResponse } from "next/server";
import {
  createAdminClient,
  extractDriverPhoneFromNotes,
  getTenantWhatsAppSettings,
  isReminderDueInWindow,
  logWhatsAppEvent,
  sendWhatsAppReminder
} from "@/lib/server/whatsapp";
import { completeJobRun, startJobRun } from "@/lib/server/job-health";
import { persistOutboundWhatsAppMessage } from "@/lib/server/whatsapp/messages";

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
  const jobRunId = await startJobRun({
    admin,
    jobKey: "whatsapp-reminders",
    jobName: "WhatsApp reminder",
    source: "api/cron/whatsapp-reminders"
  });

  const now = new Date();
  const fromDate = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const toDate = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const windowMinutes = Number(process.env.WHATSAPP_REMINDER_WINDOW_MINUTES ?? "15");

  const { data: tenants } = await admin.from("tenants").select("id");

  let totalScanned = 0;
  let totalSent = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  let totalDue48h = 0;
  let totalDue24h = 0;
  let totalDue2h = 0;
  let totalPlanned = 0;
  let totalTenantErrors = 0;
  const phaseCounters: Record<string, number> = { "48h_departure": 0, "24h": 0, "2h": 0 };

  for (const tenant of tenants ?? []) {
    const tenantId = tenant.id as string;
    const settings = await getTenantWhatsAppSettings(admin, tenantId);

    const { data: candidates, error: candidatesError } = await admin
      .from("services")
      .select("id, tenant_id, date, time, customer_name, phone, phone_e164, reminder_status, message_id, sent_at, hotel_id, vessel, status, meeting_point, bus_plate, notes, direction, place_type, pickup_hotel, barca_compagnia, orario_barca, porto_bruno, pickup_alert")
      .eq("tenant_id", tenantId)
      .gte("date", fromDate)
      .lte("date", toDate)
      .in("status", ["new", "assigned"])
      .limit(500);

    if (candidatesError) {
      totalTenantErrors += 1;
      continue;
    }

    const candidateServices = candidates ?? [];
    totalScanned += candidateServices.length;

    const candidateServiceIds = candidateServices.map((service) => service.id);

    const { data: priorEvents } =
      candidateServiceIds.length === 0
        ? { data: [] }
        : await admin
            .from("whatsapp_events")
            .select("service_id, status, payload_json")
            .eq("tenant_id", tenantId)
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
    const due2h = candidateServices.filter((service) =>
      Boolean(settings?.enable_2h_reminder) && isReminderDueInWindow(service.date, service.time, 2, windowMinutes, now)
    );
    // 48h prima per partenze con pickup_hotel (Rete Ischia): avvisa il cliente dell'orario prelievo
    const due48hDeparture = candidateServices.filter((service) => {
      const svc = service as typeof service & { direction?: string; place_type?: string; pickup_hotel?: string };
      return (
        svc.direction === "departure" &&
        svc.place_type != null && svc.place_type !== "hotel" &&
        svc.pickup_hotel != null &&
        isReminderDueInWindow(svc.date, svc.pickup_hotel, 48, windowMinutes, now)
      );
    });

    totalDue48h += due48hDeparture.length;
    totalDue24h += due24h.length;
    totalDue2h += due2h.length;

    const duePlans = [
      ...due48hDeparture.map((service) => ({ service, phase: "48h_departure" as const })),
      ...due24h.map((service) => ({ service, phase: "24h" as const })),
      ...due2h.map((service) => ({ service, phase: "2h" as const }))
    ].filter((item) => !sentPhaseByService.has(`${item.service.id}:${item.phase}`));

    totalPlanned += duePlans.length;

    if (duePlans.length === 0) continue;

    const hotelIds = Array.from(new Set(duePlans.map((item) => item.service.hotel_id)));
    const { data: hotelsData } =
      hotelIds.length === 0
        ? { data: [] }
        : await admin.from("hotels").select("id, name").eq("tenant_id", tenantId).in("id", hotelIds);
    const hotelById = new Map((hotelsData ?? []).map((hotel) => [hotel.id, hotel.name]));

    const dueServiceIds = Array.from(new Set(duePlans.map((item) => item.service.id)));
    const { data: assignmentsData } =
      dueServiceIds.length === 0
        ? { data: [] }
        : await admin
            .from("assignments")
            .select("service_id, driver_user_id, vehicle_label")
            .eq("tenant_id", tenantId)
            .in("service_id", dueServiceIds);
    const assignmentByServiceId = new Map((assignmentsData ?? []).map((item) => [item.service_id, item]));

    for (const item of duePlans) {
      const { service, phase } = item;
      const dedupeKey = `${service.id}:${phase}`;
      if (sentPhaseByService.has(dedupeKey)) {
        totalSkipped += 1;
        continue;
      }
      const assignment = assignmentByServiceId.get(service.id);
      const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "");
      const trackingUrl = appUrl && assignment?.driver_user_id ? `${appUrl}/track/${service.id}` : null;
      const result = await sendWhatsAppReminder(service, hotelById.get(service.hotel_id), {
        meetingPoint: service.meeting_point,
        driverPhone: extractDriverPhoneFromNotes(service.notes),
        vehicleLabel: assignment?.vehicle_label ?? null,
        plate: service.bus_plate,
        trackingUrl
      }, {
        templateName: settings?.default_template,
        languageCode: settings?.template_language,
        allowTextFallback: settings?.allow_text_fallback
      });
      const nowIso = new Date().toISOString();
      if (!result.ok) {
        totalFailed += 1;
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
            delivery_mode: result.deliveryMode,
            tracking_url_included: Boolean(trackingUrl)
          }
        });
        await admin
          .from("services")
          .update({ reminder_status: "failed", phone_e164: result.phoneE164 })
          .eq("id", service.id)
          .eq("tenant_id", service.tenant_id);
        continue;
      }

      totalSent += 1;
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
          delivery_mode: result.deliveryMode,
          tracking_url_included: Boolean(trackingUrl)
        }
      });
      try {
        await persistOutboundWhatsAppMessage(admin, {
          tenantId: service.tenant_id,
          toPhone: result.phoneE164,
          waMessageId: result.messageId,
          messageType: result.deliveryMode === "template" ? "template" : "text",
          templateName: result.templateName,
          textBody: result.deliveryMode === "template" ? `Template ${result.templateName}` : null,
          status: "sent",
          timestamp: nowIso,
          serviceId: service.id,
          rawMessage: {
            id: result.messageId,
            source: "api/cron/whatsapp-reminders",
            phase,
            delivery_mode: result.deliveryMode,
            template: result.templateName,
            language: result.languageCode
          }
        });
      } catch (error) {
        console.error("WhatsApp outbound message persistence failed", {
          source: "api/cron/whatsapp-reminders",
          serviceId: service.id,
          waMessageId: result.messageId ?? null,
          message: error instanceof Error ? error.message : "persist failed"
        });
      }
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
  }

  const responsePayload = {
    ok: true,
    scanned: totalScanned,
    due_48h_departure: totalDue48h,
    due_24h: totalDue24h,
    due_2h: totalDue2h,
    planned: totalPlanned,
    sent: totalSent,
    sent_by_phase: phaseCounters,
    skipped_duplicates: totalSkipped,
    failed: totalFailed
  };

  await completeJobRun({
    admin,
    runId: jobRunId,
    status: totalFailed > 0 || totalTenantErrors > 0 ? "warning" : "success",
    processedCount: totalPlanned,
    successCount: totalSent,
    failedCount: totalFailed,
    warningCount: totalTenantErrors,
    errorMessage: totalTenantErrors > 0 ? `${totalTenantErrors} tenant non processati` : null,
    metadata: {
      scanned: totalScanned,
      due_48h_departure: totalDue48h,
      due_24h: totalDue24h,
      due_2h: totalDue2h,
      planned: totalPlanned,
      sent_by_phase: phaseCounters,
      skipped_duplicates: totalSkipped,
      tenant_query_errors: totalTenantErrors
    }
  });

  return NextResponse.json(responsePayload);
}

export async function GET(request: NextRequest) {
  return runCron(request);
}

export async function POST(request: NextRequest) {
  return runCron(request);
}
