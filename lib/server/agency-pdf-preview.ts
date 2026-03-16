import { parseInboundEmail } from "@/lib/email-parser";
import { resolveBillingPartyFromRegistry } from "@/lib/server/billing-party-registry";
import { selectAgencyPdfParser, type AgencyPdfParserSelectionResult } from "@/lib/server/agency-pdf-parser-registry";

type BookingKind = "transfer_port_hotel" | "transfer_airport_hotel" | "transfer_train_hotel" | "bus_city_hotel" | "excursion";
type ServiceTypeDeduced = "transfer" | "ferry" | "excursion" | "bus" | null;
type ServiceTypeCode = "transfer_station_hotel" | "transfer_port_hotel" | "transfer_hotel_port" | "excursion" | "ferry_transfer" | "bus_line" | null;
type TransportMode = "train" | "hydrofoil" | "ferry" | "road_transfer" | "bus" | "unknown" | null;

const INTERNAL_ITS_PHONE = "0813331053";

export interface AgencyPdfPreviewInput {
  senderEmail: string;
  subject: string;
  filename?: string | null;
  bodyText?: string | null;
  extractedText: string;
  headerText?: string | null;
}

export interface AgencyPdfPreviewResult {
  parser: {
    selected_key: string;
    mode: AgencyPdfParserSelectionResult["parserMode"];
    score: number;
    selection_confidence: AgencyPdfParserSelectionResult["selectionConfidence"];
    selection_reason: string;
    fallback_reason: string | null;
    candidates: AgencyPdfParserSelectionResult["candidates"];
  };
  extracted_text_preview: string;
  extracted: {
    agency_name: string | null;
    billing_party_name: string | null;
    booking_kind: BookingKind | null;
    service_type: ServiceTypeCode;
    service_type_deduced: ServiceTypeDeduced;
    customer_full_name: string | null;
    customer_email: string | null;
    customer_phone: string | null;
    arrival_date: string | null;
    outbound_time: string | null;
    departure_date: string | null;
    return_time: string | null;
    transport_mode: TransportMode;
    transport_reference_outward: string | null;
    transport_reference_return: string | null;
    arrival_place: string | null;
    hotel_or_destination: string | null;
    passengers: number | null;
    source_total_amount: number | null;
    source_price_per_pax: number | null;
    source_amount_currency: string | null;
    train_arrival_number: string | null;
    train_arrival_time: string | null;
    train_departure_number: string | null;
    train_departure_time: string | null;
    notes: string | null;
  };
  fields_found: string[];
  missing_fields: string[];
  reliability: "high" | "medium" | "low";
  parser_logs: string[];
  raw: {
    inbound_parser: ReturnType<typeof parseInboundEmail>;
    transfer_parser: AgencyPdfParserSelectionResult["parsed"];
  };
}

