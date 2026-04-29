export type MedmarTicketRouteCode =
  | "pozzuoli_ischia"
  | "pozzuoli_casamicciola"
  | "napoli_ischia"
  | "napoli_casamicciola"
  | "ischia_pozzuoli"
  | "casamicciola_pozzuoli"
  | "ischia_napoli"
  | "casamicciola_napoli";

export const MEDMAR_TICKET_ROUTE_LABELS: Record<MedmarTicketRouteCode, string> = {
  pozzuoli_ischia: "Pozzuoli -> Ischia",
  pozzuoli_casamicciola: "Pozzuoli -> Casamicciola",
  napoli_ischia: "Napoli -> Ischia",
  napoli_casamicciola: "Napoli -> Casamicciola",
  ischia_pozzuoli: "Ischia -> Pozzuoli",
  casamicciola_pozzuoli: "Casamicciola -> Pozzuoli",
  ischia_napoli: "Ischia -> Napoli",
  casamicciola_napoli: "Casamicciola -> Napoli",
};

export const MEDMAR_TICKET_ROUTE_OPTIONS: Array<{ value: MedmarTicketRouteCode; label: string }> = (
  Object.entries(MEDMAR_TICKET_ROUTE_LABELS) as Array<[MedmarTicketRouteCode, string]>
).map(([value, label]) => ({ value, label }));

type RouteDefinition = {
  serviceDirection: "arrival" | "departure";
  departurePortKeywords: string[];
  arrivalPortKeywords: string[];
  bookingKinds: string[];
};

const ROUTE_DEFINITIONS: Record<MedmarTicketRouteCode, RouteDefinition> = {
  pozzuoli_ischia: {
    serviceDirection: "arrival",
    departurePortKeywords: ["pozzuoli"],
    arrivalPortKeywords: ["ischia"],
    bookingKinds: ["formula_medmar_pozzuoli", "transfer_port_hotel"],
  },
  pozzuoli_casamicciola: {
    serviceDirection: "arrival",
    departurePortKeywords: ["pozzuoli"],
    arrivalPortKeywords: ["casamicciola"],
    bookingKinds: ["formula_medmar_pozzuoli", "transfer_port_hotel"],
  },
  napoli_ischia: {
    serviceDirection: "arrival",
    departurePortKeywords: ["napoli", "beverello"],
    arrivalPortKeywords: ["ischia"],
    bookingKinds: ["formula_medmar_napoli", "transfer_port_hotel"],
  },
  napoli_casamicciola: {
    serviceDirection: "arrival",
    departurePortKeywords: ["napoli", "beverello"],
    arrivalPortKeywords: ["casamicciola"],
    bookingKinds: ["formula_medmar_napoli", "transfer_port_hotel"],
  },
  ischia_pozzuoli: {
    serviceDirection: "departure",
    departurePortKeywords: ["ischia"],
    arrivalPortKeywords: ["pozzuoli"],
    bookingKinds: ["formula_medmar_pozzuoli", "transfer_hotel_port"],
  },
  casamicciola_pozzuoli: {
    serviceDirection: "departure",
    departurePortKeywords: ["casamicciola"],
    arrivalPortKeywords: ["pozzuoli"],
    bookingKinds: ["formula_medmar_pozzuoli", "transfer_hotel_port"],
  },
  ischia_napoli: {
    serviceDirection: "departure",
    departurePortKeywords: ["ischia"],
    arrivalPortKeywords: ["napoli", "beverello"],
    bookingKinds: ["formula_medmar_napoli", "transfer_hotel_port"],
  },
  casamicciola_napoli: {
    serviceDirection: "departure",
    departurePortKeywords: ["casamicciola"],
    arrivalPortKeywords: ["napoli", "beverello"],
    bookingKinds: ["formula_medmar_napoli", "transfer_hotel_port"],
  },
};

export function getRouteDefinition(routeCode: MedmarTicketRouteCode): RouteDefinition {
  return ROUTE_DEFINITIONS[routeCode];
}

export function normalizeTime(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(0, 5);
}

