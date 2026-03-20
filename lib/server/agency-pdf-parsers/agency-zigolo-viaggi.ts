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

function cleanBeneficiary(value?: string | null) {
  const normalized = clean(value);
  if (!normalized) return null;
  const stopAt = normalized.search(/\b(dal|descrizione|importo|tasse|pax|totale|data prenotazione|stato prenotazione)\b/i);
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

function normalizeZigoloText(sourceText: string) {
  return sourceText
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .replace(/daldal/gi, "dal")
    .replace(/alal/gi, "al")
    .replace(/data(?=\d)/gi, "data ")
    .replace(/benefici ari/gi, "beneficiari")
    .replace(/trattamento e note/gi, "trattamento e note")
    .replace(/numservizio/gi, "num servizio")
    .replace(/datal/gi, "data ")
    .trim();
}

function parseZigoloViaggiPdfText(sourceText: string): ParsedTransferPdfPayload {
  const compact = normalizeZigoloText(sourceText);

  const practiceNumber = clean(compact.match(/pratica\s*(\d{2}\/\d{6})/i)?.[1]);
  const practiceDate = parseItalianDate(compact.match(/\bdata\s*([0-3]?\d-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\s*\d{2,4})/i)?.[1]);
  const bookingDate = parseItalianDate(compact.match(/data prenotazione\s*:\s*([0-3]?\d-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\s*\d{2,4})/i)?.[1]);
  const reference = clean(compact.match(/pratica\s*\d{2}\/\d{6}\s*ref\.\s*([^\n]+)/i)?.[1]);
  const bookingState = clean(compact.match(/stato prenotazione\s*([^\n]+)/i)?.[1]);
  const serviceDescription =
    clean(compact.match(/\b\d{3}\s*(TOUR DELL'ISOLA IN BUS)\b/i)?.[1]) ??
    clean(compact.match(/\b\d{3}\s+([A-Z' ]+?)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\s+trattamento e note/i)?.[1]) ??
    clean(compact.match(/\bdescrizione\s+([A-Z' ]+?)\s+importo\b/i)?.[1]);
  const beneficiary =
    cleanBeneficiary(compact.match(/TOUR DELL'ISOLA IN BUS\s*([^\n]+)/i)?.[1]) ??
    cleanBeneficiary(compact.match(/beneficiari\s+([^\n]+?)(?:trattamento e note|dal|descrizione|importo|tasse|pax|totale|$)/i)?.[1]) ??
    cleanBeneficiary(compact.match(/\b\d{3}\s+[A-Z' ]+\s+([^\n]+?)(?:trattamento e note|dal|descrizione|importo|tasse|pax|totale|$)/i)?.[1]);
  const fromDate = parseItalianDate(compact.match(/\bdal\s+([0-3]?\d-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\s*\d{2,4})/i)?.[1]);
  const toDate = parseItalianDate(compact.match(/\bal\s+([0-3]?\d-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\s*\d{2,4})/i)?.[1]);
  const pax =
    Number(compact.match(/\bpax\s*(\d{1,2})/i)?.[1] ?? compact.match(/(\d{1,2})\(\d+\)\s*\d+[.,]\d{2}/i)?.[1] ?? 0) || null;
  const totalAmountCandidates = [
    parseEuroAmount(compact.match(/\btotale\s*eur\s*(\d+[.,]\d{2})/i)?.[1]),
    parseEuroAmount(compact.match(/\btotaleeur\s*(\d+[.,]\d{2})/i)?.[1]),
    parseEuroAmount(compact.match(/\btotale\s*(\d+[.,]\d{2})/i)?.[1]),
    ...parseAllEuroAmounts(compact)
  ].filter((value): value is number => value !== null);
  const totalAmount = totalAmountCandidates.length > 0 ? Math.max(...totalAmountCandidates) : null;

  const parserNotes = [bookingState, bookingDate ? `Data prenotazione ${bookingDate}` : null].filter(Boolean).join(" | ");

  const excursionService: ParsedTransferService | null =
    serviceDescription && fromDate
      ? {
          practice_number: practiceNumber,
          beneficiary,
          pax,
          service_type: "transfer",
          direction: "andata",
          service_date: fromDate,
          service_time: null,
          pickup_meeting_point: null,
          origin: null,
          destination: null,
          carrier_company: null,
          hotel_structure: null,
          original_row_description: serviceDescription,
          raw_detail_text: [serviceDescription, beneficiary, parserNotes].filter(Boolean).join(" | "),
          parsing_status: "parsed",
          confidence_level: "medium",
          semantic_tag: "transfer_arrival"
        }
      : null;

  const parsedServices = excursionService ? [excursionService] : [];

  return {
    practice_number: practiceNumber,
    practice_date: practiceDate,
    first_beneficiary: beneficiary,
    customer_full_name: beneficiary,
    ns_reference: reference,
    ns_contact: null,
    pax,
    program: serviceDescription,
    package_description: "ELENCO RICHIESTE CONFERME ANNULLAMENTI SERVIZI",
    date_from: fromDate,
    date_to: toDate ?? fromDate,
    total_amount_practice: totalAmount,
    booking_kind: "excursion",
    service_type_code: "excursion",
    service_rows: parsedServices.map((service) => ({
      row_text: service.original_row_description ?? service.raw_detail_text,
      semantic_tag: "excursion",
      direction: service.direction
    })),
    operational_details: parsedServices.map((service) => ({
      service_date: service.service_date,
      service_time: service.service_time,
      meeting_point: service.pickup_meeting_point,
      from_text: service.origin,
      to_text: service.destination,
      dest_text: service.destination,
      description_line: service.original_row_description,
      raw_detail_text: service.raw_detail_text
    })),
    parsed_services: parsedServices,
    parsing_status: practiceNumber && beneficiary && serviceDescription && fromDate ? "parsed" : "needs_review",
    confidence_level: practiceNumber && beneficiary && serviceDescription && totalAmount !== null ? "medium" : "low",
    anomaly_message:
      bookingState || bookingDate
        ? `Zigolo Viaggi: verifica stato/prenotazione prima della conferma. ${parserNotes}`.trim()
        : "Zigolo Viaggi: verifica dettagli escursione prima della conferma."
  };
}

export const agencyZigoloViaggiPdfParser: AgencyPdfParserImplementation = {
  key: "agency_zigolo_viaggi",
  mode: "dedicated",
  label: "Zigolo Viaggi",
  senderDomains: [],
  subjectHints: ["zigolo", "conferme annullamenti servizi", "tour dell'isola"],
  contentHints: ["zigolo viaggi", "elenco richieste conferme annullamenti servizi", "tour dell'isola in bus"],
  agencyNameHints: ["zigolo viaggi", "zigoloviaggi s.r.l."],
  voucherHints: ["pratica", "stato prenotazione", "beneficiari", "tour dell'isola in bus"],
  parse: parseZigoloViaggiPdfText,
  match: (input) =>
    buildParserMatch(input, {
      senderDomains: [],
      subjectHints: ["zigolo", "conferme annullamenti servizi", "tour dell'isola"],
      contentHints: ["zigolo viaggi", "elenco richieste conferme annullamenti servizi", "tour dell'isola in bus"],
      agencyNameHints: ["zigolo viaggi", "zigoloviaggi s.r.l."],
      voucherHints: ["pratica", "stato prenotazione", "beneficiari", "tour dell'isola in bus"]
    })
};
