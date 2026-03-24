import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { createAdminClient, getTenantWhatsAppSettings, logWhatsAppEvent, sendWhatsAppMessage } from "@/lib/server/whatsapp";

export const runtime = "nodejs";

function minutesUntilArrival(date: string, time: string) {
  const target = new Date(`${date}T${time.slice(0, 5)}:00`);
  return Math.round((target.getTime() - Date.now()) / 60000);
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;
    const admin = createAdminClient();
    const settings = await getTenantWhatsAppSettings(admin, tenantId);
    const date = request.nextUrl.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);

    const { data, error } = await admin
      .from("services")
      .select("id, tenant_id, customer_name, phone, phone_e164, date, time, meeting_point, vessel, hotel_id, status")
      .eq("tenant_id", tenantId)
      .eq("direction", "arrival")
      .eq("date", date)
      .in("status", ["new", "assigned", "partito"]);
    if (error) throw new Error(error.message);

    return NextResponse.json({
      ok: true,
      settings: {
        enable_arrival_messages: settings.enable_arrival_messages,
        arrival_template: settings.arrival_template,
        arrival_notice_minutes: settings.arrival_notice_minutes
      },
      candidates: (data ?? []).map((service: { id: string; customer_name: string; date: string; time: string; phone: string | null; phone_e164: string | null; meeting_point: string | null; vessel: string | null }) => ({
        ...service,
        minutes_to_arrival: minutesUntilArrival(service.date, service.time),
        has_phone: Boolean(service.phone_e164 || service.phone)
      }))
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;
    const admin = createAdminClient();
    const settings = await getTenantWhatsAppSettings(admin, tenantId);
    const body = await request.json().catch(() => null);
    const serviceId = String(body?.service_id ?? "");
    const dryRun = body?.dry_run !== false;

    const { data: service, error } = await admin
      .from("services")
      .select("id, tenant_id, customer_name, phone, phone_e164, date, time, meeting_point, vessel")
      .eq("tenant_id", tenantId)
      .eq("id", serviceId)
      .maybeSingle();
    if (error || !service) throw new Error(error?.message ?? "Servizio non trovato.");

    const payload = {
      to: service.phone_e164 || service.phone,
      template: settings.arrival_template,
      variables: {
        name: service.customer_name,
        time: service.time.slice(0, 5),
        meeting_point: service.meeting_point ?? "",
        vessel: service.vessel ?? ""
      }
    };

    if (dryRun) {
      return NextResponse.json({ ok: true, preview: payload, mode: "preview_only" });
    }

    const result = await sendWhatsAppMessage(payload);
    await logWhatsAppEvent(admin, {
      tenant_id: tenantId,
      service_id: service.id,
      to_phone: result.ok ? result.phoneE164 : payload.to,
      kind: "manual",
      template: settings.arrival_template,
      status: result.ok ? "sent" : "failed",
      provider_message_id: result.ok ? result.messageId ?? null : null,
      happened_at: new Date().toISOString(),
      payload_json: {
        source: "api/ops/whatsapp-arrivals",
        mode: "arrival_auto",
        error: result.ok ? null : result.error ?? "send failed"
      }
    });

    return NextResponse.json({ ok: result.ok, result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
