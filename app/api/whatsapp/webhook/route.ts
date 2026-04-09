import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient, logWhatsAppEvent, mapWebhookStatus } from "@/lib/server/whatsapp";

export const runtime = "nodejs";

const verifyModeSchema = z.object({
  mode: z.string().optional(),
  token: z.string().optional(),
  challenge: z.string().optional()
});

const webhookSchema = z.object({
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              value: z.object({
                statuses: z
                  .array(
                    z.object({
                      id: z.string(),
                      status: z.string(),
                      timestamp: z.string().optional(),
                      recipient_id: z.string().optional(),
                      errors: z.array(z.record(z.unknown())).optional()
                    })
                  )
                  .optional()
              })
            })
          )
          .optional()
      })
    )
    .optional()
});

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
    return new NextResponse(params.data.challenge ?? "", { status: 200 });
  }

  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export async function POST(request: NextRequest) {
  const parsed = webhookSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid webhook payload" }, { status: 400 });
  }

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "Server env missing" }, { status: 500 });
  }

  const statuses =
    parsed.data.entry?.flatMap((entry) => entry.changes?.flatMap((change) => change.value.statuses ?? []) ?? []) ?? [];

  let updated = 0;
  let logged = 0;
  for (const statusUpdate of statuses) {
    const mappedStatus = mapWebhookStatus(statusUpdate.status);
    if (!mappedStatus) continue;

    const statusTimestampMs = Number(statusUpdate.timestamp) * 1000;
    const happenedAt =
      Number.isFinite(statusTimestampMs) && statusTimestampMs > 0
        ? new Date(statusTimestampMs).toISOString()
        : new Date().toISOString();

    const { data: serviceHit } = await admin
      .from("services")
      .select("id, tenant_id")
      .eq("message_id", statusUpdate.id)
      .maybeSingle();

    const patch: { reminder_status: string; sent_at?: string } = {
      reminder_status: mappedStatus
    };

    if (mappedStatus === "sent") {
      patch.sent_at = happenedAt;
    }

    const updateQuery = admin.from("services").update(patch).eq("message_id", statusUpdate.id);
    if (serviceHit?.tenant_id) {
      updateQuery.eq("tenant_id", serviceHit.tenant_id);
    }
    const { error } = await updateQuery;
    if (!error) updated += 1;

    if (serviceHit?.tenant_id) {
      await logWhatsAppEvent(admin, {
        tenant_id: serviceHit.tenant_id,
        service_id: serviceHit.id,
        to_phone: statusUpdate.recipient_id ?? "unknown",
        kind: "webhook",
        template: process.env.WHATSAPP_TEMPLATE_NAME ?? null,
        status: mappedStatus,
        provider_message_id: statusUpdate.id,
        happened_at: happenedAt,
        payload_json: {
          source: "api/whatsapp/webhook",
          raw_status: statusUpdate.status,
          errors: statusUpdate.errors ?? []
        }
      });
      logged += 1;
    }
  }

  return NextResponse.json({ ok: true, processed: statuses.length, updated, logged });
}
