import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { downloadWhatsAppMedia } from "@/lib/server/whatsapp";

export const runtime = "nodejs";

function sanitizeFilename(input: string) {
  return input.replace(/[^\w.\-() ]+/g, "_").trim() || "allegato-whatsapp";
}

function inferFilename(message: {
  message_type: string | null;
  media_mime_type: string | null;
  raw_message: Record<string, unknown> | null;
}) {
  const raw = message.raw_message ?? {};
  const documentMeta = typeof raw.document === "object" && raw.document !== null
    ? raw.document as { filename?: unknown }
    : null;
  const existing = typeof documentMeta?.filename === "string" ? documentMeta.filename : "";
  if (existing.trim()) return sanitizeFilename(existing);

  const extension = message.media_mime_type?.split("/")[1]?.split(";")[0]?.trim() ?? "bin";
  const base = message.message_type === "image"
    ? "foto-whatsapp"
    : message.message_type === "document"
      ? "documento-whatsapp"
      : "allegato-whatsapp";
  return `${base}.${extension}`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ messageId: string }> }
) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor", "assistenza"]);
  if (auth instanceof NextResponse) return auth;

  const { messageId } = await params;
  const { data: message, error } = await auth.admin
    .from("whatsapp_messages")
    .select("id, media_id, media_mime_type, message_type, raw_message")
    .or(`tenant_id.eq.${auth.membership.tenant_id},tenant_id.is.null`)
    .eq("id", messageId)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!message?.id) return NextResponse.json({ error: "Messaggio non trovato." }, { status: 404 });
  if (!message.media_id) return NextResponse.json({ error: "Questo messaggio non ha allegati." }, { status: 404 });

  const media = await downloadWhatsAppMedia(message.media_id);
  if (!media.ok) {
    return NextResponse.json({ error: media.error }, { status: media.status });
  }

  const filename = inferFilename({
    message_type: message.message_type ?? null,
    media_mime_type: message.media_mime_type ?? null,
    raw_message: (message.raw_message as Record<string, unknown> | null) ?? null,
  });

  return new NextResponse(media.data.bytes, {
    status: 200,
    headers: {
      "Content-Type": media.data.mimeType,
      "Content-Length": String(media.data.bytes.byteLength),
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
