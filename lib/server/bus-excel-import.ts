import { ZodIssue } from "zod";

const PLACEHOLDER_HOTEL_VALUES = new Set([
  "",
  "vuoto",
  "hotel destinazione",
  "hotel partenza",
  "destinazione hotel",
  "partenza hotel",
  "nd",
  "n d",
  "n/d"
]);

function normalizeLooseText(value: string | null | undefined) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function isPlaceholderHotelValue(value: string | null | undefined) {
  return PLACEHOLDER_HOTEL_VALUES.has(normalizeLooseText(value));
}

export function sanitizeImportPhone(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  const digits = raw.replace(/[^\d+]/g, "");
  const normalized = digits.startsWith("+") ? `+${digits.slice(1).replace(/[^\d]/g, "")}` : digits.replace(/[^\d]/g, "");
  if (normalized.length >= 6) {
    return normalized.slice(0, 30);
  }
  return "000000";
}

export function sanitizeImportCustomerName(value: string | null | undefined, rowIndex: number) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length >= 2 ? normalized : `Cliente import riga ${rowIndex}`;
}

export function splitPassengerChunks(pax: number, maxPaxPerService = 16) {
  if (!Number.isFinite(pax) || pax <= 0) return [];
  const chunks: number[] = [];
  let remaining = Math.floor(pax);
  while (remaining > 0) {
    const nextChunk = Math.min(remaining, maxPaxPerService);
    chunks.push(nextChunk);
    remaining -= nextChunk;
  }
  return chunks;
}

export function appendSplitImportNote(notes: string, totalPax: number, chunkIndex: number, chunkCount: number) {
  if (chunkCount <= 1) return notes;
  const suffix = `Split import Excel ${chunkIndex}/${chunkCount} da ${totalPax} pax`;
  return [notes.trim(), suffix].filter(Boolean).join(" | ");
}

export function formatImportValidationMessage(issue?: ZodIssue) {
  if (!issue) return "Riga non valida.";
  if (issue.message && issue.message !== "Invalid") return issue.message;

  const path = issue.path.at(0);
  if (typeof path === "string" && path.length > 0) {
    return `Campo ${path} non valido.`;
  }
  return "Riga non valida.";
}
