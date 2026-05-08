export type InboxPdfParsingSignal = {
  hasPdfImport: boolean;
  reviewRecommended: boolean;
  confidence: "high" | "medium" | "low" | null;
  missingFieldsCount: number;
  duplicate: boolean;
  duplicateServiceAlert: boolean;
  confirmed: boolean;
  importState: string | null;
  reviewStatus: string | null;
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
  const reviewStatus = clean(parsedJson?.review_status);
  const confirmed = reviewStatus === "confirmed" || reviewStatus === "ready_operational";
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
    confirmed,
    importState,
    reviewStatus
  };
}

export function isInboxPdfReviewOpen(parsedJson: Record<string, unknown> | null | undefined): boolean {
  const signal = getInboxPdfParsingSignal(parsedJson);
  if (!signal.hasPdfImport || signal.confirmed || signal.duplicate) return false;
  if (["ignored", "imported", "final", "skipped_duplicate", "skipped_duplicate_final", "skipped_duplicate_draft"].includes(signal.importState ?? "")) {
    return false;
  }
  const reviewOpen =
    signal.importState === "draft" ||
    signal.importState === "preview" ||
    signal.reviewStatus === "needs_review";
  return reviewOpen && (signal.reviewRecommended || signal.missingFieldsCount > 0);
}
