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

function parseItalianDate(raw?: string | null) {
  const match = String(raw ?? "").match(/([0-3]?\d)-\s*(gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)[.-]?\s*(\d{2,4})/i);
  if (!match) return null;
  const month = IT_MONTHS[match[2].toLowerCase()];
  if (!month) return null;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${month}-${match[1].padStart(2, "0")}`;
}

function parseEuroAmount(raw?: string | null) {
  const match = String(raw ?? "").match(/(\d+(?:[.,]\d{2}))/);
  if (!match) return null;
  const value = Number(match[1].replace(/\./g, "").replace(",", "."));
  return Number.isFinite(value) ? value : null;
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
    .trim();
}

function parseAngelinoTourPdfText(sourceText: string): ParsedTransferPdfPayload {
  const compact = normalizeAngelinoOcrText(sourceText);
  const practiceNumber = clean(compact.match(/pratica\s*(\d{2}\/\d{6})/i)?.[1]);
  const orderNumber = clean(compact.match(/CONFERMA D[' ]ORDINE\s*n\.\s*(\d{3,})/i)?.[1]);
  const practiceDate = parseItalianDate(compact.match(/data\s*([0-3]?\d-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)[.-]?\s*\d{2,4})/i)?.[1]);
  const beneficiary = clean(compact.match(/beneficiario\s*([A-Z][A-Za-z' ]+)/i)?.[1]);
  const secondPassenger = clean(compact.match(/nominativo\s*([A-Z][A-Za-z' ]+)\s*EUR/i)?.[1]);
  const pax = Number(compact.match(/\bpax\s*(\d{1,2})/i)?.[1] ?? 0) || null;
  const reference = clean(compact.match(/ns referente\s*([A-Z][A-Za-z' ]+)/i)?.[1]) ?? orderNumber;
  const hotel = clean(compact.match(/HOTEL\s+([A-Z][A-Za-z' ]+\*?)/i)?.[1]);
  const dateMatches = Array.from(compact.matchAll(/([0-3]?\d-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)[.-]?\s*\d{2,4})/gi))
    .map((match) => parseItalianDate(match[1]))
    .filter((value): value is string => Boolean(value));
  const outwardDate = dateMatches.find((value) => value !== practiceDate) ?? null;
  const returnDate = dateMatches.filter((value) => value !== practiceDate).slice(-1)[0] ?? null;
  const outwardRoute = clean(compact.match(/(\bPERUGIA\s*-\s*ISCHIA\b)/i)?.[1]);
  const returnRoute = clean(compact.match(/(\bISCHIA\s*-\s*PERUGIA\b)/i)?.[1]);
  const totalAmount =
    parseEuroAmount(compact.match(/Totale pratica.*?(\d+[.,]\d{2})/i)?.[1]) ??
    parseEuroAmount(compact.match(/totale\s*(\d+[.,]\d{2})/i)?.[1]);

  const outwardService: ParsedTransferService = {
    practice_number: practiceNumber,
    beneficiary,
    pax,
    service_type: "transfer",
    direction: "andata",
    service_date: outwardDate,
    service_time: null,
    pickup_meeting_point: "PERUGIA",
    origin: "PERUGIA",
    destination: hotel ?? "ISCHIA",
    carrier_company: "BUS",
    hotel_structure: hotel,
    original_row_description: outwardRoute ?? "PERUGIA - ISCHIA",
    raw_detail_text: `Bus andata da Perugia verso ${hotel ?? "Ischia"}`,
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
    destination: "PERUGIA",
    carrier_company: "BUS",
    hotel_structure: hotel,
    original_row_description: returnRoute ?? "ISCHIA - PERUGIA",
    raw_detail_text: `Bus ritorno da ${hotel ?? "Ischia"} verso Perugia`,
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
