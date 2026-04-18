import { NextRequest, NextResponse } from "next/server";
import {
  createAdminClient,
  logWhatsAppEvent,
  normalizeE164,
  selectInfoTemplate,
} from "@/lib/server/whatsapp";

export const runtime = "nodejs";

// Template WhatsApp "Prima di partire" — inviati 3 giorni prima dell'arrivo del cliente.
// Selezione automatica del template in base al booking_service_kind.
// Deduplicazione via whatsapp_events (kind = "info_3d").

function hasCronAuth(request: NextRequest) {
  const expected = process.env.WHATSAPP_CRON_SECRET ?? process.env.CRON_SECRET;
  if (!expected) return false;
  return request.headers.get("authorization") === `Bearer ${expected}`;
}

async function sendInfoTemplate(
  phoneNumberId: string,
  accessToken: string,
  toPhone: string,
  templateName: string,
  customerName: string,
  extraParams: string[],
  languageCode: string
) {
  const parameters = [
    { type: "text" as const, text: customerName.slice(0, 60) },
    ...extraParams.map((p) => ({ type: "text" as const, text: p })),
  ];

  const res = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
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
        components: [{ type: "body", parameters }],
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
  const accessToken   = process.env.WHATSAPP_TOKEN?.trim();
  const languageCode  = (process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? "it").replace("-", "_");

  if (!phoneNumberId || !accessToken) {
    return NextResponse.json({ error: "WHATSAPP_PHONE_NUMBER_ID e WHATSAPP_TOKEN non configurati" }, { status: 500 });
  }

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "Server env missing" }, { status: 500 });
  }

  // Servizi con arrivo fra esattamente 3 giorni
  const targetDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const infoKinds = [
    "transfer_airport_hotel",
    "transfer_train_hotel",
    "transfer_station_hotel",
    "formula_medmar_napoli",
    "formula_medmar_pozzuoli",
    "formula_snav",
  ];

  const { data: candidates, error: candidatesError } = await admin
    .from("services")
    .select("id, tenant_id, customer_name, phone, phone_e164, booking_service_kind, status")
    .eq("date", targetDate)
    .neq("status", "cancelled")
    .in("booking_service_kind", infoKinds)
    .not("phone", "is", null)
    .limit(1000);

  if (candidatesError) {
    return NextResponse.json({ error: "Query fallita: " + candidatesError.message }, { status: 500 });
  }

  const services = candidates ?? [];
  if (services.length === 0) {
    return NextResponse.json({ ok: true, targetDate, scanned: 0, sent: 0, skipped: 0, failed: 0 });
  }

  // Carica eventi già inviati per deduplicazione
  const serviceIds = services.map((s) => s.id);
  const { data: priorEvents } = await admin
    .from("whatsapp_events")
    .select("service_id")
    .in("service_id", serviceIds)
    .eq("kind", "info_3d")
    .in("status", ["sent", "delivered", "read"]);

  const alreadySent = new Set((priorEvents ?? []).map((e) => e.service_id).filter(Boolean));

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const svc of services) {
    if (alreadySent.has(svc.id)) { skipped++; continue; }

    const info = selectInfoTemplate(svc.booking_service_kind);
    if (!info) { skipped++; continue; }

    const toPhone = (svc.phone_e164 as string | null) ?? normalizeE164(svc.phone as string);
    const nowIso  = new Date().toISOString();

    const result = await sendInfoTemplate(
      phoneNumberId,
      accessToken,
      toPhone,
      info.templateName,
      (svc.customer_name as string) ?? "",
      info.parameters,
      languageCode
    );

    await logWhatsAppEvent(admin, {
      tenant_id: svc.tenant_id as string,
      service_id: svc.id,
      to_phone: toPhone,
      kind: "info_3d",
      template: info.templateName,
      status: result.ok ? "sent" : "failed",
      provider_message_id: result.messageId,
      happened_at: nowIso,
      payload_json: {
        source: "api/cron/whatsapp-info",
        booking_service_kind: svc.booking_service_kind,
        error: result.error ?? undefined,
      },
    });

    if (result.ok) { sent++; } else { failed++; }
  }

  return NextResponse.json({
    ok: true,
    targetDate,
    scanned: services.length,
    sent,
    skipped,
    failed,
  });
}

export async function GET(request: NextRequest) {
  return runCron(request);
}

export async function POST(request: NextRequest) {
  return runCron(request);
}
