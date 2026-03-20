import { execFile } from "node:child_process";
import { createSign } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanExtractedPdfText } from "@/lib/server/pdf-text-cleaning";

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
  const normalized = value.replace(/\r/g, "\n");
  const looksLikeEmptyForm =
    /Nome:\s*\n\s*Cognome:\s*\n\s*Data di Arrivo ad Ischia:/i.test(normalized) ||
    /Cellulare:\s*\n\s*Hotel di destinazione:/i.test(normalized) ||
    /Hotel di destinazione:\s*\n\s*Scegli l[’']?orario di partenza/i.test(normalized);

  return weirdRatio > 0.02 || (words.length < 20 && printable.length < 300) || looksLikeEmptyForm;
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

async function runOcrSpacePdfOcr(contentBase64: string) {
  const apiKey = process.env.OCR_SPACE_API_KEY?.trim() || "helloworld";
  const endpoint = process.env.OCR_SPACE_ENDPOINT?.trim() || "https://api.ocr.space/parse/image";
  const language = process.env.OCR_SPACE_LANGUAGE?.trim() || "ita";

  try {
    const body = new URLSearchParams();
    body.set("base64Image", `data:application/pdf;base64,${contentBase64}`);
    body.set("filetype", "PDF");
    body.set("language", language);
    body.set("scale", "true");
    body.set("detectOrientation", "true");
    body.set("isOverlayRequired", "false");
    body.set("OCREngine", "2");

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        apikey: apiKey,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString(),
      cache: "no-store"
    });

    if (!response.ok) return "";

    const json = (await response.json()) as {
      IsErroredOnProcessing?: boolean;
      ParsedResults?: Array<{ ParsedText?: string | null }>;
    };

    if (json.IsErroredOnProcessing) return "";

    return (json.ParsedResults ?? [])
      .map((item) => item.ParsedText?.trim() ?? "")
      .filter(Boolean)
      .join("\n")
      .trim();
  } catch {
    return "";
  }
}

function googleEnv() {
  const clientEmail = process.env.GOOGLE_CLOUD_VISION_CLIENT_EMAIL?.trim() ?? "";
  const privateKey = process.env.GOOGLE_CLOUD_VISION_PRIVATE_KEY?.replace(/\\n/g, "\n").trim() ?? "";
  const inputBucket = process.env.GOOGLE_CLOUD_VISION_INPUT_BUCKET?.trim() ?? "";
  const outputBucket = process.env.GOOGLE_CLOUD_VISION_OUTPUT_BUCKET?.trim() ?? "";
  return {
    clientEmail,
    privateKey,
    inputBucket,
    outputBucket,
    enabled: Boolean(clientEmail && privateKey && inputBucket && outputBucket)
  };
}

function base64Url(value: Buffer | string) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function getGoogleAccessToken() {
  const env = googleEnv();
  if (!env.enabled) return null;

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: env.clientEmail,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };

  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claim))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(env.privateKey);
  const assertion = `${unsigned}.${base64Url(signature)}`;

  const body = new URLSearchParams();
  body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
  body.set("assertion", assertion);

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    cache: "no-store"
  });

  if (!response.ok) return null;
  const json = (await response.json()) as { access_token?: string };
  return json.access_token ?? null;
}

async function uploadPdfToGoogleStorage(accessToken: string, contentBase64: string, objectName: string) {
  const env = googleEnv();
  const response = await fetch(
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(env.inputBucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/pdf"
      },
      body: Buffer.from(contentBase64, "base64"),
      cache: "no-store"
    }
  );

  return response.ok;
}