export function formatSlotLabel(input: { routeCode: MedmarTicketRouteCode; travelDate: string; departureTime: string | null }) {
  return `${MEDMAR_TICKET_ROUTE_LABELS[input.routeCode]} · ${input.travelDate}${input.departureTime ? ` · ${input.departureTime}` : ""}`;
}

export function buildMemorySlotKey(routeCode: MedmarTicketRouteCode, travelDate: string, departureTime: string | null) {
  return `${travelDate}|${routeCode}|${normalizeTime(departureTime) ?? ""}`;
}

export type MedmarTicketExtraction = {
  route_code: MedmarTicketRouteCode | null;
  travel_date: string | null;
  departure_time: string | null;
  issue_date: string | null;
  ticket_number: string | null;
  booking_code: string | null;
  voucher_label: string | null;
  tariff_label: string | null;
  price_cents: number | null;
  quantity: number | null;
  raw_text: string;
};

function compactWhitespace(value: string) {
  return value.replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
}

function normalizeOcrText(value: string) {
  return compactWhitespace(
    value
      .replace(/[|]/g, "I")
      .replace(/€/g, "EUR")
      .replace(/([A-Za-z])\s+([0-9])/g, "$1 $2")
  );
}

function parseItalianDate(value: string | null | undefined) {
  if (!value) return null;
  const match = value.match(/(\d{2})[\/.-](\d{2})[\/.-](\d{2,4})/);
  if (!match) return null;
  const day = match[1];
  const month = match[2];
  const year = match[3]?.length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${month}-${day}`;
}

function parsePriceToCents(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.replace(",", ".").trim();
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}

function extractDateFromLine(line: string | null | undefined) {
  if (!line) return null;
  return parseItalianDate(line.match(/(\d{2}[\/.-]\d{2}[\/.-]\d{2,4})/)?.[1] ?? null);
}

function detectRouteCode(text: string): MedmarTicketRouteCode | null {
  const normalized = text.toLowerCase();
  if (normalized.includes("pozzuoli") && normalized.includes("casamicciola")) {
    return normalized.indexOf("pozzuoli") < normalized.indexOf("casamicciola")
      ? "pozzuoli_casamicciola"
      : "casamicciola_pozzuoli";
  }
  if (normalized.includes("pozzuoli") && normalized.includes("ischia")) {
    return normalized.indexOf("pozzuoli") < normalized.indexOf("ischia")
      ? "pozzuoli_ischia"
      : "ischia_pozzuoli";
  }
  if ((normalized.includes("napoli") || normalized.includes("beverello")) && normalized.includes("casamicciola")) {
    return normalized.indexOf("casamicciola") < Math.max(normalized.indexOf("napoli"), normalized.indexOf("beverello"))
      ? "casamicciola_napoli"
      : "napoli_casamicciola";
  }
  if ((normalized.includes("napoli") || normalized.includes("beverello")) && normalized.includes("ischia")) {
    return normalized.indexOf("ischia") < Math.max(normalized.indexOf("napoli"), normalized.indexOf("beverello"))
      ? "ischia_napoli"
      : "napoli_ischia";
  }
  return null;
}

function extractTravelDate(lines: string[], rawText: string, issueDate: string | null, routeLineIndex: number) {
  const candidates = [
    extractDateFromLine(routeLineIndex >= 0 ? lines[routeLineIndex + 1] : null),
    extractDateFromLine(routeLineIndex >= 0 ? lines[routeLineIndex + 2] : null),
    ...lines
      .filter((line) => !/EMISSIONE/i.test(line))
      .map((line) => extractDateFromLine(line)),
    parseItalianDate(rawText.match(/\b(\d{2}[\/.-]\d{2}[\/.-]\d{2,4})\b/)?.[1] ?? null),
  ].filter((value): value is string => Boolean(value));

  return candidates.find((value) => value !== issueDate) ?? candidates[0] ?? null;
}

function extractDepartureTime(lines: string[], rawText: string, routeLineIndex: number) {
  const chunks = [
    ...(routeLineIndex >= 0 ? [lines[routeLineIndex + 2] ?? "", lines[routeLineIndex + 3] ?? ""] : []),
    rawText,
  ];

  const times = chunks.flatMap((chunk) =>
    [...chunk.matchAll(/\b([0-2]\d[:.][0-5]\d)\b/g)].map((match) => match[1]!.replace(".", ":"))
  );

  return normalizeTime(times[0] ?? null);
}

export function parseMedmarTicketText(input: string): MedmarTicketExtraction {
  const rawText = normalizeOcrText(input);
  const upper = rawText.toUpperCase();
  const lines = rawText.split("\n").map((line) => line.trim()).filter(Boolean);

  const routeLineIndex = lines.findIndex((line) =>
    /(POZZUOLI|NAPOLI|BEVERELLO|ISCHIA|CASAMICCIOLA)\s*[-–]\s*(POZZUOLI|NAPOLI|BEVERELLO|ISCHIA|CASAMICCIOLA)/i.test(line)
  );
  const routeLine = routeLineIndex >= 0 ? lines[routeLineIndex] ?? null : null;
  const routeCode = detectRouteCode(routeLine ?? rawText);

  const issueDate =
    parseItalianDate(rawText.match(/DATA\s+EMISSIONE\s+(\d{2}[\/.-]\d{2}[\/.-]\d{2,4})/i)?.[1] ?? null) ??
    parseItalianDate(rawText.match(/EMISSIONE\s+(\d{2}[\/.-]\d{2}[\/.-]\d{2,4})/i)?.[1] ?? null);

  const travelDate = extractTravelDate(lines, rawText, issueDate, routeLineIndex);
  const departureTime = extractDepartureTime(lines, rawText, routeLineIndex);

  const ticketNumber =
    rawText.match(/BIGLIETTO\s+([A-Z0-9]{8,})/i)?.[1] ??
    rawText.match(/\b(ME[0-9A-Z]{8,})\b/i)?.[1] ??
    null;

  const bookingCode =
    rawText.match(/BOOKING\s+([A-Z0-9]{8,})/i)?.[1] ??
    rawText.match(/\b(IS[0-9A-Z]{10,})\b/i)?.[1] ??
    null;

  const voucherValue =
    rawText.match(/VOUCHER\s*[:|]?\s*0*([0-9]{3,})/i)?.[1] ??
    rawText.match(/VOUCHERI\s*0*([0-9]{3,})/i)?.[1] ??
    rawText.match(/VOUCHER[| ]0*([0-9]{3,})/i)?.[1] ??
    null;

  const tariffLabel =
    lines.find((line) => /TARIFFA/i.test(line) && /ADULTO|BAMBINO|SPECIAL|AR/i.test(line)) ??
    lines.find((line) => /TARIFFA/i.test(line)) ??
    null;

  const quantityRaw =
    rawText.match(/\bQNT\b\s*(\d{1,2})/i)?.[1] ??
    rawText.match(/TARIFFA\s+QNT\s+BIGLIETTO[\s\S]*?\b(\d{1,2})\b/i)?.[1] ??
    "1";
  const quantity = Number(quantityRaw);

  const priceCents =
    parsePriceToCents(rawText.match(/TOTALE\s+BIGLIETTO\s*(?:EUR)?\s*([0-9]+[.,][0-9]{2})/i)?.[1] ?? null) ??
    parsePriceToCents(rawText.match(/\bPREZZO\b\s*([0-9]+[.,][0-9]{2})/i)?.[1] ?? null);

  const normalizedVoucher = voucherValue ? voucherValue.replace(/^0+/, "") || "0" : null;

  return {
    route_code: routeCode,
    travel_date: travelDate,
    departure_time: departureTime,
    issue_date: issueDate,
    ticket_number: ticketNumber ? ticketNumber.trim() : null,
    booking_code: bookingCode ? bookingCode.trim() : null,
    voucher_label: normalizedVoucher,
    tariff_label: tariffLabel ? compactWhitespace(tariffLabel) : null,
    price_cents: priceCents,
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
    raw_text: upper,
  };
}
