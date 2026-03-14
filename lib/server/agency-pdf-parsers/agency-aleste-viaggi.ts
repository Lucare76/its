import { parseTransferBookingPdfText, type ParsedTransferPdfPayload } from "@/lib/server/transfer-pdf-parser";
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

type ExtractedTrainJourney = {
  originStation: string | null;
  originTime: string | null;
  serviceDate: string | null;
  carrierCompany: string | null;
  trainNumber: string | null;
  destinationStation: string | null;
  destinationTime: string | null;
};

const CUSTOMER_STOPWORDS = ["PACCHETTO", "TRANSFER", "SERVIZIO", "PROGRAMMA", "STAFF", "CLIENTE", "ISCHIA"];

function clean(value?: string | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function sanitizeCustomerFullName(value?: string | null) {
  const normalized = clean(value)?.toUpperCase() ?? null;
  if (!normalized) return null;
  const gluedStopwordMatch = normalized.match(/^(.*?)(PACCHETTO|TRANSFER|SERVIZIO|PROGRAMMA|ISCHIA|STAFF|CLIENTE).*$/i);
  const prepared = clean(gluedStopwordMatch?.[1] ?? normalized)?.toUpperCase() ?? null;
  if (!prepared) return null;
  const parts = prepared.split(/\s+/).filter(Boolean);
  const safeParts: string[] = [];
  for (const part of parts) {
    if (CUSTOMER_STOPWORDS.includes(part)) break;
    safeParts.push(part);
  }
  const joined = safeParts.join(" ");
  return clean(joined);
}

function splitItalianCustomerName(value?: string | null) {
  const fullName = sanitizeCustomerFullName(value);
  if (!fullName) {
    return { fullName: null, firstName: null, lastName: null };
  }
  const parts = fullName.split(" ").filter(Boolean);
  if (parts.length === 1) {
    return { fullName, firstName: parts[0], lastName: null };
  }
  return {
    fullName,
    firstName: parts.slice(1).join(" "),
    lastName: parts[0] ?? null
  };
}

function parseItalianDate(raw?: string | null) {
  if (!raw) return null;
  const match = raw.match(/([0-3]?\d)-(gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-(\d{2,4})/i);
  if (!match) return null;
  const day = match[1].padStart(2, "0");
  const month = IT_MONTHS[match[2].toLowerCase()];
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return month ? `${year}-${month}-${day}` : null;
}

function normalizeTime(raw?: string | null) {
  const match = String(raw ?? "").match(/([01]?\d|2[0-3])[:.]([0-5]\d)/);
  if (!match) return null;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function normalizeStationName(value?: string | null) {
  const normalized = clean(value)?.toUpperCase() ?? null;
  if (!normalized) return null;
  if (/NAPOLI(?:\s+CENTRALE|\s+STAZIONE)?/.test(normalized)) return "STAZIONE DI NAPOLI";
  return normalized;
}

function extractHotel(sourceText: string) {
  const fromDestination = clean(
    sourceText.match(/dest:\s*([A-Z][A-Z &'./-]+?)(?=\s+Cliente:|\s+Cellulare|\s+Cell\.|\n|\r|$)/i)?.[1]
  );
  if (fromDestination) return fromDestination;

  const fromProgram =
    clean(sourceText.match(/PROGRAMMA.*?([A-Z][A-Z &'./-]+HOTEL[^0-9\n\r]*)/i)?.[1]) ??
    clean(sourceText.match(/PROGRAMMA.*?([A-Z][A-Z &'./-]+SPA)/i)?.[1]);

  if (!fromProgram) return null;
  return clean(fromProgram.replace(/\bHOTEL.*$/i, "").trim()) ?? fromProgram;
}

function extractCustomerPhone(sourceText: string) {
  return clean(
    sourceText.match(/(?:Cellulare\/Tel\.?|Cellulare:?|CELL:|Cell\.?|Tel\.?)\s*([+\d][\d\s./-]{7,})/i)?.[1]
  );
}

function extractTrainJourneyFromSchedule(sourceText: string, rowNumber: "1" | "2"): ExtractedTrainJourney | null {
  const lines = sourceText
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = 0; index < lines.length - 1; index += 1) {
    const firstLine = lines[index] ?? "";
    const secondLine = lines[index + 1] ?? "";
    const firstMatch = firstLine.match(
      new RegExp(
        `^${rowNumber}\\s*([A-ZÀ-ÖØ-Ý0-9.' ]+?)\\s*([0-2]?\\d:\\d{2})\\s*([0-3]?\\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:-\\d{2,4})?)\\s*ITALO(?:ITA)?\\s*(\\d{4})\\b`,
        "i"
      )
    );
    const secondMatch = secondLine.match(
      /^([A-ZÀ-ÖØ-Ý.' ]+?)\s*([0-2]?\d:\d{2})\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:-\d{2,4})?)$/i
    );

    if (!firstMatch || !secondMatch) continue;

    return {
      originStation: clean(firstMatch[1]),
      originTime: normalizeTime(firstMatch[2]),
      serviceDate: parseItalianDate(firstMatch[3]),
      carrierCompany: "ITALO",
      trainNumber: clean(firstMatch[4]),
      destinationStation: clean(secondMatch[1]),
      destinationTime: normalizeTime(secondMatch[2])
    };
  }

  return null;
}

function extractTrainJourneyFromOperationalBlock(sourceText: string, rowNumber: "1" | "2"): ExtractedTrainJourney | null {
  const blockMatch = sourceText.match(
    new RegExp(
      `Il\\s*([0-3]?\\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\\d{2,4})\\s+${rowNumber}\\s+TRANSFER\\s+(?:STAZIONE\\s*\\/\\s*HOTEL|HOTEL\\s*\\/\\s*STAZIONE)[\\s\\S]{0,180}?Dalle\\s*([0-2]?\\d:\\d{2})(?:Alle\\s*([0-2]?\\d:\\d{2}))?[\\s\\S]{0,140}?M\\.p\\.:\\s*([^\\n\\r]+?)\\s+da:\\s*([A-Z]+(?:\\s+[A-Z]+)*)\\s*(\\d{3,5})[\\s\\S]{0,140}?a:\\s*([^\\n\\r]+?)(?:\\s+dest:|\\s+Cliente:|\\s+Cellulare|\\n|\\r|$)[\\s\\S]{0,140}?(?:dest:\\s*([A-Z][A-Z &'./-]+?)(?=\\s+Cliente:|\\s+Cellulare|\\n|\\r|$))?`,
      "i"
    )
  );

  if (!blockMatch) return null;

  const meetingPoint = normalizeStationName(blockMatch[4]) ?? clean(blockMatch[4]);
  const carrierCompany = clean(blockMatch[5])?.toUpperCase() ?? null;
  const arrivalStation = normalizeStationName(blockMatch[7]) ?? clean(blockMatch[7]);

  return {
    originStation: rowNumber === "2" ? arrivalStation : meetingPoint,
    originTime: normalizeTime(blockMatch[2]),
    serviceDate: parseItalianDate(blockMatch[1]),
    carrierCompany,
    trainNumber: clean(blockMatch[6]),
    destinationStation: rowNumber === "1" ? arrivalStation : clean(blockMatch[8]),
    destinationTime: normalizeTime(blockMatch[3])
  };
}

function extractTrainJourney(sourceText: string, rowNumber: "1" | "2") {
  return extractTrainJourneyFromOperationalBlock(sourceText, rowNumber) ?? extractTrainJourneyFromSchedule(sourceText, rowNumber);
}

function parseAlesteViaggiPdfText(sourceText: string): ParsedTransferPdfPayload {
  const parsed = parseTransferBookingPdfText(sourceText);
  const compact = sourceText.replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  const practiceHead = compact.match(
    /(\d{2}\/\d{6})\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\d{2,4})\s*([A-ZÀ-ÖØ-Ý' ]{6,}?)\s*(STAFF\s+[A-Z ]+)\s*(\d{1,2})(?=\s*PROGRAMMA)/i
  );

  if (!practiceHead) {
    return parsed;
  }

  const customer = splitItalianCustomerName(practiceHead[3]);
  const exactBeneficiary = customer.fullName;
  const exactReference = clean(practiceHead[4]);
  const exactPax = practiceHead[5] ? Number(practiceHead[5]) : null;
  const hotel = extractHotel(sourceText);
  const customerPhone = extractCustomerPhone(sourceText);
  const arrivalTrain = extractTrainJourney(sourceText, "1");
  const departureTrain = extractTrainJourney(sourceText, "2");
  const hasMarineAutoTransfer =
    /AUTO\s*ISCHIA\s*\/\s*HOTEL|AUTO\s*HOTEL\s*\/\s*ISCHIA|ALISCAFO\s+DA\s+NAPOLI|ALISCAFO\s+PER\s+NAPOLI|CON\s+SNAV/i.test(sourceText);

  const parsedServices = parsed.parsed_services.map((service) => ({
    ...service,
    beneficiary: exactBeneficiary ?? service.beneficiary,
    pax: exactPax ?? service.pax,
    confidence_level: "high" as const
  }));

  if (arrivalTrain && hotel) {
    const arrivalIndex = parsedServices.findIndex((service) => service.direction === "andata");
    const arrivalStation = normalizeStationName(arrivalTrain.destinationStation) ?? "STAZIONE DI NAPOLI";
    const arrivalService = {
      practice_number: parsed.practice_number,
      beneficiary: exactBeneficiary ?? parsed.first_beneficiary,
      pax: exactPax ?? parsed.pax,
      service_type: "transfer" as const,
      direction: "andata" as const,
      service_date: arrivalTrain.serviceDate ?? parsed.date_from,
      service_time: arrivalTrain.destinationTime ?? parsedServices[arrivalIndex]?.service_time ?? null,
      pickup_meeting_point: arrivalStation,
      origin: arrivalStation,
      destination: hotel,
      carrier_company: arrivalTrain.carrierCompany ?? "ITALO",
      hotel_structure: hotel,
      original_row_description: "TRANSFER STAZIONE / HOTEL",
      raw_detail_text: `Arrivo ${arrivalTrain.carrierCompany ?? "treno"} ${arrivalTrain.trainNumber ?? ""} a ${arrivalStation} alle ${arrivalTrain.destinationTime ?? "N/D"} - hotel ${hotel}`.trim(),
      parsing_status: "parsed" as const,
      confidence_level: "high" as const,
      semantic_tag: "transfer_arrival" as const
    };
    if (arrivalIndex >= 0) {
      parsedServices[arrivalIndex] = arrivalService;
    } else {
      parsedServices.push(arrivalService);
    }
  }

  if (departureTrain && hotel) {
    const departureIndex = parsedServices.findIndex((service) => service.direction === "ritorno");
    const departureStation = normalizeStationName(departureTrain.originStation) ?? "STAZIONE DI NAPOLI";
    const departureService = {
      practice_number: parsed.practice_number,
      beneficiary: exactBeneficiary ?? parsed.first_beneficiary,
      pax: exactPax ?? parsed.pax,
      service_type: "transfer" as const,
      direction: "ritorno" as const,
      service_date: departureTrain.serviceDate ?? parsed.date_to,
      service_time: departureTrain.originTime ?? parsedServices[departureIndex]?.service_time ?? null,
      pickup_meeting_point: hotel,
      origin: hotel,
      destination: departureStation,
      carrier_company: departureTrain.carrierCompany ?? "ITALO",
      hotel_structure: hotel,
      original_row_description: "TRANSFER HOTEL/STAZIONE",
      raw_detail_text: `Partenza ${departureTrain.carrierCompany ?? "treno"} ${departureTrain.trainNumber ?? ""} da ${departureStation} alle ${departureTrain.originTime ?? "N/D"} - pickup hotel ${hotel}`.trim(),
      parsing_status: "parsed" as const,
      confidence_level: "high" as const,
      semantic_tag: "transfer_departure" as const
    };
    if (departureIndex >= 0) {
      parsedServices[departureIndex] = departureService;
    } else {
      parsedServices.push(departureService);
    }
  }

  return {
    ...parsed,
    first_beneficiary: exactBeneficiary ?? parsed.first_beneficiary,
    customer_first_name: customer.firstName,
    customer_last_name: customer.lastName,
    customer_full_name: customer.fullName,
    ns_reference: exactReference ?? parsed.ns_reference,
    ns_contact: customerPhone ?? parsed.ns_contact,
    pax: exactPax ?? parsed.pax,
    service_type_code: hasMarineAutoTransfer ? "transfer_port_hotel" : "transfer_station_hotel",
    train_arrival_number: arrivalTrain?.trainNumber ? `${arrivalTrain.carrierCompany ?? "ITALO"} ${arrivalTrain.trainNumber}` : null,
    train_arrival_time: arrivalTrain?.destinationTime ?? null,
    train_departure_number: departureTrain?.trainNumber ? `${departureTrain.carrierCompany ?? "ITALO"} ${departureTrain.trainNumber}` : null,
    train_departure_time: departureTrain?.originTime ?? null,
    parsed_services: parsedServices,
    confidence_level: "high"
  };
}

export const agencyAlesteViaggiPdfParser: AgencyPdfParserImplementation = {
  key: "agency_aleste_viaggi",
  mode: "dedicated",
  label: "Aleste Viaggi",
  senderDomains: ["aleste-viaggi.it", "alesteviaggi.it"],
  subjectHints: ["aleste", "booking aleste"],
  contentHints: ["staff aleste", "ufficio booking - aleste viaggi", "aleste viaggi"],
  agencyNameHints: ["aleste viaggi", "ufficio booking - aleste viaggi"],
  voucherHints: ["staff aleste", "pacchetto transfer", "conferma d ordine"],
  parse: parseAlesteViaggiPdfText,
  match: (input) =>
    buildParserMatch(input, {
      senderDomains: ["aleste-viaggi.it", "alesteviaggi.it"],
      subjectHints: ["aleste", "booking aleste"],
      contentHints: ["staff aleste", "ufficio booking - aleste viaggi", "aleste viaggi"],
      agencyNameHints: ["aleste viaggi", "ufficio booking - aleste viaggi"],
      voucherHints: ["staff aleste", "pacchetto transfer", "conferma d ordine"]
    })
};
