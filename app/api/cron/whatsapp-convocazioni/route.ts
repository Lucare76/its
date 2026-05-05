import { NextRequest, NextResponse } from "next/server";
import {
  createAdminClient,
  logWhatsAppEvent,
  normalizeE164,
  whatsappGraphVersion,
} from "@/lib/server/whatsapp";

export const runtime = "nodejs";

// Convocazioni bus_city_hotel: inviati al cliente il giorno prima dell'arrivo.
// Include punto di partenza (meeting_point) e telefono autista (da bus_unit_driver_dates
// con fallback a tenant_bus_units).
// Schedule: 11:05 UTC ogni giorno (= 13:05 ora italiana estiva CEST).

function hasCronAuth(request: NextRequest) {
  const expected = process.env.WHATSAPP_CRON_SECRET ?? process.env.CRON_SECRET;
  if (!expected) return false;
  return request.headers.get("authorization") === `Bearer ${expected}`;
}

async function sendConvocazioneTemplate(
  phoneNumberId: string,
  accessToken: string,
  toPhone: string,
  templateName: string,
  customerName: string,
  serviceDate: string,
  meetingPoint: string,
  driverName: string,
  driverPhone: string,
  qrImageUrl: string | null
) {
  const bodyParams = [
    { type: "text" as const, text: customerName.slice(0, 60) },
    { type: "text" as const, text: serviceDate },
    { type: "text" as const, text: meetingPoint.slice(0, 80) },
    { type: "text" as const, text: driverName.slice(0, 60) },
    { type: "text" as const, text: driverPhone },
  ];

  const components: object[] = [{ type: "body", parameters: bodyParams }];
  if (qrImageUrl) {
    components.unshift({
      type: "header",
      parameters: [{ type: "image", image: { link: qrImageUrl } }],
    });
  }

  const res = await fetch(
    `https://graph.facebook.com/${whatsappGraphVersion()}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: toPhone,
        type: "template",
        template: {
          name: templateName,
          language: { code: "it" },
          components,
        },
      }),
    }
  );

  const payload = (await res.json().catch(() => null)) as {
    messages?: Array<{ id: string }>;
    error?: { message?: string; code?: number };
  } | null;

  if (!res.ok) {
    console.error("Meta WhatsApp API error (convocazione)", {
      status: res.status,
      code: payload?.error?.code,
      message: payload?.error?.message,
      toPhone,
    });
  }

  return {
    ok: res.ok,
    messageId: payload?.messages?.[0]?.id ?? null,
    error: payload?.error?.message ?? (res.ok ? null : `HTTP ${res.status}`),
  };
}

async function runCron(request: NextRequest) {
  if (!hasCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const accessToken   = process.env.WHATSAPP_ACCESS_TOKEN?.trim() ?? process.env.WHATSAPP_TOKEN?.trim();
  if (!phoneNumberId || !accessToken) {
    return NextResponse.json(
      { error: "WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN non configurati" },
      { status: 500 }
    );
  }

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "Server env missing" }, { status: 500 });
  }

  // Leggi il tenant principale (usa il primo tenant attivo trovato con le impostazioni WA)
  // Per ora usiamo l'env var del tenant; in futuro si può iterare su tutti i tenant.
  const tenantId = process.env.DEFAULT_TENANT_ID?.trim();
  if (!tenantId) {
    // Cerca il primo tenant con impostazioni WA configurate
    const { data: settingsRow } = await admin
      .from("tenant_whatsapp_settings")
      .select("tenant_id")
      .limit(1)
      .maybeSingle();
    if (!settingsRow?.tenant_id) {
      return NextResponse.json({ error: "Nessun tenant WA configurato" }, { status: 500 });
    }
  }

  // Recupera il tenantId effettivo
  const { data: settingsRow } = await admin
    .from("tenant_whatsapp_settings")
    .select("tenant_id")
    .limit(1)
    .maybeSingle();
  const effectiveTenantId = tenantId ?? settingsRow?.tenant_id;
  if (!effectiveTenantId) {
    return NextResponse.json({ error: "Tenant non trovato" }, { status: 500 });
  }

  // Data di domani (servizi da convocate domani)
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const todayStr = new Date().toISOString().slice(0, 10);

  const templateName =
    process.env.WHATSAPP_TEMPLATE_CONVOCAZIONE ?? "its_bus_convocazione";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";

  // 1. Servizi bus_city_hotel per domani con telefono
  const { data: services, error: svcError } = await admin
    .from("services")
    .select("id, tenant_id, customer_name, phone, phone_e164, meeting_point, date")
    .eq("tenant_id", effectiveTenantId)
    .eq("date", tomorrow)
    .eq("booking_service_kind", "bus_city_hotel")
    .neq("status", "cancelled")
    .not("phone", "is", null)
    .limit(500);

  if (svcError) {
    return NextResponse.json({ error: "Query servizi fallita: " + svcError.message }, { status: 500 });
  }
  if (!services || services.length === 0) {
    return NextResponse.json({ ok: true, todayStr, tomorrow, toSend: 0, sent: 0, skipped: 0, failed: 0 });
  }

  const serviceIds = services.map((s) => s.id);

  // 2. Allocazioni per trovare bus_unit_id per ogni servizio
  const { data: allocations } = await admin
    .from("tenant_bus_allocations")
    .select("service_id, bus_unit_id")
    .eq("tenant_id", effectiveTenantId)
    .in("service_id", serviceIds);

  const unitByService = new Map<string, string>(
    (allocations ?? []).map((a: { service_id: string; bus_unit_id: string }) => [a.service_id, a.bus_unit_id])
  );

  // 3. Autisti per-data per domani (sovrascrive i campi statici)
  const unitIds = [...new Set(unitByService.values())];

  type DriverInfo = { unit_id: string; driver_name_outbound: string | null; driver_phone_outbound: string | null };
  let driverDates: DriverInfo[] = [];
  if (unitIds.length) {
    const { data } = await admin
      .from("bus_unit_driver_dates")
      .select("unit_id, driver_name_outbound, driver_phone_outbound")
      .eq("tenant_id", effectiveTenantId)
      .eq("travel_date", tomorrow)
      .in("unit_id", unitIds);
    driverDates = (data ?? []) as DriverInfo[];
  }

  const driverByUnit = new Map<string, { name: string | null; phone: string | null }>(
    driverDates.map((d) => [d.unit_id, { name: d.driver_name_outbound, phone: d.driver_phone_outbound }])
  );

  // 4. Fallback: campi statici sulle unità
  type BusUnitInfo = { id: string; driver_name_outbound: string | null; driver_phone_outbound: string | null };
  let busUnits: BusUnitInfo[] = [];
  if (unitIds.length) {
    const { data } = await admin
      .from("tenant_bus_units")
      .select("id, driver_name_outbound, driver_phone_outbound")
      .eq("tenant_id", effectiveTenantId)
      .in("id", unitIds);
    busUnits = (data ?? []) as BusUnitInfo[];
  }

  const staticDriverByUnit = new Map<string, { name: string | null; phone: string | null }>(
    busUnits.map((u) => [u.id, { name: u.driver_name_outbound, phone: u.driver_phone_outbound }])
  );

  // 5. Deduplicazione: già inviati oggi
  const { data: priorEvents } = await admin
    .from("whatsapp_events")
    .select("service_id")
    .in("service_id", serviceIds)
    .eq("kind", "bus_convocazione")
    .in("status", ["sent", "delivered", "read"]);

  const alreadySent = new Set((priorEvents ?? []).map((e: { service_id: string }) => e.service_id));

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const svc of services) {
    if (alreadySent.has(svc.id)) { skipped++; continue; }

    const unitId = unitByService.get(svc.id);
    if (!unitId) { skipped++; continue; }

    // Nome e telefono autista: per-data con fallback statico
    const driver = driverByUnit.has(unitId)
      ? driverByUnit.get(unitId)
      : staticDriverByUnit.get(unitId);

    const driverPhone = driver?.phone?.trim();
    const driverName  = driver?.name?.trim();

    if (!driverPhone || !driverName) { skipped++; continue; }

    const meetingPoint = (svc.meeting_point as string | null)?.trim();
    if (!meetingPoint) { skipped++; continue; }

    const phone = (svc.phone_e164 as string | null) ?? normalizeE164(svc.phone as string);
    const qrUrl = appUrl ? `${appUrl}/api/public/qr/${svc.id}` : null;
    const nowIso = new Date().toISOString();

    const result = await sendConvocazioneTemplate(
      phoneNumberId,
      accessToken,
      phone,
      templateName,
      (svc.customer_name as string) ?? "",
      svc.date as string,
      meetingPoint,
      driverName,
      driverPhone,
      qrUrl
    );

    await logWhatsAppEvent(admin, {
      tenant_id: svc.tenant_id as string,
      service_id: svc.id,
      to_phone: phone,
      kind: "bus_convocazione",
      template: templateName,
      status: result.ok ? "sent" : "failed",
      provider_message_id: result.messageId,
      happened_at: nowIso,
      payload_json: {
        source: "api/cron/whatsapp-convocazioni",
        meeting_point: meetingPoint,
        driver_name: driverName,
        driver_phone: driverPhone,
        bus_unit_id: unitId,
        arrival_date: svc.date,
        error: result.error ?? undefined,
      },
    });

    if (result.ok) { sent++; } else { failed++; }
  }

  return NextResponse.json({
    ok: true,
    todayStr,
    tomorrow,
    toSend: services.length,
    sent,
    skipped,
    failed,
  });
}

export async function GET(request: NextRequest) { return runCron(request); }
export async function POST(request: NextRequest) { return runCron(request); }
