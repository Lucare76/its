import { Buffer } from "node:buffer";
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { claudeEmailExtract } from "@/lib/server/claude-email-extract";
import { isPdfAttachment } from "@/lib/server/pdf-text";

export const runtime = "nodejs";

const MAX_FILE_BYTES = 8 * 1024 * 1024;

export async function POST(request: NextRequest) {
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

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY non configurata." }, { status: 503 });
  }

  const subject = String(form.get("subject") ?? `Preview PDF ${file.name}`).slice(0, 240);
  const bodyText = String(form.get("body_text") ?? "").trim().slice(0, 200_000);

  const bytes = Buffer.from(await file.arrayBuffer());
  const pdfBase64 = bytes.toString("base64");

  const result = await claudeEmailExtract(pdfBase64, bodyText, subject);

  // Restituisce in formato claude_extracted così il frontend usa claudeExtractedToForm
  return NextResponse.json({
    ok: true,
    mode: "claude_preview",
    filename: file.name,
    claude_extracted: {
      agency: result.agency,
      form: result.form,
      raw_json: result.rawJson
    }
  });
}
