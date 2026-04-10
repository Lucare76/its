/**
 * Estrazione email+PDF con Claude Haiku.
 * Re-export del modulo condiviso pdf-extract-haiku per compatibilità.
 */

import { extractWithHaiku, type ClaudeFormState, type HaikuExtractResult } from "@/lib/server/pdf-extract-haiku";

export type { ClaudeFormState };

export type ClaudeEmailExtractResult = {
  agency: string;
  form: ClaudeFormState;
  rawJson: Record<string, unknown>;
};

export async function claudeEmailExtract(
  pdfBase64: string | null,
  emailBody: string,
  emailSubject: string
): Promise<ClaudeEmailExtractResult> {
  const result: HaikuExtractResult = await extractWithHaiku(pdfBase64, emailBody, emailSubject);
  return {
    agency: result.agency,
    form: result.form,
    rawJson: result.rawJson
  };
}
