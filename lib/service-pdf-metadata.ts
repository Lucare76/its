import type { InboundEmail, Service } from "@/lib/types";

export type ServiceOperationalSource = "pdf" | "agency" | "manual";

export type ServicePdfOperationalMeta = {
  isPdf: boolean;
  parserKey: string | null;
  parserMode: string | null;
  parsingQuality: string | null;
  manualReview: boolean;
  externalReference: string | null;
  agencyName: string | null;
  importState: string | null;
  reviewRecommended: boolean;
};

function clean(value?: string | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function noteMarker(notes: string | null | undefined, key: string) {
  const match = String(notes ?? "").match(new RegExp(`\\[${key}:([^\\]]+)\\]`, "i"));
  return clean(match?.[1] ?? null);
}

function safeRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

export function getServicePdfOperationalMeta(service: Service, inboundEmails: InboundEmail[]): ServicePdfOperationalMeta {
  const linkedInbound = service.inbound_email_id ? inboundEmails.find((email) => email.id === service.inbound_email_id) ?? null : null;
  const parsedJson = safeRecord(linkedInbound?.parsed_json);
  const pdfImport = safeRecord(parsedJson.pdf_import);
  const pdfParser = safeRecord(parsedJson.pdf_parser);
  const effectiveNormalized = safeRecord(pdfImport.effective_normalized);
  const normalized = safeRecord(pdfImport.normalized);
  const originalNormalized = safeRecord(pdfImport.original_normalized);
  const dedupe = safeRecord(pdfImport.dedupe);
  const excursionSource = clean(String((safeRecord(service.excursion_details)).source ?? ""));
  const isPdf = excursionSource === "pdf" || noteMarker(service.notes, "source") === "pdf" || Boolean(pdfImport);
  const parsingQuality = clean(String(pdfImport?.parsing_quality ?? noteMarker(service.notes, "parsing_quality") ?? ""));
  const parserMode = clean(String(pdfParser?.mode ?? ""));
  const manualReview = Boolean(pdfImport?.has_manual_review) || noteMarker(service.notes, "manual_review") === "true";
  return {
    isPdf,
    parserKey: clean(String(pdfImport?.parser_key ?? pdfParser?.key ?? noteMarker(service.notes, "parser") ?? "")),
    parserMode,
    parsingQuality,
    manualReview,
    externalReference: clean(
      String(
        effectiveNormalized.external_reference ??
          normalized.external_reference ??
          dedupe.external_reference ??
          noteMarker(service.notes, "external_ref") ??
          ""
      )
    ),
    agencyName: clean(
      String(
        effectiveNormalized.agency_name ??
          originalNormalized.agency_name ??
          normalized.agency_name ??
          ""
      )
    ),
    importState: clean(String(pdfImport?.import_state ?? noteMarker(service.notes, "import_state") ?? "")),
    reviewRecommended: isPdf && (parsingQuality !== "high" || parserMode !== "dedicated" || !manualReview)
  };
}

export function getServiceOperationalSource(service: Service, inboundEmails: InboundEmail[]): ServiceOperationalSource {
  const pdfMeta = getServicePdfOperationalMeta(service, inboundEmails);
  if (pdfMeta.isPdf) return "pdf";
  if (service.agency_id) return "agency";
  return "manual";
}
