import { normalizeReviewWarnings, REVIEW_WARNINGS_TITLE } from "@/lib/review-warnings";

/**
 * Banner "Verifica manuale richiesta" per gli avvisi dei controlli
 * deterministici PDF (pax / treno ritorno). Volutamente senza pulsante di
 * chiusura: una situazione ambigua non deve poter sparire silenziosamente
 * mentre l'operatore compila il form. Usato da Inbox (email IMAP + preview
 * PDF manuale) e da PdfClaudeUploader.
 */
export function ReviewWarningsBanner({ warnings }: { warnings: unknown }) {
  const items = normalizeReviewWarnings(warnings);
  if (items.length === 0) return null;
  return (
    <div role="alert" data-testid="review-warnings-banner" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900">
      <p className="font-semibold">{REVIEW_WARNINGS_TITLE}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {items.map((warning, index) => <li key={index}>{warning}</li>)}
      </ul>
    </div>
  );
}
