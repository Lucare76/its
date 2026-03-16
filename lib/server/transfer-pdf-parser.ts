export type ParsedTransferDirection = "andata" | "ritorno";

export type ParsedTransferService = {
  practice_number: string | null;
  beneficiary: string | null;
  pax: number | null;
  service_type: "transfer";
  direction: ParsedTransferDirection;
  service_date: string | null;
  service_time: string | null;
  pickup_meeting_point: string | null;
  origin: string | null;
  destination: string | null;
  carrier_company: string | null;
  hotel_structure: string | null;
  original_row_description: string | null;
  raw_detail_text: string;
  parsing_status: "parsed" | "needs_review";
  confidence_level: "high" | "medium" | "low";
  semantic_tag: "transfer_arrival" | "transfer_departure" | "transfer_hotel_ischia";
};

export type ParsedTransferPdfPayload = {
  practice_number: string | null;
  practice_date: string | null;
  first_beneficiary: string | null;
  customer_first_name?: string | null;
  customer_last_name?: string | null;
  customer_full_name?: string | null;
  ns_reference: string | null;
  ns_contact: string | null;
  pax: number | null;
  program: string | null;
  package_description: string | null;
  date_from: string | null;
  date_to: string | null;
  total_amount_practice: number | null;
  booking_kind?: "transfer_port_hotel" | "transfer_airport_hotel" | "transfer_train_hotel" | "bus_city_hotel" | "excursion" | null;
  service_type_code?: "transfer_station_hotel" | "transfer_port_hotel" | "transfer_hotel_port" | "excursion" | "ferry_transfer" | "bus_line" | null;
  train_arrival_number?: string | null;
  train_arrival_time?: string | null;
  train_departure_number?: string | null;
  train_departure_time?: string | null;
  service_rows: Array<{ row_text: string; semantic_tag: string; direction: ParsedTransferDirection }>;
  operational_details: Array<{
    service_date: string | null;
    service_time: string | null;
    meeting_point: string | null;
    from_text: string | null;
    to_text: string | null;
    dest_text: string | null;
    description_line: string | null;
    raw_detail_text: string;
  }>;
  parsed_services: ParsedTransferService[];
  parsing_status: "parsed" | "needs_review";
  confidence_level: "high" | "medium" | "low";
  anomaly_message: string | null;
};

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

