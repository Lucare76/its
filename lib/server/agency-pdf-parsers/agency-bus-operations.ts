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
  const stopAt = normalized.search(/\b(data prenotazione|trattamento e note|importo|tasse|totale|pagina)\b/i);
  return clean(stopAt > 0 ? normalized.slice(0, stopAt) : normalized);
}

function mergeBrokenWords(value?: string | null) {
  const normalized = clean(value);
  if (!normalized) return null;
  const merged = normalized
    .split(" ")
    .reduce<string[]>((parts, token) => {
      if (parts.length === 0) return [token];
      if (/^[a-z]{1,3}$/i.test(token) && token === token.toLowerCase()) {
        parts[parts.length - 1] = `${parts[parts.length - 1]}${token}`;
        return parts;
      }
      return [...parts, token];
    }, [])
    .join(" ");
  return clean(merged);
}

function parseItalianDate(raw?: string | null) {
  const match = String(raw ?? "").match(/([0-3]?\d)-(gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-(\d{2,4})/i);
  if (!match) return null;
  const month = IT_MONTHS[match[2].toLowerCase()];
  if (!month) return null;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${month}-${match[1].padStart(2, "0")}`;
}

function normalizeTime(raw?: string | null) {
  const match = String(raw ?? "").match(/([01]?\d|2[0-3])[.:]([0-5]\d)/);
  if (!match) return null;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function parseEuroAmount(raw?: string | null) {
  const match = String(raw ?? "").match(/(\d+(?:[.,]\d{2}))/);
  if (!match) return null;
  const numeric = Number(match[1].replace(/\./g, "").replace(",", "."));
  return Number.isFinite(numeric) ? numeric : null;
}

function parseBusOperationsPdfText(sourceText: string): ParsedTransferPdfPayload {
  const compact = sourceText.replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  const lines = sourceText
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const practiceNumber = clean(compact.match(/Pratica\s*(\d{2}\/\d{6})/i)?.[1]);
  const reference =
    mergeBrokenWords(cleanOcrField(compact.match(/Ref\.\s*(.+?)\s+(?:Data prenotazione|NIJM|DAL|Servizio)/i)?.[1])) ??
    mergeBrokenWords(clean(compact.match(/Ref\.\s*([A-Z' ]+)/i)?.[1]));
  const practiceDate = parseItalianDate(compact.match(/Data\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\d{2,4})/i)?.[1]);

  const excursionDate = parseItalianDate(compact.match(/\bDal\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\d{2,4})/i)?.[1]);
  const excursionTitle = clean(compact.match(/(GIRO DELL'ISOLA IN BUS)/i)?.[1]);
  const excursionBeneficiary = mergeBrokenWords(
    cleanOcrField(compact.match(/Benefici\s*ari\s+(.+?)\s+Trattamento\s*e\s*note/i)?.[1])
  );
  const paxFromCompact = Number(compact.match(/\bPAX\s*(\d{1,2})/i)?.[1] ?? 0) || null;

  const firstBusLineIndex = lines.findIndex((line) => /^001BUS\s+DA/i.test(line));
  const firstDelimiterIndex = lines.findIndex((line, index) => index > firstBusLineIndex && /^DALALDESCRIZIONE/i.test(line));
  const firstBusSegment =
    firstBusLineIndex >= 0 && firstDelimiterIndex > firstBusLineIndex
      ? lines.slice(firstBusLineIndex, firstDelimiterIndex)
      : [];

  const beneficiaries = firstBusSegment
    .flatMap((line, index) => {
      if (index === 0) {
        const firstName = clean(line.match(/^001BUS.*?([A-Z' ]+\s+[A-Z' ]+)$/i)?.[1]);
        return firstName ? [firstName] : [];
      }
      const value = clean(line);
      return value ? [value] : [];
    })
    .filter(Boolean);

  const firstBeneficiary = excursionBeneficiary ?? beneficiaries[0] ?? null;
  const pax = paxFromCompact ?? (beneficiaries.length > 0 ? beneficiaries.length : null);

  const outwardDateLine = lines.find((line) => /^Dal\s+[0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\d{2,4}$/i.test(line));
  const outwardBusLine = lines.find((line) => /^001BUS\s+DA/i.test(line));
  const returnBusLine = lines.find((line) => /^001BUS\s+ISCHIA/i.test(line));
  const returnDateLine =
    returnBusLine
      ? [...lines]
          .slice(0, lines.indexOf(returnBusLine))
          .reverse()
          .find((line) => /^Dal\s+[0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\d{2,4}$/i.test(line))
      : null;

  const outwardOriginMatch = outwardBusLine?.match(/^001BUS\s+DA\s+([A-Z' ]+?)\s+([0-2]?\d[.:]\d{2})/i);
  const returnDestinationMatch = returnBusLine?.match(/^001BUS\s+ISCHIA\s*-\s*([A-Z' ]+?)\s+RITORNO/i);

  const totalAmountMatches = Array.from(compact.matchAll(/TOTALE\s*EUR\s*([0-9]+,[0-9]{2})/gi))
    .map((match) => parseEuroAmount(match[1]))
    .filter((value): value is number => value !== null);
  const totalAmount = totalAmountMatches.length > 0 ? Number(totalAmountMatches.reduce((sum, value) => sum + value, 0).toFixed(2)) : null;

  const parsedServices: ParsedTransferService[] = [];

  if (excursionTitle && excursionDate) {
    parsedServices.push({
      practice_number: practiceNumber,
      beneficiary: firstBeneficiary,
      pax,
      service_type: "transfer",
      direction: "andata",
      service_date: excursionDate,
      service_time: null,
      pickup_meeting_point: null,
      origin: null,
      destination: "ISCHIA",
      carrier_company: "BUS",
      hotel_structure: null,
      original_row_description: excursionTitle,
      raw_detail_text: `${excursionTitle} del ${excursionDate}`,
      parsing_status: "parsed",
      confidence_level: "medium",
      semantic_tag: "transfer_arrival"
    });
  }

  if (parsedServices.length === 0 && outwardDateLine && outwardOriginMatch?.[1]) {
    parsedServices.push({
      practice_number: practiceNumber,
      beneficiary: firstBeneficiary,
      pax,
      service_type: "transfer",
      direction: "andata",
      service_date: parseItalianDate(outwardDateLine.match(/^Dal\s+(.+)$/i)?.[1]),
      service_time: normalizeTime(outwardOriginMatch[2]),
      pickup_meeting_point: clean(outwardOriginMatch[1]),
      origin: clean(outwardOriginMatch[1]),
      destination: "ISCHIA",
      carrier_company: "BUS",
      hotel_structure: null,
      original_row_description: `BUS DA ${clean(outwardOriginMatch[1]) ?? "CITTA"} ${normalizeTime(outwardOriginMatch[2]) ?? ""}`.trim(),
      raw_detail_text: `Bus andata da ${clean(outwardOriginMatch[1]) ?? "CITTA"} alle ${normalizeTime(outwardOriginMatch[2]) ?? "N/D"} verso Ischia`,
      parsing_status: "parsed",
      confidence_level: "high",
      semantic_tag: "transfer_arrival"
    });
  }

  if (parsedServices.length > 0 && !excursionTitle && returnDateLine && returnDestinationMatch?.[1]) {
    parsedServices.push({
      practice_number: practiceNumber,
      beneficiary: firstBeneficiary,
      pax,
      service_type: "transfer",
      direction: "ritorno",
      service_date: parseItalianDate(returnDateLine.match(/^Dal\s+(.+)$/i)?.[1]),
      service_time: null,
      pickup_meeting_point: "ISCHIA",
      origin: "ISCHIA",
      destination: clean(returnDestinationMatch[1]),
      carrier_company: "BUS",
      hotel_structure: null,
      original_row_description: `BUS ISCHIA - ${clean(returnDestinationMatch[1]) ?? "CITTA"} RITORNO`,
      raw_detail_text: `Bus ritorno da Ischia verso ${clean(returnDestinationMatch[1]) ?? "CITTA"}`,
      parsing_status: "parsed",
      confidence_level: "medium",
      semantic_tag: "transfer_departure"
    });
  }

  return {
    practice_number: practiceNumber,
    practice_date: practiceDate,
    first_beneficiary: firstBeneficiary,
    customer_full_name: firstBeneficiary,
    ns_reference: reference,
    ns_contact: null,
    pax,
    program: excursionTitle ?? "BUS",
    package_description: "ELENCO RICHIESTE CONFERME ANNULLAMENTI SERVIZI",
    date_from: parsedServices.find((item) => item.direction === "andata")?.service_date ?? excursionDate ?? null,
    date_to: parsedServices.find((item) => item.direction === "ritorno")?.service_date ?? null,
    total_amount_practice: totalAmount,
    booking_kind: excursionTitle ? "excursion" : "bus_city_hotel",
    service_type_code: excursionTitle ? "excursion" : "bus_line",
    service_rows: parsedServices.map((service) => ({
      row_text: service.original_row_description ?? service.raw_detail_text,
      semantic_tag: service.semantic_tag,
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
    parsing_status: parsedServices.length > 0 ? "parsed" : "needs_review",
    confidence_level: parsedServices.length === 2 ? "high" : parsedServices.length > 0 ? "medium" : "low",
    anomaly_message: parsedServices.length > 0 ? null : "Nessun servizio bus operativo riconosciuto."
  };
}

export const agencyBusOperationsPdfParser: AgencyPdfParserImplementation = {
  key: "agency_bus_operations",
  mode: "dedicated",
  label: "Bus Operations List",
  senderDomains: [],
  subjectHints: ["conferme annullamenti servizi", "bus da", "bus ischia"],
  contentHints: ["001bus da", "001bus ischia", "foligno stazione fs", "linea umbria"],
  agencyNameHints: [],
  voucherHints: ["001bus da", "001bus ischia", "foligno stazione fs"],
  parse: parseBusOperationsPdfText,
  match: (input) =>
    buildParserMatch(input, {
      senderDomains: [],
      subjectHints: ["conferme annullamenti servizi", "bus da", "bus ischia"],
      contentHints: ["001bus da", "001bus ischia", "foligno stazione fs", "linea umbria"],
      agencyNameHints: [],
      voucherHints: ["001bus da", "001bus ischia", "foligno stazione fs"]
    })
};
