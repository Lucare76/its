import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { parseMedmarTicketText } from "@/lib/medmar-ticket-memory";

export const runtime = "nodejs";

const requestSchema = z.object({
  image_base64: z.string().min(32),
  mime_type: z.string().min(5).max(120).optional(),
});

async function extractImageTextWithOcrSpace(imageBase64: string, mimeType: string) {
  const apiKey = process.env.OCR_SPACE_API_KEY?.trim();
  const endpoint = process.env.OCR_SPACE_ENDPOINT?.trim() || "https://api.ocr.space/parse/image";
  const language = process.env.OCR_SPACE_LANGUAGE?.trim() || "ita";

  if (!apiKey) {
    throw new Error("OCR_SPACE_API_KEY non configurata sul server.");
  }

  const body = new URLSearchParams();
  body.set("base64Image", `data:${mimeType};base64,${imageBase64}`);
  body.set("language", language);
  body.set("scale", "true");
  body.set("detectOrientation", "true");
  body.set("isOverlayRequired", "false");
  body.set("OCREngine", "2");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      apikey: apiKey,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`OCR Space ${response.status}`);
  }

  const json = (await response.json()) as {
    IsErroredOnProcessing?: boolean;
    ErrorMessage?: string[] | string;
    ParsedResults?: Array<{ ParsedText?: string | null }>;
  };

  if (json.IsErroredOnProcessing) {
    const message = Array.isArray(json.ErrorMessage) ? json.ErrorMessage.join(" | ") : json.ErrorMessage;
    throw new Error(message || "OCR non riuscito.");
  }

  return (json.ParsedResults ?? [])
    .map((item) => item.ParsedText?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Body JSON non valido." }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Immagine non valida." }, { status: 400 });
  }

  try {
    const rawText = await extractImageTextWithOcrSpace(
      parsed.data.image_base64,
      parsed.data.mime_type?.trim() || "image/jpeg",
    );

    const extracted = parseMedmarTicketText(rawText);
    return NextResponse.json({ ok: true, extracted });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Errore estrazione ticket.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
