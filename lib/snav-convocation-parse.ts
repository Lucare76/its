// Excel column mapping + row parsing for SNAV WhatsApp convocations.
// Canonical column set (definitive spec): INVIARE, NUMERO CLIENTE,
// NOME CLIENTE, DATA PARTENZA, HOTEL, PAX, ORA PRELEVAMENTO, ORA NAVE.
// Mirrors lib/medmar-convocation-parse.ts (tolerant header detection,
// position-independent) but isolated so it can be unit tested without the
// xlsx library or a React component. NO tratta / compagnia / porto /
// riferimento — those are not part of the SNAV format.

export type SnavParsedField =
  | "inviare"
  | "phoneRaw"
  | "customerName"
  | "departureDate"
  | "hotel"
  | "passengers"
  | "pickupTime"
  | "vesselTime";

export const SNAV_COLUMN_KEYWORDS: Record<SnavParsedField, string[][]> = {
  inviare: [["inviare"], ["invio"], ["send"]],
  phoneRaw: [["numero", "cliente"], ["telefono", "cliente"], ["telefono"], ["cellulare"], ["cell"], ["phone"]],
  customerName: [["nome", "cliente"], ["nominativo"], ["cliente"], ["nome"]],
  departureDate: [["data", "partenza"], ["data", "viaggio"], ["data"]],
  hotel: [["hotel"], ["albergo"], ["struttura"]],
  passengers: [["pax"], ["passeggeri"], ["persone"]],
  pickupTime: [["ora", "prelevamento"], ["prelevamento"], ["ora", "pickup"], ["pickup"]],
  vesselTime: [
    ["ora", "nave"],
    ["ora", "aliscafo"],
    ["orario", "nave"],
    ["orario", "aliscafo"],
    ["partenza", "nave"],
    ["partenza", "aliscafo"],
    ["nave"],
    ["aliscafo"],
  ],
};

// All 7 data fields are required (inviare defaults to true when absent from
// the header, but every other field must be mapped to a distinct column).
export const SNAV_REQUIRED_FIELDS: SnavParsedField[] = [
  "phoneRaw", "customerName", "departureDate", "hotel", "passengers", "pickupTime", "vesselTime",
];

export const SNAV_FIELD_LABELS: Record<SnavParsedField, string> = {
  inviare: "Inviare",
  phoneRaw: "numero cliente",
  customerName: "nome cliente",
  departureDate: "data partenza",
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

export type SnavColumnMap = Partial<Record<SnavParsedField, number>>;

export type HeaderDetectionResult =
  | { ok: true; headerRowIndex: number; header: string[]; colMap: SnavColumnMap }
  | { ok: false; reason: string };

// Scans the first `maxScanRows` rows for a header that contains all required
// fields mapped to *distinct* columns, tolerating leading title/blank rows.
// A header where "ora prelevamento" and "ora nave" (or any other two
// required fields) resolve to the same column index is rejected rather than
// silently mis-mapped.
export function detectSnavHeader(raw: unknown[][], maxScanRows = 10): HeaderDetectionResult {
  for (let r = 0; r < Math.min(raw.length, maxScanRows); r++) {
    const candidate = (raw[r] as unknown[]).map((c) => String(c ?? "").trim());
    if (candidate.filter((c) => c.length > 0).length < 3) continue;

    const candidateMap: SnavColumnMap = {};
    for (const field of Object.keys(SNAV_COLUMN_KEYWORDS) as SnavParsedField[]) {
      const idx = findColumnIndex(candidate, SNAV_COLUMN_KEYWORDS[field]);
      if (idx >= 0) candidateMap[field] = idx;
    }

    const requiredIndices = SNAV_REQUIRED_FIELDS.map((f) => candidateMap[f]).filter((i): i is number => i != null);
    const hasAllRequired = requiredIndices.length === SNAV_REQUIRED_FIELDS.length;
    const allDistinct = new Set(requiredIndices).size === requiredIndices.length;

    if (hasAllRequired && allDistinct) {
      return { ok: true, headerRowIndex: r, header: candidate, colMap: candidateMap };
    }
  }

  const firstRow = ((raw[0] as unknown[]) ?? []).map((c) => String(c ?? "").trim()).filter((h) => h.length > 0).join(", ");
  return { ok: false, reason: `Intestazioni colonne non trovate nelle prime ${maxScanRows} righe del file.${firstRow ? `\n\nPrima riga: ${firstRow}` : ""}` };
}

export function missingRequiredFields(colMap: SnavColumnMap): SnavParsedField[] {
  return SNAV_REQUIRED_FIELDS.filter((f) => colMap[f] == null);
}

// departureDate/pickupTime/vesselTime keep the raw Excel cell value (Date
// object, numeric serial, or string) — formatting into display strings is
// deferred to lib/snav-convocation-format.ts so Date objects are never
// stringified into "Mon Sep 07 2026 GMT+0200..." garbage before they reach
// a proper formatter.
export type SnavParsedRow = {
  rowIndex: number;
  inviare: boolean;
  phoneRaw: string;
  customerName: string;
  departureDateRaw: unknown;
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

export function parseSnavRows(raw: unknown[][], headerRowIndex: number, colMap: SnavColumnMap): SnavParsedRow[] {
  const rows: SnavParsedRow[] = [];
  for (let i = headerRowIndex + 1; i < raw.length; i++) {
    const r = raw[i] as unknown[];
    if (!r || r.every((c) => c == null || String(c).trim() === "")) continue;

    const inviare = colMap.inviare != null ? parseInviare(r[colMap.inviare]) : true;

    rows.push({
      rowIndex: i + 1,
      inviare,
      phoneRaw: textCell(r, colMap.phoneRaw),
      customerName: textCell(r, colMap.customerName),
      departureDateRaw: rawCell(r, colMap.departureDate),
      hotel: textCell(r, colMap.hotel),
      passengers: textCell(r, colMap.passengers),
      pickupTimeRaw: rawCell(r, colMap.pickupTime),
      vesselTimeRaw: rawCell(r, colMap.vesselTime),
    });
  }
  return rows;
}
