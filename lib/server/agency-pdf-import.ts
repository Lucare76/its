import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { z } from "zod";
import { buildAgencyPdfPreview } from "@/lib/server/agency-pdf-preview";
import { ensureDefaultBusLotConfig } from "@/lib/server/bus-lot-configs";
import { canonicalizeKnownHotelName } from "@/lib/server/hotel-aliases";
import { auditLog } from "@/lib/server/ops-audit";
import { extractPdfHeaderTextFromBase64, extractPdfTextFromBase64 } from "@/lib/server/pdf-text";
import { tryMatchAndApplyPricing } from "@/lib/server/pricing-matching";

type AuthContext = {
  admin: any;
  user: { id?: string | null };
  membership: { tenant_id: string; role: string };
};

export type PdfImportMode = "preview" | "draft" | "final";

export type NormalizedPdfImport = {
  parser_key: string;
  parser_score: number;
  parsing_quality: "high" | "medium" | "low";
  agency_name: string | null;
  billing_party_name: string | null;
  external_reference: string | null;
  service_type: "transfer_station_hotel" | "transfer_airport_hotel" | "transfer_port_hotel" | "transfer_hotel_port" | "excursion" | "ferry_transfer" | "bus_line" | null;
  service_variant: "train_station_hotel" | "ferry_naples_transfer" | "auto_ischia_hotel" | null;
  transport_mode: "train" | "hydrofoil" | "ferry" | "road_transfer" | "bus" | "unknown" | null;
  transport_code: string | null;
  transport_reference_outward: string | null;
  transport_reference_return: string | null;
  arrival_transport_code: string | null;
  departure_transport_code: string | null;
  train_arrival_number: string | null;
  train_arrival_time: string | null;
  train_departure_number: string | null;
  train_departure_time: string | null;
  bus_city_origin: string | null;
  booking_kind: "transfer_port_hotel" | "transfer_airport_hotel" | "transfer_train_hotel" | "bus_city_hotel" | "excursion";
  service_type_deduced: "transfer" | "ferry" | "excursion" | "bus" | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  customer_full_name: string;
  customer_email: string | null;
  customer_phone: string;
  arrival_date: string;
  outbound_time: string | null;
  departure_date: string | null;
  return_time: string | null;
  arrival_place: string | null;
  hotel_or_destination: string | null;
  passengers: number;
  source_total_amount_cents: number | null;
  source_price_per_pax_cents: number | null;
  source_amount_currency: string | null;
  notes: string;
  fields_found: string[];
  missing_fields: string[];
  include_ferry_tickets: boolean;
  carrier_company: string | null;
  pdf_hash: string;
  text_hash: string;
  dedupe_key: string;
  dedupe_components: {
    practice_number: string | null;
    ns_reference: string | null;
    customer_name: string;
    arrival_date: string;
    hotel: string | null;
    pdf_hash: string;
    text_hash: string;
    composite_key: string;
  };
  parser_logs: string[];
};

type PossibleExistingMatch = {
  service_id: string;
  status: string;
  is_draft: boolean;
  customer_name: string | null;
  phone: string | null;
  date: string | null;
  match_reason: "practice_number" | "phone" | "customer_name";
};

function normalizeReviewedServiceType(
  value: Partial<z.infer<typeof pdfImportReviewSchema>>["service_type"]
): NormalizedPdfImport["service_type"] {
  return emptyToNull(value) as NormalizedPdfImport["service_type"];
}

export const pdfImportReviewSchema = z.object({
  customer_full_name: z.string().trim().max(240).optional().nullable(),
  customer_phone: z.string().trim().max(60).optional().nullable(),
  customer_email: z.string().trim().email().max(160).optional().nullable().or(z.literal("")),
  billing_party_name: z.string().trim().max(240).optional().nullable(),
  arrival_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  outbound_time: z.string().regex(/^([01]?\d|2[0-3]):([0-5]\d)$/).optional().nullable().or(z.literal("")),
  departure_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable().or(z.literal("")),
  return_time: z.string().regex(/^([01]?\d|2[0-3]):([0-5]\d)$/).optional().nullable().or(z.literal("")),
  arrival_place: z.string().trim().max(200).optional().nullable(),
  hotel_or_destination: z.string().trim().max(200).optional().nullable(),
  passengers: z.coerce.number().int().min(1).max(16),
  source_total_amount_cents: z.coerce.number().int().min(0).optional().nullable(),
  source_price_per_pax_cents: z.coerce.number().int().min(0).optional().nullable(),
  source_amount_currency: z.string().trim().length(3).optional().nullable().or(z.literal("")),
  booking_kind: z.enum(["transfer_port_hotel", "transfer_airport_hotel", "transfer_train_hotel", "bus_city_hotel", "excursion"]),
  service_type: z.enum(["transfer_station_hotel", "transfer_airport_hotel", "transfer_port_hotel", "transfer_hotel_port", "excursion", "ferry_transfer", "bus_line"]).nullable(),
  transport_mode: z.enum(["train", "hydrofoil", "ferry", "road_transfer", "bus", "unknown"]).nullable().optional(),
  train_arrival_number: z.string().trim().max(80).optional().nullable(),
  train_departure_number: z.string().trim().max(80).optional().nullable(),
  bus_city_origin: z.string().trim().max(120).optional().nullable(),
  practice_number: z.string().trim().max(120).optional().nullable(),
  ns_reference: z.string().trim().max(160).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable()
});

type ParsedUpload = {
  extractedText: string;
  preview: ReturnType<typeof buildAgencyPdfPreview>;
  normalized: NormalizedPdfImport;
};