function clean(value?: string | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function senderDomain(email: string) {
  const parts = clean(email)?.toLowerCase().split("@") ?? [];
  return parts.length > 1 ? parts[1] : null;
}

function titleFromDomain(domain: string | null) {
  if (!domain) return null;
  const base = domain.replace(/^www\./, "").split(".")[0] ?? "";
  if (!base) return null;
  return base
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function canonicalAgencyNameFromText(value?: string | null) {
  const normalized = clean(value);
  if (!normalized) return null;
  if (/aleste viaggi/i.test(normalized)) return "Aleste Viaggi";
  if (/sosandra tour/i.test(normalized) || /rossella viaggi/i.test(normalized)) return "Sosandra Tour By Rossella Viaggi";
  if (/ischia transfer service/i.test(normalized)) return "Ischia Transfer Service";
  if (/dimhotels/i.test(normalized)) return "Dimhotels";
  if (/holiday sud italia|hollday sud italia/i.test(normalized)) return "Holiday Sud Italia";
  if (/angelino tour operator|angelino tour/i.test(normalized)) return "Angelino Tour Operator";
  if (/welcome travel/i.test(normalized)) return "Welcome Travel";
  if (/gattinoni/i.test(normalized)) return "Gattinoni";
  if (/made/i.test(normalized)) return "Made";
  return normalized;
}

function agencyNameFromParser(selection: AgencyPdfParserSelectionResult) {
  if (selection.parserKey === "agency_aleste_viaggi") return "Aleste Viaggi";
  if (selection.parserKey === "agency_rossella_sosandra") return "Sosandra Tour By Rossella Viaggi";
  if (selection.parserKey === "agency_bus_operations") return "Ischia Transfer Service";
  if (selection.parserKey === "agency_holiday_sud_italia") return "Holiday Sud Italia";
  if (selection.parserKey === "agency_angelino_tour") return "Angelino Tour Operator";
  return null;
}

function isGenericOperationalDomain(domain: string | null) {
  if (!domain) return true;
  return /\.local$/i.test(domain) || /localhost/i.test(domain);
}

function deriveAgencyName(
  senderEmail: string,
  subject: string,
  extractedText: string,
  headerText: string | null | undefined,
  selection: AgencyPdfParserSelectionResult
) {
  const fromParser = agencyNameFromParser(selection);
  if (fromParser && selection.parserKey !== "agency_bus_operations") return fromParser;

  const explicitTextCandidates = [
    headerText,
    extractedText.match(/Ufficio Booking\s*-\s*([^\n\r]+)/i)?.[1],
    extractedText.match(/(?:Agenzia|Agency)\s*[:.-]?\s*([^\n\r]+)/i)?.[1],
    subject.match(/(?:Agenzia|Agency)\s*[:.-]?\s*([^\n\r]+)/i)?.[1],
    extractedText.match(/\b(Sosandra Tour(?:\s+By)?\s+Rossella Viaggi(?:\s+S\.r\.l\.)?)\b/i)?.[1],
    extractedText.match(/\b(Rossella Viaggi(?:\s+S\.r\.l\.)?)\b/i)?.[1],
    extractedText.match(/\b(Aleste Viaggi)\b/i)?.[1],
    extractedText.match(/\b(Dimhotels)\b/i)?.[1],
    extractedText.match(/\b(ISCHIA TRANSFER SERVICE(?:\s+S\.r\.l\.)?)\b/i)?.[1]
  ];

  for (const candidate of explicitTextCandidates) {
    const canonical = canonicalAgencyNameFromText(candidate);
    if (canonical) return canonical;
  }

  if (fromParser) return fromParser;

  const domain = senderDomain(senderEmail);
  if (!isGenericOperationalDomain(domain)) {
    return canonicalAgencyNameFromText(titleFromDomain(domain));
  }

  return null;
}

function deriveBillingPartyName(
  selection: AgencyPdfParserSelectionResult,
  transferParsed: AgencyPdfParserSelectionResult["parsed"],
  extractedText: string,
  headerText: string | null | undefined,
  agencyName: string | null
) {
  if (selection.parserKey === "agency_holiday_sud_italia") {
    return "Holidayweb";
  }

  if (selection.parserKey === "agency_angelino_tour") {
    return "Angelino Tour Operator";
  }

  const explicitCandidates = [
    headerText,
    extractedText.match(/(?:Intestatario|Contraente|Agenzia|Agency)\s*[:.-]?\s*([^\n\r]+)/i)?.[1]
  ];

  for (const candidate of explicitCandidates) {
    const normalized = clean(candidate);
    if (normalized && !/ischia transfer service/i.test(normalized)) return normalized;
  }

  if (selection.parserKey === "agency_bus_operations") {
    const source = [headerText, extractedText, transferParsed.ns_reference].filter(Boolean).join(" ");
    const fromRegistry = resolveBillingPartyFromRegistry({ parserKey: selection.parserKey, sourceText: source });
    if (fromRegistry) return fromRegistry;
    return null;
  }

  return agencyName;
}

function splitCustomerName(fullName: string | null) {
  const normalized = clean(fullName);
  if (!normalized) {
    return { firstName: null, lastName: null, fullName: null };
  }

  const upper = normalized.toUpperCase();
  if (/^[A-Z' ]+$/.test(upper)) {
    const parts = upper.split(" ").filter(Boolean);
    if (parts.length >= 2) {
      return {
        firstName: parts.slice(1).join(" "),
        lastName: parts[0] ?? null,
        fullName: parts.join(" ")
      };
    }
  }

  const parts = normalized.split(" ").filter(Boolean);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: null, fullName: normalized };
  }

  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts.slice(-1)[0] ?? null,
    fullName: normalized
  };
}

