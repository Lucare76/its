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

function cleanOcrField(value?: string | null) {
  const normalized = clean(value);
  if (!normalized) return null;
  const stopAt = normalized.search(/\b(riferimento|ns riferimento|ns referente|importo|tasse|data|dal|al|programma|descrizione)\b/i);
  return clean(stopAt > 0 ? normalized.slice(0, stopAt) : normalized);
}

function parseItalianDate(raw?: string | null) {
  const match = String(raw ?? "").match(/([0-3]?\d)-\s*(gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\s*(\d{2,4})/i);
  if (!match) return null;
  const month = IT_MONTHS[match[2].toLowerCase()];
  if (!month) return null;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${month}-${match[1].padStart(2, "0")}`;
}

function parseShortItalianDate(raw?: string | null, fallbackYear?: string | null) {
  const match = String(raw ?? "").match(/([0-3]?\d)-\s*(gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)\b/i);
  if (!match || !fallbackYear) return null;
  const month = IT_MONTHS[match[2].toLowerCase()];
  if (!month) return null;
  return `${fallbackYear}-${match[1].padStart(2, "0")}-${month}`.replace(/-(\d{2})-(\d{2})$/, "-$2-$1");
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

function normalizeHolidayOcrText(sourceText: string) {
  return sourceText
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .replace(/hollday/gi, "holiday")
    .replace(/0tt/gi, "ott")
    .replace(/ri feri mento/gi, "riferimento")
    .replace(/prati ca/gi, "pratica")
    .replace(/descri zi one/gi, "descrizione")
    .replace(/nomi nati vo/gi, "nominativo")
    .replace(/i mporto/gi, "importo")
    .replace(/ri feri mento ns/gi, "riferimento ns")
    .replace(/Data HOLI/gi, "Holiday")
    .replace(/LINEAUMBRI/gi, "LINEA UMBRIA")
    .replace(/oo/gi, "00")
    .trim();
}

function parseHolidaySudItaliaPdfText(sourceText: string): ParsedTransferPdfPayload {
  const compact = normalizeHolidayOcrText(sourceText);
  const practiceNumber = clean(compact.match(/pratica\s*(\d{2}\/\d{6})/i)?.[1]);
  const orderReference = clean(compact.match(/CONFERMA D[' ]ORDINE\s*n\.\s*(\d{3,})/i)?.[1]);
  const reference = clean(compact.match(/ns referente\s*([A-Z][A-Za-z ]+)/i)?.[1]) ?? orderReference;
  const pax = Number(compact.match(/\bpax\s*(\d{1,2})/i)?.[1] ?? 0) || null;
  const practiceDate = parseItalianDate(compact.match(/data\s*([0-3]?\d-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\s*\d{2,4})/i)?.[1]);
  const fallbackYear = practiceDate?.slice(0, 4) ?? null;
  const beneficiary =
    cleanOcrField(compact.match(/beneficiario\s*([A-Z][A-Za-z' ]+?)(?=\s+riferimento|\s+importo|\s+ns referente|\s+dal|\s+Hotel|\s+HOTEL|$)/i)?.[1]) ??
    cleanOcrField(compact.match(/nominativo\s+\d+\s+([A-Z][A-Za-z' ]+?)(?=\s+\d{2}\s*-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)|\s+totale|\s+Pagina|$)/i)?.[1]);
  const hotel =
    clean(compact.match(/\bal\s+([A-Z][A-Za-z' ]+)\s+HOTEL\b/i)?.[1]) ??
    clean(compact.match(/\b([A-Z][A-Za-z' ]+)\s+HOTEL\b(?=\s+descrizione|\s+ISCHIA TRANSFER SERVICE|\s+tasse|$)/i)?.[1]) ??
    clean(compact.match(/hotel\s*([A-Z][A-Za-z' ]+\d?\*?)/i)?.[1]);
  const routeOutward = clean(compact.match(/descrizione\s*ISCHIA TRANSFER SERVICE-ISCHIA \(NA\)\s*([A-Z' ]+\s*-\s*ISCHIA)/i)?.[1]);
  const routeReturn = clean(compact.match(/ISCHIA TRANSFER SERVICE-ISCHIA \(NA\)\s*(ISCHIA\s*-\s*[A-Z' ]+)/i)?.[1]);
  const routeDates = Array.from(compact.matchAll(/([0-3]?\d-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\s*\d{2,4})/gi))
    .map((match) => parseItalianDate(match[1]))
    .filter((value): value is string => Boolean(value));
  const dalBlock = compact.match(/\bdal\s+([0-3]?\d-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic))\s+\1\s+([0-3]?\d-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic))\s+\2/i);
  const outwardShortRaw = compact.match(/([0-3]?\d-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic))\s+\1\s+descrizione\s*ISCHIA TRANSFER SERVICE-ISCHIA \(NA\)\s*[A-Z' ]+\s*-\s*ISCHIA/i)?.[1];
  const returnShortRaw = compact.match(/([0-3]?\d-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic))\s+\1\s+ISCHIA TRANSFER SERVICE-ISCHIA \(NA\)\s*ISCHIA\s*-\s*[A-Z' ]+/i)?.[1];
  const outwardDate =
    parseShortItalianDate(dalBlock?.[1], fallbackYear) ??
    parseShortItalianDate(outwardShortRaw, fallbackYear) ??
    routeDates.find((value) => value !== practiceDate) ??
    null;
  const returnDate =
    parseShortItalianDate(dalBlock?.[2], fallbackYear) ??
    parseShortItalianDate(returnShortRaw, fallbackYear) ??
    routeDates.filter((value) => value !== practiceDate && value !== outwardDate).slice(-1)[0] ??
    null;
  const totalAmountCandidates = [
    parseEuroAmount(compact.match(/Totale pratica.*?(\d+[.,]\d{2})/i)?.[1]),
    parseEuroAmount(compact.match(/totale\s*pratica.*?(\d+[.,]\d{2})/i)?.[1]),
    parseEuroAmount(compact.match(/totale\s*(\d+[.,]\d{2})/i)?.[1]),
    ...parseAllEuroAmounts(compact)
  ].filter((value): value is number => value !== null);
  const totalAmount = totalAmountCandidates.length > 0 ? Math.max(...totalAmountCandidates) : null;

  const outwardOrigin = clean(routeOutward?.split("-")[0] ?? "ORTE");
  const returnDestination = clean(routeReturn?.split("-")[1] ?? "ORTE");

  const outwardService: ParsedTransferService = {
    practice_number: practiceNumber,
    beneficiary,
    pax,
    service_type: "transfer",
    direction: "andata",
    service_date: outwardDate,
    service_time: null,
    pickup_meeting_point: outwardOrigin,
    origin: outwardOrigin,
    destination: hotel ?? "ISCHIA",
    carrier_company: "BUS",
    hotel_structure: hotel,
    original_row_description: routeOutward ?? "ORTE - ISCHIA",
    raw_detail_text: `Bus andata da ${outwardOrigin ?? "ORTE"} verso ${hotel ?? "Ischia"}`,
    parsing_status: "needs_review",
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
    destination: returnDestination,
    carrier_company: "BUS",
    hotel_structure: hotel,
    original_row_description: routeReturn ?? "ISCHIA - ORTE",
    raw_detail_text: `Bus ritorno da ${hotel ?? "Ischia"} verso ${returnDestination ?? "ORTE"}`,
    parsing_status: "needs_review",
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
    program: clean(compact.match(/programma\s*([A-Z ]+)/i)?.[1]) ?? "LINEA UMBRIA",
    package_description: "CONFERMA D'ORDINE HOLIDAY SUD ITALIA",
    date_from: outwardDate,
    date_to: returnDate,
    total_amount_practice: totalAmount,
    service_type_code: "bus_line",
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
    parsing_status: practiceNumber && beneficiary && outwardDate ? "parsed" : "needs_review",
    confidence_level: practiceNumber && beneficiary && hotel && totalAmount !== null ? "medium" : "low",
    anomaly_message: "OCR Holiday Sud Italia: controlla nominativi, date e orari prima della conferma."
  };
}

export const agencyHolidaySudItaliaPdfParser: AgencyPdfParserImplementation = {
  key: "agency_holiday_sud_italia",
  mode: "dedicated",
  label: "Holiday Sud Italia",
  senderDomains: [],
  subjectHints: ["holiday", "conferma d'ordine"],
  contentHints: ["holiday sud italia", "conferma d'ordine", "linea umbria", "hotel isola verde"],
  agencyNameHints: ["holiday sud italia"],
  voucherHints: ["pratica", "beneficiario", "totale pratica"],
  parse: parseHolidaySudItaliaPdfText,
  match: (input) =>
    buildParserMatch(input, {
      senderDomains: [],
      subjectHints: ["holiday", "conferma d'ordine"],
      contentHints: ["holiday sud italia", "conferma d'ordine", "linea umbria", "hotel isola verde"],
      agencyNameHints: ["holiday sud italia"],
      voucherHints: ["pratica", "beneficiario", "totale pratica"]
    })
};
