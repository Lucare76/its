import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, logWhatsAppEvent, sendWhatsAppMessage } from "@/lib/server/whatsapp";

export const runtime = "nodejs";

function hasCronAuth(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  return request.headers.get("authorization") === `Bearer ${expected}`;
}

function parsePickupAt(date: string, time: string) {
  const hhmm = time.length >= 5 ? time.slice(0, 5) : "00:00";
  return new Date(`${date}T${hhmm}:00`);
}

export async function GET(request: NextRequest) {
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
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const fromDate = now.toISOString().slice(0, 10);
  const toDate = in24h.toISOString().slice(0, 10);

  const { data: candidates, error: candidatesError } = await admin
    .from("services")
    .select("id, tenant_id, date, time, customer_name, phone, phone_e164, hotel_id, meeting_point, status")
    .gte("date", fromDate)
    .lte("date", toDate)
    .in("status", ["assigned"])
    .limit(1000);

  if (candidatesError) {
    return NextResponse.json({ error: "Failed to load candidate services" }, { status: 500 });
  }

  const windowCandidates = (candidates ?? []).filter((service) => {
    const pickupAt = parsePickupAt(service.date, service.time);
    const phone = service.phone_e164?.trim() || service.phone?.trim();
    return pickupAt >= now && pickupAt <= in24h && Boolean(phone);
  });

  const serviceIds = windowCandidates.map((service) => service.id);
  const { data: existingEvents, error: eventsError } =
    serviceIds.length === 0
      ? { data: [], error: null }
      : await admin
          .from("whatsapp_events")
          .select("service_id")
          .in("service_id", serviceIds)
          .eq("kind", "24h_reminder");

  if (eventsError) {
    return NextResponse.json({ error: "Failed to load existing reminder events" }, { status: 500 });
  }

  const alreadySent = new Set((existingEvents ?? []).map((event) => event.service_id).filter(Boolean));
  const todo = windowCandidates.filter((service) => !alreadySent.has(service.id));

  const hotelIds = Array.from(new Set(todo.map((service) => service.hotel_id)));
  const { data: hotelsData } =
    hotelIds.length === 0
      ? { data: [] }
      : await admin.from("hotels").select("id, name").in("id", hotelIds);
  const hotelsById = new Map((hotelsData ?? []).map((hotel) => [hotel.id, hotel.name]));

  let sent = 0;
  for (const service of todo) {
    const phone = service.phone_e164?.trim() || service.phone?.trim() || "";
    const pickupAt = parsePickupAt(service.date, service.time);
    const hotelName = hotelsById.get(service.hotel_id) ?? "";

    const result = await sendWhatsAppMessage({
      to: phone,
      template: "transfer_reminder_24h",
      variables: {
        name: service.customer_name ?? "",
        date: pickupAt.toISOString(),
        hotel: hotelName,
        meeting_point: service.meeting_point ?? ""
      }
    });

    const nowIso = new Date().toISOString();
    if (!result.ok) {
      await logWhatsAppEvent(admin, {
        tenant_id: service.tenant_id,
        service_id: service.id,
        to_phone: phone,
        kind: "24h_reminder",
        template: "transfer_reminder_24h",
        status: "failed",
        provider_message_id: null,
        happened_at: nowIso,
        payload_json: {
          source: "api/jobs/whatsapp-reminders",
          error: result.error ?? "send failed"
        }
      });
      continue;
    }

    sent += 1;
    await logWhatsAppEvent(admin, {
      tenant_id: service.tenant_id,
      service_id: service.id,
      to_phone: result.phoneE164,
      kind: "24h_reminder",
      template: "transfer_reminder_24h",
      status: "sent",
      provider_message_id: result.messageId ?? null,
      happened_at: nowIso,
      payload_json: {
        source: "api/jobs/whatsapp-reminders"
      }
    });
  }

  return NextResponse.json({
    processed: todo.length,
    sent
  });
}

