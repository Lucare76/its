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
    return NextResponse.json({ error: "Server env missing" }, { status: 500 });
  }

  const params = verifyModeSchema.safeParse({
    mode: request.nextUrl.searchParams.get("hub.mode") ?? undefined,
    token: request.nextUrl.searchParams.get("hub.verify_token") ?? undefined,
    challenge: request.nextUrl.searchParams.get("hub.challenge") ?? undefined
  });

  if (!params.success) {
    return NextResponse.json({ error: "Invalid verify payload" }, { status: 400 });
  }

  if (params.data.mode === "subscribe" && params.data.token === verifyToken) {
    return new NextResponse(params.data.challenge ?? "", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }

  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export async function POST(request: NextRequest) {
  const appSecret = process.env.WHATSAPP_APP_SECRET?.trim().replace(/^["']|["']$/g, "");
  if (!appSecret) {
    return NextResponse.json({ error: "Server env missing" }, { status: 500 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!verifyMetaSignature(rawBody, signature, appSecret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = webhookPayloadSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid webhook payload" }, { status: 400 });
  }

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "Server env missing" }, { status: 500 });
  }

  const payload = parsed.data as MetaWebhookPayload;
  const dedupeKey = extractWebhookDedupeKey(payload);
  const eventType = extractWebhookEventType(payload);

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
      return NextResponse.json({ ok: true, duplicate: true });
    }
    return NextResponse.json({ error: "Webhook archive failed" }, { status: 500 });
  }

  const result = await processWhatsAppWebhook(admin, payload, eventRow?.id);
  return NextResponse.json({ ok: true, ...result });
}

