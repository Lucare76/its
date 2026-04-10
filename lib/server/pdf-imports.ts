type InboundRow = {
  id: string;
  tenant_id: string;
  from_email: string | null;
  subject: string | null;
  extracted_text: string | null;
  parsed_json: Record<string, any>;
  created_at: string;
};

type ServiceRow = {
  id: string;
  inbound_email_id: string | null;
  is_draft: boolean;
  status: string;
  customer_name: string;
  date: string;
  time: string;
  notes: string;
  created_at: string;
  billing_party_name?: string | null;
  phone?: string | null;
  hotels?: { name?: string | null } | Array<{ name?: string | null }> | null;
};

type StatusEventRow = {
  id: string;
  service_id: string;
  status: string;
  at: string;
};

export type PdfImportUiStatus = "preview" | "draft" | "confirmed" | "duplicate" | "ignored" | "failed";

export function getPdfImportStatusMeta(status: PdfImportUiStatus) {
  switch (status) {
    case "draft":
      return { label: "Draft", tone: "amber" as const };
    case "confirmed":
      return { label: "Confermato", tone: "emerald" as const };
    case "duplicate":
      return { label: "Duplicato", tone: "slate" as const };
    case "ignored":
      return { label: "Scartato", tone: "rose" as const };
    case "failed":
      return { label: "Errore", tone: "red" as const };
    default:
      return { label: "Preview", tone: "blue" as const };
  }
}

export type PdfImportListItem = {
  inbound_email_id: string;
  created_at: string;
  status: PdfImportUiStatus;
  agency: string | null;
  customer: string | null;
  arrival_date: string | null;
  hotel_or_destination: string | null;
  parser_key: string | null;
  parser_mode: "dedicated" | "fallback" | "stub" | null;
  parser_selection_confidence: string | null;
  parser_selection_reason: string | null;
  fallback_reason: string | null;
  parsing_quality: string | null;
  review_recommended: boolean;
  external_reference: string | null;
  linked_service_id: string | null;
  linked_service_is_draft: boolean;
  duplicate: boolean;
  fields_found_count: number;
  missing_fields_count: number;
};

export type PdfImportDetail = PdfImportListItem & {
  parser_logs: string[];
  fields_found: string[];
  missing_fields: string[];
  normalized: Record<string, unknown>;
  original_normalized: Record<string, unknown>;
  reviewed_values: Record<string, unknown> | null;
  effective_normalized: Record<string, unknown>;
  dedupe: Record<string, unknown>;
  raw_inbound_parser: Record<string, unknown> | null;
  raw_transfer_parser: Record<string, unknown> | null;
  subject: string | null;
  from_email: string | null;
  extracted_text_preview: string | null;
  linked_service_status: string | null;
  has_manual_review: boolean;
  reviewed_by: string | null;
  reviewed_at: string | null;
  possible_existing_matches: Array<{
    service_id: string;
    status: string;
    is_draft: boolean;
    customer_name: string | null;
    phone: string | null;
    date: string | null;
    match_reason: string;
  }>;
  status_events: Array<{ id: string; status: string; at: string }>;
};

