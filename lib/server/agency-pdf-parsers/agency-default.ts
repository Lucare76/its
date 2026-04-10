import { parseTransferBookingPdfText } from "@/lib/server/transfer-pdf-parser";
import type { AgencyPdfParserImplementation } from "@/lib/server/agency-pdf-parsers/types";
import { buildParserMatch } from "@/lib/server/agency-pdf-parsers/utils";

export const agencyDefaultPdfParser: AgencyPdfParserImplementation = {
  key: "agency_default",
  mode: "fallback",
  label: "Agency Default",
  senderDomains: [],
  subjectHints: [],
  contentHints: ["transfer", "hotel / ischia", "auto ischia / hotel", "auto hotel / ischia", "aliscafo", "trs h. ischia"],
  agencyNameHints: [],
  voucherHints: ["conferma d ordine", "pratica", "cliente:", "ufficio booking"],
  parse: parseTransferBookingPdfText,
  match: (input) =>
    buildParserMatch(input, {
      senderDomains: [],
      subjectHints: [],
      contentHints: ["transfer", "hotel / ischia", "auto ischia / hotel", "auto hotel / ischia", "aliscafo", "trs h. ischia"],
      agencyNameHints: [],
      voucherHints: ["conferma d ordine", "pratica", "cliente:", "ufficio booking"]
    })
};
