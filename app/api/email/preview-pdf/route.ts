import { Buffer } from "node:buffer";
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { claudeEmailExtract } from "@/lib/server/claude-email-extract";
import { HaikuExtractError, MODEL as HAIKU_MODEL } from "@/lib/server/pdf-extract-haiku";
import { isPdfAttachment } from "@/lib/server/pdf-text";
import { resolveBusStop } from "@/lib/server/bus-lines-catalog";
import { logAiUsage } from "@/lib/server/ai-usage-log";

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

  try {
    const result = await claudeEmailExtract(pdfBase64, bodyText, subject);

    await logAiUsage({
      tenantId: auth.membership.tenant_id,
      source: "manual",
      model: HAIKU_MODEL,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens
    });

    // Per servizi bus: usa l'orario dal catalogo fermate (fonte autoritativa)
    const enrichedForm = { ...result.form };
    if (enrichedForm.tipo_servizio === "bus_city_hotel" && enrichedForm.citta_partenza) {
      const busStop = resolveBusStop(enrichedForm.citta_partenza);
      if (busStop?.time) {
        enrichedForm.orario_arrivo = busStop.time;
      }
    }

    // Restituisce in formato claude_extracted così il frontend usa claudeExtractedToForm
    return NextResponse.json({
      ok: true,
      mode: "claude_preview",
      filename: file.name,
      claude_extracted: {
        agency: result.agency,
        form: enrichedForm,
        raw_json: result.rawJson
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Errore durante l'analisi del PDF.";
    console.error("[preview-pdf] errore Claude:", message);
    const usage = err instanceof HaikuExtractError ? err.usage : { inputTokens: 0, outputTokens: 0 };
    await logAiUsage({
      tenantId: auth.membership.tenant_id,
      source: "manual",
      model: HAIKU_MODEL,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      failed: true,
      errorMessage: message.slice(0, 2000)
    });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
