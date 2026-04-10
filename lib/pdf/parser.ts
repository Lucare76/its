export type InboxPdfParsingSignal = {
  hasPdfImport: boolean;
  reviewRecommended: boolean;
  confidence: "high" | "medium" | "low" | null;
  missingFieldsCount: number;
  duplicate: boolean;
  duplicateServiceAlert: boolean;
  confirmed: boolean;
};

function clean(value: unknown) {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

export function getInboxPdfParsingSignal(parsedJson: Record<string, unknown> | null | undefined): InboxPdfParsingSignal {
  const pdfImport = (parsedJson?.pdf_import ?? null) as Record<string, unknown> | null;
  const parser = (parsedJson?.pdf_parser ?? null) as Record<string, unknown> | null;
  const importState = clean(pdfImport?.import_state);
  const parsingQuality = clean(pdfImport?.parsing_quality);
  const parserMode = clean(parser?.mode);
  const missingFields = Array.isArray(pdfImport?.missing_fields) ? pdfImport?.missing_fields : [];
  const confirmed = parsedJson?.review_status === "confirmed" || parsedJson?.review_status === "ready_operational";
  const duplicate =
    importState === "skipped_duplicate" ||
    importState === "skipped_duplicate_final" ||
    importState === "skipped_duplicate_draft";

  const duplicateServiceAlert = parsedJson?.duplicate_alert === true;

  return {
    hasPdfImport: Boolean(pdfImport),
    reviewRecommended: Boolean((parsingQuality ?? "low") !== "high" || parserMode !== "dedicated"),
    confidence:
      parsingQuality === "high" || parsingQuality === "medium" || parsingQuality === "low"
        ? parsingQuality
        : null,
    missingFieldsCount: missingFields.length,
    duplicate,
    duplicateServiceAlert,
    confirmed
  };
}
