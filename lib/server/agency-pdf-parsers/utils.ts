import type { AgencyPdfParserMatch, AgencyPdfParserSelectionContext } from "@/lib/server/agency-pdf-parsers/types";

export function normalize(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

export function senderDomain(email: string) {
  const normalized = normalize(email);
  const parts = normalized.split("@");
  return parts.length > 1 ? parts[1] : "";
}

export function filenameHint(filename: string | null | undefined) {
  return normalize(filename).replace(/[^a-z0-9]+/g, " ");
}

export function normalizeTextForMatch(value: string | null | undefined) {
  return normalize(value).replace(/[^a-z0-9]+/g, " ");
}

export function buildParserMatch(
  input: AgencyPdfParserSelectionContext,
  definition: {
    senderDomains: string[];
    subjectHints: string[];
    contentHints: string[];
    agencyNameHints: string[];
    voucherHints: string[];
  }
): AgencyPdfParserMatch {
  const domain = senderDomain(input.senderEmail);
  const normalizedSubject = normalize(input.subject);
  const normalizedFilename = filenameHint(input.filename);
  const normalizedText = normalizeTextForMatch(input.extractedText);

  const matchedSenderDomain = definition.senderDomains.includes(domain);
  const matchedHints = [
    ...definition.subjectHints.filter((hint) => {
      const normalizedHint = normalize(hint);
      return Boolean(normalizedHint && (normalizedSubject.includes(normalizedHint) || normalizedFilename.includes(normalizedHint)));
    }),
    ...definition.contentHints.filter((hint) => {
      const normalizedHint = normalizeTextForMatch(hint);
      return Boolean(normalizedHint && normalizedText.includes(normalizedHint));
    })
  ];
  const matchedAgencyNames = definition.agencyNameHints.filter((hint) => {
    const normalizedHint = normalizeTextForMatch(hint);
    return Boolean(normalizedHint && normalizedText.includes(normalizedHint));
  });
  const matchedVoucherTokens = definition.voucherHints.filter((hint) => {
    const normalizedHint = normalizeTextForMatch(hint);
    return Boolean(normalizedHint && normalizedText.includes(normalizedHint));
  });

  let score = 0;
  if (matchedSenderDomain) score += 120;
  score += matchedAgencyNames.length * 40;
  score += matchedVoucherTokens.length * 28;
  score += matchedHints.length * 14;

  const reasons: string[] = [];
  if (matchedSenderDomain) reasons.push(`sender_domain=${domain}`);
  if (matchedAgencyNames.length > 0) reasons.push(`agency_name=${matchedAgencyNames.join("|")}`);
  if (matchedVoucherTokens.length > 0) reasons.push(`voucher=${matchedVoucherTokens.join("|")}`);
  if (matchedHints.length > 0) reasons.push(`hints=${matchedHints.join("|")}`);

  return {
    score,
    matchedSenderDomain,
    matchedHints,
    matchedAgencyNames,
    matchedVoucherTokens,
    reason: reasons.join("; ") || "no_distinctive_match"
  };
}
