import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { parseInboundEmail } from "@/lib/email-parser";
import { extractPdfTextFromBase64, isPdfAttachment } from "@/lib/server/pdf-text";

export const runtime = "nodejs";

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_BODY_TEXT_BYTES = 200_000;
const MAX_BODY_HTML_BYTES = 300_000;
const MAX_ATTACHMENT_BASE64_CHARS = 2_500_000;
const MAX_TOTAL_ATTACHMENTS_BASE64_CHARS = 5_000_000;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 30;

const attachmentSchema = z
  .union([
    z.object({
      filename: z.string().min(1).max(240),
      mimetype: z.string().min(1).max(120),
      base64: z.string().min(1)
    }),
    z.object({
      nome: z.string().min(1).max(240),
      mimetype: z.string().min(1).max(120),
      base64: z.string().min(1)
    })
  ])
  .transform((value) => ({
    filename: "filename" in value ? value.filename : value.nome,
    mimetype: value.mimetype,
    base64: value.base64
  }));

const inboundEmailPayloadSchema = z.object({
  subject: z.string().min(1).max(240),
  from: z.string().email().max(240),
  body_text: z.string().min(1).max(400_000),
  body_html: z.string().max(600_000).optional(),
  attachments: z.array(attachmentSchema).max(20).optional().default([])
});

type RateEntry = {
  count: number;
  resetAt: number;
};

const rateByIp = new Map<string, RateEntry>();

