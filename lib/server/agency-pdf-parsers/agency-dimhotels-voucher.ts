import type { ParsedTransferPdfPayload, ParsedTransferService } from "@/lib/server/transfer-pdf-parser";
import type { AgencyPdfParserImplementation } from "@/lib/server/agency-pdf-parsers/types";
import { buildParserMatch } from "@/lib/server/agency-pdf-parsers/utils";

function clean(value?: string | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeDigits(value?: string | null) {
  if (!value) return null;
  const mapped = value
    .replace(/[Oo]/g, "0")
    .replace(/[Il|]/g, "1")
    .replace(/Z/g, "2")
    .replace(/S/g, "5")
    .replace(/B/g, "8");
  const digits = mapped.replace(/\D+/g, "");
  return digits.length > 0 ? digits : null;
}

function normalizeTime(raw?: string | null) {
  const value = String(raw ?? "")
    .replace(/[Ll]/g, "1")
    .replace(/[Oo]/g, "0")
    .replace(/\s+/g, "");
  const match = value.match(/([01]?\d|2[0-3])[:.]([0-5]\d)/);
  if (!match) return null;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function parsePassengerCount(sourceText: string) {
  const raw =
    sourceText.match(/Pnsseggeri[:\s]*([A-Za-z0-9{},]+)/i)?.[1] ??
    sourceText.match(/Passeggeri[:\s]*([A-Za-z0-9{},]+)/i)?.[1] ??
    null;
  const digits = normalizeDigits(raw);
  return digits ? Number(digits.slice(0, 2)) : null;
}

function parseVoucherTimes(lines: string[]) {
  const possibleTimes = lines.flatMap((line) => {
    const matches = line.match(/([0-2]?[0-9][:.,][0-5][0-9])/g) ?? [];
    return matches.map((item) => normalizeTime(item)).filter(Boolean) as string[];
  });
  const unique = [...new Set(possibleTimes)];
  return {
    outwardTime: unique[0] ?? null,
    returnTime: unique.length > 1 ? unique[unique.length - 1] : null
  };
}

function parseCustomerName(lines: string[]) {
  const nameIndex = lines.findIndex((line) => /Noms?:/i.test(line));
  const surnameIndex = lines.findIndex((line) => /Gogrnome|Cognome/i.test(line));

  const firstName = nameIndex >= 0 ? clean(lines[nameIndex + 1] ?? null) : null;
  const lastNameParts =
    surnameIndex >= 0
      ? [clean(lines[surnameIndex + 1] ?? null), clean(lines[surnameIndex + 2] ?? null), clean(lines[surnameIndex + 3] ?? null)].filter(Boolean)
      : [];
  const lastName = lastNameParts.length > 0 ? lastNameParts.join(" ") : null;

  const fullName = clean([firstName, lastName].filter(Boolean).join(" "));
  return {
    firstName,
    lastName,
    fullName
  };
}

function parseDimhotelsVoucherPdfText(sourceText: string): ParsedTransferPdfPayload {
  const lines = sourceText
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const compact = lines.join(" ");
  const customer = parseCustomerName(lines);
  const phoneIndex = lines.findIndex((line) => /Celh?u?l?cre|Cellulare/i.test(line));
  const phoneSource =
    phoneIndex >= 0 ? [lines[phoneIndex], lines[phoneIndex + 1], lines[phoneIndex + 2]].filter(Boolean).join(" ") : null;
  const phone = normalizeDigits(phoneSource);
  const hotelIndex = lines.findIndex((line) => /Hotel/i.test(line)) ;
  const hotelSource =
    hotelIndex >= 0 ? [lines[hotelIndex], lines[hotelIndex + 1], lines[hotelIndex + 2], lines[hotelIndex + 3]].filter(Boolean).join(" ") : null;
  const hotel = clean(hotelSource?.match(/Hotel.*?destinc?[a-z]*\s+([A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ' ]{2,})/i)?.[1] ?? null);
  const passengerCount = parsePassengerCount(compact);
  const times = parseVoucherTimes(lines);

  const arrivalService: ParsedTransferService = {
    practice_number: null,
    beneficiary: customer.fullName,
    pax: passengerCount,
    service_type: "transfer",
    direction: "andata",
    service_date: null,
    service_time: times.outwardTime,
    pickup_meeting_point: "PORTO DI NAPOLI",
    origin: "NAPOLI BEVERELLO",
    destination: hotel,
    carrier_company: "SNAV",
    hotel_structure: hotel,
    original_row_description: "ALISCAFO + TRANSFER HOTEL",
    raw_detail_text: "Voucher Dimhotels/Snav con aliscafo e transfer hotel",
    parsing_status: "needs_review",
    confidence_level: hotel || phone ? "medium" : "low",
    semantic_tag: "transfer_arrival"
  };

  const departureService: ParsedTransferService = {
    practice_number: null,
    beneficiary: customer.fullName,
    pax: passengerCount,
    service_type: "transfer",
    direction: "ritorno",
    service_date: null,
    service_time: times.returnTime,
    pickup_meeting_point: hotel,
    origin: hotel,
    destination: "NAPOLI BEVERELLO",
    carrier_company: "SNAV",
    hotel_structure: hotel,
    original_row_description: "TRANSFER HOTEL + ALISCAFO",
    raw_detail_text: "Voucher Dimhotels/Snav con rientro hotel verso Napoli Beverello",
    parsing_status: "needs_review",
    confidence_level: hotel || phone ? "medium" : "low",
    semantic_tag: "transfer_departure"
  };

  return {
    practice_number: null,
    practice_date: null,
    first_beneficiary: customer.fullName,
    ns_reference: "DIMHOTELS",
    ns_contact: phone,
    pax: passengerCount,
    program: "VOUCHER SNAV + TRANSFER",
    package_description: "Voucher Dimhotels/Snav",
    date_from: null,
    date_to: null,
    total_amount_practice: /€\s*55/i.test(compact) ? 55 : null,
    service_rows: [
      { row_text: arrivalService.original_row_description ?? arrivalService.raw_detail_text, semantic_tag: "transfer_arrival", direction: "andata" },
      { row_text: departureService.original_row_description ?? departureService.raw_detail_text, semantic_tag: "transfer_departure", direction: "ritorno" }
    ],
    operational_details: [
      {
        service_date: arrivalService.service_date,
        service_time: arrivalService.service_time,
        meeting_point: arrivalService.pickup_meeting_point,
        from_text: arrivalService.origin,
        to_text: arrivalService.destination,
        dest_text: arrivalService.destination,
        description_line: arrivalService.original_row_description,
        raw_detail_text: arrivalService.raw_detail_text
      },
      {
        service_date: departureService.service_date,
        service_time: departureService.service_time,
        meeting_point: departureService.pickup_meeting_point,
        from_text: departureService.origin,
        to_text: departureService.destination,
        dest_text: departureService.destination,
        description_line: departureService.original_row_description,
        raw_detail_text: departureService.raw_detail_text
      }
    ],
    parsed_services: [arrivalService, departureService],
    parsing_status: "needs_review",
    confidence_level: hotel || phone ? "medium" : "low",
    anomaly_message: "Voucher OCR rumoroso: date e orari vanno verificati manualmente."
  };
}

export const agencyDimhotelsVoucherPdfParser: AgencyPdfParserImplementation = {
  key: "agency_dimhotels_voucher",
  mode: "dedicated",
  label: "Dimhotels / Snav Voucher",
  senderDomains: ["dimhotels.it", "snav.it"],
  subjectHints: ["voucher", "dimhotels", "snav"],
  contentHints: ["dimhotels", "snav", "aliscafo", "napoli beverello", "voucher"],
  agencyNameHints: ["dimhotels", "snav"],
  voucherHints: ["costi", "hotel di destinazione", "biglietterie", "carta d imbarco"],
  parse: parseDimhotelsVoucherPdfText,
  match: (input) =>
    buildParserMatch(input, {
      senderDomains: ["dimhotels.it", "snav.it"],
      subjectHints: ["voucher", "dimhotels", "snav"],
      contentHints: ["dimhotels", "snav", "aliscafo", "napoli beverello", "voucher"],
      agencyNameHints: ["dimhotels", "snav"],
      voucherHints: ["costi", "hotel di destinazione", "biglietterie", "carta d imbarco"]
    })
};
