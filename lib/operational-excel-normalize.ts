export const OPERATIONAL_V2_TEMPLATE_KIND = "operational_v2" as const;

export type RawOperationalExcelRow = Record<string, unknown>;

export type OperationalV2Category = "TRANSFER" | "FORMULA_NAVE" | "ESCURSIONE" | "UNKNOWN";
export type OperationalV2Direction = "arrival" | "departure" | "excursion_outbound" | "excursion_return" | "unknown";
export type OperationalV2Target = "bruno" | "continent_dispatch" | "island_only" | "excursion" | "needs_review";
export type OperationalV2Status = "ready" | "warning" | "needs_review" | "blocking_error";

export type OperationalV2NormalizedRow = {
  date: string | null;
  arrival_time: string | null;
  departure_time: string | null;
  ferry_company: string | null;
  ferry_time: string | null;
  pax: number | null;
  agency: string | null;
  flight_or_train_number: string | null;
  from: string | null;
  to: string | null;
  customer_name: string | null;
  phone: string;
  notes: string | null;
  service: string | null;
  category: string | null;
  trip_type: string | null;
};

export type OperationalV2Classification = {
  category: OperationalV2Category;
  direction: OperationalV2Direction;
  booking_service_kind: string | null;
  operational_target: OperationalV2Target;
  is_room_reference_name: boolean;
  requires_db_rules: boolean;
  requires_alias_resolution: boolean;
};

export type OperationalV2PreviewRow = {
  row_number: number;
  status: OperationalV2Status;
  raw: RawOperationalExcelRow;
  normalized: OperationalV2NormalizedRow;
  classification: OperationalV2Classification;
  warnings: string[];
  errors: string[];
};

export type OperationalV2Preview = {
  template_kind: typeof OPERATIONAL_V2_TEMPLATE_KIND;
  summary: {
    total_rows: number;
    service_rows: number;
    transfer_count: number;
    ferry_formula_count: number;
    excursion_count: number;
    ready_count: number;
    warning_count: number;
    needs_review_count: number;
    blocking_error_count: number;
  };
  rows: OperationalV2PreviewRow[];
};

const REQUIRED_HEADERS = [
  "DATA",
  "ORARIO DI ARRIVO",
  "ORARIO DI PARTENZA",
  "COMPAGNIA NAVE",
  "ORARIO NAVE",
  "NUMERO PAX",
  "AGENZIA",
  "VOLO NUMERO",
  "DA",
  "A",
  "NOME",
  "CELLULARE",
  "NOTE",
  "SERVIZIO",
  "CATEGORIA",
  "TIPO",
] as const;

const STATIC_PLACE_ALIASES = new Set(["AEROPORTO", "STAZIONE", "ISCHIA PORTO", "CASAMICCIOLA"]);

function cleanText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/\s+/g, " ").trim();
  return cleaned ? cleaned : null;
}

function compareText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function normalizeHeader(value: unknown): string {
  return compareText(value).replace(/[^A-Z0-9]+/g, " ").trim();
}

function getCell(row: RawOperationalExcelRow, header: (typeof REQUIRED_HEADERS)[number]): unknown {
  const wanted = normalizeHeader(header);
  for (const [key, value] of Object.entries(row)) {
    if (normalizeHeader(key) === wanted) return value;
  }
  return undefined;
}

function parseExcelSerialDate(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const epoch = Date.UTC(1899, 11, 30);
  const millis = epoch + Math.floor(value) * 24 * 60 * 60 * 1000;
  return new Date(millis).toISOString().slice(0, 10);
}

export function parseOperationalV2Date(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "number") return parseExcelSerialDate(value);

  const raw = cleanText(value);
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const slash = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (slash) {
    const day = slash[1].padStart(2, "0");
    const month = slash[2].padStart(2, "0");
    const year = slash[3].length === 2 ? `20${slash[3]}` : slash[3];
    return `${year}-${month}-${day}`;
  }

  return null;
}