function deduceOperationalServiceType(source: string, bookingKind: BookingKind | null): ServiceTypeCode {
  const normalized = source.toLowerCase();
  if (/(bus|pullman|coach)/i.test(normalized) || bookingKind === "bus_city_hotel") return "bus_line";
  if (/transfer stazione ?\/ ?hotel|transfer stazione hotel/.test(normalized)) return "transfer_station_hotel";
  if (/transfer hotel ?\/ ?stazione|transfer hotel stazione/.test(normalized)) return "transfer_hotel_port";
  if (/transfer porto ?\/ ?hotel|transfer porto hotel|auto ischia ?\/ ?hotel|traghetto napoli \+ transfer/.test(normalized)) {
    return "transfer_port_hotel";
  }
  if (/(ferry|traghetto|aliscafo|passaggio marittimo)/i.test(normalized)) return "ferry_transfer";
  if (/(excursion|escursione|\btour\b(?!\s+by))/i.test(normalized)) return "excursion";
  if (bookingKind === "transfer_train_hotel") return "transfer_station_hotel";
  if (bookingKind === "transfer_port_hotel") return "transfer_port_hotel";
  if (bookingKind === "excursion") return "excursion";
  return null;
}

function deduceBookingKind(source: string) {
  const normalized = source.toLowerCase();
  if (/(excursion|escursione|\btour\b(?!\s+by))/i.test(normalized)) return "excursion";
  if (/(bus|pullman|coach)/i.test(normalized)) return "bus_city_hotel";
  if (/(transfer stazione ?\/ ?hotel|transfer hotel ?\/ ?stazione|stazione\s+hotel|hotel\s+stazione|treno)/i.test(normalized)) {
    return "transfer_train_hotel";
  }
  if (/(aeroporto|airport|capodichino)/i.test(normalized)) return "transfer_airport_hotel";
  if (/(traghetto napoli|aliscafo|porto|port|molo|snav|caremar|medmar|alilauro)/i.test(normalized)) return "transfer_port_hotel";
  if (/(auto ischia ?\/ ?hotel|auto hotel ?\/ ?ischia|transfer porto ?\/ ?hotel|transfer hotel ?\/ ?porto)/i.test(normalized)) {
    return "transfer_port_hotel";
  }
  if (/(porto|port|napoli|molo|aliscafo|caremar|medmar|alilauro|snav)/i.test(normalized)) return "transfer_port_hotel";
  return null;
}

function deduceServiceType(source: string) {
  const normalized = source.toLowerCase();
  if (/(excursion|escursione|\btour\b(?!\s+by))/i.test(normalized)) return "excursion";
  if (/(bus|pullman|coach)/i.test(normalized)) return "bus";
  if (/(auto ischia ?\/ ?hotel|auto hotel ?\/ ?ischia|trs h\.?\s*ischia|transfer porto ?\/ ?hotel|transfer hotel ?\/ ?porto)/i.test(normalized)) {
    return "transfer";
  }
  if (/(traghetto napoli \+ transfer|aliscafo .* transfer|passaggio marittimo .* transfer)/i.test(normalized)) return "transfer";
  if (/(ferry|traghetto|aliscafo|passaggio marittimo)/i.test(normalized)) return "ferry";
  if (/(transfer|auto ischia|hotel \/ ischia|ischia \/ hotel)/i.test(normalized)) return "transfer";
  return null;
}