function clean(value?: string | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function slug(value?: string | null) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function hashString(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function marker(key: string, value?: string | null) {
  const normalized = clean(value);
  return normalized ? `[${key}:${normalized}]` : null;
}

function normalizePhone(value?: string | null) {
  return clean(value) ?? "N/D";
}

function emptyToNull(value?: string | null) {
  const normalized = clean(value);
  return normalized && normalized.length > 0 ? normalized : null;
}

function isIsoDate(value?: string | null) {
  if (!value) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeTime(value?: string | null) {
  const match = String(value ?? "").match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function normalizeOptionalDate(value?: string | null) {
  return isIsoDate(value) ? String(value) : null;
}

function shouldRunHeaderOcr(extractedText: string) {
  const normalized = clean(extractedText);
  if (!normalized) return true;

  const lower = normalized.toLowerCase();
  const hasCoreBusinessSignals =
    /pratica\s*\d{2}\/\d{6}/i.test(normalized) ||
    /\b(?:totale|beneficiari|stato prenotazione|ref\.)\b/i.test(normalized) ||
    /\b(?:transfer|tsf per hotel|tour dell'isola|snav|medmar|alilauro)\b/i.test(normalized);
  const looksLikeImageOnlyForm =
    /nome:\s*cognome:\s*data di arrivo ad ischia:/i.test(lower) ||
    /hotel di destinazione:\s*scegli l['’]orario di partenza/i.test(lower);

  if (looksLikeImageOnlyForm) return true;
  if (hasCoreBusinessSignals && normalized.length >= 180) return false;
  return normalized.length < 180;
}

function eurosToCents(value?: number | null) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function extractTransportCode(value?: string | null) {
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

function deriveTransportCodes(preview: ReturnType<typeof buildAgencyPdfPreview>) {
  const arrivalService =
    preview.raw.transfer_parser.parsed_services.find((item) => item.direction === "andata") ??
    preview.raw.transfer_parser.parsed_services[0] ??
    null;
  const departureService = preview.raw.transfer_parser.parsed_services.find((item) => item.direction === "ritorno") ?? null;
  const arrivalTransportCode = extractTransportCode(arrivalService?.raw_detail_text ?? arrivalService?.original_row_description ?? null);
  const departureTransportCode = extractTransportCode(
    departureService?.raw_detail_text ?? departureService?.original_row_description ?? null
  );
  return {
    arrivalTransportCode,
    departureTransportCode,
    combinedTransportCode:
      arrivalTransportCode && departureTransportCode
        ? `${arrivalTransportCode} / ${departureTransportCode}`
        : arrivalTransportCode ?? departureTransportCode
  };
}

function deriveServiceVariant(preview: ReturnType<typeof buildAgencyPdfPreview>, extractedText: string): NormalizedPdfImport["service_variant"] {
  const source = [
    extractedText,
    preview.raw.transfer_parser.service_rows.map((item) => item.row_text).join(" "),
    preview.raw.transfer_parser.parsed_services.map((item) => item.original_row_description ?? "").join(" "),
    preview.raw.transfer_parser.parsed_services.map((item) => item.raw_detail_text).join(" ")
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/(transfer stazione ?\/ ?hotel|transfer hotel ?\/ ?stazione|italo|stazione centrale|napoli centrale)/i.test(source)) {
    return "train_station_hotel";
  }
  if (/(traghetto napoli \+ trs h\. ischia|trs h\. ischia \+ traghetto napoli|passaggio marittimo adulto|medmar|porta di massa)/i.test(source)) {
    return "ferry_naples_transfer";
  }
  if (/(auto ischia\/hotel|auto ischia \/ hotel|auto hotel \/ ischia|aliscafo da napoli \+ trs h\. ischia|trs h\.ischia \+ aliscafo per napoli|snav)/i.test(source)) {
    return "auto_ischia_hotel";
  }
  return null;
}

function variantNotes(variant: NormalizedPdfImport["service_variant"]) {
  if (variant === "train_station_hotel") return "Tipo servizio: transfer stazione/hotel";
  if (variant === "ferry_naples_transfer") return "Tipo servizio: traghetto Napoli + transfer";
  if (variant === "auto_ischia_hotel") return "Tipo servizio: auto Ischia/hotel A/R";
  return null;
}

function deduceOperationalServiceType(preview: ReturnType<typeof buildAgencyPdfPreview>) {
  const source = [
    preview.extracted.service_type_deduced,
    preview.raw.transfer_parser.parsed_services.map((item) => item.original_row_description).join(" "),
    preview.raw.transfer_parser.parsed_services.map((item) => item.raw_detail_text).join(" ")
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const hasTransfer = /(transfer|auto ischia|auto hotel|trs h\.? ischia)/i.test(source);
  const hasExcursion = /(excursion|escursione|tour)/i.test(source);
  const hasFerry = /(ferry|traghetto|aliscafo|passaggio marittimo|caremar|medmar|snav|alilauro)/i.test(source);
  const hasBus = /(bus|pullman|coach)/i.test(source) || preview.extracted.booking_kind === "bus_city_hotel";

  if (hasBus) return "bus";
  if (hasExcursion && !hasTransfer) return "excursion";
  if (hasTransfer) return "transfer";
  if (hasFerry) return "ferry";
  return preview.extracted.service_type_deduced;
}

function baseServiceType(normalized: Pick<NormalizedPdfImport, "booking_kind" | "service_type">) {
  return normalized.booking_kind === "bus_city_hotel" || normalized.service_type === "bus_line" ? "bus_tour" : "transfer";
}

function buildNormalizedImport(preview: ReturnType<typeof buildAgencyPdfPreview>, extractedText: string, pdfBytes: Buffer): NormalizedPdfImport {
  const practiceNumber = clean(preview.raw.transfer_parser.practice_number);
  const nsReference = clean(preview.raw.transfer_parser.ns_reference);
  const customerName = clean(preview.extracted.customer_full_name) ?? "Cliente da verificare";
  const arrivalService =
    preview.raw.transfer_parser.parsed_services.find((item) => item.direction === "andata") ??
    preview.raw.transfer_parser.parsed_services[0] ??
    null;
  const departureService = preview.raw.transfer_parser.parsed_services.find((item) => item.direction === "ritorno") ?? null;
  const arrivalDate = isIsoDate(preview.extracted.arrival_date) ? String(preview.extracted.arrival_date) : new Date().toISOString().slice(0, 10);
  const outboundTime = normalizeTime(
    extractOperationalTime(arrivalService?.raw_detail_text, "outward") ??
    clean(preview.extracted.train_arrival_time) ??
    preview.extracted.outbound_time
  );
  const departureDate = isIsoDate(preview.extracted.departure_date) ? String(preview.extracted.departure_date) : null;
  const returnTimeRaw =
    extractOperationalTime(departureService?.raw_detail_text, "return") ??
    clean(preview.extracted.train_departure_time) ??
    clean(preview.extracted.return_time);
  const returnTime = returnTimeRaw ? normalizeTime(returnTimeRaw) : null;
  const hotel = clean(preview.extracted.hotel_or_destination);
  const textHash = hashString(extractedText).slice(0, 24);
  const pdfHash = createHash("sha256").update(pdfBytes).digest("hex").slice(0, 24);
  const compositeKey = slug(`${customerName}|${arrivalDate}|${hotel ?? "hotel-nd"}`) || "pdf-import";
  const dedupeKey = hashString([practiceNumber, nsReference, customerName, arrivalDate, hotel, textHash].filter(Boolean).join("|")).slice(0, 24);
  const serviceTypeDeduced = deduceOperationalServiceType(preview);
  const bookingKind = preview.extracted.booking_kind ?? "transfer_port_hotel";
  const includeFerryTickets = serviceTypeDeduced === "ferry" || /(traghetto|aliscafo|passaggio marittimo|caremar|medmar|snav|alilauro)/i.test(extractedText);
  const carrierCompany = clean(preview.raw.transfer_parser.parsed_services[0]?.carrier_company ?? null);
  const externalReference = practiceNumber ?? nsReference ?? compositeKey;
  const transportCodes = deriveTransportCodes(preview);
  const serviceVariant = deriveServiceVariant(preview, extractedText);
  const notes = clean(
    [
      preview.extracted.notes,
      variantNotes(serviceVariant),
      transportCodes.arrivalTransportCode ? `Treno andata ${transportCodes.arrivalTransportCode}` : null,
      transportCodes.departureTransportCode ? `Treno ritorno ${transportCodes.departureTransportCode}` : null
    ]
      .filter(Boolean)
      .join(" | ")
  ) ?? "Import PDF agenzia";

  return {
    parser_key: preview.parser.selected_key,
    parser_score: preview.parser.score,
    parsing_quality: preview.reliability,
    agency_name: clean(preview.extracted.agency_name),
    external_reference: externalReference,
    service_type: preview.extracted.service_type,
    service_variant: serviceVariant,
    transport_mode: preview.extracted.transport_mode,
    transport_code: transportCodes.combinedTransportCode,
    transport_reference_outward: clean(preview.extracted.transport_reference_outward) ?? transportCodes.arrivalTransportCode,
    transport_reference_return: clean(preview.extracted.transport_reference_return) ?? transportCodes.departureTransportCode,
    arrival_transport_code: transportCodes.arrivalTransportCode,
    departure_transport_code: transportCodes.departureTransportCode,
    train_arrival_number: clean(preview.extracted.train_arrival_number) ?? transportCodes.arrivalTransportCode,
    train_arrival_time: extractOperationalTime(arrivalService?.raw_detail_text, "outward") ?? clean(preview.extracted.train_arrival_time),
    train_departure_number: clean(preview.extracted.train_departure_number) ?? transportCodes.departureTransportCode,
    train_departure_time: extractOperationalTime(departureService?.raw_detail_text, "return") ?? clean(preview.extracted.train_departure_time),
    bus_city_origin: clean(preview.extracted.bus_city_origin),
    booking_kind: bookingKind,
    service_type_deduced: serviceTypeDeduced,
    customer_first_name: null,
    customer_last_name: null,
      customer_full_name: customerName,
      customer_email: clean(preview.extracted.customer_email),
      billing_party_name: clean(preview.extracted.billing_party_name),
      customer_phone: normalizePhone(preview.extracted.customer_phone),
    arrival_date: arrivalDate,
    outbound_time: outboundTime,
    departure_date: departureDate,
    return_time: returnTime,
    arrival_place: clean(preview.extracted.arrival_place),
    hotel_or_destination: hotel,
    passengers: Math.max(1, Math.min(16, Number(preview.extracted.passengers ?? 1))),
    source_total_amount_cents: eurosToCents(preview.extracted.source_total_amount),
    source_price_per_pax_cents: eurosToCents(preview.extracted.source_price_per_pax),
    source_amount_currency: clean(preview.extracted.source_amount_currency) ?? "EUR",
    notes,
    fields_found: preview.fields_found,
    missing_fields: preview.missing_fields,
    include_ferry_tickets: includeFerryTickets,
    carrier_company: carrierCompany,
    pdf_hash: pdfHash,
    text_hash: textHash,
    dedupe_key: dedupeKey,
    dedupe_components: {
      practice_number: practiceNumber,
      ns_reference: nsReference,
      customer_name: customerName,
      arrival_date: arrivalDate,
      hotel,
      pdf_hash: pdfHash,
      text_hash: textHash,
      composite_key: compositeKey
    },
    parser_logs: preview.parser_logs
  };
}

function computeExternalReference(practiceNumber?: string | null, nsReference?: string | null, compositeKey?: string | null) {
  return clean(practiceNumber) ?? clean(nsReference) ?? clean(compositeKey) ?? "pdf-import";
}

function buildEffectiveNormalizedImport(
  base: NormalizedPdfImport,
  reviewed?: Partial<z.infer<typeof pdfImportReviewSchema>> | null
): NormalizedPdfImport {
  if (!reviewed) return base;

  const customerFullName = emptyToNull(reviewed.customer_full_name) ?? base.customer_full_name;
  const arrivalDate = reviewed.arrival_date ? String(reviewed.arrival_date) : base.arrival_date;
  const hotel = emptyToNull(reviewed.hotel_or_destination) ?? base.hotel_or_destination;
  const practiceNumber = emptyToNull(reviewed.practice_number) ?? base.dedupe_components.practice_number;
  const nsReference = emptyToNull(reviewed.ns_reference) ?? base.dedupe_components.ns_reference;
  const compositeKey = slug(`${customerFullName}|${arrivalDate}|${hotel ?? "hotel-nd"}`) || "pdf-import";
  const dedupeKey = hashString([practiceNumber, nsReference, customerFullName, arrivalDate, hotel, base.text_hash].filter(Boolean).join("|")).slice(0, 24);
  const externalReference = computeExternalReference(practiceNumber, nsReference, compositeKey);
  const passengerCount = Math.max(1, Math.min(16, Number(reviewed.passengers ?? base.passengers)));
    const effective: NormalizedPdfImport = {
      ...base,
      external_reference: externalReference,
      booking_kind: reviewed.booking_kind ?? base.booking_kind,
    service_type: normalizeReviewedServiceType(reviewed.service_type) ?? base.service_type,
    transport_mode: reviewed.transport_mode !== undefined ? reviewed.transport_mode : base.transport_mode,
      customer_first_name: null,
      customer_last_name: null,
      customer_full_name: customerFullName,
      customer_email: emptyToNull(reviewed.customer_email) ?? base.customer_email,
      billing_party_name: emptyToNull(reviewed.billing_party_name) ?? base.billing_party_name,
      customer_phone: normalizePhone(reviewed.customer_phone ?? base.customer_phone),
    arrival_date: arrivalDate,
    outbound_time: reviewed.outbound_time ? normalizeTime(reviewed.outbound_time) : base.outbound_time,
    departure_date:
      reviewed.departure_date !== undefined ? normalizeOptionalDate(reviewed.departure_date) : base.departure_date,
    return_time:
      reviewed.return_time !== undefined
        ? normalizeOptionalDate(reviewed.departure_date) || clean(reviewed.return_time)
          ? normalizeTime(reviewed.return_time)
          : null
        : base.return_time,
    train_arrival_number: emptyToNull(reviewed.train_arrival_number) ?? base.train_arrival_number,
    train_departure_number: emptyToNull(reviewed.train_departure_number) ?? base.train_departure_number,
    bus_city_origin: emptyToNull(reviewed.bus_city_origin) ?? base.bus_city_origin,
    transport_reference_outward: emptyToNull(reviewed.train_arrival_number) ?? base.transport_reference_outward,
    transport_reference_return: emptyToNull(reviewed.train_departure_number) ?? base.transport_reference_return,
    arrival_place: emptyToNull(reviewed.arrival_place) ?? base.arrival_place,
    hotel_or_destination: hotel,
    passengers: passengerCount,
    source_total_amount_cents:
      reviewed.source_total_amount_cents !== undefined ? reviewed.source_total_amount_cents : base.source_total_amount_cents,
    source_price_per_pax_cents:
      reviewed.source_price_per_pax_cents !== undefined ? reviewed.source_price_per_pax_cents : base.source_price_per_pax_cents,
    source_amount_currency:
      reviewed.source_amount_currency !== undefined
        ? emptyToNull(reviewed.source_amount_currency) ?? null
        : base.source_amount_currency,
    notes: emptyToNull(reviewed.notes) ?? base.notes,
    include_ferry_tickets:
      (reviewed.service_type ?? base.service_type) === "ferry_transfer" ||
      (reviewed.transport_mode ?? base.transport_mode) === "ferry" ||
      (reviewed.transport_mode ?? base.transport_mode) === "hydrofoil" ||
      base.include_ferry_tickets,
    dedupe_key: dedupeKey,
    dedupe_components: {
      ...base.dedupe_components,
      practice_number: practiceNumber,
      ns_reference: nsReference,
      customer_name: customerFullName,
      arrival_date: arrivalDate,
      hotel,
      composite_key: compositeKey
    }
  };

  const fieldsFound = new Set(base.fields_found);
  const missingFields = new Set(base.missing_fields);
  const resolvedMap: Array<[string, string | number | null]> = [
      ["customer_full_name", effective.customer_full_name],
      ["billing_party_name", effective.billing_party_name],
      ["customer_phone", effective.customer_phone],
    ["arrival_date", effective.arrival_date],
    ["outbound_time", effective.outbound_time],
    ["arrival_place", effective.arrival_place],
    ["hotel_or_destination", effective.hotel_or_destination],
    ["passengers", effective.passengers],
    ["source_total_amount_cents", effective.source_total_amount_cents],
    ["source_price_per_pax_cents", effective.source_price_per_pax_cents],
    ["train_arrival_number", effective.train_arrival_number],
    ["train_departure_number", effective.train_departure_number],
    ["bus_city_origin", effective.bus_city_origin],
    ["notes", effective.notes]
  ];
  for (const [key, value] of resolvedMap) {
    if (value !== null && value !== "" && value !== "N/D") {
      fieldsFound.add(key);
      missingFields.delete(key);
    }
  }
  effective.fields_found = [...fieldsFound];
  effective.missing_fields = [...missingFields];
  return effective;
}

async function resolveHotelId(admin: any, tenantId: string, hotelName: string | null) {
  const { data: hotelsData, error: hotelsError } = await admin
    .from("hotels")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .limit(500);
  if (hotelsError) {
    throw new Error(`Hotel lookup failed: ${hotelsError.message}`);
  }
  let hotels = (hotelsData ?? []) as Array<{ id: string; name: string }>;
  const canonicalHotelName = canonicalizeKnownHotelName(hotelName);
  const normalizedHotel = clean(canonicalHotelName)?.toLowerCase() ?? null;

  const matched =
    hotels.find((hotel) => normalizedHotel && hotel.name.toLowerCase() === normalizedHotel) ??
    hotels.find((hotel) => normalizedHotel && hotel.name.toLowerCase().includes(normalizedHotel)) ??
    hotels.find((hotel) => normalizedHotel && normalizedHotel.includes(hotel.name.toLowerCase()));
  if (matched?.id) return matched.id;

  let createHotelAttempt = await admin
    .from("hotels")
    .insert({
      tenant_id: tenantId,
      name: canonicalHotelName ?? "Hotel da verificare",
      normalized_name: slug(canonicalHotelName ?? "hotel da verificare"),
      address: "Ischia",
      city: "Ischia",
      zone: "Ischia Porto",
      lat: 40.7405,
      lng: 13.9438,
      source: "pdf_import",
      is_active: true
    })
    .select("id")
    .single();

  if (createHotelAttempt.error || !createHotelAttempt.data?.id) {
    createHotelAttempt = await admin
      .from("hotels")
      .insert({
        tenant_id: tenantId,
        name: hotelName ?? "Hotel da verificare",
        address: "Ischia",
        zone: "Ischia Porto",
        lat: 40.7405,
        lng: 13.9438
      })
      .select("id")
      .single();
  }

  return createHotelAttempt.data?.id ?? null;
}

function buildServiceNotes(
  normalized: NormalizedPdfImport,
  options: { mode: "draft" | "final" | "ignored"; hasManualReview?: boolean }
) {
  const importState =
    options.mode === "final" ? "imported" : options.mode === "ignored" ? "ignored" : "draft";
  return [
    options.mode === "draft"
      ? "[needs_review] Draft creato da PDF preview"
      : options.mode === "ignored"
        ? "[pdf_import] Draft PDF scartato"
        : "[pdf_import] Booking finale creato da PDF",
    marker("source", "pdf"),
    marker("import_mode", options.mode === "final" ? "final" : "draft"),
    marker("import_state", importState),
    marker("manual_review", options.hasManualReview ? "true" : "false"),
    marker("imported_from_pdf_preview", "true"),
    marker("parser", normalized.parser_key),
    marker("parsing_quality", normalized.parsing_quality),
    marker("billing_party_name", normalized.billing_party_name),
    marker("external_ref", normalized.external_reference),
    marker("service_variant", normalized.service_variant),
    marker("service_type_code", normalized.service_type),
    marker("transport_mode", normalized.transport_mode),
    marker("source_total_amount_cents", normalized.source_total_amount_cents ? String(normalized.source_total_amount_cents) : null),
    marker("source_price_per_pax_cents", normalized.source_price_per_pax_cents ? String(normalized.source_price_per_pax_cents) : null),
    marker("source_amount_currency", normalized.source_amount_currency),
    marker("transport_code", normalized.transport_code),
    marker("transport_ref_out", normalized.transport_reference_outward),
    marker("transport_ref_ret", normalized.transport_reference_return),
    marker("arrival_transport_code", normalized.arrival_transport_code),
    marker("departure_transport_code", normalized.departure_transport_code),
    marker("train_arrival_number", normalized.train_arrival_number),
    marker("train_departure_number", normalized.train_departure_number),
    marker("practice", normalized.dedupe_components.practice_number),
    marker("ns_ref", normalized.dedupe_components.ns_reference),
    marker("pdf_hash", normalized.pdf_hash),
    marker("pdf_text_hash", normalized.text_hash),
    marker("pdf_dedupe", normalized.dedupe_key),
    marker("pdf_composite", normalized.dedupe_components.composite_key),
    normalized.notes,
    normalized.arrival_place ? `pickup/porto: ${normalized.arrival_place}` : null,
    normalized.hotel_or_destination ? `hotel/destinazione: ${normalized.hotel_or_destination}` : null
  ]
    .filter(Boolean)
    .join(" | ");
}

async function findServiceByPattern(admin: any, tenantId: string, pattern: string) {
  const { data } = await admin
    .from("services")
    .select("id, is_draft, inbound_email_id, status, notes")
    .eq("tenant_id", tenantId)
    .ilike("notes", `%${pattern}%`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

async function findExistingPdfImport(admin: any, tenantId: string, normalized: NormalizedPdfImport) {
  const patterns = [
    normalized.dedupe_components.practice_number ? `[practice:${normalized.dedupe_components.practice_number}]` : null,
    `[pdf_hash:${normalized.pdf_hash}]`,
    `[pdf_text_hash:${normalized.text_hash}]`,
    `[pdf_dedupe:${normalized.dedupe_key}]`,
    `[pdf_composite:${normalized.dedupe_components.composite_key}]`
  ].filter(Boolean) as string[];

  for (const pattern of patterns) {
    const service = await findServiceByPattern(admin, tenantId, pattern);
    if (service?.id) {
      return { service, pattern };
    }
  }
  return { service: null, pattern: null };
}

async function findPotentialExistingMatches(admin: any, tenantId: string, normalized: NormalizedPdfImport): Promise<PossibleExistingMatch[]> {
  const byId = new Map<string, PossibleExistingMatch>();

  const addRows = (rows: Array<Record<string, any>> | null | undefined, reason: PossibleExistingMatch["match_reason"]) => {
    for (const row of rows ?? []) {
      const id = String(row.id ?? "");
      if (!id || byId.has(id)) continue;
      byId.set(id, {
        service_id: id,
        status: String(row.status ?? ""),
        is_draft: Boolean(row.is_draft),
        customer_name: clean(String(row.customer_name ?? "")),
        phone: clean(String(row.phone ?? "")),
        date: clean(String(row.date ?? "")),
        match_reason: reason
      });
    }
  };

  if (normalized.dedupe_components.practice_number) {
    const { data } = await admin
      .from("services")
      .select("id, status, is_draft, customer_name, phone, date")
      .eq("tenant_id", tenantId)
      .ilike("notes", `%[practice:${normalized.dedupe_components.practice_number}]%`)
      .order("created_at", { ascending: false })
      .limit(5);
    addRows(data as Array<Record<string, any>> | undefined, "practice_number");
  }

  if (normalized.customer_phone && normalized.customer_phone !== "N/D") {
    const { data } = await admin
      .from("services")
      .select("id, status, is_draft, customer_name, phone, date")
      .eq("tenant_id", tenantId)
      .eq("phone", normalized.customer_phone)
      .order("created_at", { ascending: false })
      .limit(5);
    addRows(data as Array<Record<string, any>> | undefined, "phone");
  }

  if (normalized.customer_full_name && normalized.customer_full_name !== "Cliente da verificare") {
    const { data } = await admin
      .from("services")
      .select("id, status, is_draft, customer_name, phone, date")
      .eq("tenant_id", tenantId)
      .ilike("customer_name", normalized.customer_full_name)
      .order("created_at", { ascending: false })
      .limit(5);
    addRows(data as Array<Record<string, any>> | undefined, "customer_name");
  }

  return Array.from(byId.values()).slice(0, 8);
}

function buildPricingSourceText(sourceParts: Array<string | null | undefined>, normalized?: NormalizedPdfImport | null) {
  const hints: string[] = [];
  if (normalized?.booking_kind === "transfer_train_hotel") {
    hints.push("transfer stazione hotel", "transfer hotel stazione", "treno stazione hotel");
  }
  if (normalized?.booking_kind === "transfer_port_hotel") {
    hints.push("transfer porto hotel", "transfer hotel porto");
  }
  if (normalized?.arrival_place) hints.push(normalized.arrival_place);
  if (normalized?.hotel_or_destination) hints.push(normalized.hotel_or_destination);
  if (normalized?.transport_code) hints.push(normalized.transport_code);
  if (normalized?.transport_reference_outward) hints.push(normalized.transport_reference_outward);
  if (normalized?.transport_reference_return) hints.push(normalized.transport_reference_return);
  if (normalized?.arrival_transport_code) hints.push(normalized.arrival_transport_code);
  if (normalized?.departure_transport_code) hints.push(normalized.departure_transport_code);
  if (normalized?.service_variant === "train_station_hotel") {
    hints.push("service variant train station hotel", "transfer stazione hotel", "italo stazione hotel");
  }
  if (normalized?.service_variant === "ferry_naples_transfer") {
    hints.push("service variant ferry naples transfer", "traghetto napoli transfer", "passaggio marittimo", "medmar porta di massa");
  }
  if (normalized?.service_variant === "auto_ischia_hotel") {
    hints.push("service variant auto ischia hotel", "auto ischia hotel", "auto hotel ischia", "snav aliscafo");
  }
  return [...sourceParts.filter(Boolean), ...hints].join("\n").trim();
}

function buildParsedJson(
  source: { fromEmail: string; subject: string; bodyText: string; filename: string; sizeBytes: number },
  parsed: ParsedUpload,
  mode: PdfImportMode,
  outcome: string,
  linkedServiceId?: string | null,
  possibleExistingMatches?: PossibleExistingMatch[]
) {
  return {
    source: "pdf-import-controlled",
    from_email: source.fromEmail,
    subject: source.subject,
    received_at: new Date().toISOString(),
    review_status: mode === "preview" ? "preview" : outcome === "imported" ? "ready_operational" : "needs_review",
    attachments: [
      {
        filename: source.filename,
        mime_type: "application/pdf",
        size_bytes: source.sizeBytes,
        has_content: true
      }
    ],
    pdf_parser: {
      key: parsed.normalized.parser_key,
      mode: parsed.preview.parser.mode,
      score: parsed.normalized.parser_score,
      selection_confidence: parsed.preview.parser.selection_confidence,
      selection_reason: parsed.preview.parser.selection_reason,
      fallback_reason: parsed.preview.parser.fallback_reason,
      candidates: parsed.preview.parser.candidates
    },
    parser_suggestions: parsed.preview.raw.inbound_parser,
    pdf_import: {
      import_mode: mode,
      import_state: outcome,
      parser_key: parsed.normalized.parser_key,
      parsing_quality: parsed.normalized.parsing_quality,
      fields_found: parsed.normalized.fields_found,
      missing_fields: parsed.normalized.missing_fields,
      parser_logs: parsed.normalized.parser_logs,
      raw_transfer_parser: parsed.preview.raw.transfer_parser,
      dedupe: {
        key: parsed.normalized.dedupe_key,
        external_reference: parsed.normalized.external_reference,
        ...parsed.normalized.dedupe_components
      },
      original_normalized: parsed.normalized,
      normalized: parsed.normalized,
      effective_normalized: parsed.normalized,
      reviewed_values: null,
      has_manual_review: false,
      reviewed_by: null,
      reviewed_at: null,
      linked_service_id: linkedServiceId ?? null,
      possible_existing_matches: possibleExistingMatches ?? []
    }
  };
}

function requiresManualPdfReview(normalized: NormalizedPdfImport) {
  const missingCriticalField =
    !normalized.customer_full_name ||
    normalized.customer_full_name === "Cliente da verificare" ||
    !normalized.arrival_date ||
    !normalized.passengers ||
    (normalized.booking_kind !== "excursion" && !normalized.hotel_or_destination && !normalized.arrival_place);

  return normalized.parsing_quality !== "high" || missingCriticalField;
}

function shouldAlwaysCreatePdfDraft() {
  return true;
}

function buildServicePayload(
  normalized: NormalizedPdfImport,
  params: {
    tenantId: string;
    userId: string | null;
    inboundEmailId: string | null;
    hotelId: string;
    isDraft: boolean;
    status: "needs_review" | "new";
    importMode: "draft" | "final";
    hasManualReview: boolean;
  }
) {
  return {
    tenant_id: params.tenantId,
    inbound_email_id: params.inboundEmailId,
    is_draft: params.isDraft,
    date: normalized.arrival_date,
    time: normalized.outbound_time ?? "00:00",
    service_type: baseServiceType(normalized),
    direction: "arrival" as const,
    vessel: normalized.carrier_company ?? normalized.arrival_place ?? "Transfer da PDF",
    pax: normalized.passengers,
    hotel_id: params.hotelId,
    customer_name: normalized.customer_full_name,
    billing_party_name: normalized.billing_party_name,
    outbound_time: normalized.outbound_time,
    return_time: normalized.return_time,
    source_total_amount_cents: normalized.source_total_amount_cents,
    source_price_per_pax_cents: normalized.source_price_per_pax_cents,
    source_amount_currency: normalized.source_amount_currency,
    phone: normalized.customer_phone,
    notes: buildServiceNotes(normalized, { mode: params.importMode, hasManualReview: params.hasManualReview }),
    status: params.status,
    created_by_user_id: params.userId,
    booking_service_kind: normalized.booking_kind,
    service_type_code: normalized.service_type,
    customer_first_name: null,
    customer_last_name: null,
    customer_email: normalized.customer_email,
    arrival_date: normalized.arrival_date,
    arrival_time: normalized.outbound_time ?? "00:00",
    departure_date: normalized.departure_date,
    departure_time: normalized.return_time,
    transport_code: normalized.transport_code,
    train_arrival_number: normalized.train_arrival_number,
    train_arrival_time: null,
    train_departure_number: normalized.train_departure_number,
    train_departure_time: null,
    bus_city_origin: normalized.bus_city_origin,
    include_ferry_tickets: normalized.include_ferry_tickets,
    ferry_details: {
      transport_mode: normalized.transport_mode,
      arrival_place: normalized.arrival_place,
      carrier_company: normalized.carrier_company,
      transport_reference_outward: normalized.transport_reference_outward,
      transport_reference_return: normalized.transport_reference_return,
      arrival_transport_code: normalized.arrival_transport_code,
      departure_transport_code: normalized.departure_transport_code
    },
    excursion_details: {
      source: "pdf",
      import_mode: params.importMode,
      external_reference: normalized.external_reference,
      reviewed: params.hasManualReview
    }
  };
}

export async function parseAgencyPdfUpload(input: {
  senderEmail: string;
  subject: string;
  filename: string;
  bodyText?: string | null;
  fileBytes: Buffer;
}): Promise<ParsedUpload> {
  const base64 = input.fileBytes.toString("base64");
  const extractedText = await extractPdfTextFromBase64(base64);
  const headerText = shouldRunHeaderOcr(extractedText) ? await extractPdfHeaderTextFromBase64(base64) : null;
  const preview = buildAgencyPdfPreview({
    senderEmail: input.senderEmail,
    subject: input.subject,
    filename: input.filename,
    bodyText: input.bodyText ?? "",
    extractedText,
    headerText
  });
  const normalized = buildNormalizedImport(preview, extractedText, input.fileBytes);
  return { extractedText, preview, normalized };
}

export async function createDraftFromPdfUpload(auth: AuthContext, input: {
  senderEmail: string;
  subject: string;
  filename: string;
  bodyText?: string | null;
  fileBytes: Buffer;
  fileSize: number;
}) {
  const parsed = await parseAgencyPdfUpload(input);
  const tenantId = auth.membership.tenant_id;
  const dedupeHit = await findExistingPdfImport(auth.admin, tenantId, parsed.normalized);
  if (dedupeHit.service?.id) {
    if (dedupeHit.service.is_draft && dedupeHit.service.inbound_email_id) {
      const possibleExistingMatches = await findPotentialExistingMatches(auth.admin, tenantId, parsed.normalized);
      const refreshedParsedJson = buildParsedJson(
        {
          fromEmail: input.senderEmail,
          subject: input.subject,
          bodyText: input.bodyText ?? "",
          filename: input.filename,
          sizeBytes: input.fileSize
        },
        parsed,
        "draft",
        "draft",
        dedupeHit.service.id,
        possibleExistingMatches
      );

      const inboundRefresh = await auth.admin
        .from("inbound_emails")
        .update({
          from_email: input.senderEmail,
          subject: input.subject,
          body_text: input.bodyText ?? "",
          raw_text: input.bodyText ?? "",
          raw_json: { source: "pdf-import-controlled", filename: input.filename, size_bytes: input.fileSize, refreshed: true },
          extracted_text: parsed.extractedText || null,
          parsed_json: refreshedParsedJson
        })
        .eq("tenant_id", tenantId)
        .eq("id", dedupeHit.service.inbound_email_id);

      if (inboundRefresh.error) {
        throw new Error(inboundRefresh.error.message);
      }

      await syncDraftServiceFromNormalized(auth, dedupeHit.service.inbound_email_id, parsed.normalized, refreshedParsedJson);

      auditLog({
        event: "pdf_import_draft_refreshed",
        tenantId,
        userId: auth.user.id ?? null,
        role: auth.membership.role,
        serviceId: dedupeHit.service.id,
        inboundEmailId: dedupeHit.service.inbound_email_id,
        outcome: "draft_refreshed",
        parserKey: parsed.normalized.parser_key,
        parsingQuality: parsed.normalized.parsing_quality,
        details: { dedupe_pattern: dedupeHit.pattern, filename: input.filename }
      });

      return {
        ok: true,
        outcome: "draft_refreshed",
        duplicate: true,
        inbound_email_id: dedupeHit.service.inbound_email_id,
        draft_service_id: dedupeHit.service.id,
        dedupe_pattern: dedupeHit.pattern,
        preview: parsed.preview,
        normalized: parsed.normalized
      };
    }

    auditLog({
      event: "pdf_import_duplicate_blocked",
      level: "warn",
      tenantId,
      userId: auth.user.id ?? null,
      role: auth.membership.role,
      serviceId: dedupeHit.service.id,
      duplicate: true,
      outcome: dedupeHit.service.is_draft ? "skipped_duplicate_draft" : "skipped_duplicate_final",
      parserKey: parsed.normalized.parser_key,
      parsingQuality: parsed.normalized.parsing_quality,
      details: { dedupe_pattern: dedupeHit.pattern, filename: input.filename }
    });
    return {
      ok: true,
      outcome: dedupeHit.service.is_draft ? "skipped_duplicate_draft" : "skipped_duplicate_final",
      duplicate: true,
      existing_service_id: dedupeHit.service.id,
      dedupe_pattern: dedupeHit.pattern,
      preview: parsed.preview,
      normalized: parsed.normalized
    };
  }

  const hotelId = await resolveHotelId(auth.admin, tenantId, parsed.normalized.hotel_or_destination);
  if (!hotelId) {
    throw new Error("Nessun hotel disponibile per il tenant.");
  }
  const possibleExistingMatches = await findPotentialExistingMatches(auth.admin, tenantId, parsed.normalized);
  const reviewRecommended = requiresManualPdfReview(parsed.normalized);
  const needsManualReview = shouldAlwaysCreatePdfDraft();

  const parsedJson = buildParsedJson(
    {
      fromEmail: input.senderEmail,
      subject: input.subject,
      bodyText: input.bodyText ?? "",
      filename: input.filename,
      sizeBytes: input.fileSize
    },
    parsed,
    "draft",
    "draft",
    undefined,
    possibleExistingMatches
  );

  const inboundInsert = await auth.admin
    .from("inbound_emails")
    .insert({
      tenant_id: tenantId,
      raw_text: input.bodyText ?? "",
      from_email: input.senderEmail,
      subject: input.subject,
      body_text: input.bodyText ?? "",
      body_html: null,
      raw_json: { source: "pdf-import-controlled", filename: input.filename, size_bytes: input.fileSize },
      extracted_text: parsed.extractedText || null,
      parsed_json: parsedJson
    })
    .select("id")
    .single();

  if (inboundInsert.error || !inboundInsert.data?.id) {
    throw new Error(inboundInsert.error?.message ?? "Salvataggio inbound PDF fallito.");
  }

  try {
    await auth.admin.from("inbound_email_attachments").insert({
      inbound_email_id: inboundInsert.data.id,
      tenant_id: tenantId,
      filename: input.filename,
      mimetype: "application/pdf",
      size_bytes: input.fileSize,
      stored: true,
      extracted_text: parsed.extractedText || null
    });
  } catch {
    // Attachment persistence is optional for the controlled import flow.
  }

  const serviceInsert = await auth.admin
    .from("services")
    .insert(
      buildServicePayload(parsed.normalized, {
        tenantId,
        userId: auth.user.id ?? null,
        inboundEmailId: inboundInsert.data.id,
        hotelId,
        isDraft: true,
        status: "needs_review",
        importMode: "draft",
        hasManualReview: false
      })
    )
    .select("id")
    .single();

  if (serviceInsert.error || !serviceInsert.data?.id) {
    throw new Error(serviceInsert.error?.message ?? "Creazione draft PDF fallita.");
  }

  const updatedParsedJson = buildParsedJson(
    {
      fromEmail: input.senderEmail,
      subject: input.subject,
      bodyText: input.bodyText ?? "",
      filename: input.filename,
      sizeBytes: input.fileSize
    },
    parsed,
    "draft",
    "draft",
    serviceInsert.data.id,
    possibleExistingMatches
  );

  const inboundUpdate = await auth.admin
    .from("inbound_emails")
    .update({ parsed_json: updatedParsedJson })
    .eq("id", inboundInsert.data.id)
    .eq("tenant_id", tenantId);
  if (inboundUpdate.error) {
    throw new Error(inboundUpdate.error.message);
  }

  auditLog({
    event: "pdf_import_draft_created",
    tenantId,
    userId: auth.user.id ?? null,
    role: auth.membership.role,
    serviceId: serviceInsert.data.id,
    inboundEmailId: inboundInsert.data.id,
    outcome: "draft",
    parserKey: parsed.normalized.parser_key,
    parsingQuality: parsed.normalized.parsing_quality,
    details: {
      filename: input.filename,
      parser_mode: parsed.preview.parser.mode,
      review_recommended: reviewRecommended,
      auto_confirm_disabled: true
    }
  });
  if (reviewRecommended) {
    auditLog({
      event: "pdf_import_low_quality_warning",
      level: "warn",
      tenantId,
      userId: auth.user.id ?? null,
      role: auth.membership.role,
      serviceId: serviceInsert.data.id,
      inboundEmailId: inboundInsert.data.id,
      parserKey: parsed.normalized.parser_key,
      parsingQuality: parsed.normalized.parsing_quality,
      details: { filename: input.filename, review_recommended: true }
    });
  }

  return {
    ok: true,
    outcome: "draft",
    inbound_email_id: inboundInsert.data.id,
    draft_service_id: serviceInsert.data.id,
    preview: parsed.preview,
    normalized: parsed.normalized
  };
}

async function syncDraftServiceFromNormalized(
  auth: AuthContext,
  inboundEmailId: string,
  normalized: NormalizedPdfImport,
  parsedJson: Record<string, any>
) {
  const tenantId = auth.membership.tenant_id;
  const draftRow = await auth.admin
    .from("services")
    .select("id, is_draft")
    .eq("tenant_id", tenantId)
    .eq("inbound_email_id", inboundEmailId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const draftService = draftRow.data ?? null;
  if (!draftService?.id || draftService.is_draft === false) {
    return draftService?.id ?? null;
  }

  const hotelId = await resolveHotelId(auth.admin, tenantId, normalized.hotel_or_destination);
  if (!hotelId) return draftService.id;

  const draftUpdate = await auth.admin
    .from("services")
    .update({
      date: normalized.arrival_date,
      time: normalized.outbound_time ?? "00:00",
      vessel: normalized.carrier_company ?? normalized.arrival_place ?? "Transfer da PDF",
      pax: normalized.passengers,
      hotel_id: hotelId,
      customer_name: normalized.customer_full_name,
      billing_party_name: normalized.billing_party_name,
      outbound_time: normalized.outbound_time,
      return_time: normalized.return_time,
      source_total_amount_cents: normalized.source_total_amount_cents,
      source_price_per_pax_cents: normalized.source_price_per_pax_cents,
      source_amount_currency: normalized.source_amount_currency,
      phone: normalized.customer_phone,
      notes: buildServiceNotes(normalized, {
        mode: "draft",
        hasManualReview: Boolean(parsedJson?.pdf_import?.has_manual_review)
      }),
      booking_service_kind: normalized.booking_kind,
      service_type_code: normalized.service_type,
      customer_first_name: null,
      customer_last_name: null,
      customer_email: normalized.customer_email,
      arrival_date: normalized.arrival_date,
      arrival_time: normalized.outbound_time ?? "00:00",
      departure_date: normalized.departure_date,
      departure_time: normalized.return_time,
      transport_code: normalized.transport_code,
      train_arrival_number: normalized.train_arrival_number,
      train_arrival_time: null,
      train_departure_number: normalized.train_departure_number,
      train_departure_time: null,
      bus_city_origin: normalized.bus_city_origin,
      include_ferry_tickets: normalized.include_ferry_tickets,
      ferry_details: {
        transport_mode: normalized.transport_mode,
        arrival_place: normalized.arrival_place,
        carrier_company: normalized.carrier_company,
        transport_reference_outward: normalized.transport_reference_outward,
        transport_reference_return: normalized.transport_reference_return,
        arrival_transport_code: normalized.arrival_transport_code,
        departure_transport_code: normalized.departure_transport_code
      },
      excursion_details: {
        ...(parsedJson?.pdf_import?.normalized?.excursion_details ?? {}),
        source: "pdf",
        import_mode: "draft",
        external_reference: normalized.external_reference,
        reviewed: Boolean(parsedJson?.pdf_import?.has_manual_review)
      }
    })
    .eq("tenant_id", tenantId)
    .eq("id", draftService.id);
  if (draftUpdate.error) {
    throw new Error(draftUpdate.error.message);
  }

  return draftService.id;
}

export function getEffectiveNormalizedFromParsedJson(parsedJson: Record<string, any>) {
  const pdfImport = parsedJson?.pdf_import ?? {};
  const original = (pdfImport.original_normalized ?? pdfImport.normalized ?? null) as NormalizedPdfImport | null;
  const reviewedValues = (pdfImport.reviewed_values ?? null) as Partial<z.infer<typeof pdfImportReviewSchema>> | null;
  if (!original) return null;
  return buildEffectiveNormalizedImport(original, reviewedValues);
}

export async function savePdfImportReview(
  auth: AuthContext,
  input: {
    inboundEmailId: string;
    reviewedValues: z.infer<typeof pdfImportReviewSchema>;
  }
) {
  const tenantId = auth.membership.tenant_id;
  const inboundRow = await auth.admin
    .from("inbound_emails")
    .select("id, parsed_json")
    .eq("tenant_id", tenantId)
    .eq("id", input.inboundEmailId)
    .maybeSingle();
  if (inboundRow.error || !inboundRow.data?.id) {
    throw new Error("Import PDF non trovato.");
  }

  const parsedJson = (inboundRow.data.parsed_json ?? {}) as Record<string, any>;
  const importState = clean(parsedJson?.pdf_import?.import_state);
  if (importState && importState !== "draft") {
    throw new Error("La review manuale e consentita solo su draft da revisionare.");
  }

  const originalNormalized = (parsedJson?.pdf_import?.original_normalized ?? parsedJson?.pdf_import?.normalized) as
    | NormalizedPdfImport
    | undefined;
  if (!originalNormalized) {
    throw new Error("Normalized import assente.");
  }

  const effectiveNormalized = buildEffectiveNormalizedImport(originalNormalized, input.reviewedValues);
  const nextParsedJson = {
    ...parsedJson,
    review_status: "needs_review",
    pdf_import: {
      ...parsedJson.pdf_import,
      import_state: "draft",
      original_normalized: originalNormalized,
      reviewed_values: input.reviewedValues,
      effective_normalized: effectiveNormalized,
      normalized: originalNormalized,
      dedupe: {
        key: effectiveNormalized.dedupe_key,
        external_reference: effectiveNormalized.external_reference,
        ...effectiveNormalized.dedupe_components
      },
      has_manual_review: true,
      reviewed_by: auth.user.id,
      reviewed_at: new Date().toISOString(),
      linked_service_id: parsedJson?.pdf_import?.linked_service_id ?? null
    }
  };

  const reviewUpdate = await auth.admin
    .from("inbound_emails")
    .update({ parsed_json: nextParsedJson })
    .eq("tenant_id", tenantId)
    .eq("id", input.inboundEmailId);
  if (reviewUpdate.error) {
    throw new Error(reviewUpdate.error.message);
  }

  const linkedServiceId = await syncDraftServiceFromNormalized(auth, input.inboundEmailId, effectiveNormalized, nextParsedJson);

  auditLog({
    event: "pdf_import_review_saved",
    tenantId,
    userId: auth.user.id ?? null,
    role: auth.membership.role,
    serviceId: linkedServiceId,
    inboundEmailId: input.inboundEmailId,
    outcome: "review_saved",
    parserKey: effectiveNormalized.parser_key,
    parsingQuality: effectiveNormalized.parsing_quality,
    details: { has_manual_review: true }
  });

  return {
    ok: true,
    inbound_email_id: input.inboundEmailId,
    linked_service_id: linkedServiceId,
    has_manual_review: true,
    reviewed_at: nextParsedJson.pdf_import.reviewed_at,
    effective_normalized: effectiveNormalized
  };
}

export async function confirmPdfImport(auth: AuthContext, input: { inboundEmailId: string }) {
  const tenantId = auth.membership.tenant_id;
  const inboundRow = await auth.admin
    .from("inbound_emails")
    .select("id, from_email, subject, body_text, extracted_text, parsed_json")
    .eq("tenant_id", tenantId)
    .eq("id", input.inboundEmailId)
    .maybeSingle();
  if (inboundRow.error || !inboundRow.data?.id) {
    throw new Error("Inbound email PDF non trovato.");
  }

  const parsedJson = (inboundRow.data.parsed_json ?? {}) as Record<string, any>;
  const currentImportState = clean(parsedJson?.pdf_import?.import_state);
  if (currentImportState === "ignored") {
    throw new Error("Import PDF gia scartato: conferma non consentita.");
  }
  if (currentImportState === "imported") {
    throw new Error("Import PDF gia confermato.");
  }
  const normalized = getEffectiveNormalizedFromParsedJson(parsedJson);
  if (!normalized) {
    throw new Error("Metadati PDF normalizzati assenti: crea prima il draft.");
  }

  const dedupeHit = await findExistingPdfImport(auth.admin, tenantId, normalized);
  const linkedDraft = await auth.admin
    .from("services")
    .select("id, is_draft, notes, status")
    .eq("tenant_id", tenantId)
    .eq("inbound_email_id", input.inboundEmailId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const draftService = linkedDraft.data ?? null;

  if (draftService?.id && draftService.is_draft === false) {
    await auth.admin
      .from("inbound_emails")
      .update({
        parsed_json: {
          ...parsedJson,
          pdf_import: {
            ...parsedJson.pdf_import,
            import_mode: "final",
            import_state: "skipped_duplicate",
            linked_service_id: draftService.id,
            dedupe_pattern: "[inbound_email_id]"
          }
        }
      })
      .eq("id", input.inboundEmailId)
      .eq("tenant_id", tenantId);

    auditLog({
      event: "pdf_import_duplicate_blocked",
      level: "warn",
      tenantId,
      userId: auth.user.id ?? null,
      role: auth.membership.role,
      serviceId: draftService.id,
      inboundEmailId: input.inboundEmailId,
      duplicate: true,
      outcome: "skipped_duplicate",
      parserKey: normalized.parser_key,
      parsingQuality: normalized.parsing_quality,
      details: { dedupe_pattern: "[inbound_email_id]" }
    });

    return {
      ok: true,
      outcome: "skipped_duplicate",
      duplicate: true,
      existing_service_id: draftService.id,
      dedupe_pattern: "[inbound_email_id]"
    };
  }

  if (dedupeHit.service?.id && !dedupeHit.service.is_draft && dedupeHit.service.id !== draftService?.id) {
    await auth.admin
      .from("inbound_emails")
      .update({
        parsed_json: {
          ...parsedJson,
          pdf_import: {
            ...parsedJson.pdf_import,
            import_mode: "final",
            import_state: "skipped_duplicate",
            linked_service_id: dedupeHit.service.id,
            dedupe_pattern: dedupeHit.pattern
          }
        }
      })
      .eq("id", input.inboundEmailId)
      .eq("tenant_id", tenantId);

    auditLog({
      event: "pdf_import_duplicate_blocked",
      level: "warn",
      tenantId,
      userId: auth.user.id ?? null,
      role: auth.membership.role,
      serviceId: dedupeHit.service.id,
      inboundEmailId: input.inboundEmailId,
      duplicate: true,
      outcome: "skipped_duplicate",
      parserKey: normalized.parser_key,
      parsingQuality: normalized.parsing_quality,
      details: { dedupe_pattern: dedupeHit.pattern }
    });

    return {
      ok: true,
      outcome: "skipped_duplicate",
      duplicate: true,
      existing_service_id: dedupeHit.service.id,
      dedupe_pattern: dedupeHit.pattern
    };
  }

  const hotelId = await resolveHotelId(auth.admin, tenantId, normalized.hotel_or_destination);
  if (!hotelId) {
    throw new Error("Nessun hotel disponibile per il tenant.");
  }

  const finalNotes = buildServiceNotes(normalized, {
    mode: "final",
    hasManualReview: Boolean(parsedJson?.pdf_import?.has_manual_review)
  });
  let finalServiceId: string | null = null;

  if (draftService?.id) {
    const updateAttempt = await auth.admin
      .from("services")
      .update({
        is_draft: false,
        status: "new",
        date: normalized.arrival_date,
        time: normalized.outbound_time ?? "00:00",
        service_type: baseServiceType(normalized),
        direction: "arrival",
        vessel: normalized.carrier_company ?? normalized.arrival_place ?? "Transfer da PDF",
        pax: normalized.passengers,
        hotel_id: hotelId,
        customer_name: normalized.customer_full_name,
        billing_party_name: normalized.billing_party_name,
        outbound_time: normalized.outbound_time,
        return_time: normalized.return_time,
        source_total_amount_cents: normalized.source_total_amount_cents,
        source_price_per_pax_cents: normalized.source_price_per_pax_cents,
        source_amount_currency: normalized.source_amount_currency,
        phone: normalized.customer_phone,
        notes: finalNotes,
        created_by_user_id: auth.user.id ?? null,
        booking_service_kind: normalized.booking_kind,
        service_type_code: normalized.service_type,
        customer_first_name: null,
        customer_last_name: null,
        customer_email: normalized.customer_email,
        arrival_date: normalized.arrival_date,
        arrival_time: normalized.outbound_time ?? "00:00",
        departure_date: normalized.departure_date,
        departure_time: normalized.return_time,
        transport_code: normalized.transport_code,
        train_arrival_number: normalized.train_arrival_number,
        train_arrival_time: null,
        train_departure_number: normalized.train_departure_number,
        train_departure_time: null,
        bus_city_origin: normalized.bus_city_origin,
        include_ferry_tickets: normalized.include_ferry_tickets,
        ferry_details: {
          transport_mode: normalized.transport_mode,
          arrival_place: normalized.arrival_place,
          carrier_company: normalized.carrier_company,
          transport_reference_outward: normalized.transport_reference_outward,
          transport_reference_return: normalized.transport_reference_return,
          arrival_transport_code: normalized.arrival_transport_code,
          departure_transport_code: normalized.departure_transport_code
        },
        excursion_details: {
          source: "pdf",
          import_mode: "final",
          external_reference: normalized.external_reference
        }
      })
      .eq("tenant_id", tenantId)
      .eq("id", draftService.id)
      .select("id")
      .single();
    if (updateAttempt.error || !updateAttempt.data?.id) {
      throw new Error(updateAttempt.error?.message ?? "Conferma draft PDF fallita.");
    }
    finalServiceId = updateAttempt.data.id;
  } else {
    const createAttempt = await auth.admin
      .from("services")
      .insert({
        tenant_id: tenantId,
        inbound_email_id: input.inboundEmailId,
        is_draft: false,
        date: normalized.arrival_date,
        time: normalized.outbound_time ?? "00:00",
        service_type: baseServiceType(normalized),
        direction: "arrival",
        vessel: normalized.carrier_company ?? normalized.arrival_place ?? "Transfer da PDF",
        pax: normalized.passengers,
        hotel_id: hotelId,
        customer_name: normalized.customer_full_name,
        billing_party_name: normalized.billing_party_name,
        outbound_time: normalized.outbound_time,
        return_time: normalized.return_time,
        source_total_amount_cents: normalized.source_total_amount_cents,
        source_price_per_pax_cents: normalized.source_price_per_pax_cents,
        source_amount_currency: normalized.source_amount_currency,
        phone: normalized.customer_phone,
        notes: finalNotes,
        status: "new",
        created_by_user_id: auth.user.id ?? null,
        booking_service_kind: normalized.booking_kind,
        service_type_code: normalized.service_type,
        customer_first_name: null,
        customer_last_name: null,
        customer_email: normalized.customer_email,
        arrival_date: normalized.arrival_date,
        arrival_time: normalized.outbound_time ?? "00:00",
        departure_date: normalized.departure_date,
        departure_time: normalized.return_time,
        transport_code: normalized.transport_code,
        train_arrival_number: normalized.train_arrival_number,
        train_arrival_time: null,
        train_departure_number: normalized.train_departure_number,
        train_departure_time: null,
        include_ferry_tickets: normalized.include_ferry_tickets,
        ferry_details: {
          transport_mode: normalized.transport_mode,
          arrival_place: normalized.arrival_place,
          carrier_company: normalized.carrier_company,
          transport_reference_outward: normalized.transport_reference_outward,
          transport_reference_return: normalized.transport_reference_return,
          arrival_transport_code: normalized.arrival_transport_code,
          departure_transport_code: normalized.departure_transport_code
        },
        excursion_details: {
          source: "pdf",
          import_mode: "final",
          external_reference: normalized.external_reference
        }
      })
      .select("id")
      .single();
    if (createAttempt.error || !createAttempt.data?.id) {
      throw new Error(createAttempt.error?.message ?? "Creazione booking PDF finale fallita.");
    }
    finalServiceId = createAttempt.data.id;
  }

  const existingStatus = await auth.admin
    .from("status_events")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("service_id", finalServiceId)
    .eq("status", "new")
    .limit(1)
    .maybeSingle();
  if (!existingStatus.data?.id) {
    const statusInsert = await auth.admin.from("status_events").insert({
      tenant_id: tenantId,
      service_id: finalServiceId,
      status: "new",
      by_user_id: auth.user.id
    });
    if (statusInsert.error) {
      throw new Error(statusInsert.error.message);
    }
  }

  if (normalized.service_type === "bus_line" || normalized.booking_kind === "bus_city_hotel") {
    await ensureDefaultBusLotConfig(auth.admin, {
      tenantId,
      date: normalized.arrival_date,
      direction: "arrival",
      billingPartyName: normalized.billing_party_name,
      busCityOrigin: normalized.bus_city_origin,
      transportCode: normalized.transport_code,
      title: normalized.bus_city_origin,
      time: normalized.outbound_time,
      meetingPoint: normalized.arrival_place
    });
  }

  const inboundUpdate = await auth.admin
    .from("inbound_emails")
    .update({
      parsed_json: {
        ...parsedJson,
        pdf_import: {
          ...parsedJson.pdf_import,
          import_mode: "final",
          import_state: "imported",
          linked_service_id: finalServiceId,
          effective_normalized: normalized
        }
      }
    })
    .eq("id", input.inboundEmailId)
    .eq("tenant_id", tenantId);
  if (inboundUpdate.error) {
    throw new Error(inboundUpdate.error.message);
  }

  if (!finalServiceId) {
    throw new Error("Import PDF finale senza service id.");
  }

  await tryMatchAndApplyPricing(auth.admin, {
    tenantId,
    inboundEmailId: input.inboundEmailId,
    serviceId: finalServiceId,
    senderEmail: inboundRow.data.from_email ?? null,
    sourceText: buildPricingSourceText([inboundRow.data.subject ?? "", inboundRow.data.body_text ?? "", inboundRow.data.extracted_text ?? ""], normalized),
    serviceType: "transfer",
    direction: "arrival",
    date: normalized.arrival_date,
    time: normalized.outbound_time ?? "00:00",
    pax: normalized.passengers,
    bookingKind: normalized.booking_kind,
    serviceVariant: normalized.service_variant
  });

  auditLog({
    event: "pdf_import_confirmed",
    tenantId,
    userId: auth.user.id ?? null,
    role: auth.membership.role,
    serviceId: finalServiceId,
    inboundEmailId: input.inboundEmailId,
    outcome: "imported",
    parserKey: normalized.parser_key,
    parsingQuality: normalized.parsing_quality,
    details: {
      external_reference: normalized.external_reference,
      has_manual_review: Boolean(parsedJson?.pdf_import?.has_manual_review)
    }
  });

  return {
    ok: true,
    outcome: "imported",
    final_service_id: finalServiceId,
    inbound_email_id: input.inboundEmailId,
    parsing_quality: normalized.parsing_quality,
    dedupe_key: normalized.dedupe_key
  };
}
