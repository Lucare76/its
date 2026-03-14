import type { ParsedTransferPdfPayload, ParsedTransferService } from "@/lib/server/transfer-pdf-parser";
import type { AgencyPdfParserImplementation } from "@/lib/server/agency-pdf-parsers/types";
import { buildParserMatch } from "@/lib/server/agency-pdf-parsers/utils";

function clean(value?: string | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function parseIsoDate(raw?: string | null) {
  const match = String(raw ?? "").match(/([0-3]?\d)[/-]([01]?\d)[/-](\d{4})/);
  if (!match) return null;
  return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
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

function parseRossellaSosandraPdfText(sourceText: string): ParsedTransferPdfPayload {
  const compact = sourceText.replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  const lines = sourceText
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const customerName =
    clean(lines.find((line) => /^Oggetto:/i.test(line))?.match(/Sigg?\s+([A-ZÀ-ÖØ-Ý' ]+?)\s+x\s+numero/i)?.[1]) ??
    clean(lines.find((line) => /^Clienti\s+Sigg?/i.test(line))?.match(/Clienti\s+Sigg?\s+([A-ZÀ-ÖØ-Ý' ]+?)\s+numero persone/i)?.[1]);
  const pax = Number(lines.find((line) => /numero\s+\d+\s+persone/i.test(line))?.match(/numero\s+(\d{1,2})\s+persone/i)?.[1] ?? "0") || null;
  const phone = clean(lines.find((line) => /^Cellulare cliente/i.test(line))?.match(/Cellulare cliente\s*([+\d][\d\s./-]{7,})/i)?.[1]);

  const arrivalLineIndex = lines.findIndex((line) => /^Arrivo giorno/i.test(line));
  const arrivalLine = arrivalLineIndex >= 0 ? lines[arrivalLineIndex] : null;
  const arrivalNextLine = arrivalLineIndex >= 0 ? (lines[arrivalLineIndex + 1] ?? "") : "";
  const returnLineIndex = lines.findIndex((line) => /^Ritorno giorno/i.test(line));
  const returnLine = returnLineIndex >= 0 ? lines[returnLineIndex] : null;
  const returnNextLine = returnLineIndex >= 0 ? (lines[returnLineIndex + 1] ?? "") : "";

  const arrivalMatch = arrivalLine?.match(
    /Arrivo giorno\s*([0-3]?\d-[01]?\d-\d{4})\s+in\s+([A-ZÀ-ÖØ-Ý' ]+?)\s+alle ore\s*([0-2]?\d[.:][0-5]\d)\s+con Treno numero\s*([A-ZÀ-ÖØ-Ý]+)\s*(\d{3,5})/i
  );
  const hotelMatch = arrivalNextLine.match(/trasferimento per Hotel\s*([A-ZÀ-ÖØ-Ý0-9' ]+)/i);
  const returnMatch = returnLine?.match(/Ritorno giorno\s*([0-3]?\d-[01]?\d-\d{4})/i);
  const returnTimeMatch = returnNextLine.match(/partenza alle ore\s*([0-2]?\d[.:][0-5]\d)/i);

  const arrivalService: ParsedTransferService | null = arrivalMatch
    ? {
        practice_number: null,
        beneficiary: customerName,
        pax,
        service_type: "transfer",
        direction: "andata",
        service_date: parseIsoDate(arrivalMatch[1]),
        service_time: normalizeTime(arrivalMatch[3]),
        pickup_meeting_point: normalizeStation(arrivalMatch[2]),
        origin: normalizeStation(arrivalMatch[2]),
        destination: clean(hotelMatch?.[1]),
        carrier_company: clean(arrivalMatch[4]),
        hotel_structure: clean(hotelMatch?.[1]),
        original_row_description: "TRANSFER STAZIONE / HOTEL",
        raw_detail_text: `Arrivo treno ${clean(arrivalMatch[4]) ?? ""} ${clean(arrivalMatch[5]) ?? ""} a ${normalizeStation(arrivalMatch[2]) ?? "stazione"} alle ${normalizeTime(arrivalMatch[3]) ?? "N/D"} - hotel ${clean(hotelMatch?.[1]) ?? "N/D"}`.trim(),
        parsing_status: "parsed",
        confidence_level: "high",
        semantic_tag: "transfer_arrival"
      }
    : null;

  const returnService: ParsedTransferService | null = returnMatch && returnTimeMatch
    ? {
        practice_number: null,
        beneficiary: customerName,
        pax,
        service_type: "transfer",
        direction: "ritorno",
        service_date: parseIsoDate(returnMatch[1]),
        service_time: normalizeTime(returnTimeMatch[1]),
        pickup_meeting_point: arrivalService?.destination ?? "HOTEL DA VERIFICARE",
        origin: arrivalService?.destination ?? "HOTEL DA VERIFICARE",
        destination: "STAZIONE DI NAPOLI",
        carrier_company: arrivalService?.carrier_company ?? null,
        hotel_structure: arrivalService?.destination ?? null,
        original_row_description: "TRANSFER HOTEL / STAZIONE",
        raw_detail_text: `Ritorno da hotel ${arrivalService?.destination ?? "N/D"} verso STAZIONE DI NAPOLI alle ${normalizeTime(returnTimeMatch[1]) ?? "N/D"}`.trim(),
        parsing_status: "parsed",
        confidence_level: "medium",
        semantic_tag: "transfer_departure"
      }
    : null;

  const parsedServices = [arrivalService, returnService].filter(Boolean) as ParsedTransferService[];
  const anomalyMessages: string[] = [];
  if (!arrivalService) anomalyMessages.push("Arrivo vettore non letto.");
  if (!returnService) anomalyMessages.push("Ritorno vettore non letto.");
  if (!phone) anomalyMessages.push("Telefono cliente non rilevato.");

  return {
    practice_number: clean(compact.match(/transfer_vettore[_ ]?(\d{3,})/i)?.[1]),
    practice_date: parseIsoDate(compact.match(/Ischia lì,\s*([0-3]?\d\/[01]?\d\/\d{4})/i)?.[1]?.replace(/\//g, "-") ?? null),
    first_beneficiary: customerName,
    ns_reference: clean(compact.match(/Alla C\.A\s*([^\n]+)/i)?.[1]),
    ns_contact: phone,
    pax,
    program: "TRANSFER VETTORE",
    package_description: clean(compact.match(/Oggetto:\s*([^\n]+)/i)?.[1]),
    date_from: arrivalService?.service_date ?? null,
    date_to: returnService?.service_date ?? null,
    total_amount_practice: null,
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
  voucherHints: ["transfer di andata e ritorno", "cellulare cliente", "treno numero"],
  parse: parseRossellaSosandraPdfText,
  match: (input) =>
    buildParserMatch(input, {
      senderDomains: ["rossellaviaggi.it", "sosandratour.it"],
      subjectHints: ["transfer vettore", "sosandra", "rossella viaggi"],
      contentHints: ["sosandra tour", "rossella viaggi", "gent.mo/ma vettore", "transfer di andata e ritorno"],
      agencyNameHints: ["sosandra tour", "rossella viaggi"],
      voucherHints: ["transfer di andata e ritorno", "cellulare cliente", "treno numero"]
    })
};
