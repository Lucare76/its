import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export function isPdfAttachment(filename: string, mimeType?: string | null) {
  const normalizedMime = (mimeType ?? "").toLowerCase();
  return normalizedMime.includes("pdf") || filename.toLowerCase().endsWith(".pdf");
}

function hasCorruptedPdfTextShape(text: string) {
  const value = text.trim();
  if (!value) return true;

  const controlChars = (value.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g) ?? []).length;
  const weirdRatio = controlChars / Math.max(value.length, 1);
  const words = value.match(/[A-Za-zÀ-ÿ]{3,}/g) ?? [];
  const printable = value.match(/[A-Za-zÀ-ÿ0-9]/g) ?? [];

  return weirdRatio > 0.02 || (words.length < 20 && printable.length < 300);
}

async function runWindowsPdfOcr(contentBase64: string) {
  if (process.platform !== "win32") return "";

  const tempFile = path.join(os.tmpdir(), `ischia-pdf-ocr-${Date.now()}-${Math.random().toString(16).slice(2)}.pdf`);
  try {
    await fs.writeFile(tempFile, Buffer.from(contentBase64, "base64"));
    const scriptPath = path.join(process.cwd(), "scripts", "pdf-header-ocr.ps1");
    const output = await new Promise<string>((resolve) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, tempFile],
        { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 * 8 },
        (error, stdout) => {
          if (error) return resolve("");
          resolve(String(stdout ?? "").trim());
        }
      );
    });
    return output;
  } catch {
    return "";
  } finally {
    await fs.unlink(tempFile).catch(() => undefined);
  }
}

export async function extractPdfTextFromBase64(contentBase64: string) {
  try {
    const buffer = Buffer.from(contentBase64, "base64");
    const pdfParseModule = await import("pdf-parse");
    const parsePdf = pdfParseModule.default as (dataBuffer: Buffer) => Promise<{ text?: string }>;
    const parsed = await parsePdf(buffer);
    const extracted = parsed.text?.trim() ?? "";

    if (!hasCorruptedPdfTextShape(extracted)) {
      return extracted;
    }

    const ocrText = await runWindowsPdfOcr(contentBase64);
    return ocrText.trim() || extracted;
  } catch {
    return runWindowsPdfOcr(contentBase64);
  }
}

export async function extractPdfHeaderTextFromBase64(contentBase64: string) {
  return runWindowsPdfOcr(contentBase64);
}
