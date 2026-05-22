import { NextRequest, NextResponse } from "next/server";
import {
  createAdminClient,
  logWhatsAppEvent,
  normalizeE164,
  selectInfoTemplate,
  whatsappGraphVersion,
} from "@/lib/server/whatsapp";

export const runtime = "nodejs";

// Template WhatsApp "Prima di partire".
// Spread anti-ban: gli arrivi vengono distribuiti su 4 giorni (3-6 giorni prima)
// in base all'hash del service_id — evita picchi di volume sulla domenica.
// Lingua: +39 → italiano, altri prefissi → inglese.

function hasCronAuth(request: NextRequest) {
  const expected = process.env.WHATSAPP_CRON_SECRET ?? process.env.CRON_SECRET;
  if (!expected) return false;
  return request.headers.get("authorization") === `Bearer ${expected}`;
}

// Restituisce 3, 4, 5 o 6 in base all'id del servizio — distribuzione uniforme
function sendDaysAhead(serviceId: string): number {
  let hash = 0;
  for (let i = 0; i < serviceId.length; i++) {
    hash = (hash * 31 + serviceId.charCodeAt(i)) >>> 0;
  }
  return 3 + (hash % 4);
}

function detectLanguage(phone: string): "it" | "en" {
  const e164 = normalizeE164(phone);
  return e164.startsWith("+39") ? "it" : "en";
}

async function sendInfoTemplate(
  phoneNumberId: string,
  accessToken: string,
  toPhone: string,
  templateName: string,
  customerName: string,
  extraParams: string[],
  languageCode: string,
  qrImageUrl?: string | null
) {
  const bodyParams = [
    { type: "text" as const, text: customerName.slice(0, 60) },
    ...extraParams.map((p) => ({ type: "text" as const, text: p })),
  ];

  const components: object[] = [{ type: "body", parameters: bodyParams }];
  if (qrImageUrl) {
    components.unshift({
      type: "header",
      parameters: [{ type: "image", image: { link: qrImageUrl } }],
    });
  }

  const res = await fetch(`https://graph.facebook.com/${whatsappGraphVersion()}/${phoneNumberId}/messages`, {
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
        language: { code: languageCode },
        components,
      },
    }),
  });

  const payload = (await res.json().catch(() => null)) as {
    messages?: Array<{ id: string }>;
    error?: { message?: string };
  } | null;

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
  const defaultLang   = (process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? "it").replace("-", "_");

  if (!phoneNumberId || !accessToken) {
    return NextResponse.json({ error: "WHATSAPP_PHONE_NUMBER_ID e WHATSAPP_ACCESS_TOKEN non configurati" }, { status: 500 });
  }

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "Server env missing" }, { status: 500 });
  }

  const today = new Date();
  // Finestra 3-6 giorni: carica tutti i candidati dell'intervallo, poi filtra per spread
  const dateFrom = new Date(today.getTime() + 3 * 86_400_000).toISOString().slice(0, 10);
  const dateTo   = new Date(today.getTime() + 6 * 86_400_000).toISOString().slice(0, 10);
  const todayStr = today.toISOString().slice(0, 10);

  const infoKinds = [
    "transfer_airport_hotel",
    "transfer_train_hotel",
    "transfer_station_hotel",
    "formula_medmar_napoli",
    "formula_medmar_pozzuoli",
    "formula_snav",
    "bus_city_hotel",
  ];

  const { data: tenants } = await admin.from("tenants").select("id").limit(50);

  let totalScanned = 0;
  let totalToSend = 0;
  let totalSent = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const tenant of tenants ?? []) {
    const tenantId = tenant.id as string;

    const { data: candidates, error: candidatesError } = await admin
      .from("services")
      .select("id, tenant_id, customer_name, phone, phone_e164, booking_service_kind, status, date")
      .eq("tenant_id", tenantId)
      .gte("date", dateFrom)
      .lte("date", dateTo)
      .neq("status", "cancelled")
      .in("booking_service_kind", infoKinds)
      .not("phone", "is", null)
      .limit(2000);

    if (candidatesError) continue;

    totalScanned += candidates?.length ?? 0;

    // Filtra solo quelli il cui "send day" è oggi
    const services = (candidates ?? []).filter((svc) => {
      const arrivalDate = svc.date as string;
      const daysAhead   = sendDaysAhead(svc.id as string);
      const sendDate    = new Date(new Date(arrivalDate).getTime() - daysAhead * 86_400_000)
        .toISOString().slice(0, 10);
      return sendDate === todayStr;
    });

    if (services.length === 0) continue;

    totalToSend += services.length;

    // Deduplicazione
    const serviceIds = services.map((s) => s.id);
    const { data: priorEvents } = await admin
      .from("whatsapp_events")
      .select("service_id")
      .in("service_id", serviceIds)
      .eq("kind", "info_3d")
      .in("status", ["sent", "delivered", "read"]);

    const alreadySent = new Set((priorEvents ?? []).map((e) => e.service_id).filter(Boolean));

    for (const svc of services) {
      if (alreadySent.has(svc.id)) { totalSkipped++; continue; }

      const phone    = (svc.phone_e164 as string | null) ?? normalizeE164(svc.phone as string);
      const lang     = detectLanguage(phone) === "it" ? defaultLang : "en";
      const info     = selectInfoTemplate(svc.booking_service_kind, lang);
      if (!info) { totalSkipped++; continue; }

      const nowIso  = new Date().toISOString();
      const appUrl  = process.env.NEXT_PUBLIC_APP_URL ?? "";
      const qrUrl   = (info as { hasQrHeader?: boolean }).hasQrHeader && appUrl
        ? `${appUrl}/api/public/qr/${svc.id as string}`
        : null;

      const extraParams = info.needsDate
        ? [...info.parameters, svc.date as string]
        : info.parameters;

      const result = await sendInfoTemplate(
        phoneNumberId,
        accessToken,
        phone,
        info.templateName,
        (svc.customer_name as string) ?? "",
        extraParams,
        lang,
        qrUrl
      );

      await logWhatsAppEvent(admin, {
        tenant_id: svc.tenant_id as string,
        service_id: svc.id,
        to_phone: phone,
        kind: "info_3d",
        template: info.templateName,
        status: result.ok ? "sent" : "failed",
        provider_message_id: result.messageId,
        happened_at: nowIso,
        payload_json: {
          source: "api/cron/whatsapp-info",
          booking_service_kind: svc.booking_service_kind,
          lang,
          arrival_date: svc.date,
          error: result.error ?? undefined,
        },
      });

      if (result.ok) { totalSent++; } else { totalFailed++; }
    }
  }

  return NextResponse.json({ ok: true, todayStr, scanned: totalScanned, toSend: totalToSend, sent: totalSent, skipped: totalSkipped, failed: totalFailed });
}

export async function GET(request: NextRequest) { return runCron(request); }
export async function POST(request: NextRequest) { return runCron(request); }
