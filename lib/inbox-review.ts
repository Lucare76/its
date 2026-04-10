export function needsInboxReview(parsedJson: unknown): boolean {
  if (!parsedJson || typeof parsedJson !== "object") return true;
  const payload = parsedJson as Record<string, unknown>;
  const reviewStatus = typeof payload.review_status === "string" ? payload.review_status : null;
  const linkedServiceId = typeof payload.linked_service_id === "string" ? payload.linked_service_id : null;
  const draftServiceId = typeof payload.draft_service_id === "string" ? payload.draft_service_id : null;

  if (reviewStatus === "confirmed" || reviewStatus === "ready_operational") return false;
  if (linkedServiceId) return false;
  const pdfImport = typeof payload.pdf_import === "object" && payload.pdf_import !== null ? payload.pdf_import as Record<string, unknown> : null;
  if (typeof pdfImport?.linked_service_id === "string") return false;
  if (draftServiceId) return true;
  return true;
}