function clientIp(request: NextRequest) {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

function tooLarge(text: string, maxBytes: number) {
  return Buffer.byteLength(text, "utf8") > maxBytes;
}

function rateLimited(ip: string) {
  const now = Date.now();
  const current = rateByIp.get(ip);
  if (!current || current.resetAt <= now) {
    rateByIp.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  if (current.count >= RATE_LIMIT_MAX) return true;
  current.count += 1;
  rateByIp.set(ip, current);
  return false;
}

async function resolveTenantId(admin: any) {
  const envTenant = process.env.INBOUND_DEFAULT_TENANT_ID;
  if (envTenant) return envTenant;

  const { data: demoTenant } = (await admin
    .from("tenants")
    .select("id")
    .eq("name", "Demo Ischia")
    .maybeSingle()) as { data: { id?: string } | null };
  if (demoTenant?.id) return demoTenant.id;

  const { data: firstTenant } = (await admin.from("tenants").select("id").limit(1).maybeSingle()) as {
    data: { id?: string } | null;
  };
  return firstTenant?.id ?? null;
}

export async function POST(request: NextRequest) {
  const expectedToken = process.env.EMAIL_INBOUND_TOKEN;
  const receivedToken = request.headers.get("x-inbound-token");
  if (!expectedToken || !receivedToken || receivedToken !== expectedToken) {
    return NextResponse.json({ ok: false, error: "Unauthorized token" }, { status: 401 });
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return NextResponse.json({ ok: false, error: "Payload too large" }, { status: 413 });
  }

  const ip = clientIp(request);
  if (rateLimited(ip)) {
    return NextResponse.json({ ok: false, error: "Rate limit exceeded" }, { status: 429 });
  }

  const rawPayload = await request.json().catch(() => null);
  const parsed = inboundEmailPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid payload" }, { status: 400 });
  }

  if (tooLarge(parsed.data.body_text, MAX_BODY_TEXT_BYTES)) {
    return NextResponse.json({ ok: false, error: "body_text too large" }, { status: 413 });
  }
  if (parsed.data.body_html && tooLarge(parsed.data.body_html, MAX_BODY_HTML_BYTES)) {
    return NextResponse.json({ ok: false, error: "body_html too large" }, { status: 413 });
  }

  let totalAttachmentChars = 0;
  const pdfTexts: string[] = [];
  for (const attachment of parsed.data.attachments) {
    if (attachment.base64.length > MAX_ATTACHMENT_BASE64_CHARS) {
      return NextResponse.json({ ok: false, error: `Attachment too large: ${attachment.filename}` }, { status: 413 });
    }
    totalAttachmentChars += attachment.base64.length;
    if (totalAttachmentChars > MAX_TOTAL_ATTACHMENTS_BASE64_CHARS) {
      return NextResponse.json({ ok: false, error: "Total attachments payload too large" }, { status: 413 });
    }
    if (!isPdfAttachment(attachment.filename, attachment.mimetype)) continue;
    const text = await extractPdfTextFromBase64(attachment.base64);
    if (text) pdfTexts.push(text);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) {
    return NextResponse.json({ ok: false, error: "Missing server env vars" }, { status: 500 });
  }

  const admin = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const tenantId = await resolveTenantId(admin);
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "No tenant available" }, { status: 400 });
  }

  const extractedText = pdfTexts.join("\n\n---\n\n") || null;
  const parsedFields = parseInboundEmail([parsed.data.subject, parsed.data.body_text].filter(Boolean).join("\n"), "agency-default", extractedText);

  const draftDate = parsedFields.date ?? new Date().toISOString().slice(0, 10);
  const draftTime = parsedFields.time ?? "09:00";
  const draftPax = parsedFields.pax && parsedFields.pax > 0 ? parsedFields.pax : 1;
  const draftCustomer = parsedFields.customer_name?.trim() || "Cliente da verificare";
  const draftPhone = parsedFields.phone?.trim() || "N/D";
  const draftVessel = parsedFields.vessel?.trim() || "Porto/Nave da verificare";
  const draftDirection: "arrival" | "departure" = "arrival";

  const { data: hotelsData } = await admin
    .from("hotels")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .limit(200);
  const hotels = (hotelsData ?? []) as Array<{ id: string; name: string }>;
  const matchedHotel = hotels.find((hotel) =>
    parsedFields.hotel ? hotel.name.toLowerCase().includes(parsedFields.hotel.toLowerCase()) : false
  );
  const fallbackHotelId = matchedHotel?.id ?? hotels[0]?.id ?? null;
  if (!fallbackHotelId) {
    return NextResponse.json({ ok: false, error: "No hotel available for tenant draft creation" }, { status: 400 });
  }

  const parsedJson = {
    source: "inbound-email-mvp",
    from_email: parsed.data.from,
    subject: parsed.data.subject,
    body_html: parsed.data.body_html ?? null,
    received_at: new Date().toISOString(),
    parser_suggestions: {
      date: parsedFields.date ?? null,
      time: parsedFields.time ?? null,
      pax: parsedFields.pax ?? null,
      hotel: parsedFields.hotel ?? null,
      porto: parsedFields.pickup ?? parsedFields.dropoff ?? null,
      nave: parsedFields.vessel ?? null,
      customer_name: parsedFields.customer_name ?? null,
      phone: parsedFields.phone ?? null,
      confidence: parsedFields.confidence ?? {}
    },
    review_status: "needs_review",
    attachments: parsed.data.attachments.map((item) => ({
      filename: item.filename,
      mime_type: item.mimetype,
      size_base64_chars: item.base64.length,
      has_content: Boolean(item.base64),
      base64: item.base64
    }))
  };

  const { data, error } = await admin
    .from("inbound_emails")
    .insert({
      tenant_id: tenantId,
      raw_text: parsed.data.body_text,
      from_email: parsed.data.from,
      subject: parsed.data.subject,
      body_text: parsed.data.body_text,
      body_html: parsed.data.body_html ?? null,
      raw_json: rawPayload,
      extracted_text: extractedText,
      parsed_json: parsedJson
    })
    .select("id, parsed_json")
    .single();

  if (error) {
    console.error("Inbound email insert error", error.message);
    return NextResponse.json({ ok: false, error: "Failed to store inbound email" }, { status: 500 });
  }

  const attachmentRows = await Promise.all(
    parsed.data.attachments.map(async (attachment) => {
      const attachmentExtractedText = isPdfAttachment(attachment.filename, attachment.mimetype)
        ? await extractPdfTextFromBase64(attachment.base64)
        : "";
      const sizeBytes = Buffer.from(attachment.base64, "base64").byteLength;
      return {
        inbound_email_id: data.id,
        tenant_id: tenantId,
        filename: attachment.filename,
        mimetype: attachment.mimetype,
        size_bytes: sizeBytes,
        stored: true,
        extracted_text: attachmentExtractedText || null
      };
    })
  );
  if (attachmentRows.length > 0) {
    const { error: attachmentInsertError } = await admin.from("inbound_email_attachments").insert(attachmentRows);
    if (attachmentInsertError) {
      console.error("Inbound attachment insert error", attachmentInsertError.message);
    }
  }

  const draftNotes = [
    "[needs_review] Draft creato da inbound email",
    `from: ${parsed.data.from}`,
    `subject: ${parsed.data.subject}`,
    parsedFields.pickup ? `pickup/porto: ${parsedFields.pickup}` : "",
    parsedFields.dropoff ? `dropoff: ${parsedFields.dropoff}` : ""
  ]
    .filter(Boolean)
    .join(" | ");

  const { data: draftService, error: draftError } = await admin
    .from("services")
    .insert({
      tenant_id: tenantId,
      inbound_email_id: data.id,
      is_draft: true,
      date: draftDate,
      time: draftTime,
      service_type: "transfer",
      direction: draftDirection,
      vessel: draftVessel,
      pax: draftPax,
      hotel_id: fallbackHotelId,
      customer_name: draftCustomer,
      phone: draftPhone,
      notes: draftNotes,
      status: "needs_review"
    })
    .select("id")
    .single();

  if (draftError) {
    console.error("Inbound draft service insert error", draftError.message);
    return NextResponse.json({ ok: false, error: "Inbound stored but draft service creation failed" }, { status: 500 });
  }

  const updatedParsedJson = {
    ...(data.parsed_json as Record<string, unknown>),
    draft_service_id: draftService.id
  };
  await admin.from("inbound_emails").update({ parsed_json: updatedParsedJson }).eq("id", data.id).eq("tenant_id", tenantId);

  return NextResponse.json({ ok: true, id: data.id, tenant_id: tenantId, draft_service_id: draftService.id });
}