export function parseOperationalV2Time(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const fraction = value >= 1 ? value % 1 : value;
    if (fraction > 0) {
      const totalMinutes = Math.round(fraction * 24 * 60);
      return `${String(Math.floor(totalMinutes / 60) % 24).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}`;
    }
  }

  const raw = cleanText(value);
  if (!raw) return null;
  const compact = raw.replace(".", ":");
  const hhmm = compact.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (hhmm) return `${hhmm[1].padStart(2, "0")}:${hhmm[2]}`;

  const digits = raw.replace(/\D/g, "");
  if (digits.length === 4) return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
  if (digits.length === 3) return `0${digits[0]}:${digits.slice(1, 3)}`;
  return null;
}

function parsePax(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  const raw = cleanText(value);
  if (!raw) return null;
  const numberValue = Number(raw.replace(",", "."));
  if (Number.isFinite(numberValue) && numberValue > 0) return Math.floor(numberValue);
  const digits = raw.replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

function normalizeCategory(value: string | null): OperationalV2Category {
  const normalized = compareText(value);
  if (normalized === "TRANSFER") return "TRANSFER";
  if (normalized === "FORMULA NAVE") return "FORMULA_NAVE";
  if (normalized === "ESCURSIONE") return "ESCURSIONE";
  return "UNKNOWN";
}

function normalizeTripType(value: string | null): "ANDATA" | "RITORNO" | "UNKNOWN" {
  const normalized = compareText(value);
  if (normalized === "ANDATA") return "ANDATA";
  if (normalized === "RITORNO") return "RITORNO";
  return "UNKNOWN";
}

function isRoomReferenceName(value: string | null): boolean {
  const normalized = compareText(value);
  return /^CAM(?:ERA)?\s+\d+[A-Z]?(?:\s*[-/]\s*\d+[A-Z]?\s*X?\s*\d*)*$/i.test(normalized)
    || /^CAM\s+\d+[A-Z]?\s*X\d+(?:\s*-\s*\d+[A-Z]?\s*X\d+)*$/i.test(normalized);
}

function serviceKindForTransfer(service: string | null, tripType: "ANDATA" | "RITORNO" | "UNKNOWN"): string | null {
  const normalized = compareText(service);
  if (normalized === "AEROPORTO HOTEL") {
    return tripType === "RITORNO" ? "transfer_hotel_airport" : "transfer_airport_hotel";
  }
  if (normalized === "STAZIONE HOTEL") {
    return tripType === "RITORNO" ? "transfer_hotel_train" : "transfer_train_hotel";
  }
  return null;
}

function serviceKindForFerry(service: string | null, ferryCompany: string | null, from: string | null, to: string | null): string | null {
  const normalized = compareText([service, ferryCompany].filter(Boolean).join(" "));
  if (normalized.includes("SNAV")) return "formula_snav";
  if (normalized.includes("ALILAURO")) return "formula_alilauro";
  if (normalized.includes("MEDMAR")) {
    const routeText = compareText([from, to].filter(Boolean).join(" "));
    if (routeText.includes("POZZUOLI")) return "formula_medmar_pozzuoli";
    if (routeText.includes("NAPOLI")) return "formula_medmar_napoli";
    return "formula_medmar_unknown";
  }
  return null;
}

function requiresAliasResolution(from: string | null, to: string | null): boolean {
  const values = [from, to].filter((value): value is string => Boolean(value));
  return values.some((value) => !STATIC_PLACE_ALIASES.has(compareText(value)));
}

function buildClassification(normalized: OperationalV2NormalizedRow): OperationalV2Classification {
  const category = normalizeCategory(normalized.category);
  const tripType = normalizeTripType(normalized.trip_type);
  const roomReference = isRoomReferenceName(normalized.customer_name);
  const aliasResolution = requiresAliasResolution(normalized.from, normalized.to);

  if (category === "TRANSFER") {
    const bookingKind = serviceKindForTransfer(normalized.service, tripType);
    const isAirport = compareText(normalized.service) === "AEROPORTO HOTEL";
    const direction = tripType === "RITORNO" ? "departure" : tripType === "ANDATA" ? "arrival" : "unknown";
    return {
      category,
      direction,
      booking_service_kind: bookingKind,
      operational_target: direction === "arrival" && isAirport ? "bruno" : "continent_dispatch",
      is_room_reference_name: roomReference,
      requires_db_rules: true,
      requires_alias_resolution: aliasResolution,
    };
  }

  if (category === "FORMULA_NAVE") {
    return {
      category,
      direction: tripType === "RITORNO" ? "departure" : tripType === "ANDATA" ? "arrival" : "unknown",
      booking_service_kind: serviceKindForFerry(normalized.service, normalized.ferry_company, normalized.from, normalized.to),
      operational_target: "island_only",
      is_room_reference_name: roomReference,
      requires_db_rules: tripType === "RITORNO",
      requires_alias_resolution: aliasResolution,
    };
  }

  if (category === "ESCURSIONE") {
    return {
      category,
      direction: tripType === "RITORNO" ? "excursion_return" : tripType === "ANDATA" ? "excursion_outbound" : "unknown",
      booking_service_kind: "excursion",
      operational_target: "excursion",
      is_room_reference_name: roomReference,
      requires_db_rules: false,
      requires_alias_resolution: aliasResolution,
    };
  }

  return {
    category: "UNKNOWN",
    direction: "unknown",
    booking_service_kind: null,
    operational_target: "needs_review",
    is_room_reference_name: roomReference,
    requires_db_rules: false,
    requires_alias_resolution: aliasResolution,
  };
}

function requiredValueErrors(normalized: OperationalV2NormalizedRow): string[] {
  const errors: string[] = [];
  if (!normalized.date) errors.push("DATA mancante o non valida");
  if (!normalized.category) errors.push("CATEGORIA mancante");
  if (!normalized.service) errors.push("SERVIZIO mancante");
  if (!normalized.trip_type) errors.push("TIPO mancante");
  if (!normalized.pax || normalized.pax < 1) errors.push("NUMERO PAX mancante o non valido");
  if (!normalized.agency) errors.push("AGENZIA mancante");
  if (!normalized.from) errors.push("DA mancante");
  if (!normalized.to) errors.push("A mancante");
  if (!normalized.customer_name) errors.push("NOME mancante");
  return errors;
}

function timeWarnings(normalized: OperationalV2NormalizedRow, classification: OperationalV2Classification): string[] {
  if (classification.category === "TRANSFER" && classification.direction === "arrival" && !normalized.arrival_time) {
    return ["Orario di arrivo mancante: richiede verifica"];
  }
  if (classification.category === "TRANSFER" && classification.direction === "departure" && !normalized.departure_time) {
    return ["Orario di partenza mancante: richiede verifica"];
  }
  if (classification.category === "FORMULA_NAVE" && !normalized.ferry_time) {
    return ["Orario nave mancante: richiede verifica"];
  }
  if (classification.category === "ESCURSIONE" && !normalized.departure_time) {
    return ["Orario escursione mancante: richiede verifica"];
  }
  return [];
}

function rowStatus(errors: string[], warnings: string[]): OperationalV2Status {
  if (errors.length > 0) return "blocking_error";
  if (warnings.some((warning) => warning.includes("richiede verifica")) || warnings.some((warning) => warning.includes("non riconosciut"))) {
    return "needs_review";
  }
  if (warnings.length > 0) return "warning";
  return "ready";
}

function duplicateKey(row: OperationalV2PreviewRow): string {
  const n = row.normalized;
  const operativeTime = n.ferry_time ?? n.departure_time ?? n.arrival_time ?? "";
  return [
    n.date,
    n.customer_name,
    row.classification.category,
    n.service,
    n.trip_type,
    n.from,
    n.to,
    operativeTime,
    n.agency,
    n.pax,
  ].map((value) => compareText(value)).join("|");
}

function isEmptyOperationalV2Row(raw: RawOperationalExcelRow): boolean {
  return REQUIRED_HEADERS.every((header) => !cleanText(getCell(raw, header)));
}

function buildRow(raw: RawOperationalExcelRow, index: number): OperationalV2PreviewRow {
  const phone = cleanText(getCell(raw, "CELLULARE")) ?? "0000";
  const normalized: OperationalV2NormalizedRow = {
    date: parseOperationalV2Date(getCell(raw, "DATA")),
    arrival_time: parseOperationalV2Time(getCell(raw, "ORARIO DI ARRIVO")),
    departure_time: parseOperationalV2Time(getCell(raw, "ORARIO DI PARTENZA")),
    ferry_company: cleanText(getCell(raw, "COMPAGNIA NAVE")),
    ferry_time: parseOperationalV2Time(getCell(raw, "ORARIO NAVE")),
    pax: parsePax(getCell(raw, "NUMERO PAX")),
    agency: cleanText(getCell(raw, "AGENZIA")),
    flight_or_train_number: cleanText(getCell(raw, "VOLO NUMERO")),
    from: cleanText(getCell(raw, "DA")),
    to: cleanText(getCell(raw, "A")),
    customer_name: cleanText(getCell(raw, "NOME")),
    phone,
    notes: cleanText(getCell(raw, "NOTE")),
    service: cleanText(getCell(raw, "SERVIZIO")),
    category: cleanText(getCell(raw, "CATEGORIA")),
    trip_type: cleanText(getCell(raw, "TIPO")),
  };
  const classification = buildClassification(normalized);
  const warnings: string[] = [];
  const errors = requiredValueErrors(normalized);

  if (!cleanText(getCell(raw, "CELLULARE"))) warnings.push("Telefono mancante: impostato 0000");
  if (classification.is_room_reference_name) warnings.push("Nome cliente non disponibile: usato riferimento camera");
  if (classification.category === "UNKNOWN" && normalized.category) warnings.push("Categoria non riconosciuta: richiede verifica");
  if (!classification.booking_service_kind && classification.category !== "UNKNOWN") warnings.push("Servizio non riconosciuto: richiede verifica");
  warnings.push(...timeWarnings(normalized, classification));

  return {
    row_number: typeof raw.row_number === "number" ? raw.row_number : typeof raw.__row_number === "number" ? raw.__row_number : index + 2,
    status: rowStatus(errors, warnings),
    raw,
    normalized,
    classification,
    warnings,
    errors,
  };
}

export function isOperationalV2Header(headers: unknown[]): boolean {
  const normalizedHeaders = new Set(headers.map(normalizeHeader).filter(Boolean));
  return REQUIRED_HEADERS.every((header) => normalizedHeaders.has(normalizeHeader(header)));
}

export function parseOperationalV2Rows(rows: RawOperationalExcelRow[]): OperationalV2Preview {
  const previewRows = rows
    .filter((row) => !isEmptyOperationalV2Row(row))
    .map(buildRow)
    .filter((row) => Object.values(row.normalized).some((value) => value !== null && value !== ""));

  const duplicateCounts = new Map<string, number>();
  for (const row of previewRows) {
    const key = duplicateKey(row);
    duplicateCounts.set(key, (duplicateCounts.get(key) ?? 0) + 1);
  }
  for (const row of previewRows) {
    if ((duplicateCounts.get(duplicateKey(row)) ?? 0) > 1) {
      row.warnings.push("Possibile duplicato nel file");
      row.status = rowStatus(row.errors, row.warnings);
    }
  }

  const summary = {
    total_rows: rows.length,
    service_rows: previewRows.length,
    transfer_count: previewRows.filter((row) => row.classification.category === "TRANSFER").length,
    ferry_formula_count: previewRows.filter((row) => row.classification.category === "FORMULA_NAVE").length,
    excursion_count: previewRows.filter((row) => row.classification.category === "ESCURSIONE").length,
    ready_count: previewRows.filter((row) => row.status === "ready").length,
    warning_count: previewRows.filter((row) => row.status === "warning").length,
    needs_review_count: previewRows.filter((row) => row.status === "needs_review").length,
    blocking_error_count: previewRows.filter((row) => row.status === "blocking_error").length,
  };

  return {
    template_kind: OPERATIONAL_V2_TEMPLATE_KIND,
    summary,
    rows: previewRows,
  };
}
