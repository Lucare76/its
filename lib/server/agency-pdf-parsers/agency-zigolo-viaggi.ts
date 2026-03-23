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

function normalizeCustomerName(value?: string | null) {
  const normalized = cleanBeneficiary(value);
  if (!normalized) return null;
  return clean(
    normalized
      .replace(/\d{1,2}-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\d{2,4}$/i, "")
      .replace(/\d+$/g, "")
  );
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

function parseTsfBlocks(compact: string, practiceNumber: string | null) {
  const blocks = Array.from(
    compact.matchAll(
      /stato prenotazione\s*conf extra\s*data prenotazione:\s*([0-3]?\d-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\s*\d{2,4})\s*dal\s*([0-3]?\d-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\s*\d{2,4})\s*num servizio beneficiari trattamento e note\s*001\s*(TSF PER HOTEL (?:ANDATA|RITORNO))\s*([A-ZÀ-ÖØ-Ý' ]+?)\s*(?:\d{1,2}-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\d{2,4})?\s*dal al descrizione importo tasse(?:pax)? totale\s*([0-3]?\d-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic))\s*([0-3]?\d-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic))\s*TSF PER HOTEL (ANDATA|RITORNO)\s*(\d+[.,]\d{2})(?:\s*(\d{1,2})\(\d+\)|\((\d+)\))?\s*(\d+[.,]\d{2})/gi
    )
  ).map((match) => {
    const passengerCount = Number(match[8] ?? match[9] ?? 0) || null;
    const direction: "andata" | "ritorno" = /RITORNO/i.test(match[6] ?? match[3]) ? "ritorno" : "andata";
    return {
      bookingDate: parseItalianDate(match[1]),
      serviceDate: parseItalianDate(match[2]),
      description: clean(match[3]),
      beneficiary: normalizeCustomerName(match[4]),
      direction,
      lineAmount: parseEuroAmount(match[7]),
      pax: passengerCount,
      totalAmount: parseEuroAmount(match[10]),
      service: {
        practice_number: practiceNumber,
        beneficiary: normalizeCustomerName(match[4]),
        pax: passengerCount,
        service_type: "transfer" as const,
        direction,
        service_date: parseItalianDate(match[2]),
        service_time: null,
        pickup_meeting_point: null,
        origin: direction === "andata" ? "PORTO" : "HOTEL ISCHIA",
        destination: direction === "andata" ? "HOTEL ISCHIA" : "PORTO",
        carrier_company: null,
        hotel_structure: null,
        original_row_description: clean(match[3]),
        raw_detail_text: [clean(match[3]), normalizeCustomerName(match[4]), parseItalianDate(match[2])].filter(Boolean).join(" | "),
        parsing_status: "parsed" as const,
        confidence_level: "medium" as const,
        semantic_tag: direction === "andata" ? ("transfer_arrival" as const) : ("transfer_departure" as const)
      }
    };
  });

  return blocks;
}

function normalizeTime(raw?: string | null) {
  const match = String(raw ?? "").match(/([01]?\d|2[0-3])[.:]([0-5]\d)/);
  if (!match) return null;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function parseBusTransferBlocks(compact: string, practiceNumber: string | null) {
  return Array.from(
    compact.matchAll(
      /stato prenotazione\s*conf extra\s*data prenotazione:\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\d{2,4})\s*dal\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\d{2,4})\s*num servizio beneficiari trattamento e note\s*001\s+(BUS\s+DA\s+[A-Z ]+?\s+\d{1,2}[.:]\d{2}|BUS\s+[-A-Z /]+?RITORNO)\s+([^\n]+)[\s\S]*?(\d+[.,]\d{2})\s+(\d+)\s*\(\d+\)\s+(\d+[.,]\d{2})\s*totale eur\s*(\d+[.,]\d{2})/gi
    )
  ).map((match) => {
    const description = clean(match[3]);
    const timeMatch = description?.match(/(\d{1,2}[.:]\d{2})\s*$/);
    const serviceTime = timeMatch ? normalizeTime(timeMatch[1]) : null;
    const isReturn = /RITORNO/i.test(description ?? "");
    const direction: "andata" | "ritorno" = isReturn ? "ritorno" : "andata";
    const pax = Number(match[6]) || null;
    const firstBeneficiary = normalizeCustomerName(match[4]);
    const cityName = isReturn
      ? clean(description?.match(/BUS\s+ISCHIA\s*-\s*([-A-Z ]+?)\s+RITORNO/i)?.[1])
      : clean(description?.replace(/^BUS\s+DA\s+/i, "").replace(/\s+\d{1,2}[.:]\d{2}$/, ""));
    const origin = isReturn ? "HOTEL ISCHIA" : cityName;
    const destination = isReturn ? cityName : "HOTEL ISCHIA";
    return {
      bookingDate: parseItalianDate(match[1]),
      serviceDate: parseItalianDate(match[2]),
      description,
      serviceTime,
      beneficiary: firstBeneficiary,
      direction,
      lineAmount: parseEuroAmount(match[5]),
      pax,
      totalAmount: parseEuroAmount(match[8]),
      service: {
        practice_number: practiceNumber,
        beneficiary: firstBeneficiary,
        pax,
        service_type: "transfer" as const,
        direction,
        service_date: parseItalianDate(match[2]),
        service_time: serviceTime,
        pickup_meeting_point: isReturn ? "HOTEL ISCHIA" : cityName,
        origin,
        destination,
        carrier_company: "BUS",
        hotel_structure: null,
        original_row_description: description,
        raw_detail_text: [description, firstBeneficiary, parseItalianDate(match[2])].filter(Boolean).join(" | "),
        parsing_status: "parsed" as const,
        confidence_level: "medium" as const,
        semantic_tag: direction === "andata" ? ("transfer_arrival" as const) : ("transfer_departure" as const)
      }
    };
  });
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
  const tsfBlocks = parseTsfBlocks(compact, null);
  const busBlocks = parseBusTransferBlocks(compact, null);

  const practiceNumber = clean(compact.match(/pratica\s*(\d{2}\/\d{6})/i)?.[1]);
  const practiceDate =
    parseItalianDate(compact.match(/\bdata\s*([0-3]?\d-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\s*\d{2,4})/i)?.[1]) ??
    parseItalianDate(compact.match(/servizi\s*n\.\s*\d+\s*data\s*([0-3]?\d-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\s*\d{2,4})/i)?.[1]);
  const bookingDate = tsfBlocks[0]?.bookingDate ?? parseItalianDate(compact.match(/data prenotazione\s*:\s*([0-3]?\d-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\s*\d{2,4})/i)?.[1]);
  const reference = clean(compact.match(/pratica\s*\d{2}\/\d{6}\s*ref\.\s*([^\n]+)/i)?.[1]);
  const bookingState = clean(compact.match(/stato prenotazione\s*([^\n]+)/i)?.[1]);
  const hasTsfTransfer = /TSF PER HOTEL (?:ANDATA|RITORNO)/i.test(compact);
  const hasBusTransfer = busBlocks.length > 0;
  const serviceDescription =
    clean(compact.match(/\b\d{3}\s*(TOUR DELL'ISOLA IN BUS)\b/i)?.[1]) ??
    clean(compact.match(/\b\d{3}\s+([A-Z' ]+?)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\s+trattamento e note/i)?.[1]) ??
    clean(compact.match(/\bdescrizione\s+([A-Z' ]+?)\s+importo\b/i)?.[1]);
  const beneficiary =
    busBlocks[0]?.beneficiary ??
    tsfBlocks[0]?.beneficiary ??
    normalizeCustomerName(compact.match(/TSF PER HOTEL (?:ANDATA|RITORNO)\s*([A-ZÀ-ÖØ-Ý' ]+?)\s*\d{1,2}-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\d{2,4}/i)?.[1]) ??
    cleanBeneficiary(compact.match(/TOUR DELL'ISOLA IN BUS\s*([^\n]+)/i)?.[1]) ??
    cleanBeneficiary(compact.match(/beneficiari\s+([^\n]+?)(?:trattamento e note|dal|descrizione|importo|tasse|pax|totale|$)/i)?.[1]) ??
    cleanBeneficiary(compact.match(/\b\d{3}\s+[A-Z' ]+\s+([^\n]+?)(?:trattamento e note|dal|descrizione|importo|tasse|pax|totale|$)/i)?.[1]);
  const fromDate =
    busBlocks.find((item) => item.direction === "andata")?.serviceDate ??
    tsfBlocks.find((item) => item.direction === "andata")?.serviceDate ??
    parseItalianDate(compact.match(/\bdal\s+([0-3]?\d-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\s*\d{2,4})/i)?.[1]);
  const toDate =
    busBlocks.find((item) => item.direction === "ritorno")?.serviceDate ??
    tsfBlocks.find((item) => item.direction === "ritorno")?.serviceDate ??
    parseItalianDate(compact.match(/\bal\s+([0-3]?\d-\s*(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\s*\d{2,4})/i)?.[1]) ??
    fromDate;
  const pax =
    (busBlocks.map((item) => item.pax).filter((value): value is number => Boolean(value)).length > 0
      ? Math.max(...busBlocks.map((item) => item.pax).filter((value): value is number => Boolean(value)))
      : null) ??
    (tsfBlocks.map((item) => item.pax).filter((value): value is number => Boolean(value)).length > 0
      ? Math.max(...tsfBlocks.map((item) => item.pax).filter((value): value is number => Boolean(value)))
      : null) ??
    (Number(compact.match(/\bpax\s*(\d{1,2})/i)?.[1] ?? compact.match(/(?:\s|^)(\d{1,2})\(\d+\)\s*\d+[.,]\d{2}/i)?.[1] ?? 0) || null);
  const totalAmountCandidates = [
    parseEuroAmount(compact.match(/\btotale\s*eur\s*(\d+[.,]\d{2})/i)?.[1]),
    parseEuroAmount(compact.match(/\btotaleeur\s*(\d+[.,]\d{2})/i)?.[1]),
    parseEuroAmount(compact.match(/\btotale\s*(\d+[.,]\d{2})/i)?.[1]),
    ...parseAllEuroAmounts(compact)
  ].filter((value): value is number => value !== null);
  const busTotalAmount = hasBusTransfer
    ? busBlocks.reduce((sum, b) => sum + (b.totalAmount ?? 0), 0) || null
    : null;
  const totalAmount = busTotalAmount ?? (totalAmountCandidates.length > 0 ? Math.max(...totalAmountCandidates) : null);

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

  const parsedServices = hasBusTransfer
    ? busBlocks.map((item) => item.service)
    : hasTsfTransfer
      ? tsfBlocks.map((item) => item.service)
      : excursionService
        ? [excursionService]
        : [];
  const bookingKind = hasBusTransfer ? "bus_city_hotel" : hasTsfTransfer ? "transfer_port_hotel" : "excursion";
  const serviceTypeCode = hasBusTransfer ? "bus_line" : hasTsfTransfer ? "transfer_port_hotel" : "excursion";

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
    date_to: toDate,
    total_amount_practice: totalAmount,
    booking_kind: bookingKind,
    service_type_code: serviceTypeCode,
    service_rows: parsedServices.map((service) => ({
      row_text: service.original_row_description ?? service.raw_detail_text,
      semantic_tag: hasTsfTransfer ? service.semantic_tag : "excursion",
      direction: service.direction as "andata" | "ritorno"
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
    parsing_status: practiceNumber && beneficiary && fromDate ? "parsed" : "needs_review",
    confidence_level: practiceNumber && beneficiary && totalAmount !== null ? "medium" : "low",
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
