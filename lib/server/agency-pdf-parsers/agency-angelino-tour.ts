import type { ParsedTransferPdfPayload, ParsedTransferService } from "@/lib/server/transfer-pdf-parser";
import type { AgencyPdfParserImplementation } from "@/lib/server/agency-pdf-parsers/types";
import { buildParserMatch } from "@/lib/server/agency-pdf-parsers/utils";

const IT_MONTHS: Record<string, string> = {
  gen: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  mag: "05",
  giu: "06",
  lug: "07",
  ago: "08",
  set: "09",
  ott: "10",
  nov: "11",
  dic: "12"
};

function clean(value?: string | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeHotelName(value?: string | null) {
  const normalized = clean(value);
  if (!normalized) return null;
  return clean(normalized.replace(/\s+\d\*?$/i, ""));
}

function cleanOcrField(value?: string | null) {
  const normalized = clean(value);
  if (!normalized) return null;
  const stopAt = normalized.search(/\b(ns riferimento|ns referente|importo|tasse|data|dal|al|programma|descrizione|pax|num|pagina|hotel)\b/i);
  return clean(stopAt > 0 ? normalized.slice(0, stopAt) : normalized);
}

function extractBeneficiary(compact: string) {
  const candidates = [
    compact.match(/beneficiario\s*([A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ' ]+)/i)?.[1],
    compact.match(/beneficiario.*?\b([A-ZÀ-ÖØ-Ý][A-ZÀ-ÖØ-Ý' ]{5,})(?=\s+descrizione|\s+HOTEL|\s+nominativo|\s+tasse|\s+Totale|\s+num\b|$)/i)?.[1],
    compact.match(/nominativo\s*(?:\([^)]+\)\s*)?(?:\d+\s+)?([A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ' ]+)/i)?.[1],
    compact.match(/\)\s*\d+\s+([A-ZÀ-ÖØ-Ý][A-ZÀ-ÖØ-Ý' ]{5,})(?=\s+tasse|\s+Totale|\s+num\b|$)/i)?.[1],
    compact.match(/\b([A-ZÀ-ÖØ-Ý][A-ZÀ-ÖØ-Ý' ]{5,})\s+descrizione\s+HOTEL\b/i)?.[1]
  ];

  for (const candidate of candidates) {
    const cleaned = cleanOcrField(candidate);
    if (cleaned) return cleaned;
  }

  return null;
}

function parseItalianDate(raw?: string | null, fallbackYear?: string | null) {
  const match = String(raw ?? "").match(/([0-3]?\d)\s*-\s*(gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:[.-]?\s*(\d{2,4}))?/i);
  if (!match) return null;
  const month = IT_MONTHS[match[2].toLowerCase()];
  if (!month) return null;
  const rawYear = match[3] ?? fallbackYear ?? null;
  if (!rawYear) return null;
  const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
  const numericYear = Number(year);
  const currentYear = new Date().getFullYear();
  if (!Number.isFinite(numericYear)) return fallbackYear ? `${fallbackYear}-${month}-${match[1].padStart(2, "0")}` : null;
  if (numericYear < currentYear - 1 || numericYear > currentYear + 2) {
    return fallbackYear ? `${fallbackYear}-${month}-${match[1].padStart(2, "0")}` : null;
  }
  return `${String(numericYear)}-${month}-${match[1].padStart(2, "0")}`;
}

function parseItalianDateLoose(raw?: string | null, fallbackYear?: string | null) {
  return parseItalianDate(raw, fallbackYear);
}

function parseShortItalianDate(raw?: string | null, fallbackYear?: string | null) {
  const match = String(raw ?? "").match(/([0-3]?\d)\s*-\s*(gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)\b/i);
  if (!match || !fallbackYear) return null;
  const month = IT_MONTHS[match[2].toLowerCase()];
  if (!month) return null;
  return `${fallbackYear}-${month}-${match[1].padStart(2, "0")}`;
}

function parseShortItalianDateRelative(raw?: string | null, anchorDate?: string | null) {
  const anchor = clean(anchorDate);
  if (!anchor) return null;
  const base = parseShortItalianDate(raw, anchor.slice(0, 4));
  if (!base) return null;
  if (base >= anchor) return base;
  const match = base.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return base;
  const nextYear = String(Number(match[1]) + 1).padStart(4, "0");
  return `${nextYear}-${match[2]}-${match[3]}`;
}

function parseEuroAmount(raw?: string | null) {
  const match = String(raw ?? "").match(/(\d+(?:[.,]\d{2}))/);
  if (!match) return null;
  const value = Number(match[1].replace(/\./g, "").replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

function parseAllEuroAmounts(raw?: string | null) {
  return Array.from(String(raw ?? "").matchAll(/(\d+(?:[.,]\d{2}))/g))
    .map((match) => Number(match[1].replace(/\./g, "").replace(",", ".")))
    .filter((value) => Number.isFinite(value));
}

function normalizeAngelinoOcrText(sourceText: string) {
  return sourceText
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .replace(/ri feri mento/gi, "riferimento")
    .replace(/descri zi one/gi, "descrizione")
    .replace(/i mporto/gi, "importo")
    .replace(/prati ca/gi, "pratica")
    .replace(/ns ri feri mento/gi, "ns riferimento")
    .replace(/angelino TOUR OPERATOR/gi, "Angelino Tour Operator")
    .replace(/totale pratica/gi, "Totale pratica")
    .replace(/nominativo/gi, "nominativo")
    .replace(/(\d)\s*,\s*o{2}\b/gi, "$1,00")
    .replace(/(\d)\s*,\s*oo\b/gi, "$1,00")
    .trim();
}

function parseAngelinoTourPdfText(sourceText: string): ParsedTransferPdfPayload {
  const compact = normalizeAngelinoOcrText(sourceText);
  const practiceNumber = clean(compact.match(/pratica\s*(\d{2}\/\d{6})/i)?.[1]);
  const orderNumber = clean(compact.match(/CONFERMA D[' ]ORDINE\s*n\.\s*(\d{3,})/i)?.[1]);
  const practiceDate = parseItalianDate(compact.match(/data\s*([0-3]?\d\s*-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)[.-]?\s*\d{2,4})/i)?.[1]);
  const fallbackYear = practiceDate?.slice(0, 4) ?? null;
  const beneficiary = extractBeneficiary(compact);
  const secondPassenger = clean(compact.match(/nominativo\s*([A-Z][A-Za-z' ]+)\s*EUR/i)?.[1]);
  const pax = Number(compact.match(/\bpax\s*(\d{1,2})/i)?.[1] ?? 0) || null;
  const reference = cleanOcrField(compact.match(/ns referente\s*([A-Z][A-Za-z' ]+)/i)?.[1]) ?? orderNumber;
  const hotel =
    normalizeHotelName(compact.match(/beneficiario\s+[A-Z' ]+\s+HOTEL\s+([A-Z0-9][A-Za-z0-9' ]+?)(?=\s+descrizione|\s+ri\s*feri\s*mento|\s+tasse|\s+Totale|\s+num\b|$)/i)?.[1]) ??
    normalizeHotelName(compact.match(/HOTEL\s+([A-Z0-9][A-Za-z0-9' ]+?)(?=\s+descrizione|\s+ri\s*feri\s*mento|\s+tasse|\s+Totale|\s+num\b|$)/i)?.[1]);
  const dateMatches = Array.from(compact.matchAll(/([0-3]?\d\s*-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)[.-]?\s*\d{2,4})/gi))
    .map((match) => parseItalianDate(match[1], fallbackYear))
    .filter((value): value is string => Boolean(value));
  const fromDate = parseItalianDate(compact.match(/\bdal\s*([0-3]?\d\s*-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:[.-]?\s*\d{2,4})?)/i)?.[1], fallbackYear);
  const toDate = parseItalianDate(compact.match(/\bal\s*([0-3]?\d\s*-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:[.-]?\s*\d{2,4})?)/i)?.[1], fallbackYear);
  const outwardTransferDateRaw = compact.match(/([0-3]?\d\s*-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic))(?:\s+\1)?\s+TRASFERIMENTO\s+PORTO\s*-\s*HOTEL/i)?.[1];
  const returnTransferDateRaw = compact.match(/([0-3]?\d\s*-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic))(?:\s+\1)?\s+TRASFERIMENTO\s+HOTEL\s*-\s*PORTO/i)?.[1];
  const outwardStationDateRaw = compact.match(/([0-3]?\d\s*-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic))(?:\s+\1)?\s+TRASFERIMENTO\s+STAZIONE\s+NAPOLI\s*-\s*HOTEL/i)?.[1];
  const returnStationDateRaw = compact.match(/([0-3]?\d\s*-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic))(?:\s+\1)?\s+TRASFERIMENTO\s+HOTEL\s+ISCHIA\s*-\s*STAZIONE/i)?.[1];
  const outwardTransferDate =
    parseShortItalianDate(outwardTransferDateRaw, fromDate?.slice(0, 4) ?? fallbackYear) ??
    parseItalianDateLoose(outwardTransferDateRaw, fromDate?.slice(0, 4) ?? fallbackYear);
  const returnTransferDate =
    parseShortItalianDateRelative(returnTransferDateRaw, outwardTransferDate ?? fromDate ?? null) ??
    parseItalianDateLoose(returnTransferDateRaw, toDate?.slice(0, 4) ?? fallbackYear);
  const outwardStationDate =
    parseShortItalianDate(outwardStationDateRaw, fromDate?.slice(0, 4) ?? fallbackYear) ??
    parseItalianDateLoose(outwardStationDateRaw, fromDate?.slice(0, 4) ?? fallbackYear);
  const returnStationDate =
    parseShortItalianDateRelative(returnStationDateRaw, outwardStationDate ?? fromDate ?? null) ??
    parseItalianDateLoose(returnStationDateRaw, toDate?.slice(0, 4) ?? fallbackYear);
  const hasPortTransferRows = /TRASFERIMENTO\s+PORTO\s*-\s*HOTEL/i.test(compact) || /TRASFERIMENTO\s+HOTEL\s*-\s*PORTO/i.test(compact);
  const hasStationTransferRows =
    /TRASFERIMENTO\s+STAZIONE\s+NAPOLI\s*-\s*HOTEL/i.test(compact) ||
    /TRASFERIMENTO\s+HOTEL\s+ISCHIA\s*-\s*STAZIONE/i.test(compact);
  const transferDatesLocked = hasPortTransferRows || hasStationTransferRows;
  const outwardDate =
    outwardStationDate ??
    outwardTransferDate ??
    (transferDatesLocked ? null : fromDate) ??
    parseItalianDate(compact.match(/([0-3]?\d\s*-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:[.-]?\s*\d{2,4})?)\s+[0-3]?\d\s*-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:[.-]?\s*\d{2,4})?\s+(?:PERUGIA|TERNI)\s*-\s*ISCHIA/i)?.[1], fallbackYear) ??
    dateMatches.find((value) => value !== practiceDate && value !== toDate) ??
    null;
  const returnDate =
    returnStationDate ??
    returnTransferDate ??
    (transferDatesLocked ? null : toDate) ??
    parseItalianDate(compact.match(/([0-3]?\d\s*-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:[.-]?\s*\d{2,4})?)\s+[0-3]?\d\s*-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:[.-]?\s*\d{2,4})?\s+ISCHIA\s*-\s*(?:PERUGIA|TERNI)/i)?.[1], fallbackYear) ??
    dateMatches.filter((value) => value !== practiceDate && value !== outwardDate).slice(-1)[0] ??
    null;
  const outwardRoute = clean(compact.match(/(\b(?:PERUGIA|TERNI)\s*-\s*ISCHIA\b)/i)?.[1]);
  const returnRoute = clean(compact.match(/(\bISCHIA\s*-\s*(?:PERUGIA|TERNI)\b)/i)?.[1]);
  const totalAmountCandidates = [
    parseEuroAmount(compact.match(/Totale pratica.*?(\d+[.,]\d{2})/i)?.[1]),
    parseEuroAmount(compact.match(/totale\s*pratica.*?(\d+[.,]\d{2})/i)?.[1]),
    parseEuroAmount(compact.match(/(\d+[.,]\d{2})\s*Pagina\/Page/i)?.[1]),
    ...parseAllEuroAmounts(compact)
  ].filter((value): value is number => value !== null);
  const totalAmount = totalAmountCandidates.length > 0 ? Math.max(...totalAmountCandidates) : null;

  const outwardService: ParsedTransferService = {
    practice_number: practiceNumber,
    beneficiary,
    pax,
    service_type: "transfer",
    direction: "andata",
    service_date: outwardDate,
    service_time: null,
    pickup_meeting_point: hasStationTransferRows ? "STAZIONE" : hasPortTransferRows ? "PORTO" : clean(outwardRoute?.split("-")[0]) ?? "TERNI",
    origin: hasStationTransferRows ? "STAZIONE" : hasPortTransferRows ? "PORTO" : clean(outwardRoute?.split("-")[0]) ?? "TERNI",
    destination: hotel ?? "ISCHIA",
    carrier_company: hasPortTransferRows || hasStationTransferRows ? null : "BUS",
    hotel_structure: hotel,
    original_row_description: hasStationTransferRows
      ? "TRASFERIMENTO STAZIONE NAPOLI - HOTEL ISCHIA"
      : hasPortTransferRows
        ? "TRASFERIMENTO PORTO - HOTEL"
        : outwardRoute ?? "TERNI - ISCHIA",
    raw_detail_text: hasStationTransferRows
      ? `Transfer andata stazione-hotel verso ${hotel ?? "Ischia"}`
      : hasPortTransferRows
      ? `Transfer andata porto-hotel verso ${hotel ?? "Ischia"}`
      : `Bus andata da ${clean(outwardRoute?.split("-")[0]) ?? "Terni"} verso ${hotel ?? "Ischia"}`,
    parsing_status: "parsed",
    confidence_level: "medium",
    semantic_tag: "transfer_arrival"
  };

  const returnService: ParsedTransferService = {
    practice_number: practiceNumber,
    beneficiary,
    pax,
    service_type: "transfer",
    direction: "ritorno",
    service_date: returnDate,
    service_time: null,
    pickup_meeting_point: hotel ?? "ISCHIA",
    origin: hotel ?? "ISCHIA",
    destination: hasStationTransferRows ? "STAZIONE" : hasPortTransferRows ? "PORTO" : clean(returnRoute?.split("-")[1]) ?? "TERNI",
    carrier_company: hasPortTransferRows || hasStationTransferRows ? null : "BUS",
    hotel_structure: hotel,
    original_row_description: hasStationTransferRows
      ? "TRASFERIMENTO HOTEL ISCHIA - STAZIONE NAPOLI"
      : hasPortTransferRows
        ? "TRASFERIMENTO HOTEL - PORTO"
        : returnRoute ?? "ISCHIA - TERNI",
    raw_detail_text: hasStationTransferRows
      ? `Transfer ritorno hotel-stazione da ${hotel ?? "Ischia"}`
      : hasPortTransferRows
      ? `Transfer ritorno hotel-porto da ${hotel ?? "Ischia"}`
      : `Bus ritorno da ${hotel ?? "Ischia"} verso ${clean(returnRoute?.split("-")[1]) ?? "Terni"}`,
    parsing_status: "parsed",
    confidence_level: "medium",
    semantic_tag: "transfer_departure"
  };

  return {
    practice_number: practiceNumber,
    practice_date: practiceDate,
    first_beneficiary: beneficiary,
    customer_full_name: beneficiary,
    ns_reference: reference,
    ns_contact: null,
    pax,
    program: clean(compact.match(/programma\s*([A-Z ]+)/i)?.[1]),
    package_description: "CONFERMA D'ORDINE ANGELINO TOUR OPERATOR",
    date_from: outwardDate,
    date_to: returnDate,
    total_amount_practice: totalAmount,
    booking_kind: hasStationTransferRows ? "transfer_train_hotel" : hasPortTransferRows ? "transfer_port_hotel" : "bus_city_hotel",
    service_type_code: hasStationTransferRows ? "transfer_station_hotel" : hasPortTransferRows ? "transfer_port_hotel" : "bus_line",
    service_rows: [outwardService, returnService].map((service) => ({
      row_text: service.original_row_description ?? service.raw_detail_text,
      semantic_tag: service.semantic_tag,
      direction: service.direction
    })),
    operational_details: [outwardService, returnService].map((service) => ({
      service_date: service.service_date,
      service_time: service.service_time,
      meeting_point: service.pickup_meeting_point,
      from_text: service.origin,
      to_text: service.destination,
      dest_text: service.destination,
      description_line: service.original_row_description,
      raw_detail_text: service.raw_detail_text
    })),
    parsed_services: [outwardService, returnService],
    parsing_status: practiceNumber && beneficiary && hotel ? "parsed" : "needs_review",
    confidence_level: practiceNumber && beneficiary && hotel && totalAmount !== null ? "medium" : "low",
    anomaly_message: secondPassenger
      ? `OCR Angelino: controlla nominativi multipli. Secondo nominativo rilevato: ${secondPassenger}.`
      : "OCR Angelino: controlla nominativi e date prima della conferma."
  };
}

export const agencyAngelinoTourPdfParser: AgencyPdfParserImplementation = {
  key: "agency_angelino_tour",
  mode: "dedicated",
  label: "Angelino Tour Operator",
  senderDomains: [],
  subjectHints: ["angelino", "conferma d'ordine"],
  contentHints: ["angelino tour operator", "hotel terme zi carmela", "perugia - ischia"],
  agencyNameHints: ["angelino tour operator", "angelino tour"],
  voucherHints: ["pratica", "beneficiario", "totale pratica"],
  parse: parseAngelinoTourPdfText,
  match: (input) =>
    buildParserMatch(input, {
      senderDomains: [],
      subjectHints: ["angelino", "conferma d'ordine"],
      contentHints: ["angelino tour operator", "hotel terme zi carmela", "perugia - ischia"],
      agencyNameHints: ["angelino tour operator", "angelino tour"],
      voucherHints: ["pratica", "beneficiario", "totale pratica"]
    })
};
