import type { ParsedTransferPdfPayload } from "@/lib/server/transfer-pdf-parser";
import { parseTransferBookingPdfText } from "@/lib/server/transfer-pdf-parser";
import { agencyAlesteViaggiPdfParser } from "@/lib/server/agency-pdf-parsers/agency-aleste-viaggi";
import { agencyAngelinoTourPdfParser } from "@/lib/server/agency-pdf-parsers/agency-angelino-tour";
import { agencyBusOperationsPdfParser } from "@/lib/server/agency-pdf-parsers/agency-bus-operations";
import { agencyDimhotelsVoucherPdfParser } from "@/lib/server/agency-pdf-parsers/agency-dimhotels-voucher";
import { agencyDefaultPdfParser } from "@/lib/server/agency-pdf-parsers/agency-default";
import { agencyHolidaySudItaliaPdfParser } from "@/lib/server/agency-pdf-parsers/agency-holiday-sud-italia";
import { agencyRossellaSosandraPdfParser } from "@/lib/server/agency-pdf-parsers/agency-rossella-sosandra";
import { agencyZigoloViaggiPdfParser } from "@/lib/server/agency-pdf-parsers/agency-zigolo-viaggi";
import type { AgencyPdfParserImplementation, AgencyPdfParserMode, AgencyPdfParserSelectionContext } from "@/lib/server/agency-pdf-parsers/types";
import { buildParserMatch } from "@/lib/server/agency-pdf-parsers/utils";

export interface AgencyPdfParserSelectionInput extends AgencyPdfParserSelectionContext {}

export interface AgencyPdfParserSelectionResult {
  parserKey: string;
  parserMode: AgencyPdfParserMode;
  score: number;
  selectionConfidence: "high" | "medium" | "low";
  selectionReason: string;
  fallbackReason: string | null;
  parsed: ParsedTransferPdfPayload;
  candidates: Array<{
    key: string;
    mode: AgencyPdfParserMode;
    score: number;
    matchedSenderDomain: boolean;
    matchedHints: string[];
    matchedAgencyNames: string[];
    matchedVoucherTokens: string[];
    reason: string;
  }>;
}

function buildStubParser(key: string, label: string, senderDomains: string[], subjectHints: string[], agencyNameHints: string[]): AgencyPdfParserImplementation {
  return {
    key,
    mode: "stub",
    label,
    senderDomains,
    subjectHints,
    contentHints: [],
    agencyNameHints,
    voucherHints: [],
    parse: parseTransferBookingPdfText,
    match: (input) =>
      buildParserMatch(input, {
        senderDomains,
        subjectHints,
        contentHints: [],
        agencyNameHints,
        voucherHints: []
      })
  };
}

const parserDefinitions: AgencyPdfParserImplementation[] = [
  agencyAlesteViaggiPdfParser,
  agencyAngelinoTourPdfParser,
  agencyRossellaSosandraPdfParser,
  agencyBusOperationsPdfParser,
  agencyDimhotelsVoucherPdfParser,
  agencyHolidaySudItaliaPdfParser,
  agencyZigoloViaggiPdfParser,
  buildStubParser("agency_gattinoni_stub", "Gattinoni Stub", ["gattinoni.it"], ["gattinoni"], ["gattinoni"]),
  buildStubParser("agency_welcome_stub", "Welcome Stub", ["welcometravel.it"], ["welcome travel"], ["welcome travel"]),
  buildStubParser("agency_made_stub", "Made Stub", ["made.it"], ["made"], ["made"]),
  agencyDefaultPdfParser
];

function selectionConfidence(score: number, secondScore: number) {
  if (score >= 120 || score - secondScore >= 45) return "high";
  if (score >= 40 || score - secondScore >= 15) return "medium";
  return "low";
}

export function selectAgencyPdfParser(input: AgencyPdfParserSelectionInput): AgencyPdfParserSelectionResult {
  const scored = parserDefinitions.map((definition) => {
    const match = definition.match(input);
    return { definition, match };
  });
  scored.sort((a, b) => b.match.score - a.match.score);

  const topCandidate = scored[0];
  const winnerBundle =
    topCandidate && topCandidate.match.score > 0
      ? topCandidate
      : { definition: agencyDefaultPdfParser, match: agencyDefaultPdfParser.match(input) };
  const winner = winnerBundle.definition;
  const winnerMatch = winnerBundle.match;
  const secondScore = scored[1]?.match.score ?? 0;
  const confidence = selectionConfidence(winnerMatch.score, secondScore);
  const fallbackReason =
    winner.mode === "fallback"
      ? scored.some((candidate) => candidate.definition.mode === "dedicated" && candidate.match.score > 0)
        ? "dedicated_parsers_not_confident_enough"
        : "no_dedicated_match"
      : null;

  return {
    parserKey: winner.key,
    parserMode: winner.mode,
    score: winnerMatch.score,
    selectionConfidence: confidence,
    selectionReason: winnerMatch.reason,
    fallbackReason,
    parsed: winner.parse(input.extractedText),
    candidates: scored.map(({ definition, match }) => ({
      key: definition.key,
      mode: definition.mode,
      score: match.score,
      matchedSenderDomain: match.matchedSenderDomain,
      matchedHints: match.matchedHints,
      matchedAgencyNames: match.matchedAgencyNames,
      matchedVoucherTokens: match.matchedVoucherTokens,
      reason: match.reason
    }))
  };
}
