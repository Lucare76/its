import { Buffer } from "node:buffer";
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { parseAgencyPdfUpload } from "@/lib/server/agency-pdf-import";
import { auditLog } from "@/lib/server/ops-audit";
import { isPdfAttachment } from "@/lib/server/pdf-text";

export const runtime = "nodejs";

const MAX_FILE_BYTES = 8 * 1024 * 1024;

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "File PDF mancante." }, { status: 400 });
    }
    if (file.size <= 0 || file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ ok: false, error: "File non valido o troppo grande (max 8MB)." }, { status: 400 });
    }
    if (!isPdfAttachment(file.name, file.type)) {
      return NextResponse.json({ ok: false, error: "Formato non supportato. Carica un PDF." }, { status: 400 });
    }

    const subject = String(form.get("subject") ?? `Preview PDF ${file.name}`).slice(0, 240);
    const fromEmailRaw = String(form.get("from_email") ?? "agency@example.com").trim().toLowerCase();
    const fromEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmailRaw) ? fromEmailRaw : "agency@example.com";
    const bodyText = String(form.get("body_text") ?? "").trim().slice(0, 200_000);

    const bytes = Buffer.from(await file.arrayBuffer());
    const parsed = await parseAgencyPdfUpload({
      senderEmail: fromEmail,
      subject,
      filename: file.name,
      bodyText,
      fileBytes: bytes
    });

    return NextResponse.json({
      ok: true,
      mode: "preview_only",
      tenant_id: auth.membership.tenant_id,
      filename: file.name,
      extracted_text_available: Boolean(parsed.extractedText),
      preview: parsed.preview,
      normalized: parsed.normalized
    });
  } catch (error) {
    auditLog({ event: "pdf_preview_route_unhandled", level: "error", details: { message: error instanceof Error ? error.message : "Unknown error" } });
    return NextResponse.json({ ok: false, error: "Errore interno server." }, { status: 500 });
  }
}