function extractTransportReference(value?: string | null) {
  const normalized = clean(value);
  if (!normalized) return null;
  const match = normalized.match(/\b(ITALO|ITA|FRECCIAROSSA|FR|INTERCITY|IC|SNAV|CAREMAR|MEDMAR|ALILAURO)\s*(\d{3,5})\b/i);
  if (!match) return null;
  const carrier = match[1].toUpperCase();
  if (carrier === "ITA" || carrier === "ITALO") return `ITALO ${match[2]}`;
  if (carrier === "FR" || carrier === "FRECCIAROSSA") return `FRECCIAROSSA ${match[2]}`;
  if (carrier === "IC" || carrier === "INTERCITY") return `INTERCITY ${match[2]}`;
  return `${carrier} ${match[2]}`;
}

function extractOperationalTime(rawDetailText?: string | null, kind?: "outward" | "return") {
  const source = clean(rawDetailText);
  if (!source) return null;
  const fromMatch = source.match(/(?:^|[^A-Za-z])Dalle\s*([01]?\d|2[0-3])[:.h]([0-5]\d)/i);
  const toMatch = source.match(/(?:^|[^A-Za-z])Alle\s*([01]?\d|2[0-3])[:.h]([0-5]\d)/i);
  const fromTime = fromMatch ? `${fromMatch[1].padStart(2, "0")}:${fromMatch[2]}` : null;
  const toTime = toMatch ? `${toMatch[1].padStart(2, "0")}:${toMatch[2]}` : null;

  if (/TRANSFER\s+STAZIONE\s*\/\s*HOTEL/i.test(source)) {
    return kind === "outward" ? (toTime ?? fromTime) : (fromTime ?? toTime);
  }
  if (/TRANSFER\s+HOTEL\s*\/\s*STAZIONE/i.test(source)) {
    return kind === "return" ? (fromTime ?? toTime) : (toTime ?? fromTime);
  }
  return kind === "outward" ? (toTime ?? fromTime) : (fromTime ?? toTime);
}

function isTrainMode(mode: TransportMode) {
  return mode === "train";
}

function deduceTransportMode(source: string, bookingKind: BookingKind | null, serviceType: ServiceTypeCode): TransportMode {
  const normalized = source.toLowerCase();
  if (serviceType === "bus_line") return "bus";
  if (serviceType === "transfer_port_hotel" || serviceType === "transfer_hotel_port") return "road_transfer";
  if (/(bus|pullman|coach)/i.test(normalized) || bookingKind === "bus_city_hotel") return "bus";
  if (/(italo|freccia|intercity|stazione|napoli centrale|treno)/i.test(normalized) || serviceType === "transfer_station_hotel") {
    return "train";
  }
  if (/(aliscafo|hydrofoil|alilauro|snav)/i.test(normalized)) return "hydrofoil";
  if (/(traghetto|ferry|caremar|medmar|porta di massa)/i.test(normalized) || serviceType === "ferry_transfer") return "ferry";
  if (/(transfer|porto|hotel|auto ischia)/i.test(normalized)) return "road_transfer";
  return "unknown";
}

function buildParserLogs(selection: AgencyPdfParserSelectionResult, missingFields: string[]) {
  const topCandidates = selection.candidates.slice(0, 3).map((candidate) => `${candidate.key}=${candidate.score}:${candidate.mode}`);
  const logs = [
    `selected_parser=${selection.parserKey}`,
    `parser_mode=${selection.parserMode}`,
    `selected_score=${selection.score}`,
    `selection_confidence=${selection.selectionConfidence}`,
    `selection_reason=${selection.selectionReason}`,
    `top_candidates=${topCandidates.join(", ") || "n/a"}`,
    `parsed_services=${selection.parsed.parsed_services.length}`,
    `confidence=${selection.parsed.confidence_level}`
  ];
  if (selection.fallbackReason) logs.push(`fallback_reason=${selection.fallbackReason}`);
  if (selection.parsed.anomaly_message) logs.push(`anomaly=${selection.parsed.anomaly_message}`);
  if (missingFields.length > 0) logs.push(`missing_fields=${missingFields.join(",")}`);
  return logs;
}

