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

type ExtractedBusJourney = {
  serviceDate: string | null;
  serviceTime: string | null;
  meetingPoint: string | null;
  origin: string | null;
  destination: string | null;
  rawDetailText: string;
  direction: "andata" | "ritorno";
};

type ExtractedMarineJourney = {
  serviceDate: string | null;
  serviceTime: string | null;
  meetingPoint: string | null;
  origin: string | null;
  destination: string | null;
  hotel: string | null;
  rawDetailText: string;
  direction: "andata" | "ritorno";
};

type ExtractedFlixbusJourney = {
  serviceDate: string | null;
  serviceTime: string | null;
  arrivalTime: string | null;
  meetingPoint: string | null;
  transportReference: string | null;
  destination: string | null;
  rawDetailText: string;
  direction: "andata" | "ritorno";
};

type ExtractedAirportJourney = {
  serviceDate: string | null;
  serviceTime: string | null;
  meetingPoint: string | null;
  transportReference: string | null;
  destination: string | null;
  rawDetailText: string;
  direction: "andata" | "ritorno";
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

function parseItalianShortDate(raw?: string | null, fallbackYear?: string | null) {
  if (!raw || !fallbackYear) return null;
  const match = raw.match(/([0-3]?\d)-(gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)\b/i);
  if (!match) return null;
  const day = match[1].padStart(2, "0");
  const month = IT_MONTHS[match[2].toLowerCase()];
  if (!month) return null;
  return `${fallbackYear}-${month}-${day}`;
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
  const fromDescription = clean(
    sourceText.match(
      /DESCRIZIONE\s*(?:AV\s+)?([A-Z][A-Z &'./-]+?(?:HOTEL(?:\s*&\s*THERMAL\s*SPA)?|THERMAL SPA|SPA))(?=\s*(?:ns\s*ri?\s*ferimento|IMPORTO|NS\s+REFERENTE|DAL\b|[0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)|$))/i
    )?.[1]
  );
  if (fromDescription) return fromDescription;

  const fromCompactDescription = clean(
    sourceText.match(/\bAV\s+([A-Z][A-Z &'./-]+?(?:HOTEL(?:\s*&\s*THERMAL\s*SPA)?|THERMAL SPA|SPA))(?=\s*[0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)|$)/i)?.[1]
  );
  if (fromCompactDescription) return fromCompactDescription;

  const fromProgramRow = clean(
    sourceText.match(/PROGRAMMA(?:DESCRIZIONE)?(?:DALAL)?\s*[A-Z0-9/]+\s*(?:AV\s+)?([A-Z][A-Z &'./-]+?(?:HOTEL(?:\s*&\s*THERMAL\s*SPA)?|THERMAL SPA|SPA))(?=\s*[0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)|$)/i)?.[1]
  );
  if (fromProgramRow) return fromProgramRow;

  const fromAlesteProgramRow = clean(
    sourceText.match(
      /PROGRAMMA(?:DESCRIZIONE)?(?:DALAL)?\s*[A-Z0-9/]+\s*([A-Z][A-Z &'./-]+?)(?=\s*[0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\d{2,4}\s*[0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\d{2,4})/i
    )?.[1]
  );
  if (fromAlesteProgramRow && !/PACCHETTO\s+TRANSFER/i.test(fromAlesteProgramRow)) {
    return clean(fromAlesteProgramRow.replace(/^AV\s+CLUB\s+/i, ""));
  }

  const fromDestination = clean(
    sourceText.match(/dest:\s*([A-Z][A-Z &'./-]+?)(?=\s+Il[0-3]?\d-\w{3}-\d{2,4}|\s+Cliente:|\s+Cellulare|\s+Cell\.|\n|\r|$)/i)?.[1]
  );
  if (fromDestination) return fromDestination;

  const fromProgram =
    clean(sourceText.match(/PROGRAMMA.*?([A-Z][A-Z &'./-]+HOTEL[^0-9\n\r]*)/i)?.[1]) ??
    clean(sourceText.match(/PROGRAMMA.*?([A-Z][A-Z &'./-]+SPA)/i)?.[1]);

  if (!fromProgram) return null;
  return fromProgram;
}

function extractCustomerPhone(sourceText: string) {
  const raw = clean(
    sourceText.match(/(?:Cellulare\/Tel\.?|Cellulare:?|CELL:|Cell\.?|Tel\.?)\s*([+\d][\d\s./-]{7,})/i)?.[1]
  );
  if (!raw) return null;
  return clean(raw.replace(/[-–—]{3,}.*$/u, ""));
}

function extractAlesteTrainOperationalJourney(
  sourceText: string,
  direction: "andata" | "ritorno",
  fallbackYear?: string | null
): ExtractedTrainJourney | null {
  const compact = sourceText.replace(/\s+/g, " ").trim();

  if (direction === "andata") {
    const match = compact.match(
      /Il\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:-\d{2,4})?)\s+\d+\s+TRANSFER\s+STAZIONE\s*\/\s*HOTEL\s+Dalle\s*([0-2]?\d[:.]\d{2})(?:\s+Alle\s*([0-2]?\d[:.]\d{2}))?\s+M\.p\.\s*:\s*([A-Z][A-Z ]+?)\s+da:\s*([A-Z]+)\s*(\d{3,5})\s+a:\s*CELL[.:]?\s*\d+\s+dest:\s*([A-Z][A-Z &'./-]+?)(?=\s+Cliente:|\s+Cellulare|\s+Il\s*[0-3]?\d-\w{3}-\d{2,4}|$)/i
    );
    if (!match) return null;

    return {
      originStation: clean(match[4]),
      originTime: normalizeTime(match[2]),
      serviceDate: parseItalianDate(match[1]) ?? parseItalianShortDate(match[1], fallbackYear),
      carrierCompany: clean(match[5])?.toUpperCase() ?? null,
      trainNumber: clean(match[6]),
      destinationStation: "STAZIONE DI NAPOLI",
      destinationTime: normalizeTime(match[3])
    };
  }

  const match = compact.match(
    /Il\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:-\d{2,4})?)\s+\d+\s+TRANSFER\s+HOTEL(?:\s+ISCHIA)?\s*\/\s*STAZIONE\s+Dalle\s*([0-2]?\d[:.]\d{2})\s+M\.p\.\s*:\s*([A-Z][A-Z &'./-]+?)\s+da:\s*([A-Z]+)\s*(\d{3,5})(?:\s+a:\s*(NAPOLI(?:\s+STAZIONE|\s+CENTRALE)?)|\s+dest:\s*(STAZIONE\s+DI\s+NAPOLI|NAPOLI(?:\s+STAZIONE|\s+CENTRALE)?))/i
  );
  if (!match) return null;

  return {
    originStation: "STAZIONE DI NAPOLI",
    originTime: normalizeTime(match[2]),
    serviceDate: parseItalianDate(match[1]) ?? parseItalianShortDate(match[1], fallbackYear),
    carrierCompany: clean(match[4])?.toUpperCase() ?? null,
    trainNumber: clean(match[5]),
    destinationStation: normalizeStationName(match[6] ?? match[7]) ?? clean(match[6] ?? match[7]),
    destinationTime: null
  };
}

function extractTrainJourneyFromSchedule(sourceText: string, rowNumber: "1" | "2", fallbackYear?: string | null): ExtractedTrainJourney | null {
  const compactSource = sourceText.replace(/\s+/g, " ").trim();
  const compactMatch = compactSource.match(
    new RegExp(
      `${rowNumber}\\s+([A-ZÀ-ÖØ-Ý0-9.' ]+?)\\s*([0-2]?\\d:\\d{2})\\s*([0-3]?\\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:-\\d{2,4})?)\\s*ITALO(?:ITA)?\\s*(\\d{4})\\s*([A-ZÀ-ÖØ-Ý0-9.' ]+?)\\s*([0-2]?\\d:\\d{2})\\s*([0-3]?\\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:-\\d{2,4})?)`,
      "i"
    )
  );

  if (compactMatch) {
    return {
      originStation: clean(compactMatch[1]),
      originTime: normalizeTime(compactMatch[2]),
      serviceDate: parseItalianDate(compactMatch[3]) ?? parseItalianShortDate(compactMatch[3], fallbackYear),
      carrierCompany: "ITALO",
      trainNumber: clean(compactMatch[4]),
      destinationStation: clean(compactMatch[5]),
      destinationTime: normalizeTime(compactMatch[6])
    };
  }

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
      serviceDate: parseItalianDate(firstMatch[3]) ?? parseItalianShortDate(firstMatch[3], fallbackYear),
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

function extractTrainJourney(sourceText: string, rowNumber: "1" | "2", fallbackYear?: string | null) {
  return extractTrainJourneyFromSchedule(sourceText, rowNumber, fallbackYear) ?? extractTrainJourneyFromOperationalBlock(sourceText, rowNumber);
}

function extractAlesteBusJourney(sourceText: string, direction: "andata" | "ritorno", fallbackYear?: string | null): ExtractedBusJourney | null {
  const compact = sourceText.replace(/\s+/g, " ").trim();

  if (direction === "andata") {
    const outwardMatch = compact.match(
      /Il\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:-\d{2,4})?)\s+\d+\s+BUS\s+DA\s+BOLOGNA\s+PARTENZA\s+ORE\s*([0-2]?\d[:.]\d{2})[\s\S]{0,240}?Meeting point:\s*(.+?)\s+da:\s*BOLOGNA\s+a:\s*CELL\.?\s+dest:\s*HOTEL(?=\s+Cliente:|\s+Cellulare|\s+L['’]ORARIO|\s+Il\s*[0-3]?\d-|$)/i
    );
    if (!outwardMatch) return null;

    return {
      serviceDate: parseItalianDate(outwardMatch[1]) ?? parseItalianShortDate(outwardMatch[1], fallbackYear),
      serviceTime: normalizeTime(outwardMatch[2]),
      meetingPoint: clean(outwardMatch[3]),
      origin: "BOLOGNA",
      destination: "HOTEL ISCHIA",
      rawDetailText: clean(outwardMatch[0]) ?? "",
      direction
    };
  }

  const returnMatch = compact.match(
    /Il\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:-\d{2,4})?)\s+\d+\s+BUS\s+DA\s+HOTEL\s+ISCHIA\s+PICK-UP\s+ORE\s*([0-2]?\d[:.]\d{1,2})[\s\S]{0,240}?Meeting point:\s*DA HOTEL ISCHIA(?:\s+M\.p\.\s*:\s*TRAGHETTO\s*[0-2]?\d[:.]\d{2})?\s+da:\s*HOTEL\s+a:\s*PORTO\s+dest:\s*(.+?)(?=\s+L['’]ORARIO|\s+La caparra|\s+Cliente:|$)/i
  );
  if (!returnMatch) return null;

  return {
    serviceDate: parseItalianDate(returnMatch[1]) ?? parseItalianShortDate(returnMatch[1], fallbackYear),
    serviceTime: normalizeTime(returnMatch[2]),
    meetingPoint: "DA HOTEL ISCHIA",
    origin: "HOTEL ISCHIA",
    destination: clean(returnMatch[3]),
    rawDetailText: clean(returnMatch[0]) ?? "",
    direction
  };
}

function extractAlesteMarineJourney(
  sourceText: string,
  direction: "andata" | "ritorno",
  fallbackYear?: string | null
): ExtractedMarineJourney | null {
  const compact = sourceText.replace(/\s+/g, " ").trim();

  if (direction === "andata") {
    const outwardMatch =
      compact.match(
      /Il\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:-\d{2,4})?)\s+\d+\s+TRAGHETTO\s+POZZUOLI\s*\+\s*TRS\s+H\.?\s*ISCHIA\s*([0-2]?\d[:.]\d{2})[\s\S]{0,220}?M\.p\.\s*:\s*(PORTO DI POZZUOLI)\s+da:\s*(POZZUOLI CON MEDMAR)\s+a:\s*(?:CELL[:.]?\s*\d*|HOTEL)\s*dest:\s*([A-Z][A-Z &'./-]+?)(?=\s+Il\s*[0-3]?\d-\w{3}-\d{2,4}|\s+Il[0-3]?\d-\w{3}-\d{2,4}|\s+Cliente:|\s+Cellulare|$)/i
      ) ??
      compact.match(
        /Il\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:-\d{2,4})?)\s+\d+\s+AL\s*ISCAFO\s+DA\s+NAPOLI\s*\+\s*TRS\s+H\.?\s*ISCHIA\s*([0-2]?\d[:.]\d{2})[\s\S]{0,220}?M\.p\.\s*:\s*(PORTO\s+NAPOLI)\s+da:\s*(NAPOLI\s+CON\s+SNAV)\s+a:\s*CELL[:.]?\s*\d*\s*dest:\s*([A-Z][A-Z &'./-]+?)(?=\s+Il\s*[0-3]?\d-\w{3}-\d{2,4}|\s+Il[0-3]?\d-\w{3}-\d{2,4}|\s+Cliente:|\s+Cellulare|$)/i
      );
    if (!outwardMatch) return null;

    const hotel = clean(outwardMatch[5] ?? outwardMatch[4]);
    const origin =
      /POZZUOLI/i.test(outwardMatch[3] ?? "") ? "PORTO DI POZZUOLI" : clean(outwardMatch[3]) ?? "PORTO NAPOLI";
    return {
      serviceDate: parseItalianDate(outwardMatch[1]) ?? parseItalianShortDate(outwardMatch[1], fallbackYear),
      serviceTime: normalizeTime(outwardMatch[2]),
      meetingPoint: clean(outwardMatch[3]),
      origin,
      destination: hotel,
      hotel,
      rawDetailText: clean(outwardMatch[0]) ?? "",
      direction
    };
  }

  const returnMatch =
    compact.match(
      /Il\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:-\d{2,4})?)\s+\d+\s+TRS\s+H\.?\s*ISCHIA\s*\+\s*TRAGHETTO\s+POZZUOLI\s*([0-2]?\d[:.]\d{2})[\s\S]{0,220}?M\.p\.\s*:\s*([A-Z][A-Z &'./-]+?)\s+da:\s*HOTEL\s+a:\s*(PORTO PER POZZUOLI CON MEDMAR)\s+dest:\s*(PORTO DI POZZUOLI)/i
    ) ??
    compact.match(
      /Il\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:-\d{2,4})?)\s+\d+\s+TRS\s+H\.?\s*ISCHIA\s*\+\s*AL\s*ISCAFO\s+PER\s+NAPOLI\s*([0-2]?\d[:.]\d{2})[\s\S]{0,220}?M\.p\.\s*:\s*([A-Z][A-Z &'./-]+?)\s+da:\s*(ISCHIA)\s+a:\s*(SNAV)\s+dest:\s*(PORTO\s+NAPOLI)/i
    );
  if (!returnMatch) return null;

  const meetingPoint = clean(returnMatch[3]);
  const isSnavJourney = /SNAV/i.test(returnMatch[5] ?? "");
  const destination =
    /POZZUOLI/i.test(returnMatch[5] ?? returnMatch[4] ?? "") ? "PORTO DI POZZUOLI" : clean(isSnavJourney ? returnMatch[6] : returnMatch[5]) ?? "PORTO NAPOLI";
  return {
    serviceDate: parseItalianDate(returnMatch[1]) ?? parseItalianShortDate(returnMatch[1], fallbackYear),
    serviceTime: normalizeTime(returnMatch[2]),
    meetingPoint,
    origin: meetingPoint ?? "HOTEL ISCHIA",
    destination,
    hotel: null,
    rawDetailText: clean(returnMatch[0]) ?? "",
    direction
  };
}

function extractAlesteFlixbusJourney(
  sourceText: string,
  direction: "andata" | "ritorno",
  fallbackYear?: string | null
): ExtractedFlixbusJourney | null {
  const compact = sourceText.replace(/\s+/g, " ").trim();

  if (direction === "andata") {
    const outwardMatch = compact.match(
      /Il\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:-\d{2,4})?)\s+\d+\s+TRANSFER\s+STAZIONE\s*\/\s*HOTEL\s+Dalle\s*([0-2]?\d[:.]\d{2})(?:\s+Alle\s*([0-2]?\d[:.]\d{2}))?\s+M\.p\.\s*:\s*([A-Z][A-Z ]+?)\s+da:\s*(FLIXBUS\s+\d+)\s+a:\s*CELL:?\d+\s+dest:\s*([A-Z][A-Z &'./-]+?)(?=\s+Cliente:|\s+Cellulare|\s+Il\s*[0-3]?\d-\w{3}-\d{2,4}|$)/i
    );
    if (!outwardMatch) return null;
    return {
      serviceDate: parseItalianDate(outwardMatch[1]) ?? parseItalianShortDate(outwardMatch[1], fallbackYear),
      serviceTime: normalizeTime(outwardMatch[3] ?? outwardMatch[2]),
      arrivalTime: normalizeTime(outwardMatch[3]),
      meetingPoint: clean(outwardMatch[4]),
      transportReference: clean(outwardMatch[5]),
      destination: clean(outwardMatch[6]),
      rawDetailText: clean(outwardMatch[0]) ?? "",
      direction
    };
  }

  const returnMatch = compact.match(
    /Il\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:-\d{2,4})?)\s+\d+\s+TRANSFER\s+HOTEL\s*\/\s*STAZIONE\s+Dalle\s*([0-2]?\d[:.]\d{2})\s+M\.p\.\s*:\s*([A-Z][A-Z &'./-]+?)\s+da:\s*(FLIXBUS\s+\d+)\s+a:\s*([A-Z][A-Z ]+?)(?=\s+La caparra|\s+Cliente:|\s+Il\s*[0-3]?\d-\w{3}-\d{2,4}|$)/i
  );
  if (!returnMatch) return null;
  return {
    serviceDate: parseItalianDate(returnMatch[1]) ?? parseItalianShortDate(returnMatch[1], fallbackYear),
    serviceTime: normalizeTime(returnMatch[2]),
    arrivalTime: null,
    meetingPoint: clean(returnMatch[3]),
    transportReference: clean(returnMatch[4]),
    destination: clean(returnMatch[5]),
    rawDetailText: clean(returnMatch[0]) ?? "",
    direction
  };
}

function extractAlesteAirportJourney(
  sourceText: string,
  direction: "andata" | "ritorno",
  fallbackYear?: string | null
): ExtractedAirportJourney | null {
  const compact = sourceText.replace(/\s+/g, " ").trim();

  if (direction === "andata") {
    const outwardMatch = compact.match(
      /Il\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:-\d{2,4})?)\s+\d+\s+TRANSFER\s+AEROPORTO\s*\/\s*HOTEL\s+Alle\s*([0-2]?\d[:.]\d{2})\s+M\.p\.\s*:\s*(AEROPORTO)\s+da:\s*([A-Z0-9 ]+?)\s+a:\s*CELL\.?\s*\d+\s+dest:\s*([A-Z][A-Z &'./-]+?)(?=\s+Cliente:|\s+Cellulare|\s+Il\s*[0-3]?\d-\w{3}-\d{2,4}|$)/i
    );
    if (!outwardMatch) return null;
    return {
      serviceDate: parseItalianDate(outwardMatch[1]) ?? parseItalianShortDate(outwardMatch[1], fallbackYear),
      serviceTime: normalizeTime(outwardMatch[2]),
      meetingPoint: clean(outwardMatch[3]),
      transportReference: clean(outwardMatch[4]),
      destination: clean(outwardMatch[5]),
      rawDetailText: clean(outwardMatch[0]) ?? "",
      direction
    };
  }

  const returnMatch = compact.match(
    /Il\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)(?:-\d{2,4})?)\s+\d+\s+TRANSFER\s+HOTEL(?:\s+ISCHIA)?\s*\/\s*AEROPORTO\s+Dalle\s*([0-2]?\d[:.]\d{2})\s+M\.p\.\s*:\s*([A-Z][A-Z &'./-]+?)\s+da:\s*([A-Z0-9 ]+?)\s+dest:\s*(AEROPORTO DI NAPOLI|AEROPORTO)(?=\s+[-A-ZÀ-ÖØ-Ý]|$)/i
  );
  if (!returnMatch) return null;
  return {
    serviceDate: parseItalianDate(returnMatch[1]) ?? parseItalianShortDate(returnMatch[1], fallbackYear),
    serviceTime: normalizeTime(returnMatch[2]),
    meetingPoint: clean(returnMatch[3]),
    transportReference: clean(returnMatch[4]),
    destination: clean(returnMatch[5]),
    rawDetailText: clean(returnMatch[0]) ?? "",
    direction
  };
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
  const fallbackYear =
    parsed.practice_date?.slice(0, 4) ??
    parseItalianDate(practiceHead[2])?.slice(0, 4) ??
    parseItalianDate(sourceText.match(/\bData\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\d{2,4})/i)?.[1] ?? null)?.slice(0, 4) ??
    null;
  const arrivalTrain = extractAlesteTrainOperationalJourney(sourceText, "andata", fallbackYear) ?? extractTrainJourney(sourceText, "1", fallbackYear);
  const departureTrain = extractAlesteTrainOperationalJourney(sourceText, "ritorno", fallbackYear) ?? extractTrainJourney(sourceText, "2", fallbackYear);
  const outwardBus = extractAlesteBusJourney(sourceText, "andata", fallbackYear);
  const returnBus = extractAlesteBusJourney(sourceText, "ritorno", fallbackYear);
  const outwardMarine = extractAlesteMarineJourney(sourceText, "andata", fallbackYear);
  const returnMarine = extractAlesteMarineJourney(sourceText, "ritorno", fallbackYear);
  const outwardFlixbus = extractAlesteFlixbusJourney(sourceText, "andata", fallbackYear);
  const returnFlixbus = extractAlesteFlixbusJourney(sourceText, "ritorno", fallbackYear);
  const outwardAirport = extractAlesteAirportJourney(sourceText, "andata", fallbackYear);
  const returnAirport = extractAlesteAirportJourney(sourceText, "ritorno", fallbackYear);
  const hasBusLineService =
    /\b(?:linea\s+\d+|bus\s+line|bus da |pullman|servizio bus|corriera|autobus)\b/i.test(sourceText) ||
    /\bBUS\b/i.test(parsed.program ?? "") ||
    /\bBUS\b/i.test(parsed.package_description ?? "");
  const hasMarineAutoTransfer =
    /AUTO\s*ISCHIA\s*\/\s*HOTEL|AUTO\s*HOTEL\s*\/\s*ISCHIA|ALISCAFO\s+DA\s+NAPOLI|ALISCAFO\s+PER\s+NAPOLI|CON\s+SNAV/i.test(sourceText);
  const hasTrainTransfer = arrivalTrain !== null || departureTrain !== null;

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

  if (hasBusLineService && hotel) {
    if (outwardBus) {
      parsedServices.push({
        practice_number: parsed.practice_number,
        beneficiary: exactBeneficiary ?? parsed.first_beneficiary,
        pax: exactPax ?? parsed.pax,
        service_type: "transfer",
        direction: "andata",
        service_date: outwardBus.serviceDate,
        service_time: outwardBus.serviceTime,
        pickup_meeting_point: outwardBus.meetingPoint,
        origin: outwardBus.origin,
        destination: hotel,
        carrier_company: "BUS",
        hotel_structure: hotel,
        original_row_description: "BUS DA CITTA / HOTEL",
        raw_detail_text: outwardBus.rawDetailText,
        parsing_status: "parsed",
        confidence_level: "high",
        semantic_tag: "transfer_arrival"
      });
    }

    if (returnBus) {
      parsedServices.push({
        practice_number: parsed.practice_number,
        beneficiary: exactBeneficiary ?? parsed.first_beneficiary,
        pax: exactPax ?? parsed.pax,
        service_type: "transfer",
        direction: "ritorno",
        service_date: returnBus.serviceDate,
        service_time: returnBus.serviceTime,
        pickup_meeting_point: hotel,
        origin: hotel,
        destination: returnBus.destination,
        carrier_company: "BUS",
        hotel_structure: hotel,
        original_row_description: "BUS HOTEL / CITTA",
        raw_detail_text: returnBus.rawDetailText,
        parsing_status: "parsed",
        confidence_level: "high",
        semantic_tag: "transfer_departure"
      });
    }
  }

  if (hasMarineAutoTransfer) {
    const marineHotel = outwardMarine?.hotel ?? hotel;
    const marineCarrier = /SNAV/i.test(outwardMarine?.rawDetailText ?? returnMarine?.rawDetailText ?? "") ? "SNAV" : "MEDMAR";
    const outwardMarineLabel = marineCarrier === "SNAV" ? "ALISCAFO DA NAPOLI + TRS H. ISCHIA" : "TRAGHETTO POZZUOLI + TRS H. ISCHIA";
    const returnMarineLabel = marineCarrier === "SNAV" ? "TRS H. ISCHIA + ALISCAFO PER NAPOLI" : "TRS H. ISCHIA + TRAGHETTO POZZUOLI";

    if (outwardMarine && marineHotel) {
      parsedServices.push({
        practice_number: parsed.practice_number,
        beneficiary: exactBeneficiary ?? parsed.first_beneficiary,
        pax: exactPax ?? parsed.pax,
        service_type: "transfer",
        direction: "andata",
        service_date: outwardMarine.serviceDate,
        service_time: outwardMarine.serviceTime,
        pickup_meeting_point: outwardMarine.meetingPoint,
        origin: outwardMarine.origin,
        destination: marineHotel,
        carrier_company: marineCarrier,
        hotel_structure: marineHotel,
        original_row_description: outwardMarineLabel,
        raw_detail_text: outwardMarine.rawDetailText,
        parsing_status: "parsed",
        confidence_level: "high",
        semantic_tag: "transfer_arrival"
      });
    }

    if (returnMarine && marineHotel) {
      parsedServices.push({
        practice_number: parsed.practice_number,
        beneficiary: exactBeneficiary ?? parsed.first_beneficiary,
        pax: exactPax ?? parsed.pax,
        service_type: "transfer",
        direction: "ritorno",
        service_date: returnMarine.serviceDate,
        service_time: returnMarine.serviceTime,
        pickup_meeting_point: marineHotel,
        origin: marineHotel,
        destination: returnMarine.destination,
        carrier_company: marineCarrier,
        hotel_structure: marineHotel,
        original_row_description: returnMarineLabel,
        raw_detail_text: returnMarine.rawDetailText,
        parsing_status: "parsed",
        confidence_level: "high",
        semantic_tag: "transfer_departure"
      });
    }
  }

  const hasFlixbusTransfer =
    /\bFLIXBUS\b/i.test(sourceText) &&
    /TRANSFER\s+STAZIONE\s*\/\s*HOTEL|TRANSFER\s+HOTEL\s*\/\s*STAZIONE/i.test(sourceText);
  const hasAirportTransfer =
    /TRANSFER\s+AEROPORTO\s*\/\s*HOTEL|TRANSFER\s+HOTEL(?:\s+ISCHIA)?\s*\/\s*AEROPORTO/i.test(sourceText);

  if (hasFlixbusTransfer && hotel) {
    if (outwardFlixbus) {
      parsedServices.push({
        practice_number: parsed.practice_number,
        beneficiary: exactBeneficiary ?? parsed.first_beneficiary,
        pax: exactPax ?? parsed.pax,
        service_type: "transfer",
        direction: "andata",
        service_date: outwardFlixbus.serviceDate,
        service_time: outwardFlixbus.arrivalTime ?? outwardFlixbus.serviceTime,
        pickup_meeting_point: outwardFlixbus.meetingPoint,
        origin: outwardFlixbus.meetingPoint,
        destination: hotel,
        carrier_company: "FLIXBUS",
        hotel_structure: hotel,
        original_row_description: "TRANSFER STAZIONE / HOTEL",
        raw_detail_text: outwardFlixbus.rawDetailText,
        parsing_status: "parsed",
        confidence_level: "high",
        semantic_tag: "transfer_arrival"
      });
    }

    if (returnFlixbus) {
      parsedServices.push({
        practice_number: parsed.practice_number,
        beneficiary: exactBeneficiary ?? parsed.first_beneficiary,
        pax: exactPax ?? parsed.pax,
        service_type: "transfer",
        direction: "ritorno",
        service_date: returnFlixbus.serviceDate,
        service_time: returnFlixbus.serviceTime,
        pickup_meeting_point: hotel,
        origin: hotel,
        destination: returnFlixbus.destination,
        carrier_company: "FLIXBUS",
        hotel_structure: hotel,
        original_row_description: "TRANSFER HOTEL/STAZIONE",
        raw_detail_text: returnFlixbus.rawDetailText,
        parsing_status: "parsed",
        confidence_level: "high",
        semantic_tag: "transfer_departure"
      });
    }
  }

  if (hasAirportTransfer) {
    const airportHotel = outwardAirport?.destination ?? hotel;

    if (outwardAirport && airportHotel) {
      parsedServices.push({
        practice_number: parsed.practice_number,
        beneficiary: exactBeneficiary ?? parsed.first_beneficiary,
        pax: exactPax ?? parsed.pax,
        service_type: "transfer",
        direction: "andata",
        service_date: outwardAirport.serviceDate,
        service_time: outwardAirport.serviceTime,
        pickup_meeting_point: outwardAirport.meetingPoint,
        origin: outwardAirport.meetingPoint,
        destination: airportHotel,
        carrier_company: "AEREO",
        hotel_structure: airportHotel,
        original_row_description: "TRANSFER AEROPORTO / HOTEL",
        raw_detail_text: outwardAirport.rawDetailText,
        parsing_status: "parsed",
        confidence_level: "high",
        semantic_tag: "transfer_arrival"
      });
    }

    if (returnAirport && airportHotel) {
      parsedServices.push({
        practice_number: parsed.practice_number,
        beneficiary: exactBeneficiary ?? parsed.first_beneficiary,
        pax: exactPax ?? parsed.pax,
        service_type: "transfer",
        direction: "ritorno",
        service_date: returnAirport.serviceDate,
        service_time: returnAirport.serviceTime,
        pickup_meeting_point: airportHotel,
        origin: airportHotel,
        destination: returnAirport.destination,
        carrier_company: "AEREO",
        hotel_structure: airportHotel,
        original_row_description: "TRANSFER HOTEL ISCHIA / AEROPORTO",
        raw_detail_text: returnAirport.rawDetailText,
        parsing_status: "parsed",
        confidence_level: "high",
        semantic_tag: "transfer_departure"
      });
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
    booking_kind: hasAirportTransfer ? "transfer_airport_hotel" : hasBusLineService ? "bus_city_hotel" : hasTrainTransfer ? "transfer_train_hotel" : hasMarineAutoTransfer ? "transfer_port_hotel" : "transfer_train_hotel",
    service_type_code: hasAirportTransfer ? "transfer_airport_hotel" : hasBusLineService ? "bus_line" : hasTrainTransfer ? "transfer_station_hotel" : hasMarineAutoTransfer ? "transfer_port_hotel" : "transfer_station_hotel",
    date_from: (outwardAirport?.serviceDate ?? outwardFlixbus?.serviceDate ?? outwardBus?.serviceDate ?? outwardMarine?.serviceDate ?? parsed.date_from) || null,
    date_to: (returnAirport?.serviceDate ?? returnFlixbus?.serviceDate ?? returnBus?.serviceDate ?? returnMarine?.serviceDate ?? parsed.date_to) || null,
    train_arrival_number:
      outwardAirport?.transportReference ??
      outwardFlixbus?.transportReference ??
      (arrivalTrain?.trainNumber ? `${arrivalTrain.carrierCompany ?? "ITALO"} ${arrivalTrain.trainNumber}` : null),
    train_arrival_time: outwardAirport?.serviceTime ?? outwardFlixbus?.arrivalTime ?? outwardFlixbus?.serviceTime ?? arrivalTrain?.destinationTime ?? arrivalTrain?.originTime ?? null,
    train_departure_number:
      returnAirport?.transportReference ??
      returnFlixbus?.transportReference ??
      (departureTrain?.trainNumber ? `${departureTrain.carrierCompany ?? "ITALO"} ${departureTrain.trainNumber}` : null),
    train_departure_time: returnAirport?.serviceTime ?? returnFlixbus?.serviceTime ?? departureTrain?.originTime ?? null,
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
  contentHints: ["staff aleste", "staff al este", "ufficio booking - aleste viaggi", "aleste viaggi"],
  agencyNameHints: ["aleste viaggi", "ufficio booking - aleste viaggi"],
  voucherHints: ["staff aleste", "staff al este", "pacchetto transfer", "conferma d ordine"],
  parse: parseAlesteViaggiPdfText,
  match: (input) =>
    buildParserMatch(input, {
      senderDomains: ["aleste-viaggi.it", "alesteviaggi.it"],
      subjectHints: ["aleste", "booking aleste"],
      contentHints: ["staff aleste", "staff al este", "ufficio booking - aleste viaggi", "aleste viaggi"],
      agencyNameHints: ["aleste viaggi", "ufficio booking - aleste viaggi"],
      voucherHints: ["staff aleste", "staff al este", "pacchetto transfer", "conferma d ordine"]
    })
};
