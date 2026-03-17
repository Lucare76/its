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
  const stopAt = normalized.search(/\b(ns riferimento|ns referente|importo|tasse|data|dal|al|programma|descrizione|pax|num|pagina)\b/i);
  return clean(stopAt > 0 ? normalized.slice(0, stopAt) : normalized);
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
  const beneficiary = cleanOcrField(compact.match(/beneficiario\s*([A-Z][A-Za-z' ]+)/i)?.[1]);
  const secondPassenger = clean(compact.match(/nominativo\s*([A-Z][A-Za-z' ]+)\s*EUR/i)?.[1]);
  const pax = Number(compact.match(/\bpax\s*(\d{1,2})/i)?.[1] ?? 0) || null;
  const reference = cleanOcrField(compact.match(/ns referente\s*([A-Z][A-Za-z' ]+)/i)?.[1]) ?? orderNumber;
  const hotel = clean(compact.match(/HOTEL\s+([A-Z][A-Za-z' ]+\*?)/i)?.[1]);
  const dateMatches = Array.from(compact.matchAll(/([0-3]?\d\s*-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)[.-]?\s*\d{2,4})/gi))
    .map((match) => parseItalianDate(match[1], fallbackYear))
    .filter((value): value is string => Boolean(value));
  const fromDate = parseItalianDate(compact.match(/\bdal\s*([0-3]?\d\s*-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:[.-]?\s*\d{2,4})?)/i)?.[1], fallbackYear);
  const toDate = parseItalianDate(compact.match(/\bal\s*([0-3]?\d\s*-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:[.-]?\s*\d{2,4})?)/i)?.[1], fallbackYear);
  const outwardDate =
    fromDate ??
    parseItalianDate(compact.match(/([0-3]?\d\s*-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:[.-]?\s*\d{2,4})?)\s+[0-3]?\d\s*-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:[.-]?\s*\d{2,4})?\s+(?:PERUGIA|TERNI)\s*-\s*ISCHIA/i)?.[1], fallbackYear) ??
    dateMatches.find((value) => value !== practiceDate && value !== toDate) ??
    null;
  const returnDate =
    toDate ??
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
    pickup_meeting_point: clean(outwardRoute?.split("-")[0]) ?? "TERNI",
    origin: clean(outwardRoute?.split("-")[0]) ?? "TERNI",
    destination: hotel ?? "ISCHIA",
    carrier_company: "BUS",
    hotel_structure: hotel,
    original_row_description: outwardRoute ?? "TERNI - ISCHIA",
    raw_detail_text: `Bus andata da ${clean(outwardRoute?.split("-")[0]) ?? "Terni"} verso ${hotel ?? "Ischia"}`,
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
    destination: clean(returnRoute?.split("-")[1]) ?? "TERNI",
    carrier_company: "BUS",
    hotel_structure: hotel,
    original_row_description: returnRoute ?? "ISCHIA - TERNI",
    raw_detail_text: `Bus ritorno da ${hotel ?? "Ischia"} verso ${clean(returnRoute?.split("-")[1]) ?? "Terni"}`,
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
    booking_kind: "bus_city_hotel",
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
