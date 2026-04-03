import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { parseInboundEmail } from "@/lib/email-parser";
import { extractPdfTextFromBase64, isPdfAttachment } from "@/lib/server/pdf-text";
import { inboundWebhookSchema } from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const inboundToken = request.headers.get("x-inbound-token");
  const expectedToken = process.env.EMAIL_INBOUND_TOKEN;
  if (!expectedToken || inboundToken !== expectedToken) {
    return NextResponse.json({ ok: false, error: "Unauthorized token" }, { status: 401 });
  }

  const parsed = inboundWebhookSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.errors[0]?.message ?? "Invalid payload" }, { status: 400 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) {
    return NextResponse.json({ ok: false, error: "Missing server env vars" }, { status: 500 });
  }

  const pdfTexts: string[] = [];
  for (const attachment of parsed.data.attachments ?? []) {
    if (!isPdfAttachment(attachment.filename, attachment.mime_type) || !attachment.content_base64) continue;
    const text = await extractPdfTextFromBase64(attachment.content_base64);
    if (text) pdfTexts.push(text);
  }

  const extractedText = pdfTexts.join("\n\n---\n\n") || null;
  const parsedJson = parseInboundEmail(parsed.data.raw_text, parsed.data.template_key, extractedText);
  const payloadJson = {
    ...parsedJson,
    source: parsed.data.source ?? "inbound-mailbox",
    template_key: parsed.data.template_key ?? parsedJson.template_key ?? "agency-default",
    mailbox: parsed.data.mailbox ?? "test-mailbox",
    from_email: parsed.data.from_email ?? null,
    subject: parsed.data.subject ?? null,
    received_at: parsed.data.received_at ?? new Date().toISOString(),
    attachments: (parsed.data.attachments ?? []).map((item) => ({
      filename: item.filename,
      mime_type: item.mime_type,
      size_bytes: item.size_bytes,
      has_content: Boolean(item.content_base64)
    })),
    pdf_text_excerpt: (extractedText ?? "").slice(0, 3000)
  };
  const supabase = createClient(supabaseUrl, serviceRole);
  const { data, error } = await supabase
    .from("inbound_emails")
    .insert({
      tenant_id: parsed.data.tenant_id,
      raw_text: parsed.data.raw_text,
      extracted_text: extractedText,
      parsed_json: payloadJson
    })
    .select("id")
    .single();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, id: data.id, parsed_json: payloadJson });
}