function normalizeCustomerPhone(
  selection: AgencyPdfParserSelectionResult,
  transferParsed: AgencyPdfParserSelectionResult["parsed"],
  inboundParsed: ReturnType<typeof parseInboundEmail>
) {
  if (selection.parserKey === "agency_bus_operations") return null;
  const candidate = clean(transferParsed.ns_contact ?? inboundParsed.phone ?? null);
  if (!candidate) return null;
  if (candidate.replace(/\D/g, "") === INTERNAL_ITS_PHONE) return null;
  return candidate;
}

export function buildAgencyPdfPreview(input: AgencyPdfPreviewInput): AgencyPdfPreviewResult {
  const inboundParsed = parseInboundEmail([input.subject, input.bodyText ?? ""].filter(Boolean).join("\n"), "agency-default", input.extractedText);
  const selection = selectAgencyPdfParser({
    senderEmail: input.senderEmail,
    subject: input.subject,
    filename: input.filename,
    extractedText: input.extractedText
  });

  const transferParsed = selection.parsed;
  const arrivalService = transferParsed.parsed_services.find((service) => service.direction === "andata") ?? transferParsed.parsed_services[0] ?? null;
  const departureService = transferParsed.parsed_services.find((service) => service.direction === "ritorno") ?? null;
  const customer = splitCustomerName(transferParsed.first_beneficiary ?? inboundParsed.customer_name ?? null);

  const rawArrivalPlace = clean(
    arrivalService?.pickup_meeting_point ?? arrivalService?.origin ?? inboundParsed.pickup ?? inboundParsed.vessel ?? null
  );
  const hotelOrDestination = clean(arrivalService?.hotel_structure ?? arrivalService?.destination ?? inboundParsed.hotel ?? inboundParsed.dropoff ?? null);
  const notes = clean(
    [
      transferParsed.practice_number ? `Pratica ${transferParsed.practice_number}` : null,
      transferParsed.ns_reference ? `Riferimento ${transferParsed.ns_reference}` : null,
      transferParsed.program,
      transferParsed.anomaly_message
    ]
      .filter(Boolean)
      .join(" | ")
  );

  const sourceForDeduction = [
    input.subject,
    input.extractedText,
    arrivalService?.raw_detail_text,
    departureService?.raw_detail_text,
    inboundParsed.pickup,
    inboundParsed.dropoff
  ]
    .filter(Boolean)
    .join(" ");
  const deducedBookingKind = transferParsed.booking_kind ?? deduceBookingKind(sourceForDeduction);
  const deducedServiceType = transferParsed.service_type_code ?? deduceOperationalServiceType(sourceForDeduction, deducedBookingKind);
  const transportMode = deduceTransportMode(sourceForDeduction, deducedBookingKind, deducedServiceType);
  const arrivalPlace =
    deducedServiceType === "transfer_station_hotel" && transportMode === "train"
      ? "STAZIONE DI NAPOLI"
      : rawArrivalPlace;
  const transportReferenceOutward =
    clean(transferParsed.train_arrival_number ?? null) ??
    extractTransportReference(arrivalService?.raw_detail_text ?? arrivalService?.original_row_description ?? null);
  const transportReferenceReturn =
    clean(transferParsed.train_departure_number ?? null) ??
    extractTransportReference(departureService?.raw_detail_text ?? departureService?.original_row_description ?? null);
  const operationalOutwardTime =
    extractOperationalTime(arrivalService?.raw_detail_text, "outward") ??
    clean(transferParsed.train_arrival_time ?? null) ??
    clean(arrivalService?.service_time ?? inboundParsed.time ?? null);
  const operationalReturnTime =
    extractOperationalTime(departureService?.raw_detail_text, "return") ??
    clean(transferParsed.train_departure_time ?? null) ??
    clean(departureService?.service_time ?? inboundParsed.departure_time ?? null);
  const sourceTotalAmount = transferParsed.total_amount_practice ?? null;
  const sourcePricePerPax =
    sourceTotalAmount !== null && Number(transferParsed.pax ?? 0) > 0
      ? Number((sourceTotalAmount / Number(transferParsed.pax)).toFixed(2))
      : null;

  const agencyName = deriveAgencyName(input.senderEmail, input.subject, input.extractedText, input.headerText, selection);
  const extracted: AgencyPdfPreviewResult["extracted"] = {
    agency_name: agencyName,
    billing_party_name: deriveBillingPartyName(selection, transferParsed, input.extractedText, input.headerText, agencyName),
    booking_kind: deducedBookingKind,
    service_type: deducedServiceType,
    service_type_deduced: deduceServiceType(sourceForDeduction),
    customer_full_name: clean(transferParsed.customer_full_name ?? customer.fullName),
    customer_email: null,
    customer_phone: normalizeCustomerPhone(selection, transferParsed, inboundParsed),
    arrival_date: clean(arrivalService?.service_date ?? inboundParsed.date ?? null),
    outbound_time: operationalOutwardTime,
    departure_date: clean(departureService?.service_date ?? inboundParsed.departure_date ?? null),
    return_time: operationalReturnTime,
    transport_mode: transportMode,
    transport_reference_outward: transportReferenceOutward,
    transport_reference_return: transportReferenceReturn,
    arrival_place: arrivalPlace,
    hotel_or_destination: hotelOrDestination,
    passengers: transferParsed.pax ?? inboundParsed.pax ?? null,
    source_total_amount: sourceTotalAmount,
    source_price_per_pax: sourcePricePerPax,
    source_amount_currency: sourceTotalAmount !== null ? "EUR" : null,
    train_arrival_number: transportReferenceOutward,
    train_arrival_time: isTrainMode(transportMode) ? operationalOutwardTime : clean(transferParsed.train_arrival_time ?? null),
    train_departure_number: transportReferenceReturn,
    train_departure_time: isTrainMode(transportMode) ? operationalReturnTime : clean(transferParsed.train_departure_time ?? null),
    notes
  };

  const requiredFields: Array<keyof typeof extracted> = [
    "agency_name",
    "booking_kind",
    "customer_full_name",
    "arrival_date",
    "outbound_time",
    "arrival_place",
    "hotel_or_destination",
    "passengers"
  ];
  const fieldsFound = Object.entries(extracted)
    .filter(([, value]) => value !== null && value !== "")
    .map(([key]) => key);
  const missingFields = requiredFields.filter((field) => extracted[field] === null);
  const reliability =
    missingFields.length === 0 && transferParsed.confidence_level === "high"
      ? "high"
      : fieldsFound.length >= 6 && transferParsed.parsed_services.length > 0
        ? "medium"
        : "low";
  const reliabilityAdjusted =
    selection.parserMode === "dedicated"
      ? reliability
      : reliability === "high"
        ? "medium"
        : reliability;

  return {
    parser: {
      selected_key: selection.parserKey,
      mode: selection.parserMode,
      score: selection.score,
      selection_confidence: selection.selectionConfidence,
      selection_reason: selection.selectionReason,
      fallback_reason: selection.fallbackReason,
      candidates: selection.candidates
    },
    extracted_text_preview: input.extractedText.slice(0, 3000),
    extracted,
    fields_found: fieldsFound,
    missing_fields: missingFields,
    reliability: reliabilityAdjusted,
    parser_logs: buildParserLogs(selection, missingFields),
    raw: {
      inbound_parser: inboundParsed,
      transfer_parser: transferParsed
    }
  };
}
