import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createDraftFromPdfUpload } from "@/lib/server/agency-pdf-import";
import { parseInboundEmail } from "@/lib/email-parser";
import { extractPdfTextFromBase64, isPdfAttachment } from "@/lib/server/pdf-text";
import { tryMatchAndApplyPricing } from "@/lib/server/pricing-matching";
import { selectAgencyPdfParser } from "@/lib/server/agency-pdf-parser-registry";

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

function isValidIsoDate(value?: string) {
  if (!value) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function normalizeTimeOrDefault(value?: string) {
  if (!value) return "09:00";
  const match = value.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return "09:00";
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function extractPracticeNumber(...sources: Array<string | null | undefined>) {
  for (const source of sources) {
    const hit = source?.match(/(\d{2}\/\d{6})/);
    if (hit?.[1]) return hit[1];
  }
  return null;
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

  const { data: firstTenant, error: firstTenantError } = (await admin.from("tenants").select("id").limit(1).maybeSingle()) as {
    data: { id?: string } | null;
    error?: { message?: string } | null;
  };
  if (firstTenantError) {
    throw new Error(`Tenant lookup failed: ${firstTenantError.message ?? "unknown error"}`);
  }
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

  const firstPdfAttachment = parsed.data.attachments.find((attachment) => isPdfAttachment(attachment.filename, attachment.mimetype));
  if (firstPdfAttachment) {
    try {
      const pdfBytes = Buffer.from(firstPdfAttachment.base64, "base64");
      const autoImport = await createDraftFromPdfUpload(
        {
          admin,
          user: { id: null },
          membership: { tenant_id: tenantId, role: "system" }
        },
        {
          senderEmail: parsed.data.from,
          subject: parsed.data.subject,
          filename: firstPdfAttachment.filename,
          bodyText: parsed.data.body_text,
          fileBytes: pdfBytes,
          fileSize: pdfBytes.byteLength
        }
      );

      if ("draft_service_id" in autoImport && typeof autoImport.draft_service_id === "string") {
        const pricingSourceText = [
          parsed.data.subject,
          parsed.data.body_text,
          autoImport.normalized.notes,
          autoImport.normalized.booking_kind === "transfer_train_hotel" ? "transfer stazione hotel transfer hotel stazione treno" : null,
          autoImport.normalized.transport_code,
          autoImport.normalized.arrival_transport_code,
          autoImport.normalized.departure_transport_code,
          autoImport.normalized.arrival_place,
          autoImport.normalized.hotel_or_destination
        ]
          .filter(Boolean)
          .join("\n");

        await tryMatchAndApplyPricing(admin, {
          tenantId,
          inboundEmailId: "inbound_email_id" in autoImport ? autoImport.inbound_email_id : null,
          serviceId: autoImport.draft_service_id,
          sourceText: pricingSourceText,
          serviceType: "transfer",
          direction: "arrival",
          date: autoImport.normalized.arrival_date,
          time: autoImport.normalized.outbound_time,
          pax: autoImport.normalized.passengers,
          bookingKind: autoImport.normalized.booking_kind,
          serviceVariant: autoImport.normalized.service_variant
        });
      }

      return NextResponse.json({
        ...autoImport,
        id: "inbound_email_id" in autoImport && typeof autoImport.inbound_email_id === "string" ? autoImport.inbound_email_id : null,
        tenant_id: tenantId
      });
    } catch (error) {
      return NextResponse.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : "Inbound PDF import failed"
        },
        { status: 500 }
      );
    }
  }

  const extractedText = pdfTexts.join("\n\n---\n\n") || null;
  const parsedFields = parseInboundEmail([parsed.data.subject, parsed.data.body_text].filter(Boolean).join("\n"), "agency-default", extractedText);
  const parserSelection = extractedText
    ? selectAgencyPdfParser({
        senderEmail: parsed.data.from,
        subject: parsed.data.subject,
        filename: parsed.data.attachments[0]?.filename ?? null,
        extractedText
      })
    : null;

  const draftDate = isValidIsoDate(parsedFields.date) ? (parsedFields.date as string) : new Date().toISOString().slice(0, 10);
  const draftTime = normalizeTimeOrDefault(parsedFields.time);
  const rawDraftPax = parsedFields.pax && parsedFields.pax > 0 ? parsedFields.pax : 1;
  const draftPax = Math.max(1, Math.min(16, rawDraftPax));
  const draftCustomer = parsedFields.customer_name?.trim() || "Cliente da verificare";
  const draftPhone = parsedFields.phone?.trim() || "N/D";
  const draftVessel = parsedFields.vessel?.trim() || "Porto/Nave da verificare";
  const draftDirection: "arrival" | "departure" = parsedFields.direction ?? "arrival";
  const practiceNumber = extractPracticeNumber(parsed.data.subject, parsed.data.body_text, extractedText);
  const practiceMarker = practiceNumber ? `[practice:${practiceNumber}]` : null;

  const { data: hotelsData, error: hotelsError } = await admin
    .from("hotels")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .limit(200);
  if (hotelsError) {
    return NextResponse.json({ ok: false, error: `Hotel lookup failed: ${hotelsError.message}` }, { status: 500 });
  }
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
      departure_date: parsedFields.departure_date ?? null,
      departure_time: parsedFields.departure_time ?? null,
      direction: parsedFields.direction ?? null,
      pax: parsedFields.pax ?? null,
      hotel: parsedFields.hotel ?? null,
      porto: parsedFields.pickup ?? parsedFields.dropoff ?? null,
      nave: parsedFields.vessel ?? null,
      customer_name: parsedFields.customer_name ?? null,
      phone: parsedFields.phone ?? null,
      confidence: parsedFields.confidence ?? {}
    },
    review_status: "needs_review",
    pdf_parser: parserSelection
      ? {
          key: parserSelection.parserKey,
          score: parserSelection.score
        }
      : null,
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
    practiceMarker ?? "",
    `from: ${parsed.data.from}`,
    `subject: ${parsed.data.subject}`,
    parsedFields.pickup ? `pickup/porto: ${parsedFields.pickup}` : "",
    parsedFields.dropoff ? `dropoff: ${parsedFields.dropoff}` : ""
  ]
    .filter(Boolean)
    .join(" | ");

  const draftBasePayload = {
    tenant_id: tenantId,
    date: draftDate,
    time: draftTime,
    service_type: "transfer",
    direction: draftDirection,
    vessel: draftVessel,
    pax: draftPax,
    hotel_id: fallbackHotelId,
    customer_name: draftCustomer,
    phone: draftPhone,
    notes: draftNotes
  };

  const draftCandidates = [
    { ...draftBasePayload, inbound_email_id: data.id, is_draft: true, status: "needs_review" },
    { ...draftBasePayload, inbound_email_id: data.id, is_draft: true, status: "new" },
    { ...draftBasePayload, status: "needs_review" },
    { ...draftBasePayload, status: "new" }
  ];

  let draftServiceId: string | null = null;
  if (practiceNumber) {
    const { data: existingByPractice } = await admin
      .from("services")
      .select("id")
      .eq("tenant_id", tenantId)
      .ilike("notes", `%[practice:${practiceNumber}]%`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    draftServiceId = existingByPractice?.id ?? null;
  }

  let draftInsert: { data: { id: string } | null; error: { message?: string } | null } = { data: null, error: null };
  if (!draftServiceId) {
    for (const candidate of draftCandidates) {
      const attempt = await admin.from("services").insert(candidate).select("id").single();
      draftInsert = attempt;
      if (!attempt.error) {
        draftServiceId = attempt.data?.id ?? null;
        break;
      }
    }
  }

  const draftError = draftInsert.error;
  if (draftError && !draftServiceId) {
    console.error("Inbound draft service insert error", draftError.message);
    return NextResponse.json(
      {
        ok: false,
        error: "Inbound stored but draft service creation failed",
        details: draftError.message ?? "unknown"
      },
      { status: 500 }
    );
  }

  if (!draftServiceId) {
    return NextResponse.json({ ok: false, error: "Inbound stored but draft service creation failed", details: "missing draft id" }, { status: 500 });
  }

  const updatedParsedJson = {
    ...(data.parsed_json as Record<string, unknown>),
    draft_service_id: draftServiceId
  };
  await admin.from("inbound_emails").update({ parsed_json: updatedParsedJson }).eq("id", data.id).eq("tenant_id", tenantId);

  await tryMatchAndApplyPricing(admin, {
    tenantId,
    inboundEmailId: data.id,
    serviceId: draftServiceId,
    sourceText: [parsed.data.subject, parsed.data.body_text, extractedText ?? ""].filter(Boolean).join("\n"),
    serviceType: "transfer",
    direction: draftDirection,
    date: draftDate,
    time: draftTime,
    pax: draftPax
  });

  return NextResponse.json({
    ok: true,
    id: data.id,
    tenant_id: tenantId,
    draft_service_id: draftServiceId,
    extracted_text: extractedText,
    parsed_json: updatedParsedJson
  });
}