function clean(value?: string | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function relatedHotelName(value: ServiceRow["hotels"]) {
  if (!value) return null;
  if (Array.isArray(value)) {
    return clean(String(value[0]?.name ?? ""));
  }
  return clean(String(value.name ?? ""));
}

export function derivePdfImportStatus(parsedJson: Record<string, any>, linkedService: ServiceRow | null): PdfImportUiStatus {
  const state = clean(parsedJson?.pdf_import?.import_state);
  if (state === "ignored") return "ignored";
  if (state === "failed") return "failed";
  if (state === "skipped_duplicate" || state === "skipped_duplicate_final" || state === "skipped_duplicate_draft") return "duplicate";
  if (state === "imported") return "confirmed";
  if (linkedService && linkedService.is_draft === false) return "confirmed";
  if (state === "draft" || (linkedService && linkedService.is_draft)) return "draft";
  return "preview";
}

export function buildPdfImportDetail(row: InboundRow, linkedService: ServiceRow | null, statusEvents: StatusEventRow[]): PdfImportDetail {
  const pdfImport = row.parsed_json?.pdf_import ?? {};
  const originalNormalized = (pdfImport.original_normalized ?? pdfImport.normalized ?? {}) as Record<string, unknown>;
  const reviewedValues = (pdfImport.reviewed_values ?? null) as Record<string, unknown> | null;
  const effectiveNormalized = (pdfImport.effective_normalized ?? pdfImport.normalized ?? {}) as Record<string, unknown>;
  const normalized = effectiveNormalized;
  const dedupe = (pdfImport.dedupe ?? {}) as Record<string, unknown>;
  const fieldsFound = Array.isArray(pdfImport.fields_found) ? (pdfImport.fields_found as string[]) : [];
  const missingFields = Array.isArray(pdfImport.missing_fields) ? (pdfImport.missing_fields as string[]) : [];
  const parserLogs = Array.isArray(pdfImport.parser_logs) ? (pdfImport.parser_logs as string[]) : [];
  const status = derivePdfImportStatus(row.parsed_json, linkedService);
  const confirmedService = status === "confirmed" && linkedService && linkedService.is_draft === false ? linkedService : null;
  const confirmedAgency = clean(String(confirmedService?.billing_party_name ?? ""));
  const confirmedHotel = relatedHotelName(confirmedService?.hotels ?? null);
  const confirmedCustomer = clean(String(confirmedService?.customer_name ?? ""));
  const confirmedDate = clean(String(confirmedService?.date ?? ""));

  return {
    inbound_email_id: row.id,
    created_at: row.created_at,
    status,
    agency: confirmedAgency ?? clean(String(normalized.billing_party_name ?? normalized.agency_name ?? "")),
    customer: confirmedCustomer ?? clean(String(normalized.customer_full_name ?? "")),
    arrival_date: confirmedDate ?? clean(String(normalized.arrival_date ?? "")),
    hotel_or_destination: confirmedHotel ?? clean(String(normalized.hotel_or_destination ?? "")),
    parser_key: clean(String(pdfImport.parser_key ?? row.parsed_json?.pdf_parser?.key ?? "")),
    parser_mode: clean(String(row.parsed_json?.pdf_parser?.mode ?? "")) as "dedicated" | "fallback" | "stub" | null,
    parser_selection_confidence: clean(String(row.parsed_json?.pdf_parser?.selection_confidence ?? "")),
    parser_selection_reason: clean(String(row.parsed_json?.pdf_parser?.selection_reason ?? "")),
    fallback_reason: clean(String(row.parsed_json?.pdf_parser?.fallback_reason ?? "")),
    parsing_quality: clean(String(pdfImport.parsing_quality ?? "")),
    review_recommended:
      (clean(String(pdfImport.parsing_quality ?? "")) ?? "low") !== "high" ||
      clean(String(row.parsed_json?.pdf_parser?.mode ?? "")) !== "dedicated",
    external_reference: clean(String(pdfImport.dedupe?.external_reference ?? normalized.external_reference ?? "")),
    linked_service_id: linkedService?.id ?? clean(String(pdfImport.linked_service_id ?? "")),
    linked_service_is_draft: Boolean(linkedService?.is_draft),
    duplicate: status === "duplicate",
    fields_found_count: fieldsFound.length,
    missing_fields_count: missingFields.length,
    parser_logs: parserLogs,
    fields_found: fieldsFound,
    missing_fields: missingFields,
    normalized,
    original_normalized: originalNormalized,
    reviewed_values: reviewedValues,
    effective_normalized: effectiveNormalized,
    dedupe,
    raw_inbound_parser: (row.parsed_json?.parser_suggestions ?? null) as Record<string, unknown> | null,
    raw_transfer_parser: (row.parsed_json?.pdf_import?.raw_transfer_parser ?? row.parsed_json?.raw?.transfer_parser ?? null) as Record<string, unknown> | null,
    subject: row.subject,
    from_email: row.from_email,
    extracted_text_preview: row.extracted_text ? row.extracted_text.slice(0, 4000) : null,
    linked_service_status: linkedService?.status ?? null,
    has_manual_review: Boolean(pdfImport.has_manual_review),
    reviewed_by: clean(String(pdfImport.reviewed_by ?? "")),
    reviewed_at: clean(String(pdfImport.reviewed_at ?? "")),
    possible_existing_matches: Array.isArray(pdfImport.possible_existing_matches)
      ? (pdfImport.possible_existing_matches as Array<{
          service_id: string;
          status: string;
          is_draft: boolean;
          customer_name: string | null;
          phone: string | null;
          date: string | null;
          match_reason: string;
        }>)
      : [],
    status_events: statusEvents.map((item) => ({ id: item.id, status: item.status, at: item.at }))
  };
}
