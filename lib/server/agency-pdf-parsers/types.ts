import type { ParsedTransferPdfPayload } from "@/lib/server/transfer-pdf-parser";

export type AgencyPdfParserMode = "dedicated" | "fallback" | "stub";

export type AgencyPdfParserSelectionContext = {
  senderEmail: string;
  subject: string;
  filename?: string | null;
  extractedText: string;
};

export type AgencyPdfParserMatch = {
  score: number;
  matchedSenderDomain: boolean;
  matchedHints: string[];
  matchedAgencyNames: string[];
  matchedVoucherTokens: string[];
  reason: string;
};

export type AgencyPdfParserImplementation = {
  key: string;
  mode: AgencyPdfParserMode;
  label: string;
  senderDomains: string[];
  subjectHints: string[];
  contentHints: string[];
  agencyNameHints: string[];
  voucherHints: string[];
  parse: (sourceText: string) => ParsedTransferPdfPayload;
  match: (input: AgencyPdfParserSelectionContext) => AgencyPdfParserMatch;
};