async function startGoogleVisionPdfOcr(accessToken: string, inputObjectName: string, outputPrefix: string) {
  const env = googleEnv();
  const response = await fetch("https://vision.googleapis.com/v1/files:asyncBatchAnnotate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      requests: [
        {
          inputConfig: {
            gcsSource: { uri: `gs://${env.inputBucket}/${inputObjectName}` },
            mimeType: "application/pdf"
          },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          outputConfig: {
            gcsDestination: { uri: `gs://${env.outputBucket}/${outputPrefix}` },
            batchSize: 1
          }
        }
      ]
    }),
    cache: "no-store"
  });

  if (!response.ok) return null;
  const json = (await response.json()) as { name?: string };
  return json.name ?? null;
}

async function waitForGoogleOperation(accessToken: string, operationName: string) {
  for (let attempt = 0; attempt < 18; attempt += 1) {
    const response = await fetch(`https://vision.googleapis.com/v1/${operationName}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store"
    });
    if (!response.ok) return false;
    const json = (await response.json()) as { done?: boolean; error?: unknown };
    if (json.done) return !json.error;
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  return false;
}

async function readGoogleVisionOutput(accessToken: string, outputPrefix: string) {
  const env = googleEnv();
  const listResponse = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(env.outputBucket)}/o?prefix=${encodeURIComponent(outputPrefix)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store"
    }
  );
  if (!listResponse.ok) return "";

  const listed = (await listResponse.json()) as { items?: Array<{ name?: string }> };
  const resultObject = (listed.items ?? []).find((item) => item.name?.endsWith(".json"))?.name;
  if (!resultObject) return "";

  const fileResponse = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(env.outputBucket)}/o/${encodeURIComponent(resultObject)}?alt=media`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store"
    }
  );
  if (!fileResponse.ok) return "";

  const json = (await fileResponse.json()) as {
    responses?: Array<{
      fullTextAnnotation?: { text?: string | null };
    }>;
  };

  return (json.responses ?? [])
    .map((item) => item.fullTextAnnotation?.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function runGoogleVisionPdfOcr(contentBase64: string) {
  const env = googleEnv();
  if (!env.enabled) return "";

  try {
    const accessToken = await getGoogleAccessToken();
    if (!accessToken) return "";

    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const inputObjectName = `incoming/${stamp}.pdf`;
    const outputPrefix = `output/${stamp}/`;

    const uploaded = await uploadPdfToGoogleStorage(accessToken, contentBase64, inputObjectName);
    if (!uploaded) return "";

    const operationName = await startGoogleVisionPdfOcr(accessToken, inputObjectName, outputPrefix);
    if (!operationName) return "";

    const completed = await waitForGoogleOperation(accessToken, operationName);
    if (!completed) return "";

    return await readGoogleVisionOutput(accessToken, outputPrefix);
  } catch {
    return "";
  }
}

async function runServerCompatiblePdfOcr(contentBase64: string) {
  const windowsText = await runWindowsPdfOcr(contentBase64);
  if (windowsText.trim()) return windowsText;

  const googleVisionText = await runGoogleVisionPdfOcr(contentBase64);
  if (googleVisionText.trim()) return googleVisionText;

  return runOcrSpacePdfOcr(contentBase64);
}

export async function extractPdfTextFromBase64(contentBase64: string) {
  try {
    const buffer = Buffer.from(contentBase64, "base64");
    const pdfParseModule = await import("pdf-parse");
    const parsePdf = pdfParseModule.default as (dataBuffer: Buffer) => Promise<{ text?: string }>;
    const parsed = await parsePdf(buffer);
    const extracted = parsed.text?.trim() ?? "";

    if (!hasCorruptedPdfTextShape(extracted)) {
      return cleanExtractedPdfText(extracted);
    }

    const ocrText = await runServerCompatiblePdfOcr(contentBase64);
    return cleanExtractedPdfText(ocrText.trim() || extracted);
  } catch {
    const fallback = await runServerCompatiblePdfOcr(contentBase64);
    return cleanExtractedPdfText(fallback);
  }
}

export async function extractPdfHeaderTextFromBase64(contentBase64: string) {
  return cleanExtractedPdfText(await runServerCompatiblePdfOcr(contentBase64));
}
