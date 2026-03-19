import type { ParsedTransferPdfPayload, ParsedTransferService } from "@/lib/server/transfer-pdf-parser";
import type { AgencyPdfParserImplementation } from "@/lib/server/agency-pdf-parsers/types";
import { buildParserMatch } from "@/lib/server/agency-pdf-parsers/utils";

function clean(value?: string | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function parseIsoDate(raw?: string | null) {
  const match = String(raw ?? "").match(/([0-3]?\d)[/.:-]([01]?\d)[/.:-](\d{2,4})/);
  if (!match) return null;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function normalizeTime(raw?: string | null) {
  const match = String(raw ?? "").match(/([01]?\d|2[0-3])[.:]([0-5]\d)/);
  if (!match) return null;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function normalizeStation(value?: string | null) {
  const normalized = clean(value)?.toUpperCase() ?? null;
  if (!normalized) return null;
  if (/NAPOLI/.test(normalized)) return "STAZIONE DI NAPOLI";
  return normalized;
}

function extractTrainReference(raw?: string | null) {
  const normalized = clean(raw);
  if (!normalized) return null;
  const match = normalized.match(
    /\b(ITALO|FRECCIAROSSA|FR|INTERCITY|IC|REGIONALE|TRENITALIA)(?:\s*(?:numero\s*)?([A-Z]{0,2}\d{2,5}|\d{2,5}))?\b/i
  );
  if (!match) return null;
  const carrier = match[1].toUpperCase();
  const code = match[2]?.toUpperCase() ?? null;
  if (carrier === "FR") return code ? `FRECCIAROSSA ${code}` : "FRECCIAROSSA";
  if (carrier === "IC") return code ? `INTERCITY ${code}` : "INTERCITY";
  return code ? `${carrier} ${code}` : carrier;
}

function lineDate(raw?: string | null) {
  return clean(String(raw ?? "").match(/([0-3]?\d[/.:-][01]?\d[/.:-](?:\d{2}|\d{4}))/)?.[1]);
}

function lineTime(raw?: string | null) {
  return normalizeTime(clean(String(raw ?? "").match(/(?:alle\s+ore|ore)\s*([0-2]?\d[.:][0-5]\d)/i)?.[1]));
}

function buildTrainArrivalService(input: {
  customerName: string | null;
  pax: number | null;
  arrivalMatch: RegExpMatchArray;
  hotelName: string | null;
}): ParsedTransferService {
  const station = normalizeStation(input.arrivalMatch[2]);
  const hotelName = input.hotelName;
  return {
    practice_number: null,
    beneficiary: input.customerName,
    pax: input.pax,
    service_type: "transfer",
    direction: "andata",
    service_date: parseIsoDate(input.arrivalMatch[1]),
    service_time: normalizeTime(input.arrivalMatch[3]),
    pickup_meeting_point: station,
    origin: station,
    destination: hotelName,
    carrier_company: clean(input.arrivalMatch[4]),
    hotel_structure: hotelName,
    original_row_description: "TRANSFER STAZIONE / HOTEL",
    raw_detail_text: `Arrivo treno ${clean(input.arrivalMatch[4]) ?? ""} ${clean(input.arrivalMatch[5]) ?? ""} a ${station ?? "stazione"} alle ${normalizeTime(input.arrivalMatch[3]) ?? "N/D"} - hotel ${hotelName ?? "N/D"}`.trim(),
    parsing_status: "parsed",
    confidence_level: "high",
    semantic_tag: "transfer_arrival"
  };
}

function buildBusArrivalService(input: {
  customerName: string | null;
  pax: number | null;
  arrivalDate: string;
  busOrigin: string;
  busHotel: string;
  pickupTime: string | null;
}): ParsedTransferService {
  return {
    practice_number: null,
    beneficiary: input.customerName,
    pax: input.pax,
    service_type: "transfer",
    direction: "andata",
    service_date: parseIsoDate(input.arrivalDate),
    service_time: normalizeTime(input.pickupTime),
    pickup_meeting_point: input.busOrigin,
    origin: input.busOrigin,
    destination: input.busHotel,
    carrier_company: "BUS",
    hotel_structure: input.busHotel,
    original_row_description: "BUS CITTA / HOTEL",
    raw_detail_text: `Bus andata da ${input.busOrigin} alle ${normalizeTime(input.pickupTime) ?? "N/D"} per hotel ${input.busHotel}`.trim(),
    parsing_status: "parsed",
    confidence_level: "high",
    semantic_tag: "transfer_arrival"
  };
}

function buildTrainReturnService(input: {
  customerName: string | null;
  pax: number | null;
  returnDate: string;
  returnTime: string;
  hotelName: string | null;
  carrierCompany: string | null;
}): ParsedTransferService {
  const hotelName = input.hotelName ?? "HOTEL DA VERIFICARE";
  return {
    practice_number: null,
    beneficiary: input.customerName,
    pax: input.pax,
    service_type: "transfer",
    direction: "ritorno",
    service_date: parseIsoDate(input.returnDate),
    service_time: normalizeTime(input.returnTime),
    pickup_meeting_point: hotelName,
    origin: hotelName,
    destination: "STAZIONE DI NAPOLI",
    carrier_company: input.carrierCompany,
    hotel_structure: hotelName,
    original_row_description: "TRANSFER HOTEL / STAZIONE",
    raw_detail_text: `Ritorno da hotel ${hotelName} verso STAZIONE DI NAPOLI alle ${normalizeTime(input.returnTime) ?? "N/D"}`.trim(),
    parsing_status: "parsed",
    confidence_level: "medium",
    semantic_tag: "transfer_departure"
  };
}

function buildGenericTrainArrivalService(input: {
  customerName: string | null;
  pax: number | null;
  arrivalDate: string;
  arrivalTime: string | null;
  station: string | null;
  trainReference: string | null;
  hotelName: string | null;
}): ParsedTransferService {
  const station = normalizeStation(input.station) ?? "STAZIONE DI NAPOLI";
  const hotelName = input.hotelName;
  return {
    practice_number: null,
    beneficiary: input.customerName,
    pax: input.pax,
    service_type: "transfer",
    direction: "andata",
    service_date: parseIsoDate(input.arrivalDate),
    service_time: normalizeTime(input.arrivalTime),
    pickup_meeting_point: station,
    origin: station,
    destination: hotelName,
    carrier_company: clean(input.trainReference),
    hotel_structure: hotelName,
    original_row_description: "TRANSFER STAZIONE / HOTEL",
    raw_detail_text: `Arrivo treno ${clean(input.trainReference) ?? ""} a ${station} alle ${normalizeTime(input.arrivalTime) ?? "N/D"} - hotel ${hotelName ?? "N/D"}`.trim(),
    parsing_status: "parsed",
    confidence_level: "medium",
    semantic_tag: "transfer_arrival"
  };
}

function buildGenericTrainReturnService(input: {
  customerName: string | null;
  pax: number | null;
  returnDate: string;
  returnTime: string | null;
  hotelName: string | null;
  trainReference: string | null;
}): ParsedTransferService {
  const hotelName = input.hotelName ?? "HOTEL DA VERIFICARE";
  return {
    practice_number: null,
    beneficiary: input.customerName,
    pax: input.pax,
    service_type: "transfer",
    direction: "ritorno",
    service_date: parseIsoDate(input.returnDate),
    service_time: normalizeTime(input.returnTime),
    pickup_meeting_point: hotelName,
    origin: hotelName,
    destination: "STAZIONE DI NAPOLI",
    carrier_company: clean(input.trainReference),
    hotel_structure: hotelName,
    original_row_description: "TRANSFER HOTEL / STAZIONE",
    raw_detail_text: `Ritorno da hotel ${hotelName} verso STAZIONE DI NAPOLI alle ${normalizeTime(input.returnTime) ?? "N/D"} con ${clean(input.trainReference) ?? "treno"}`.trim(),
    parsing_status: "parsed",
    confidence_level: "medium",
    semantic_tag: "transfer_departure"
  };
}

function buildBusReturnService(input: {
  customerName: string | null;
  pax: number | null;
  returnDate: string;
  returnTime: string;
  busHotel: string | null;
  returnDestination: string | null;
  busOrigin: string | null;
}): ParsedTransferService {
  const hotelName = input.busHotel ?? "HOTEL DA VERIFICARE";
  const destination = input.returnDestination ?? input.busOrigin ?? "CITTA DA VERIFICARE";
  return {
    practice_number: null,
    beneficiary: input.customerName,
    pax: input.pax,
    service_type: "transfer",
    direction: "ritorno",
    service_date: parseIsoDate(input.returnDate),
    service_time: normalizeTime(input.returnTime),
    pickup_meeting_point: hotelName,
    origin: hotelName,
    destination,
    carrier_company: "BUS",
    hotel_structure: hotelName,
    original_row_description: "BUS HOTEL / CITTA",
    raw_detail_text: `Bus ritorno da hotel ${hotelName} alle ${normalizeTime(input.returnTime) ?? "N/D"} verso ${destination}`.trim(),
    parsing_status: "parsed",
    confidence_level: "high",
    semantic_tag: "transfer_departure"
  };
}

function parseRossellaSosandraPdfText(sourceText: string): ParsedTransferPdfPayload {
  const compact = sourceText.replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  const lines = sourceText
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const customerName =
    clean(lines.find((line) => /^Oggetto:/i.test(line))?.match(/Sigg?\s+(.+?)\s+x\s+numero/i)?.[1]) ??
    clean(lines.find((line) => /^Clienti\s+Sigg?/i.test(line))?.match(/Clienti\s+Sigg?\s+(.+?)\s+numero persone/i)?.[1]) ??
    clean(lines.find((line) => /^A nome /i.test(line))?.match(/A nome\s+(.+?)\s+numero\s+\d+\s+persone/i)?.[1]);
  const pax = Number(lines.find((line) => /numero\s+\d+\s+persone/i.test(line))?.match(/numero\s+(\d{1,2})\s+persone/i)?.[1] ?? "0") || null;
  const phone = clean(lines.find((line) => /^Cellulare cliente/i.test(line))?.match(/Cellulare cliente\s*([+\d][\d\s./-]{7,})/i)?.[1]);

  const arrivalLineIndex = lines.findIndex((line) => /^(Arrivo|Andata) giorno/i.test(line));
  const arrivalLine = arrivalLineIndex >= 0 ? lines[arrivalLineIndex] : null;
  const arrivalNextLine = arrivalLineIndex >= 0 ? (lines[arrivalLineIndex + 1] ?? "") : "";
  const returnLineIndex = lines.findIndex((line) => /^(Ritorno|Partenza) giorno/i.test(line));
  const returnLine = returnLineIndex >= 0 ? lines[returnLineIndex] : null;
  const returnNextLine = returnLineIndex >= 0 ? (lines[returnLineIndex + 1] ?? "") : "";

  const trainArrivalMatch = arrivalLine?.match(
    /Arrivo giorno\s*([0-3]?\d[/.:-][01]?\d[/.:-](?:\d{2}|\d{4}))\s+in\s+(.+?)\s+alle ore\s*([0-2]?\d[.:][0-5]\d)\s+con Treno numero\s*([A-Z]+)(?:\s*([A-Z]{0,2}\d{2,5}|\d{2,5}))?/i
  );
  const hotelMatch = arrivalNextLine.match(/trasferimento per Hotel\s*(.+)/i);

  const busArrivalMatch = arrivalLine?.match(/Arrivo giorno\s*([0-3]?\d[/.:-][01]?\d[/.:-](?:\d{2}|\d{4})).*Bus di Andata/i);
  const busRouteMatch = lines.find((line) => /^Bus da /i.test(line))?.match(/Bus da\s+(.+?)\s+per\s+(.+?)(?:\s+di\s+Ischia)?$/i);
  const busPickupMatch = lines.find((line) => /prelevamento da .* alle ore/i.test(line))?.match(/prelevamento da\s+(.+?)\s+alle ore\s*([0-2]?\d[.:][0-5]\d)/i);
  const busCustomerHotelMatch = lines.find((line) => /^A nome /i.test(line))?.match(/A nome\s+.+?\s+numero\s+\d+\s+persone\s+per\s+(.+?)(?:\s+di\s+Ischia)?$/i);
  const busHotel = clean(busCustomerHotelMatch?.[1] ?? busRouteMatch?.[2] ?? hotelMatch?.[1]);
  const busOrigin = clean(busPickupMatch?.[1] ?? busRouteMatch?.[1]);

  const trainReturnDateMatch = returnLine?.match(/Ritorno giorno\s*([0-3]?\d[/.:-][01]?\d[/.:-](?:\d{2}|\d{4}))/i);
  const trainReturnTimeMatch = returnNextLine.match(/partenza alle ore\s*([0-2]?\d[.:][0-5]\d)/i);
  const busReturnMatch = returnLine?.match(/Ritorno giorno\s*([0-3]?\d[/.:-][01]?\d[/.:-](?:\d{2}|\d{4})).*prelevamento alle ore\s*([0-2]?\d[.:][0-5]\d)/i);
  const returnBusDestinationMatch = lines.find((line) => /^a nome /i.test(line))?.match(/a nome\s+.+?\s+numero\s+\d+\s+persone\s+per\s+(.+)$/i);

  const genericArrivalDate = lineDate(arrivalLine);
  const genericArrivalTime = lineTime(arrivalLine) ?? lineTime(arrivalNextLine) ?? normalizeTime(busPickupMatch?.[2] ?? null);
  const genericReturnDate = lineDate(returnLine);
  const genericReturnTime = lineTime(returnLine) ?? lineTime(returnNextLine);
  const genericArrivalTrainReference =
    extractTrainReference(arrivalLine) ??
    extractTrainReference(arrivalNextLine) ??
    extractTrainReference(compact.match(/(?:andata|arrivo)[\s\S]{0,220}/i)?.[0]);
  const genericReturnTrainReference =
    extractTrainReference(returnLine) ??
    extractTrainReference(returnNextLine) ??
    extractTrainReference(compact.match(/(?:ritorno|partenza)[\s\S]{0,220}/i)?.[0]);
  const genericArrivalStation =
    clean(arrivalLine?.match(/\bin\s+(.+?)\s+alle ore\b/i)?.[1]) ??
    clean(arrivalNextLine?.match(/\bin\s+(.+?)\s+alle ore\b/i)?.[1]) ??
    "NAPOLI";

  const arrivalService: ParsedTransferService | null = trainArrivalMatch
    ? buildTrainArrivalService({
        customerName,
        pax,
        arrivalMatch: trainArrivalMatch,
        hotelName: clean(hotelMatch?.[1])
      })
    : genericArrivalDate && genericArrivalTrainReference
      ? buildGenericTrainArrivalService({
          customerName,
          pax,
          arrivalDate: genericArrivalDate,
          arrivalTime: genericArrivalTime,
          station: genericArrivalStation,
          trainReference: genericArrivalTrainReference,
          hotelName: clean(hotelMatch?.[1] ?? busHotel)
        })
    : busArrivalMatch && busOrigin && busHotel
      ? buildBusArrivalService({
          customerName,
          pax,
          arrivalDate: busArrivalMatch[1],
          busOrigin,
          busHotel,
          pickupTime: busPickupMatch?.[2] ?? null
        })
      : genericArrivalDate && busOrigin && busHotel
        ? buildBusArrivalService({
            customerName,
            pax,
            arrivalDate: genericArrivalDate,
            busOrigin,
            busHotel,
            pickupTime: genericArrivalTime
          })
      : null;

  const returnService: ParsedTransferService | null = trainReturnDateMatch && trainReturnTimeMatch
    ? buildTrainReturnService({
        customerName,
        pax,
        returnDate: trainReturnDateMatch[1],
        returnTime: trainReturnTimeMatch[1],
        hotelName: arrivalService?.destination ?? clean(hotelMatch?.[1]),
        carrierCompany: arrivalService?.carrier_company ?? null
      })
    : genericReturnDate && genericReturnTrainReference
      ? buildGenericTrainReturnService({
          customerName,
          pax,
          returnDate: genericReturnDate,
          returnTime: genericReturnTime,
          hotelName: arrivalService?.destination ?? clean(hotelMatch?.[1] ?? busHotel),
          trainReference: genericReturnTrainReference
        })
    : busReturnMatch
      ? buildBusReturnService({
          customerName,
          pax,
          returnDate: busReturnMatch[1],
          returnTime: busReturnMatch[2],
          busHotel: arrivalService?.destination ?? busHotel,
          returnDestination: clean(returnBusDestinationMatch?.[1]),
          busOrigin
        })
      : genericReturnDate
        ? buildBusReturnService({
            customerName,
            pax,
            returnDate: genericReturnDate,
            returnTime: genericReturnTime ?? "00:00",
            busHotel: arrivalService?.destination ?? busHotel,
            returnDestination: clean(returnBusDestinationMatch?.[1]),
            busOrigin
          })
      : null;

  const parsedServices = [arrivalService, returnService].filter(Boolean) as ParsedTransferService[];
  const anomalyMessages: string[] = [];
  if (!arrivalService) anomalyMessages.push("Arrivo vettore non letto.");
  if (!returnService) anomalyMessages.push("Ritorno vettore non letto.");
  if (!phone) anomalyMessages.push("Telefono cliente non rilevato.");

  return {
    practice_number: clean(compact.match(/transfer_vettore[_ ]?(\d{3,})/i)?.[1]),
    practice_date: parseIsoDate(compact.match(/Ischia l[^\d]*([0-3]?\d[/.:-][01]?\d[/.:-](?:\d{2}|\d{4}))/i)?.[1] ?? null),
    first_beneficiary: customerName,
    ns_reference: clean(compact.match(/Alla C\.A\s*([^\n]+)/i)?.[1]),
    ns_contact: phone,
    pax,
    program: "TRANSFER VETTORE",
    package_description: clean(compact.match(/Oggetto:\s*([^\n]+)/i)?.[1]),
    date_from: arrivalService?.service_date ?? null,
    date_to: returnService?.service_date ?? null,
    total_amount_practice:
      Number(compact.match(/\b(?:totale|importo)\D{0,12}(\d{1,4}(?:[.,]\d{2})?)\s*euro\b/i)?.[1]?.replace(",", ".") ?? "") || null,
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
    anomaly_message: anomalyMessages.length > 0 ? anomalyMessages.join(" ") : null
  };
}

export const agencyRossellaSosandraPdfParser: AgencyPdfParserImplementation = {
  key: "agency_rossella_sosandra",
  mode: "dedicated",
  label: "Rossella / Sosandra Tour",
  senderDomains: ["rossellaviaggi.it", "sosandratour.it"],
  subjectHints: ["transfer vettore", "sosandra", "rossella viaggi"],
  contentHints: ["sosandra tour", "rossella viaggi", "gent.mo/ma vettore", "transfer di andata e ritorno"],
  agencyNameHints: ["sosandra tour", "rossella viaggi"],
  voucherHints: ["transfer di andata e ritorno", "cellulare cliente", "treno numero", "bus di andata", "bus di ritorno"],
  parse: parseRossellaSosandraPdfText,
  match: (input) =>
    buildParserMatch(input, {
      senderDomains: ["rossellaviaggi.it", "sosandratour.it"],
      subjectHints: ["transfer vettore", "sosandra", "rossella viaggi"],
      contentHints: ["sosandra tour", "rossella viaggi", "gent.mo/ma vettore", "transfer di andata e ritorno"],
      agencyNameHints: ["sosandra tour", "rossella viaggi"],
      voucherHints: ["transfer di andata e ritorno", "cellulare cliente", "treno numero", "bus di andata", "bus di ritorno"]
    })
};
