import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/server/whatsapp";
import { verifyMetaSignature } from "@/lib/server/whatsapp/signature";
import {
  extractWebhookDedupeKey,
  extractWebhookEventType,
  processWhatsAppWebhook
} from "@/lib/server/whatsapp/webhook-processing";
import type { MetaWebhookPayload } from "@/lib/server/whatsapp/types";

export const runtime = "nodejs";

const verifyModeSchema = z.object({
  mode: z.string().optional(),
  token: z.string().optional(),
  challenge: z.string().optional()
});

const webhookPayloadSchema = z.object({
  object: z.string().optional(),
  entry: z.array(z.unknown()).optional()
}).passthrough();

export async function GET(request: NextRequest) {
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!verifyToken) {
    console.error("WhatsApp webhook GET missing verify token env");
    return NextResponse.json({ error: "Server env missing" }, { status: 500 });
  }

  const params = verifyModeSchema.safeParse({
    mode: request.nextUrl.searchParams.get("hub.mode") ?? undefined,
    token: request.nextUrl.searchParams.get("hub.verify_token") ?? undefined,
    challenge: request.nextUrl.searchParams.get("hub.challenge") ?? undefined
  });

  if (!params.success) {
    console.warn("WhatsApp webhook GET invalid verify payload");
    return NextResponse.json({ error: "Invalid verify payload" }, { status: 400 });
  }

  if (params.data.mode === "subscribe" && params.data.token === verifyToken) {
    console.info("WhatsApp webhook GET verified");
    return new NextResponse(params.data.challenge ?? "", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }

  console.warn("WhatsApp webhook GET forbidden");
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  console.info("WhatsApp webhook POST received", {
    hasSignature: Boolean(signature),
    contentLength: rawBody.length
  });

  const appSecret = process.env.WHATSAPP_APP_SECRET?.trim().replace(/^["']|["']$/g, "");
  if (!appSecret) {
    console.error("WhatsApp webhook POST missing app secret env");
    return NextResponse.json({ error: "Server env missing" }, { status: 500 });
  }

  if (!verifyMetaSignature(rawBody, signature, appSecret)) {
    console.warn("WhatsApp webhook POST invalid signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    console.warn("WhatsApp webhook POST invalid JSON");
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = webhookPayloadSchema.safeParse(parsedJson);
  if (!parsed.success) {
    console.warn("WhatsApp webhook POST invalid payload schema");
    return NextResponse.json({ error: "Invalid webhook payload" }, { status: 400 });
  }

  const payload = parsed.data as MetaWebhookPayload;
  const dedupeKey = extractWebhookDedupeKey(payload);
  const eventType = extractWebhookEventType(payload);
  const fields = Array.from(new Set(
    (payload.entry ?? []).flatMap((entry) => (entry.changes ?? []).map((change) => change.field ?? "unknown"))
  ));
  const messagesCount = (payload.entry ?? []).reduce(
    (sum, entry) => sum + (entry.changes ?? []).reduce((inner, change) => inner + (change.value?.messages?.length ?? 0), 0),
    0
  );
  const statusesCount = (payload.entry ?? []).reduce(
    (sum, entry) => sum + (entry.changes ?? []).reduce((inner, change) => inner + (change.value?.statuses?.length ?? 0), 0),
    0
  );
  console.info("WhatsApp webhook POST accepted", {
    object: payload.object ?? null,
    entryCount: payload.entry?.length ?? 0,
    eventType,
    field: fields.join(","),
    messagesCount,
    statusesCount,
    hasDedupeKey: Boolean(dedupeKey)
  });

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    console.error("WhatsApp webhook POST admin client init failed");
    return NextResponse.json({ ok: true, accepted: true, processed: false, reason: "admin_client_init_failed" });
  }

  const { data: eventRow, error: insertError } = await admin
    .from("whatsapp_webhook_events")
    .insert({
      provider: "meta",
      event_type: eventType,
      object: payload.object ?? null,
      raw_payload: payload,
      signature_valid: true,
      dedupe_key: dedupeKey
    })
    .select("id")
    .single();

  if (insertError) {
    const duplicate = insertError.code === "23505";
    if (duplicate) {
      console.info("WhatsApp webhook POST duplicate event");
      return NextResponse.json({ ok: true, duplicate: true });
    }
    console.error("WhatsApp webhook POST archive failed", {
      code: insertError.code ?? null,
      message: insertError.message
    });
    return NextResponse.json({ ok: true, accepted: true, processed: false, reason: "archive_failed" });
  }

  try {
    const result = await processWhatsAppWebhook(admin, payload, eventRow?.id);
    console.info("WhatsApp webhook POST processed", {
      messages: result.messages,
      statuses: result.statuses,
      contacts: result.contacts,
      tenantsResolved: result.tenantsResolved,
      errors: result.errors.length
    });
    return NextResponse.json({ ok: true, accepted: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown processing error";
    console.error("WhatsApp webhook POST processing failed", { message });
    if (eventRow?.id) {
      await admin
        .from("whatsapp_webhook_events")
        .update({
          processed_at: new Date().toISOString(),
          processing_error: message.slice(0, 2000)
        })
        .eq("id", eventRow.id);
    }
    return NextResponse.json({ ok: true, accepted: true, processed: false, reason: "processing_failed" });
  }
}

