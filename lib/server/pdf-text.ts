import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

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

export async function extractPdfHeaderTextFromBase64(contentBase64: string) {
  if (process.platform !== "win32") return "";

  const tempFile = path.join(os.tmpdir(), `ischia-pdf-header-${Date.now()}-${Math.random().toString(16).slice(2)}.pdf`);
  try {
    await fs.writeFile(tempFile, Buffer.from(contentBase64, "base64"));
    const scriptPath = path.join(process.cwd(), "scripts", "pdf-header-ocr.ps1");
    const output = await new Promise<string>((resolve) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, tempFile],
        { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 * 4 },
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