function normalizeText(source: string) {
  return source
    .replace(/\u00a0/g, " ")
    .replace(/[–—]/g, "-")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseItalianDate(raw?: string | null) {
  if (!raw) return null;
  const match = raw.match(/([0-3]?\d)-(gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-(\d{2,4})/i);
  if (!match) return null;
  const day = match[1].padStart(2, "0");
  const month = IT_MONTHS[match[2].toLowerCase()];
  if (!month) return null;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${month}-${day}`;
}

function cleanValue(value?: string | null) {
  if (!value) return null;
  const cleaned = value.replace(/\s+/g, " ").trim().replace(/^[,;:\-.\s]+|[,;:\-.\s]+$/g, "");
  return cleaned.length > 0 ? cleaned : null;
}

function parseEuroAmount(raw?: string | null) {
  if (!raw) return null;
  const normalized = raw.replace(/\./g, "").replace(",", ".");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function isPortOrStationText(value?: string | null) {
  if (!value) return false;
  return /(porto|stazione|aeroporto|napoli|molo|terminal)/i.test(value);
}

function deriveDirectionFromTexts(description: string, meetingPoint?: string | null, dest?: string | null): ParsedTransferDirection {
  const source = description.toLowerCase();
  if (/transfer\s+hotel\s*\/\s*stazione/.test(source)) return "ritorno";
  if (/transfer\s+stazione\s*\/\s*hotel/.test(source)) return "andata";
  if (/aliscafo\s+per\s+napoli/.test(source)) return "ritorno";
  if (/traghetto\s+napoli\s*\+\s*trs\s*h\.?\s*ischia/.test(source)) return "andata";
  if (/trs\s*h\.?\s*ischia\s*\+\s*traghetto\s+napoli/.test(source)) return "ritorno";
  if (/auto\s*ischia\s*\/\s*hotel/.test(source)) return "andata";
  if (/auto\s*hotel\s*\/\s*ischia/.test(source)) return "ritorno";
  if (/aliscafo\s+da\s+napoli/.test(source) || /trs\s*h\.?\s*ischia/.test(source)) return "andata";
  if (isPortOrStationText(dest)) return "ritorno";
  if (isPortOrStationText(meetingPoint)) return "andata";
  return "andata";
}

function normalizeSemanticTag(direction: ParsedTransferDirection, description: string): "transfer_arrival" | "transfer_departure" | "transfer_hotel_ischia" {
  if (/trs\s*h\.?\s*ischia/i.test(description) && !/aliscafo\s+per\s+napoli/i.test(description)) return "transfer_hotel_ischia";
  return direction === "andata" ? "transfer_arrival" : "transfer_departure";
}

function detectCarrierCompany(...values: Array<string | null | undefined>) {
  const source = values.filter(Boolean).join(" ").toUpperCase();
  const match = source.match(/\b(SNAV|CAREMAR|MEDMAR|ALILAURO|TRAGHETTI)\b/);
  return match?.[1] ?? null;
}

function isAutoIschiaHotelRow(value?: string | null) {
  return /AUTO\s*ISCHIA\s*\/\s*HOTEL|AUTO\s*HOTEL\s*\/\s*ISCHIA/i.test(String(value ?? ""));
}

function extractPracticeCore(source: string) {
  const compactSource = source.replace(/\s+/g, " ");
  const structuredHead = compactSource.match(
    /(\d{2}\/\d{6})\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\d{2,4})\s*([A-ZÀ-ÖØ-Ý' ]{6,}?)\s*(Staff\s+[A-Za-z]+)\s*(\d{1,2})(?=\s*PROGRAMMA)/i
  );

  const practiceNumber = structuredHead?.[1] ?? source.match(/(\d{2}\/\d{6})/)?.[1] ?? null;
  const practiceDate = parseItalianDate(source.match(/Data\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\d{2,4})/i)?.[1] ?? null);
  const paxByLabel =
    structuredHead?.[5] ??
    source.match(/\bPAX\b[^\d]{0,10}(\d{1,2})(?!\s*\/)/i)?.[1] ??
    source.match(/Staff\s+[A-Za-z]+\s*(\d{1,2})\b/i)?.[1];
  const pax = paxByLabel ? Number(paxByLabel) : null;

  let firstBeneficiary =
    cleanValue(structuredHead?.[3] ?? null) ??
    cleanValue(source.match(/BENEFICIARIO\s*([^\n\r]+?)(?:NS\s*RIFERIMENTO|PAX|PROGRAMMA)/i)?.[1]);
  let nsReference =
    cleanValue(structuredHead?.[4] ?? null) ??
    cleanValue(source.match(/NS\s*RIFERIMENTO\s*([^\n\r]+?)(?:NS\s*REFERENTE|PAX|PROGRAMMA)/i)?.[1]);
  const nsContact = cleanValue(source.match(/NS\s*REFERENTE\s*([^\n\r]+?)(?:PAX|PROGRAMMA)/i)?.[1]);
  const customerFromDetail = cleanValue(source.match(/Cliente:\s*([^\n\r]+)/i)?.[1] ?? null);
  if (!firstBeneficiary || /ns riferimento|ns referente/i.test(firstBeneficiary)) {
    firstBeneficiary = customerFromDetail ?? firstBeneficiary;
  }

  if ((!firstBeneficiary || !nsReference) && practiceNumber) {
    const practiceLine = source
      .split(/\n/)
      .map((line) => line.trim())
      .find((line) => line.includes(practiceNumber));
    if (practiceLine) {
      const compact = practiceLine.replace(/\s+/g, " ");
      const headerMatch = compact.match(/(\d{2}\/\d{6})\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\d{2,4})(.*)$/i);
      if (headerMatch) {
        const tail = headerMatch[3] ?? "";
        const benMatch = tail.match(/([A-ZÀ-ÖØ-Ý' ]{8,})(Staff\s+[A-Za-z]+)/i);
        firstBeneficiary = firstBeneficiary ?? cleanValue(benMatch?.[1] ?? null);
        nsReference = nsReference ?? cleanValue(benMatch?.[2] ?? null);
      }
    }
  }

  const program = cleanValue(source.match(/\b(\d{2}\/TRANSFER)\b/i)?.[1] ?? null);
  const packageDescription = cleanValue(source.match(/\b(PACCHETTO\s+TRANSFER)\b/i)?.[1] ?? null);
  const dateFrom = parseItalianDate(source.match(/\bDAL\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\d{2,4})/i)?.[1] ?? null);
  const dateTo = parseItalianDate(source.match(/\bAL\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\d{2,4})/i)?.[1] ?? null);
  const totalAmount = parseEuroAmount(source.match(/Totale\s*pratica\s*EUR\s*([0-9]+(?:[.,][0-9]{2})?)/i)?.[1] ?? null);

  return {
    practiceNumber,
    practiceDate,
    firstBeneficiary,
    nsReference,
    nsContact,
    pax,
    program,
    packageDescription,
    dateFrom,
    dateTo,
    totalAmount
  };
}

function extractServiceRows(
  source: string
): Array<{ row_text: string; semantic_tag: "transfer_arrival" | "transfer_departure"; direction: ParsedTransferDirection }> {
  const rows = source
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => /AUTO\s*ISCHIA\s*\/\s*HOTEL|AUTO\s*HOTEL\s*\/\s*ISCHIA/i.test(line));

  return rows.map((line) => {
    const direction = /AUTO\s*HOTEL\s*\/\s*ISCHIA/i.test(line) ? "ritorno" : "andata";
    return {
      row_text: line,
      semantic_tag: direction === "andata" ? "transfer_arrival" : "transfer_departure",
      direction
    };
  });
}

type OperationalLeg = {
  service_date: string | null;
  service_time: string | null;
  meeting_point: string | null;
  from_text: string | null;
  to_text: string | null;
  dest_text: string | null;
  description_line: string | null;
  raw_detail_text: string;
  direction: ParsedTransferDirection;
};

function extractOperationalLegs(source: string): OperationalLeg[] {
  const lines = source
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const legs: OperationalLeg[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const head = lines[i].match(/^Il\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\d{2,4})\b/i);
    if (!head) continue;
    const descriptionLine = lines[i] ?? null;
    const detailLine = [lines[i + 1], lines[i + 2], lines[i + 3]].find((line) => typeof line === "string" && /\bDalle\s*[0-2]?\d[:.h][0-5]\d/i.test(line ?? "")) ?? null;
    if (!detailLine) continue;
    const detailContinuation = [lines[i + 2], lines[i + 3], lines[i + 4]]
      .filter(
        (line) =>
          typeof line === "string" &&
          line &&
          !/^Il\s*[0-3]?\d-/i.test(line) &&
          !/^Cliente:/i.test(line) &&
          !/^Cellulare/i.test(line) &&
          !/^Dalle\s*[0-2]?\d[:.h][0-5]\d/i.test(line)
      )
      .join(" ");
    const mergedDetail = `${detailLine} ${detailContinuation}`.replace(/\s+/g, " ").trim();

    const date = parseItalianDate(head[1]);
    const fromTimeMatch = mergedDetail.match(/(?:^|[^A-Za-z])Dalle\s*([01]?\d|2[0-3])[:.h]([0-5]\d)/i);
    const toTimeMatch = mergedDetail.match(/(?:^|[^A-Za-z])Alle\s*([01]?\d|2[0-3])[:.h]([0-5]\d)/i);
    const fromTime = fromTimeMatch ? `${fromTimeMatch[1].padStart(2, "0")}:${fromTimeMatch[2].padStart(2, "0")}` : null;
    const toTime = toTimeMatch ? `${toTimeMatch[1].padStart(2, "0")}:${toTimeMatch[2].padStart(2, "0")}` : null;

    const dest = cleanValue(mergedDetail.match(/\bdest:\s*(.+)$/i)?.[1]);
    const meetingPoint = cleanValue(mergedDetail.match(/M\.p\.\s*:\s*(.+?)\s+\bda:/i)?.[1]);
    const fromText = cleanValue(mergedDetail.match(/\bda:\s*(.+?)\s+\ba:/i)?.[1]);
    let toText = cleanValue(mergedDetail.match(/\ba:\s*(.+?)\s+\bdest:/i)?.[1]);
    if (toText && /^cell/i.test(toText)) {
      toText = null;
    }
    const direction = deriveDirectionFromTexts(`${descriptionLine ?? ""} ${mergedDetail}`, meetingPoint, dest);
    const isStationHotelTransfer = /TRANSFER\s+STAZIONE\s*\/\s*HOTEL/i.test(descriptionLine ?? "");
    const isHotelStationTransfer = /TRANSFER\s+HOTEL\s*\/\s*STAZIONE/i.test(descriptionLine ?? "");
    const serviceTime =
      isStationHotelTransfer
        ? (toTime ?? fromTime)
        : isHotelStationTransfer
          ? (fromTime ?? toTime)
          : (fromTime ?? toTime);

    legs.push({
      service_date: date,
      service_time: serviceTime,
      meeting_point: meetingPoint,
      from_text: fromText,
      to_text: toText,
      dest_text: dest,
      description_line: descriptionLine,
      raw_detail_text: `${descriptionLine ?? ""}\n${mergedDetail}`.trim(),
      direction
    });
  }
  return legs;
}

function buildParsedServices(core: ReturnType<typeof extractPracticeCore>, rows: ReturnType<typeof extractServiceRows>, legs: OperationalLeg[]) {
  const services: ParsedTransferService[] = [];
  for (const [index, leg] of legs.entries()) {
    const row = rows.find((item) => item.direction === leg.direction) ?? rows[index] ?? null;
    const direction = leg.direction ?? row?.direction ?? "andata";
    const isAutoPortTransfer = isAutoIschiaHotelRow(row?.row_text) || /ALISCAFO|SNAV|CAREMAR|MEDMAR|ALILAURO/i.test(leg.raw_detail_text);
    const semanticTag = normalizeSemanticTag(direction, `${row?.row_text ?? ""} ${leg.description_line ?? ""}`);
    const hotelStructure =
      direction === "andata"
        ? (isPortOrStationText(leg.dest_text) ? null : leg.dest_text)
        : (isPortOrStationText(leg.meeting_point) ? null : leg.meeting_point);

    const arrivalPort =
      isAutoPortTransfer && /MEDMAR|TRAGHETTO\s+NAPOLI|PORTA\s+DI\s+MASSA/i.test(leg.raw_detail_text)
        ? "ISCHIA/CASAMICCIOLA"
        : isAutoPortTransfer
          ? "CASAMICCIOLA"
          : leg.meeting_point;
    const destination =
      direction === "ritorno" && isAutoPortTransfer
        ? arrivalPort
        : direction === "ritorno" && leg.dest_text
          ? leg.dest_text
          : leg.dest_text ?? leg.to_text ?? leg.from_text ?? leg.meeting_point;
    const carrierCompany = detectCarrierCompany(leg.from_text, leg.to_text, leg.raw_detail_text);

    services.push({
      practice_number: core.practiceNumber,
      beneficiary: core.firstBeneficiary,
      pax: core.pax,
      service_type: "transfer",
      direction,
      service_date: leg.service_date,
      service_time: leg.service_time,
      pickup_meeting_point: direction === "andata" && isAutoPortTransfer ? arrivalPort : leg.meeting_point,
      origin: direction === "andata" && isAutoPortTransfer ? arrivalPort : leg.from_text ?? leg.meeting_point,
      destination,
      carrier_company: carrierCompany,
      hotel_structure: hotelStructure,
      original_row_description: row?.row_text ?? leg.description_line,
      raw_detail_text: leg.raw_detail_text,
      parsing_status: "parsed",
      confidence_level: "high",
      semantic_tag: semanticTag
    });
  }
  return services;
}

export function parseTransferBookingPdfText(sourceText: string): ParsedTransferPdfPayload {
  const source = normalizeText(sourceText);
  const core = extractPracticeCore(source);
  const serviceRows = extractServiceRows(source);
  const operationalLegs = extractOperationalLegs(source);
  const parsedServices = buildParsedServices(core, serviceRows, operationalLegs);

  const dateFrom = core.dateFrom ?? parsedServices.map((item) => item.service_date).filter(Boolean).sort()[0] ?? null;
  const dateTo = core.dateTo ?? parsedServices.map((item) => item.service_date).filter(Boolean).sort().slice(-1)[0] ?? null;

  const anomalyMessages: string[] = [];
  if (!core.practiceNumber) anomalyMessages.push("Numero pratica non trovato.");
  if (parsedServices.length === 0) anomalyMessages.push("Nessun servizio transfer operativo riconosciuto.");
  if (!core.firstBeneficiary) anomalyMessages.push("Beneficiario non rilevato.");

  const confidenceLevel: "high" | "medium" | "low" =
    anomalyMessages.length === 0 ? "high" : parsedServices.length > 0 ? "medium" : "low";

  return {
    practice_number: core.practiceNumber,
    practice_date: core.practiceDate,
    first_beneficiary: core.firstBeneficiary,
    ns_reference: core.nsReference,
    ns_contact: core.nsContact,
    pax: core.pax,
    program: core.program,
    package_description: core.packageDescription,
    date_from: dateFrom,
    date_to: dateTo,
    total_amount_practice: core.totalAmount,
    service_rows: serviceRows,
    operational_details: operationalLegs.map((leg) => ({
      service_date: leg.service_date,
      service_time: leg.service_time,
      meeting_point: leg.meeting_point,
      from_text: leg.from_text,
      to_text: leg.to_text,
      dest_text: leg.dest_text,
      description_line: leg.description_line,
      raw_detail_text: leg.raw_detail_text
    })),
    parsed_services: parsedServices,
    parsing_status: parsedServices.length > 0 ? "parsed" : "needs_review",
    confidence_level: confidenceLevel,
    anomaly_message: anomalyMessages.length > 0 ? anomalyMessages.join(" ") : null
  };
}
