// Excel column mapping + row parsing for MEDMAR WhatsApp convocations.
// Canonical column set (definitive spec): INVIARE, NUMERO CLIENTE,
// NOME CLIENTE, DATA PARTENZA, HOTEL, PAX, ORA PRELEVAMENTO, ORA NAVE.
// Mirrors the tolerant header-detection approach used by /bus-convocations
// (app/(app)/bus-convocations/page.tsx) but isolated so it can be unit
// tested without loading the xlsx library or a React component.

export type MedmarParsedField =
  | "inviare"
  | "phoneRaw"
  | "customerName"
  | "travelDate"
  | "hotel"
  | "passengers"
  | "pickupTime"
  | "vesselTime";

export const MEDMAR_COLUMN_KEYWORDS: Record<MedmarParsedField, string[][]> = {
  inviare: [["inviare"], ["invio"], ["send"]],
  phoneRaw: [["numero", "cliente"], ["telefono", "cliente"], ["telefono"], ["cellulare"], ["cell"], ["phone"]],
  customerName: [["nome", "cliente"], ["nominativo"], ["cliente"], ["nome"]],
  travelDate: [["data", "partenza"], ["data", "viaggio"], ["data"]],
  hotel: [["hotel"], ["albergo"], ["struttura"]],
  passengers: [["pax"], ["passeggeri"], ["persone"]],
  pickupTime: [["ora", "prelevamento"], ["prelevamento"], ["ora", "pickup"], ["pickup"]],
  vesselTime: [["ora", "nave"], ["orario", "nave"], ["partenza", "nave"], ["nave"]],
};

// All 8 canonical fields are required (inviare defaults to true when absent
// from the header, but every other field must be mapped to a column).
export const MEDMAR_REQUIRED_FIELDS: MedmarParsedField[] = [
  "phoneRaw", "customerName", "travelDate", "hotel", "passengers", "pickupTime", "vesselTime",
];

export const MEDMAR_FIELD_LABELS: Record<MedmarParsedField, string> = {
  inviare: "Inviare",
  phoneRaw: "numero cliente",
  customerName: "nome cliente",
  travelDate: "data partenza",
  hotel: "hotel",
  passengers: "pax",
  pickupTime: "ora prelevamento",
  vesselTime: "ora nave",
};

export function normalizeHeader(s: string): string {
  return s.trim().toLowerCase().replace(/[\s\n\r]+/g, " ").replace(/[?!.:;]/g, "");
}

export function findColumnIndex(header: string[], keywordSets: string[][]): number {
  const normalized = header.map(normalizeHeader);
  for (const keywords of keywordSets) {
    const idx = normalized.findIndex((h) => keywords.every((kw) => h.includes(kw.toLowerCase())));
    if (idx >= 0) return idx;
  }
  return -1;
}

export function parseInviare(value: unknown): boolean {
  if (value == null) return false;
  const s = String(value).trim().toUpperCase();
  return ["SI", "SÌ", "S", "1", "TRUE", "X", "YES", "Y"].includes(s);
}

export type MedmarColumnMap = Partial<Record<MedmarParsedField, number>>;

export type HeaderDetectionResult =
  | { ok: true; headerRowIndex: number; header: string[]; colMap: MedmarColumnMap }
  | { ok: false; reason: string };

// Scans the first `maxScanRows` rows for a header that contains all
// required fields mapped to *distinct* columns, tolerating leading
// title/blank rows. A header where "ora prelevamento" and "ora nave" (or
// any other two required fields) resolve to the same column index is
// rejected rather than silently mis-mapped.
export function detectMedmarHeader(raw: unknown[][], maxScanRows = 10): HeaderDetectionResult {
  for (let r = 0; r < Math.min(raw.length, maxScanRows); r++) {
    const candidate = (raw[r] as unknown[]).map((c) => String(c ?? "").trim());
    if (candidate.filter((c) => c.length > 0).length < 3) continue;

    const candidateMap: MedmarColumnMap = {};
    for (const field of Object.keys(MEDMAR_COLUMN_KEYWORDS) as MedmarParsedField[]) {
      const idx = findColumnIndex(candidate, MEDMAR_COLUMN_KEYWORDS[field]);
      if (idx >= 0) candidateMap[field] = idx;
    }

    const requiredIndices = MEDMAR_REQUIRED_FIELDS.map((f) => candidateMap[f]).filter((i): i is number => i != null);
    const hasAllRequired = requiredIndices.length === MEDMAR_REQUIRED_FIELDS.length;
    const allDistinct = new Set(requiredIndices).size === requiredIndices.length;

    if (hasAllRequired && allDistinct) {
      return { ok: true, headerRowIndex: r, header: candidate, colMap: candidateMap };
    }
  }

  const firstRow = ((raw[0] as unknown[]) ?? []).map((c) => String(c ?? "").trim()).filter((h) => h.length > 0).join(", ");
  return { ok: false, reason: `Intestazioni colonne non trovate nelle prime ${maxScanRows} righe del file.${firstRow ? `\n\nPrima riga: ${firstRow}` : ""}` };
}

export function missingRequiredFields(colMap: MedmarColumnMap): MedmarParsedField[] {
  return MEDMAR_REQUIRED_FIELDS.filter((f) => colMap[f] == null);
}

// travelDate/pickupTime/vesselTime keep the raw Excel cell value (Date
// object, numeric serial, or string) — formatting into display strings is
// deferred to lib/medmar-convocation-format.ts so Date objects are never
// stringified into "Mon Sep 07 2026 GMT+0200..." garbage before they reach
// a proper formatter.
export type MedmarParsedRow = {
  rowIndex: number;
  inviare: boolean;
  phoneRaw: string;
  customerName: string;
  travelDateRaw: unknown;
  hotel: string;
  passengers: string;
  pickupTimeRaw: unknown;
  vesselTimeRaw: unknown;
};

function textCell(row: unknown[], idx: number | undefined): string {
  if (idx == null || idx < 0 || idx >= row.length) return "";
  const v = row[idx];
  if (v instanceof Date && !isNaN(v.getTime())) {
    const dd = String(v.getDate()).padStart(2, "0");
    const mm = String(v.getMonth() + 1).padStart(2, "0");
    const yyyy = v.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }
  return String(v ?? "").trim();
}

function rawCell(row: unknown[], idx: number | undefined): unknown {
  if (idx == null || idx < 0 || idx >= row.length) return null;
  return row[idx];
}

export function parseMedmarRows(raw: unknown[][], headerRowIndex: number, colMap: MedmarColumnMap): MedmarParsedRow[] {
  const rows: MedmarParsedRow[] = [];
  for (let i = headerRowIndex + 1; i < raw.length; i++) {
    const r = raw[i] as unknown[];
    if (!r || r.every((c) => c == null || String(c).trim() === "")) continue;

    const inviare = colMap.inviare != null ? parseInviare(r[colMap.inviare]) : true;

    rows.push({
      rowIndex: i + 1,
      inviare,
      phoneRaw: textCell(r, colMap.phoneRaw),
      customerName: textCell(r, colMap.customerName),
      travelDateRaw: rawCell(r, colMap.travelDate),
      hotel: textCell(r, colMap.hotel),
      passengers: textCell(r, colMap.passengers),
      pickupTimeRaw: rawCell(r, colMap.pickupTime),
      vesselTimeRaw: rawCell(r, colMap.vesselTime),
    });
  }
  return rows;
}
