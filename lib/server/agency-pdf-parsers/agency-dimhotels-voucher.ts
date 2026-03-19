import type { ParsedTransferPdfPayload, ParsedTransferService } from "@/lib/server/transfer-pdf-parser";
import type { AgencyPdfParserImplementation } from "@/lib/server/agency-pdf-parsers/types";
import { buildParserMatch } from "@/lib/server/agency-pdf-parsers/utils";

function clean(value?: string | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function cleanCustomerChunk(value?: string | null) {
  return (
    clean(value)
      ?.replace(/^it\s+/i, "")
      .replace(/\s+(?:nome|cognome)\s*:?.*$/i, "")
      .trim() ?? null
  );
}

function cleanVoucherHotel(value?: string | null) {
  const normalized = clean(value);
  if (!normalized) return null;
  return (
    clean(
      normalized.match(/\b((?:Hotel|Albergo|Residence|Terme)\s+[A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ' ]{2,60})\b/i)?.[1] ??
        normalized
    ) ?? null
  );
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

function parseIsoDate(raw?: string | null) {
  const match = String(raw ?? "").match(/([0-3]?\d)[/.:-]([01]?\d)[/.:-](\d{2,4})/);
  if (!match) return null;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function parsePassengerCount(sourceText: string) {
  const raw =
    sourceText.match(/Numero Passeggeri[:\s]*([A-Za-z0-9{},]+)/i)?.[1] ??
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

function parseChosenVoucherTimes(sourceText: string) {
  const normalized = sourceText.replace(/\r/g, "\n").replace(/\s+/g, " ");
  const outwardBlock = normalized.match(
    /Scegli l['’]?orario di partenza da Napoli Beverello a Casamicciola:\s*(.+?)\s*Scegli l['’]?orario di partenza da Casamicciola a Napoli Beverello:/i
  )?.[1];
  const returnBlock = normalized.match(/Scegli l['’]?orario di partenza da Casamicciola a Napoli Beverello:\s*(.+)$/i)?.[1];

  const pickMarkedTime = (value?: string | null) => {
    const marked = Array.from(String(value ?? "").matchAll(/\b([a-z0-9])\s*([0-2]?\d[:.,][0-5]\d)\b/gi)).map((match) => ({
      marker: match[1].toLowerCase(),
      time: normalizeTime(match[2])
    }));
    const preferred = marked.find((item) => item.time && !["c", "o", "0"].includes(item.marker));
    if (preferred?.time) return preferred.time;

    const plain = Array.from(String(value ?? "").matchAll(/([0-2]?\d[:.,][0-5]\d)/g)).map((match) => normalizeTime(match[1]));
    return plain.find(Boolean) ?? null;
  };

  return {
    outwardTime: pickMarkedTime(outwardBlock),
    returnTime: pickMarkedTime(returnBlock)
  };
}

function parseCustomerName(lines: string[]) {
  const compact = lines.join(" ");
  const combinedLabelMatch =
    compact.match(/\b(?:it\s+)?([A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ' ]{1,40})\s+Nome:\s*([A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ' ]{1,40})\s+Cognome:/i) ??
    compact.match(/\bNome:\s*([A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ' ]{1,40})\s+Cognome:\s*([A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ' ]{1,40})/i);
  if (combinedLabelMatch) {
    const firstName = cleanCustomerChunk(combinedLabelMatch[1]);
    const lastName = cleanCustomerChunk(combinedLabelMatch[2]);
    return {
      firstName,
      lastName,
      fullName: clean([firstName, lastName].filter(Boolean).join(" "))
    };
  }

  const firstNameInline = cleanCustomerChunk(lines.find((line) => /Nome:/i.test(line))?.match(/Nome:\s*(.+)$/i)?.[1] ?? null);
  const lastNameInline = cleanCustomerChunk(lines.find((line) => /Cognome:/i.test(line))?.match(/Cognome:\s*(.+)$/i)?.[1] ?? null);
  const firstNameBeforeLabel = cleanCustomerChunk(compact.match(/\b([A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ' ]{1,40})\s+Nome:/i)?.[1] ?? null);
  const lastNameBeforeLabel = cleanCustomerChunk(compact.match(/\b([A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ' ]{1,40})\s+Cognome:/i)?.[1] ?? null);
  if (firstNameBeforeLabel || lastNameBeforeLabel) {
    return {
      firstName: firstNameBeforeLabel,
      lastName: lastNameBeforeLabel,
      fullName: clean([firstNameBeforeLabel, lastNameBeforeLabel].filter(Boolean).join(" "))
    };
  }
  if (firstNameInline || lastNameInline) {
    return {
      firstName: firstNameInline,
      lastName: lastNameInline,
      fullName: clean([firstNameInline, lastNameInline].filter(Boolean).join(" "))
    };
  }

  const nameIndex = lines.findIndex((line) => /Noms?:/i.test(line));
  const surnameIndex = lines.findIndex((line) => /Gogrnome|Cognome/i.test(line));
  const firstName = nameIndex >= 0 ? cleanCustomerChunk(lines[nameIndex + 1] ?? null) : null;
  const lastNameParts =
    surnameIndex >= 0
      ? [cleanCustomerChunk(lines[surnameIndex + 1] ?? null), cleanCustomerChunk(lines[surnameIndex + 2] ?? null), cleanCustomerChunk(lines[surnameIndex + 3] ?? null)].filter(Boolean)
      : [];
  const lastName = lastNameParts.length > 0 ? lastNameParts.join(" ") : null;

  return {
    firstName,
    lastName,
    fullName: clean([firstName, lastName].filter(Boolean).join(" "))
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

  const phoneIndex = lines.findIndex((line) => /Celh?u?l?are|Cellulare/i.test(line));
  const phoneSource =
    phoneIndex >= 0 ? [lines[phoneIndex], lines[phoneIndex + 1], lines[phoneIndex + 2]].filter(Boolean).join(" ") : compact;
  const phone =
    normalizeDigits(clean(lines.find((line) => /Cellulare:/i.test(line))?.match(/Cellulare:\s*([+\d][\d\s./-]{7,})/i)?.[1] ?? null)) ??
    normalizeDigits(clean(compact.match(/Cellulare:\s*([+\d][\d\s./-]{7,})/i)?.[1] ?? null)) ??
    normalizeDigits(phoneSource);

  const hotelInline = clean(lines.find((line) => /Hotel di destinazione:/i.test(line))?.match(/Hotel di destinazione:\s*(.+)$/i)?.[1] ?? null);
  const hotelIndex = lines.findIndex((line) => /Hotel/i.test(line));
  const hotelSource =
    hotelIndex >= 0 ? [lines[hotelIndex], lines[hotelIndex + 1], lines[hotelIndex + 2], lines[hotelIndex + 3]].filter(Boolean).join(" ") : null;
  const hotel = cleanVoucherHotel(
    hotelInline ??
      clean(compact.match(/Hotel di destinazione:\s*((?:Hotel|Albergo|Residence|Terme)\s+[A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ' ]{2,60}?)(?=\s*Scegli l['’]?orario di partenza|\s*Tutte le corse|\s*Nota Bene)/i)?.[1] ?? null) ??
      clean(compact.match(/Hotel di destinazione:\s*(.+?)(?:\s*Scegli l['’]?orario di partenza|\s*Tutte le corse|\s*Nota Bene)/i)?.[1] ?? null) ??
      clean(hotelSource?.match(/Hotel.*?destinazione\s*:?\s*([A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ' ]{2,})/i)?.[1] ?? null)
  );

  const hotelSanitized = cleanVoucherHotel(
    hotel
      ?.replace(/\s+(?:Scegli l['’]?orario di partenza|Tutte le corse|Nota Bene:?).*$/i, "")
      .replace(/\s+(?:da Napoli Beverello a Casamicciola|da Casamicciola a Napoli Beverello).*$/i, "")
      .trim() ?? null
  );

  const passengerCount = parsePassengerCount(compact);
  const chosenTimes = parseChosenVoucherTimes(sourceText);
  const scannedTimes = parseVoucherTimes(lines);
  const times = {
    outwardTime: chosenTimes.outwardTime ?? scannedTimes.outwardTime,
    returnTime: chosenTimes.returnTime ?? scannedTimes.returnTime
  };

  const pairedDateMatch = compact.match(
    /\b([0-3]?\d[/.:-][01]?\d[/.:-](?:\d{2}|\d{4}))\s+Data di Arrivo ad Ischia:\s*([0-3]?\d[/.:-][01]?\d[/.:-](?:\d{2}|\d{4}))\s+Data di Partenza da Ischia:/i
  );
  const arrivalDate = parseIsoDate(
    clean(pairedDateMatch?.[1] ?? null) ??
      clean(lines.find((line) => /Data di Arrivo ad Ischia:/i.test(line))?.match(/Data di Arrivo ad Ischia:\s*([0-3]?\d[/.:-][01]?\d[/.:-](?:\d{2}|\d{4}))/i)?.[1] ?? null) ??
      clean(compact.match(/\b([0-3]?\d[/.:-][01]?\d[/.:-](?:\d{2}|\d{4}))\s+Data di Arrivo ad Ischia:/i)?.[1] ?? null)
  );
  const departureDate = parseIsoDate(
    clean(pairedDateMatch?.[2] ?? null) ??
      clean(lines.find((line) => /Data di Partenza da Ischia:/i.test(line))?.match(/Data di Partenza da Ischia:\s*([0-3]?\d[/.:-][01]?\d[/.:-](?:\d{2}|\d{4}))/i)?.[1] ?? null) ??
      clean(compact.match(/\b([0-3]?\d[/.:-][01]?\d[/.:-](?:\d{2}|\d{4}))\s+Data di Partenza da Ischia:/i)?.[1] ?? null)
  );

  const arrivalService: ParsedTransferService = {
    practice_number: null,
    beneficiary: customer.fullName,
    pax: passengerCount,
    service_type: "transfer",
    direction: "andata",
    service_date: arrivalDate,
    service_time: times.outwardTime,
    pickup_meeting_point: "CASAMICCIOLA",
    origin: "NAPOLI BEVERELLO",
    destination: hotelSanitized,
    carrier_company: "SNAV",
    hotel_structure: hotelSanitized,
    original_row_description: "ALISCAFO + TRANSFER HOTEL",
    raw_detail_text: "Voucher Dimhotels/Snav con aliscafo e transfer hotel",
    parsing_status: arrivalDate || hotel || phone ? "parsed" : "needs_review",
    confidence_level: arrivalDate && hotel && times.outwardTime ? "high" : hotel || phone ? "medium" : "low",
    semantic_tag: "transfer_arrival"
  };

  const departureService: ParsedTransferService = {
    practice_number: null,
    beneficiary: customer.fullName,
    pax: passengerCount,
    service_type: "transfer",
    direction: "ritorno",
    service_date: departureDate,
    service_time: times.returnTime,
    pickup_meeting_point: hotelSanitized,
    origin: hotelSanitized,
    destination: "NAPOLI BEVERELLO",
    carrier_company: "SNAV",
    hotel_structure: hotelSanitized,
    original_row_description: "TRANSFER HOTEL + ALISCAFO",
    raw_detail_text: "Voucher Dimhotels/Snav con rientro hotel verso Napoli Beverello",
    parsing_status: departureDate || hotel || phone ? "parsed" : "needs_review",
    confidence_level: departureDate && hotel && times.returnTime ? "high" : hotel || phone ? "medium" : "low",
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
    date_from: arrivalDate,
    date_to: departureDate,
    total_amount_practice: /€\s*55/i.test(compact) || /55[,.\s]?00/i.test(compact) ? 55 : null,
    booking_kind: "transfer_port_hotel",
    service_type_code: "transfer_port_hotel",
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
    parsing_status: arrivalDate || departureDate || hotel || phone ? "parsed" : "needs_review",
    confidence_level: arrivalDate && departureDate && hotel && times.outwardTime && times.returnTime ? "high" : hotel || phone ? "medium" : "low",
    anomaly_message: arrivalDate && departureDate && hotel ? null : "Voucher OCR rumoroso: verifica date/orari se mancanti."
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
