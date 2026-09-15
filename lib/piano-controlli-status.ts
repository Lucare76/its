/**
 * Fix P2 (audit pre-go-live): stato dei "Controlli" del Controllo Giornata.
 *
 * Distingue esplicitamente sorgente-OK-zero-problemi da sorgente-in-errore,
 * cosi' un fallimento di group-diagnostics non puo' apparire come card verde
 * "0 problemi" — vedi app/(app)/piano-giorno/page.tsx (controlliStatus).
 */
export type ControlliStatus = "ok" | "issues" | "error";

export function deriveControlliStatus(
  groupDiagnosticsError: string | null,
  planIssuesCount: number
): ControlliStatus {
  if (groupDiagnosticsError) return "error";
  return planIssuesCount > 0 ? "issues" : "ok";
}
