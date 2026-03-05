export function isPdfAttachment(filename: string, mimeType?: string | null) {
  const normalizedMime = (mimeType ?? "").toLowerCase();
  return normalizedMime.includes("pdf") || filename.toLowerCase().endsWith(".pdf");
}

export async function extractPdfTextFromBase64(contentBase64: string) {
  try {
    const buffer = Buffer.from(contentBase64, "base64");
    const pdfParseModule = await import("pdf-parse");
    const parsePdf = pdfParseModule.default as (dataBuffer: Buffer) => Promise<{ text?: string }>;
    const parsed = await parsePdf(buffer);
    return parsed.text?.trim() ?? "";
  } catch {
    return "";
  }
}
